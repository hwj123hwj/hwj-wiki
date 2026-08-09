import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalToken = process.env.OPENWIKI_GATEWAY_ADMIN_TOKEN;
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-gateway-"));
  tempHomes.push(home);
  return home;
}

async function writeGatewayConfig(home: string): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "gateway");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    JSON.stringify(
      {
        baseUrl: "http://gateway.test",
        enabled: true,
        limit: 2,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function loadConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.OPENWIKI_GATEWAY_ADMIN_TOKEN = "admin-test-token";
  const { createGatewayConnector } =
    await import("../src/connectors/sources/gateway.ts");
  return createGatewayConnector();
}

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalToken === undefined)
    delete process.env.OPENWIKI_GATEWAY_ADMIN_TOKEN;
  else process.env.OPENWIKI_GATEWAY_ADMIN_TOKEN = originalToken;
  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("gateway connector", () => {
  test("exports JSONL archives and advances the durable cursor", async () => {
    const home = await createTempHome();
    await writeGatewayConfig(home);
    const requests: string[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer admin-test-token",
        });
        call += 1;
        const body =
          call === 1
            ? [
                JSON.stringify({ id: 1, request_id: "one" }),
                JSON.stringify({ id: 2, request_id: "two" }),
              ].join("\n") + "\n"
            : "";
        return Promise.resolve(
          new Response(body, {
            headers: {
              "Content-Type": "application/x-ndjson",
              "X-Archive-Next-Cursor":
                call === 1 ? "2026-08-09T00:00:00Z,2" : "",
              "X-Archive-Schema-Version": "2",
            },
            status: 200,
          }),
        );
      }),
    );

    const connector = await loadConnector(home);
    const first = await connector.ingest();
    expect(first.status).toBe("success");
    expect(first.rawFiles).toHaveLength(1);
    const raw = JSON.parse(await readFile(first.rawFiles[0] ?? "", "utf8")) as {
      archives: { request_id: string }[];
      previousCursor?: string;
      nextCursor?: string;
      schemaVersion: number;
    };
    expect(raw.archives.map((archive) => archive.request_id)).toEqual([
      "one",
      "two",
    ]);
    expect(raw.nextCursor).toBe("2026-08-09T00:00:00Z,2");
    expect(raw.schemaVersion).toBe(2);

    const second = await connector.ingest();
    expect(second.status).toBe("skipped");
    expect(second.rawFiles).toEqual([]);
    expect(new URL(requests[1] ?? "").searchParams.get("since")).toBe(
      "2026-08-09T00:00:00Z,2",
    );
    const state = JSON.parse(
      await readFile(
        path.join(home, ".openwiki", "connectors", "gateway", "state.json"),
        "utf8",
      ),
    ) as { latestIds: Record<string, string> };
    expect(state.latestIds["gateway-export-cursor"]).toBe(
      "2026-08-09T00:00:00Z,2",
    );
  });

  test("filters OpenWiki agent feedback while preserving external archives", async () => {
    const home = await createTempHome();
    await writeGatewayConfig(home);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            [
              JSON.stringify({
                id: 1,
                request_id: "self",
                source: "hwj-wiki-agent",
              }),
              JSON.stringify({
                id: 2,
                request_id: "external",
                source: "hwjcode",
              }),
            ].join("\n") + "\n",
            {
              headers: {
                "X-Archive-Next-Cursor": "2026-08-09T00:00:00Z,2",
              },
              status: 200,
            },
          ),
        ),
      ),
    );

    const connector = await loadConnector(home);
    const result = await connector.ingest();
    expect(result.status).toBe("success");
    const raw = JSON.parse(await readFile(result.rawFiles[0] ?? "", "utf8")) as {
      archives: { request_id: string }[];
      excludedCount: number;
      fetchedCount: number;
    };
    expect(raw.archives.map((archive) => archive.request_id)).toEqual([
      "external",
    ]);
    expect(raw.fetchedCount).toBe(2);
    expect(raw.excludedCount).toBe(1);
  });

  test("advances the cursor without raw output when a page is only agent feedback", async () => {
    const home = await createTempHome();
    await writeGatewayConfig(home);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: 1,
              request_id: "self",
              source: "hwj-wiki-agent",
            }) + "\n",
            {
              headers: {
                "X-Archive-Next-Cursor": "2026-08-09T00:00:00Z,1",
              },
              status: 200,
            },
          ),
        ),
      ),
    );

    const connector = await loadConnector(home);
    const result = await connector.ingest();
    expect(result.status).toBe("skipped");
    expect(result.rawFiles).toEqual([]);
    const state = JSON.parse(
      await readFile(
        path.join(home, ".openwiki", "connectors", "gateway", "state.json"),
        "utf8",
      ),
    ) as {
      latestIds: Record<string, string>;
      runs: Array<{ status: string }>;
    };
    expect(state.latestIds["gateway-export-cursor"]).toBe(
      "2026-08-09T00:00:00Z,1",
    );
    expect(state.runs.at(-1)?.status).toBe("skipped");
  });

  test("reports missing credentials without advancing state", async () => {
    const home = await createTempHome();
    delete process.env.OPENWIKI_GATEWAY_ADMIN_TOKEN;
    const connector = await loadConnector(home);
    delete process.env.OPENWIKI_GATEWAY_ADMIN_TOKEN;

    const result = await connector.ingest();
    expect(result.status).toBe("error");
    expect(result.rawFiles).toEqual([]);
    expect(result.message).toContain("OPENWIKI_GATEWAY_ADMIN_TOKEN");
  });

  test("records transport failures without advancing the cursor", async () => {
    const home = await createTempHome();
    await writeGatewayConfig(home);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("gateway offline"))),
    );

    const connector = await loadConnector(home);
    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.message).toContain("gateway offline");
    const state = JSON.parse(
      await readFile(
        path.join(home, ".openwiki", "connectors", "gateway", "state.json"),
        "utf8",
      ),
    ) as { latestIds?: Record<string, string> };
    expect(state.latestIds).toBeUndefined();
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-internal-"));
  tempHomes.push(home);
  return home;
}

async function configureConnector(
  home: string,
  rootDir: string,
  config: Record<string, unknown> = {},
): Promise<void> {
  const connectorDir = path.join(home, ".openwiki", "connectors", "internal");
  await mkdir(connectorDir, { recursive: true });
  await writeFile(
    path.join(connectorDir, "config.json"),
    `${JSON.stringify({ rootDir, sources: ["google", "slack", "notion"], ...config }, null, 2)}\n`,
    "utf8",
  );
}

function setConnectorTestHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

async function loadConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  const { createInternalConnector } =
    await import("../../../src/connectors/sources/internal.ts");
  return createInternalConnector();
}

function event(
  source: string,
  id: string,
  timestamp: string,
  text = id,
): Record<string, unknown> {
  return {
    id,
    kind: "message",
    source,
    text,
    timestamp,
    title: id,
  };
}

async function writeFeed(
  rootDir: string,
  source: string,
  records: unknown[],
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    path.join(rootDir, `${source}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

afterEach(async () => {
  vi.resetModules();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("internal source connector", () => {
  test("ingests configured feeds incrementally and advances per-source cursors", async () => {
    const home = await createTempHome();
    const rootDir = path.join(home, "internal-sources");
    await configureConnector(home, rootDir);
    await writeFeed(rootDir, "google", [
      event("google", "mail-1", "2026-08-10T00:00:00.000Z"),
      event("google", "mail-2", "2026-08-10T00:01:00.000Z"),
    ]);
    await writeFeed(rootDir, "slack", [
      event("slack", "message-1", "2026-08-10T00:02:00.000Z"),
    ]);

    const connector = await loadConnector(home);
    const first = await connector.ingest();

    expect(first.status).toBe("success");
    expect(first.rawFiles).toHaveLength(2);
    expect(first.warnings).toEqual([]);

    const googleRawPath = first.rawFiles.find((file) =>
      file.endsWith("google-items.json"),
    );
    expect(googleRawPath).toBeDefined();
    const googleRaw = JSON.parse(
      await readFile(googleRawPath as string, "utf8"),
    ) as { items: { id: string }[] };
    expect(googleRaw.items.map((item) => item.id)).toEqual([
      "mail-1",
      "mail-2",
    ]);

    const second = await connector.ingest();
    expect(second.status).toBe("skipped");
    expect(second.rawFiles).toEqual([]);

    await writeFeed(rootDir, "google", [
      event("google", "mail-1", "2026-08-10T00:00:00.000Z"),
      event("google", "mail-2", "2026-08-10T00:01:00.000Z"),
      event("google", "mail-3", "2026-08-10T00:03:00.000Z"),
    ]);
    const third = await connector.ingest();
    expect(third.status).toBe("success");
    expect(third.rawFiles).toHaveLength(1);
    const incrementalRaw = JSON.parse(
      await readFile(third.rawFiles[0], "utf8"),
    ) as { items: { id: string }[] };
    expect(incrementalRaw.items.map((item) => item.id)).toEqual(["mail-3"]);
  });

  test("keeps valid events while warning on malformed or sensitive records", async () => {
    const home = await createTempHome();
    const rootDir = path.join(home, "internal-sources");
    await configureConnector(home, rootDir, { sources: ["notion"] });
    await writeFeed(rootDir, "notion", [
      event("notion", "page-1", "2026-08-10T00:00:00.000Z"),
      {
        ...event("notion", "page-2", "2026-08-10T00:01:00.000Z"),
        metadata: { access_token: "must-not-be-stored" },
      },
      "not-json",
    ]);

    const connector = await loadConnector(home);
    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join(" ")).toMatch(/access_token/u);
    expect(result.warnings.join(" ")).toMatch(/event must be a JSON object/u);
    const raw = JSON.parse(await readFile(result.rawFiles[0], "utf8")) as {
      items: { id: string }[];
    };
    expect(raw.items.map((item) => item.id)).toEqual(["page-1"]);
    expect(JSON.stringify(raw)).not.toContain("must-not-be-stored");

    const retry = await connector.ingest();
    expect(retry.status).toBe("success");
    expect(retry.warnings).toHaveLength(2);
  });

  test("rejects a configured feed path outside the source root", async () => {
    const home = await createTempHome();
    const rootDir = path.join(home, "internal-sources");
    await configureConnector(home, rootDir, {
      sources: [{ id: "google", path: "../outside.jsonl" }],
    });

    const connector = await loadConnector(home);
    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.rawFiles).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/inside rootDir/u);
  });
});

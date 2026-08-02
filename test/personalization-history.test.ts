import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  acknowledgePersonalHistoryBatches,
  collectPersonalHistory,
} from "../src/personalization/history.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "hwj-wiki-history-"));
  temporaryRoots.push(root);
  const repo = path.join(root, "repo");
  const stateRoot = path.join(root, "state");
  const roots = {
    antigravity: path.join(root, "antigravity"),
    codex: path.join(root, "codex"),
    doubao: path.join(root, "doubao"),
    pi: path.join(root, "pi"),
  } as const;
  await Promise.all(
    [repo, stateRoot, ...Object.values(roots)].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  return { repo, root, roots, stateRoot };
}

describe("personal history collection", () => {
  test("filters by repository, redacts secrets, and advances append cursors", async () => {
    const { repo, roots, stateRoot } = await fixture();
    const session = path.join(roots.pi, "session.jsonl");
    await writeFile(
      session,
      [
        JSON.stringify({ type: "session", id: "session-1", cwd: repo }),
        JSON.stringify({
          type: "message",
          id: "one",
          timestamp: "2026-08-01T00:00:00Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "token=super-secret-value" }],
          },
        }),
        "",
      ].join("\n"),
    );

    const first = await collectPersonalHistory("code", repo, {
      roots,
      stateRoot,
    });
    expect(first.recordCount).toBe(1);
    const raw = JSON.parse(await readFile(first.rawFiles[0], "utf8")) as {
      records: Array<{ text: string }>;
    };
    expect(raw.records[0]?.text).toContain("[REDACTED]");
    expect(raw.records[0]?.text).not.toContain("super-secret-value");

    const second = await collectPersonalHistory("code", repo, {
      roots,
      stateRoot,
    });
    expect(second.batches.map((batch) => batch.key)).toEqual(
      first.batches.map((batch) => batch.key),
    );

    await acknowledgePersonalHistoryBatches(first, stateRoot);
    const acknowledged = await collectPersonalHistory("code", repo, {
      roots,
      stateRoot,
    });
    expect(acknowledged.recordCount).toBe(0);

    await writeFile(
      session,
      `${await readFile(session, "utf8")}${JSON.stringify({
        type: "message",
        id: "two",
        message: { role: "assistant", content: "已完成重构" },
      })}\n`,
    );
    const third = await collectPersonalHistory("code", repo, {
      roots,
      stateRoot,
    });
    expect(third.recordCount).toBe(1);
  });

  test("excludes unrelated sessions in code mode", async () => {
    const { repo, root, roots, stateRoot } = await fixture();
    await writeFile(
      path.join(roots.codex, "session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { session_id: "other", cwd: path.join(root, "other") },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: "not this repo" },
        }),
        "",
      ].join("\n"),
    );
    await mkdir(path.join(root, "other"), { recursive: true });

    const result = await collectPersonalHistory("code", repo, {
      roots,
      stateRoot,
    });
    expect(result.recordCount).toBe(0);
  });

  test("imports Doubao only in personal mode", async () => {
    const { repo, roots, stateRoot } = await fixture();
    await writeFile(
      path.join(roots.doubao, "chat.json"),
      JSON.stringify({
        messages: [
          {
            role: "user",
            text: "如何设计知识库？",
            messageId: "m1",
            createTime: 1_785_552_000,
          },
        ],
      }),
    );

    expect(
      (
        await collectPersonalHistory("code", repo, {
          roots,
          stateRoot,
        })
      ).recordCount,
    ).toBe(0);
    expect(
      (
        await collectPersonalHistory("personal", repo, {
          roots,
          stateRoot,
        })
      ).recordCount,
    ).toBe(1);
  });

  test("caps each run and continues from the durable scan cursor", async () => {
    const { repo, roots, stateRoot } = await fixture();
    const events = [JSON.stringify({ type: "session", id: "many", cwd: repo })];
    for (let index = 0; index < 500; index += 1) {
      events.push(
        JSON.stringify({
          id: `message-${index}`,
          message: { content: `记录 ${index}`, role: "user" },
          type: "message",
        }),
      );
    }
    await writeFile(
      path.join(roots.pi, "many.jsonl"),
      `${events.join("\n")}\n`,
    );

    const first = await collectPersonalHistory("personal", repo, {
      roots,
      stateRoot,
    });
    expect(first.recordCount).toBeLessThanOrEqual(100);
    await acknowledgePersonalHistoryBatches(first, stateRoot);

    const second = await collectPersonalHistory("personal", repo, {
      roots,
      stateRoot,
    });
    expect(second.recordCount).toBeLessThanOrEqual(100);
    await acknowledgePersonalHistoryBatches(second, stateRoot);

    let total = first.recordCount + second.recordCount;
    while (total < 500) {
      const next = await collectPersonalHistory("personal", repo, {
        roots,
        stateRoot,
      });
      expect(next.recordCount).toBeLessThanOrEqual(100);
      total += next.recordCount;
      await acknowledgePersonalHistoryBatches(next, stateRoot);
    }
    expect(total).toBe(500);
  });

  test("advances past invalid trailing JSONL instead of reporting endless scan work", async () => {
    const { repo, roots, stateRoot } = await fixture();
    await writeFile(path.join(roots.codex, "invalid.jsonl"), "not-json");

    const first = await collectPersonalHistory("personal", repo, {
      roots,
      stateRoot,
    });
    expect(first.recordCount).toBe(0);
    expect(first.scanPendingSources).toEqual([]);
    expect(first.warnings).toHaveLength(1);

    const second = await collectPersonalHistory("personal", repo, {
      roots,
      stateRoot,
    });
    expect(second.recordCount).toBe(0);
    expect(second.scanPendingSources).toEqual([]);
    expect(second.warnings).toEqual([]);
  });

  test("reports more source scanning when a noise-only JSONL window ends before EOF", async () => {
    const { repo, roots, stateRoot } = await fixture();
    const events = Array.from({ length: 30 }, (_, index) =>
      JSON.stringify({
        payload: { content: `工具噪声 ${index}`, role: "developer" },
        type: "response_item",
      }),
    );
    events.push(
      JSON.stringify({
        payload: { content: "窗口之后的长期知识", role: "user" },
        type: "response_item",
      }),
    );
    await writeFile(
      path.join(roots.codex, "windowed.jsonl"),
      `${events.join("\n")}\n`,
    );

    let collection = await collectPersonalHistory("personal", repo, {
      maxJsonlScanBytes: 512,
      roots,
      stateRoot,
    });
    expect(collection.recordCount).toBe(0);
    expect(collection.scanPendingSources).toContain("codex");

    for (
      let attempt = 0;
      attempt < 10 && collection.recordCount === 0;
      attempt += 1
    ) {
      collection = await collectPersonalHistory("personal", repo, {
        maxJsonlScanBytes: 512,
        roots,
        stateRoot,
      });
    }
    expect(collection.recordCount).toBe(1);
  });

  test("excludes Antigravity generated logs from canonical history", async () => {
    const { repo, roots, stateRoot } = await fixture();
    const generated = path.join(
      roots.antigravity,
      "brain-id",
      ".system_generated",
      "logs",
    );
    await mkdir(generated, { recursive: true });
    await writeFile(
      path.join(generated, "transcript.jsonl"),
      `${JSON.stringify({ source: "MODEL", content: "generated noise" })}\n`,
    );
    await writeFile(
      path.join(roots.antigravity, "canonical.jsonl"),
      `${JSON.stringify({ source: "USER_EXPLICIT", content: "保留的正式会话" })}\n`,
    );

    const result = await collectPersonalHistory("personal", repo, {
      roots,
      stateRoot,
    });
    expect(result.recordCount).toBe(1);
    const raw = await readFile(result.rawFiles[0], "utf8");
    expect(raw).toContain("保留的正式会话");
    expect(raw).not.toContain("generated noise");
  });

  test("round-robins pending batches across all four connectors", async () => {
    const { repo, roots, stateRoot } = await fixture();
    await writeFile(
      path.join(roots.pi, "pi.jsonl"),
      `${JSON.stringify({ id: "pi-1", message: { content: "Pi 记录", role: "user" }, type: "message" })}\n`,
    );
    await writeFile(
      path.join(roots.codex, "codex.jsonl"),
      `${JSON.stringify({ payload: { content: "Codex 记录", role: "user", type: "message" }, type: "response_item" })}\n`,
    );
    await writeFile(
      path.join(roots.antigravity, "antigravity.jsonl"),
      `${JSON.stringify({ content: "Antigravity 记录", source: "USER_EXPLICIT" })}\n`,
    );
    await writeFile(
      path.join(roots.doubao, "doubao.json"),
      JSON.stringify({
        messages: [{ messageId: "d-1", role: "user", text: "豆包记录" }],
      }),
    );

    const selected: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const collection = await collectPersonalHistory("personal", repo, {
        roots,
        stateRoot,
      });
      selected.push(collection.batches[0]?.source ?? "missing");
      if (index === 0) {
        expect(collection.backlogBatchCount).toBe(4);
        expect(collection.backlogBySource).toEqual({
          antigravity: 1,
          codex: 1,
          doubao: 1,
          pi: 1,
        });
      }
      await acknowledgePersonalHistoryBatches(collection, stateRoot);
    }

    expect(selected).toEqual(["pi", "codex", "antigravity", "doubao"]);
  });

  test("keeps code mode's shared record budget and source order", async () => {
    const { repo, roots, stateRoot } = await fixture();
    const piEvents = [
      JSON.stringify({ cwd: repo, id: "code-pi", type: "session" }),
    ];
    for (let index = 0; index < 100; index += 1) {
      piEvents.push(
        JSON.stringify({
          id: `pi-${index}`,
          message: { content: `Pi ${index}`, role: "user" },
          type: "message",
        }),
      );
    }
    await writeFile(
      path.join(roots.pi, "pi.jsonl"),
      `${piEvents.join("\n")}\n`,
    );
    await writeFile(
      path.join(roots.codex, "codex.jsonl"),
      [
        JSON.stringify({
          payload: { cwd: repo, id: "code-codex" },
          type: "session_meta",
        }),
        JSON.stringify({
          payload: {
            content: "Codex should wait",
            role: "user",
            type: "message",
          },
          type: "response_item",
        }),
        "",
      ].join("\n"),
    );

    const first = await collectPersonalHistory("code", repo, {
      roots,
      stateRoot,
    });
    expect(first.recordCount).toBe(100);
    expect(first.sources).toEqual(["pi"]);
    await acknowledgePersonalHistoryBatches(first, stateRoot);

    const second = await collectPersonalHistory("code", repo, {
      roots,
      stateRoot,
    });
    expect(second.sources).toEqual(["codex"]);
    expect(second.recordCount).toBe(1);
  });
});

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { collectPersonalHistory } from "../src/personalization/history.ts";

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
    expect(second.recordCount).toBe(0);

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
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { searchKnowledge } from "../src/search.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("searchKnowledge", () => {
  test("searches configured Markdown roots with weighted metadata and safe snippets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-search-"));
    roots.push(root);
    await mkdir(path.join(root, "doubao-knowledge", "tech"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "doubao-knowledge", "tech", "gateway.md"),
      [
        "# gateway-sync-test-unique 归档与知识飞轮",
        "",
        "## 增量同步",
        "",
        "使用 cursor 进行可靠的 gateway-sync-test-unique archive 同步。",
        "token=should-not-appear",
        "",
      ].join("\n"),
      "utf8",
    );

    const results = await searchKnowledge("gateway-sync-test-unique", {
      limit: 5,
      roots: [root],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("gateway-sync-test-unique 归档与知识飞轮");
    expect(results[0]?.source).toBe(path.basename(root));
    expect(results[0]?.snippet).toContain("gateway-sync-test-unique");
    expect(results[0]?.snippet).not.toContain("should-not-appear");
  });
});

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { generateProjectIssuesIndex } from "../src/personalization/issues-index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("project issues index", () => {
  test("generates a stable OKF index without changing source issues", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "hwj-wiki-issues-"));
    temporaryRoots.push(repo);
    const issues = path.join(repo, "issues");
    await mkdir(issues, { recursive: true });
    const source = path.join(issues, "gateway.md");
    const original = `---
title: LiteLLM 超时
project: gateway
category: fallback
confidence: confirmed
updated_at: 2026-08-01
---

# LiteLLM 超时
`;
    await writeFile(source, original, "utf8");

    const first = await generateProjectIssuesIndex(repo);
    expect(first).toMatchObject({ changed: true, issueCount: 1 });
    const output = await readFile(first.outputPath!, "utf8");
    expect(output).toContain('type: "Reference"');
    expect(output).toContain("[LiteLLM 超时](../../issues/gateway.md)");
    expect(await readFile(source, "utf8")).toBe(original);

    expect(await generateProjectIssuesIndex(repo)).toMatchObject({
      changed: false,
      issueCount: 1,
    });
  });
});

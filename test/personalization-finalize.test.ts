import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { KnowledgeCandidate } from "../src/personalization/candidates.ts";
import { generatePersonalWikiFallback } from "../src/personalization/fallback.ts";
import {
  capturePersonalWikiBodySnapshot,
  finalizePersonalWiki,
} from "../src/personalization/finalize.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "hwj-finalize-"));
  temporaryRoots.push(root);
  const wikiRoot = path.join(root, "wiki");
  const stateRoot = path.join(root, "state");
  await mkdir(wikiRoot, { recursive: true });

  const refs: string[] = [];
  for (const [run, id] of [
    ["run-1", "111111111111111111111111"],
    ["run-2", "222222222222222222222222"],
  ]) {
    const rawDir = path.join(stateRoot, "codex-history", "raw", run);
    await mkdir(rawDir, { recursive: true });
    await writeFile(
      path.join(rawDir, "records-0001.json"),
      JSON.stringify({
        records: [
          {
            id,
            kind: "message",
            role: "user",
            sessionId: run,
            source: "codex",
            text: `证据 ${run}`,
          },
        ],
      }),
    );
    refs.push(`codex-history:${run}/records-0001.json#${id}`);
  }
  return { refs, stateRoot, wikiRoot };
}

function lesson(sourceRef: string, fact: string): KnowledgeCandidate {
  return {
    confidence: "source-backed",
    decisions: [],
    facts: [fact],
    project: "hwj-wiki",
    reusableLessons: ["工具结果必须通过统一质量门后再确认批次。"],
    sourceRefs: [sourceRef],
    stableKey: "hwj-wiki/lesson/统一质量收尾",
    summary:
      "把所有生成路径统一接到确定性质量检查，避免降级模式绕过索引与安全验证。",
    tags: ["质量", "知识库"],
    title: "统一知识库质量收尾",
    type: "Lesson",
    validAsOf: "2026-08-02",
    volatile: true,
  };
}

describe("personal wiki deterministic finalization", () => {
  test("fallback merges duplicate themes, preserves provenance, and rebuilds indexes", async () => {
    const { refs, stateRoot, wikiRoot } = await fixture();
    const first = lesson(refs[0], "原生和降级输出必须使用同一 finalizer。");
    const second = {
      ...lesson(refs[1], "失效链接会阻止批次确认。"),
      stableKey: "hwj-wiki/lesson/知识库质量统一收尾",
      title: "知识库统一质量收尾",
    };
    const candidates = [first, second];

    const result = await generatePersonalWikiFallback(
      wikiRoot,
      candidates,
      "zh-CN",
      stateRoot,
    );
    expect(result.report).toMatchObject({ valid: true });
    expect(result.files).toHaveLength(1);

    const lessonFiles = (await readdir(path.join(wikiRoot, "lessons"))).filter(
      (file) => file !== "index.md",
    );
    expect(lessonFiles).toHaveLength(1);
    const page = await readFile(
      path.join(wikiRoot, "lessons", lessonFiles[0]),
      "utf8",
    );
    expect(page).toContain("fallbackGenerated: true");
    expect(page).toContain("stableKeyAliases");
    expect(page).toContain("validAsOf");
    expect(page).toContain(refs[0]);
    expect(page).toContain(refs[1]);

    const directoryIndex = await readFile(
      path.join(wikiRoot, "lessons", "index.md"),
      "utf8",
    );
    expect(directoryIndex).toContain(lessonFiles[0]);
    const quickstart = await readFile(
      path.join(wikiRoot, "quickstart.md"),
      "utf8",
    );
    expect(quickstart).toContain("[可复用经验](lessons/)");
    const themes = await readFile(path.join(wikiRoot, "themes.md"), "utf8");
    expect(themes).toContain("### 质量");
    expect(themes).toContain(lessonFiles[0]);
  });

  test("a broken relative link is a blocking quality issue", async () => {
    const { refs, stateRoot, wikiRoot } = await fixture();
    const candidate = lesson(refs[0], "所有链接必须可解析。");
    const generated = await generatePersonalWikiFallback(
      wikiRoot,
      [candidate],
      "zh-CN",
      stateRoot,
    );
    expect(generated.report.valid).toBe(true);
    const pagePath = path.join(wikiRoot, generated.files[0]);
    await writeFile(
      pagePath,
      `${await readFile(pagePath, "utf8")}\n[失效链接](missing-page.md)\n`,
    );

    const report = await finalizePersonalWiki(wikiRoot, {
      allowFallbackGenerated: true,
      candidates: [candidate],
      language: "zh-CN",
      stateRoot,
    });
    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "broken_link" }),
    );
  });

  test("redacts personal absolute paths left by an earlier Agent pass", async () => {
    const { refs, stateRoot, wikiRoot } = await fixture();
    const sourcesDir = path.join(wikiRoot, "sources");
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(
      path.join(sourcesDir, "index.md"),
      "# 证据来源\n\n上一轮来源文件：/Users/weijian/Documents/private-export.json\n",
    );
    await writeFile(
      path.join(sourcesDir, "source-evidence-stale.md"),
      String.raw`---
title: 旧来源
---

Windows 路径：C:\Users\weijian\Desktop\private.json
`,
    );

    const result = await generatePersonalWikiFallback(
      wikiRoot,
      [lesson(refs[0], "历史页面中的本机路径必须自动隐藏。")],
      "zh-CN",
      stateRoot,
    );

    expect(result.report.valid).toBe(true);
    const sourceIndex = await readFile(
      path.join(sourcesDir, "index.md"),
      "utf8",
    );
    const staleSource = await readFile(
      path.join(sourcesDir, "source-evidence-stale.md"),
      "utf8",
    );
    expect(sourceIndex).not.toMatch(/\/Users\/weijian\//u);
    expect(staleSource).not.toMatch(/[A-Za-z]:\\Users\\weijian\\/u);
    expect(staleSource).toContain("本地路径已隐藏");
  });

  test("blocks a batch-created page that cannot be traced to its candidates", async () => {
    const { refs, stateRoot, wikiRoot } = await fixture();
    const candidate = lesson(refs[0], "所有新知识必须带来源。");
    const generated = await generatePersonalWikiFallback(
      wikiRoot,
      [candidate],
      "zh-CN",
      stateRoot,
    );
    expect(generated.report.valid).toBe(true);
    const baselineBodies = await capturePersonalWikiBodySnapshot(wikiRoot);
    await writeFile(
      path.join(wikiRoot, "lessons", "untraceable.md"),
      "# 无来源页面\n\n这是本批额外生成、但无法关联候选证据的内容。\n",
    );

    const report = await finalizePersonalWiki(wikiRoot, {
      allowFallbackGenerated: true,
      baselineBodies,
      candidates: [candidate],
      language: "zh-CN",
      stateRoot,
    });
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "untraceable_batch_mutation" }),
    );
    expect(report.valid).toBe(false);
  });

  test("repairs an unambiguous root-relative target before link validation", async () => {
    const { refs, stateRoot, wikiRoot } = await fixture();
    const candidate = lesson(refs[0], "可证明的旧相对路径可以自动修复。");
    const generated = await generatePersonalWikiFallback(
      wikiRoot,
      [candidate],
      "zh-CN",
      stateRoot,
    );
    const pagePath = path.join(wikiRoot, generated.files[0]);
    await writeFile(
      pagePath,
      `${await readFile(pagePath, "utf8")}\n[个人知识库](quickstart.md)\n`,
    );

    const report = await finalizePersonalWiki(wikiRoot, {
      allowFallbackGenerated: true,
      candidates: [candidate],
      language: "zh-CN",
      stateRoot,
    });
    expect(report.valid).toBe(true);
    expect(
      report.repairedLinks?.some((link) =>
        link.includes("quickstart.md -> ../quickstart.md"),
      ),
    ).toBe(true);
    expect(await readFile(pagePath, "utf8")).toContain(
      "[个人知识库](../quickstart.md)",
    );
  });

  test("rebuilds commitment and open-question tracking pages", async () => {
    const { refs, stateRoot, wikiRoot } = await fixture();
    const commitment: KnowledgeCandidate = {
      ...lesson(refs[0], "已经承诺补齐回归测试。"),
      stableKey: "hwj-wiki/commitment/补齐回归测试",
      title: "补齐回归测试",
      type: "Commitment",
    };
    const openQuestion: KnowledgeCandidate = {
      ...lesson(refs[1], "仍需确认真实历史的整理耗时。"),
      stableKey: "hwj-wiki/openquestion/真实历史耗时",
      title: "真实历史整理耗时",
      type: "OpenQuestion",
    };
    const result = await generatePersonalWikiFallback(
      wikiRoot,
      [commitment, openQuestion],
      "zh-CN",
      stateRoot,
    );
    expect(result.report.valid).toBe(true);
    expect(
      await readFile(path.join(wikiRoot, "commitments.md"), "utf8"),
    ).toContain("commitments/commitment-");
    expect(
      await readFile(path.join(wikiRoot, "open-questions.md"), "utf8"),
    ).toContain("open-questions/open-question-");
  });

  test("keeps identical titles separate across knowledge types", async () => {
    const { refs, stateRoot, wikiRoot } = await fixture();
    const project: KnowledgeCandidate = {
      ...lesson(refs[0], "这是一个项目事实。"),
      stableKey: "hwj-wiki/project/同名主题",
      title: "同名主题",
      type: "Project",
    };
    const reusableLesson: KnowledgeCandidate = {
      ...lesson(refs[1], "这是一个跨项目经验。"),
      stableKey: "hwj-wiki/lesson/同名主题",
      title: "同名主题",
    };

    const result = await generatePersonalWikiFallback(
      wikiRoot,
      [project, reusableLesson],
      "zh-CN",
      stateRoot,
    );

    expect(result.report.valid).toBe(true);
    expect(result.files.some((file) => file.startsWith("projects/"))).toBe(
      true,
    );
    expect(result.files.some((file) => file.startsWith("lessons/"))).toBe(true);
  });

  test("does not upgrade old unverified volatile evidence implicitly", async () => {
    const { refs, stateRoot, wikiRoot } = await fixture();
    const first = {
      ...lesson(refs[0], "某项能力目前仍需验证。"),
      confidence: "unverified" as const,
    };
    const second = {
      ...lesson(refs[1], "新记录没有再次声明它易过期。"),
      confidence: "confirmed" as const,
      validAsOf: undefined,
      volatile: false,
    };
    await generatePersonalWikiFallback(
      wikiRoot,
      [first, second],
      "zh-CN",
      stateRoot,
    );
    const lessonFile = (await readdir(path.join(wikiRoot, "lessons"))).find(
      (file) => file !== "index.md",
    );
    const content = await readFile(
      path.join(wikiRoot, "lessons", lessonFile ?? ""),
      "utf8",
    );
    expect(content).toContain('confidence: "unverified"');
    expect(content).toContain("volatile: true");
    expect(content).toContain("validAsOf:");
  });
});

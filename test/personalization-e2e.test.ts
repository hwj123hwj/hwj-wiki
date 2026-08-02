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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  acknowledgeCandidateReview,
  extractKnowledgeCandidates,
  listCandidateReviews,
  markCandidateCheckpointForReview,
  type KnowledgeCandidate,
} from "../src/personalization/candidates.ts";
import { generatePersonalWikiFallback } from "../src/personalization/fallback.ts";
import { finalizePersonalWiki } from "../src/personalization/finalize.ts";
import {
  acknowledgePersonalHistoryBatches,
  collectPersonalHistory,
} from "../src/personalization/history.ts";
import { mergeCandidatesDeterministically } from "../src/personalization/merge.ts";
import { runPersonalBatchPipeline } from "../src/personalization/run.ts";

const temporaryRoots: string[] = [];
const originalProvider = process.env.OPENWIKI_PROVIDER;
const originalModel = process.env.OPENWIKI_MODEL_ID;

beforeEach(() => {
  process.env.OPENWIKI_PROVIDER = "openai-compatible";
  process.env.OPENWIKI_MODEL_ID = "coding";
});

afterEach(async () => {
  if (originalProvider === undefined) delete process.env.OPENWIKI_PROVIDER;
  else process.env.OPENWIKI_PROVIDER = originalProvider;
  if (originalModel === undefined) delete process.env.OPENWIKI_MODEL_ID;
  else process.env.OPENWIKI_MODEL_ID = originalModel;
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("personal workflow end to end", () => {
  test("drains four connectors, drops noise, and merges conflicting duplicate themes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hwj-e2e-"));
    temporaryRoots.push(root);
    const wikiRoot = path.join(root, "wiki");
    const stateRoot = path.join(root, "state");
    const roots = {
      antigravity: path.join(root, "antigravity"),
      codex: path.join(root, "codex"),
      doubao: path.join(root, "doubao"),
      pi: path.join(root, "pi"),
    } as const;
    await Promise.all(
      [wikiRoot, stateRoot, ...Object.values(roots)].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );

    const piEvents = [JSON.stringify({ id: "pi-session", type: "session" })];
    for (let index = 0; index < 120; index += 1) {
      piEvents.push(
        JSON.stringify({
          id: `pi-${index}`,
          message: {
            content: `Pi 证据 ${index}：批次上限应为 80。`,
            role: "user",
          },
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
      `${JSON.stringify({ payload: { content: "Codex 证据：批次上限应为 100。", role: "user", type: "message" }, type: "response_item" })}\n`,
    );
    await writeFile(
      path.join(roots.antigravity, "antigravity.jsonl"),
      `${JSON.stringify({ content: "你好，谢谢，再见。", source: "USER_EXPLICIT" })}\n`,
    );
    await writeFile(
      path.join(roots.doubao, "doubao.json"),
      JSON.stringify({
        messages: [
          {
            messageId: "doubao-1",
            role: "user",
            text: "豆包证据：批次处理后必须立即保存 checkpoint。",
          },
        ],
      }),
    );

    let currentCandidates: KnowledgeCandidate[] = [];
    const invokeModel = (messages: Array<{ content: unknown }>) => {
      const content = messages.at(-1)?.content;
      const text =
        typeof content === "string" ? content : JSON.stringify(content ?? "");
      const refs = [...text.matchAll(/"sourceRef":"([^"]+)"/gu)].map(
        (match) => match[1],
      );
      const sourceRef = refs[0];
      if (!sourceRef || sourceRef.startsWith("antigravity-history:")) {
        return Promise.resolve('{"candidates":[]}');
      }
      const fact = sourceRef.startsWith("pi-history:")
        ? "批次上限应为 80。"
        : sourceRef.startsWith("codex-history:")
          ? "批次上限应为 100。"
          : "每批成功后立即保存 checkpoint。";
      return Promise.resolve(
        JSON.stringify({
          candidates: [
            {
              confidence: "source-backed",
              decisions: [],
              facts: [fact],
              project: "hwj-wiki",
              reusableLessons: ["批处理必须可恢复并保留精确来源。"],
              sourceRefs: [sourceRef],
              stableKey: "ignored-by-normalizer",
              summary: "个人历史按小批次处理，并在成功后保存可恢复进度。",
              tags: ["批处理", "知识库"],
              title: "可恢复的个人知识批处理",
              type: "Lesson",
              volatile: false,
            },
          ],
        }),
      );
    };

    const result = await runPersonalBatchPipeline(
      "init",
      wikiRoot,
      { language: "zh-CN", modelId: "coding", outputMode: "local-wiki" },
      {
        acknowledgeReview: acknowledgeCandidateReview,
        acknowledge: (history) =>
          acknowledgePersonalHistoryBatches(history, stateRoot),
        collect: (mode, repository) =>
          collectPersonalHistory(mode, repository, { roots, stateRoot }),
        extract: async (batch, scopeKey, modelId, language) => {
          const checkpoint = await extractKnowledgeCandidates(
            batch,
            scopeKey,
            modelId,
            language,
            { invokeModel, stateRoot },
          );
          currentCandidates = checkpoint.candidates;
          return checkpoint;
        },
        finalize: (directory, options) =>
          finalizePersonalWiki(directory, { ...options, stateRoot }),
        listReviews: (scopeKey) => listCandidateReviews(scopeKey, stateRoot),
        markReview: (batch, scopeKey) =>
          markCandidateCheckpointForReview(batch, scopeKey, stateRoot),
        runAgent: async (command, directory) => {
          await mergeCandidatesDeterministically(directory, currentCandidates, {
            fallbackGenerated: false,
          });
          return { command, model: "coding" };
        },
      },
    );

    expect(result).toMatchObject({
      backlogBatchCount: 0,
      processedBatchCount: 5,
      status: "complete",
    });
    const lessons = (await readdir(path.join(wikiRoot, "lessons"))).filter(
      (file) => file !== "index.md",
    );
    expect(lessons).toHaveLength(1);
    const page = await readFile(
      path.join(wikiRoot, "lessons", lessons[0]),
      "utf8",
    );
    expect(page).toContain("批次上限应为 80");
    expect(page).toContain("批次上限应为 100");
    expect(page).toContain("pi-history:");
    expect(page).toContain("codex-history:");
    expect(page).toContain("doubao-export:");
    expect(page).not.toContain("你好，谢谢，再见");
    expect(page).toContain("fallbackGenerated: false");
  });

  test("fallback drains raw backlog and a later native run clears the review queue", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hwj-review-e2e-"));
    temporaryRoots.push(root);
    const wikiRoot = path.join(root, "wiki");
    const stateRoot = path.join(root, "state");
    const roots = {
      antigravity: path.join(root, "antigravity"),
      codex: path.join(root, "codex"),
      doubao: path.join(root, "doubao"),
      pi: path.join(root, "pi"),
    } as const;
    await Promise.all(
      [wikiRoot, stateRoot, ...Object.values(roots)].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    await writeFile(
      path.join(roots.codex, "review.jsonl"),
      `${JSON.stringify({ payload: { content: "降级后必须再次复核。", role: "user", type: "message" }, type: "response_item" })}\n`,
    );

    let currentCandidates: KnowledgeCandidate[] = [];
    let nativeAttempts = 0;
    const dependencies = {
      acknowledgeReview: acknowledgeCandidateReview,
      acknowledge: (
        history: Parameters<typeof acknowledgePersonalHistoryBatches>[0],
      ) => acknowledgePersonalHistoryBatches(history, stateRoot),
      collect: (mode: "code" | "personal", repository: string) =>
        collectPersonalHistory(mode, repository, { roots, stateRoot }),
      extract: async (
        batch: Parameters<typeof extractKnowledgeCandidates>[0],
        scopeKey: string,
        modelId: string,
        language: string,
      ) => {
        const result = await extractKnowledgeCandidates(
          batch,
          scopeKey,
          modelId,
          language,
          {
            invokeModel: (messages) => {
              const content = messages.at(-1)?.content;
              const text =
                typeof content === "string"
                  ? content
                  : JSON.stringify(content ?? "");
              const sourceRef = text.match(/"sourceRef":"([^"]+)"/u)?.[1];
              return Promise.resolve(
                JSON.stringify({
                  candidates: sourceRef
                    ? [
                        {
                          confidence: "source-backed",
                          decisions: [],
                          facts: ["降级页面需要由正常 Agent 复核"],
                          reusableLessons: ["复核队列清空前不能 complete"],
                          sourceRefs: [sourceRef],
                          stableKey: "review/fallback",
                          summary:
                            "把安全降级和正常 Agent 复核拆成两个 checkpoint。",
                          tags: ["降级", "复核"],
                          title: "安全降级复核",
                          type: "Lesson",
                          volatile: false,
                        },
                      ]
                    : [],
                }),
              );
            },
            stateRoot,
          },
        );
        currentCandidates = result.candidates;
        return result;
      },
      fallback: (
        directory: string,
        candidates: KnowledgeCandidate[],
        language: string,
      ) =>
        generatePersonalWikiFallback(
          directory,
          candidates,
          language,
          stateRoot,
        ),
      finalize: (
        directory: string,
        options: Parameters<typeof finalizePersonalWiki>[1],
      ) => finalizePersonalWiki(directory, { ...options, stateRoot }),
      listReviews: (scopeKey: string) =>
        listCandidateReviews(scopeKey, stateRoot),
      markReview: (
        batch: Parameters<typeof markCandidateCheckpointForReview>[0],
        scopeKey: string,
      ) => markCandidateCheckpointForReview(batch, scopeKey, stateRoot),
      runAgent: async (
        command: "chat" | "init" | "update",
        directory: string,
      ) => {
        nativeAttempts += 1;
        if (nativeAttempts === 1) throw new Error("tool protocol failed");
        await mergeCandidatesDeterministically(directory, currentCandidates, {
          fallbackGenerated: false,
        });
        return { command, model: "coding" };
      },
    };

    const first = await runPersonalBatchPipeline(
      "init",
      wikiRoot,
      { language: "zh-CN", modelId: "coding", outputMode: "local-wiki" },
      dependencies,
    );
    expect(first).toMatchObject({
      backlogBatchCount: 0,
      pendingReviewCount: 1,
      processedBatchCount: 1,
      status: "partial",
    });
    expect(await listCandidateReviews("personal", stateRoot)).toHaveLength(1);
    const lessonFile = (await readdir(path.join(wikiRoot, "lessons"))).find(
      (file) => file !== "index.md",
    );
    expect(
      await readFile(path.join(wikiRoot, "lessons", lessonFile ?? ""), "utf8"),
    ).toContain("fallbackGenerated: true");

    const second = await runPersonalBatchPipeline(
      "update",
      wikiRoot,
      { language: "zh-CN", modelId: "coding", outputMode: "local-wiki" },
      dependencies,
    );
    expect(second).toMatchObject({
      pendingReviewCount: 0,
      reviewBatchCount: 1,
      status: "complete",
    });
    expect(await listCandidateReviews("personal", stateRoot)).toEqual([]);
    expect(
      await readFile(path.join(wikiRoot, "lessons", lessonFile ?? ""), "utf8"),
    ).toContain("fallbackGenerated: false");
  });
});

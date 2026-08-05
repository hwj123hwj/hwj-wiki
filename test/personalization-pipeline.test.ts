import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  CandidateBatchCheckpoint,
  CandidateReviewTask,
  KnowledgeCandidate,
} from "../src/personalization/candidates.ts";
import type {
  PersonalHistoryBatch,
  PersonalHistoryCollection,
} from "../src/personalization/history.ts";
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

async function wikiRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hwj-pipeline-"));
  temporaryRoots.push(root);
  return root;
}

function batch(
  source: PersonalHistoryBatch["source"],
  index: number,
): PersonalHistoryBatch {
  const connectorId = {
    antigravity: "antigravity-history",
    codex: "codex-history",
    doubao: "doubao-export",
    pi: "pi-history",
  }[source] as PersonalHistoryBatch["connectorId"];
  return {
    byteSize: 100,
    connectorId,
    key: `run-${index}/records-0001.json`,
    path: `run-${index}/records-0001.json`,
    recordCount: 1,
    source,
  };
}

function collection(queue: PersonalHistoryBatch[]): PersonalHistoryCollection {
  const selected = queue[0];
  const backlogBySource: PersonalHistoryCollection["backlogBySource"] = {};
  for (const item of queue) {
    backlogBySource[item.source] = (backlogBySource[item.source] ?? 0) + 1;
  }
  return {
    backlogBatchCount: queue.length,
    backlogBySource,
    batches: selected ? [selected] : [],
    rawFiles: selected ? [selected.path] : [],
    recordCount: selected?.recordCount ?? 0,
    scanBlockedSources: [],
    scanPendingSources: [],
    scopeKey: "personal",
    sources: selected ? [selected.source] : [],
    warnings: [],
  };
}

function checkpoint(
  item: PersonalHistoryBatch,
  candidates: KnowledgeCandidate[] = [],
): CandidateBatchCheckpoint {
  return {
    batchKey: item.key,
    candidates,
    connectorId: item.connectorId,
    extractedAt: "2026-08-02T00:00:00Z",
    model: "coding",
    rawHash: "hash",
    source: item.source,
    version: 1,
  };
}

const validReport = { filesScanned: 2, issues: [], valid: true } as const;

describe("personal multi-batch pipeline", () => {
  test("returns partial instead of complete when a source cannot be scanned", async () => {
    const root = await wikiRoot();
    const result = await runPersonalBatchPipeline(
      "init",
      root,
      { language: "zh-CN", modelId: "coding", outputMode: "local-wiki" },
      {
        collect: () =>
          Promise.resolve({
            ...collection([]),
            scanBlockedSources: ["doubao"],
            warnings: ["doubao: archive is too large"],
          }),
        finalize: () => Promise.resolve(validReport),
        listReviews: () => Promise.resolve([]),
      },
    );

    expect(result).toMatchObject({
      blockedSourceCount: 1,
      status: "partial",
    });
    expect(
      JSON.parse(await readFile(path.join(root, ".last-update.json"), "utf8")),
    ).toMatchObject({ scanBlockedSources: ["doubao"], status: "partial" });
  });

  test("continues scanning when a local window contains no knowledge records", async () => {
    const root = await wikiRoot();
    const queue = [batch("codex", 1)];
    let collects = 0;
    let acknowledgements = 0;

    const result = await runPersonalBatchPipeline(
      "init",
      root,
      { language: "zh-CN", modelId: "coding", outputMode: "local-wiki" },
      {
        acknowledge: () => {
          acknowledgements += 1;
          queue.shift();
          return Promise.resolve();
        },
        collect: () => {
          collects += 1;
          if (collects === 1) {
            return Promise.resolve({
              ...collection([]),
              scanPendingSources: ["codex"],
            });
          }
          return Promise.resolve(collection(queue));
        },
        extract: (item) => Promise.resolve(checkpoint(item)),
        finalize: () => Promise.resolve(validReport),
        listReviews: () => Promise.resolve([]),
      },
    );

    expect(collects).toBe(3);
    expect(acknowledgements).toBe(1);
    expect(result.status).toBe("complete");
  });

  test("one command drains multiple sources and acknowledges every empty batch", async () => {
    const root = await wikiRoot();
    const queue = [
      batch("pi", 1),
      batch("codex", 2),
      batch("antigravity", 3),
      batch("doubao", 4),
    ];
    const acknowledged: string[] = [];

    const result = await runPersonalBatchPipeline(
      "init",
      root,
      { language: "zh-CN", modelId: "coding", outputMode: "local-wiki" },
      {
        acknowledge: (current) => {
          acknowledged.push(current.batches[0].key);
          queue.shift();
          return Promise.resolve();
        },
        collect: () => Promise.resolve(collection(queue)),
        extract: (item) => Promise.resolve(checkpoint(item)),
        finalize: () => Promise.resolve(validReport),
        listReviews: () => Promise.resolve([]),
      },
    );

    expect(acknowledged).toHaveLength(4);
    expect(result).toMatchObject({
      backlogBatchCount: 0,
      processedBatchCount: 4,
      status: "complete",
    });
    const metadata = JSON.parse(
      await readFile(path.join(root, ".last-update.json"), "utf8"),
    ) as { status: string };
    expect(metadata.status).toBe("complete");
  });

  test("an interrupted extraction resumes without duplicate consumption", async () => {
    const root = await wikiRoot();
    const queue = [batch("codex", 1)];
    let attempts = 0;
    let acknowledgements = 0;
    const dependencies = {
      acknowledge: () => {
        acknowledgements += 1;
        queue.shift();
        return Promise.resolve();
      },
      collect: () => Promise.resolve(collection(queue)),
      extract: (item: PersonalHistoryBatch) => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("gateway interrupted"))
          : Promise.resolve(checkpoint(item));
      },
      finalize: () => Promise.resolve(validReport),
      listReviews: () => Promise.resolve([]),
    };

    await expect(
      runPersonalBatchPipeline(
        "init",
        root,
        { language: "zh-CN", modelId: "coding", outputMode: "local-wiki" },
        dependencies,
      ),
    ).rejects.toThrow("gateway interrupted");
    expect(acknowledgements).toBe(0);
    expect(
      JSON.parse(await readFile(path.join(root, ".last-update.json"), "utf8")),
    ).toMatchObject({ status: "partial" });

    const resumed = await runPersonalBatchPipeline(
      "update",
      root,
      { language: "zh-CN", modelId: "coding", outputMode: "local-wiki" },
      dependencies,
    );
    expect(resumed.status).toBe("complete");
    expect(acknowledgements).toBe(1);
  });

  test("fallback remains partial and the next native run reviews the same batch", async () => {
    const root = await wikiRoot();
    const item = batch("doubao", 1);
    const queue = [item];
    const candidate: KnowledgeCandidate = {
      confidence: "source-backed",
      decisions: [],
      facts: ["需要保留来源"],
      reusableLessons: [],
      sourceRefs: [
        "doubao-export:run-1/records-0001.json#111111111111111111111111",
      ],
      stableKey: "global/knowledgecard/来源规则",
      summary: "知识卡片需要保留来源。",
      tags: ["知识库"],
      title: "知识来源规则",
      type: "KnowledgeCard",
      volatile: false,
    };
    let nativeAttempts = 0;
    let acknowledgements = 0;
    let reviews: CandidateReviewTask[] = [];
    const dependencies = {
      acknowledgeReview: () => {
        reviews = [];
        return Promise.resolve();
      },
      acknowledge: () => {
        acknowledgements += 1;
        queue.shift();
        return Promise.resolve();
      },
      collect: () => Promise.resolve(collection(queue)),
      extract: () => Promise.resolve(checkpoint(item, [candidate])),
      fallback: () =>
        Promise.resolve({
          files: ["doubao-knowledge/card.md"],
          report: validReport,
        }),
      finalize: () => Promise.resolve(validReport),
      listReviews: () => Promise.resolve(reviews),
      markReview: () => {
        reviews = [
          {
            ...checkpoint(item, [candidate]),
            checkpointPath: "/private/candidate.json",
            id: `${item.connectorId}\0${item.key}`,
            reviewRequired: true,
          },
        ];
        return Promise.resolve();
      },
      runAgent: (command: "chat" | "init" | "update") => {
        nativeAttempts += 1;
        return nativeAttempts === 1
          ? Promise.reject(new Error("tool protocol failed"))
          : Promise.resolve({ command, model: "coding" });
      },
    };

    const first = await runPersonalBatchPipeline(
      "init",
      root,
      { language: "zh-CN", modelId: "coding", outputMode: "local-wiki" },
      dependencies,
    );
    expect(first).toMatchObject({
      backlogBatchCount: 0,
      pendingReviewCount: 1,
      processedBatchCount: 1,
      status: "partial",
    });
    expect(acknowledgements).toBe(1);

    const second = await runPersonalBatchPipeline(
      "update",
      root,
      { language: "zh-CN", modelId: "coding", outputMode: "local-wiki" },
      dependencies,
    );
    expect(second.status).toBe("complete");
    expect(nativeAttempts).toBe(2);
    expect(acknowledgements).toBe(1);
  });

  test("does not demote every later batch after one native merge failure", async () => {
    const root = await wikiRoot();
    const first = batch("doubao", 1);
    const second = batch("codex", 2);
    const queue = [first, second];
    const reviews: CandidateReviewTask[] = [];
    const candidate: KnowledgeCandidate = {
      confidence: "source-backed",
      decisions: [],
      facts: ["批次需要保留可恢复进度"],
      reusableLessons: [],
      sourceRefs: ["doubao-export:run-1/records-0001.json#candidate"],
      stableKey: "global/lesson/retryable-batch",
      summary: "批次失败后应允许后续批次继续尝试原生合并。",
      tags: ["批处理"],
      title: "原生合并失败不应污染后续批次",
      type: "Lesson",
      volatile: false,
    };
    let nativeAttempts = 0;

    const result = await runPersonalBatchPipeline(
      "update",
      root,
      { language: "zh-CN", modelId: "coding", outputMode: "local-wiki" },
      {
        acknowledge: () => {
          queue.shift();
          return Promise.resolve();
        },
        collect: () => Promise.resolve(collection(queue)),
        extract: (item) => Promise.resolve(checkpoint(item, [candidate])),
        fallback: () =>
          Promise.resolve({
            files: ["lessons/fallback.md"],
            report: validReport,
          }),
        finalize: () => Promise.resolve(validReport),
        listReviews: () => Promise.resolve(reviews),
        markReview: (item) => {
          reviews.push({
            ...checkpoint(item, [candidate]),
            checkpointPath: "/private/checkpoint.json",
            id: `${item.connectorId}\0${item.key}`,
            reviewRequired: true,
          });
          return Promise.resolve();
        },
        runAgent: (command: "chat" | "init" | "update") => {
          nativeAttempts += 1;
          if (nativeAttempts === 1) {
            return Promise.reject(new Error("temporary native failure"));
          }
          return Promise.resolve({ command, model: "coding" });
        },
      },
    );

    expect(result).toMatchObject({
      backlogBatchCount: 0,
      pendingReviewCount: 1,
      processedBatchCount: 2,
      status: "partial",
    });
    expect(nativeAttempts).toBe(2);
  });
});

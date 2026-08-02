import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  acknowledgeCandidateReview,
  extractKnowledgeCandidates,
  listCandidateReviews,
  markCandidateCheckpointForReview,
} from "../src/personalization/candidates.ts";
import type { PersonalHistoryBatch } from "../src/personalization/history.ts";
import { createCandidateMergeMessage } from "../src/personalization/merge.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function candidateFixture(
  role: "assistant" | "user" = "user",
  text = "coding 模型当前版本支持工具调用，这项能力以后可能变化。",
) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "hwj-candidates-"));
  temporaryRoots.push(stateRoot);
  const relativePath = "run-1/records-0001.json";
  const rawDir = path.join(stateRoot, "codex-history", "raw", "run-1");
  await mkdir(rawDir, { recursive: true });
  await writeFile(
    path.join(rawDir, "records-0001.json"),
    JSON.stringify({
      generatedAt: "2026-08-02T01:00:00Z",
      records: [
        {
          id: "1234567890abcdef12345678",
          kind: "message",
          role,
          sessionId: "codex-session",
          source: "codex",
          text,
          timestamp: "2026-08-01T08:00:00Z",
        },
      ],
      scopeKey: "personal",
    }),
  );
  const batch: PersonalHistoryBatch = {
    byteSize: 500,
    connectorId: "codex-history",
    key: relativePath,
    path: relativePath,
    recordCount: 1,
    source: "codex",
  };
  const sourceRef =
    "codex-history:run-1/records-0001.json#1234567890abcdef12345678";
  return { batch, sourceRef, stateRoot };
}

async function multiRecordCandidateFixture(
  recordCount: number,
  textLength: number,
) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "hwj-candidates-"));
  temporaryRoots.push(stateRoot);
  const relativePath = "run-1/records-0002.json";
  const rawDir = path.join(stateRoot, "codex-history", "raw", "run-1");
  await mkdir(rawDir, { recursive: true });
  const records = Array.from({ length: recordCount }, (_, index) => ({
    id: `1234567890abcdef123456${String(index).padStart(2, "0")}`,
    kind: "message",
    role: "user" as const,
    sessionId: "codex-session",
    source: "codex" as const,
    text: `记录 ${index}\n${"x".repeat(textLength)}`,
    timestamp: "2026-08-01T08:00:00Z",
  }));
  await writeFile(
    path.join(rawDir, "records-0002.json"),
    JSON.stringify({
      generatedAt: "2026-08-02T01:00:00Z",
      records,
      scopeKey: "personal",
    }),
  );
  const batch: PersonalHistoryBatch = {
    byteSize: 500,
    connectorId: "codex-history",
    key: relativePath,
    path: relativePath,
    recordCount,
    source: "codex",
  };
  return { batch, stateRoot };
}

function candidateResponseForMessages(
  messages: Array<{ content: unknown }>,
  title: string,
): string {
  const content = messages[1]?.content;
  const prompt =
    typeof content === "string" ? content : JSON.stringify(content);
  const sourceRef = /"sourceRef":"([^"]+)"/u.exec(prompt)?.[1];
  if (!sourceRef) throw new Error("test prompt did not contain a sourceRef");
  return JSON.stringify({
    candidates: [
      {
        confidence: "source-backed",
        decisions: [],
        facts: [],
        reusableLessons: ["按批次边界提取，避免单次请求过大"],
        sourceRefs: [sourceRef],
        summary: `${title}摘要`,
        tags: ["测试"],
        title,
        type: "Lesson",
        volatile: false,
      },
    ],
  });
}

describe("personal knowledge candidate extraction", () => {
  test("splits oversized batches before invoking the model", async () => {
    const { batch, stateRoot } = await multiRecordCandidateFixture(4, 15_000);
    let invocations = 0;
    const checkpoint = await extractKnowledgeCandidates(
      batch,
      "personal",
      "coding",
      "zh-CN",
      {
        invokeModel: (messages) => {
          invocations += 1;
          return Promise.resolve(
            candidateResponseForMessages(messages, `批次分片 ${invocations}`),
          );
        },
        stateRoot,
      },
    );

    expect(invocations).toBeGreaterThan(1);
    expect(checkpoint.candidates).toHaveLength(invocations);
    expect(
      checkpoint.candidates.every(
        (candidate) => candidate.sourceRefs.length > 0,
      ),
    ).toBe(true);
  });

  test("splits a chunk after an abort instead of repeating the same oversized request", async () => {
    const { batch, stateRoot } = await multiRecordCandidateFixture(4, 100);
    let invocations = 0;
    const checkpoint = await extractKnowledgeCandidates(
      batch,
      "personal",
      "coding",
      "zh-CN",
      {
        invokeModel: (messages) => {
          invocations += 1;
          if (invocations === 1) {
            return Promise.reject(new Error("Request was aborted"));
          }
          return Promise.resolve(
            candidateResponseForMessages(messages, `重试分片 ${invocations}`),
          );
        },
        stateRoot,
      },
    );

    expect(invocations).toBe(3);
    expect(checkpoint.candidates).toHaveLength(2);
  });

  test("keeps the merge pass scoped to candidates instead of rereading raw history", () => {
    const message = createCandidateMergeMessage(
      [
        {
          confidence: "source-backed",
          decisions: ["通过质量门后再确认批次"],
          facts: [],
          reusableLessons: [],
          sourceRefs: [
            "codex-history:run-1/records-0001.json#1234567890abcdef12345678",
          ],
          stableKey: "hwj-wiki/decision/quality-gate",
          summary: "批次确认必须服从统一质量门。",
          tags: ["质量"],
          title: "批次质量门",
          type: "Decision",
          volatile: false,
        },
      ],
      "zh-CN",
    );

    expect(message).toContain("不得重新读取或摄取");
    expect(message).toContain("不得创建或改写任何其他概念页");
    expect(message).toContain("fallbackGenerated: false");
    expect(message).not.toContain("openwiki_read_personal_history_batch");
  });

  test("checkpoints traceable candidates and normalizes volatile evidence", async () => {
    const { batch, sourceRef, stateRoot } = await candidateFixture("assistant");
    let invocations = 0;
    const invokeModel = () => {
      invocations += 1;
      return Promise.resolve(
        JSON.stringify({
          candidates: [
            {
              confidence: "confirmed",
              decisions: [],
              facts: ["coding 模型支持工具调用"],
              reusableLessons: ["产品能力需要按日期复核"],
              sourceRefs: [sourceRef, "codex-history:bad#not-allowed"],
              stableKey: "model/coding/capability",
              summary: "记录 coding 模型当前的工具调用能力。",
              tags: ["模型", "版本"],
              title: "coding 模型工具调用能力",
              type: "KnowledgeCard",
              volatile: false,
            },
          ],
        }),
      );
    };

    const first = await extractKnowledgeCandidates(
      batch,
      "personal",
      "coding",
      "zh-CN",
      { invokeModel, stateRoot },
    );
    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]).toMatchObject({
      confidence: "unverified",
      sourceRefs: [sourceRef],
      validAsOf: "2026-08-01T08:00:00Z",
      volatile: true,
    });
    expect(first.candidates[0]?.stableKey).toContain("knowledgecard");

    const second = await extractKnowledgeCandidates(
      batch,
      "personal",
      "coding",
      "zh-CN",
      { invokeModel, stateRoot },
    );
    expect(second).toEqual(first);
    expect(invocations).toBe(1);
  });

  test("accepts an empty candidate set without manufacturing a page", async () => {
    const { batch, stateRoot } = await candidateFixture();
    const checkpoint = await extractKnowledgeCandidates(
      batch,
      "personal",
      "coding",
      "zh-CN",
      { invokeModel: () => Promise.resolve('{"candidates":[]}'), stateRoot },
    );
    expect(checkpoint.candidates).toEqual([]);
  });

  test("does not treat a user's question as a confirmed fact", async () => {
    const { batch, sourceRef, stateRoot } = await candidateFixture(
      "user",
      "coding 模型是否已经支持所有工具调用？",
    );
    const checkpoint = await extractKnowledgeCandidates(
      batch,
      "personal",
      "coding",
      "zh-CN",
      {
        invokeModel: () =>
          Promise.resolve(
            JSON.stringify({
              candidates: [
                {
                  confidence: "confirmed",
                  decisions: [],
                  facts: ["coding 模型支持所有工具调用"],
                  reusableLessons: [],
                  sourceRefs: [sourceRef],
                  stableKey: "model/tools",
                  summary: "coding 模型支持全部工具。",
                  tags: ["模型"],
                  title: "coding 模型工具支持",
                  type: "KnowledgeCard",
                  volatile: true,
                  validAsOf: "2026-08-01",
                },
              ],
            }),
          ),
        stateRoot,
      },
    );
    expect(checkpoint.candidates[0]?.confidence).toBe("unverified");
  });

  test("persists and acknowledges a separate fallback review checkpoint", async () => {
    const { batch, sourceRef, stateRoot } = await candidateFixture();
    await extractKnowledgeCandidates(batch, "personal", "coding", "zh-CN", {
      invokeModel: () =>
        Promise.resolve(
          JSON.stringify({
            candidates: [
              {
                confidence: "source-backed",
                decisions: [],
                facts: ["降级页面后续需要复核"],
                reusableLessons: [],
                sourceRefs: [sourceRef],
                stableKey: "review/fallback",
                summary: "降级页面必须进入独立复核队列。",
                tags: ["复核"],
                title: "降级复核队列",
                type: "Lesson",
                volatile: false,
              },
            ],
          }),
        ),
      stateRoot,
    });
    await markCandidateCheckpointForReview(batch, "personal", stateRoot);
    const reviews = await listCandidateReviews("personal", stateRoot);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ reviewRequired: true });

    await acknowledgeCandidateReview(reviews[0]);
    expect(await listCandidateReviews("personal", stateRoot)).toEqual([]);
  });
});

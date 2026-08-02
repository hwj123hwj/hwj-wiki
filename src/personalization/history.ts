import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sanitizeDiagnosticText } from "../diagnostics.js";
import {
  ensureConnectorHome,
  getConnectorDir,
  getConnectorRawDir,
  openWikiConnectorsDir,
} from "../openwiki-home.js";

const execFileAsync = promisify(execFile);
const MAX_RECORD_TEXT_BYTES = 50_000;
const MAX_RAW_BATCH_BYTES = 80_000;
const MAX_RUN_RECORDS = 100;
const MAX_RUN_RAW_BYTES = 100_000;
const MAX_JSONL_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;
const PREFIX_SAMPLE_BYTES = 64 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export type PersonalWorkflowMode = "code" | "personal";

export interface PersonalHistoryRecord {
  id: string;
  kind: string;
  role?: string;
  sessionId: string;
  source: PersonalHistorySource;
  text: string;
  timestamp?: string;
}

export type PersonalHistorySource = "antigravity" | "codex" | "doubao" | "pi";

export const PERSONAL_HISTORY_CONNECTOR_IDS = [
  "pi-history",
  "codex-history",
  "antigravity-history",
  "doubao-export",
] as const;

export type PersonalHistoryConnectorId =
  (typeof PERSONAL_HISTORY_CONNECTOR_IDS)[number];

interface FileState {
  byteOffset: number;
  belongsToRepository?: boolean;
  headBytes?: number;
  headHash?: string;
  itemOffset?: number;
  prefixHash: string;
  sessionId?: string;
  size: number;
}

interface HistoryState {
  files: Record<string, FileState>;
  version: 1;
}

interface SourceDefinition {
  connectorId: PersonalHistoryConnectorId;
  format: "doubao" | "jsonl";
  root: string;
  source: PersonalHistorySource;
}

export interface CollectPersonalHistoryOptions {
  /** Test override for the bounded JSONL scan window. */
  maxJsonlScanBytes?: number;
  /** Test/advanced override for source roots. */
  roots?: Partial<Record<PersonalHistorySource, string>>;
  /** Test override; production uses ~/.openwiki/connectors. */
  stateRoot?: string;
}

export interface PersonalHistoryCollection {
  backlogBatchCount: number;
  backlogBySource: Partial<Record<PersonalHistorySource, number>>;
  batches: PersonalHistoryBatch[];
  rawFiles: string[];
  recordCount: number;
  scanBlockedSources: PersonalHistorySource[];
  scanPendingSources: PersonalHistorySource[];
  scopeKey: string;
  sources: PersonalHistorySource[];
  warnings: string[];
}

export interface PersonalHistoryBatch {
  byteSize: number;
  connectorId: PersonalHistoryConnectorId;
  key: string;
  path: string;
  recordCount: number;
  source: PersonalHistorySource;
}

interface ProcessingReceipt {
  processed: string[];
  version: 1;
}

interface SchedulerState {
  nextConnectorIndex: number;
  version: 1;
}

/**
 * Collects only new, sanitized conversation records. State is scoped per mode
 * (and per repository in code mode), so a project run can never consume the
 * personal wiki's cursor or another project's cursor.
 */
export async function collectPersonalHistory(
  mode: PersonalWorkflowMode,
  repoRoot: string,
  options: CollectPersonalHistoryOptions = {},
): Promise<PersonalHistoryCollection> {
  const definitions = sourceDefinitions(options.roots).filter(
    (definition) => mode === "personal" || definition.source !== "doubao",
  );
  const warnings: string[] = [];

  const canonicalRepoRoot =
    mode === "code" ? await canonicalizeExistingPath(repoRoot) : repoRoot;
  const scopeKey =
    mode === "personal"
      ? "personal"
      : `code-${sha256(canonicalRepoRoot).slice(0, 16)}`;

  if (mode === "personal") {
    warnings.push(...(await migrateLegacyAntigravityCache(options.stateRoot)));
  }

  let pending = await selectPendingBatches(scopeKey, mode, options.stateRoot);
  if (pending.batches.length > 0) {
    return collectionFromPending(
      scopeKey,
      pending,
      warnings,
      options.stateRoot,
      [],
      [],
    );
  }

  const scanBlockedSources: PersonalHistorySource[] = [];
  const scanPendingSources: PersonalHistorySource[] = [];

  if (mode === "personal") {
    const scheduler = await readSchedulerState(scopeKey, options.stateRoot);
    const orderedDefinitions = rotateDefinitions(
      definitions,
      scheduler.nextConnectorIndex,
    );

    // Each personal source gets its own bounded scan window. Pending selection
    // still returns one raw batch, so Agent context remains bounded while a
    // large Pi or Codex archive cannot prevent other sources being discovered.
    for (const definition of orderedDefinitions) {
      const result = await collectSource(
        definition,
        mode,
        canonicalRepoRoot,
        scopeKey,
        options.stateRoot,
        MAX_RUN_RECORDS,
        options.maxJsonlScanBytes,
      );
      warnings.push(...result.warnings);
      if (result.scanBlocked) scanBlockedSources.push(definition.source);
      if (result.scanPending) scanPendingSources.push(definition.source);
    }
  } else {
    // Preserve code mode's original shared per-run record budget and source
    // order. Personal backlog orchestration must not change repository docs.
    let remainingRecords = MAX_RUN_RECORDS;
    for (const definition of definitions) {
      if (remainingRecords <= 0) break;
      const result = await collectSource(
        definition,
        mode,
        canonicalRepoRoot,
        scopeKey,
        options.stateRoot,
        remainingRecords,
        options.maxJsonlScanBytes,
      );
      warnings.push(...result.warnings);
      if (result.scanBlocked) scanBlockedSources.push(definition.source);
      if (result.scanPending) scanPendingSources.push(definition.source);
      remainingRecords -= result.records.length;
    }
  }

  pending = await selectPendingBatches(scopeKey, mode, options.stateRoot);
  return collectionFromPending(
    scopeKey,
    pending,
    warnings,
    options.stateRoot,
    scanPendingSources,
    scanBlockedSources,
  );
}

export async function acknowledgePersonalHistoryBatches(
  collection: PersonalHistoryCollection,
  stateRoot?: string,
): Promise<void> {
  const byConnector = new Map<PersonalHistoryConnectorId, string[]>();
  for (const batch of collection.batches) {
    const keys = byConnector.get(batch.connectorId) ?? [];
    keys.push(batch.key);
    byConnector.set(batch.connectorId, keys);
  }

  for (const [connectorId, keys] of byConnector) {
    const storage = await resolveStorage(connectorId, stateRoot);
    const receiptPath = path.join(
      storage.connectorDir,
      `processed-${collection.scopeKey}.json`,
    );
    const receipt = await readProcessingReceipt(receiptPath);
    await writePrivateJsonAtomic(receiptPath, {
      processed: [...new Set([...receipt.processed, ...keys])].sort(),
      version: 1,
    } satisfies ProcessingReceipt);
  }

  const lastBatch = collection.batches.at(-1);
  if (lastBatch && collection.scopeKey === "personal") {
    const connectorIndex = PERSONAL_HISTORY_CONNECTOR_IDS.indexOf(
      lastBatch.connectorId,
    );
    await writeSchedulerState(
      collection.scopeKey,
      {
        nextConnectorIndex:
          (connectorIndex + 1) % PERSONAL_HISTORY_CONNECTOR_IDS.length,
        version: 1,
      },
      stateRoot,
    );
  }
}

function collectionFromPending(
  scopeKey: string,
  pending: {
    backlogBatchCount: number;
    backlogBySource: Partial<Record<PersonalHistorySource, number>>;
    batches: PersonalHistoryBatch[];
  },
  warnings: string[],
  stateRoot?: string,
  scanPendingSources: PersonalHistorySource[] = [],
  scanBlockedSources: PersonalHistorySource[] = [],
): PersonalHistoryCollection {
  return {
    backlogBatchCount: pending.backlogBatchCount,
    backlogBySource: pending.backlogBySource,
    batches: pending.batches,
    rawFiles: pending.batches.map((batch) =>
      path.join(
        stateRoot
          ? path.join(stateRoot, batch.connectorId, "raw")
          : getConnectorRawDir(batch.connectorId),
        ...batch.path.split("/"),
      ),
    ),
    recordCount: pending.batches.reduce(
      (total, batch) => total + batch.recordCount,
      0,
    ),
    scanBlockedSources: [...new Set(scanBlockedSources)],
    scanPendingSources: [...new Set(scanPendingSources)],
    scopeKey,
    sources: [...new Set(pending.batches.map((batch) => batch.source))],
    warnings,
  };
}

async function collectSource(
  definition: SourceDefinition,
  mode: PersonalWorkflowMode,
  repoRoot: string,
  scopeKey: string,
  stateRoot?: string,
  maxRecords = MAX_RUN_RECORDS,
  maxJsonlScanBytes = MAX_JSONL_SCAN_BYTES,
): Promise<{
  rawFiles: string[];
  records: PersonalHistoryRecord[];
  scanBlocked: boolean;
  scanPending: boolean;
  warnings: string[];
}> {
  if (!(await isDirectory(definition.root))) {
    return {
      rawFiles: [],
      records: [],
      scanBlocked: false,
      scanPending: false,
      warnings: [],
    };
  }

  const storage = await resolveStorage(definition.connectorId, stateRoot);
  const statePath = path.join(storage.connectorDir, `state-${scopeKey}.json`);
  const state = await readState(statePath);
  const nextState: HistoryState = { files: { ...state.files }, version: 1 };
  const files = await listSourceFiles(definition.root, definition);
  const records: PersonalHistoryRecord[] = [];
  let scanBlocked = false;
  let scanPending = false;
  const warnings: string[] = [];

  for (const [fileIndex, filePath] of files.entries()) {
    if (records.length >= maxRecords) {
      scanPending ||= fileIndex < files.length;
      break;
    }
    const relativePath = path
      .relative(definition.root, filePath)
      .split(path.sep)
      .join("/");
    try {
      const result =
        definition.format === "jsonl" && definition.source !== "doubao"
          ? await collectJsonlFile(
              definition.source,
              filePath,
              relativePath,
              state.files[relativePath],
              mode,
              repoRoot,
              maxRecords - records.length,
              maxJsonlScanBytes,
            )
          : await collectDoubaoFile(
              filePath,
              relativePath,
              state.files[relativePath],
              maxRecords - records.length,
            );
      records.push(...result.records);
      nextState.files[relativePath] = result.state;
      scanPending ||= result.hasMoreInput;
      warnings.push(...result.warnings);
    } catch (error) {
      scanBlocked = true;
      warnings.push(
        `${definition.source}:${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const rawFiles: string[] = [];
  if (records.length > 0) {
    const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
    const runDir = path.join(storage.rawDir, runId);
    await mkdir(runDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const batches = splitRecordBatches(records);
    for (const [index, batch] of batches.entries()) {
      const rawFile = path.join(
        runDir,
        `records-${String(index + 1).padStart(4, "0")}.json`,
      );
      await writePrivateJson(rawFile, {
        batch: index + 1,
        batchCount: batches.length,
        generatedAt: new Date().toISOString(),
        records: batch,
        scopeKey,
        source: definition.source,
        warningCount: warnings.length,
      });
      rawFiles.push(rawFile);
    }
  }

  // Advance cursors only after the sanitized raw batch is durable.
  await writePrivateJsonAtomic(statePath, nextState);
  return { rawFiles, records, scanBlocked, scanPending, warnings };
}

function splitRecordBatches(
  records: PersonalHistoryRecord[],
): PersonalHistoryRecord[][] {
  const batches: PersonalHistoryRecord[][] = [];
  let current: PersonalHistoryRecord[] = [];
  let currentBytes = 0;

  for (const record of records) {
    const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    if (
      current.length > 0 &&
      currentBytes + recordBytes > MAX_RAW_BATCH_BYTES
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(record);
    currentBytes += recordBytes;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

async function selectPendingBatches(
  scopeKey: string,
  mode: PersonalWorkflowMode,
  stateRoot?: string,
): Promise<{
  backlogBatchCount: number;
  backlogBySource: Partial<Record<PersonalHistorySource, number>>;
  batches: PersonalHistoryBatch[];
}> {
  const pending: PersonalHistoryBatch[] = [];

  for (const connectorId of PERSONAL_HISTORY_CONNECTOR_IDS) {
    const storage = await resolveStorage(connectorId, stateRoot);
    const receipt = await readProcessingReceipt(
      path.join(storage.connectorDir, `processed-${scopeKey}.json`),
    );
    const processed = new Set(receipt.processed);
    const source = sourceForConnector(connectorId);

    for (const relativePath of await listRawBatchFiles(storage.rawDir)) {
      if (processed.has(relativePath)) continue;
      const filePath = path.join(
        storage.rawDir,
        ...relativePath.split(path.posix.sep),
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.records)) continue;
      const batchScope = stringValue(parsed.scopeKey);
      const isLegacyPersonalBatch =
        batchScope === undefined &&
        mode === "personal" &&
        connectorId !== "antigravity-history";
      if (batchScope !== scopeKey && !isLegacyPersonalBatch) continue;
      const fileStat = await stat(filePath);
      pending.push({
        byteSize: fileStat.size,
        connectorId,
        key: relativePath,
        path: relativePath,
        recordCount: parsed.records.length,
        source,
      });
    }
  }

  pending.sort((left, right) =>
    `${left.path}\0${left.connectorId}`.localeCompare(
      `${right.path}\0${right.connectorId}`,
    ),
  );
  const backlogBySource: Partial<Record<PersonalHistorySource, number>> = {};
  for (const batch of pending) {
    backlogBySource[batch.source] = (backlogBySource[batch.source] ?? 0) + 1;
  }

  const selected =
    mode === "personal"
      ? selectFairPersonalBatch(
          pending,
          await readSchedulerState(scopeKey, stateRoot),
        )
      : selectCodeBatches(pending);

  return {
    backlogBatchCount: pending.length,
    backlogBySource,
    batches: Array.isArray(selected) ? selected : selected ? [selected] : [],
  };
}

function selectFairPersonalBatch(
  pending: PersonalHistoryBatch[],
  scheduler: SchedulerState,
): PersonalHistoryBatch | undefined {
  return rotateConnectors(scheduler.nextConnectorIndex)
    .map((connectorId) =>
      pending.find((batch) => batch.connectorId === connectorId),
    )
    .find((batch): batch is PersonalHistoryBatch => batch !== undefined);
}

function selectCodeBatches(
  pending: PersonalHistoryBatch[],
): PersonalHistoryBatch[] {
  const selected: PersonalHistoryBatch[] = [];
  let selectedBytes = 0;
  let selectedRecords = 0;
  for (const batch of pending) {
    if (
      selected.length > 0 &&
      (selectedBytes + batch.byteSize > MAX_RUN_RAW_BYTES ||
        selectedRecords + batch.recordCount > MAX_RUN_RECORDS)
    ) {
      break;
    }
    selected.push(batch);
    selectedBytes += batch.byteSize;
    selectedRecords += batch.recordCount;
  }
  return selected;
}

function rotateDefinitions(
  definitions: SourceDefinition[],
  nextConnectorIndex: number,
): SourceDefinition[] {
  const order = rotateConnectors(nextConnectorIndex);
  return [...definitions].sort(
    (left, right) =>
      order.indexOf(left.connectorId) - order.indexOf(right.connectorId),
  );
}

function rotateConnectors(
  nextConnectorIndex: number,
): PersonalHistoryConnectorId[] {
  const normalized =
    ((nextConnectorIndex % PERSONAL_HISTORY_CONNECTOR_IDS.length) +
      PERSONAL_HISTORY_CONNECTOR_IDS.length) %
    PERSONAL_HISTORY_CONNECTOR_IDS.length;
  return [
    ...PERSONAL_HISTORY_CONNECTOR_IDS.slice(normalized),
    ...PERSONAL_HISTORY_CONNECTOR_IDS.slice(0, normalized),
  ];
}

async function readSchedulerState(
  scopeKey: string,
  stateRoot?: string,
): Promise<SchedulerState> {
  try {
    const parsed = JSON.parse(
      await readFile(
        path.join(
          await coordinatorDir(stateRoot),
          `scheduler-${scopeKey}.json`,
        ),
        "utf8",
      ),
    ) as unknown;
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      typeof parsed.nextConnectorIndex === "number" &&
      Number.isInteger(parsed.nextConnectorIndex)
    ) {
      return {
        nextConnectorIndex: parsed.nextConnectorIndex,
        version: 1,
      };
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
  return { nextConnectorIndex: 0, version: 1 };
}

async function writeSchedulerState(
  scopeKey: string,
  state: SchedulerState,
  stateRoot?: string,
): Promise<void> {
  await writePrivateJsonAtomic(
    path.join(await coordinatorDir(stateRoot), `scheduler-${scopeKey}.json`),
    state,
  );
}

async function coordinatorDir(stateRoot?: string): Promise<string> {
  const directory = path.join(
    stateRoot ?? openWikiConnectorsDir,
    ".personalization",
  );
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  return directory;
}

async function listRawBatchFiles(
  root: string,
  current = root,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }

  const result: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listRawBatchFiles(root, entryPath)));
    } else if (entry.isFile() && /^records-\d+\.json$/u.test(entry.name)) {
      result.push(path.relative(root, entryPath).split(path.sep).join("/"));
    }
  }
  return result;
}

async function migrateLegacyAntigravityCache(
  stateRoot?: string,
): Promise<string[]> {
  const storage = await resolveStorage("antigravity-history", stateRoot);
  const markerPath = path.join(
    storage.connectorDir,
    "migration-v2-personal.json",
  );
  if (await fileExists(markerPath)) return [];

  const legacyPaths: string[] = [];
  for (const relativePath of await listRawBatchFiles(storage.rawDir)) {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(storage.rawDir, relativePath), "utf8"),
      ) as unknown;
      if (isRecord(parsed) && parsed.scopeKey === undefined) {
        legacyPaths.push(relativePath);
      }
    } catch {
      // A malformed cache is ignored by pending-batch selection as well.
    }
  }

  if (legacyPaths.length > 0) {
    // Version 0.1.x mixed canonical Antigravity sessions with generated logs.
    // Preserve the old cache for audit/recovery, but rescan canonical files with
    // the new directory filter instead of feeding the noisy legacy batches.
    await writePrivateJsonAtomic(
      path.join(storage.connectorDir, "state-personal.json"),
      { files: {}, version: 1 } satisfies HistoryState,
    );
    const receiptPath = path.join(
      storage.connectorDir,
      "processed-personal.json",
    );
    const receipt = await readProcessingReceipt(receiptPath);
    await writePrivateJsonAtomic(receiptPath, {
      processed: [...new Set([...receipt.processed, ...legacyPaths])].sort(),
      version: 1,
    } satisfies ProcessingReceipt);
  }
  await writePrivateJsonAtomic(markerPath, {
    ignoredLegacyRaw: legacyPaths.length,
    migratedAt: new Date().toISOString(),
    version: 1,
  });

  return legacyPaths.length > 0
    ? [
        "已保留但跳过旧版 Antigravity 混合日志缓存；后续将仅重新扫描正式会话文件。",
      ]
    : [];
}

async function readProcessingReceipt(
  filePath: string,
): Promise<ProcessingReceipt> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.processed)) {
      return {
        processed: parsed.processed.filter(
          (value): value is string => typeof value === "string",
        ),
        version: 1,
      };
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
  return { processed: [], version: 1 };
}

function sourceForConnector(
  connectorId: PersonalHistoryConnectorId,
): PersonalHistorySource {
  switch (connectorId) {
    case "pi-history":
      return "pi";
    case "codex-history":
      return "codex";
    case "antigravity-history":
      return "antigravity";
    case "doubao-export":
      return "doubao";
  }
}

async function collectJsonlFile(
  source: Exclude<PersonalHistorySource, "doubao">,
  filePath: string,
  relativePath: string,
  previous: FileState | undefined,
  mode: PersonalWorkflowMode,
  repoRoot: string,
  maxRecords: number,
  maxJsonlScanBytes: number,
): Promise<{
  hasMoreInput: boolean;
  records: PersonalHistoryRecord[];
  state: FileState;
  warnings: string[];
}> {
  const fileStat = await stat(filePath);
  const startOffset = await validPreviousOffset(
    filePath,
    fileStat.size,
    previous,
  );
  const window = await readJsonlWindow(
    filePath,
    startOffset,
    maxJsonlScanBytes,
  );
  const parsedEvents = window.lines.map((line) => line.event);
  const belongs =
    mode === "personal" ||
    previous?.belongsToRepository === true ||
    (await sessionBelongsToRepository(parsedEvents, repoRoot));
  const sessionId =
    previous?.sessionId ??
    findSessionId(parsedEvents) ??
    sha256(relativePath).slice(0, 16);
  const records: PersonalHistoryRecord[] = [];
  let processedOffset = startOffset;
  let stoppedForRecordLimit = false;

  for (const [index, line] of window.lines.entries()) {
    const record = belongs
      ? normalizeJsonlEvent(source, sessionId, line.event, startOffset, index)
      : undefined;
    if (record) {
      if (records.length >= maxRecords) {
        stoppedForRecordLimit = true;
        break;
      }
      records.push(record);
    }
    processedOffset = line.endOffset;
  }
  if (!stoppedForRecordLimit) processedOffset = window.scanEndOffset;

  const warnings =
    window.invalidLineCount > 0
      ? [
          `${relativePath}: ${window.invalidLineCount} invalid JSONL line(s) skipped in this scan window`,
        ]
      : [];
  const headBytes = Math.min(fileStat.size, PREFIX_SAMPLE_BYTES);
  const headHash = await hashFileHead(filePath, fileStat.size, headBytes);

  return {
    hasMoreInput: processedOffset < fileStat.size,
    records,
    state: {
      belongsToRepository: belongs,
      byteOffset: processedOffset,
      headBytes,
      headHash,
      prefixHash: headHash,
      sessionId,
      size: fileStat.size,
    },
    warnings,
  };
}

async function readJsonlWindow(
  filePath: string,
  startOffset: number,
  maxScanBytes: number,
): Promise<{
  invalidLineCount: number;
  lines: Array<{ endOffset: number; event: unknown }>;
  scanEndOffset: number;
}> {
  const fileHandle = await open(filePath, "r");
  const stream = fileHandle.createReadStream({
    autoClose: false,
    highWaterMark: 64 * 1024,
    start: startOffset,
  });
  const lines: Array<{ endOffset: number; event: unknown }> = [];
  let buffer = Buffer.alloc(0);
  let consumed = 0;
  let invalidLineCount = 0;
  let stoppedAtLimit = false;

  try {
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      let newlineIndex = buffer.indexOf(0x0a);
      while (newlineIndex !== -1) {
        const lineBytes = buffer.subarray(0, newlineIndex);
        const endOffset = startOffset + consumed + newlineIndex + 1;
        buffer = buffer.subarray(newlineIndex + 1);
        consumed += newlineIndex + 1;
        const text = lineBytes.toString("utf8").trim();
        if (text) {
          try {
            lines.push({ endOffset, event: JSON.parse(text) as unknown });
          } catch {
            invalidLineCount += 1;
          }
        }
        if (consumed >= maxScanBytes) {
          stoppedAtLimit = true;
          stream.destroy();
          break;
        }
        newlineIndex = buffer.indexOf(0x0a);
      }
      if (stoppedAtLimit) break;
      if (buffer.length > MAX_JSONL_LINE_BYTES) {
        // A single enormous JSONL entry must not make a multi-gigabyte file
        // exceed Node's Buffer limits. Advance over this private raw fragment;
        // the following scan will discard the remainder up to its newline.
        consumed += buffer.length;
        buffer = Buffer.alloc(0);
        invalidLineCount += 1;
        stoppedAtLimit = consumed >= maxScanBytes;
        if (stoppedAtLimit) {
          stream.destroy();
          break;
        }
      }
    }

    if (!stoppedAtLimit && buffer.length > 0) {
      consumed += buffer.length;
      const text = buffer.toString("utf8").trim();
      if (text) {
        try {
          lines.push({
            endOffset: startOffset + consumed,
            event: JSON.parse(text) as unknown,
          });
        } catch {
          invalidLineCount += 1;
        }
      }
    }
  } finally {
    stream.destroy();
    await fileHandle.close();
  }

  return {
    invalidLineCount,
    lines,
    scanEndOffset: startOffset + consumed,
  };
}

async function collectDoubaoFile(
  filePath: string,
  relativePath: string,
  previous: FileState | undefined,
  maxRecords: number,
): Promise<{
  hasMoreInput: boolean;
  records: PersonalHistoryRecord[];
  state: FileState;
  warnings: string[];
}> {
  const bytes = await readFile(filePath);
  const digest = sha256Bytes(bytes);
  const nextState = {
    byteOffset: bytes.length,
    prefixHash: digest,
    size: bytes.length,
  };
  if (
    previous !== undefined &&
    previous.size === bytes.length &&
    previous.prefixHash === digest &&
    previous.itemOffset === undefined
  ) {
    return {
      hasMoreInput: false,
      records: [],
      state: nextState,
      warnings: [],
    };
  }

  const sessionId = `doubao-${sha256(relativePath).slice(0, 16)}`;
  if (/\.md$/iu.test(filePath)) {
    const text = sanitizeImportedText(bytes.toString("utf8"));
    return {
      hasMoreInput: false,
      records: text
        ? [
            createRecord(
              "doubao",
              sessionId,
              `file:${sha256(relativePath).slice(0, 16)}`,
              "document",
              text,
            ),
          ]
        : [],
      state: nextState,
      warnings: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return {
      hasMoreInput: false,
      records: [],
      state: nextState,
      warnings: [`${relativePath}: invalid JSON skipped`],
    };
  }

  const messages: unknown[] =
    isRecord(parsed) && Array.isArray(parsed.messages)
      ? (parsed.messages as unknown[])
      : [];
  const records: PersonalHistoryRecord[] = [];
  const startIndex =
    previous?.prefixHash === digest ? (previous.itemOffset ?? 0) : 0;
  let nextIndex = startIndex;
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index];
    nextIndex = index + 1;
    if (!isRecord(message)) continue;
    const role = stringValue(message.role);
    if (role !== "user" && role !== "assistant") continue;
    const text = sanitizeImportedText(stringValue(message.text) ?? "");
    if (!text) continue;
    const eventId =
      stringValue(message.messageId) ??
      `message-${numberValue(message.index) ?? index}`;
    const timestamp = normalizeTimestamp(message.createTime);
    records.push(
      createRecord(
        "doubao",
        sessionId,
        eventId,
        "message",
        text,
        role,
        timestamp,
      ),
    );
    if (records.length >= maxRecords) break;
  }

  return {
    hasMoreInput: nextIndex < messages.length,
    records,
    state: {
      ...nextState,
      ...(nextIndex < messages.length ? { itemOffset: nextIndex } : {}),
    },
    warnings: [],
  };
}

function normalizeJsonlEvent(
  source: Exclude<PersonalHistorySource, "doubao">,
  sessionId: string,
  event: unknown,
  startOffset: number,
  index: number,
): PersonalHistoryRecord | undefined {
  if (!isRecord(event)) return undefined;
  const timestamp = normalizeTimestamp(event.timestamp ?? event.created_at);
  const fallbackEventId = `${startOffset}-${index}`;

  if (source === "pi") {
    const message = isRecord(event.message) ? event.message : undefined;
    const role = message ? stringValue(message.role) : undefined;
    if (role !== "user" && role !== "assistant") return undefined;
    const text = sanitizeImportedText(extractText(message?.content));
    if (!text) return undefined;
    return createRecord(
      source,
      sessionId,
      stringValue(event.id) ?? fallbackEventId,
      "message",
      text,
      role,
      timestamp,
    );
  }

  if (source === "codex") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const payloadType = payload ? stringValue(payload.type) : undefined;
    const role = payload ? stringValue(payload.role) : undefined;
    if (role === "developer" || role === "system") return undefined;

    const eventType = stringValue(event.type);
    const effectiveRole =
      role ??
      (payloadType === "user_message"
        ? "user"
        : payloadType === "agent_message"
          ? "assistant"
          : undefined);
    if (effectiveRole !== "user" && effectiveRole !== "assistant") {
      return undefined;
    }
    const text = sanitizeImportedText(
      extractText(payload?.content ?? payload?.message ?? payload?.text),
    );
    if (!text) return undefined;
    return createRecord(
      source,
      sessionId,
      stringValue(payload?.id) ?? stringValue(event.id) ?? fallbackEventId,
      eventType ?? payloadType ?? "message",
      text,
      effectiveRole,
      timestamp,
    );
  }

  const sourceType = stringValue(event.source);
  const effectiveRole =
    sourceType === "USER_EXPLICIT"
      ? "user"
      : sourceType === "MODEL"
        ? "assistant"
        : undefined;
  if (!effectiveRole) return undefined;
  const raw = extractText(event.content);
  const text = sanitizeImportedText(stripAntigravityEnvelope(raw));
  if (!text) return undefined;
  return createRecord(
    source,
    sessionId,
    `${numberValue(event.step_index) ?? fallbackEventId}`,
    stringValue(event.type) ?? "message",
    text,
    effectiveRole,
    normalizeTimestamp(event.created_at) ?? timestamp,
  );
}

function createRecord(
  source: PersonalHistorySource,
  sessionId: string,
  eventId: string,
  kind: string,
  text: string,
  role?: string,
  timestamp?: string,
): PersonalHistoryRecord {
  return {
    id: sha256(`${source}\0${sessionId}\0${eventId}`).slice(0, 24),
    kind,
    ...(role ? { role } : {}),
    sessionId: `${source}-${sha256(sessionId).slice(0, 16)}`,
    source,
    text,
    ...(timestamp ? { timestamp } : {}),
  };
}

async function sessionBelongsToRepository(
  events: unknown[],
  repoRoot: string,
): Promise<boolean> {
  const candidates = collectWorkspacePaths(events).slice(0, 24);
  const repoCommonDir = await gitCommonDir(repoRoot);

  for (const candidate of candidates) {
    const resolved = await canonicalizeCandidate(candidate);
    if (!resolved) continue;
    if (isPathInside(resolved, repoRoot)) return true;
    if (repoCommonDir) {
      const candidateCommonDir = await gitCommonDir(resolved);
      if (candidateCommonDir === repoCommonDir) return true;
    }
  }

  return false;
}

function collectWorkspacePaths(events: unknown[]): string[] {
  const found = new Set<string>();

  const visit = (value: unknown, key = ""): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (isRecord(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childValue, childKey);
      }
      return;
    }
    if (
      typeof value === "string" &&
      /^(?:cwd|workspace_roots?|directorypath)$/iu.test(key)
    ) {
      const unquoted = value.replace(/^['"]|['"]$/gu, "");
      if (path.isAbsolute(unquoted)) found.add(unquoted);
    }
  };

  for (const event of events) visit(event);
  return [...found];
}

async function gitCommonDir(candidate: string): Promise<string | undefined> {
  try {
    const candidateStat = await stat(candidate);
    const cwd = candidateStat.isDirectory()
      ? candidate
      : path.dirname(candidate);
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd },
    );
    return await canonicalizeExistingPath(stdout.trim());
  } catch {
    return undefined;
  }
}

function sourceDefinitions(
  overrides: CollectPersonalHistoryOptions["roots"],
): SourceDefinition[] {
  const home = os.homedir();
  return [
    {
      connectorId: "pi-history",
      format: "jsonl",
      root: overrides?.pi ?? path.join(home, ".pi", "agent", "sessions"),
      source: "pi",
    },
    {
      connectorId: "codex-history",
      format: "jsonl",
      root: overrides?.codex ?? path.join(home, ".codex", "sessions"),
      source: "codex",
    },
    {
      connectorId: "antigravity-history",
      format: "jsonl",
      root:
        overrides?.antigravity ??
        path.join(home, ".gemini", "antigravity-cli", "brain"),
      source: "antigravity",
    },
    {
      connectorId: "doubao-export",
      format: "doubao",
      root: overrides?.doubao ?? path.join(home, "Documents", "doubao-export"),
      source: "doubao",
    },
  ];
}

async function resolveStorage(connectorId: string, stateRoot?: string) {
  if (stateRoot) {
    const connectorDir = path.join(stateRoot, connectorId);
    const rawDir = path.join(connectorDir, "raw");
    await mkdir(rawDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return { connectorDir, rawDir };
  }

  await ensureConnectorHome(connectorId);
  return {
    connectorDir: getConnectorDir(connectorId),
    rawDir: getConnectorRawDir(connectorId),
  };
}

async function listSourceFiles(
  root: string,
  definition: Pick<SourceDefinition, "format" | "source">,
): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    if (
      definition.source === "antigravity" &&
      entry.isDirectory() &&
      entry.name === ".system_generated"
    ) {
      continue;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listSourceFiles(entryPath, definition)));
    } else if (
      entry.isFile() &&
      (definition.format === "jsonl" ? /\.jsonl$/iu : /\.(?:json|md)$/iu).test(
        entry.name,
      )
    ) {
      result.push(entryPath);
    }
  }
  return result;
}

async function validPreviousOffset(
  filePath: string,
  fileSize: number,
  previous: FileState | undefined,
): Promise<number> {
  if (!previous || previous.byteOffset > fileSize) return 0;
  if (!previous.headHash) {
    // Version-1 states used a full-prefix digest. Trust the durable offset once
    // during migration; all subsequently written states carry a bounded head
    // digest so multi-gigabyte files never need to be loaded in full.
    return previous.byteOffset;
  }
  return (await hashFileHead(filePath, fileSize, previous.headBytes)) ===
    previous.headHash
    ? previous.byteOffset
    : 0;
}

async function hashFileHead(
  filePath: string,
  fileSize: number,
  sampleBytes = Math.min(fileSize, PREFIX_SAMPLE_BYTES),
): Promise<string> {
  const fileHandle = await open(filePath, "r");
  try {
    const length = Math.min(fileSize, sampleBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, 0);
    return sha256Bytes(buffer.subarray(0, bytesRead));
  } finally {
    await fileHandle.close();
  }
}

function findSessionId(events: unknown[]): string | undefined {
  for (const event of events) {
    if (!isRecord(event)) continue;
    const direct = stringValue(event.id);
    if (stringValue(event.type) === "session" && direct) return direct;
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const payloadId = payload
      ? (stringValue(payload.session_id) ?? stringValue(payload.id))
      : undefined;
    if (stringValue(event.type) === "session_meta" && payloadId) {
      return payloadId;
    }
  }
  return undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) return "";
  for (const key of ["text", "input_text", "output_text", "message"]) {
    if (typeof value[key] === "string") return value[key];
  }
  if (value.content !== undefined) return extractText(value.content);
  return "";
}

function stripAntigravityEnvelope(value: string): string {
  const request = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u.exec(value);
  return request?.[1]?.trim() || value;
}

export function sanitizeImportedText(value: string): string {
  let sanitized = sanitizeDiagnosticText(value)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
      "[REDACTED:PRIVATE_KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, "Bearer [REDACTED]")
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*([^\s,;]+)/giu,
      "$1=[REDACTED]",
    )
    .replace(/[A-Za-z0-9+/]{512,}={0,2}/gu, "[REDACTED:LONG_BASE64]")
    .replaceAll(os.homedir(), "~")
    .trim();

  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.length > MAX_RECORD_TEXT_BYTES) {
    const half = Math.floor(MAX_RECORD_TEXT_BYTES / 2);
    sanitized = `${bytes.subarray(0, half).toString("utf8")}\n\n[...内容已截断...]\n\n${bytes.subarray(-half).toString("utf8")}`;
  }

  return sanitized;
}

async function readState(filePath: string): Promise<HistoryState> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (isRecord(value) && value.version === 1 && isRecord(value.files)) {
      return value as unknown as HistoryState;
    }
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )) {
      throw error;
    }
  }
  return { files: {}, version: 1 };
}

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), {
    recursive: true,
    mode: PRIVATE_DIR_MODE,
  });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(filePath, PRIVATE_FILE_MODE);
}

async function writePrivateJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writePrivateJson(temporary, value);
  await rename(temporary, filePath);
  await chmod(filePath, PRIVATE_FILE_MODE);
}

async function canonicalizeCandidate(
  value: string,
): Promise<string | undefined> {
  try {
    return await canonicalizeExistingPath(value);
  } catch {
    return undefined;
  }
}

async function canonicalizeExistingPath(value: string): Promise<string> {
  return await import("node:fs/promises").then(({ realpath }) =>
    realpath(value),
  );
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isDirectory();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return new Date(milliseconds).toISOString();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

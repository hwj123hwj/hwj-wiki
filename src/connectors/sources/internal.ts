import { lstat, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OPENWIKI_INTERNAL_SOURCE_ROOT_ENV_KEY } from "../../config/constants.js";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

export const DEFAULT_INTERNAL_SOURCE_IDS = [
  "google",
  "slack",
  "notion",
] as const;

const DEFAULT_MAX_ITEMS = 200;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 512 * 1024;
const CURSOR_PREFIX = "internal:";

export type InternalSourceEnvelope = {
  author?: string;
  id: string;
  kind: string;
  metadata?: Record<string, unknown>;
  source: string;
  text: string;
  timestamp: string;
  title?: string;
  updatedAt?: string;
  url?: string;
};

type InternalSourceSpec = {
  enabled?: boolean;
  id: string;
  path?: string;
};

type InternalSourceConfig = {
  enabled?: boolean;
  maxFileBytes?: number;
  maxItems?: number;
  maxLineBytes?: number;
  rootDir?: string;
  sources?: unknown;
};

type InternalCursor = {
  id: string;
  timestamp: string;
};

type SourceReadResult = {
  error?: string;
  filePath: string;
  hasInvalidRecords?: boolean;
  items: InternalSourceEnvelope[];
  missing: boolean;
  nextCursor?: string;
  sourceId: string;
  warnings: string[];
};

const definition: ConnectorDefinition = {
  backend: "internal-file",
  description:
    "Reads sanitized Gmail, Slack, Notion, and other internal-system events from a local JSONL feed with durable cursors; no third-party OAuth is required.",
  displayName: "Internal system sources",
  id: "internal",
  mode: "personal",
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

export function createInternalConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<InternalSourceConfig>("internal", {
      enabled: true,
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      maxItems: DEFAULT_MAX_ITEMS,
      maxLineBytes: DEFAULT_MAX_LINE_BYTES,
      rootDir: defaultRootDir(),
      sources: [...DEFAULT_INTERNAL_SOURCE_IDS],
    })),
    ...((options.connectorConfig ?? {}) as InternalSourceConfig),
  };
  const state = await readConnectorState("internal");
  const rawFiles: string[] = [];
  const warnings: string[] = [];

  if (!config.enabled) {
    return finishRun({
      message:
        "Internal system source ingestion is disabled. Set enabled=true in ~/.openwiki/connectors/internal/config.json.",
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  if (options.retryPending && state.pendingRawFiles?.length) {
    const pendingRawFiles = [...state.pendingRawFiles];
    const nextState = updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles: pendingRawFiles,
      runId,
      status: "success",
      warnings,
    });
    await writeConnectorState("internal", nextState);
    return {
      connectorId: "internal",
      message:
        "Retrying " +
        pendingRawFiles.length +
        " pending durable internal-source raw file(s) from an incomplete synthesis run.",
      rawFiles: pendingRawFiles,
      runId,
      statePath: "~/.openwiki/connectors/internal/state.json",
      status: "success",
      warnings,
    };
  }

  const rootDir = resolveRootDir(config.rootDir);
  await ensureRootDir(rootDir);
  const specs = selectSourceSpecs(config.sources, options.streams, warnings);
  const maxItems = normalizeLimit(options.limit ?? config.maxItems);
  const maxFileBytes = normalizeByteLimit(
    config.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
  );
  const maxLineBytes = normalizeByteLimit(
    config.maxLineBytes,
    DEFAULT_MAX_LINE_BYTES,
  );
  const nextLatestIds = { ...(state.latestIds ?? {}) };
  let missingSources = 0;
  let failedSources = 0;

  for (const spec of specs) {
    const result = await readSourceFile({
      cursor: decodeCursor(state.latestIds?.[cursorKey(spec.id)]),
      maxFileBytes,
      maxItems,
      maxLineBytes,
      rootDir,
      spec,
    });

    if (result.missing) {
      missingSources += 1;
      continue;
    }

    if (result.error) {
      failedSources += 1;
      warnings.push(`${spec.id}: ${result.error}`);
      continue;
    }

    warnings.push(
      ...result.warnings.map((warning) => `${spec.id}: ${warning}`),
    );

    if (result.items.length === 0) {
      if (result.hasInvalidRecords) failedSources += 1;
      continue;
    }

    const previousCursor = state.latestIds?.[cursorKey(spec.id)];
    rawFiles.push(
      await writeRawJson("internal", runId, `${spec.id}-items.json`, {
        fetchedAt: new Date().toISOString(),
        inputPath: result.filePath,
        items: result.items,
        nextCursor: result.nextCursor,
        previousCursor,
        source: spec.id,
      }),
    );
    // Do not advance past malformed records. The valid subset is still
    // durable and can be synthesized, but keeping the cursor unchanged makes
    // the producer's repair visible on the next run instead of silently
    // skipping an event whose timestamp could not be validated.
    if (result.nextCursor && !result.hasInvalidRecords) {
      nextLatestIds[cursorKey(spec.id)] = result.nextCursor;
    }
  }

  const status: ConnectorIngestResult["status"] =
    rawFiles.length > 0 ? "success" : failedSources > 0 ? "error" : "skipped";
  const nextState = updateStateWithRun(
    {
      ...state,
      latestIds:
        Object.keys(nextLatestIds).length > 0 ? nextLatestIds : state.latestIds,
      pendingRawFiles:
        rawFiles.length > 0
          ? [...new Set([...(state.pendingRawFiles ?? []), ...rawFiles])]
          : state.pendingRawFiles,
    },
    {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    },
  );
  await writeConnectorState("internal", nextState);

  const configuredSourceCount = specs.length;
  const message =
    rawFiles.length > 0
      ? `Fetched new internal events for ${rawFiles.length} source(s) from ${rootDir}.`
      : failedSources > 0
        ? `Internal source ingestion failed for ${failedSources} source(s).`
        : configuredSourceCount === 0
          ? "No valid internal source streams were configured."
          : missingSources === configuredSourceCount
            ? `No internal source feeds found under ${rootDir}.`
            : "No new internal source events were found after the stored cursors.";

  return {
    connectorId: "internal",
    message,
    rawFiles,
    runId,
    statePath: "~/.openwiki/connectors/internal/state.json",
    status,
    warnings,
  };
}

async function readSourceFile({
  cursor,
  maxFileBytes,
  maxItems,
  maxLineBytes,
  rootDir,
  spec,
}: {
  cursor: InternalCursor | null;
  maxFileBytes: number;
  maxItems: number;
  maxLineBytes: number;
  rootDir: string;
  spec: InternalSourceSpec;
}): Promise<SourceReadResult> {
  let filePath: string;
  try {
    filePath = resolveSourcePath(rootDir, spec);
  } catch (error) {
    return {
      error: getErrorMessage(error),
      filePath: path.join(rootDir, `${spec.id}.jsonl`),
      items: [],
      missing: false,
      sourceId: spec.id,
      warnings: [],
    };
  }
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {
        filePath,
        items: [],
        missing: true,
        sourceId: spec.id,
        warnings: [],
      };
    }
    return {
      error: getErrorMessage(error),
      filePath,
      items: [],
      missing: false,
      sourceId: spec.id,
      warnings: [],
    };
  }

  if (fileStat.isSymbolicLink()) {
    return {
      error: "source feed must not be a symbolic link",
      filePath,
      items: [],
      missing: false,
      sourceId: spec.id,
      warnings: [],
    };
  }
  if (!fileStat.isFile()) {
    return {
      error: "source feed path is not a regular file",
      filePath,
      items: [],
      missing: false,
      sourceId: spec.id,
      warnings: [],
    };
  }
  if (fileStat.size > maxFileBytes) {
    return {
      error: `source feed is ${fileStat.size} bytes; maximum is ${maxFileBytes} bytes`,
      filePath,
      items: [],
      missing: false,
      sourceId: spec.id,
      warnings: [],
    };
  }

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    return {
      error: getErrorMessage(error),
      filePath,
      items: [],
      missing: false,
      sourceId: spec.id,
      warnings: [],
    };
  }

  const latestById = new Map<string, InternalSourceEnvelope>();
  const parseWarnings: string[] = [];
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (Buffer.byteLength(trimmed, "utf8") > maxLineBytes) {
      parseWarnings.push(`line ${index + 1} exceeds ${maxLineBytes} bytes`);
      continue;
    }

    try {
      const value = JSON.parse(trimmed) as unknown;
      const envelope = normalizeEnvelope(value, spec.id);
      const previous = latestById.get(envelope.id);
      if (!previous || compareEnvelope(previous, envelope) < 0) {
        latestById.set(envelope.id, envelope);
      }
    } catch (error) {
      parseWarnings.push(`line ${index + 1}: ${getErrorMessage(error)}`);
    }
  }

  const items = [...latestById.values()]
    .filter(
      (item) => cursor === null || compareEnvelopeToCursor(item, cursor) > 0,
    )
    .sort(compareEnvelope)
    .slice(0, maxItems);
  const nextCursor = items.at(-1)
    ? encodeCursor(items.at(-1) as InternalSourceEnvelope)
    : undefined;

  return {
    filePath,
    hasInvalidRecords: parseWarnings.length > 0,
    items,
    missing: false,
    nextCursor,
    sourceId: spec.id,
    warnings: parseWarnings,
  };
}

function normalizeEnvelope(
  value: unknown,
  expectedSource: string,
): InternalSourceEnvelope {
  if (!isRecord(value)) {
    throw new Error("event must be a JSON object");
  }
  if (value.source !== expectedSource) {
    throw new Error(`source must be ${expectedSource}`);
  }

  const id = requiredText(value.id, "id", 512);
  const kind = requiredText(value.kind, "kind", 80);
  const text = requiredText(value.text, "text", 200_000);
  const timestamp = normalizeTimestamp(value.timestamp, "timestamp");
  const updatedAt =
    value.updatedAt === undefined
      ? undefined
      : normalizeTimestamp(value.updatedAt, "updatedAt");
  const metadata = value.metadata;
  if (metadata !== undefined) {
    assertSafeMetadata(metadata);
  }

  return {
    author: optionalText(value.author, "author", 512),
    id,
    kind,
    metadata: isRecord(metadata) ? metadata : undefined,
    source: expectedSource,
    text,
    timestamp,
    title: optionalText(value.title, "title", 20_000),
    updatedAt,
    url: optionalText(value.url, "url", 4_096),
  };
}

function selectSourceSpecs(
  value: unknown,
  requestedStreams: string[] | undefined,
  warnings: string[],
): InternalSourceSpec[] {
  const configured = Array.isArray(value)
    ? value
    : [...DEFAULT_INTERNAL_SOURCE_IDS];
  const specs: InternalSourceSpec[] = [];
  const seen = new Set<string>();

  for (const entry of configured) {
    const spec =
      typeof entry === "string"
        ? { id: entry.trim() }
        : isRecord(entry) && typeof entry.id === "string"
          ? {
              enabled: entry.enabled !== false,
              id: entry.id.trim(),
              path: typeof entry.path === "string" ? entry.path : undefined,
            }
          : null;
    if (!spec || !isSafeSourceId(spec.id)) {
      warnings.push("Ignored an internal source with an unsafe or missing id.");
      continue;
    }
    if (spec.enabled === false || seen.has(spec.id)) continue;
    seen.add(spec.id);
    specs.push(spec);
  }

  if (!requestedStreams || requestedStreams.length === 0) {
    return specs;
  }

  const requested = new Set(requestedStreams);
  for (const stream of requested) {
    if (!seen.has(stream)) {
      warnings.push(`Ignored unconfigured internal source stream: ${stream}`);
    }
  }
  return specs.filter((spec) => requested.has(spec.id));
}

function resolveRootDir(value: unknown): string {
  const configured =
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : defaultRootDir();
  const expanded =
    configured === "~"
      ? os.homedir()
      : configured.startsWith("~/") || configured.startsWith("~\\")
        ? path.join(os.homedir(), configured.slice(2))
        : configured;
  return path.resolve(expanded);
}

async function ensureRootDir(rootDir: string): Promise<void> {
  try {
    const existing = await lstat(rootDir);
    if (existing.isSymbolicLink()) {
      throw new Error("internal source root must not be a symbolic link");
    }
    if (!existing.isDirectory()) {
      throw new Error("internal source root is not a directory");
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
  }
}

function resolveSourcePath(rootDir: string, spec: InternalSourceSpec): string {
  const configuredPath = spec.path?.trim() || `${spec.id}.jsonl`;
  const resolved = path.resolve(rootDir, configuredPath);
  if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error("internal source feed path must stay inside rootDir");
  }
  return resolved;
}

function defaultRootDir(): string {
  return (
    process.env[OPENWIKI_INTERNAL_SOURCE_ROOT_ENV_KEY] ??
    path.join(os.homedir(), ".openwiki", "internal-sources")
  );
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_ITEMS;
  }
  return Math.max(1, Math.min(10_000, Math.floor(value)));
}

function normalizeByteLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1_024, Math.min(64 * 1024 * 1024, Math.floor(value)));
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new Error(`${name} exceeds ${maxLength} characters`);
  }
  return text;
}

function optionalText(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, name, maxLength);
}

function normalizeTimestamp(value: unknown, name: string): string {
  const text = requiredText(value, name, 128);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be an ISO-compatible timestamp`);
  }
  return parsed.toISOString();
}

function assertSafeMetadata(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error("metadata nesting is too deep");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertSafeMetadata(item, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new Error("metadata must be JSON data");

  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      throw new Error(`metadata contains a sensitive field: ${key}`);
    }
    assertSafeMetadata(child, depth + 1);
  }
}

function isSensitiveKey(value: string): boolean {
  return /(?:access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization|cookie|password|api[-_]?key|^token$|^secret$)/iu.test(
    value,
  );
}

function isSafeSourceId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/u.test(value.trim());
}

function cursorKey(sourceId: string): string {
  return CURSOR_PREFIX + sourceId;
}

function encodeCursor(item: InternalSourceEnvelope): string {
  return JSON.stringify({
    id: item.id,
    timestamp: effectiveTimestamp(item),
  } satisfies InternalCursor);
}

function decodeCursor(value: string | undefined): InternalCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.id !== "string" ||
      typeof parsed.timestamp !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      timestamp: parsed.timestamp,
    };
  } catch {
    return null;
  }
}

function effectiveTimestamp(item: InternalSourceEnvelope): string {
  return item.updatedAt ?? item.timestamp;
}

function compareEnvelope(
  left: InternalSourceEnvelope,
  right: InternalSourceEnvelope,
): number {
  const timestampComparison = effectiveTimestamp(left).localeCompare(
    effectiveTimestamp(right),
  );
  return timestampComparison !== 0
    ? timestampComparison
    : left.id < right.id
      ? -1
      : left.id > right.id
        ? 1
        : 0;
}

function compareEnvelopeToCursor(
  item: InternalSourceEnvelope,
  cursor: InternalCursor,
): number {
  const timestampComparison = effectiveTimestamp(item).localeCompare(
    cursor.timestamp,
  );
  return timestampComparison !== 0
    ? timestampComparison
    : item.id < cursor.id
      ? -1
      : item.id > cursor.id
        ? 1
        : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function finishRun({
  message,
  rawFiles,
  runId,
  state,
  status,
  warnings,
}: {
  message: string;
  rawFiles: string[];
  runId: string;
  state: Awaited<ReturnType<typeof readConnectorState>>;
  status: ConnectorIngestResult["status"];
  warnings: string[];
}): Promise<ConnectorIngestResult> {
  await writeConnectorState(
    "internal",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "internal",
    message,
    rawFiles,
    runId,
    statePath: "~/.openwiki/connectors/internal/state.json",
    status,
    warnings,
  };
}

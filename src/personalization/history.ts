import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
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
} from "../openwiki-home.js";

const execFileAsync = promisify(execFile);
const MAX_RECORD_TEXT_BYTES = 50_000;
const MAX_RAW_BATCH_BYTES = 80_000;
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

interface FileState {
  byteOffset: number;
  prefixHash: string;
  size: number;
}

interface HistoryState {
  files: Record<string, FileState>;
  version: 1;
}

interface SourceDefinition {
  connectorId: string;
  format: "doubao" | "jsonl";
  root: string;
  source: PersonalHistorySource;
}

export interface CollectPersonalHistoryOptions {
  /** Test/advanced override for source roots. */
  roots?: Partial<Record<PersonalHistorySource, string>>;
  /** Test override; production uses ~/.openwiki/connectors. */
  stateRoot?: string;
}

export interface PersonalHistoryCollection {
  rawFiles: string[];
  recordCount: number;
  sources: PersonalHistorySource[];
  warnings: string[];
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
  const rawFiles: string[] = [];
  const sources: PersonalHistorySource[] = [];
  const warnings: string[] = [];
  let recordCount = 0;

  const canonicalRepoRoot =
    mode === "code" ? await canonicalizeExistingPath(repoRoot) : repoRoot;
  const scopeKey =
    mode === "personal"
      ? "personal"
      : `code-${sha256(canonicalRepoRoot).slice(0, 16)}`;

  for (const definition of definitions) {
    const result = await collectSource(
      definition,
      mode,
      canonicalRepoRoot,
      scopeKey,
      options.stateRoot,
    );
    warnings.push(...result.warnings);
    rawFiles.push(...result.rawFiles);
    if (result.records.length > 0) sources.push(definition.source);
    recordCount += result.records.length;
  }

  return { rawFiles, recordCount, sources, warnings };
}

async function collectSource(
  definition: SourceDefinition,
  mode: PersonalWorkflowMode,
  repoRoot: string,
  scopeKey: string,
  stateRoot?: string,
): Promise<{
  rawFiles: string[];
  records: PersonalHistoryRecord[];
  warnings: string[];
}> {
  if (!(await isDirectory(definition.root))) {
    return { rawFiles: [], records: [], warnings: [] };
  }

  const storage = await resolveStorage(definition.connectorId, stateRoot);
  const statePath = path.join(storage.connectorDir, `state-${scopeKey}.json`);
  const state = await readState(statePath);
  const nextState: HistoryState = { files: { ...state.files }, version: 1 };
  const files = await listSourceFiles(definition.root, definition.format);
  const records: PersonalHistoryRecord[] = [];
  const warnings: string[] = [];

  for (const filePath of files) {
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
            )
          : await collectDoubaoFile(
              filePath,
              relativePath,
              state.files[relativePath],
            );
      records.push(...result.records);
      nextState.files[relativePath] = result.state;
      warnings.push(...result.warnings);
    } catch (error) {
      warnings.push(
        `${definition.source}:${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const rawFiles: string[] = [];
  if (records.length > 0) {
    const runId = new Date().toISOString().replace(/[:.]/gu, "-");
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
        source: definition.source,
        warningCount: warnings.length,
      });
      rawFiles.push(rawFile);
    }
  }

  // Advance cursors only after the sanitized raw batch is durable.
  await writePrivateJsonAtomic(statePath, nextState);
  return { rawFiles, records, warnings };
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

async function collectJsonlFile(
  source: Exclude<PersonalHistorySource, "doubao">,
  filePath: string,
  relativePath: string,
  previous: FileState | undefined,
  mode: PersonalWorkflowMode,
  repoRoot: string,
): Promise<{
  records: PersonalHistoryRecord[];
  state: FileState;
  warnings: string[];
}> {
  const bytes = await readFile(filePath);
  const completeLength = lastCompleteLineOffset(bytes);
  const previousOffset = validPreviousOffset(bytes, previous);
  const startOffset = previousOffset ?? 0;
  const allText = bytes.subarray(0, completeLength).toString("utf8");
  const allLines = allText ? allText.split("\n").filter(Boolean) : [];
  const parsedAll: unknown[] = [];
  const warnings: string[] = [];

  for (const [index, line] of allLines.entries()) {
    try {
      parsedAll.push(JSON.parse(line) as unknown);
    } catch {
      warnings.push(`${relativePath}:${index + 1}: invalid JSONL line skipped`);
    }
  }

  const belongs =
    mode === "personal" ||
    (await sessionBelongsToRepository(parsedAll, repoRoot));
  const sessionId =
    findSessionId(parsedAll) ?? sha256(relativePath).slice(0, 16);
  const suffix = bytes.subarray(startOffset, completeLength).toString("utf8");
  const records: PersonalHistoryRecord[] = [];

  if (belongs && suffix) {
    for (const [index, line] of suffix.split("\n").filter(Boolean).entries()) {
      try {
        const event = JSON.parse(line) as unknown;
        const record = normalizeJsonlEvent(
          source,
          sessionId,
          event,
          startOffset,
          index,
        );
        if (record) records.push(record);
      } catch {
        // The full-file pass already emits a stable line warning.
      }
    }
  }

  return {
    records,
    state: {
      byteOffset: completeLength,
      prefixHash: sha256Bytes(bytes.subarray(0, completeLength)),
      size: bytes.length,
    },
    warnings,
  };
}

async function collectDoubaoFile(
  filePath: string,
  relativePath: string,
  previous: FileState | undefined,
): Promise<{
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
    previous.prefixHash === digest
  ) {
    return { records: [], state: nextState, warnings: [] };
  }

  const sessionId = `doubao-${sha256(relativePath).slice(0, 16)}`;
  if (/\.md$/iu.test(filePath)) {
    const text = sanitizeImportedText(bytes.toString("utf8"));
    return {
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
      records: [],
      state: nextState,
      warnings: [`${relativePath}: invalid JSON skipped`],
    };
  }

  const messages =
    isRecord(parsed) && Array.isArray(parsed.messages) ? parsed.messages : [];
  const records: PersonalHistoryRecord[] = [];
  for (const [index, message] of messages.entries()) {
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
  }

  return { records, state: nextState, warnings: [] };
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
  format: SourceDefinition["format"],
): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listSourceFiles(entryPath, format)));
    } else if (
      entry.isFile() &&
      (format === "jsonl" ? /\.jsonl$/iu : /\.(?:json|md)$/iu).test(entry.name)
    ) {
      result.push(entryPath);
    }
  }
  return result;
}

function validPreviousOffset(
  bytes: Buffer,
  previous: FileState | undefined,
): number | undefined {
  if (!previous || previous.byteOffset > bytes.length) return undefined;
  const prefix = bytes.subarray(0, previous.byteOffset);
  return sha256Bytes(prefix) === previous.prefixHash
    ? previous.byteOffset
    : undefined;
}

function lastCompleteLineOffset(bytes: Buffer): number {
  const lastNewline = bytes.lastIndexOf(0x0a);
  return lastNewline === -1 ? 0 : lastNewline + 1;
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

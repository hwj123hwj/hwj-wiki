import {
  OPENWIKI_GATEWAY_ADMIN_TOKEN_ENV_KEY,
  OPENWIKI_GATEWAY_URL_ENV_KEY,
} from "../../constants.js";
import { fetchWithResilience } from "../http.js";
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

type GatewayConfig = {
  adminTokenEnv?: string;
  baseUrl?: string;
  enabled?: boolean;
  excludeSources?: string[];
  limit?: number;
};

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:4001";
const DEFAULT_LIMIT = 100;
const CURSOR_KEY = "gateway-export-cursor";

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Pulls sanitized conversation archives from the LLM Gateway through its admin JSONL export with a durable cursor.",
  displayName: "LLM Gateway",
  id: "gateway",
  mode: "personal",
  requiredEnv: [OPENWIKI_GATEWAY_ADMIN_TOKEN_ENV_KEY],
  supportsAgenticDiscovery: false,
};

export function createGatewayConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<GatewayConfig>("gateway", {
      adminTokenEnv: OPENWIKI_GATEWAY_ADMIN_TOKEN_ENV_KEY,
      baseUrl: process.env[OPENWIKI_GATEWAY_URL_ENV_KEY] ?? DEFAULT_GATEWAY_URL,
      enabled: true,
      excludeSources: ["hwj-wiki-agent"],
      limit: DEFAULT_LIMIT,
    })),
    ...((options.connectorConfig ?? {}) as GatewayConfig),
  };
  const state = await readConnectorState("gateway");
  const rawFiles: string[] = [];
  const warnings: string[] = [];

  if (!config.enabled) {
    return finishRun({
      message:
        "LLM Gateway connector is disabled. Set enabled=true in ~/.openwiki/connectors/gateway/config.json.",
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  const tokenEnv = normalizeTokenEnv(config.adminTokenEnv);
  const adminToken = process.env[tokenEnv];
  if (!adminToken) {
    return finishRun({
      message:
        tokenEnv +
        " is required for LLM Gateway ingestion. Set the environment variable without writing the token to connector config.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const limit = normalizeLimit(options.limit ?? config.limit);
  const since = state.latestIds?.[CURSOR_KEY] ?? "";
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const url = new URL("/admin/archives/export", baseUrl);
  url.searchParams.set("limit", String(limit));
  if (since) {
    url.searchParams.set("since", since);
  }

  let response: Response;
  let fetchedArchives: Record<string, unknown>[];
  try {
    response = await fetchWithResilience(url, {
      headers: {
        Accept: "application/x-ndjson",
        Authorization: "Bearer " + adminToken,
      },
    });
    if (!response.ok) {
      return finishRun({
        message:
          "LLM Gateway export failed: " +
          response.status +
          " " +
          response.statusText,
        rawFiles,
        runId,
        state,
        status: "error",
        warnings,
      });
    }
    fetchedArchives = parseJsonLines(await response.text());
  } catch (error) {
    return finishRun({
      message:
        "LLM Gateway export failed: " +
        (error instanceof Error ? error.message : String(error)),
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }
  const nextCursor = response.headers.get("X-Archive-Next-Cursor") ?? "";
  const schemaVersion = Number(
    response.headers.get("X-Archive-Schema-Version") ?? "0",
  );
  const excludedSources = normalizeExcludedSources(config.excludeSources);
  const archives = fetchedArchives.filter(
    (archive) =>
      !excludedSources.has(
        typeof archive.source === "string" ? archive.source.trim() : "",
      ),
  );
  const excludedCount = fetchedArchives.length - archives.length;

  if (archives.length > 0) {
    rawFiles.push(
      await writeRawJson("gateway", runId, "gateway-archives.json", {
        fetchedAt: new Date().toISOString(),
        instanceId: options.instanceId,
        limit,
        nextCursor: nextCursor || undefined,
        previousCursor: since || undefined,
        archives,
        excludedCount,
        fetchedCount: fetchedArchives.length,
        schemaVersion: Number.isFinite(schemaVersion)
          ? schemaVersion
          : undefined,
      }),
    );
  }

  const status = archives.length > 0 ? "success" : "skipped";
  const nextState = updateStateWithRun(
    {
      ...state,
      latestIds: nextCursor
        ? { ...(state.latestIds ?? {}), [CURSOR_KEY]: nextCursor }
        : state.latestIds,
    },
    {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    },
  );
  await writeConnectorState("gateway", nextState);

  return {
    connectorId: "gateway",
    message:
      "Fetched " +
      fetchedArchives.length +
      " Gateway archive(s), retained " +
      archives.length +
      (excludedCount > 0 ? " and excluded " + excludedCount + " agent feedback" : "") +
      (nextCursor
        ? " and advanced the export cursor."
        : " (cursor unchanged)."),
    rawFiles,
    runId,
    statePath: "~/.openwiki/connectors/gateway/state.json",
    status,
    warnings,
  };
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
  // Error/skipped runs intentionally do not advance the cursor. A later run
  // can retry the exact same export page without gaps.
  await writeConnectorState(
    "gateway",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "gateway",
    message,
    rawFiles,
    runId,
    statePath: "~/.openwiki/connectors/gateway/state.json",
    status,
    warnings,
  };
}

function normalizeBaseUrl(value: unknown): string {
  const configured =
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : (process.env[OPENWIKI_GATEWAY_URL_ENV_KEY] ?? DEFAULT_GATEWAY_URL);
  return configured.endsWith("/") ? configured : configured + "/";
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

function normalizeTokenEnv(value: unknown): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value)
    ? value
    : OPENWIKI_GATEWAY_ADMIN_TOKEN_ENV_KEY;
}

function normalizeExcludedSources(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set(["hwj-wiki-agent"]);
  return new Set(
    value
      .filter((source): source is string => typeof source === "string")
      .map((source) => source.trim())
      .filter(Boolean),
  );
}

function parseJsonLines(body: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const [index, line] of body
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
    .entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        "LLM Gateway export returned invalid JSONL at line " +
          (index + 1) +
          ": " +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        "LLM Gateway export line " + (index + 1) + " is not a JSON object.",
      );
    }
    records.push(parsed as Record<string, unknown>);
  }
  return records;
}

import type { CliCommand } from "../commands.js";
import {
  OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../constants.js";

export const PERSONAL_DEFAULT_LANGUAGE = "zh-CN";
export const PERSONAL_LITELLM_BASE_URL = "http://localhost:4001/v1";
export const PERSONAL_LITELLM_MODEL = "coding";
export const PERSONAL_LITELLM_API_KEY = "sk-local-gateway-hwj123hwj";
export const LITELLM_MASTER_KEY_ENV_KEY = "LITELLM_MASTER_KEY";

/**
 * Applies the personal workflow's zero-configuration defaults after
 * `~/.openwiki/.env` has been loaded. Explicit OpenWiki settings always win.
 *
 * Keeping this at the CLI boundary lets the upstream model/runtime code remain
 * unchanged: the existing OpenAI-compatible provider receives ordinary env
 * configuration and does not need a LiteLLM-specific model implementation.
 */
export function applyPersonalWorkflowEnvironmentDefaults(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!env[OPENWIKI_PROVIDER_ENV_KEY]?.trim()) {
    env[OPENWIKI_PROVIDER_ENV_KEY] = "openai-compatible";
  }

  if (env[OPENWIKI_PROVIDER_ENV_KEY] !== "openai-compatible") {
    return;
  }

  if (!env[OPENAI_COMPATIBLE_BASE_URL_ENV_KEY]?.trim()) {
    env[OPENAI_COMPATIBLE_BASE_URL_ENV_KEY] = PERSONAL_LITELLM_BASE_URL;
  }

  if (
    normalizeBaseUrl(env[OPENAI_COMPATIBLE_BASE_URL_ENV_KEY]) ===
      normalizeBaseUrl(PERSONAL_LITELLM_BASE_URL) &&
    !env[OPENWIKI_MODEL_ID_ENV_KEY]?.trim()
  ) {
    env[OPENWIKI_MODEL_ID_ENV_KEY] = PERSONAL_LITELLM_MODEL;
  }

  if (!env[OPENAI_COMPATIBLE_API_KEY_ENV_KEY]?.trim()) {
    env[OPENAI_COMPATIBLE_API_KEY_ENV_KEY] =
      env[LITELLM_MASTER_KEY_ENV_KEY]?.trim() || PERSONAL_LITELLM_API_KEY;
  }
}

/** Adds the Chinese default only to run commands that did not request a locale. */
export function applyPersonalWorkflowCommandDefaults(
  command: CliCommand,
): CliCommand {
  if (command.kind !== "run" || command.language !== null) {
    return command;
  }

  return {
    ...command,
    language: PERSONAL_DEFAULT_LANGUAGE,
  };
}

/**
 * Fails early with an actionable message when the default local gateway cannot
 * serve requests. Custom providers and custom OpenAI-compatible URLs are left
 * entirely to the upstream provider runtime.
 */
export async function verifyPersonalLiteLlmGateway(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (
    env[OPENWIKI_PROVIDER_ENV_KEY] !== "openai-compatible" ||
    normalizeBaseUrl(env[OPENAI_COMPATIBLE_BASE_URL_ENV_KEY]) !==
      normalizeBaseUrl(PERSONAL_LITELLM_BASE_URL)
  ) {
    return;
  }

  const baseUrl = `${normalizeBaseUrl(PERSONAL_LITELLM_BASE_URL)}/`;
  const modelsUrl = new URL("models", baseUrl);
  const key = env[OPENAI_COMPATIBLE_API_KEY_ENV_KEY]?.trim();

  let response: Response;
  try {
    response = await fetchImpl(modelsUrl, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `无法连接本地 LiteLLM 网关 ${modelsUrl.toString()}。请先启动监听 4001 端口的 litellm-gateway。${detail ? ` 原因：${detail}` : ""}`,
      { cause: error },
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `LiteLLM 网关鉴权失败（HTTP ${response.status}）。请设置 ${LITELLM_MASTER_KEY_ENV_KEY} 或 ${OPENAI_COMPATIBLE_API_KEY_ENV_KEY}。`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `LiteLLM 网关健康检查失败（HTTP ${response.status} ${response.statusText}）。`,
    );
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/u, "") ?? "";
}

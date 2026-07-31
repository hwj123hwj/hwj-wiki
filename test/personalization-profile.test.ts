import { describe, expect, test, vi } from "vitest";
import type { CliCommand } from "../src/commands.ts";
import {
  applyPersonalWorkflowCommandDefaults,
  applyPersonalWorkflowEnvironmentDefaults,
  PERSONAL_LITELLM_BASE_URL,
  verifyPersonalLiteLlmGateway,
} from "../src/personalization/profile.ts";

describe("personal workflow defaults", () => {
  test("uses the local gateway without overriding explicit settings", () => {
    const env: NodeJS.ProcessEnv = { LITELLM_MASTER_KEY: "gateway-secret" };
    applyPersonalWorkflowEnvironmentDefaults(env);

    expect(env.OPENWIKI_PROVIDER).toBe("openai-compatible");
    expect(env.OPENAI_COMPATIBLE_BASE_URL).toBe(PERSONAL_LITELLM_BASE_URL);
    expect(env.OPENWIKI_MODEL_ID).toBe("coding");
    expect(env.OPENAI_COMPATIBLE_API_KEY).toBe("gateway-secret");

    const explicit: NodeJS.ProcessEnv = {
      OPENWIKI_PROVIDER: "anthropic",
      OPENWIKI_MODEL_ID: "claude-sonnet-5",
    };
    applyPersonalWorkflowEnvironmentDefaults(explicit);
    expect(explicit).toEqual({
      OPENWIKI_PROVIDER: "anthropic",
      OPENWIKI_MODEL_ID: "claude-sonnet-5",
    });
  });

  test("defaults run commands to zh-CN and preserves explicit language", () => {
    const command = {
      kind: "run",
      exitCode: 0,
      command: "update",
      dryRun: false,
      language: null,
      languageWarning: null,
      mode: "code",
      modeSource: "positional",
      modelId: null,
      print: true,
      shouldStart: true,
      telemetryFile: null,
      userMessage: null,
    } satisfies CliCommand;

    expect(applyPersonalWorkflowCommandDefaults(command)).toMatchObject({
      language: "zh-CN",
    });
    expect(
      applyPersonalWorkflowCommandDefaults({ ...command, language: "en" }),
    ).toMatchObject({ language: "en" });
  });

  test("distinguishes auth failures from connection failures", async () => {
    const env = {
      OPENWIKI_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_BASE_URL: PERSONAL_LITELLM_BASE_URL,
      OPENAI_COMPATIBLE_API_KEY: "bad",
    };
    const unauthorized = vi.fn(() =>
      Promise.resolve(new Response("", { status: 401 })),
    );
    await expect(
      verifyPersonalLiteLlmGateway(env, unauthorized),
    ).rejects.toThrow("鉴权失败");

    const unavailable = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(
      verifyPersonalLiteLlmGateway(env, unavailable),
    ).rejects.toThrow("无法连接本地 LiteLLM 网关");
  });
});

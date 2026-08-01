import { describe, expect, test } from "vitest";
import { resolveSlashCommandCompletion } from "../src/slash-completion.ts";

describe("slash command completion", () => {
  test("completes a highlighted partial command", () => {
    expect(resolveSlashCommandCompletion("/in", "/init")).toBe("/init");
    expect(resolveSlashCommandCompletion("/", "/update")).toBe("/update");
  });

  test("does not rewrite exact commands, arguments, or mismatches", () => {
    expect(resolveSlashCommandCompletion("/init", "/init")).toBeNull();
    expect(resolveSlashCommandCompletion("/model coding", "/model")).toBeNull();
    expect(resolveSlashCommandCompletion("/up", "/init")).toBeNull();
  });
});

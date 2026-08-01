import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { validatePersonalizedWikiOutput } from "../src/personalization/run.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createWikiRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hwj-wiki-run-"));
  temporaryRoots.push(root);
  return root;
}

describe("personalized run validation", () => {
  test("rejects the empty index produced by a tool-less false success", async () => {
    const root = await createWikiRoot();
    await writeFile(
      root + "/index.md",
      '---\nokf_version: "0.1"\n---\n\n# 文件\n',
    );

    await expect(
      validatePersonalizedWikiOutput(
        "init",
        root,
        "local-wiki",
        "before",
        "after",
        true,
        false,
      ),
    ).resolves.toMatchObject({ valid: false });
  });

  test("accepts a changed wiki only after all evidence batches were read", async () => {
    const root = await createWikiRoot();
    await mkdir(path.join(root, "lessons"), { recursive: true });
    await writeFile(
      path.join(root, "quickstart.md"),
      "# 个人知识库\n\n这里是个人知识库导航，包含长期经验、开发记录、豆包知识卡片和跨项目经验，方便后续持续检索与维护。\n",
    );
    await writeFile(
      path.join(root, "lessons", "tooling.md"),
      "# 工具经验\n\n所有导入证据必须经过专用读取工具并在成功后确认；失败批次保持待处理状态，下一轮可以安全恢复，不能提前推进处理回执。\n",
    );

    expect(
      await validatePersonalizedWikiOutput(
        "update",
        root,
        "local-wiki",
        "before",
        "after",
        true,
        true,
      ),
    ).toEqual({ reason: "", valid: true });
    await expect(
      validatePersonalizedWikiOutput(
        "update",
        root,
        "local-wiki",
        "before",
        "after",
        true,
        false,
      ),
    ).resolves.toMatchObject({ valid: false });
  });
});

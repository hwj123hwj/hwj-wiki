import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatterFields } from "../okf/frontmatter.js";

export interface IssuesIndexResult {
  changed: boolean;
  issueCount: number;
  outputPath?: string;
}

/**
 * Builds the project issue index without involving the model. The source
 * `issues/` tree remains user-owned; only `openwiki/issues/by-project.md` is
 * written, preserving the repository-mode docs boundary.
 */
export async function generateProjectIssuesIndex(
  repoRoot: string,
): Promise<IssuesIndexResult> {
  const issuesRoot = path.join(repoRoot, "issues");
  if (!(await isDirectory(issuesRoot))) {
    return { changed: false, issueCount: 0 };
  }

  const issuePaths = await listMarkdownFiles(issuesRoot);
  const repoName = path.basename(repoRoot);
  const entries = await Promise.all(
    issuePaths.map(async (filePath) => {
      const content = await readFile(filePath, "utf8");
      const fields = parseFrontmatterFields(content) ?? {};
      const relativeSourcePath = path.relative(repoRoot, filePath);

      return {
        category: stringField(fields.category) ?? "未分类",
        confidence: stringField(fields.confidence) ?? "未标注",
        project: stringField(fields.project) ?? repoName,
        sourcePath: relativeSourcePath.split(path.sep).join("/"),
        title:
          stringField(fields.title) ??
          firstHeading(content) ??
          path.basename(filePath, path.extname(filePath)),
        updatedAt:
          stringField(fields.updated_at) ??
          stringField(fields.timestamp) ??
          stringField(fields.created_at) ??
          "—",
      };
    }),
  );

  entries.sort((left, right) =>
    [left.project, left.category, left.title, left.sourcePath]
      .join("\0")
      .localeCompare(
        [right.project, right.category, right.title, right.sourcePath].join(
          "\0",
        ),
        "zh-CN",
      ),
  );

  const outputPath = path.join(repoRoot, "openwiki", "issues", "by-project.md");
  const content = renderIssuesIndex(entries);
  const previous = await readIfPresent(outputPath);

  if (previous === content) {
    return { changed: false, issueCount: entries.length, outputPath };
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");

  return { changed: true, issueCount: entries.length, outputPath };
}

function renderIssuesIndex(
  entries: Array<{
    category: string;
    confidence: string;
    project: string;
    sourcePath: string;
    title: string;
    updatedAt: string;
  }>,
): string {
  const lines = [
    "---",
    'type: "Reference"',
    'title: "项目踩坑经验索引"',
    'description: "由本地 issues 记录确定性生成的项目经验索引。"',
    "tags: [issues, lessons, projects]",
    'openwiki_generated: "issues-index"',
    "---",
    "",
    "# 项目踩坑经验索引",
    "",
    "此页由 OpenWiki Personal 根据仓库中的 `issues/**/*.md` 自动生成，请勿手工编辑。",
    "",
  ];

  if (entries.length === 0) {
    lines.push("当前没有可索引的踩坑记录。", "");
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "| 项目 | 分类 | 经验 | 可信度 | 更新时间 |",
    "| --- | --- | --- | --- | --- |",
  );

  for (const entry of entries) {
    const href = `../../${entry.sourcePath}`;
    lines.push(
      `| ${cell(entry.project)} | ${cell(entry.category)} | [${cell(entry.title)}](${encodeLink(href)}) | ${cell(entry.confidence)} | ${cell(entry.updatedAt)} |`,
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listMarkdownFiles(entryPath)));
    } else if (entry.isFile() && /\.md$/iu.test(entry.name)) {
      result.push(entryPath);
    }
  }

  return result;
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

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function firstHeading(content: string): string | undefined {
  return /^#\s+(.+)$/mu.exec(content)?.[1]?.trim();
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function encodeLink(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
    .replace(/^\.\.\/\.\.\//u, "../../");
}

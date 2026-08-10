import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { openWikiLocalWikiDir } from "./config/openwiki-home.js";

export type KnowledgeSearchResult = {
  matchedTerms: string[];
  path: string;
  score: number;
  snippet: string;
  source: string;
  title: string;
};

export type KnowledgeSearchOptions = {
  limit?: number;
  roots?: string[];
};

const DEFAULT_LIMIT = 10;
const MAX_FILE_BYTES = 1_000_000;
const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "raw",
  "compile-input",
  "_trash",
]);

/**
 * Search generated OpenWiki pages plus explicitly configured external Markdown
 * roots (for example agent-lessons). The index is deterministic and rebuilt
 * from files on each invocation, so the CLI never serves a stale search cache
 * or stores conversation text in another database.
 */
export async function searchKnowledge(
  query: string,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const terms = tokenize(normalizedQuery);
  const roots = uniquePaths([
    openWikiLocalWikiDir,
    ...(options.roots ?? []),
    ...getConfiguredRoots(),
  ]);
  const files = (
    await Promise.all(roots.map((root) => collectMarkdownFiles(root)))
  ).flat();
  const results: KnowledgeSearchResult[] = [];

  for (const filePath of uniquePaths(files)) {
    const content = await readSearchableFile(filePath);
    if (content === null) {
      continue;
    }
    const title = extractTitle(content, path.basename(filePath, ".md"));
    const score = scoreDocument(content, title, normalizedQuery, terms);
    if (score <= 0) {
      continue;
    }
    results.push({
      matchedTerms: terms.filter((term) =>
        content.toLocaleLowerCase().includes(term),
      ),
      path: filePath,
      score,
      snippet: createSnippet(content, normalizedQuery, terms),
      source: getSourceLabel(filePath, roots),
      title,
    });
  }

  return results
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.title.localeCompare(right.title, "zh-CN") ||
        left.path.localeCompare(right.path),
    )
    .slice(0, normalizeLimit(options.limit));
}

function getConfiguredRoots(): string[] {
  return [
    process.env.OPENWIKI_AGENT_LESSONS_ROOT,
    ...(process.env.OPENWIKI_KNOWLEDGE_ROOTS ?? "")
      .split(path.delimiter)
      .map((root) => root.trim())
      .filter(Boolean),
  ].filter((root): root is string => Boolean(root));
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  const entries = await safeReadDir(resolvedRoot);
  if (!entries) {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(resolvedRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(entryPath)));
    } else if (
      entry.isFile() &&
      entry.name.toLocaleLowerCase().endsWith(".md")
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

async function safeReadDir(
  directory: string,
): Promise<import("node:fs").Dirent[] | null> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function readSearchableFile(filePath: string): Promise<string | null> {
  try {
    const file = await readFile(filePath);
    if (file.byteLength > MAX_FILE_BYTES) {
      return null;
    }
    return file.toString("utf8");
  } catch {
    return null;
  }
}

function scoreDocument(
  content: string,
  title: string,
  query: string,
  terms: string[],
): number {
  const lowerContent = content.toLocaleLowerCase();
  const lowerTitle = title.toLocaleLowerCase();
  let score = 0;
  if (lowerContent.includes(query)) {
    score += 8;
  }
  if (lowerTitle.includes(query)) {
    score += 20;
  }
  const headings = content
    .split("\n")
    .filter((line) => /^#{1,6}\s/u.test(line))
    .map((line) => line.toLocaleLowerCase());
  for (const term of terms) {
    if (lowerTitle.includes(term)) {
      score += 10;
    }
    if (lowerContent.includes(term)) {
      score += 2;
    }
    if (headings.some((heading) => heading.includes(term))) {
      score += 5;
    }
  }
  return score;
}

function createSnippet(
  content: string,
  query: string,
  terms: string[],
): string {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith(String.fromCharCode(96).repeat(3)),
    );
  const match = lines.find((line) => {
    const lower = line.toLocaleLowerCase();
    return lower.includes(query) || terms.some((term) => lower.includes(term));
  });
  return sanitizeSnippet(match ?? lines[0] ?? "");
}

function sanitizeSnippet(value: string): string {
  return value
    .replace(
      /((?:authorization|cookie|x-api-key|api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[REDACTED]",
    )
    .replace(/\s+/gu, " ")
    .slice(0, 300);
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/mu);
  return match?.[1]?.trim() || fallback;
}

function tokenize(query: string): string[] {
  const terms = query
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  return terms.length > 0 ? [...new Set(terms)] : [query];
}

function getSourceLabel(filePath: string, roots: string[]): string {
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, filePath);
    if (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    ) {
      return path.basename(resolvedRoot) || resolvedRoot;
    }
  }
  return "openwiki";
}

function normalizeLimit(value: number | undefined): number {
  return Number.isInteger(value) && (value ?? 0) > 0
    ? Math.min(value ?? DEFAULT_LIMIT, 100)
    : DEFAULT_LIMIT;
}

function uniquePaths(paths: string[]): string[] {
  return [
    ...new Set(paths.filter(Boolean).map((value) => path.resolve(value))),
  ];
}

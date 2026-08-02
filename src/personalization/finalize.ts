import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { OpenWikiLocalShellBackend } from "../agent/docs-only-backend.js";
import { OpenWikiIgnore } from "../agent/openwiki-ignore.js";
import { validateWikiMermaid } from "../mermaid/wiki.js";
import { parseFrontmatterFields } from "../okf/frontmatter.js";
import { migrateWikiToOkf, synchronizeWikiIndexes } from "../okf/index-sync.js";
import {
  resolveConceptTypeLabel,
  resolveIndexLabels,
} from "../okf/index-labels.js";
import { getConnectorRawDir } from "../openwiki-home.js";
import {
  KNOWLEDGE_CANDIDATE_TYPES,
  KNOWLEDGE_CONFIDENCE_LEVELS,
  type KnowledgeCandidate,
} from "./candidates.js";

const NAV_START = "<!-- HWJ-WIKI:NAV:START -->";
const NAV_END = "<!-- HWJ-WIKI:NAV:END -->";
const TRACKING_START = "<!-- HWJ-WIKI:TRACKING:START -->";
const TRACKING_END = "<!-- HWJ-WIKI:TRACKING:END -->";
const RESERVED_FILES = new Set(["INSTRUCTIONS.md", "_plan.md"]);
const NON_CONCEPT_FILES = new Set(["index.md", ...RESERVED_FILES]);
const BATCH_MUTATION_EXEMPT_FILES = new Set([
  "quickstart.md",
  "themes.md",
  "commitments.md",
  "open-questions.md",
]);
const SOURCE_REF_PATTERN = /^([a-z][a-z0-9-]{0,63}):(.+)#([a-f0-9]{24})$/u;
const MARKDOWN_LINK_PATTERN = /!?\[[^\]]*\]\(([^)]+)\)/gu;
const PERSONAL_POSIX_PATH_PREFIX_PATTERN = /\/(?:Users|home)\/[^/\s]+/gu;
const PERSONAL_WINDOWS_PATH_PREFIX_PATTERN = /[A-Za-z]:\\Users\\[^\\\s]+/gu;
const VALID_KNOWLEDGE_TYPES = new Set<string>(KNOWLEDGE_CANDIDATE_TYPES);
const VALID_CONFIDENCE_LEVELS = new Set<string>(KNOWLEDGE_CONFIDENCE_LEVELS);
const REDACTED_PERSONAL_PATH = "本地路径已隐藏";

export interface PersonalQualityIssue {
  code: string;
  file?: string;
  message: string;
}

export interface PersonalFinalizeReport {
  filesScanned: number;
  issues: PersonalQualityIssue[];
  repairedLinks?: string[];
  valid: boolean;
}

export interface PersonalFinalizeOptions {
  allowFallbackGenerated?: boolean;
  baselineBodies?: Record<string, string>;
  candidates?: KnowledgeCandidate[];
  language: string;
  requireCandidateReview?: boolean;
  /** Test override matching connector state layout. */
  stateRoot?: string;
}

/** Captures concept-page bodies before an Agent batch for mutation auditing. */
export async function capturePersonalWikiBodySnapshot(
  wikiRoot: string,
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const relativePath of await listMarkdownFiles(wikiRoot)) {
    if (NON_CONCEPT_FILES.has(path.posix.basename(relativePath))) continue;
    const content = await readFile(
      path.join(wikiRoot, ...relativePath.split("/")),
      "utf8",
    );
    snapshot[relativePath] = bodyHash(content);
  }
  return snapshot;
}

/**
 * Shared deterministic finish line for both native Agent and fallback output.
 * It repairs reproducible navigation/index concerns, then performs blocking
 * validation for evidence, security, links, duplication and metadata.
 */
export async function finalizePersonalWiki(
  wikiRoot: string,
  options: PersonalFinalizeOptions,
): Promise<PersonalFinalizeReport> {
  await ensureQuickstart(wikiRoot);
  // An earlier Agent pass can leave a host path in an otherwise valid page.
  // Redact it before rebuilding indexes and running the shared quality gate so
  // one historical page cannot permanently block every later batch.
  await redactPersonalAbsolutePaths(wikiRoot);
  const backend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    openWikiIgnore: new OpenWikiIgnore([]),
    outputMode: "local-wiki",
    rootDir: wikiRoot,
    virtualMode: true,
  });
  const labels = resolveIndexLabels(options.language);
  const conceptType = resolveConceptTypeLabel(options.language);

  await migrateWikiToOkf(backend, "local-wiki", conceptType);
  await validateWikiMermaid(backend, "local-wiki");
  await synchronizeWikiIndexes(backend, "local-wiki", labels, conceptType);
  await updatePersonalTrackingPages(wikiRoot);
  await updateQuickstartNavigation(wikiRoot);
  await migrateWikiToOkf(backend, "local-wiki", conceptType);
  await synchronizeWikiIndexes(backend, "local-wiki", labels, conceptType);
  const repairedLinks = await repairUnambiguousRelativeLinks(wikiRoot);

  return {
    ...(await validateFinalizedWiki(wikiRoot, options)),
    repairedLinks,
  };
}

async function redactPersonalAbsolutePaths(wikiRoot: string): Promise<void> {
  for (const relativePath of await listMarkdownFiles(wikiRoot)) {
    const target = path.join(wikiRoot, ...relativePath.split("/"));
    const original = await readFile(target, "utf8");
    const next = redactPersonalPathPrefixes(original);
    if (next !== original) await writeFileAtomic(target, next);
  }
}

function redactPersonalPathPrefixes(content: string): string {
  return content
    .replace(PERSONAL_POSIX_PATH_PREFIX_PATTERN, REDACTED_PERSONAL_PATH)
    .replace(PERSONAL_WINDOWS_PATH_PREFIX_PATTERN, REDACTED_PERSONAL_PATH);
}

async function ensureQuickstart(wikiRoot: string): Promise<void> {
  const quickstart = path.join(wikiRoot, "quickstart.md");
  try {
    await readFile(quickstart, "utf8");
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
    await writeFileAtomic(
      quickstart,
      `---\ntype: "导航"\ntitle: "个人知识库"\ndescription: "个人长期知识、项目记录与可复用经验的入口。"\n---\n\n# 个人知识库\n\n这里汇总经过证据约束和去重整理的长期知识。\n`,
    );
  }
}

async function updateQuickstartNavigation(wikiRoot: string): Promise<void> {
  const quickstartPath = path.join(wikiRoot, "quickstart.md");
  const original = await readFile(quickstartPath, "utf8");
  const entries = await readdir(wikiRoot, { withFileTypes: true });
  const links: string[] = [];
  const labels: Record<string, string> = {
    commitments: "承诺追踪",
    decisions: "设计与工作决策",
    "doubao-knowledge": "豆包知识卡片",
    journals: "项目与开发日志",
    lessons: "可复用经验",
    "open-questions": "开放问题",
    projects: "项目知识",
    sources: "证据来源",
    themes: "长期主题",
  };

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      links.push(
        `- [${labels[entry.name] ?? entry.name}](${encodeURIComponent(entry.name)}/)`,
      );
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      !NON_CONCEPT_FILES.has(entry.name) &&
      entry.name !== "quickstart.md"
    ) {
      const content = await readFile(path.join(wikiRoot, entry.name), "utf8");
      const title =
        stringField(parseFrontmatterFields(content)?.title) ??
        path.basename(entry.name, ".md");
      links.push(
        `- [${escapeLabel(title)}](${encodeURIComponent(entry.name)})`,
      );
    }
  }

  const block = `${NAV_START}\n## 导航\n\n${links.length > 0 ? links.join("\n") : "当前还没有提取出需要长期保存的知识。"}\n${NAV_END}`;
  const next =
    original.includes(NAV_START) && original.includes(NAV_END)
      ? original.replace(
          new RegExp(
            `${escapeRegExp(NAV_START)}[\\s\\S]*?${escapeRegExp(NAV_END)}`,
            "u",
          ),
          block,
        )
      : `${original.trimEnd()}\n\n${block}\n`;
  if (next !== original) await writeFileAtomic(quickstartPath, next);
}

async function updatePersonalTrackingPages(wikiRoot: string): Promise<void> {
  const pages = (
    await Promise.all(
      (await listMarkdownFiles(wikiRoot)).map(async (relativePath) => {
        const content = await readFile(
          path.join(wikiRoot, ...relativePath.split("/")),
          "utf8",
        );
        const fields = parseFrontmatterFields(content) ?? {};
        const stableKey =
          stringField(fields.stableKey) ?? stringField(fields.stable_key);
        if (!stableKey) return undefined;
        return {
          relativePath,
          tags: arrayField(fields.tags),
          title:
            stringField(fields.title) ?? path.basename(relativePath, ".md"),
          type: stringField(fields.type),
        };
      }),
    )
  ).filter((page): page is NonNullable<typeof page> => page !== undefined);

  const themes = new Map<string, typeof pages>();
  for (const page of pages) {
    for (const tag of page.tags) {
      const tagged = themes.get(tag) ?? [];
      tagged.push(page);
      themes.set(tag, tagged);
    }
  }
  const themeSections = [...themes]
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN"))
    .map(
      ([tag, tagged]) =>
        `### ${tag}\n\n${renderTrackingLinks(uniquePages(tagged))}`,
    );
  await updateTrackingPage(
    wikiRoot,
    "themes.md",
    "长期主题",
    "按标签聚合个人知识页面，便于跨项目浏览。",
    themeSections.join("\n\n"),
  );
  await updateTrackingPage(
    wikiRoot,
    "commitments.md",
    "承诺追踪",
    "持续跟踪从历史记录中提取的明确承诺。",
    renderTrackingLinks(pages.filter((page) => page.type === "Commitment")),
  );
  await updateTrackingPage(
    wikiRoot,
    "open-questions.md",
    "开放问题",
    "集中查看仍需回答、验证或推进的问题。",
    renderTrackingLinks(pages.filter((page) => page.type === "OpenQuestion")),
  );
}

async function updateTrackingPage(
  wikiRoot: string,
  filename: string,
  title: string,
  description: string,
  content: string,
): Promise<void> {
  const target = path.join(wikiRoot, filename);
  let original = "";
  try {
    original = await readFile(target, "utf8");
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
  if (!original && !content) return;
  const block = `${TRACKING_START}\n## 自动追踪\n\n${content || "当前没有待追踪条目。"}\n${TRACKING_END}`;
  const next = original
    ? original.includes(TRACKING_START) && original.includes(TRACKING_END)
      ? original.replace(
          new RegExp(
            `${escapeRegExp(TRACKING_START)}[\\s\\S]*?${escapeRegExp(TRACKING_END)}`,
            "u",
          ),
          block,
        )
      : `${original.trimEnd()}\n\n${block}\n`
    : `---\ntype: "导航"\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${title}\n\n${description}\n\n${block}\n`;
  if (next !== original) await writeFileAtomic(target, next);
}

function renderTrackingLinks(
  pages: Array<{ relativePath: string; title: string }>,
): string {
  return uniquePages(pages)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map(
      (page) =>
        `- [${escapeLabel(page.title)}](${encodeWikiPath(page.relativePath)})`,
    )
    .join("\n");
}

function uniquePages<Page extends { relativePath: string }>(
  pages: Page[],
): Page[] {
  return [...new Map(pages.map((page) => [page.relativePath, page])).values()];
}

function encodeWikiPath(relativePath: string): string {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

async function validateFinalizedWiki(
  wikiRoot: string,
  options: PersonalFinalizeOptions,
): Promise<PersonalFinalizeReport> {
  const files = await listMarkdownFiles(wikiRoot);
  const pages = await Promise.all(
    files.map(async (relativePath) => {
      const content = await readFile(
        path.join(wikiRoot, ...relativePath.split("/")),
        "utf8",
      );
      return {
        content,
        fields: parseFrontmatterFields(content) ?? {},
        relativePath,
      };
    }),
  );
  const issues: PersonalQualityIssue[] = [];

  issues.push(...(await validateLinksAndIndexes(wikiRoot, pages)));
  issues.push(...validateReachability(pages));
  issues.push(...validateStableKeysAndSimilarity(pages));
  issues.push(...(await validateEvidence(pages, options)));
  issues.push(...validateSecurityAndLanguage(pages, options.language));
  issues.push(...validateCandidateCoverage(pages, options));

  return {
    filesScanned: files.length,
    issues,
    valid: issues.length === 0,
  };
}

async function repairUnambiguousRelativeLinks(
  wikiRoot: string,
): Promise<string[]> {
  const files = await listMarkdownFiles(wikiRoot);
  const pagePaths = new Set(files);
  const repaired: string[] = [];

  for (const relativePath of files) {
    const target = path.join(wikiRoot, ...relativePath.split("/"));
    const original = await readFile(target, "utf8");
    const next = original.replace(
      MARKDOWN_LINK_PATTERN,
      (fullMatch: string, rawHref: string) => {
        if (resolveExistingWikiLink(relativePath, rawHref, pagePaths)) {
          return fullMatch;
        }
        const replacement = findUnambiguousLinkTarget(
          relativePath,
          rawHref,
          pagePaths,
        );
        if (!replacement) return fullMatch;
        repaired.push(`${relativePath}: ${rawHref} -> ${replacement}`);
        return fullMatch.replace(rawHref, replacement);
      },
    );
    if (next !== original) await writeFileAtomic(target, next);
  }
  return repaired;
}

function resolveExistingWikiLink(
  from: string,
  href: string,
  pagePaths: Set<string>,
): boolean {
  const resolved = resolveWikiLink(from, href);
  return resolved === undefined || pagePaths.has(resolved);
}

function findUnambiguousLinkTarget(
  from: string,
  rawHref: string,
  pagePaths: Set<string>,
): string | undefined {
  const href = rawHref.replace(/^<|>$/gu, "").trim();
  if (
    !href ||
    href.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(href) ||
    href.startsWith("//")
  ) {
    return undefined;
  }
  const suffix = href.match(/([?#].*)$/u)?.[1] ?? "";
  let pathname = href.slice(0, suffix ? -suffix.length : undefined);
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const normalizedRootTarget = path.posix
    .normalize(pathname.replace(/^\/+/, ""))
    .replace(/^\.\//u, "");
  const asPage =
    pathname.endsWith("/") || path.posix.extname(normalizedRootTarget) === ""
      ? path.posix.join(normalizedRootTarget, "index.md")
      : normalizedRootTarget;
  const candidates = pagePaths.has(asPage)
    ? [asPage]
    : [...pagePaths].filter(
        (pagePath) => pagePath === asPage || pagePath.endsWith(`/${asPage}`),
      );
  if (candidates.length !== 1) return undefined;

  const candidate = candidates[0];
  if (!candidate) return undefined;
  let relative = path.posix.relative(path.posix.dirname(from), candidate);
  if (relative === "") relative = path.posix.basename(candidate);
  if (candidate.endsWith("/index.md") && !pathname.endsWith("index.md")) {
    relative = relative.replace(/index\.md$/u, "");
  }
  return `${relative}${suffix}`;
}

interface WikiPage {
  content: string;
  fields: Record<string, unknown>;
  relativePath: string;
}

async function validateLinksAndIndexes(
  wikiRoot: string,
  pages: WikiPage[],
): Promise<PersonalQualityIssue[]> {
  const issues: PersonalQualityIssue[] = [];
  const pagePaths = new Set(pages.map((page) => page.relativePath));

  for (const page of pages) {
    for (const href of markdownLinks(page.content)) {
      const resolved = resolveWikiLink(page.relativePath, href);
      if (!resolved) continue;
      if (!pagePaths.has(resolved)) {
        issues.push({
          code: "broken_link",
          file: page.relativePath,
          message: `相对链接不存在：${href}`,
        });
      }
    }
  }

  const directories = await listDirectories(wikiRoot);
  for (const directory of directories) {
    const indexPath = directory ? `${directory}/index.md` : "index.md";
    const index = pages.find((page) => page.relativePath === indexPath);
    if (!index) {
      issues.push({
        code: "missing_index",
        file: indexPath,
        message: "目录缺少 index.md。",
      });
      continue;
    }
    const linked = new Set(
      markdownLinks(index.content)
        .map((href) => resolveWikiLink(indexPath, href))
        .filter((target): target is string => target !== undefined),
    );
    const immediatePages = pages.filter((page) => {
      if (page.relativePath === indexPath) return false;
      return path.posix.dirname(page.relativePath) === (directory || ".");
    });
    for (const child of immediatePages) {
      if (
        !NON_CONCEPT_FILES.has(path.posix.basename(child.relativePath)) &&
        !linked.has(child.relativePath)
      ) {
        issues.push({
          code: "index_missing_entry",
          file: indexPath,
          message: `索引遗漏页面：${child.relativePath}`,
        });
      }
    }
  }
  return issues;
}

function validateReachability(pages: WikiPage[]): PersonalQualityIssue[] {
  const pagePaths = new Set(pages.map((page) => page.relativePath));
  const byPath = new Map(pages.map((page) => [page.relativePath, page]));
  const queue = ["quickstart.md", "index.md"].filter((file) =>
    pagePaths.has(file),
  );
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const page = byPath.get(current);
    if (!page) continue;
    for (const href of markdownLinks(page.content)) {
      const target = resolveWikiLink(current, href);
      if (target && pagePaths.has(target) && !visited.has(target))
        queue.push(target);
    }
  }

  return pages
    .filter(
      (page) =>
        !visited.has(page.relativePath) &&
        !RESERVED_FILES.has(path.posix.basename(page.relativePath)),
    )
    .map((page) => ({
      code: "orphan_page",
      file: page.relativePath,
      message: "页面无法从 quickstart.md 或目录索引到达。",
    }));
}

function validateStableKeysAndSimilarity(
  pages: WikiPage[],
): PersonalQualityIssue[] {
  const issues: PersonalQualityIssue[] = [];
  const byStableKey = new Map<string, string[]>();
  const concepts = pages.filter(
    (page) => !NON_CONCEPT_FILES.has(path.posix.basename(page.relativePath)),
  );
  for (const page of concepts) {
    const stableKey =
      stringField(page.fields.stableKey) ?? stringField(page.fields.stable_key);
    if (
      stableKey &&
      !VALID_KNOWLEDGE_TYPES.has(stringField(page.fields.type) ?? "")
    ) {
      issues.push({
        code: "invalid_knowledge_type",
        file: page.relativePath,
        message: "结构化页面的 type 不属于个人知识候选类型。",
      });
    }
    const knowledgeType = stringField(page.fields.type);
    const expectedDirectory = knowledgeType
      ? directoryForKnowledgeType(knowledgeType)
      : undefined;
    if (
      stableKey &&
      expectedDirectory &&
      !page.relativePath.startsWith(`${expectedDirectory}/`)
    ) {
      issues.push({
        code: "invalid_knowledge_directory",
        file: page.relativePath,
        message: `${knowledgeType} 页面应位于 ${expectedDirectory}/。`,
      });
    }
    if (
      stableKey &&
      !VALID_CONFIDENCE_LEVELS.has(stringField(page.fields.confidence) ?? "")
    ) {
      issues.push({
        code: "invalid_confidence",
        file: page.relativePath,
        message: "结构化页面缺少有效 confidence。",
      });
    }
    if (stableKey && typeof page.fields.volatile !== "boolean") {
      issues.push({
        code: "invalid_volatile",
        file: page.relativePath,
        message: "结构化页面的 volatile 必须是布尔值。",
      });
    }
    if (
      stableKey &&
      page.fields.volatile === true &&
      !stringField(page.fields.validAsOf)
    ) {
      issues.push({
        code: "volatile_without_valid_as_of",
        file: page.relativePath,
        message: "易过期信息缺少 validAsOf。",
      });
    }
    for (const key of [
      ...(stableKey ? [stableKey] : []),
      ...arrayField(page.fields.stableKeyAliases),
    ]) {
      const paths = byStableKey.get(key) ?? [];
      paths.push(page.relativePath);
      byStableKey.set(key, paths);
    }
  }
  for (const [stableKey, paths] of byStableKey) {
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length > 1) {
      issues.push({
        code: "duplicate_stable_key",
        message: `stableKey ${stableKey} 同时出现在：${uniquePaths.join("、")}`,
      });
    }
  }

  for (let leftIndex = 0; leftIndex < concepts.length; leftIndex += 1) {
    const left = concepts[leftIndex];
    if (!left) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < concepts.length;
      rightIndex += 1
    ) {
      const right = concepts[rightIndex];
      if (!right || left.fields.type !== right.fields.type) continue;
      const leftTitle = stringField(left.fields.title);
      const rightTitle = stringField(right.fields.title);
      if (!leftTitle || !rightTitle) continue;
      const score = jaccard(titleTokens(leftTitle), titleTokens(rightTitle));
      if (
        score >= 0.92 &&
        normalizeText(leftTitle) !== normalizeText(rightTitle)
      ) {
        issues.push({
          code: "high_similarity_pages",
          message: `疑似重复主题（${score.toFixed(2)}）：${left.relativePath}、${right.relativePath}`,
        });
      }
    }
  }
  return issues;
}

async function validateEvidence(
  pages: WikiPage[],
  options: PersonalFinalizeOptions,
): Promise<PersonalQualityIssue[]> {
  const issues: PersonalQualityIssue[] = [];
  const batchCache = new Map<string, Set<string> | undefined>();
  const candidateRefs = new Set(
    (options.candidates ?? []).flatMap((candidate) => candidate.sourceRefs),
  );

  for (const page of pages) {
    const stableKey =
      stringField(page.fields.stableKey) ?? stringField(page.fields.stable_key);
    const auditableConcept =
      !BATCH_MUTATION_EXEMPT_FILES.has(page.relativePath) &&
      !NON_CONCEPT_FILES.has(path.posix.basename(page.relativePath));
    const bodyChanged =
      auditableConcept &&
      options.baselineBodies !== undefined &&
      options.baselineBodies[page.relativePath] !== bodyHash(page.content);
    const refs = arrayField(page.fields.sourceRefs);
    if (bodyChanged && candidateRefs.size > 0 && !stableKey) {
      issues.push({
        code: "missing_stable_key",
        file: page.relativePath,
        message: "本批新增或修改的知识页面缺少 stableKey。",
      });
    }
    if (
      bodyChanged &&
      candidateRefs.size > 0 &&
      !refs.some((sourceRef) => candidateRefs.has(sourceRef))
    ) {
      issues.push({
        code: "untraceable_batch_mutation",
        file: page.relativePath,
        message: "本批新增或修改的页面没有引用本批候选证据。",
      });
    }
    if (!stableKey) continue;
    if (refs.length === 0) {
      issues.push({
        code: "missing_source_refs",
        file: page.relativePath,
        message: "结构化知识页面缺少 sourceRefs。",
      });
      continue;
    }
    for (const sourceRef of refs) {
      if (!(await sourceRefExists(sourceRef, options.stateRoot, batchCache))) {
        issues.push({
          code: "invalid_source_ref",
          file: page.relativePath,
          message: `无法定位证据：${sourceRef}`,
        });
      }
    }
  }
  return issues;
}

function validateSecurityAndLanguage(
  pages: WikiPage[],
  language: string,
): PersonalQualityIssue[] {
  const issues: PersonalQualityIssue[] = [];
  const chinese = language.toLowerCase().startsWith("zh");
  const secretPattern =
    /(?:\bsk-[A-Za-z0-9_-]{12,}\b|\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*(?!\[REDACTED\])[^\s`]{8,})/iu;
  const personalPathPattern =
    /(?:\/(?:Users|home)\/[^/\s]+(?:\/|$)|[A-Za-z]:\\Users\\[^\\\s]+(?:\\|$))/u;

  for (const page of pages) {
    if (secretPattern.test(page.content)) {
      issues.push({
        code: "suspected_secret",
        file: page.relativePath,
        message: "页面含有疑似密钥或 Token。",
      });
    }
    if (personalPathPattern.test(page.content)) {
      issues.push({
        code: "personal_absolute_path",
        file: page.relativePath,
        message: "页面含有个人绝对路径。",
      });
    }
    const stableKey =
      stringField(page.fields.stableKey) ?? stringField(page.fields.stable_key);
    if (stableKey && chinese && !/[\p{Script=Han}]/u.test(page.content)) {
      issues.push({
        code: "non_chinese_content",
        file: page.relativePath,
        message: "中文知识库中的结构化页面没有中文内容。",
      });
    }
  }
  return issues;
}

function validateCandidateCoverage(
  pages: WikiPage[],
  options: PersonalFinalizeOptions,
): PersonalQualityIssue[] {
  const issues: PersonalQualityIssue[] = [];
  const byStableKey = new Map<string, WikiPage>();
  for (const page of pages) {
    const stableKey =
      stringField(page.fields.stableKey) ?? stringField(page.fields.stable_key);
    if (stableKey) byStableKey.set(stableKey, page);
    for (const alias of arrayField(page.fields.stableKeyAliases)) {
      byStableKey.set(alias, page);
    }
    if (
      !options.allowFallbackGenerated &&
      page.fields.fallbackGenerated === true
    ) {
      issues.push({
        code: "fallback_review_required",
        file: page.relativePath,
        message: "降级生成页面尚未经过正常 Agent 复核。",
      });
    }
  }

  for (const candidate of options.candidates ?? []) {
    const page = byStableKey.get(candidate.stableKey);
    if (!page) {
      issues.push({
        code: "candidate_not_rendered",
        message: `候选没有合并到 Wiki：${candidate.stableKey}`,
      });
      continue;
    }
    if (page.fields.type !== candidate.type) {
      issues.push({
        code: "candidate_type_mismatch",
        file: page.relativePath,
        message: `type 应为 ${candidate.type}。`,
      });
    }
    const refs = new Set(arrayField(page.fields.sourceRefs));
    for (const sourceRef of candidate.sourceRefs) {
      if (!refs.has(sourceRef)) {
        issues.push({
          code: "candidate_source_missing",
          file: page.relativePath,
          message: `页面没有保留候选来源：${sourceRef}`,
        });
      }
    }
    if (
      options.requireCandidateReview &&
      page.fields.fallbackGenerated === true
    ) {
      issues.push({
        code: "fallback_review_required",
        file: page.relativePath,
        message: "当前候选对应页面仍带 fallbackGenerated 标记。",
      });
    }
  }
  return issues;
}

async function sourceRefExists(
  sourceRef: string,
  stateRoot: string | undefined,
  cache: Map<string, Set<string> | undefined>,
): Promise<boolean> {
  const match = SOURCE_REF_PATTERN.exec(sourceRef);
  if (!match) return false;
  const [, connectorId, relativePath, recordId] = match;
  if (!connectorId || !relativePath || !recordId) return false;
  const rawRoot = stateRoot
    ? path.join(stateRoot, connectorId, "raw")
    : getConnectorRawDir(connectorId);
  const resolved = path.resolve(rawRoot, ...relativePath.split("/"));
  if (resolved !== rawRoot && !resolved.startsWith(`${rawRoot}${path.sep}`)) {
    return false;
  }
  let ids = cache.get(resolved);
  if (!cache.has(resolved)) {
    try {
      const parsed = JSON.parse(await readFile(resolved, "utf8")) as unknown;
      ids =
        isRecord(parsed) && Array.isArray(parsed.records)
          ? new Set(
              parsed.records
                .filter(isRecord)
                .map((record) => record.id)
                .filter((id): id is string => typeof id === "string"),
            )
          : undefined;
    } catch {
      ids = undefined;
    }
    cache.set(resolved, ids);
  }
  return ids?.has(recordId) === true;
}

function markdownLinks(content: string): string[] {
  return [...content.matchAll(MARKDOWN_LINK_PATTERN)]
    .map((match) => match[1]?.trim())
    .filter((href): href is string => Boolean(href));
}

function resolveWikiLink(from: string, rawHref: string): string | undefined {
  const href = rawHref.replace(/^<|>$/gu, "").trim();
  if (
    !href ||
    href.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(href) ||
    href.startsWith("//")
  ) {
    return undefined;
  }
  let pathname = href.split(/[?#]/u)[0] ?? "";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return "__invalid_percent_encoding__";
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), pathname),
  );
  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    path.posix.isAbsolute(resolved)
  ) {
    return "__outside_wiki__";
  }
  return pathname.endsWith("/") || path.posix.extname(resolved) === ""
    ? path.posix.join(resolved, "index.md")
    : resolved;
}

async function listMarkdownFiles(
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
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listMarkdownFiles(root, entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      result.push(path.relative(root, entryPath).split(path.sep).join("/"));
    }
  }
  return result.sort();
}

async function listDirectories(
  root: string,
  current = root,
): Promise<string[]> {
  const directories = [path.relative(root, current).split(path.sep).join("/")];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      entry.name.startsWith(".") ||
      entry.isSymbolicLink() ||
      !entry.isDirectory()
    )
      continue;
    directories.push(
      ...(await listDirectories(root, path.join(current, entry.name))),
    );
  }
  return directories;
}

function titleTokens(value: string): Set<string> {
  const normalized = normalizeText(value);
  const tokens = new Set<string>();
  const words = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const word of words) tokens.add(word);
  const han = [...normalized.matchAll(/[\p{Script=Han}]+/gu)]
    .map((match) => match[0])
    .join("");
  for (let index = 0; index < han.length - 1; index += 1) {
    tokens.add(han.slice(index, index + 2));
  }
  return tokens;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "").trim();
}

function directoryForKnowledgeType(type: string): string | undefined {
  switch (type) {
    case "Project":
      return "projects";
    case "Journal":
      return "journals";
    case "Lesson":
      return "lessons";
    case "KnowledgeCard":
      return "doubao-knowledge";
    case "Decision":
      return "decisions";
    case "Commitment":
      return "commitments";
    case "OpenQuestion":
      return "open-questions";
    case "SourceEvidence":
      return "sources";
    default:
      return undefined;
  }
}

function bodyHash(content: string): string {
  return createHash("sha256")
    .update(splitFrontmatterBody(content))
    .digest("hex");
}

function splitFrontmatterBody(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(content);
  return match ? content.slice(match[0].length) : content;
}

function arrayField(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, target);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  Budget,
  Collector,
  describeRubyIndex,
  EDGE_LABELS,
  findRoot,
  isTestPath,
  jsDefinitionStart,
  languageFor,
  type Definition,
  type Language,
  type QueueItem,
  type ReferenceHit,
  type SparsityEdge,
  type SparsityNode,
} from "./sparsity.ts";
import { rubyAdapter } from "./adapters/ruby.ts";
import { buildRubyIndex, type RubyIndex } from "./adapters/ruby-index.ts";
import { TsPrograms } from "./adapters/ts.ts";
import { displaySearchRoot, normalizeRepoRelativePath } from "./shared.ts";
import { ensureInsideCwd } from "./sparsity-shared.ts";
import { boundarySignal, RANKING_EXPLANATION } from "./rank.ts";
import { edgeMetrics, indexMetrics, writeMetrics } from "./metrics.ts";

export interface ScanOptions {
  cwd: string;
  diff: string;
  anchors?: string[];
  maxDepth: number;
  vicinity: number;
  maxNodes: number;
  maxAnchors: number;
  root?: string;
  budgetMs: number;
  outputDir: string;
  inlineBudgetBytes: number;
  indexCacheDir?: string;
  metricsLog?: string;
  signal?: AbortSignal;
}

export type FileKind = "code" | "test" | "generated" | "other";

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: Hunk[];
  newRanges: Array<[number, number]>;
  oldRanges: Array<[number, number]>;
  kind: FileKind;
  language?: Language;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface FileHunkRecord {
  id: string;
  path: string;
  kind: "generated" | "other";
  status: ChangedFile["status"];
  hunks: Array<{ oldStart: number; oldLines: string[]; newStart: number; newLines: string[] }>;
  omittedLines: number;
}

export interface TestGroupRecord {
  id: string;
  path: string;
  entries: Array<{ symbol: string; startLine: number; endLine: number; fingerprint: string; snippet: string }>;
}

export interface AnchorRecord {
  id: string;
  symbol: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  fingerprint: string;
  changedLines: number[];
  removed: Array<{ oldStart: number; lines: string[] }>;
  boundary: { score: number; tags: string[] };
  callers: Array<{ id: string; symbol: string; path: string; line: number; text: string; test: boolean; changed: boolean; boundary: string[] }>;
  tests: Array<{ id: string; symbol: string; path: string; line: number; text: string }>;
}

export interface DanglingRecord {
  name: string;
  oldPath: string;
  oldLine: number;
  language: Language;
  stillDefined: boolean;
  callers: Array<{ id: string; symbol: string; path: string; line: number; text: string; test: boolean }>;
}

export interface Section {
  id: string;
  body: string;
  bytes: number;
  tokens: number;
  inline: boolean;
  startLine: number;
  endLine: number;
}

export interface ScanResult {
  label: string;
  head: string;
  base?: string;
  checkoutHead: string;
  dirty: boolean;
  roots: string[];
  files: ChangedFile[];
  fileHunks: FileHunkRecord[];
  anchors: AnchorRecord[];
  testGroups: TestGroupRecord[];
  skippedAnchors: string[];
  nodes: SparsityNode[];
  edges: SparsityEdge[];
  dangling: DanglingRecord[];
  coverage: {
    maxDepth: number;
    depthReached: number;
    vicinity: number;
    unresolved: number;
    truncatedBy: string;
    frontier: string[];
    cycles: string[];
    notes: string[];
    rgCalls: number;
    elapsedMs: number;
  };
  sections: Section[];
  packPath: string;
  jsonPath: string;
  metricsPath: string;
  inline: string;
}

const GIT_TIMEOUT_MS = 20_000;
const SEARCH_CONCURRENCY = 4;
const MAX_TEST_ANCHORS_PER_FILE = 2;

async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
const GENERATED_PATTERNS = [
  /(^|\/)(schema\.rb|structure\.sql|db\/schema\/)/,
  /\.(lock|snap|min\.js|map|generated\.[cm]?[jt]sx?|graphql\.json|d\.ts)$/,
  /(^|\/)(__snapshots__|node_modules|vendor|dist|build|coverage)\//,
  /(^|\/)(sorbet\/rbi|rbi)\//,
  /\.generated\./,
];

function git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, signal, timeout: GIT_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) rejectPromise(new Error(`git ${args.slice(0, 2).join(" ")} failed: ${String(stderr || error.message).trim()}`));
      else resolvePromise(String(stdout ?? ""));
    });
  });
}

function classifyFile(path: string, binary: boolean): FileKind {
  if (binary) return "other";
  if (GENERATED_PATTERNS.some((pattern) => pattern.test(path))) return "generated";
  if (!languageFor(path)) return "other";
  return isTestPath(path) ? "test" : "code";
}

export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  const flush = () => {
    if (current) files.push(current);
    current = undefined;
  };

  for (const rawLine of text.split("\n")) {
    const header = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      flush();
      const oldPath = normalizeRepoRelativePath(header[1]!);
      const path = normalizeRepoRelativePath(header[2]!);
      current = {
        path,
        oldPath: oldPath !== path ? oldPath : undefined,
        status: oldPath !== path ? "renamed" : "modified",
        hunks: [],
        newRanges: [],
        oldRanges: [],
        kind: "other",
        additions: 0,
        deletions: 0,
        binary: false,
      };
      continue;
    }
    if (!current) continue;
    if (/^new file mode/.test(rawLine)) current.status = "added";
    else if (/^deleted file mode/.test(rawLine)) current.status = "deleted";
    else if (/^Binary files /.test(rawLine)) current.binary = true;
    else if (/^rename from /.test(rawLine)) current.status = "renamed";
    else if (rawLine.startsWith("+++ ")) {
      const target = rawLine.slice(4).trim();
      if (target !== "/dev/null") current.path = normalizeRepoRelativePath(target.replace(/^b\//, ""));
    } else if (rawLine.startsWith("--- ")) {
      const source = rawLine.slice(4).trim();
      if (source !== "/dev/null") {
        const oldPath = normalizeRepoRelativePath(source.replace(/^a\//, ""));
        if (oldPath !== current.path) current.oldPath = oldPath;
      }
    } else {
      const hunk = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunk) {
        const oldStart = Number(hunk[1]);
        const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
        const newStart = Number(hunk[3]);
        const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
        current.hunks.push({ oldStart, oldCount, newStart, newCount });
        if (oldCount > 0) current.oldRanges.push([oldStart, oldStart + oldCount - 1]);
        if (newCount > 0) current.newRanges.push([newStart, newStart + newCount - 1]);
        else current.newRanges.push([Math.max(1, newStart), Math.max(1, newStart)]);
        current.additions += newCount;
        current.deletions += oldCount;
      }
    }
  }
  flush();

  for (const file of files) {
    if (file.status === "deleted" && file.oldPath === undefined) file.oldPath = file.path;
    file.kind = classifyFile(file.status === "deleted" ? file.oldPath ?? file.path : file.path, file.binary);
    file.language = languageFor(file.status === "deleted" ? file.oldPath ?? file.path : file.path);
  }
  return files;
}

async function resolveDiff(diff: string, cwd: string, signal?: AbortSignal): Promise<{ label: string; base?: string; head: string; dirty: boolean; args: string[]; untracked: string[] }> {
  const trimmed = diff.trim();
  const headSha = (await git(["rev-parse", "HEAD"], cwd, signal)).trim();
  if (!trimmed || trimmed === "worktree") {
    const untracked = (await git(["ls-files", "--others", "--exclude-standard"], cwd, signal)).split("\n").map((line) => line.trim()).filter(Boolean);
    return { label: `worktree vs HEAD (${headSha.slice(0, 12)})`, base: "HEAD", head: headSha, dirty: true, args: ["diff", "--unified=0", "--no-color", "--no-ext-diff", "-M", "HEAD"], untracked };
  }
  const triple = trimmed.match(/^(.+?)\.\.\.(.+)$/);
  if (triple) {
    const mergeBase = (await git(["merge-base", triple[1]!, triple[2]!], cwd, signal)).trim();
    const head = (await git(["rev-parse", triple[2]!], cwd, signal)).trim();
    return { label: `${triple[1]}...${triple[2]} (merge-base ${mergeBase.slice(0, 12)} → ${head.slice(0, 12)})`, base: mergeBase, head, dirty: false, args: ["diff", "--unified=0", "--no-color", "--no-ext-diff", "-M", mergeBase, head], untracked: [] };
  }
  const double = trimmed.match(/^(.+?)\.\.(.+)$/);
  if (double) {
    const base = (await git(["rev-parse", double[1]!], cwd, signal)).trim();
    const head = (await git(["rev-parse", double[2]!], cwd, signal)).trim();
    return { label: `${double[1]}..${double[2]} (${base.slice(0, 12)} → ${head.slice(0, 12)})`, base, head, dirty: false, args: ["diff", "--unified=0", "--no-color", "--no-ext-diff", "-M", base, head], untracked: [] };
  }
  const head = (await git(["rev-parse", trimmed], cwd, signal)).trim();
  const base = (await git(["rev-parse", `${trimmed}^`], cwd, signal)).trim();
  return { label: `${trimmed} (${base.slice(0, 12)} → ${head.slice(0, 12)})`, base, head, dirty: false, args: ["diff", "--unified=0", "--no-color", "--no-ext-diff", "-M", base, head], untracked: [] };
}

function removedDefinitionNames(lines: string[], ranges: Array<[number, number]>, language: Language): Array<{ name: string; line: number }> {
  const found: Array<{ name: string; line: number }> = [];
  for (const [start, end] of ranges) {
    for (let n = start; n <= Math.min(end, lines.length); n += 1) {
      const text = lines[n - 1]!;
      if (language === "ruby") {
        const match = text.match(/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/);
        if (match) found.push({ name: match[1]!, line: n });
      } else {
        const start = jsDefinitionStart(text);
        if (start && start.kind !== "test" && start.kind !== "class") found.push({ name: start.name, line: n });
      }
    }
  }
  return found;
}

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function compressRanges(lines: number[]): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const line of sorted.slice(1)) {
    if (previous !== undefined && line === previous + 1) {
      previous = line;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = line;
    previous = line;
  }
  if (start !== undefined) parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  return parts.join(", ");
}

function anchorPriority(file: ChangedFile, def: Definition): number {
  let score = 0;
  if (file.kind === "test") score += 100;
  if (["declaration", "statement", "constant"].includes(def.kind)) score += 50;
  if (["class", "module", "type", "object"].includes(def.kind)) score += 40;
  return score;
}

export async function scanSparsity(options: ScanOptions): Promise<ScanResult> {
  const budget = new Budget(options.budgetMs);
  let counter = 0;
  const nextId = () => `n${++counter}`;
  const { cwd, signal } = options;

  let files: ChangedFile[] = [];
  let label: string;
  let head: string;
  let base: string | undefined;
  let dirty = false;

  if (options.anchors?.length) {
    label = `explicit anchors (${options.anchors.length})`;
    head = (await git(["rev-parse", "HEAD"], cwd, signal).catch(() => "unknown")).trim();
    for (const target of options.anchors) {
      const match = target.trim().match(/^(.+?):(\d+)(?::\d+)?$/);
      if (!match) throw new Error(`anchor must look like path:line, received ${JSON.stringify(target)}`);
      const path = normalizeRepoRelativePath(match[1]!);
      const line = Number(match[2]);
      const existing = files.find((file) => file.path === path);
      if (existing) existing.newRanges.push([line, line]);
      else files.push({ path, status: "modified", hunks: [], newRanges: [[line, line]], oldRanges: [], kind: classifyFile(path, false), language: languageFor(path), additions: 0, deletions: 0, binary: false });
    }
  } else {
    const resolved = await resolveDiff(options.diff, cwd, signal);
    label = resolved.label;
    head = resolved.head;
    base = resolved.base;
    dirty = resolved.dirty;
    files = parseUnifiedDiff(await git(resolved.args, cwd, signal));
    for (const path of resolved.untracked) {
      const normalized = normalizeRepoRelativePath(path);
      if (files.some((file) => file.path === normalized)) continue;
      files.push({ path: normalized, status: "added", hunks: [], newRanges: [[1, Number.MAX_SAFE_INTEGER]], oldRanges: [], kind: classifyFile(normalized, false), language: languageFor(normalized), additions: 0, deletions: 0, binary: false });
    }
  }

  const indexNotes: string[] = [];
  const headContent = new Map<string, string>();
  const headContentAbsolute = new Map<string, string>();
  const checkoutHead = options.anchors?.length || dirty ? head : (await git(["rev-parse", "HEAD"], cwd, signal).catch(() => head)).trim();
  if (checkoutHead !== head) {
    const readable = files.filter((file) => file.status !== "deleted" && !file.binary);
    await pool(readable, SEARCH_CONCURRENCY, async (file) => {
      const content = await git(["show", `${head}:${file.path}`], cwd, signal).catch(() => undefined);
      if (content === undefined) return;
      headContent.set(file.path, content);
      headContentAbsolute.set(resolve(cwd, file.path), content);
    });
    indexNotes.push(`checkout HEAD ${checkoutHead.slice(0, 12)} differs from range head ${head.slice(0, 12)}: the ${headContent.size} changed files were read at ${head.slice(0, 12)}, so anchors, snippets and line numbers are the range head's; callers, tests and unchanged files reflect the checkout.`);
  }

  const rubyReady = files.some((file) => file.language === "ruby") ? await rubyAdapter.ready() : false;
  const rubyIndexes = new Map<string, RubyIndex>();
  const tsFiles = files.filter((file) => file.language === "javascript" && file.status !== "deleted" && (file.kind === "code" || file.kind === "test")).map((file) => resolve(cwd, file.path));
  const tsPrograms = tsFiles.length ? new TsPrograms(cwd, headContentAbsolute) : undefined;
  tsPrograms?.prepare(tsFiles, signal);
  indexNotes.push(...(tsPrograms?.describe() ?? []));
  const collectors = new Map<string, Collector>();
  const rootOverride = options.root && resolve(cwd, options.root) !== resolve(cwd) ? options.root : undefined;
  if (options.root && !rootOverride) indexNotes.push("Whole-repository root override ignored for a diff; using the nearest component root per changed file.");
  const collectorFor = async (path: string): Promise<{ collector: Collector; rootDisplay: string } | undefined> => {
    const absolute = ensureInsideCwd(cwd, path);
    const root = await findRoot(cwd, absolute, rootOverride);
    const rootDisplay = displaySearchRoot(cwd, root);
    let collector = collectors.get(rootDisplay);
    if (!collector) {
      let rubyIndex: RubyIndex | undefined;
      const productionRubyChange = files.some((file) => file.language === "ruby" && file.kind === "code" && file.status !== "deleted" && (rootDisplay === "." || file.path === rootDisplay || file.path.startsWith(`${rootDisplay}/`)));
      if (rubyReady && options.indexCacheDir && languageFor(path) === "ruby" && !productionRubyChange) {
        indexNotes.push(`Ruby index for ${rootDisplay} skipped: only test files changed under it; name-based ripgrep resolution used instead.`);
      }
      if (rubyReady && options.indexCacheDir && languageFor(path) === "ruby" && productionRubyChange) {
        rubyIndex = await buildRubyIndex({ cwd, root: rootDisplay, cacheDir: options.indexCacheDir, signal, overlay: headContent, log: (message) => indexNotes.push(message) });
        rubyIndexes.set(rootDisplay, rubyIndex);
        const described = describeRubyIndex(rubyIndex);
        if (described) indexNotes.push(described);
      }
      collector = new Collector({ cwd, maxDepth: options.maxDepth, vicinity: options.vicinity, maxNodes: options.maxNodes, budgetMs: options.budgetMs, signal }, root, {
        budget,
        nextId,
        expandedCount: () => [...collectors.values()].reduce((sum, item) => sum + item.expandedNodes, 0),
        rubyReady,
        rubyIndex: rubyIndex && !rubyIndex.skipped ? rubyIndex : undefined,
        tsPrograms,
      });
      for (const [path, content] of headContent) collector.preload(path, content);
      collectors.set(rootDisplay, collector);
    }
    return { collector, rootDisplay };
  };

  // Anchor discovery
  type Candidate = { file: ChangedFile; collector: Collector; node: SparsityNode; def: Definition; changedLines: number[]; priority: number; boundary: { score: number; tags: string[] } };
  const candidates: Candidate[] = [];
  const candidateByKey = new Map<string, Candidate>();
  for (const file of files) {
    if (file.status === "deleted" || (file.kind !== "code" && file.kind !== "test") || !file.language) continue;
    const found = await collectorFor(file.path);
    if (!found) continue;
    const lines = await found.collector.lines(file.path);
    if (!lines) continue;
    for (const [start, rawEnd] of file.newRanges) {
      const end = Math.min(rawEnd, lines.length);
      let line = Math.min(start, lines.length);
      while (line >= 1 && line <= end) {
        const text = lines[line - 1] ?? "";
        if (!text.trim() || /^\s*(#|\/\/|\*|\/\*)/.test(text)) {
          line += 1;
          continue;
        }
        const created = await found.collector.node(file.path, line, 0, line);
        if (!created) {
          line += 1;
          continue;
        }
        const container = created.def.kind === "class" || created.def.kind === "module";
        const single = created.def.kind === "statement" || created.def.kind === "declaration";
        const previous = (lines[line - 2] ?? "").trimEnd();
        const continuation = /[,(\[{|\\]$/.test(previous) || /^\s*[.)\]}]/.test(text) || /^\s*["'`]/.test(text) || /^\s*[a-z_]\w*:\s/.test(text) && /[,(]$/.test(previous);
        const closer = /^\s*(end|else|elsif|ensure|rescue|begin|do|then|[}\])]+;?)\s*$/.test(text);
        if (single && (!/[A-Za-z_$]/.test(text) || closer || continuation || /^\s*(import\b|export\s+(\*|\{)|export\s+.*\bfrom\b|const\s+.*=\s*require\()/.test(text))) {
          line += 1;
          continue;
        }
        const key = `${file.path}:${created.def.startLine}:${created.def.symbol}`;
        const existing = candidateByKey.get(key);
        if (existing) {
          if (!existing.changedLines.includes(line)) existing.changedLines.push(line);
        } else {
          const candidate: Candidate = { file, collector: found.collector, node: created.node, def: created.def, changedLines: [line], priority: anchorPriority(file, created.def), boundary: { score: 0, tags: [] } };
          candidates.push(candidate);
          candidateByKey.set(key, candidate);
        }
        line = container ? line + 1 : Math.max(line, created.def.endLine) + 1;
      }
    }
  }
  for (const candidate of candidates) {
    const changed = new Set(candidate.changedLines);
    for (const [start, end] of candidate.file.newRanges) {
      const from = Math.max(start, candidate.def.startLine);
      const to = Math.min(end, candidate.def.endLine);
      for (let n = from; n <= to; n += 1) changed.add(n);
    }
    candidate.changedLines = [...changed].sort((a, b) => a - b);
  }
  for (const candidate of candidates) {
    const lines = await candidate.collector.lines(candidate.file.path);
    const body = lines ? lines.slice(candidate.def.startLine - 1, candidate.def.endLine).join("\n") : "";
    candidate.boundary = candidate.file.kind === "test" ? { score: 0, tags: [] } : boundarySignal(candidate.file.path, candidate.def.symbol, body);
  }
  const prunedCandidates = candidates.filter((candidate) => {
    if (candidate.file.status !== "added" || !["class", "module"].includes(candidate.def.kind)) return true;
    return !candidates.some((other) => other !== candidate
      && other.file.path === candidate.file.path
      && other.def.startLine > candidate.def.startLine
      && other.def.endLine < candidate.def.endLine);
  });
  prunedCandidates.sort((a, b) => a.priority - b.priority || b.boundary.score - a.boundary.score || a.file.path.localeCompare(b.file.path) || a.def.startLine - b.def.startLine);

  const testCounts = new Map<string, number>();
  const eligible: Candidate[] = [];
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of prunedCandidates) {
    if (candidate.file.kind !== "test") {
      eligible.push(candidate);
      continue;
    }
    const count = testCounts.get(candidate.file.path) ?? 0;
    testCounts.set(candidate.file.path, count + 1);
    if (count < MAX_TEST_ANCHORS_PER_FILE) eligible.push(candidate);
    else grouped.set(candidate.file.path, [...(grouped.get(candidate.file.path) ?? []), candidate]);
  }

  const testGroups: TestGroupRecord[] = [];
  let testGroupCounter = 0;
  for (const [path, overflow] of grouped) {
    const entries = [];
    for (const candidate of overflow) {
      const lines = await candidate.collector.lines(path);
      if (!lines) continue;
      entries.push({
        symbol: candidate.def.symbol,
        startLine: candidate.def.startLine,
        endLine: candidate.def.endLine,
        fingerprint: candidate.node.fingerprint,
        snippet: candidate.collector.snippet(lines, candidate.def, candidate.changedLines, new Set(candidate.changedLines)),
      });
    }
    if (entries.length) testGroups.push({ id: `t${++testGroupCounter}`, path, entries });
  }

  const chosen = eligible.slice(0, options.maxAnchors);
  const skippedAnchors = eligible.slice(options.maxAnchors).map((candidate) => `${candidate.file.path}:${candidate.def.startLine} ${candidate.def.symbol}`);
  const anchorIds = new Set(chosen.map((candidate) => candidate.node.id));
  for (const candidate of chosen) await candidate.collector.refocus(candidate.node, candidate.changedLines, new Set(candidate.changedLines));

  const oldFiles = new Map<string, string[] | undefined>();
  const oldLines = async (path: string): Promise<string[] | undefined> => {
    if (!base) return undefined;
    if (oldFiles.has(path)) return oldFiles.get(path);
    const content = await git(["show", `${base}:${path}`], cwd, signal).catch(() => undefined);
    const lines = content === undefined ? undefined : content.split("\n");
    oldFiles.set(path, lines);
    return lines;
  };
  const fileHunks: FileHunkRecord[] = [];
  let fileHunkCounter = 0;
  for (const file of files) {
    if ((file.kind !== "other" && file.kind !== "generated") || file.binary) continue;
    const old = file.status === "added" ? [] : await oldLines(file.oldPath ?? file.path) ?? [];
    let current: string[] = [];
    if (file.status !== "deleted") {
      const content = headContent.get(file.path) ?? await readFile(resolve(cwd, file.path), "utf8").catch(() => undefined);
      current = content?.split("\n") ?? [];
    }
    let remaining = 240;
    let omittedLines = 0;
    const hunks = [];
    for (const hunk of file.hunks) {
      const oldSlice = old.slice(hunk.oldStart - 1, hunk.oldStart - 1 + hunk.oldCount);
      const newSlice = current.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newCount);
      const combined = oldSlice.length + newSlice.length;
      const oldLines = oldSlice.slice(0, remaining);
      remaining -= oldLines.length;
      const newLines = newSlice.slice(0, remaining);
      remaining -= newLines.length;
      omittedLines += combined - oldLines.length - newLines.length;
      if (oldLines.length || newLines.length) hunks.push({ oldStart: hunk.oldStart, oldLines, newStart: hunk.newStart, newLines });
      if (remaining === 0) break;
    }
    if (hunks.length) fileHunks.push({ id: `f${++fileHunkCounter}`, path: file.path, kind: file.kind, status: file.status, hunks, omittedLines });
  }

  const removedFor = async (candidate: Candidate): Promise<AnchorRecord["removed"]> => {
    const removed: AnchorRecord["removed"] = [];
    let total = 0;
    for (const hunk of candidate.file.hunks) {
      if (hunk.oldCount === 0) continue;
      const newEnd = hunk.newStart + Math.max(hunk.newCount, 1) - 1;
      if (newEnd < candidate.def.startLine || hunk.newStart > candidate.def.endLine) continue;
      const lines = await oldLines(candidate.file.oldPath ?? candidate.file.path);
      if (!lines) continue;
      const slice = lines.slice(hunk.oldStart - 1, hunk.oldStart - 1 + hunk.oldCount);
      const kept = slice.slice(0, Math.max(0, 60 - total));
      total += kept.length;
      if (kept.length) removed.push({ oldStart: hunk.oldStart, lines: kept });
      if (total >= 60) break;
    }
    return removed;
  };

  // Expansion
  const queues = new Map<Collector, QueueItem[]>();
  for (const candidate of chosen) {
    const queue = queues.get(candidate.collector) ?? [];
    queue.push({ node: candidate.node, def: candidate.def, depth: 0, ancestry: [], focus: candidate.changedLines });
    queues.set(candidate.collector, queue);
  }
  await Promise.all([...queues].map(async ([collector, queue]) => {
    while (queue.length) {
      const item = queue.shift()!;
      if (budget.exhausted || signal?.aborted) {
        collector.frontier.push(`${item.node.id} ${item.node.symbol} not expanded (budget)`);
        continue;
      }
      await collector.expand(item.node, item.def, item.depth, item.ancestry, queue, signal, item.focus);
    }
  }));

  // Callers and tests, a few anchors at a time
  const lookups = await pool(chosen, SEARCH_CONCURRENCY, async (candidate) => {
    if (budget.exhausted || signal?.aborted) return { callers: [] as ReferenceHit[], tests: [] as ReferenceHit[] };
    const [callers, tests] = await Promise.all([
      candidate.collector.callers(candidate.node, candidate.def, signal, 6),
      candidate.collector.tests(candidate.node, candidate.def, signal, 8),
    ]);
    return { callers, tests };
  });

  const anchors: AnchorRecord[] = [];
  for (const [index, candidate] of chosen.entries()) {
    const { callers, tests } = lookups[index]!;
    const callerRecords = [];
    for (const hit of callers) {
      const boundary = hit.test ? { score: 0, tags: [] } : boundarySignal(hit.node.path, hit.node.symbol);
      callerRecords.push({ id: hit.node.id, symbol: hit.node.symbol, path: hit.node.path, line: hit.line, text: hit.text, test: hit.test, changed: anchorIds.has(hit.node.id), boundary: boundary.tags, score: boundary.score });
    }
    callerRecords.sort((a, b) => Number(b.changed) - Number(a.changed) || b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
    const testRecords = [];
    const seen = new Set<string>();
    for (const hit of [...tests, ...callers.filter((hit) => hit.test)]) {
      const key = `${hit.node.path}:${hit.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      testRecords.push({ id: hit.node.id, symbol: hit.node.symbol, path: hit.node.path, line: hit.line, text: hit.text });
    }
    anchors.push({
      id: candidate.node.id,
      symbol: candidate.node.symbol,
      kind: candidate.node.kind,
      path: candidate.node.path,
      startLine: candidate.node.startLine,
      endLine: candidate.node.endLine,
      fingerprint: candidate.node.fingerprint,
      changedLines: candidate.changedLines,
      removed: await removedFor(candidate),
      boundary: candidate.boundary,
      callers: callerRecords.filter((record) => !record.test).map(({ score: _score, ...record }) => record),
      tests: testRecords,
    });
  }

  // Dangling definitions: removed on the old side, callers still present on the new side
  const dangling: DanglingRecord[] = [];
  if (base) {
    for (const file of files) {
      if (!file.language || (file.kind !== "code" && file.kind !== "test") || !file.oldRanges.length) continue;
      if (budget.exhausted) break;
      const oldPath = file.oldPath ?? file.path;
      let oldLines: string[];
      try {
        oldLines = (await git(["show", `${base}:${oldPath}`], cwd, signal)).split("\n");
      } catch {
        continue;
      }
      const ranges = file.status === "deleted" ? [[1, oldLines.length] as [number, number]] : file.oldRanges;
      const removed = removedDefinitionNames(oldLines, ranges, file.language);
      if (!removed.length) continue;
      const found = await collectorFor(file.status === "deleted" ? (files.find((f) => f.kind === "code" && f.status !== "deleted")?.path ?? oldPath) : file.path).catch(() => undefined);
      if (!found) continue;
      for (const item of removed.slice(0, 12)) {
        if (found.collector.tooCommon(item.name)) continue;
        const stillDefined = await found.collector.definitionExists(item.name, file.language, signal);
        const callers = stillDefined ? [] : (await found.collector.references(item.name, file.language, { limit: 6 }, signal)).hits;
        dangling.push({
          name: item.name,
          oldPath,
          oldLine: item.line,
          language: file.language,
          stillDefined,
          callers: callers.map((hit) => ({ id: hit.node.id, symbol: hit.node.symbol, path: hit.node.path, line: hit.line, text: hit.text, test: hit.test })),
        });
      }
    }
  }

  const all = [...collectors.values()];
  const nodes = all.flatMap((collector) => collector.nodes).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const edges = all.flatMap((collector) => collector.edges);
  const coverage = {
    maxDepth: options.maxDepth,
    depthReached: Math.max(0, ...all.map((collector) => collector.depthReached)),
    vicinity: options.vicinity,
    unresolved: edges.filter((edge) => edge.resolution === "unresolved").length,
    truncatedBy: budget.truncatedBy,
    frontier: [...new Set(all.flatMap((collector) => collector.frontier))],
    cycles: [...new Set(all.flatMap((collector) => collector.cycles))],
    notes: [...new Set([...indexNotes.filter((note) => !note.startsWith("Scanning code changes")), ...(files.some((file) => file.language === "ruby") && !rubyReady ? ["Prism parser unavailable; Ruby definitions and calls came from the regex engine."] : []), ...all.flatMap((collector) => collector.notes)])],
    rgCalls: budget.rgCalls,
    elapsedMs: budget.elapsedMs,
  };

  const partial: Omit<ScanResult, "sections" | "packPath" | "jsonPath" | "metricsPath" | "inline"> = {
    label,
    head,
    base,
    checkoutHead,
    dirty,
    roots: [...collectors.keys()],
    files,
    fileHunks,
    anchors,
    testGroups,
    skippedAnchors,
    nodes,
    edges,
    dangling,
    coverage,
  };

  const sections = await renderSections(partial, all, anchorIds);
  const outputDir = isAbsolute(options.outputDir) ? options.outputDir : resolve(cwd, options.outputDir);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const packPath = join(outputDir, "pack.md");
  const jsonPath = join(outputDir, "pack.json");
  const { pack, inline, finalSections } = assemble(sections, packPath, options.inlineBudgetBytes, partial);
  await writeFile(packPath, pack, { encoding: "utf8", mode: 0o600 });
  const metricsPath = join(outputDir, "metrics.json");
  const result: ScanResult = { ...partial, sections: finalSections, packPath, jsonPath, metricsPath, inline };
  await writeFile(jsonPath, `${JSON.stringify({ ...result, inline: undefined }, null, 0)}\n`, { encoding: "utf8", mode: 0o600 });
  const byKind = (kind: FileKind) => files.filter((file) => file.kind === kind).length;
  await writeMetrics({
    kind: "sparsity_scan",
    at: new Date().toISOString(),
    cwd,
    label,
    head,
    elapsedMs: coverage.elapsedMs,
    rgCalls: coverage.rgCalls,
    truncatedBy: coverage.truncatedBy,
    files: { total: files.length, code: byKind("code"), test: byKind("test"), generated: byKind("generated"), other: byKind("other") },
    anchors: { expanded: anchors.length, skipped: skippedAnchors.length },
    nodes: nodes.length,
    edges: edges.length,
    ...edgeMetrics(nodes, edges),
    tokens: {
      inline: finalSections.filter((section) => section.inline).reduce((sum, section) => sum + section.tokens, 0),
      spilled: finalSections.filter((section) => !section.inline).reduce((sum, section) => sum + section.tokens, 0),
    },
    index: indexMetrics(rubyIndexes.values()),
    programs: tsPrograms?.summary() ?? [],
  }, metricsPath, options.metricsLog).catch(() => undefined);
  return result;
}

function edgeLine(edge: SparsityEdge, byId: Map<string, SparsityNode>): string {
  const target = edge.to ? byId.get(edge.to) : undefined;
  const destination = target ? `${edge.to} ${target.symbol} ${target.path}:${target.startLine}` : "?";
  const extras = [edge.note, edge.candidates ? `candidates: ${edge.candidates.slice(0, 4).join(", ")}${edge.candidates.length > 4 ? ", …" : ""}` : undefined].filter(Boolean).join("; ");
  const label = edge.via ? `${edge.resolution}, ${edge.via}` : edge.resolution;
  return `  - :${edge.line} \`${edge.name}\` → [${label}] ${destination}${extras ? `  (${extras})` : ""}`;
}

async function renderSections(result: Omit<ScanResult, "sections" | "packPath" | "jsonPath" | "metricsPath" | "inline">, collectors: Collector[], anchorIds: Set<string>): Promise<Array<Omit<Section, "startLine" | "endLine" | "inline">>> {
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  const collectorFor = (path: string) => collectors.find((collector) => collector.nodes.some((node) => node.path === path)) ?? collectors[0]!;
  const sections: Array<Omit<Section, "startLine" | "endLine" | "inline">> = [];
  const push = (id: string, body: string) => {
    const bytes = Buffer.byteLength(body, "utf8");
    sections.push({ id, body, bytes, tokens: estimateTokens(bytes) });
  };

  for (const file of result.fileHunks) {
    const out: string[] = [`${file.id} ${file.path} [${file.kind}, ${file.status}]`];
    for (const hunk of file.hunks) {
      if (hunk.oldLines.length) {
        const width = String(hunk.oldStart + hunk.oldLines.length).length;
        out.push(`old lines ${hunk.oldStart}-${hunk.oldStart + hunk.oldLines.length - 1}:`);
        hunk.oldLines.forEach((text, index) => out.push(`${String(hunk.oldStart + index).padStart(width)} -| ${text}`));
      }
      if (hunk.newLines.length) {
        const width = String(hunk.newStart + hunk.newLines.length).length;
        out.push(`new lines ${hunk.newStart}-${hunk.newStart + hunk.newLines.length - 1}:`);
        hunk.newLines.forEach((text, index) => out.push(`${String(hunk.newStart + index).padStart(width)} +| ${text}`));
      }
    }
    if (file.omittedLines) out.push(`… ${file.omittedLines} changed lines omitted after the 240-line file-hunk cap`);
    push(`file:${file.id}`, out.join("\n"));
  }

  for (const group of result.testGroups) {
    const out: string[] = [`${group.id} ${group.path}: ${group.entries.length} changed test definitions grouped after the first ${MAX_TEST_ANCHORS_PER_FILE} anchors.`];
    for (const entry of group.entries) {
      out.push("");
      out.push(`${entry.symbol} ${group.path}:${entry.startLine}-${entry.endLine} fp ${entry.fingerprint}`);
      out.push(entry.snippet);
    }
    push(`test-group:${group.id}`, out.join("\n"));
  }

  for (const anchor of result.anchors) {
    const node = byId.get(anchor.id)!;
    const out: string[] = [];
    out.push(`${anchor.id} ${anchor.symbol} [${anchor.kind}] ${anchor.path}:${anchor.startLine}-${anchor.endLine} fp ${anchor.fingerprint}`);
    out.push(`changed lines (+): ${compressRanges(anchor.changedLines)}`);
    out.push(node.snippet);
    for (const block of anchor.removed) {
      const width = String(block.oldStart + block.lines.length).length;
      out.push(`removed (old lines ${block.oldStart}-${block.oldStart + block.lines.length - 1}):`);
      block.lines.forEach((text, index) => out.push(`${String(block.oldStart + index).padStart(width)} -| ${text}`));
    }
    const outgoing = result.edges.filter((edge) => edge.from === anchor.id && edge.relationship !== "called_by");
    if (outgoing.length) {
      out.push(`calls (${outgoing.length}):`);
      for (const edge of outgoing) out.push(edgeLine(edge, byId));
    } else {
      out.push("calls: none found");
    }
    if (anchor.callers.length) {
      out.push(`callers (${anchor.callers.length}):`);
      for (const caller of anchor.callers) out.push(`  - ${caller.id} ${caller.symbol} ${caller.path}:${caller.line}${caller.changed ? " (changed in this diff)" : ""}${caller.boundary.length ? ` [${caller.boundary.join(", ")}]` : ""}  ${caller.text.slice(0, 100)}`);
    } else {
      out.push("callers: none found in root (or name too common)");
    }
    if (anchor.tests.length) {
      out.push(`tests (${anchor.tests.length}):`);
      for (const test of anchor.tests) out.push(`  - ${test.path}:${test.line} ${test.symbol}  ${test.text.slice(0, 100)}`);
    } else {
      out.push("tests: none reference this symbol by name");
    }
    push(`anchor:${anchor.id}`, out.join("\n"));
  }

  const depthOne = result.nodes.filter((node) => node.depth === 1 && !anchorIds.has(node.id) && result.edges.some((edge) => edge.to === node.id && edge.relationship !== "called_by"));
  if (depthOne.length) {
    const out: string[] = ["Definitions the changed code calls directly. Signature plus the first lines; full text in the source."];
    for (const node of depthOne) {
      const collector = collectorFor(node.path);
      out.push("");
      out.push(`${node.id} ${node.symbol} [${node.kind}] ${node.path}:${node.startLine}-${node.endLine} fp ${node.fingerprint}`);
      out.push(await collector.headLines(node, 12));
      const outgoing = result.edges.filter((edge) => edge.from === node.id && edge.relationship !== "called_by");
      if (outgoing.length) {
        out.push(`  calls (${outgoing.length}):`);
        for (const edge of outgoing) out.push(`  ${edgeLine(edge, byId)}`);
      }
    }
    push("depth1", out.join("\n"));
  }

  const deeper = result.nodes.filter((node) => node.depth >= 2 && !anchorIds.has(node.id));
  if (deeper.length) {
    const out: string[] = ["Definitions reached at depth 2 or more. Signature line only."];
    for (const node of deeper) {
      const collector = collectorFor(node.path);
      out.push(`${node.id} ${node.symbol} ${node.path}:${node.startLine}-${node.endLine} depth ${node.depth}  ${await collector.lineText(node.path, node.startLine)}`);
    }
    push("depth2", out.join("\n"));
  }

  if (result.dangling.length) {
    const out: string[] = ["Definitions removed on the old side of the diff."];
    for (const item of result.dangling) {
      out.push(`- ${item.name} removed from ${item.oldPath}:${item.oldLine}: ${item.stillDefined ? "another definition with this name still exists under the root" : item.callers.length ? `NO definition left, ${item.callers.length} caller(s) still reference it:` : "no definition left and no remaining callers found by name"}`);
      for (const caller of item.callers) out.push(`    - ${caller.id} ${caller.symbol} ${caller.path}:${caller.line}${caller.test ? " (test)" : ""}  ${caller.text.slice(0, 100)}`);
    }
    push("dangling", out.join("\n"));
  }

  const recap: string[] = [];
  const unresolved = result.edges.filter((edge) => edge.resolution === "unresolved");
  if (unresolved.length) {
    recap.push(`unresolved edges (${unresolved.length}):`);
    const grouped = new Map<string, SparsityEdge[]>();
    for (const edge of unresolved) grouped.set(edge.name, [...(grouped.get(edge.name) ?? []), edge]);
    for (const [name, group] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 40)) {
      const first = group[0]!;
      recap.push(`  - \`${name}\` ×${group.length} from ${first.from}:${first.line}${first.note ? `  (${first.note})` : ""}`);
    }
  }
  const external = result.edges.filter((edge) => edge.resolution === "external");
  if (external.length) recap.push(`external packages referenced: ${[...new Set(external.map((edge) => edge.note?.replace(/^from package /, "") ?? edge.name))].slice(0, 30).join(", ")}`);
  if (result.coverage.cycles.length) recap.push(`cycles: ${result.coverage.cycles.slice(0, 10).join("; ")}`);
  if (result.skippedAnchors.length) {
    recap.push(`changed definitions not expanded (anchor cap ${result.anchors.length}): ${result.skippedAnchors.length}`);
    for (const item of result.skippedAnchors.slice(0, 30)) recap.push(`  - ${item}`);
  }
  if (result.coverage.frontier.length) {
    recap.push(`frontier not expanded (${result.coverage.frontier.length}):`);
    for (const item of result.coverage.frontier.slice(0, 25)) recap.push(`  - ${item}`);
  }
  for (const note of result.coverage.notes) recap.push(`note: ${note}`);
  const untested = result.anchors.filter((anchor) => !anchor.tests.length && !["declaration", "statement", "constant", "class", "module"].includes(anchor.kind));
  if (untested.length) recap.push(`changed definitions with no test referencing them by name: ${untested.map((anchor) => `${anchor.id} ${anchor.symbol}`).join(", ")}`);
  push("recap", recap.length ? recap.join("\n") : "nothing unresolved; no frontier; no skipped anchors");

  return sections;
}

function manifestText(result: Omit<ScanResult, "sections" | "packPath" | "jsonPath" | "metricsPath" | "inline">, sections: Section[], packPath: string): string {
  const out: string[] = [];
  const byKind = (kind: FileKind) => result.files.filter((file) => file.kind === kind).length;
  out.push(`SPARSITY SCAN ${result.label}${result.dirty ? " [dirty worktree]" : ""}`);
  if (result.checkoutHead !== result.head) out.push(`revision: changed files, anchors, snippets and line numbers are from the range head ${result.head.slice(0, 12)}; the checkout is at ${result.checkoutHead.slice(0, 12)}, which callers, tests and unchanged files reflect. Do not re-read the changed files at the head; the pack already did.`);
  out.push(`roots: ${result.roots.join(", ") || "none"}  depth ${result.coverage.depthReached}/${result.coverage.maxDepth}  vicinity ±${result.coverage.vicinity}`);
  for (const note of result.coverage.notes.filter((item) => /^Ruby index for |^Prism parser unavailable|^TypeScript program for /.test(item))) out.push(`index: ${note}`);
  out.push(`files ${result.files.length} (code ${byKind("code")}, tests ${byKind("test")}, generated ${byKind("generated")}, other ${byKind("other")}); anchors ${result.anchors.length} expanded, ${result.skippedAnchors.length} skipped; nodes ${result.nodes.length}; edges ${result.edges.length}; unresolved ${result.coverage.unresolved}; dangling ${result.dangling.length}; rg calls ${result.coverage.rgCalls}; ${result.coverage.elapsedMs} ms; truncated: ${result.coverage.truncatedBy}`);
  out.push("");
  out.push("FILES");
  for (const file of result.files) {
    const anchorsHere = result.anchors.filter((anchor) => anchor.path === file.path).map((anchor) => anchor.id);
    const status = file.status[0]!.toUpperCase();
    const rename = file.oldPath && file.status === "renamed" ? ` (from ${file.oldPath})` : "";
    const hunk = result.fileHunks.find((item) => item.path === file.path);
    out.push(`  ${status} ${file.path}${rename}  [${file.kind}${file.language ? `, ${file.language}` : ""}] +${file.additions} -${file.deletions}${anchorsHere.length ? `  anchors: ${anchorsHere.join(", ")}` : ""}${hunk ? `  changed hunk: file:${hunk.id}` : ""}`);
  }
  out.push("");
  out.push("ANCHORS (changed definitions)");
  for (const anchor of result.anchors) out.push(`  ${anchor.id} ${anchor.symbol} ${anchor.path}:${anchor.startLine}-${anchor.endLine}  callers ${anchor.callers.length}  tests ${anchor.tests.length}${anchor.boundary.tags.length ? `  [${anchor.boundary.tags.join(", ")}]` : ""}`);
  out.push(`  ${RANKING_EXPLANATION}`);
  if (result.testGroups.length) {
    out.push("");
    out.push("GROUPED TESTS (read these file-level sections after the test anchors)");
    for (const group of result.testGroups) out.push(`  test-group:${group.id} ${group.path}: ${group.entries.length} definitions`);
  }
  out.push("");
  out.push("REVIEW INPUTS");
  out.push(`  production anchors: ${result.anchors.filter((anchor) => !isTestPath(anchor.path)).map((anchor) => anchor.id).join(", ") || "none"}`);
  out.push(`  test anchors: ${result.anchors.filter((anchor) => isTestPath(anchor.path)).map((anchor) => anchor.id).join(", ") || "none"}`);
  out.push(`  grouped tests: ${result.testGroups.map((group) => `test-group:${group.id}`).join(", ") || "none"}`);
  out.push(`  non-code changed hunks: ${result.fileHunks.map((file) => `file:${file.id}`).join(", ") || "none"}`);
  out.push(`  closed gaps: ${result.coverage.unresolved || result.coverage.frontier.length || result.skippedAnchors.length ? "read recap" : "none from static coverage; judge runtime/dynamic contracts in the zones"}`);
  out.push("");
  out.push(`SECTIONS (full pack: ${packPath})`);
  for (const section of sections) out.push(`  ${section.id.padEnd(14)} lines ${String(section.startLine).padStart(5)}-${String(section.endLine).padEnd(5)} ~${String(section.tokens).padStart(5)} tok  ${section.inline ? "inline" : "spilled"}`);
  out.push("");
  out.push(`${EDGE_LABELS} Read spilled sections from the pack file by line range.`);
  return out.join("\n");
}

function assemble(rendered: Array<Omit<Section, "startLine" | "endLine" | "inline">>, packPath: string, inlineBudgetBytes: number, result: Omit<ScanResult, "sections" | "packPath" | "jsonPath" | "metricsPath" | "inline">): { pack: string; inline: string; finalSections: Section[] } {
  const order = ["manifest", ...rendered.map((section) => section.id)];
  const bodies = new Map(rendered.map((section) => [section.id, section.body]));

  const layout = (manifestBody: string): Section[] => {
    const sections: Section[] = [];
    let line = 1;
    for (const id of order) {
      const body = id === "manifest" ? manifestBody : bodies.get(id)!;
      const lines = body.split("\n").length + 2;
      const bytes = Buffer.byteLength(body, "utf8");
      sections.push({ id, body, bytes, tokens: estimateTokens(bytes), inline: false, startLine: line, endLine: line + lines - 1 });
      line += lines + 1;
    }
    return sections;
  };

  const placeholder = layout("x".repeat(1));
  let manifestBody = manifestText(result, placeholder, packPath);
  let sections = layout(manifestBody);
  manifestBody = manifestText(result, sections, packPath);
  sections = layout(manifestBody);

  let used = 0;
  const inlineOrder = ["manifest", ...result.anchors.map((anchor) => `anchor:${anchor.id}`), ...result.fileHunks.map((file) => `file:${file.id}`), ...result.testGroups.map((group) => `test-group:${group.id}`), "dangling", "depth1", "recap", "depth2"];
  for (const id of inlineOrder) {
    const section = sections.find((item) => item.id === id);
    if (!section) continue;
    if (id === "manifest" || used + section.bytes <= inlineBudgetBytes) {
      section.inline = true;
      used += section.bytes;
    }
  }
  manifestBody = manifestText(result, sections, packPath);
  for (const section of sections) if (section.id === "manifest") section.body = manifestBody;

  const pack = sections.map((section) => `## ${section.id}\n\n${section.body}\n`).join("\n");
  const inlineParts: string[] = [];
  for (const id of inlineOrder) {
    const section = sections.find((item) => item.id === id);
    if (!section) continue;
    if (section.inline) inlineParts.push(`## ${section.id}\n\n${section.body}`);
    else inlineParts.push(`## ${section.id}\n\n[spilled: read ${packPath} lines ${section.startLine}-${section.endLine} (~${section.tokens} tokens)]`);
  }
  return { pack, inline: inlineParts.join("\n\n"), finalSections: sections };
}

export function packId(cwd: string, label: string, head: string): string {
  return createHash("sha256").update(`${cwd}\n${label}\n${head}\n${Date.now()}`).digest("hex").slice(0, 12);
}

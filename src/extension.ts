import { execFile, spawn } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateLine,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderCall, renderResult } from "./render.ts";
import {
  expandRelatedFiles,
  relatedReferencesForPath,
  type RelatedExpansionDetails,
} from "./related.ts";
import {
  camelToSnake,
  clampInt,
  displaySearchRoot,
  normalizeRepoRelativePath,
  stripAtPrefix,
  uniqueValues,
} from "./shared.ts";

const RG_TIMEOUT_MS = 30_000;
// Only rank this many distinct files before stopping rg early — the tool returns
// at most 10 files to the model, so scanning beyond this is wasted work.
const MAX_RANKED_FILES = 200;
const MAX_PACKAGE_SEARCH_ROOTS = 20;

const DEFAULT_EXCLUDES = [
  "!.git/**",
  "!**/.git/**",
  "!node_modules/**",
  "!**/node_modules/**",
  "!vendor/**",
  "!**/vendor/**",
  "!dist/**",
  "!**/dist/**",
  "!build/**",
  "!**/build/**",
  "!coverage/**",
  "!**/coverage/**",
  "!tmp/**",
  "!**/tmp/**",
  "!log/**",
  "!**/log/**",
  "!.next/**",
  "!**/.next/**",
  "!.turbo/**",
  "!**/.turbo/**",
  "!target/**",
  "!**/target/**",
  "!*.lock",
  "!**/*.lock",
  "!package-lock.json",
  "!**/package-lock.json",
  "!pnpm-lock.yaml",
  "!**/pnpm-lock.yaml",
  "!yarn.lock",
  "!**/yarn.lock",
];

const PACKAGE_SEARCH_EXCLUDES = [
  "!.git/**",
  "!**/.git/**",
  "!node_modules/**",
  "!**/node_modules/**",
  "!coverage/**",
  "!**/coverage/**",
  "!*.map",
  "!**/*.map",
  "!*.min.*",
  "!**/*.min.*",
  "!*.lock",
  "!**/*.lock",
  "!package-lock.json",
  "!pnpm-lock.yaml",
  "!yarn.lock",
];

const JS_TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]);

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".clj",
  ".cpp",
  ".cs",
  ".ex",
  ".exs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".lua",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".swift",
  ".ts",
  ".tsx",
  ".zig",
]);

const DEFINITION_PATTERNS = [
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+[A-Za-z_$][\w$]*/,
  /^\s*(export\s+)?(abstract\s+)?class\s+[A-Za-z_$][\w$]*/,
  /^\s*(export\s+)?interface\s+[A-Za-z_$][\w$]*/,
  /^\s*(export\s+)?type\s+[A-Za-z_$][\w$]*/,
  /^\s*(export\s+)?enum\s+[A-Za-z_$][\w$]*/,
  /^\s*(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
  /^\s*(def|class|module)\s+[A-Za-z_][\w!?=]*/,
  /^\s*(async\s+)?(def|class)\s+[A-Za-z_][\w]*/,
  /^\s*(pub\s+)?(async\s+)?(fn|struct|enum|trait|impl|mod|type|const)\s+[A-Za-z_][\w]*/,
  /^\s*(func|type|var|const)\s+[A-Za-z_][\w]*/,
  /^\s*func\s*\([^)]*\)\s*[A-Za-z_][\w]*/,
  /^\s*(public|private|protected)?\s*(static\s+)?(class|interface|enum|record)\s+[A-Za-z_][\w]*/,
];

const LOW_VALUE_PATH_PATTERN = /(^|\/)(node_modules|vendor|dist|build|coverage|tmp|log|\.git|\.next|\.turbo|target)(\/|$)/;
const TEST_PATH_PATTERN = /(^|\/)(__tests__|tests?|spec|fixtures?|mocks?|stories)(\/|$)|\.(test|spec|stories)\.[^.]+$/;
const GENERATED_PATH_PATTERN = /(generated|schema\.json|\.min\.|bundle\.|compiled)/i;

export interface CodeMatch {
  path: string;
  lineNumber: number;
  line: string;
  submatches: Array<{ text: string; start: number; end: number }>;
  isDefinition: boolean;
}

export interface RankedFileResult {
  path: string;
  score: number;
  confidence?: number;
  reasons: string[];
  matchCount: number;
  matches: CodeMatch[];
}

export interface PathMatch {
  path: string;
  score: number;
  reasons: string[];
}

interface SearchTopMatch {
  lineNumber: number;
  marker: "def" | "ref" | "scope";
  text: string;
}

interface SearchFileDetails extends Pick<RankedFileResult, "path" | "score" | "matchCount" | "reasons"> {
  topMatch?: SearchTopMatch;
  confidence?: number;
}

interface SearchCoverageDetails {
  roots: string[];
  ownerRoot?: string;
  packageRoots: string[];
  omittedPackageRoots: number;
}

interface SearchDetails {
  query: string;
  context?: string;
  totalMatches: number;
  totalFiles: number;
  returnedFiles: number;
  files: SearchFileDetails[];
  coverage: SearchCoverageDetails;
  related?: RelatedExpansionDetails;
  truncation?: TruncationResult;
  fullOutputPath?: string;
  literalFallback?: boolean;
  regexError?: string;
}

function isRegexParseError(error: unknown): boolean {
  return error instanceof Error && /regex parse error|repetition quantifier|unclosed|invalid escape/i.test(error.message);
}

function isValidRegex(query: string): boolean {
  try {
    new RegExp(query);
    return true;
  } catch {
    return false;
  }
}

function isDefinitionLine(line: string): boolean {
  return DEFINITION_PATTERNS.some((pattern) => pattern.test(line));
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function queryTokens(query: string): string[] {
  return Array.from(new Set(
    [query, camelToSnake(query)]
      .flatMap((value) => value.toLowerCase().split(/[^a-z0-9_]+/))
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  ));
}

function scorePath(path: string, query: string): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const normalized = normalizeRepoRelativePath(path);
  const lower = normalized.toLowerCase();
  const ext = extname(lower);
  const file = (path.split("/").pop() ?? "").replace(ext, "").toLowerCase();
  const depth = pathDepth(normalized);

  if (SOURCE_EXTENSIONS.has(ext)) {
    score += 15;
    reasons.push("source file");
  }

  if (/^(src|app|lib|packages|pkg|cmd|internal|core)\//.test(lower) || /\/(src|app|lib|packages|pkg|cmd|internal|core)\//.test(lower)) {
    score += 8;
    reasons.push("implementation path");
  }

  if (depth <= 3) {
    score += 5;
    reasons.push("shallow path");
  }

  const tokens = queryTokens(query);
  for (const token of tokens) {
    if (file.includes(token)) {
      score += 12;
      reasons.push(`filename matches "${token}"`);
      break;
    }
  }

  if (TEST_PATH_PATTERN.test(lower)) {
    score -= 30;
    reasons.push("test/support path");
  }

  if (LOW_VALUE_PATH_PATTERN.test(lower)) {
    score -= 60;
    reasons.push("low-value path");
  }

  if (GENERATED_PATH_PATTERN.test(lower)) {
    score -= 25;
    reasons.push("generated/bundled path");
  }

  return { score, reasons };
}

function scoreMatches(matches: CodeMatch[]): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const definitionCount = matches.filter((match) => match.isDefinition).length;

  if (matches.length > 0) {
    score += 1000;
    reasons.push("content match");
  }

  if (definitionCount > 0) {
    score += 35 + Math.min(30, definitionCount * 5);
    reasons.push(`${definitionCount} definition-like match${definitionCount === 1 ? "" : "es"}`);
  }

  score += Math.min(20, matches.length * 2);
  if (matches.length > 1) reasons.push(`${matches.length} matches`);

  return { score, reasons };
}

const PATH_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "call",
  "calls",
  "class",
  "classes",
  "def",
  "file",
  "files",
  "find",
  "for",
  "in",
  "locate",
  "method",
  "methods",
  "on",
  "scope",
  "scopes",
  "site",
  "sites",
  "the",
  "to",
]);

function scorePathQueryMatch(path: string, query: string): { score: number; reasons: string[] } | undefined {
  const normalizedPath = normalizeRepoRelativePath(path).toLowerCase();
  const filename = path.split("/").pop() ?? "";
  const filenameWithoutExtension = filename.replace(/\.[^.]+$/, "");
  const normalizedQuery = query.trim().toLowerCase();
  const snakeQuery = camelToSnake(query.trim());
  const queryVariants = Array.from(new Set([normalizedQuery, snakeQuery].filter((value) => value.length >= 3)));
  const importantTokens = queryTokens(query).filter((token) => !PATH_QUERY_STOPWORDS.has(token));

  let score = 0;
  const reasons: string[] = [];

  for (const variant of queryVariants) {
    if (filename === variant || filenameWithoutExtension === variant) {
      score += 80;
      reasons.push(`exact filename match "${variant}"`);
      break;
    }

    if (filename.includes(variant)) {
      score += 60;
      reasons.push(`filename contains "${variant}"`);
      break;
    }

    if (normalizedPath.includes(variant)) {
      score += 45;
      reasons.push(`path contains "${variant}"`);
      break;
    }
  }

  if (importantTokens.length > 0 && importantTokens.every((token) => normalizedPath.split("/").some((segment) => segment.includes(token)))) {
    score += Math.min(50, 20 + importantTokens.length * 5);
    reasons.push(`path matches query tokens: ${importantTokens.join(", ")}`);
  }

  if (score === 0) return undefined;

  return { score, reasons };
}

const CONTEXT_STOPWORDS = new Set([
  ...PATH_QUERY_STOPWORDS,
  "about",
  "above",
  "across",
  "around",
  "between",
  "by",
  "context",
  "domain",
  "from",
  "into",
  "named",
  "near",
  "of",
  "or",
  "related",
  "same",
  "search",
  "use",
  "using",
  "with",
]);

function contextTokens(context: string | undefined): string[] {
  const trimmed = context?.trim();
  if (!trimmed) return [];
  return uniqueValues(
    [trimmed, camelToSnake(trimmed)]
      .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/))
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !CONTEXT_STOPWORDS.has(token)),
  );
}

function scoreContext(path: string, matches: CodeMatch[], context: string | undefined): { score: number; reasons: string[] } {
  const tokens = contextTokens(context);
  if (tokens.length === 0) return { score: 0, reasons: [] };

  const normalizedPath = normalizeRepoRelativePath(path).toLowerCase();
  const lowerLines = matches.map((match) => match.line.toLowerCase());
  const pathTokens = tokens.filter((token) => normalizedPath.includes(token));
  const snippetTokens = tokens.filter((token) => lowerLines.some((line) => line.includes(token)));

  let score = 0;
  const reasons: string[] = [];

  if (snippetTokens.length > 0) {
    score += Math.min(135, snippetTokens.length * 45);
    reasons.push(`context tokens matched snippets: ${snippetTokens.join(", ")}`);
  }

  if (pathTokens.length > 0) {
    score += Math.min(75, pathTokens.length * 25);
    reasons.push(`context tokens matched path: ${pathTokens.join(", ")}`);
  }

  if (snippetTokens.length > 0 && pathTokens.length > 0) score += 15;

  return { score, reasons };
}

export function parseRipgrepJsonLines(output: string): CodeMatch[] {
  const matches: CodeMatch[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;

    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event?.type !== "match") continue;

    const data = event.data;
    const path = data?.path?.text;
    const lineText = data?.lines?.text;
    const lineNumber = data?.line_number;

    if (typeof path !== "string" || typeof lineText !== "string" || typeof lineNumber !== "number") {
      continue;
    }

    matches.push({
      path: normalizeRepoRelativePath(path),
      lineNumber,
      line: lineText.replace(/\r?\n$/, ""),
      submatches: Array.isArray(data.submatches)
        ? data.submatches.map((submatch: any) => ({
            text: String(submatch?.match?.text ?? ""),
            start: Number(submatch?.start ?? 0),
            end: Number(submatch?.end ?? 0),
          }))
        : [],
      isDefinition: isDefinitionLine(lineText),
    });
  }

  return matches;
}

export function rankFileGroups(
  matches: CodeMatch[],
  query: string,
  maxMatchesPerFile: number,
  pathMatches: PathMatch[] = [],
  context?: string,
): RankedFileResult[] {
  const grouped = new Map<string, CodeMatch[]>();
  for (const match of matches) {
    const existing = grouped.get(match.path) ?? [];
    existing.push(match);
    grouped.set(match.path, existing);
  }

  const pathMatchByPath = new Map(pathMatches.map((match) => [match.path, match]));
  const allPaths = new Set([...grouped.keys(), ...pathMatchByPath.keys()]);

  const ranked: RankedFileResult[] = [];
  for (const path of allPaths) {
    const fileMatches = grouped.get(path) ?? [];
    const pathQueryMatch = pathMatchByPath.get(path);
    const sortedMatches = [...fileMatches].sort((a, b) => {
      if (a.isDefinition !== b.isDefinition) return a.isDefinition ? -1 : 1;
      return a.lineNumber - b.lineNumber;
    });

    const pathScore = scorePath(path, query);
    const matchScore = scoreMatches(fileMatches);
    const contextScore = scoreContext(path, fileMatches, context);
    const pathQueryScore = pathQueryMatch?.score ?? 0;
    const pathQueryReasons = pathQueryMatch?.reasons ?? [];

    ranked.push({
      path,
      score: pathScore.score + matchScore.score + contextScore.score + pathQueryScore,
      reasons: [...contextScore.reasons, ...pathQueryReasons, ...matchScore.reasons, ...pathScore.reasons],
      matchCount: fileMatches.length > 0 ? fileMatches.length : (pathQueryMatch ? 1 : 0),
      matches: sortedMatches.slice(0, maxMatchesPerFile),
    });
  }

  return ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    return a.path.localeCompare(b.path);
  });
}

function withConfidence(ranked: RankedFileResult[]): RankedFileResult[] {
  if (ranked.length === 0) return ranked;

  const weights = ranked.map((file) => Math.max(0, file.score));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    const confidence = 1 / ranked.length;
    return ranked.map((file) => ({ ...file, confidence }));
  }

  return ranked.map((file, index) => ({ ...file, confidence: weights[index]! / total }));
}

function prioritizeRelatedResults(ranked: RankedFileResult[], related?: RelatedExpansionDetails, primaryPath?: string): RankedFileResult[] {
  if (!related || ranked.length === 0) return ranked;

  const targetPath = primaryPath ?? ranked[0]!.path;

  return ranked
    .map((file) => {
      const references = relatedReferencesForPath(related, file.path);
      if (file.path === targetPath) {
        return {
          ...file,
          score: Math.round(file.score * 2),
          reasons: ["primary target", ...file.reasons],
        };
      }

      if (references.length > 0) {
        const labels = references.map((item) => `${item.name} ${item.relationship} ${item.from}; ${item.note}`).join(", ");
        return {
          ...file,
          score: Math.round(file.score * 1.5),
          reasons: [`${related.label} target: ${labels}`, ...file.reasons],
        };
      }

      return file;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      return a.path.localeCompare(b.path);
    });
}

function matchMarker(match: CodeMatch): SearchTopMatch["marker"] {
  if (/^\s*scope\s+:/.test(match.line)) return "scope";
  return match.isDefinition ? "def" : "ref";
}

function formatTopMatch(match: CodeMatch): SearchTopMatch {
  return {
    lineNumber: match.lineNumber,
    marker: matchMarker(match),
    text: truncateLine(match.line.trim(), 180).text,
  };
}

export function formatSearchResults(
  query: string,
  ranked: RankedFileResult[],
  totalMatches: number,
  notes: string[] = [],
  targetInstruction = "Read this file first; use other ranked candidates if it lacks the requested context.",
  related?: RelatedExpansionDetails,
): string {
  if (ranked.length === 0) {
    return [
      `No code matches found for ${JSON.stringify(query)}.`,
      ...(notes.length > 0 ? [notes.join("\n")] : []),
      "Path hints are coverage, not code matches.",
      "Search complete for the reported one-call coverage. Do not repeat discovery with grep, find, or shell search.",
    ].join("\n\n");
  }

  const confidenceSum = ranked.reduce((sum, file) => sum + (file.confidence ?? 0), 0);
  const confidenceText = ranked.some((file) => typeof file.confidence === "number") ? `, confidence sum ${confidenceSum.toFixed(3)}` : "";
  const lines = [
    `agentic_search: ${JSON.stringify(query)} — ${ranked.length} ranked file${ranked.length === 1 ? "" : "s"} from ${totalMatches} match${totalMatches === 1 ? "" : "es"}${confidenceText}`,
    `TARGET FILE: ${ranked[0]?.path}. ${targetInstruction}`,
    "",
  ];

  const primaryPath = ranked[0]?.path;

  let topLevelIndex = 0;
  let mixinChildIndex = 0;
  for (const file of ranked) {
    const relatedReferences = relatedReferencesForPath(related, file.path);
    const isPrimaryRelatedChild = file.path !== primaryPath && relatedReferences.some((item) => item.from === primaryPath);
    const displayIndex = isPrimaryRelatedChild ? `1.${++mixinChildIndex}` : String(++topLevelIndex);
    const prefix = isPrimaryRelatedChild ? `   ↳ ${displayIndex}.` : `${displayIndex}.`;
    const relationshipText = isPrimaryRelatedChild
      ? ` — ${relatedReferences.map((item) => `${item.relationship} ${primaryPath} via ${item.name}; ${item.note}`).join(", ")}`
      : "";
    const reasonText = file.reasons.length > 0 ? ` — ${file.reasons.slice(0, 4).join(", ")}` : "";
    const candidateConfidence = typeof file.confidence === "number" ? `, confidence ${file.confidence.toFixed(3)}` : "";
    lines.push(`${prefix} ${file.path} (score ${file.score}${candidateConfidence}, ${file.matchCount} match${file.matchCount === 1 ? "" : "es"})${relationshipText || reasonText}`);

    if (file.matches.length === 0) {
      lines.push(`${isPrimaryRelatedChild ? "      " : "   "}[path] filename/path match`);
    }

    for (const match of file.matches) {
      const topMatch = formatTopMatch(match);
      lines.push(`${isPrimaryRelatedChild ? "      " : "   "}L${topMatch.lineNumber} [${topMatch.marker}] ${topMatch.text}`);
    }

    if (file.matches.length > 0 && file.matchCount > file.matches.length) {
      lines.push(`${isPrimaryRelatedChild ? "      " : "   "}… ${file.matchCount - file.matches.length} more match${file.matchCount - file.matches.length === 1 ? "" : "es"} in this file`);
    }

    lines.push("");
  }

  if (notes.length > 0) {
    lines.push(...notes, "");
  }

  lines.push("Next step: read the TARGET FILE first. Discovery is complete for the reported one-call coverage; do not repeat it with grep, find, or shell search.");
  return lines.join("\n").trimEnd();
}

async function writeFullOutputIfTruncated(output: string, prefix: string, details: { truncation?: TruncationResult; fullOutputPath?: string }): Promise<string> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) return truncation.content;

  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  const fullOutputPath = join(tempDir, "output.txt");
  await writeFile(fullOutputPath, output, "utf8");

  details.truncation = truncation;
  details.fullOutputPath = fullOutputPath;

  return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
}

function runRgStreaming(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  maxFiles = MAX_RANKED_FILES,
  mapPath: (path: string) => string = normalizeRepoRelativePath,
): Promise<CodeMatch[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("rg", args, { cwd, signal });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`rg timed out after ${RG_TIMEOUT_MS} ms`));
    }, RG_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        rejectPromise(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        child.kill("SIGKILL");
        rejectPromise(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }

    if (!child.stdout) {
      clearTimeout(timer);
      rejectPromise(new Error("rg stdout unavailable"));
      return;
    }

    const matches: CodeMatch[] = [];
    const filesSeen = new Set<string>();
    let stderrText = "";
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(matches);
    };

    child.stderr?.on("data", (chunk) => { stderrText += String(chunk); });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim() || settled) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.type !== "match") return;

      const data = event.data;
      const path = data?.path?.text;
      const lineText = data?.lines?.text;
      const lineNumber = data?.line_number;
      if (typeof path !== "string" || typeof lineText !== "string" || typeof lineNumber !== "number") return;

      const normalized = mapPath(path);
      matches.push({
        path: normalized,
        lineNumber,
        line: lineText.replace(/\r?\n$/, ""),
        submatches: Array.isArray(data.submatches)
          ? data.submatches.map((submatch: any) => ({
              text: String(submatch?.match?.text ?? ""),
              start: Number(submatch?.start ?? 0),
              end: Number(submatch?.end ?? 0),
            }))
          : [],
        isDefinition: isDefinitionLine(lineText),
      });

      filesSeen.add(normalized);
      if (filesSeen.size >= maxFiles) {
        child.kill("SIGTERM");
        finish();
      }
    });

    let exitCode: number | null = null;
    let processClosed = false;
    let rlClosed = false;

    const maybeSettle = () => {
      if (settled || !processClosed || !rlClosed) return;
      if (exitCode === 0 || exitCode === 1 || exitCode === null || exitCode === 143) finish();
      else finish(new Error(`rg failed (exit ${exitCode}): ${stderrText.trim()}`));
    };

    rl.on("close", () => { rlClosed = true; maybeSettle(); });
    child.on("error", (error) => finish(new Error(`rg failed: ${error.message}`)));
    child.on("close", (code) => { exitCode = code; processClosed = true; maybeSettle(); });
  });
}

async function listPathMatches(params: {
  cwd: string;
  query: string;
  searchRoot: string;
  signal?: AbortSignal;
}): Promise<PathMatch[]> {
  const explicitAbsoluteRoot = isAbsolute(stripAtPrefix(params.searchRoot));
  const resolvedRoot = resolveCandidatePath(params.cwd, params.searchRoot);
  const rootStats = explicitAbsoluteRoot ? await stat(resolvedRoot) : undefined;
  const searchCwd = rootStats?.isDirectory() ? resolvedRoot : explicitAbsoluteRoot ? dirname(resolvedRoot) : params.cwd;
  const localRoot = rootStats?.isDirectory() ? "." : explicitAbsoluteRoot ? basename(resolvedRoot) : params.searchRoot;
  const args = ["--files", "--hidden", "--color=never"];
  addRgExcludes(args);
  args.push("--", localRoot);

  const output = await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile("rg", args, { cwd: searchCwd, encoding: "utf8", maxBuffer: 30 * 1024 * 1024, signal: params.signal, timeout: RG_TIMEOUT_MS }, (error, stdout) => {
      if (error && (error as any).code !== 1) rejectPromise(new Error(`rg --files failed: ${(error as any).stderr ?? error.message}`));
      else resolvePromise(String(stdout ?? ""));
    });
  });

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => explicitAbsoluteRoot
      ? displaySearchRoot(params.cwd, resolve(searchCwd, stripAtPrefix(path)))
      : normalizeRepoRelativePath(path))
    .flatMap((path) => {
      const match = scorePathQueryMatch(path, params.query);
      return match ? [{ path, ...match }] : [];
    });
}

function resolveCandidatePath(cwd: string, candidate: string): string {
  const stripped = stripAtPrefix(candidate);
  return isAbsolute(stripped) ? resolve(stripped) : resolve(cwd, stripped);
}

async function existingSearchRoot(cwd: string, candidate: string): Promise<{ root: string; isDirectory: boolean } | undefined> {
  try {
    const stripped = stripAtPrefix(candidate);
    const resolved = resolveCandidatePath(cwd, candidate);
    const stats = await stat(resolved);
    return {
      root: isAbsolute(stripped) ? resolved : displaySearchRoot(cwd, resolved),
      isDirectory: stats.isDirectory(),
    };
  } catch {
    return undefined;
  }
}

async function resolveSearchScope(params: {
  cwd: string;
  query: string;
  path?: string;
  maxFiles: number;
  signal?: AbortSignal;
}): Promise<{ searchRoots: string[]; pathMatches: PathMatch[]; fastPath: boolean }> {
  const pathQuery = params.path?.trim();

  if (!pathQuery) {
    return {
      searchRoots: ["."],
      pathMatches: await listPathMatches({ cwd: params.cwd, query: params.query, searchRoot: ".", signal: params.signal }),
      fastPath: false,
    };
  }

  const existing = await existingSearchRoot(params.cwd, pathQuery);
  if (existing) {
    return {
      searchRoots: [existing.root],
      pathMatches: existing.isDirectory
        ? []
        : await listPathMatches({ cwd: params.cwd, query: pathQuery, searchRoot: existing.root, signal: params.signal }),
      fastPath: !existing.isDirectory,
    };
  }

  const pathMatches = await listPathMatches({ cwd: params.cwd, query: pathQuery, searchRoot: ".", signal: params.signal });
  const rankedPathMatches = [...pathMatches].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const depthDifference = pathDepth(a.path) - pathDepth(b.path);
    if (depthDifference !== 0) return depthDifference;
    return a.path.localeCompare(b.path);
  });
  const searchRoots = rankedPathMatches.slice(0, Math.max(params.maxFiles, 1)).map((match) => match.path);

  return {
    searchRoots: searchRoots.length > 0 ? searchRoots : ["."],
    pathMatches,
    fastPath: false,
  };
}

function addRgExcludes(args: string[]): void {
  for (const glob of DEFAULT_EXCLUDES) args.push("--glob", glob);
}

function addPackageSearchExcludes(args: string[]): void {
  for (const glob of PACKAGE_SEARCH_EXCLUDES) args.push("--glob", glob);
}

function deduplicateMatches(matches: CodeMatch[]): CodeMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.path}\u0000${match.lineNumber}\u0000${match.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function findOwningSearchRoot(cwd: string, searchRoot: string): Promise<string | undefined> {
  const resolved = resolveCandidatePath(cwd, searchRoot);
  const stats = await stat(resolved).catch(() => undefined);
  if (!stats) return undefined;

  let current = stats.isDirectory() ? resolved : dirname(resolved);
  while (true) {
    const [manifest, gitBoundary] = await Promise.all([
      stat(join(current, "package.json")).catch(() => undefined),
      stat(join(current, ".git")).catch(() => undefined),
    ]);
    if (manifest?.isFile() || gitBoundary) {
      return isAbsolute(searchRoot) ? current : displaySearchRoot(cwd, current);
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function searchPackageRoot(params: {
  cwd: string;
  root: string;
  query: string;
  literal: boolean;
  caseSensitive?: boolean;
  signal?: AbortSignal;
}): Promise<CodeMatch[]> {
  const resolvedRoot = resolveCandidatePath(params.cwd, params.root);
  const stats = await stat(resolvedRoot).catch(() => undefined);
  if (!stats?.isDirectory()) return [];

  const args = ["--json", "--line-number", "--color=never", "--hidden", "--no-ignore"];
  addPackageSearchExcludes(args);
  if (params.literal) args.push("--fixed-strings");
  if (!params.caseSensitive) args.push("--smart-case");
  args.push("-e", params.query, "--", ".");

  return runRgStreaming(
    args,
    resolvedRoot,
    params.signal,
    MAX_RANKED_FILES,
    (path) => displaySearchRoot(params.cwd, resolve(resolvedRoot, stripAtPrefix(path))),
  );
}

function oneCallCoverageNotes(coverage: SearchCoverageDetails): string[] {
  const parts = [`${coverage.roots.length} target/relative root${coverage.roots.length === 1 ? "" : "s"}`];
  if (coverage.ownerRoot) parts.push(`owning package ${coverage.ownerRoot}`);
  if (coverage.packageRoots.length > 0) {
    parts.push(`${coverage.packageRoots.length} imported package${coverage.packageRoots.length === 1 ? "" : "s"}`);
  }
  if (coverage.omittedPackageRoots > 0) {
    parts.push(`${coverage.omittedPackageRoots} imported package${coverage.omittedPackageRoots === 1 ? "" : "s"} omitted by the safety cap`);
  }

  const notes = [`One-call coverage: ${parts.join("; ")}.`];
  if (coverage.packageRoots.length > 0) {
    notes.push(`Imported packages searched: ${coverage.packageRoots.join(", ")}.`);
  }
  return notes;
}

const SearchParams = Type.Object({
  query: Type.String({ description: "Precise code syntax regex or literal string to search for. Prefer construct syntax over the whole user prompt; for Rails scopes use scope\\s+:" }),
  context: Type.Optional(Type.String({ description: "Optional natural-language disambiguation hint used only for ranking, not as the ripgrep query. Example: actual goal progress" })),
  path: Type.Optional(Type.String({ description: "Optional exact path, filename, partial path, or absolute file/directory root. Example: event_occurrence.rb" })),
  max_files: Type.Optional(Type.Number({ description: "Maximum ranked candidate files to return, default 5, max 10" })),
  max_matches_per_file: Type.Optional(Type.Number({ description: "Maximum snippet matches per file, default 10 for construct queries, max 10" })),
  expand_related: Type.Optional(Type.Boolean({ description: "Complete related discovery in one call: Ruby/Rails mixins; JS/TS relative imports, owning package, and resolvable imported package surfaces" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat query as a literal string instead of a regex" })),
  case_sensitive: Type.Optional(Type.Boolean({ description: "Use case-sensitive matching. Default false uses smart-case." })),
});

export default function agenticSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "agentic_search",
    label: "Agentic Search",
    description: `Preferred ranked search for locating files, classes, scopes, methods, and call sites across a repository. Uses ripgrep, then ranks and groups results for coding-agent workflows. Optional context disambiguates ranking without changing the ripgrep query. Set expand_related true to make one call cover Ruby/Rails mixins or the JS/TS target, relative imports, owning package, and resolvable imported package surfaces before returning a result or decisive miss. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Preferred one-call ranked search for locating files, classes, scopes, methods, and call sites. Make one focused search from the user's named construct and optional path hint. Use context for natural-language disambiguation. For Rails concerns/mixins or JS/TS module and utility discovery, pass expand_related: true so the same call searches the relevant owning and imported-package surfaces. Read the ranked target; do not repeat discovery with another search tool.",
    promptGuidelines: [
      "Prefer agentic_search over grep for locating files, classes, scopes, methods, and call sites because ranked results identify the best file to read first.",
      "When a user names both a code construct and a file, make exactly one focused agentic_search call with query for the construct syntax and path for the filename or partial path hint.",
      "When the same construct name appears in multiple domains, keep query as the exact code syntax or literal and pass context as a natural-language ranking hint; for example query remaining_value with context actual goal progress.",
      "For Rails scope requests like predicates for scopes on event_occurrence.rb, call agentic_search once with query scope\\s+: and path event_occurrence.rb, then read the target file first before broader discovery.",
      "For Rails model questions about scopes available on a model, model behavior, callbacks, associations, included concerns, or mixins, set expand_related true; examples: 'how many scopes does User have?', 'include concerns', 'from mixins', 'available on User'.",
      "For JS/TS questions where imported files, re-export barrels, hooks, components, helpers, sibling modules, or dependency utilities may contain the requested behavior, set expand_related true. One agentic_search call then covers relative imports, the owning package, and resolvable imported packages.",
      "If agentic_search returns a target file containing the requested construct matches, read that target first before alternate candidates, sibling models, tests, migrations, git status, or shell searches.",
      "Use other ranked candidates from the same agentic_search result when the first target is ambiguous or lacks context.",
      "When agentic_search reports its one-call coverage or a decisive miss, discovery is complete for those scopes. Do not repeat discovery with grep, find, or shell search.",
    ],
    parameters: SearchParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const maxFiles = clampInt(params.max_files, 5, 1, 10);
      const maxMatchesPerFile = clampInt(params.max_matches_per_file, 10, 1, 10);
      const context = typeof params.context === "string" && params.context.trim() ? params.context.trim() : undefined;

      const scope = await resolveSearchScope({
        cwd: ctx.cwd,
        query: params.query,
        path: params.path,
        maxFiles,
        signal,
      });

      const related = params.expand_related
        ? await expandRelatedFiles(ctx.cwd, scope.searchRoots)
        : undefined;
      const searchRoots = uniqueValues([...scope.searchRoots, ...(related?.roots ?? [])]);
      const expandNote =
        params.expand_related && (!related || (related.roots.length === 0 && related.packageRoots.length === 0))
          ? "expand_related: no resolvable mixins/imports from the search root(s); owning-package coverage is still included on a scoped miss."
          : undefined;

      let useLiteral = params.literal ?? false;
      let literalFallback = false;
      let regexError: string | undefined;
      if (!useLiteral && !isValidRegex(params.query)) {
        useLiteral = true;
        literalFallback = true;
        regexError = "Invalid regex; retried as literal string.";
      }

      const buildArgs = (literal: boolean, roots: string[]) => {
        const args = ["--json", "--line-number", "--color=never", "--hidden"];
        addRgExcludes(args);
        if (literal) args.push("--fixed-strings");
        if (!params.case_sensitive) args.push("--smart-case");
        args.push("-e", params.query, "--", ...roots);
        return args;
      };

      const runSearchRoots = async (literal: boolean, roots: string[]) => {
        const matches: CodeMatch[] = [];
        const relativeRoots = roots.filter((root) => !isAbsolute(root));
        if (relativeRoots.length > 0) {
          matches.push(...await runRgStreaming(buildArgs(literal, relativeRoots), ctx.cwd, signal));
        }

        for (const root of roots.filter(isAbsolute)) {
          const rootStats = await stat(root);
          const searchCwd = rootStats.isDirectory() ? root : dirname(root);
          const localRoot = rootStats.isDirectory() ? "." : basename(root);
          matches.push(...await runRgStreaming(
            buildArgs(literal, [localRoot]),
            searchCwd,
            signal,
            MAX_RANKED_FILES,
            (path) => displaySearchRoot(ctx.cwd, resolve(searchCwd, stripAtPrefix(path))),
          ));
        }

        return matches;
      };

      let matches: CodeMatch[];
      try {
        matches = await runSearchRoots(useLiteral, searchRoots);
      } catch (error) {
        if (useLiteral || !isRegexParseError(error)) throw error;
        useLiteral = true;
        literalFallback = true;
        regexError = error instanceof Error ? error.message : String(error);
        matches = await runSearchRoots(true, searchRoots);
      }

      const primaryRoot = scope.searchRoots[0] ?? ".";
      const primaryExtension = extname(primaryRoot).toLowerCase();
      const needsOneCallExpansion = Boolean(
        params.expand_related
        && (matches.length === 0 || (JS_TS_EXTENSIONS.has(primaryExtension) && !matches.some((match) => match.isDefinition))),
      );
      const ownerRoot = needsOneCallExpansion
        ? await findOwningSearchRoot(ctx.cwd, primaryRoot)
        : undefined;
      if (ownerRoot && !searchRoots.includes(ownerRoot)) {
        matches.push(...await runSearchRoots(useLiteral, [ownerRoot]));
      }

      const availablePackageRoots = needsOneCallExpansion ? (related?.packageRoots ?? []) : [];
      const selectedPackageRoots = availablePackageRoots.slice(0, MAX_PACKAGE_SEARCH_ROOTS);
      for (const packageRoot of selectedPackageRoots) {
        matches.push(...await searchPackageRoot({
          cwd: ctx.cwd,
          root: packageRoot.path,
          query: params.query,
          literal: useLiteral,
          caseSensitive: params.case_sensitive,
          signal,
        }));
      }
      matches = deduplicateMatches(matches);

      const coverage: SearchCoverageDetails = {
        roots: searchRoots,
        ownerRoot,
        packageRoots: selectedPackageRoots.map((item) => item.path),
        omittedPackageRoots: Math.max(0, availablePackageRoots.length - selectedPackageRoots.length),
      };

      const allPathMatches = [...scope.pathMatches];
      if (params.path && scope.fastPath) {
        const hinted = await listPathMatches({ cwd: ctx.cwd, query: params.path, searchRoot: ".", signal });
        for (const match of hinted) {
          if (!allPathMatches.some((existing) => existing.path === match.path)) allPathMatches.push(match);
        }
      }

      const pathOnlyDiscovery = matches.length === 0 && !params.path && allPathMatches.length > 0;
      const allRankedCandidates = prioritizeRelatedResults(
        rankFileGroups(matches, params.path ?? params.query, maxMatchesPerFile, allPathMatches, context),
        related,
        primaryRoot,
      );
      const rankedCandidates = matches.length > 0
        ? allRankedCandidates.filter((file) => file.matches.length > 0)
        : (pathOnlyDiscovery ? allRankedCandidates : []);
      const ranked = withConfidence(rankedCandidates.slice(0, maxFiles));
      const totalMatches = matches.length + (pathOnlyDiscovery ? allPathMatches.length : 0);
      const totalFiles = matches.length > 0
        ? new Set(matches.map((match) => match.path)).size
        : (pathOnlyDiscovery ? new Set(allPathMatches.map((match) => match.path)).size : 0);
      const fallbackNotice = literalFallback ? "\n\n[agentic_search retried this as a literal string because ripgrep rejected the regex.]" : "";
      const relatedOptionName = "expand_related";
      const relatedNoun = related?.label === "import" ? "import" : related?.label === "mixin" ? "mixin" : "related";
      const relatedNotes = related
        ? [
            `${relatedOptionName}: searched ${related.roots.length} resolved ${relatedNoun} file${related.roots.length === 1 ? "" : "s"}.`,
            ...(related.resolved.length > 0
              ? [`Resolved ${relatedNoun}s: ${related.resolved.map((item) => `${item.name} -> ${item.path}`).join(", ")}.`]
              : []),
            ...(related.unresolved.length > 0
              ? [`Unresolved ${relatedNoun}s: ${uniqueValues(related.unresolved.map((item) => item.name)).join(", ")}.`]
              : []),
          ]
        : (expandNote ? [expandNote] : []);
      const notes = [...relatedNotes, ...oneCallCoverageNotes(coverage)];
      const targetInstruction = related
        ? (coverage.packageRoots.length > 0
          ? `Read this file first; ${relatedOptionName} also searched ${related.roots.length} resolved ${relatedNoun} file${related.roots.length === 1 ? "" : "s"} and ${coverage.packageRoots.length} imported package${coverage.packageRoots.length === 1 ? "" : "s"}.`
          : `Read this file first; ${relatedOptionName} also searched ${related.roots.length} resolved ${relatedNoun} file${related.roots.length === 1 ? "" : "s"} shown below as 1.x related targets.`)
        : undefined;
      const formatted = `${formatSearchResults(params.query, ranked, totalMatches, notes, targetInstruction, related)}${fallbackNotice}`;

      const details: SearchDetails = {
        query: params.query,
        context,
        totalMatches,
        totalFiles,
        returnedFiles: ranked.length,
        files: ranked.map((file) => ({
          path: file.path,
          score: file.score,
          matchCount: file.matchCount,
          reasons: file.reasons,
          topMatch: file.matches[0] ? formatTopMatch(file.matches[0]) : undefined,
          confidence: file.confidence,
        })),
        coverage,
        related,
        literalFallback,
        regexError,
      };

      const text = await writeFullOutputIfTruncated(formatted, "pi-agentic-search-", details);
      return { content: [{ type: "text", text }], details };
    },

    renderCall,

    renderResult,
  });

  pi.registerCommand("agentic-search-info", {
    description: "Show pi-agentic-search status and tool names",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "pi-agentic-search loaded: one agentic_search call covers the scoped target, related files, owning package, and resolvable imported packages.",
        "info",
      );
    },
  });
}

import { execFile } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
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
import { expandRelatedFiles, expandRubyMixins, type RelatedExpansionDetails } from "./related.ts";

const execFileAsync = promisify(execFile);

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
  "!*.lock",
  "!**/*.lock",
  "!package-lock.json",
  "!**/package-lock.json",
  "!pnpm-lock.yaml",
  "!**/pnpm-lock.yaml",
  "!yarn.lock",
  "!**/yarn.lock",
];

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

interface SearchDetails {
  query: string;
  totalMatches: number;
  totalFiles: number;
  returnedFiles: number;
  files: SearchFileDetails[];
  related?: RelatedExpansionDetails;
  mixins?: RelatedExpansionDetails;
  truncation?: TruncationResult;
  fullOutputPath?: string;
  literalFallback?: boolean;
  regexError?: string;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value ?? fallback)));
}

function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function normalizeRepoRelativePath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\/+/, "");
}

function ensureInsideCwd(cwd: string, candidate: string): string {
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
  const rel = relative(cwd, resolved);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolved;
  throw new Error(`Path escapes current repository: ${candidate}`);
}

function isDefinitionLine(line: string): boolean {
  return DEFINITION_PATTERNS.some((pattern) => pattern.test(line));
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function camelToSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function queryTokens(query: string): string[] {
  return Array.from(new Set(
    [query, camelToSnake(query)]
      .flatMap((value) => value.toLowerCase().split(/[^a-z0-9_]+/))
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  ));
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function scorePath(path: string, query: string): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const normalized = normalizeRepoRelativePath(path);
  const lower = normalized.toLowerCase();
  const ext = extname(lower);
  const file = basename(lower, ext);
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
  const filename = basename(normalizedPath);
  const filenameWithoutExtension = basename(normalizedPath, extname(normalizedPath));
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

  if (importantTokens.length > 0 && importantTokens.every((token) => normalizedPath.includes(token))) {
    score += Math.min(50, 20 + importantTokens.length * 5);
    reasons.push(`path matches query tokens: ${importantTokens.join(", ")}`);
  }

  if (score === 0) return undefined;

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
    const pathQueryScore = pathQueryMatch?.score ?? 0;
    const pathQueryReasons = pathQueryMatch?.reasons ?? [];

    ranked.push({
      path,
      score: pathScore.score + matchScore.score + pathQueryScore,
      reasons: [...pathQueryReasons, ...matchScore.reasons, ...pathScore.reasons],
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
  const relatedByPath = new Map<string, Array<{ from: string; name: string; relationship: string; note: string }>>();
  for (const item of related.resolved) {
    const existing = relatedByPath.get(item.path) ?? [];
    existing.push({ from: item.from, name: item.name, relationship: item.relationship, note: item.note });
    relatedByPath.set(item.path, existing);
  }

  return ranked
    .map((file) => {
      const references = relatedByPath.get(file.path) ?? [];
      if (file.path === targetPath) {
        return {
          ...file,
          score: file.score + 2000,
          reasons: ["primary target", ...file.reasons],
        };
      }

      if (references.length > 0) {
        const labels = references.map((item) => `${item.name} ${item.relationship} ${item.from}; ${item.note}`).join(", ");
        return {
          ...file,
          score: file.score + 1500,
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
    const noteText = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";
    return `No matches found for ${JSON.stringify(query)}.${noteText}`;
  }

  const confidenceSum = ranked.reduce((sum, file) => sum + (file.confidence ?? 0), 0);
  const confidenceText = ranked.some((file) => typeof file.confidence === "number") ? `, confidence sum ${confidenceSum.toFixed(3)}` : "";
  const lines = [
    `agentic_search: ${JSON.stringify(query)} — ${ranked.length} ranked file${ranked.length === 1 ? "" : "s"} from ${totalMatches} match${totalMatches === 1 ? "" : "es"}${confidenceText}`,
    `TARGET FILE: ${ranked[0]?.path}. ${targetInstruction}`,
    "",
  ];

  const primaryPath = ranked[0]?.path;
  const relatedByPath = new Map<string, Array<{ from: string; name: string; relationship: string; note: string }>>();
  if (related && primaryPath) {
    for (const item of related.resolved) {
      const existing = relatedByPath.get(item.path) ?? [];
      existing.push({ from: item.from, name: item.name, relationship: item.relationship, note: item.note });
      relatedByPath.set(item.path, existing);
    }
  }

  let topLevelIndex = 0;
  let mixinChildIndex = 0;
  for (const file of ranked) {
    const relatedReferences = relatedByPath.get(file.path) ?? [];
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

  lines.push("Next step: read the TARGET FILE first. If it lacks the requested construct or context, inspect the ranked candidates before falling back to broad shell search.");
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

async function runRg(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    const result = await execFileAsync("rg", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 30 * 1024 * 1024,
      signal,
    });
    return String(result.stdout ?? "");
  } catch (error: any) {
    if (error?.code === 1) return String(error.stdout ?? "");
    if (error?.name === "AbortError") throw error;
    const stderr = typeof error?.stderr === "string" && error.stderr.trim() ? `\n${error.stderr.trim()}` : "";
    throw new Error(`rg failed${stderr}`);
  }
}

async function listPathMatches(params: {
  cwd: string;
  query: string;
  searchRoot: string;
  signal?: AbortSignal;
}): Promise<PathMatch[]> {
  const args = ["--files", "--hidden", "--color=never"];
  addRgExcludes(args);
  args.push(params.searchRoot);

  const output = await runRg(args, params.cwd, params.signal);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeRepoRelativePath)
    .flatMap((path) => {
      const match = scorePathQueryMatch(path, params.query);
      return match ? [{ path, ...match }] : [];
    });
}

function resolveCandidatePath(cwd: string, candidate: string): string {
  const stripped = stripAtPrefix(candidate);
  if (isAbsolute(stripped)) return resolve(stripped);
  return ensureInsideCwd(cwd, stripped);
}

function displaySearchRoot(cwd: string, resolved: string): string {
  const rel = relative(cwd, resolved);
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !isAbsolute(rel)) return normalizeRepoRelativePath(rel);
  return normalizeRepoRelativePath(resolved);
}

async function existingSearchRoot(cwd: string, candidate: string): Promise<{ root: string; isDirectory: boolean } | undefined> {
  try {
    const resolved = resolveCandidatePath(cwd, candidate);
    const stats = await stat(resolved);
    return {
      root: displaySearchRoot(cwd, resolved),
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
}): Promise<{ searchRoots: string[]; pathMatches: PathMatch[] }> {
  const pathQuery = params.path?.trim();

  if (!pathQuery) {
    return {
      searchRoots: ["."],
      pathMatches: await listPathMatches({ cwd: params.cwd, query: params.query, searchRoot: ".", signal: params.signal }),
    };
  }

  const existing = await existingSearchRoot(params.cwd, pathQuery);
  if (existing) {
    return {
      searchRoots: [existing.root],
      pathMatches: existing.isDirectory
        ? []
        : await listPathMatches({ cwd: params.cwd, query: pathQuery, searchRoot: existing.root, signal: params.signal }),
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
  };
}

function isRegexParseError(error: unknown): boolean {
  return error instanceof Error && /regex parse error|repetition quantifier|unclosed|invalid escape/i.test(error.message);
}

function addRgExcludes(args: string[]): void {
  for (const glob of DEFAULT_EXCLUDES) args.push("--glob", glob);
}

const SearchParams = Type.Object({
  query: Type.String({ description: "Precise code syntax regex or literal string to search for. Prefer construct syntax over the whole user prompt; for Rails scopes use scope\\s+:" }),
  path: Type.Optional(Type.String({ description: "Optional exact path, filename, or partial path hint. Example: event_occurrence.rb" })),
  max_files: Type.Optional(Type.Number({ description: "Maximum ranked candidate files to return, default 5, max 10" })),
  max_matches_per_file: Type.Optional(Type.Number({ description: "Maximum snippet matches per file, default 10 for construct queries, max 10" })),
  expand_mixins: Type.Optional(Type.Boolean({ description: "Ruby/Rails alias for expand_related; searches include/prepend/extend modules resolved from target files" })),
  expand_related: Type.Optional(Type.Boolean({ description: "Search language-related files with the target: Ruby/Rails include/prepend/extend mixins and JS/TS relative imports/re-exports" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat query as a literal string instead of a regex" })),
  case_sensitive: Type.Optional(Type.Boolean({ description: "Use case-sensitive matching. Default false uses smart-case." })),
});

export default function agenticSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "agentic_search",
    label: "Agentic Search",
    description: `Preferred ranked search for locating files, classes, scopes, methods, and call sites across a repository. Uses ripgrep, then ranks and groups results for coding-agent workflows. For model/component/module questions about available behavior, scopes, callbacks, associations, included concerns, mixins, or JS/TS imports, set expand_related true so related files are searched with the target file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Preferred ranked search for locating files, classes, scopes, methods, and call sites across a repository. Make one focused search from the user's named construct and optional path hint. For Rails model questions about scopes/behavior including concerns or mixins, or JS/TS questions needing imported files, pass expand_related: true. Read the target file first, then use related 1.x candidates when shown.",
    promptGuidelines: [
      "Prefer agentic_search over grep for locating files, classes, scopes, methods, and call sites because ranked results identify the best file to read first.",
      "When a user names both a code construct and a file, make exactly one focused agentic_search call with query for the construct syntax and path for the filename or partial path hint.",
      "For Rails scope requests like predicates for scopes on event_occurrence.rb, call agentic_search once with query scope\\s+: and path event_occurrence.rb, then read the target file first before broader discovery.",
      "For Rails model questions about scopes available on a model, model behavior, callbacks, associations, included concerns, or mixins, set expand_related true; examples: 'how many scopes does User have?', 'include concerns', 'from mixins', 'available on User'.",
      "For JS/TS questions where imported files, re-export barrels, hooks, components, helpers, or sibling modules may contain the requested behavior, set expand_related true so relative imports are searched and rendered as 1.x child targets.",
      "If agentic_search returns a target file containing the requested construct matches, read that target first before alternate candidates, sibling models, tests, migrations, git status, or shell searches.",
      "Use other ranked candidates when the target file is missing, ambiguous, or lacks the requested construct/context.",
    ],
    parameters: SearchParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const maxFiles = clampInt(params.max_files, 5, 1, 10);
      const maxMatchesPerFile = clampInt(params.max_matches_per_file, 10, 1, 10);
      const scope = await resolveSearchScope({
        cwd: ctx.cwd,
        query: params.query,
        path: params.path,
        maxFiles,
        signal,
      });
      const related = params.expand_related
        ? await expandRelatedFiles(ctx.cwd, scope.searchRoots)
        : (params.expand_mixins ? await expandRubyMixins(ctx.cwd, scope.searchRoots) : undefined);
      const searchRoots = uniqueValues([...scope.searchRoots, ...(related?.roots ?? [])]);

      const buildArgs = (literal: boolean) => {
        const args = ["--json", "--line-number", "--column", "--color=never", "--hidden"];
        addRgExcludes(args);
        if (literal) args.push("--fixed-strings");
        if (!params.case_sensitive) args.push("--smart-case");
        args.push(params.query, ...searchRoots);
        return args;
      };

      let output: string;
      let literalFallback = false;
      let regexError: string | undefined;
      try {
        output = await runRg(buildArgs(params.literal ?? false), ctx.cwd, signal);
      } catch (error) {
        if (params.literal || !isRegexParseError(error)) throw error;
        literalFallback = true;
        regexError = error instanceof Error ? error.message : String(error);
        output = await runRg(buildArgs(true), ctx.cwd, signal);
      }

      const pathMatches = scope.pathMatches;
      const matches = parseRipgrepJsonLines(output);
      const rankedCandidates = prioritizeRelatedResults(
        rankFileGroups(matches, params.path ?? params.query, maxMatchesPerFile, pathMatches),
        related,
        scope.searchRoots[0],
      );
      const ranked = withConfidence(rankedCandidates.slice(0, maxFiles));
      const totalMatches = matches.length > 0 ? matches.length : pathMatches.length;
      const totalFiles = new Set([...matches.map((match) => match.path), ...pathMatches.map((match) => match.path)]).size;
      const fallbackNotice = literalFallback ? "\n\n[agentic_search retried this as a literal string because ripgrep rejected the regex.]" : "";
      const relatedOptionName = params.expand_related ? "expand_related" : "expand_mixins";
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
        : [];
      const targetInstruction = related
        ? `Read this file first; ${relatedOptionName} also searched ${related.roots.length} resolved ${relatedNoun} file${related.roots.length === 1 ? "" : "s"} shown below as 1.x related targets.`
        : undefined;
      const formatted = `${formatSearchResults(params.query, ranked, totalMatches, relatedNotes, targetInstruction, related)}${fallbackNotice}`;

      const details: SearchDetails = {
        query: params.query,
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
        related,
        mixins: params.expand_mixins ? related : undefined,
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
        "pi-agentic-search loaded: agentic_search only. For named-file construct matches, read the target file first before broader discovery.",
        "info",
      );
    },
  });
}

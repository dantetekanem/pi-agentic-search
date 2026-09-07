import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

import { DEFAULT_EXCLUDES, PACKAGE_SEARCH_EXCLUDES, JS_TS_EXTENSIONS, SOURCE_EXTENSIONS } from "./classifications.ts";
import { SearchRequest, runRg } from "./retrieval.ts";
import type { CodeMatch, FileSummary, RankedFileResult, PathMatch, SearchTopMatch, SearchCoverageDetails, SearchDetails } from "./types.ts";
export { parseRipgrepJsonLines } from "./matches.ts";
export type { CodeMatch, RankedFileResult, PathMatch } from "./types.ts";

const MAX_PACKAGE_SEARCH_ROOTS = 20;

const LOW_VALUE_PATH_PATTERN = /(^|\/)(node_modules|vendor|dist|build|coverage|tmp|log|\.git|\.next|\.turbo|target)(\/|$)/;
const TEST_PATH_PATTERN = /(^|\/)(__tests__|tests?|spec|fixtures?|mocks?|stories)(\/|$)|\.(test|spec|stories)\.[^.]+$/;
const GENERATED_PATH_PATTERN = /(generated|schema\.json|\.min\.|bundle\.|compiled)/i;

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

function scoreMatches(matches: CodeMatch[], summary?: FileSummary): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const definitionCount = summary?.definitionCount ?? matches.filter((match) => match.isDefinition).length;
  const count = summary?.matchCount ?? matches.length;

  if (count > 0) {
    score += 1000;
    reasons.push("content match");
  }

  if (definitionCount > 0) {
    score += 35 + Math.min(30, definitionCount * 5);
    reasons.push(`${definitionCount} definition-like match${definitionCount === 1 ? "" : "es"}`);
  }

  score += Math.min(20, count * 2);
  if (count > 1) reasons.push(`${count} matches`);

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

export function rankFileGroups(
  matches: CodeMatch[],
  query: string,
  maxMatchesPerFile: number,
  pathMatches: PathMatch[] = [],
  context?: string,
  summaries?: ReadonlyMap<string, FileSummary>,
): RankedFileResult[] {
  const grouped = new Map<string, CodeMatch[]>();
  for (const match of matches) {
    const existing = grouped.get(match.path) ?? [];
    existing.push(match);
    grouped.set(match.path, existing);
  }

  const pathMatchByPath = new Map(pathMatches.map((match) => [match.path, match]));
  const allPaths = new Set([...grouped.keys(), ...pathMatchByPath.keys(), ...(summaries?.keys() ?? [])]);

  const ranked: RankedFileResult[] = [];
  for (const path of allPaths) {
    const fileMatches = grouped.get(path) ?? [];
    const pathQueryMatch = pathMatchByPath.get(path);
    const sortedMatches = [...fileMatches].sort((a, b) => {
      if (a.isDefinition !== b.isDefinition) return a.isDefinition ? -1 : 1;
      return a.lineNumber - b.lineNumber;
    });

    const pathScore = scorePath(path, query);
    const matchScore = scoreMatches(fileMatches, summaries?.get(path));
    const contextScore = scoreContext(path, fileMatches, context);
    const pathQueryScore = pathQueryMatch?.score ?? 0;
    const pathQueryReasons = pathQueryMatch?.reasons ?? [];

    ranked.push({
      path,
      score: pathScore.score + matchScore.score + contextScore.score + pathQueryScore,
      reasons: [...contextScore.reasons, ...pathQueryReasons, ...matchScore.reasons, ...pathScore.reasons],
      matchCount: summaries?.get(path)?.matchCount ?? (fileMatches.length > 0 ? fileMatches.length : (pathQueryMatch ? 1 : 0)),
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
  coverage?: SearchCoverageDetails,
): string {
  if (ranked.length === 0) {
    return [
      coverage?.status === "failed" ? `Search failed for ${JSON.stringify(query)}.` : `No code matches found for ${JSON.stringify(query)} in the completed scopes.`,
      ...(notes.length > 0 ? [notes.join("\n")] : []),
      "Path hints are coverage, not code matches.",
      coverage?.status === "complete" ? "Search complete for the reported pattern and scopes." : "Coverage is incomplete; inspect the unvisited roots and unresolved relationships listed above.",
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
      lines.push(`${isPrimaryRelatedChild ? "      " : "   "}${file.reasons.includes("content match") ? "[content] matching snippets omitted by retention budget" : "[path] filename/path match"}`);
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

  lines.push(coverage && coverage.status !== "complete"
    ? "Next step: read the TARGET FILE, then inspect the unvisited roots and unresolved relationships listed above."
    : "Next step: read the TARGET FILE first; coverage applies only to the reported pattern and scopes.");
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

async function listPathMatches(params: {
  cwd: string;
  query: string;
  searchRoot: string;
  request: SearchRequest;
}): Promise<PathMatch[]> {
  const explicitAbsoluteRoot = isAbsolute(stripAtPrefix(params.searchRoot));
  const resolvedRoot = resolveCandidatePath(params.cwd, params.searchRoot);
  const rootStats = explicitAbsoluteRoot ? await stat(resolvedRoot) : undefined;
  const searchCwd = rootStats?.isDirectory() ? resolvedRoot : explicitAbsoluteRoot ? dirname(resolvedRoot) : params.cwd;
  const localRoot = rootStats?.isDirectory() ? "." : explicitAbsoluteRoot ? basename(resolvedRoot) : params.searchRoot;
  const args = ["--files", "--null", "--hidden", "--color=never"];
  addRgExcludes(args);
  args.push("--", localRoot);

  const key = `${searchCwd}\0${localRoot}`;
  let inventory = params.request.inventories.get(key);
  if (!inventory) {
    inventory = (async () => {
      const paths: string[] = [];
      const result = await runRg(args, searchCwd, [params.searchRoot], params.request, (path) => {
        if (paths.length >= params.request.limits.candidates) return "path inventory candidate budget";
        paths.push(path);
      }, "\0");
      result.kind = "inventory";
      if (result.status !== "complete") params.request.inventoryReasons.push(result.reason ?? result.error ?? "incomplete path inventory");
      return paths;
    })();
    params.request.inventories.set(key, inventory);
  }

  return (await inventory)
    .map((path) => explicitAbsoluteRoot
      ? displaySearchRoot(params.cwd, resolve(searchCwd, path))
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

async function existingSearchRoot(cwd: string, candidate: string): Promise<{ root: string } | undefined> {
  try {
    const stripped = stripAtPrefix(candidate);
    const resolved = resolveCandidatePath(cwd, candidate);
    await stat(resolved);
    return { root: isAbsolute(stripped) ? resolved : displaySearchRoot(cwd, resolved) };
  } catch {
    return undefined;
  }
}

async function resolveSearchScope(params: {
  cwd: string;
  query: string;
  path?: string;
  request: SearchRequest;
}): Promise<{ searchRoots: string[]; pathMatches: PathMatch[] }> {
  const pathQuery = params.path?.trim();

  if (!pathQuery) {
    return {
      searchRoots: ["."],
      pathMatches: [],
    };
  }

  const existing = await existingSearchRoot(params.cwd, pathQuery);
  if (existing) {
    return {
      searchRoots: [existing.root],
      pathMatches: [],
    };
  }

  const pathMatches = await listPathMatches({ cwd: params.cwd, query: pathQuery, searchRoot: ".", request: params.request });
  const rankedPathMatches = [...pathMatches].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const depthDifference = pathDepth(a.path) - pathDepth(b.path);
    if (depthDifference !== 0) return depthDifference;
    return a.path.localeCompare(b.path);
  });
  const searchRoots = rankedPathMatches.map((match) => match.path);

  return {
    searchRoots: searchRoots.length > 0 ? searchRoots : ["."],
    pathMatches,
  };
}

function addRgExcludes(args: string[]): void {
  for (const glob of DEFAULT_EXCLUDES) args.push("--glob", glob);
}

function addPackageSearchExcludes(args: string[]): void {
  for (const glob of PACKAGE_SEARCH_EXCLUDES) args.push("--glob", glob);
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
  request: SearchRequest;
}): Promise<void> {
  const resolvedRoot = resolveCandidatePath(params.cwd, params.root);

  const args = ["--json", "--line-number", "--color=never", "--hidden", "--no-ignore"];
  addPackageSearchExcludes(args);
  if (params.literal) args.push("--fixed-strings");
  if (!params.caseSensitive) args.push("--smart-case");
  args.push("-e", params.query, "--", ".");

  await runRg(args, resolvedRoot, [params.root], params.request,
    (line) => params.request.consume(line, (path) => displaySearchRoot(params.cwd, resolve(resolvedRoot, path))));
}

function oneCallCoverageNotes(coverage: SearchCoverageDetails): string[] {
  const parts = [`${coverage.roots.length} target/relative root${coverage.roots.length === 1 ? "" : "s"}`];
  if (coverage.ownerRoot) parts.push(`owning package ${coverage.ownerRoot}`);
  if (coverage.packageRoots.length > 0) {
    parts.push(`${coverage.packageRoots.length} imported package${coverage.packageRoots.length === 1 ? "" : "s"}`);
  }
  if (coverage.omittedPackageRoots > 0) {
    parts.push(`${coverage.omittedPackageRoots} imported package${coverage.omittedPackageRoots === 1 ? "" : "s"} not searched`);
  }

  const notes = [`One-call coverage: ${parts.join("; ")}. Status: ${coverage.status}.`,
    `Completed roots: ${coverage.completedRoots.join(", ") || "none"}.`,
    ...(coverage.unvisitedRoots.length ? [`Unvisited or incomplete roots: ${coverage.unvisitedRoots.join(", ")}.`] : []),
    ...coverage.reasons.map((reason) => `Coverage limit: ${reason}.`),
    ...(coverage.omittedMatches ? [`Snippet retention: ${coverage.retainedMatches} retained; ${coverage.omittedMatches} omitted. Counts include all visited matching lines.`] : []),
  ];
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
    promptSnippet: "Preferred one-call ranked search for locating files, classes, scopes, methods, and call sites. Use context for natural-language disambiguation and expand_related: true for Rails concerns/mixins or JS/TS imports. Read the ranked target, then inspect reported unvisited scopes when coverage is partial.",
    promptGuidelines: [
      "Prefer agentic_search over grep for locating files, classes, scopes, methods, and call sites because ranked results identify the best file to read first.",
      "When a user names both a code construct and a file, make exactly one focused agentic_search call with query for the construct syntax and path for the filename or partial path hint.",
      "When the same construct name appears in multiple domains, keep query as the exact code syntax or literal and pass context as a natural-language ranking hint; for example query remaining_value with context actual goal progress.",
      "For Rails scope requests like predicates for scopes on event_occurrence.rb, call agentic_search once with query scope\\s+: and path event_occurrence.rb, then read the target file first before broader discovery.",
      "For Rails model questions about scopes available on a model, model behavior, callbacks, associations, included concerns, or mixins, set expand_related true; examples: 'how many scopes does User have?', 'include concerns', 'from mixins', 'available on User'.",
      "For JS/TS questions where imported files, re-export barrels, hooks, components, helpers, sibling modules, or dependency utilities may contain the requested behavior, set expand_related true. One agentic_search call then covers relative imports, the owning package, and resolvable imported packages.",
      "If agentic_search returns a target file containing the requested construct matches, read that target first before alternate candidates, sibling models, tests, migrations, git status, or shell searches.",
      "Use other ranked candidates from the same agentic_search result when the first target is ambiguous or lacks context.",
      "Use agentic_search coverage.status, completedRoots, and unvisitedRoots to judge misses. Partial or failed coverage is not a decisive miss; inspect the named unvisited scopes or unresolved relationships.",
    ],
    parameters: SearchParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const maxFiles = clampInt(params.max_files, 5, 1, 10);
      const maxMatchesPerFile = clampInt(params.max_matches_per_file, 10, 1, 10);
      const context = typeof params.context === "string" && params.context.trim() ? params.context.trim() : undefined;

      const request = new SearchRequest(signal);
      try {
      const scope = await resolveSearchScope({ cwd: ctx.cwd, query: params.query, path: params.path, request });

      const related = params.expand_related
        ? await expandRelatedFiles(ctx.cwd, scope.searchRoots, request.signal)
        : undefined;
      const searchRoots = uniqueValues([...scope.searchRoots, ...(related?.roots ?? [])]);
      const expandNote =
        params.expand_related && (!related || (related.roots.length === 0 && related.packageRoots.length === 0))
          ? "expand_related: no resolvable mixins/imports from the search root(s); owning-package coverage is still included on a scoped miss."
          : undefined;

      let useLiteral = params.literal ?? false;
      let literalFallback = false;
      let regexError: string | undefined;

      const buildArgs = (literal: boolean, roots: string[]) => {
        const args = ["--json", "--line-number", "--color=never", "--hidden"];
        addRgExcludes(args);
        if (literal) args.push("--fixed-strings");
        if (!params.case_sensitive) args.push("--smart-case");
        args.push("-e", params.query, "--", ...roots);
        return args;
      };

      const runSearchRoots = async (roots: string[]) => {
        const search = async (cwd: string, localRoots: string[], reportedRoots: string[], mapPath = normalizeRepoRelativePath) => {
          const result = await runRg(buildArgs(useLiteral, localRoots), cwd, reportedRoots, request, (line) => request.consume(line, mapPath));
          if (!useLiteral && result.exitCode === 2 && result.signal === null && /regex parse error:/i.test(result.error ?? "")) {
            result.kind = "validation";
            useLiteral = true;
            literalFallback = true;
            regexError = result.error;
            await runRg(buildArgs(true, localRoots), cwd, reportedRoots, request, (line) => request.consume(line, mapPath));
          }
        };
        const relativeRoots = roots.filter((root) => !isAbsolute(root));
        for (let index = 0; index < relativeRoots.length; index += 32) {
          const batch = relativeRoots.slice(index, index + 32);
          await search(ctx.cwd, batch, batch);
        }
        for (const root of roots.filter(isAbsolute)) {
          const rootStats = await stat(root).catch(() => undefined);
          const cwd = rootStats?.isDirectory() ? root : dirname(root);
          await search(cwd, [rootStats?.isDirectory() ? "." : basename(root)], [root],
            (path) => displaySearchRoot(ctx.cwd, resolve(cwd, path)));
        }
      };
      await runSearchRoots(searchRoots);
      let matches = request.matches;

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
        await runSearchRoots([ownerRoot]);
      }

      const availablePackageRoots = related?.packageRoots ?? [];
      const selectedPackageRoots = needsOneCallExpansion ? availablePackageRoots.slice(0, MAX_PACKAGE_SEARCH_ROOTS) : [];
      for (const packageRoot of selectedPackageRoots) {
        await searchPackageRoot({
          cwd: ctx.cwd,
          root: packageRoot.path,
          query: params.query,
          literal: useLiteral,
          caseSensitive: params.case_sensitive,
          request,
        });
      }
      matches = request.matches;
      const allPathMatches = !params.path && request.files.size === 0
        ? await listPathMatches({ cwd: ctx.cwd, query: params.query, searchRoot: ".", request })
        : scope.pathMatches;
      const contentRuns = request.runs.filter((run) => !run.kind || run.kind === "content");
      const omittedPackages = availablePackageRoots.filter((item) => !selectedPackageRoots.includes(item));
      const reasons = uniqueValues([
        ...request.inventoryReasons,
        ...contentRuns.flatMap((run) => run.reason ?? run.error ?? []),
        ...(related?.unresolved.map((item) => `unresolved ${item.name} from ${item.from}`) ?? []),
        ...omittedPackages.map((item) => `unsearched imported package ${item.path}`),
        ...(related?.skipped ?? []),
      ]);
      const completedRoots = uniqueValues(contentRuns.filter((run) => run.status === "complete").flatMap((run) => run.roots));
      const coverage: SearchCoverageDetails = {
        status: reasons.length === 0 ? "complete" : request.files.size === 0 && contentRuns.some((run) => run.status === "failed") && completedRoots.length === 0 ? "failed" : "partial",
        roots: searchRoots, ownerRoot,
        packageRoots: selectedPackageRoots.map((item) => item.path), omittedPackageRoots: omittedPackages.length,
        omittedRelatedCandidates: omittedPackages.length + (related?.unresolved.length ?? 0) + (related?.skipped?.length ?? 0),
        packagePolicy: { excludes: PACKAGE_SEARCH_EXCLUDES, respectsIgnoreFiles: false },
        completedRoots,
        unvisitedRoots: uniqueValues([...request.runs.filter((run) => run.kind !== "validation" && run.status !== "complete").flatMap((run) => run.roots), ...omittedPackages.map((item) => item.path)]),
        reasons, runs: request.runs, excludes: DEFAULT_EXCLUDES, respectsIgnoreFiles: true,
        retainedMatches: matches.length, omittedMatches: request.totalMatches - matches.length,
        retainedBytes: request.retainedBytes, truncatedMatches: request.truncatedMatches, limits: request.limits,
      };

      const pathOnlyDiscovery = matches.length === 0 && !params.path && allPathMatches.length > 0;
      const allRankedCandidates = prioritizeRelatedResults(
        rankFileGroups(matches, params.path ?? params.query, maxMatchesPerFile, allPathMatches, context, request.files),
        related,
        primaryRoot,
      );
      const rankedCandidates = request.files.size > 0
        ? allRankedCandidates.filter((file) => request.files.has(file.path))
        : (pathOnlyDiscovery ? allRankedCandidates : []);
      const ranked = withConfidence(rankedCandidates.slice(0, maxFiles));
      const totalMatches = request.totalMatches + (pathOnlyDiscovery ? allPathMatches.length : 0);
      const totalFiles = request.files.size || (pathOnlyDiscovery ? allPathMatches.length : 0);
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
      const formatted = `${formatSearchResults(params.query, ranked, totalMatches, notes, targetInstruction, related, coverage)}${fallbackNotice}`;

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
      } finally { request.dispose(); }
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

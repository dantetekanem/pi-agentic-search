import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_EXCLUDES, PACKAGE_SEARCH_EXCLUDES, JS_TS_EXTENSIONS } from "./classifications.ts";
import { capList, coverageNotes, describeNameCounts } from "./coverage-summary.ts";
import { expandRelatedFiles } from "./related.ts";
import { formatSearchResults, formatTopMatch } from "./format.ts";
import { CONTEXT_LIMITS, contextTokens, enrichContext, pathDepth, rankFileGroups, scorePathQueryMatch, type RankingFeatures } from "./ranking.ts";
import { SearchRequest } from "./retrieval.ts";
import { EXECUTION_LIMITS, SearchExecutor, inPool } from "./execution.ts";
import { ProjectFiles } from "./inventory.ts";
import { clampInt, displaySearchRoot, stripAtPrefix, uniqueValues } from "./shared.ts";
import type { PathMatch, RankedFileResult, SearchCoverageDetails, SearchDetails, SearchIntent } from "./types.ts";

export interface SearchInput {
  query: string;
  context?: string;
  intent?: SearchIntent;
  path?: string;
  max_files?: number;
  max_matches_per_file?: number;
  expand_related?: boolean;
  literal?: boolean;
  case_sensitive?: boolean;
}

function candidatePath(cwd: string, candidate: string): string { return resolve(cwd, stripAtPrefix(candidate)); }

async function listPathMatches(files: ProjectFiles, query: string): Promise<PathMatch[]> {
  return (await files.list(".")).flatMap((absolute) => {
    const path = files.display(absolute);
    const match = scorePathQueryMatch(path, query);
    return match ? [{ path, ...match }] : [];
  });
}

type ScopeKind = "file" | "directory" | "path-matches" | "repository";
interface SearchScope { roots: string[]; pathMatches: PathMatch[]; kind: ScopeKind }

async function resolveSearchScope(cwd: string, path: string | undefined, files: ProjectFiles): Promise<SearchScope> {
  const hint = path?.trim();
  if (!hint) return { roots: ["."], pathMatches: [], kind: "repository" };
  const resolved = candidatePath(cwd, hint);
  const stats = await files.fileStat(resolved);
  if (stats || files.request.signal.aborted) {
    return { roots: [isAbsolute(stripAtPrefix(hint)) ? resolved : displaySearchRoot(cwd, resolved)], pathMatches: [], kind: stats?.isFile() ? "file" : "directory" };
  }
  const pathMatches = await listPathMatches(files, hint);
  pathMatches.sort((a, b) => b.score - a.score || pathDepth(a.path) - pathDepth(b.path) || a.path.localeCompare(b.path));
  return { roots: pathMatches.length ? pathMatches.map((match) => match.path) : ["."], pathMatches, kind: pathMatches.length ? "path-matches" : "repository" };
}

function expansionSeeds(scope: SearchScope, ranked: RankedFileResult[], matched: ReadonlyMap<string, unknown>, limit: number): string[] {
  if (scope.kind === "file") return scope.roots;
  return ranked.filter((file) => matched.has(file.path)).slice(0, limit).map((file) => file.path);
}

async function owningRoot(files: ProjectFiles, root: string): Promise<string | undefined> {
  const resolved = candidatePath(files.cwd, root);
  const stats = await files.fileStat(resolved);
  if (!stats) return;
  let current = stats.isDirectory() ? resolved : dirname(resolved);
  while (files.alive()) {
    const [manifest, git] = await Promise.all([files.fileStat(join(current, "package.json")), files.fileStat(join(current, ".git"))]);
    if (manifest?.isFile() || git) return files.display(current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  return;
}

const ROOT_LIST_LIMIT = 6;

type SearchFeatures = RankingFeatures & { guidance?: boolean };

// Feature switches support evaluation; the registered tool always uses the defaults.
export async function runSearch(params: SearchInput, cwd: string, signal?: AbortSignal, features: SearchFeatures = {}) {
  const request = new SearchRequest(signal, undefined, undefined, { intent: params.intent, context: contextTokens(params.context) });
  try { return await executeSearch(params, cwd, request, features); }
  finally { request.dispose(); }
}

async function executeSearch(params: SearchInput, cwd: string, request: SearchRequest, features: SearchFeatures) {
  const maxFiles = clampInt(params.max_files, 5, 1, 10);
  const maxMatches = clampInt(params.max_matches_per_file, 10, 1, 10);
  const context = params.context?.trim() || undefined;
  const intent = params.intent ?? "auto";
  const files = new ProjectFiles(cwd, request);
  const scope = await resolveSearchScope(cwd, params.path, files);
  const executor = new SearchExecutor(files, params.query, params.literal, params.case_sensitive);
  await executor.searchRoots(scope.roots, "target");
  const querySymbol = /^[$_\p{ID_Start}][$\p{ID_Continue}\u200c\u200d]*$/u.test(params.query) && (params.literal || !params.query.includes("$")) ? params.query : undefined;
  const primaryRoot = scope.roots[0] ?? ".";
  const rankingOptions = { intent, anchorPath: params.path ? primaryRoot : undefined, features };
  const seeds = params.expand_related
    ? expansionSeeds(scope, request.checkpoint() ? rankFileGroups(request.matches, params.query, maxMatches, scope.pathMatches, context, request.files, rankingOptions) : [], request.files, maxFiles)
    : [];
  const seeding = params.expand_related && scope.kind !== "file" ? {
    roots: seeds, matchingFiles: request.files.size, limit: maxFiles, omittedFiles: Math.max(0, request.files.size - seeds.length),
  } : undefined;
  const related = seeds.length ? await expandRelatedFiles(cwd, seeds, request.signal, files, intent, querySymbol, scope.kind !== "file") : undefined;
  const searchRoots = uniqueValues([...scope.roots, ...(related?.roots ?? [])]);
  const coveredByTarget = (root: string) => scope.roots.some((target) => {
    const candidate = candidatePath(cwd, root);
    const absoluteTarget = candidatePath(cwd, target);
    return candidate === absoluteTarget || ((scope.kind === "directory" || scope.kind === "repository") && candidate.startsWith(`${absoluteTarget}/`));
  });
  await executor.searchRoots((related?.roots ?? []).filter((root) => !coveredByTarget(root)), "related");
  await executor.searchAliases(related?.symbolSearches ?? []);
  const needsExpansion = () => params.expand_related && scope.kind === "file" && (intent === "references" || intent === "tests" || request.files.size === 0 ||
    (JS_TS_EXTENSIONS.has(extname(primaryRoot)) && ![...request.files.values()].some((file) => file.definitionCount > 0)));
  const shouldExpandPackages = needsExpansion();
  const packages = shouldExpandPackages ? related?.packageRoots ?? [] : [];
  const candidates = packages.slice(0, EXECUTION_LIMITS.packages);
  if (shouldExpandPackages) for (const pkg of candidates) {
    if ((await files.fileStat(candidatePath(cwd, pkg.entryPath)))?.isFile()) await executor.searchRoot(pkg.entryPath, "entry");
  }
  const owner = shouldExpandPackages ? await owningRoot(files, primaryRoot) : undefined;
  if (owner && !searchRoots.includes(owner)) await executor.searchRoots([owner], "owner");
  const selectedPackages = shouldExpandPackages ? candidates : [];
  await inPool(selectedPackages, EXECUTION_LIMITS.packageConcurrency, async (pkg) => { await executor.searchRoot(pkg.path, "package"); });
  const { literalFallback, regexError } = executor;
  const pathMatches = !params.path && request.files.size === 0 ? await listPathMatches(files, params.query) : scope.pathMatches;
  const contentRuns = request.runs.filter((run) => !run.kind || run.kind === "content");
  const omittedPackages = packages.filter((pkg) => !selectedPackages.includes(pkg));
  const reasons = uniqueValues([
    ...request.inventoryReasons, ...contentRuns.flatMap((run) => run.reason ?? run.error ?? []),
    ...(seeding?.omittedFiles ? [`related seed budget: ${seeding.omittedFiles} matching files not expanded; ${seeding.roots.length}/${seeding.matchingFiles} ranked seeds`] : []),
    ...(related?.unresolved.map((item) => `unresolved ${item.name} from ${item.from}`) ?? []),
    ...(!request.checkpoint() ? [String(request.signal.reason ?? "cancelled")] : []),
    ...omittedPackages.map((pkg) => `unsearched imported package ${pkg.path}`), ...(related?.skipped ?? []),
  ]);
  const completedRoots = uniqueValues(contentRuns.filter((run) => run.status === "complete").flatMap((run) => run.roots));
  const failedWithoutCoverage = request.files.size === 0 && contentRuns.some((run) => run.status === "failed") && completedRoots.length === 0;
  const coverage: SearchCoverageDetails = {
    status: reasons.length === 0 ? "complete" : failedWithoutCoverage ? "failed" : "partial",
    roots: searchRoots, ownerRoot: owner, packageRoots: selectedPackages.map((pkg) => pkg.path), omittedPackageRoots: omittedPackages.length,
    omittedRelatedCandidates: omittedPackages.length + (related?.unresolved.length ?? 0) +
      (related?.traversal ? related.traversal.omittedEdges + related.traversal.omittedFileCandidates : related?.skipped?.length ?? 0),
    packagePolicy: { excludes: PACKAGE_SEARCH_EXCLUDES, respectsIgnoreFiles: false }, completedRoots,
    unvisitedRoots: uniqueValues([...request.runs.filter((run) => run.kind !== "validation" && run.status !== "complete").flatMap((run) => run.roots), ...omittedPackages.map((pkg) => pkg.path)]),
    reasons, runs: request.runs, excludes: DEFAULT_EXCLUDES, respectsIgnoreFiles: true,
    retainedMatches: request.matches.length, omittedMatches: request.totalMatches - request.matches.length,
    retainedBytes: request.retainedBytes, truncatedMatches: request.truncatedMatches, limits: request.limits,
    executionLimits: { ...EXECUTION_LIMITS, replayBytes: request.limits.retainedBytes }, relatedSeeding: seeding,
  };
  const options = { ...rankingOptions, related };
  let ranked = request.checkpoint() ? rankFileGroups(request.matches, params.query, maxMatches, pathMatches, context, request.files, options) : [];
  if (context && request.checkpoint()) {
    const enriched = await enrichContext(request.matches, ranked, cwd, request.signal);
    coverage.contextRanking = {
      fileLimit: CONTEXT_LIMITS.files, readByteLimit: CONTEXT_LIMITS.readBytes, blockByteLimit: CONTEXT_LIMITS.blockBytes,
      enrichedCandidates: enriched.enrichedPaths.size, unexaminedCandidates: ranked.length - enriched.enrichedPaths.size,
    };
    ranked = rankFileGroups(enriched.matches, params.query, maxMatches, pathMatches, context, request.files, options);
    for (const file of ranked) if (file.evidence) file.evidence.contextRead = enriched.enrichedPaths.has(file.path) ? "bounded" : "unavailable";
  }
  if (!request.checkpoint()) {
    coverage.status = "partial";
    coverage.reasons = uniqueValues([...coverage.reasons, String(request.signal.reason ?? "cancelled during result preparation")]);
  }
  const pathOnly = !request.files.size && !params.path && pathMatches.length > 0;
  ranked = (request.files.size ? ranked.filter((file) => request.files.has(file.path)) : pathOnly ? ranked : []).slice(0, maxFiles);
  const totalMatches = request.totalMatches + (pathOnly ? pathMatches.length : 0);
  const visibleResolved = related?.resolved.filter((item) => item.kind !== "package") ?? [];
  const unresolvedNames = new Map<string, number>();
  for (const item of related?.unresolved ?? []) unresolvedNames.set(item.name, (unresolvedNames.get(item.name) ?? 0) + 1);
  const unresolvedSummary = describeNameCounts(unresolvedNames, ROOT_LIST_LIMIT);
  const seedNote = seeds.length && scope.kind !== "file" ? ` Expanded from the ${seeds.length} top-ranked matching file${seeds.length === 1 ? "" : "s"}, not from ${scope.kind === "repository" ? "the repository" : primaryRoot}.` : "";
  const relatedNotes = related ? [
    `expand_related: searched ${related.roots.length} resolved ${related.label} files.${seedNote}`,
    ...(visibleResolved.length ? [`Resolved ${related.label}s: ${capList(uniqueValues(visibleResolved.map((item) => `${item.name} -> ${item.path}`)), ROOT_LIST_LIMIT)}.`] : []),
    ...(related.unresolved.length ? [`Unresolved ${related.label}s: ${unresolvedSummary.shown}${unresolvedSummary.more ? `; ${unresolvedSummary.more} more name${unresolvedSummary.more === 1 ? "" : "s"} across ${related.unresolved.length} sites in details.related.unresolved` : ""}.`] : []),
  ] : params.expand_related && !seeds.length ? [
    `expand_related: no matching files under ${scope.kind === "repository" ? "the repository" : primaryRoot} to expand from; name an exact file to follow its imports or mixins.`,
  ] : seeds.length && scope.kind !== "file" ? [`expand_related:${seedNote} No imports or mixins found.`] : [];
  const notes = [...relatedNotes, ...coverageNotes(coverage, { unresolvedSummarized: Boolean(related?.unresolved.length) }), ...(context ? [`Context ranking reads at most ${CONTEXT_LIMITS.files} candidate prefixes of ${CONTEXT_LIMITS.readBytes} bytes; unexamined candidates are marked unavailable.`] : [])];
  const details: SearchDetails = {
    query: params.query, context, intent, anchorPath: options.anchorPath, totalMatches,
    totalFiles: request.files.size || (pathOnly ? pathMatches.length : 0), returnedFiles: ranked.length,
    files: ranked.map((file) => ({ path: file.path, score: file.score, matchCount: file.matchCount, reasons: file.reasons, evidence: file.evidence, topMatch: file.matches[0] ? formatTopMatch(file.matches[0]) : undefined })),
    coverage, related, literalFallback, regexError,
  };
  let text = request.checkpoint() ? formatSearchResults(params.query, ranked, totalMatches, notes, undefined, related, coverage, features.guidance) : "";
  if (!request.checkpoint()) {
    coverage.status = "partial";
    coverage.reasons = uniqueValues([...coverage.reasons, String(request.signal.reason ?? "cancelled")]);
    text = `Search interrupted: ${String(request.signal.reason ?? "cancelled").slice(0, 512)}. Retrieved ${details.totalFiles} files${features.guidance === false ? "." : "; see coverage details for completed work."}`;
  }
  if (literalFallback) text += "\n\n[agentic_search retried this as a literal string because ripgrep rejected the regex.]";
  return { content: [{ type: "text" as const, text }], details };
}


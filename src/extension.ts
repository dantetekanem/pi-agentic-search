import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { DEFAULT_EXCLUDES, PACKAGE_SEARCH_EXCLUDES, JS_TS_EXTENSIONS } from "./classifications.ts";
import { expandRelatedFiles } from "./related.ts";
import { formatSearchResults, formatTopMatch, renderCall, renderResult } from "./render.ts";
import { CONTEXT_LIMITS, contextTokens, enrichContext, pathDepth, rankFileGroups, scorePathQueryMatch } from "./ranking.ts";
import { SearchRequest, runRg } from "./retrieval.ts";
import { ProjectFiles } from "./inventory.ts";
import { clampInt, displaySearchRoot, normalizeRepoRelativePath, stripAtPrefix, uniqueValues } from "./shared.ts";
import type { PathMatch, SearchCoverageDetails, SearchDetails } from "./types.ts";
export { parseRipgrepJsonLines } from "./matches.ts";
export { rankFileGroups } from "./ranking.ts";
export { formatSearchResults } from "./render.ts";
export type { CodeMatch, RankedFileResult, PathMatch } from "./types.ts";

const MAX_PACKAGE_SEARCH_ROOTS = 20;
const SearchParams = Type.Object({
  query: Type.String({ description: "Precise code syntax regex or literal string to search for. For Rails scopes use scope\\s+:." }),
  context: Type.Optional(Type.String({ description: "Optional natural-language disambiguation hint used only for ranking, not as the ripgrep query. Example: actual goal progress" })),
  intent: Type.Optional(StringEnum(["definition", "references", "tests", "file", "auto"] as const)),
  path: Type.Optional(Type.String({ description: "Optional exact path, filename, partial path, or absolute file/directory root." })),
  max_files: Type.Optional(Type.Number({ description: "Maximum ranked files displayed, default 5, max 10. Does not limit searched candidates." })),
  max_matches_per_file: Type.Optional(Type.Number({ description: "Maximum snippets per file, default 10, max 10." })),
  expand_related: Type.Optional(Type.Boolean({ description: "Search Ruby/Rails mixins or JS/TS imports and owning/imported packages; report incomplete traversal explicitly." })),
  literal: Type.Optional(Type.Boolean({ description: "Treat query as literal text instead of a regex." })),
  case_sensitive: Type.Optional(Type.Boolean({ description: "Use case-sensitive matching instead of rg smart-case." })),
});
type SearchInput = Static<typeof SearchParams>;

function candidatePath(cwd: string, candidate: string): string { return resolve(cwd, stripAtPrefix(candidate)); }
function rgArgs(query: string, roots: string[], literal: boolean, caseSensitive?: boolean, packageSearch = false): string[] {
  const args = ["--json", "--line-number", "--color=never", "--hidden"];
  if (packageSearch) args.push("--no-ignore");
  for (const glob of packageSearch ? PACKAGE_SEARCH_EXCLUDES : DEFAULT_EXCLUDES) args.push("--glob", glob);
  if (literal) args.push("--fixed-strings");
  if (!caseSensitive) args.push("--smart-case");
  return [...args, "-e", query, "--", ...roots];
}

async function listPathMatches(files: ProjectFiles, query: string): Promise<PathMatch[]> {
  return (await files.list(".")).flatMap((absolute) => {
    const path = files.display(absolute);
    const match = scorePathQueryMatch(path, query);
    return match ? [{ path, ...match }] : [];
  });
}

async function resolveSearchScope(cwd: string, path: string | undefined, files: ProjectFiles): Promise<{ roots: string[]; pathMatches: PathMatch[] }> {
  const hint = path?.trim();
  if (!hint) return { roots: ["."], pathMatches: [] };
  const resolved = candidatePath(cwd, hint);
  if (await files.fileStat(resolved) || files.request.signal.aborted) {
    return { roots: [isAbsolute(stripAtPrefix(hint)) ? resolved : displaySearchRoot(cwd, resolved)], pathMatches: [] };
  }
  const pathMatches = await listPathMatches(files, hint);
  pathMatches.sort((a, b) => b.score - a.score || pathDepth(a.path) - pathDepth(b.path) || a.path.localeCompare(b.path));
  return { roots: pathMatches.length ? pathMatches.map((match) => match.path) : ["."], pathMatches };
}

async function owningRoot(cwd: string, root: string): Promise<string | undefined> {
  const resolved = candidatePath(cwd, root);
  const stats = await stat(resolved).catch(() => undefined);
  if (!stats) return;
  let current = stats.isDirectory() ? resolved : dirname(resolved);
  while (true) {
    const [manifest, git] = await Promise.all([stat(join(current, "package.json")).catch(() => undefined), stat(join(current, ".git")).catch(() => undefined)]);
    if (manifest?.isFile() || git) return isAbsolute(root) ? current : displaySearchRoot(cwd, current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function coverageNotes(coverage: SearchCoverageDetails): string[] {
  const parts = [`${coverage.roots.length} target/relative roots`];
  if (coverage.ownerRoot) parts.push(`owning package ${coverage.ownerRoot}`);
  if (coverage.packageRoots.length) parts.push(`${coverage.packageRoots.length} imported packages`);
  return [
    `One-call coverage: ${parts.join("; ")}. Status: ${coverage.status}.`,
    `Completed roots: ${coverage.completedRoots.join(", ") || "none"}.`,
    ...(coverage.unvisitedRoots.length ? [`Unvisited or incomplete roots: ${coverage.unvisitedRoots.join(", ")}.`] : []),
    ...coverage.reasons.map((reason) => `Coverage limit: ${reason}.`),
    ...(coverage.packageRoots.length ? [`Imported packages searched: ${coverage.packageRoots.join(", ")}.`] : []),
    ...(coverage.omittedMatches ? [`Snippet retention: ${coverage.retainedMatches} retained; ${coverage.omittedMatches} omitted. Counts include all visited matching lines.`] : []),
  ];
}

async function executeSearch(params: SearchInput, cwd: string, request: SearchRequest) {
  const maxFiles = clampInt(params.max_files, 5, 1, 10);
  const maxMatches = clampInt(params.max_matches_per_file, 10, 1, 10);
  const context = params.context?.trim() || undefined;
  const intent = params.intent ?? "auto";
  const files = new ProjectFiles(cwd, request);
  const scope = await resolveSearchScope(cwd, params.path, files);
  const related = params.expand_related ? await expandRelatedFiles(cwd, scope.roots, request.signal, files) : undefined;
  const searchRoots = uniqueValues([...scope.roots, ...(related?.roots ?? [])]);
  let literal = params.literal ?? false;
  let literalFallback = false;
  let regexError: string | undefined;
  const search = async (localCwd: string, localRoots: string[], reportedRoots: string[], mapPath = normalizeRepoRelativePath, packageSearch = false) => {
    const run = await runRg(rgArgs(params.query, localRoots, literal, params.case_sensitive, packageSearch), localCwd, reportedRoots, request, (line) => request.consume(line, mapPath));
    if (!literal && run.exitCode === 2 && run.signal === null && /regex parse error:/i.test(run.error ?? "")) {
      run.kind = "validation";
      literal = true;
      literalFallback = true;
      regexError = run.error;
      await runRg(rgArgs(params.query, localRoots, true, params.case_sensitive, packageSearch), localCwd, reportedRoots, request, (line) => request.consume(line, mapPath));
    }
  };
  const searchRootsInBatches = async (roots: string[]) => {
    const relative = roots.filter((root) => !isAbsolute(root));
    for (let index = 0; index < relative.length; index += 32) {
      const batch = relative.slice(index, index + 32);
      await search(cwd, batch, batch);
    }
    for (const root of roots.filter(isAbsolute)) {
      const stats = await stat(root).catch(() => undefined);
      const localCwd = stats?.isDirectory() ? root : dirname(root);
      await search(localCwd, [stats?.isDirectory() ? "." : basename(root)], [root], (path) => displaySearchRoot(cwd, resolve(localCwd, path)));
    }
  };
  await searchRootsInBatches(searchRoots);
  const primaryRoot = scope.roots[0] ?? ".";
  const hasDefinition = [...request.files.values()].some((file) => file.definitionCount > 0);
  const needsExpansion = params.expand_related && (request.files.size === 0 || (JS_TS_EXTENSIONS.has(extname(primaryRoot)) && !hasDefinition));
  const owner = needsExpansion ? await owningRoot(cwd, primaryRoot) : undefined;
  if (owner && !searchRoots.includes(owner)) await searchRootsInBatches([owner]);
  const packages = related?.packageRoots ?? [];
  const selectedPackages = needsExpansion ? packages.slice(0, MAX_PACKAGE_SEARCH_ROOTS) : [];
  for (const pkg of selectedPackages) {
    const root = candidatePath(cwd, pkg.path);
    await search(root, ["."], [pkg.path], (path) => displaySearchRoot(cwd, resolve(root, path)), true);
  }
  const pathMatches = !params.path && request.files.size === 0 ? await listPathMatches(files, params.query) : scope.pathMatches;
  const contentRuns = request.runs.filter((run) => !run.kind || run.kind === "content");
  const omittedPackages = packages.filter((pkg) => !selectedPackages.includes(pkg));
  const reasons = uniqueValues([
    ...request.inventoryReasons, ...contentRuns.flatMap((run) => run.reason ?? run.error ?? []),
    ...(related?.unresolved.map((item) => `unresolved ${item.name} from ${item.from}`) ?? []),
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
  };
  const options = { intent, anchorPath: params.path ? primaryRoot : undefined, related };
  let ranked = rankFileGroups(request.matches, params.query, maxMatches, pathMatches, context, request.files, options);
  if (context) {
    const enriched = await enrichContext(request.matches, ranked, cwd, request.signal);
    coverage.contextRanking = {
      fileLimit: CONTEXT_LIMITS.files, readByteLimit: CONTEXT_LIMITS.readBytes, blockByteLimit: CONTEXT_LIMITS.blockBytes,
      enrichedCandidates: enriched.enrichedPaths.size, unexaminedCandidates: ranked.length - enriched.enrichedPaths.size,
    };
    ranked = rankFileGroups(enriched.matches, params.query, maxMatches, pathMatches, context, request.files, options);
    for (const file of ranked) if (file.evidence) file.evidence.contextRead = enriched.enrichedPaths.has(file.path) ? "bounded" : "unavailable";
  }
  const pathOnly = !request.files.size && !params.path && pathMatches.length > 0;
  ranked = (request.files.size ? ranked.filter((file) => request.files.has(file.path)) : pathOnly ? ranked : []).slice(0, maxFiles);
  const totalMatches = request.totalMatches + (pathOnly ? pathMatches.length : 0);
  const relatedNotes = related ? [
    `expand_related: searched ${related.roots.length} resolved ${related.label} files.`,
    ...(related.resolved.length ? [`Resolved ${related.label}s: ${related.resolved.map((item) => `${item.name} -> ${item.path}`).join(", ")}.`] : []),
    ...(related.unresolved.length ? [`Unresolved ${related.label}s: ${uniqueValues(related.unresolved.map((item) => item.name)).join(", ")}.`] : []),
  ] : [];
  const notes = [...relatedNotes, ...coverageNotes(coverage), ...(context ? [`Context ranking reads at most ${CONTEXT_LIMITS.files} candidate prefixes of ${CONTEXT_LIMITS.readBytes} bytes; unexamined candidates are marked unavailable.`] : [])];
  const details: SearchDetails = {
    query: params.query, context, intent, anchorPath: options.anchorPath, totalMatches,
    totalFiles: request.files.size || (pathOnly ? pathMatches.length : 0), returnedFiles: ranked.length,
    files: ranked.map((file) => ({ path: file.path, score: file.score, matchCount: file.matchCount, reasons: file.reasons, evidence: file.evidence, topMatch: file.matches[0] ? formatTopMatch(file.matches[0]) : undefined })),
    coverage, related, literalFallback, regexError,
  };
  let text = formatSearchResults(params.query, ranked, totalMatches, notes, undefined, related, coverage);
  if (literalFallback) text += "\n\n[agentic_search retried this as a literal string because ripgrep rejected the regex.]";
  const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (truncation.truncated) {
    const dir = await mkdtemp(join(tmpdir(), "pi-agentic-search-"));
    details.fullOutputPath = join(dir, "output.txt");
    details.truncation = truncation;
    await writeFile(details.fullOutputPath, text, "utf8");
    text = `${truncation.content}\n\n[Output truncated. Full output: ${details.fullOutputPath}]`;
  }
  return { content: [{ type: "text" as const, text }], details };
}

export default function agenticSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "agentic_search", label: "Agentic Search",
    description: `Preferred ranked search for files, classes, scopes, methods, and call sites. Use intent for definition, references, tests, or file lookup; context disambiguates ranking. Set expand_related true for Ruby/Rails mixins or JS/TS imports, owning packages, and imported packages. Check coverage before treating a miss as decisive. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Preferred ranked search for locating files, classes, scopes, methods, and call sites. Use context for natural-language disambiguation, intent for the requested evidence, and expand_related for module relationships. Inspect reported unfinished scopes when coverage is partial.",
    promptGuidelines: [
      "Prefer agentic_search over grep for locating files, classes, scopes, methods, and call sites.",
      "For agentic_search, keep query as code syntax and context as a domain hint; for example query remaining_value with context actual goal progress.",
      "For Rails scopes in a named file, use agentic_search query scope\\s+: and path event_occurrence.rb, then read the target.",
      "For Rails questions such as 'how many scopes does User have', enable agentic_search expand_related true for concerns and mixins.",
      "For JS/TS questions about imported behavior, enable agentic_search expand_related true. One agentic_search call searches the target, relative imports, owning package and resolvable imported packages, and reports unfinished work.",
      "Use agentic_search intent definition to find the declaration, references for callers, tests for test evidence, or file to prefer the navigation anchor. Auto preserves a named-file preference.",
      "If agentic_search returns a matching target, read that target first before sibling tests, migrations, git status, or additional discovery. Follow reported unvisited scopes when coverage is incomplete.",
      "A complete agentic_search miss applies only to the reported pattern and completed scopes. Partial or failed coverage requires inspecting its unvisited roots or unresolved relationships.",
    ],
    parameters: SearchParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const request = new SearchRequest(signal, undefined, undefined, { intent: params.intent, context: contextTokens(params.context) });
      try { return await executeSearch(params, ctx.cwd, request); }
      finally { request.dispose(); }
    },
    renderCall, renderResult,
  });
  pi.registerCommand("agentic-search-info", {
    description: "Show pi-agentic-search status and tool names",
    handler: async (_args, ctx) => { ctx.ui.notify("pi-agentic-search loaded: intent-aware ranking with explicit retrieval coverage.", "info"); },
  });
}

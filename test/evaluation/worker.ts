import childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../../index.ts";
import { runSearch } from "../../src/extension.ts";
import { DEFAULT_EXCLUDES, PACKAGE_SEARCH_EXCLUDES } from "../../src/classifications.ts";
import { SearchRequest } from "../../src/retrieval.ts";
import type { SearchDetails } from "../../src/types.ts";
import { percentile } from "../benchmark-cases.ts";
import { assessQuality, PinnedSource, validateCase, type EvaluationCase, type Observation, type SourcePin } from "./core.ts";
import { MODES, type Mode } from "./variants.ts";
export type { Mode } from "./variants.ts";
interface NativeMatch { path: string; lineNumber: number; line: string }
function counts(matches: NativeMatch[]): Record<string, number> {
  const lines = new Map<string, Set<number>>();
  for (const match of matches) {
    if (!lines.has(match.path)) lines.set(match.path, new Set());
    lines.get(match.path)!.add(match.lineNumber);
  }
  return Object.fromEntries([...lines].map(([path, hits]) => [path, hits.size]));
}
function nativeText(value: unknown): string {
  if (typeof value !== "object" || value === null) throw new Error("Invalid native rg JSON text");
  const item = value as Record<string, unknown>;
  if (typeof item.text === "string") return item.text;
  if (typeof item.bytes === "string") return Buffer.from(item.bytes, "base64").toString("utf8");
  throw new Error("Invalid native rg JSON text");
}
export function nativeSearch(source: PinnedSource, scenario: EvaluationCase, roots: string[], packageSearch = false, reroot = false) {
  if (!roots.length) return { matches: [], text: "", candidates: [] };
  let cwd = source.root;
  if (reroot && roots.length === 1) {
    const path = roots[0]!;
    const file = source.regularFiles.has(path);
    cwd = resolve(source.root, file ? dirname(path) : path);
    roots = [file ? basename(path) : "."];
  }
  const caseFlag = scenario.params.case_sensitive === undefined ? "--smart-case" : scenario.params.case_sensitive ? "--case-sensitive" : "--ignore-case";
  const args = ["--no-config", "--json", "--sort=path", "--hidden", caseFlag];
  if (scenario.params.literal) args.push("--fixed-strings");
  if (packageSearch) args.push("--no-ignore");
  for (const glob of packageSearch ? PACKAGE_SEARCH_EXCLUDES : DEFAULT_EXCLUDES) args.push("--glob", glob);
  args.push("-e", scenario.params.query, "--", ...roots);
  const result = childProcess.spawnSync("rg", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
  if (result.error || (result.status !== 0 && result.status !== 1) || result.signal) throw new Error("Native corpus oracle did not complete");
  // Deliberately independent of production decoding/classification: corrupt output must fail, not become a miss.
  const matches: NativeMatch[] = [];
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    let event: { type?: string; data?: { path?: unknown; lines?: unknown; line_number?: number } };
    try { event = JSON.parse(line); } catch { throw new Error("Invalid native rg JSON"); }
    if (event?.type !== "match") continue;
    const data = event.data;
    if (!data || !Number.isInteger(data.line_number) || data.line_number! < 1) throw new Error("Invalid native rg JSON match");
    const path = source.publicPath(resolve(cwd, nativeText(data.path)));
    const text = nativeText(data.lines).replace(/\r?\n$/, "");
    if (path && source.regularFiles.has(path)) matches.push({ path, lineNumber: data.line_number!, line: text });
  }
  return { matches, candidates: [...new Set(matches.map((match) => match.path))], text: matches.map((match) => `${match.path}:${match.lineNumber}:${match.line}`).join("\n") };
}
const reasonCode = (reason: string) => /budget|limit/i.test(reason) ? "budget" : /cancel|deadline/i.test(reason) ? "cancelled" : /unresolved/i.test(reason) ? "unresolved" : "reported limitation";

export async function measure(root: string, pin: SourcePin, input: EvaluationCase, mode: Mode, samples: number, phase: "cold" | "warm" = "warm") {
  const scenario = validateCase(input);
  if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error("Samples must be 1..100");
  if (!MODES.includes(mode)) throw new Error("Unsupported evaluation mode");
  if ((phase !== "cold" && phase !== "warm") || (phase === "cold" && samples !== 1)) throw new Error("Cold workers execute exactly one query");
  const source = await PinnedSource.open(root, pin);
  source.validate(scenario);
  const temporary = await mkdtemp(join(tmpdir(), "evaluation-rg-"));
  const previousConfig = process.env.RIPGREP_CONFIG_PATH;
  const originalSpawn = childProcess.spawn;
  const originalDispose = SearchRequest.prototype.dispose;
  let candidates: string[] = [];
  let matchedLineCounts: Record<string, number> = {};
  let detailsForOracle: SearchDetails | undefined;
  let queryExecutions = 0;
  let processes = 0;
  let listings = 0;
  SearchRequest.prototype.dispose = function () {
    candidates = [...this.files.keys()];
    matchedLineCounts = Object.fromEntries([...this.files].flatMap(([path, file]) => {
      const known = source.publicPath(path);
      return known && source.regularFiles.has(known) ? [[known, file.matchCount]] : [];
    }));
    return originalDispose.call(this);
  };
  childProcess.spawn = new Proxy(originalSpawn, { apply(target, receiver, args) {
    if (args[0] === "rg") { processes++; if (Array.isArray(args[1]) && args[1].includes("--files")) listings++; }
    return Reflect.apply(target, receiver, args);
  } });
  syncBuiltinESMExports();
  try {
    const config = join(temporary, "rg.conf");
    await writeFile(config, "--sort=path\n");
    process.env.RIPGREP_CONFIG_PATH = config;
    let tool: Pick<ToolDefinition, "execute"> | undefined;
    const adapter: Pick<ExtensionAPI, "registerTool" | "registerCommand"> = { registerTool(value) { tool = value; }, registerCommand() {} };
    extension(adapter as ExtensionAPI);
    if (!tool) throw new Error("Search tool not registered");
    const search = tool;
    const publicRoots = (roots: string[]) => roots.flatMap((path) => source.publicPath(path) ?? []);
    const run = async (): Promise<Observation> => {
      queryExecutions++;
      candidates = []; matchedLineCounts = {}; processes = 0; listings = 0;
      if (mode === "raw-rg") {
        const native = nativeSearch(source, scenario, [scenario.params.path ?? "."]);
        const visible = truncateHead(native.text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        const visiblePaths = [...new Set(native.matches.slice(0, visible.outputLines).map((match) => match.path))];
        return {
          candidates: native.candidates, returned: visiblePaths.slice(0, scenario.params.max_files ?? 5).map((path) => ({ path, line: native.matches.find((match) => match.path === path)!.lineNumber })),
          totalMatches: native.matches.length, oracleCandidates: native.candidates, matchedLineCounts: counts(native.matches), oracleLineCounts: counts(native.matches), outsideCorpusCandidates: 0,
          coverage: { status: "complete", completedRoots: [scenario.params.path ?? "."], unvisitedRoots: [], reasons: [] },
          retainedSnippetBytes: Buffer.byteLength(JSON.stringify(native.matches)), emittedBytes: Buffer.byteLength(visible.content), processes: 1, listings: 0,
        };
      }
      const params = { ...scenario.params,
        ...(mode === "no-context" ? { context: undefined } : {}),
        ...(mode === "no-graph" ? { expand_related: false } : {}),
      };
      const result = mode === "full" || mode === "no-context" || mode === "no-graph"
        ? await search.execute("evaluation", params, undefined, undefined, { cwd: source.root } as ExtensionContext)
        : await runSearch(params, source.root, undefined, {
          pathPriors: mode !== "no-path-priors", declarationEvidence: mode !== "no-definition-scoring", guidance: mode !== "no-guidance",
        });
      const details = result.details as SearchDetails;
      detailsForOracle = details;
      if (details.fullOutputPath) await rm(dirname(details.fullOutputPath), { recursive: true, force: true });
      const publicCandidates = candidates.flatMap((path) => {
        const known = source.publicPath(path);
        return known && source.regularFiles.has(known) ? [known] : [];
      });
      return {
        candidates: publicCandidates,
        returned: details.files.flatMap((file) => {
          const path = source.publicPath(file.path);
          return path && source.regularFiles.has(path) ? [{ path, line: file.topMatch?.lineNumber ?? 0 }] : [];
        }),
        totalMatches: details.totalMatches, oracleCandidates: [], matchedLineCounts, oracleLineCounts: {}, outsideCorpusCandidates: candidates.length - publicCandidates.length,
        coverage: { status: details.coverage.status, completedRoots: publicRoots(details.coverage.completedRoots), unvisitedRoots: publicRoots(details.coverage.unvisitedRoots), reasons: details.coverage.reasons.map(reasonCode) },
        retainedSnippetBytes: details.coverage.retainedBytes,
        emittedBytes: Buffer.byteLength(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")), processes, listings,
      };
    };
    const firstStart = performance.now();
    let observation = await run();
    const firstQueryMs = performance.now() - firstStart;
    const firstQueryCompletedUptimeMs = process.uptime() * 1000;
    const times: number[] = [];
    if (phase === "warm") for (let index = 0; index < samples; index++) {
      const start = performance.now();
      observation = await run();
      times.push(performance.now() - start);
    }
    // Oracle and source verification are outside timed query execution. Reproduce each reported policy, not just its roots.
    if (detailsForOracle) {
      const runs = detailsForOracle.coverage.runs.filter((run) => (!run.kind || run.kind === "content") && run.status === "complete");
      const oracle = runs.flatMap((run) => {
        const packageSearch = ["entry", "alias", "package"].includes(run.stage ?? "");
        const reroot = packageSearch || run.roots.some(isAbsolute);
        const query = detailsForOracle?.literalFallback ? { ...scenario, params: { ...scenario.params, literal: true } } : scenario;
        return nativeSearch(source, query, publicRoots(run.roots), packageSearch, reroot).matches;
      });
      for (const alias of detailsForOracle.related?.symbolSearches ?? []) {
        const path = source.publicPath(alias.path);
        if (!path || alias.symbol === scenario.params.query || !observation.coverage.completedRoots.some((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`))) continue;
        oracle.push(...nativeSearch(source, { ...scenario, params: { query: alias.symbol, literal: true, case_sensitive: true } }, [path], true, true).matches);
      }
      observation.oracleLineCounts = counts(oracle);
      observation.oracleCandidates = Object.keys(observation.oracleLineCounts);
    }
    return {
      scenario, mode, source: pin, observation, metrics: assessQuality(scenario, observation), firstQueryMs, firstQueryCompletedUptimeMs,
      workerPid: process.pid, queryExecutions,
      warmLatencyMs: phase === "warm" ? { samples, median: percentile(times, 0.5), p95: percentile(times, 0.95) } : null,
      workerPeakRssKiB: process.resourceUsage().maxRSS,
      emittedTokens: null, emittedTokensEstimate: Math.ceil(observation.emittedBytes / 4), tokenization: "unavailable; byte/4 estimate is not an exact token count",
    };
  } finally {
    childProcess.spawn = originalSpawn;
    SearchRequest.prototype.dispose = originalDispose;
    syncBuiltinESMExports();
    if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previousConfig;
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 128 * 1024) throw new Error("Worker input limit");
  }
  const request = JSON.parse(input) as { root: string; pin: SourcePin; scenario: EvaluationCase; mode: Mode; samples: number; phase: "cold" | "warm" };
  process.stdout.write(JSON.stringify(await measure(request.root, request.pin, request.scenario, request.mode, request.samples, request.phase)));
}

import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { assess, benchmarkCases, percentile, summarizeByIntent } from "./benchmark-cases.ts";

interface ObservedDetails {
  totalMatches: number;
  totalFiles: number;
  literalFallback?: boolean;
  files: Array<{ path: string; matchCount: number; topMatch?: { lineNumber: number } }>;
  coverage: { roots: string[]; status?: string };
}

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}
const samples = Number(option("--samples") ?? 15);
if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error("--samples must be 1..100");
const outputPath = option("--output");
const selected = benchmarkCases.filter((item) => !option("--case") || item.id.startsWith(option("--case")!));
if (selected.length === 0) throw new Error("No benchmark cases selected");

const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
let counts = { processes: 0, listings: 0 };
function countCall(args: unknown[]): void {
  if (args[0] !== "rg") return;
  counts.processes++;
  if (Array.isArray(args[1]) && args[1].includes("--files")) counts.listings++;
}
childProcess.spawn = new Proxy(originalSpawn, { apply(target, receiver, args) {
  countCall(args);
  return Reflect.apply(target, receiver, args);
} });
childProcess.execFile = new Proxy(originalExecFile, { apply(target, receiver, args) {
  countCall(args);
  return Reflect.apply(target, receiver, args);
} });
syncBuiltinESMExports();

const temp = await mkdtemp(join(tmpdir(), "agentic-search-benchmark-"));
const previousConfig = process.env.RIPGREP_CONFIG_PATH;
try {
  const { default: extension } = await import("../index.ts");
  let registered: Pick<ToolDefinition, "execute"> | undefined;
  const adapter: Pick<ExtensionAPI, "registerTool" | "registerCommand"> = {
    registerTool(tool) { registered = tool; }, registerCommand() {},
  };
  extension(adapter as ExtensionAPI);
  if (!registered) throw new Error("Search tool was not registered");
  const search = registered;
  const config = join(temp, "ripgrep.conf");
  await writeFile(config, "--sort=path\n");
  process.env.RIPGREP_CONFIG_PATH = config;
  const results = [];

  for (const scenario of selected) {
    const cwd = join(temp, scenario.id);
    for (const [path, content] of Object.entries(scenario.files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), content);
    }
    const oracleOutput = childProcess.execFileSync("rg", [
      "--no-config", "--json", "--smart-case", "-e", scenario.params.query, "--", ...scenario.requiredRoots,
    ], { cwd, encoding: "utf8" });
    const oracle = oracleOutput.split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.type === "match");
    const oracleFiles = new Set(oracle.map((event) => event.data.path.text.replace(/^\.\//, "")));
    const run = () => search.execute("benchmark", scenario.params, undefined, undefined, { cwd } as ExtensionContext);
    await run();
    const times: number[] = [];
    const processSamples = [];
    let observation: ObservedDetails | undefined;
    let emittedBytes = 0;
    for (let sample = 0; sample < samples; sample++) {
      counts = { processes: 0, listings: 0 };
      const start = performance.now();
      const result = await run();
      times.push(performance.now() - start);
      processSamples.push({ ...counts });
      observation = result.details as ObservedDetails;
      emittedBytes = Buffer.byteLength(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    }
    if (!observation) throw new Error("No observation recorded");
    const metrics = assess(observation.files.map((file) => ({ path: file.path, line: file.topMatch?.lineNumber ?? 0 })), scenario.targets);
    const checks = {
      relevantFileFirst: metrics.top1 === 1,
      relevantSpanFirst: metrics.correctFirstSpan,
      allMatchingFilesRetrieved: observation.totalFiles === oracleFiles.size,
      allMatchingLinesCounted: observation.totalMatches === oracle.length,
      requiredScopesSearched: scenario.requiredRoots.every((root) => observation.coverage.roots.includes(root)),
      effectiveRegexPreserved: !observation.literalFallback,
      ...Object.fromEntries(Object.entries(scenario.requiredCounts ?? {}).map(([path, count]) => [
        `matchCount:${path}`, observation.files.find((file) => file.path === path)?.matchCount === count,
      ])),
      ...(scenario.expectedProcesses === undefined ? {} : { processBudget: processSamples.every((sample) => sample.processes === scenario.expectedProcesses) }),
      ...(scenario.expectedListings === undefined ? {} : { listingBudget: processSamples.every((sample) => sample.listings === scenario.expectedListings) }),
    };
    results.push({
      id: scenario.id, intent: scenario.intent, query: scenario.params.query, params: scenario.params,
      relevantTargets: scenario.targets, validAlternativeTargets: [], requiredRoots: scenario.requiredRoots,
      fixtureHash: createHash("sha256").update(JSON.stringify(scenario.files)).digest("hex"),
      fixtureFiles: Object.keys(scenario.files).length,
      oracle: { matchingLines: oracle.length, matchingFiles: oracleFiles.size },
      observed: { matchingLines: observation.totalMatches, matchingFiles: observation.totalFiles, files: observation.files.map((file) => ({ path: file.path, matchCount: file.matchCount })), coverage: observation.coverage, literalFallback: Boolean(observation.literalFallback) },
      metrics, checks, passes: Object.values(checks).every(Boolean),
      warmLatencyMs: { samples, median: percentile(times, 0.5), p95: percentile(times, 0.95) },
      processCounts: { min: Math.min(...processSamples.map((sample) => sample.processes)), max: Math.max(...processSamples.map((sample) => sample.processes)) },
      repositoryListings: { min: Math.min(...processSamples.map((sample) => sample.listings)), max: Math.max(...processSamples.map((sample) => sample.listings)) },
      emittedBytes,
    });
    console.error(`${scenario.id}: ${Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name).join(", ") || "PASS"}`);
  }

  const runtimeHash = createHash("sha256");
  for (const path of ["index.ts", ...(await readdir("src", { recursive: true })).filter((path) => path.endsWith(".ts")).sort().map((path) => join("src", path))]) {
    runtimeHash.update(path).update(await readFile(path));
  }
  const report = {
    schemaVersion: 1,
    sourceRevision: childProcess.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runtimeDirty: childProcess.execFileSync("git", ["status", "--porcelain", "--", "src", "index.ts"], { encoding: "utf8" }).trim() !== "",
    runtimeHash: runtimeHash.digest("hex"),
    datasetHash: createHash("sha256").update(JSON.stringify(selected)).digest("hex"),
    environment: { node: process.version, platform: process.platform, arch: process.arch, ripgrep: childProcess.execFileSync("rg", ["--version"], { encoding: "utf8" }).split("\n")[0] },
    methodology: { warmups: 1, samples, traversal: "--sort=path through isolated RIPGREP_CONFIG_PATH; test control, not production configuration", processCounting: "Node child_process spawn/execFile proxies, no subprocess wrapper", timing: "in-process tool execution on warm filesystem, includes ranking/rendering, excludes fixture creation and oracle" },
    unavailable: ["candidate relevance recall before output slicing", "cold-cache latency", "retained/peak memory", "tokenizer-specific emitted tokens", "model effort and task success", "held-out real-project accuracy"],
    byIntent: summarizeByIntent(results),
    results,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    await mkdir(dirname(resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, json);
  } else process.stdout.write(json);
  if (args.includes("--check") && results.some((result) => !result.passes)) process.exitCode = 1;
} finally {
  childProcess.spawn = originalSpawn;
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
  else process.env.RIPGREP_CONFIG_PATH = previousConfig;
  await rm(temp, { recursive: true, force: true });
}

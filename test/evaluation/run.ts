import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { percentile } from "../benchmark-cases.ts";
import { SOURCE_PINS, summarize, validateCase, type EvaluationCase, type SourcePin } from "./core.ts";
import type { measure, Mode } from "./worker.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
export function measureFresh(root: string, pin: SourcePin, scenario: EvaluationCase, mode: Mode, samples: number, phase: "cold" | "warm") {
  const start = performance.now();
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./worker.ts", import.meta.url))], {
    cwd: repository, input: JSON.stringify({ root, pin, scenario, mode, samples, phase }), encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 180_000,
  });
  if (child.error || child.status !== 0 || child.signal) throw new Error(`Evaluation worker failed for ${scenario.id}/${mode}: ${child.error?.message ?? child.stderr}`);
  return { totalProcessMs: performance.now() - start, measurement: JSON.parse(child.stdout) as Awaited<ReturnType<typeof measure>> };
}
export async function loadCases(directory: string): Promise<EvaluationCase[]> {
  const cases: EvaluationCase[] = [];
  const ids = new Set<string>();
  for (const file of (await readdir(directory)).filter((path) => path.endsWith(".json")).sort()) {
    const values: unknown = JSON.parse(await readFile(join(directory, file), "utf8"));
    if (!Array.isArray(values)) throw new Error("Corpus files must contain case arrays");
    for (const value of values) {
      const item = validateCase(value);
      if (!Object.hasOwn(SOURCE_PINS, item.project)) throw new Error("Unknown public source project");
      if (ids.has(item.id)) throw new Error("Duplicate corpus case id");
      ids.add(item.id); cases.push(item);
    }
  }
  if (!cases.length) throw new Error("No corpus cases loaded");
  return cases;
}
async function hashFiles(paths: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) { hash.update(path); hash.update("\0"); hash.update(await readFile(join(repository, path))); }
  return hash.digest("hex");
}
function git(...args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: repository, encoding: "utf8" }).trim();
}
async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    if (!["--cache", "--samples", "--cold-samples", "--case", "--output"].includes(key) || !args[index + 1] || options.has(key)) throw new Error("Invalid evaluation arguments");
    options.set(key, args[index + 1]!);
  }
  const cache = options.get("--cache");
  if (!cache) throw new Error("Pass --cache with clean pinned pi/rails/zod checkouts; this runner never fetches or installs");
  const samples = Number(options.get("--samples") ?? "15");
  const coldSamples = Number(options.get("--cold-samples") ?? "3");
  if (![samples, coldSamples].every((number) => Number.isInteger(number) && number >= 1 && number <= 100)) throw new Error("Sample counts must be 1..100");
  const catalog = await loadCases(join(repository, "test/corpus"));
  const cases = catalog.filter((item) => !options.has("--case") || item.id === options.get("--case"));
  if (!cases.length) throw new Error("Unknown corpus case");
  const modes: Mode[] = ["raw-rg", "full"];
  const results: Array<Omit<Awaited<ReturnType<typeof measure>>, "workerPid"> & {
    freshProcessLatencyMs: { samples: number; median: number; p95: number };
    firstQueryLatencyMs: { samples: number; median: number; p95: number }; freshProcessTotalMs: number[];
  }> = [];
  for (const scenario of cases) for (const mode of modes) {
    const pin = SOURCE_PINS[scenario.project]!;
    const root = resolve(cache, scenario.project);
    const warm = measureFresh(root, pin, scenario, mode, samples, "warm").measurement;
    const cold = Array.from({ length: coldSamples }, () => measureFresh(root, pin, scenario, mode, 1, "cold"));
    const times = cold.map((row) => row.measurement.firstQueryCompletedUptimeMs);
    const queries = cold.map((row) => row.measurement.firstQueryMs);
    const { workerPid: _workerPid, ...measurement } = warm;
    results.push({ ...measurement, freshProcessLatencyMs: { samples: coldSamples, median: percentile(times, 0.5), p95: percentile(times, 0.95) },
      firstQueryLatencyMs: { samples: coldSamples, median: percentile(queries, 0.5), p95: percentile(queries, 0.95) },
      freshProcessTotalMs: cold.map((row) => row.totalProcessMs) });
    console.error(`${scenario.id}/${mode}: measured ${samples} warm and ${coldSamples} fresh-process queries`);
  }
  const report = {
    schemaVersion: 1, createdAt: new Date().toISOString(), sourceRevision: git("rev-parse", "HEAD"),
    runtimeDirty: Boolean(git("status", "--porcelain", "--", "index.ts", "src")),
    runtimeHash: await hashFiles(git("ls-files", "index.ts", "src").split("\n").filter(Boolean)),
    runnerHash: await hashFiles((await readdir(dirname(fileURLToPath(import.meta.url)))).filter((path) => path.endsWith(".ts")).map((path) => `test/evaluation/${path}`)),
    datasetHash: createHash("sha256").update(JSON.stringify({ sources: SOURCE_PINS, cases: catalog })).digest("hex"),
    environment: { node: process.version, os: platform(), arch: arch(), rg: execFileSync("rg", ["--version"], { encoding: "utf8" }).split("\n")[0] },
    methodology: {
      corpus: "Manually labeled revision-pinned public navigation cases, not a representative accuracy estimate. Holdout labels are not used for tuning.",
      warm: "One warmup, then timed queries including observation capture; excludes source validation and independent native oracle.",
      firstQuery: "First query in each fresh worker, including observation capture but excluding loader, harness validation and oracle. Filesystem caches are not flushed.",
      freshProcess: "Node process uptime through its first query, including loader/SDK and harness validation. Exactly one query; excludes oracle and result serialization. Filesystem caches are not flushed.",
      freshProcessTotal: "Parent-observed process lifetime, including validation, oracle and JSON transfer; not single-query latency.",
      memory: "Worker lifetime peak RSS includes loader, validation, instrumentation and oracle; excludes rg child RSS. Retained snippet bytes are serialized content, not heap size.",
      tokens: "This runner has no configured tokenizer. Emitted tokens unavailable; byte/4 is an explicitly labeled estimate, not billing usage.",
      relevance: "File recall uses distinct labeled targets/alternatives. MRR uses the returned shortlist (default five files). Positive ranking metrics exclude negative cases; valid-miss rate uses negatives only. Both denominators are reported.",
      completeness: "Compare candidates and per-file matching-line counts to an independent native decoder in reported completed public scopes, reproducing target/package ignore policy and scoped aliases. Required-root coverage is a separate geometric metric, not proof of task success.",
      unavailable: ["cold filesystem-cache latency", "rg child peak memory", "tokenizer-exact emitted tokens"],
    },
    byMode: Object.fromEntries(modes.map((mode) => [mode, summarize(results.filter((row) => row.mode === mode))])), results,
  };
  const output = resolve(options.get("--output") ?? join(repository, "docs/benchmarks/evaluation.json"));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`Evaluation report written to ${output}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

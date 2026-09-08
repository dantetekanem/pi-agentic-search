import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { assessQuality, PinnedSource, summarize, validateCase, type EvaluationCase, type Observation, type SourcePin } from "./evaluation/core.ts";
import { measure, type Mode } from "./evaluation/worker.ts";
import { loadCases, measureFresh } from "./evaluation/run.ts";
import { assertComparisons, parseModes } from "./evaluation/variants.ts";
import { runSearch } from "../src/extension.ts";

const scenario: EvaluationCase = {
  id: "example", project: "fixture", split: "development", task: "Locate needle's definition.",
  params: { query: "needle", intent: "definition" },
  targets: [{ path: "target.ts", startLine: 2, endLine: 4 }], alternatives: [], requiredRoots: ["."],
};
function observation(changes: Partial<Observation> = {}): Observation {
  return { candidates: ["target.ts"], returned: [{ path: "target.ts", line: 2 }], totalMatches: 1,
    coverage: { status: "complete", completedRoots: ["."], unvisitedRoots: [], reasons: [] },
    oracleCandidates: ["target.ts"], matchedLineCounts: { "target.ts": 1 }, oracleLineCounts: { "target.ts": 1 },
    outsideCorpusCandidates: 0, retainedSnippetBytes: 0, emittedBytes: 0,
    processes: 1, listings: 0, ...changes };
}

test("candidate recall is independent of the displayed shortlist", () => {
  const metrics = assessQuality(scenario, observation({ candidates: ["other.ts", "target.ts"], returned: [{ path: "other.ts", line: 1 }] }));
  assert.equal(metrics.candidateRecall, 1);
  assert.equal(metrics.recallAt5, 0);
  assert.equal(metrics.top1, 0);
  assert.equal(metrics.mrr, 0);
  assert.equal(metrics.correctFirstSpan, false);
});

test("span ranges and valid alternatives count without duplicating relevant files", () => {
  const item = { ...scenario, alternatives: [{ path: "target.ts", startLine: 20, endLine: 23 }] };
  const metrics = assessQuality(item, observation({ returned: [{ path: "target.ts", line: 22 }] }));
  assert.equal(metrics.top1, 1);
  assert.equal(metrics.recallAt5, 1);
  assert.equal(metrics.correctFirstSpan, true);
});

test("only an actually completed negative is a valid miss", () => {
  const negative = { ...scenario, targets: [] };
  const empty = observation({ candidates: [], returned: [], totalMatches: 0, oracleCandidates: [], matchedLineCounts: {}, oracleLineCounts: {} });
  assert.equal(assessQuality(negative, empty).validMiss, true);
  assert.equal(assessQuality(negative, empty).top1, null);
  assert.equal(assessQuality(negative, { ...empty, coverage: { ...empty.coverage, status: "partial" } }).validMiss, false);
  assert.equal(assessQuality(negative, { ...empty, oracleCandidates: ["missed.ts"] }).validMiss, false);
});

test("missing candidates in a claimed completed scope are completeness errors", () => {
  const metrics = assessQuality(scenario, observation({ candidates: [], returned: [], totalMatches: 0 }));
  assert.equal(metrics.completenessError, true);
  assert.equal(metrics.falseMiss, true);
  const partial = assessQuality(scenario, observation({ candidates: [], returned: [], coverage: { status: "partial", completedRoots: [], unvisitedRoots: ["."], reasons: ["budget"] } }));
  assert.equal(partial.completenessError, false);
  assert.equal(partial.requiredCoverage, false);
});

test("losing a matching line is detected even when the file was retrieved", () => {
  const metrics = assessQuality(scenario, observation({ oracleLineCounts: { "target.ts": 2 } }));
  assert.equal(metrics.candidateRecall, 1);
  assert.equal(metrics.completenessError, true);
});

test("metrics stay separated by intent and development/holdout split", () => {
  const report = summarize([
    { scenario, metrics: assessQuality(scenario, observation()) },
    { scenario: { ...scenario, split: "holdout" }, metrics: assessQuality(scenario, observation({ returned: [{ path: "other.ts", line: 1 }] })) },
  ]);
  assert.equal(report.development?.definition?.top1, 1);
  assert.equal(report.holdout?.definition?.top1, 0);
});

test("variant selection preserves defaults and rejects unknown, repeated or empty modes", () => {
  assert.deepEqual(parseModes(), ["raw-rg", "full"]);
  assert.deepEqual(parseModes("full,no-guidance"), ["full", "no-guidance"]);
  for (const input of ["unknown", "full,full", ""]) assert.throws(() => parseModes(input), /Invalid evaluation modes/);
});

test("comparison gates preserve defaults, labels, candidate pools and guidance rankings", () => {
  const base = { scenario, mode: "full" as const, observation: observation(), metrics: assessQuality(scenario, observation()) };
  assert.doesNotThrow(() => assertComparisons([base, { ...base, mode: "no-context" }], [base]));
  assert.throws(() => assertComparisons([{ ...base, metrics: { ...base.metrics, top1: 0 } }], [base]), /default metrics/);
  assert.throws(() => assertComparisons([{ ...base, scenario: { ...scenario, task: "Changed label" } }], [base]), /labels/);
  const different = observation({ candidates: [] });
  assert.throws(() => assertComparisons([base, { ...base, mode: "no-context", observation: different }], [base]), /candidate pool/);
  assert.throws(() => assertComparisons([base, { ...base, mode: "no-guidance", observation: observation({ returned: [] }) }], [base]), /guidance ranking/);
  assert.throws(() => assertComparisons([base, { ...base, mode: "no-graph", observation: different }], [base]), /candidate pool/);
  const graphCase = { ...scenario, params: { ...scenario.params, path: "anchor.ts", expand_related: true } };
  const graphBase = { ...base, scenario: graphCase };
  const anchorOnly = observation({ candidates: [], returned: [], totalMatches: 0, matchedLineCounts: {}, oracleLineCounts: {}, oracleCandidates: [],
    coverage: { status: "complete", completedRoots: ["anchor.ts"], unvisitedRoots: [], reasons: [] } });
  assert.doesNotThrow(() => assertComparisons([graphBase, { ...graphBase, mode: "no-graph", observation: anchorOnly, metrics: assessQuality(graphCase, anchorOnly) }], [graphBase]));
  assert.throws(() => assertComparisons([], [base]), /missing full/);
});

test("corpus validation rejects unsupported intents and unsafe source paths", () => {
  assert.deepEqual(validateCase(scenario), scenario);
  assert.throws(() => validateCase({ ...scenario, params: { query: "needle", intent: "caller/reference" } }));
  assert.throws(() => validateCase({ ...scenario, params: { query: "needle", path: "../private" } }));
  assert.throws(() => validateCase({ ...scenario, targets: [{ path: "/private/code.ts", startLine: 1, endLine: 2 }] }));
  assert.throws(() => validateCase({ ...scenario, targets: [{ path: "target.ts", startLine: 4, endLine: 2 }] }));
});

async function repository(files: Record<string, string>, run: (root: string, pin: SourcePin) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "evaluation-source-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  try {
    git("init", "--quiet");
    git("remote", "add", "origin", "https://github.com/fixture/public.git");
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    await symlink("/private/never-read-this", join(root, "link.ts"));
    git("add", ".");
    git("-c", "user.name=Evaluation fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
    await run(root, { repository: "fixture/public", revision: git("rev-parse", "HEAD").trim() });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("pinned reads use committed blobs and reject symlinks and escaping paths", () => repository({ "target.ts": "export const needle = 1;\n" }, async (root, pin) => {
  const source = await PinnedSource.open(root, pin);
  await writeFile(join(root, "target.ts"), "private working-tree changes\n");
  assert.equal(source.read("target.ts"), "export const needle = 1;\n");
  assert.throws(() => source.read("link.ts"));
  assert.throws(() => source.read("../private.ts"));
  assert.throws(() => source.read("untracked.ts"));
  await assert.rejects(PinnedSource.open(root, pin), /dirty/);
}));

test("wrong revisions and ignored untracked files cannot masquerade as a pinned clean source", () => repository({ "target.ts": "needle\n", ".gitignore": "*.secret\n" }, async (root, pin) => {
  await assert.rejects(PinnedSource.open(root, { ...pin, revision: "0".repeat(40) }), /revision/);
  await writeFile(join(root, "private.secret"), "not public\n");
  await assert.rejects(PinnedSource.open(root, pin), /untracked/);
}));

test("measurement exercises the real tool and keeps candidates before max_files", () => repository({
  "target.ts": "export function needle() {}\n", "other.ts": "needle();\n",
}, async (root, pin) => {
  const item = { ...scenario, params: { query: "needle", intent: "definition" as const, max_files: 1 }, targets: [{ path: "target.ts", startLine: 1, endLine: 1 }] };
  const full = await measure(root, pin, item, "full", 2);
  assert.equal(full.observation.candidates.length, 2);
  assert.equal(full.observation.returned.length, 1);
  assert.equal(full.observation.processes, 1);
  assert.equal(full.observation.listings, 0);
  assert.equal(full.metrics.candidateRecall, 1);
  assert.deepEqual(full.observation.oracleLineCounts, { "other.ts": 1, "target.ts": 1 });
  assert.deepEqual(full.observation.matchedLineCounts, full.observation.oracleLineCounts);
  assert.ok(full.warmLatencyMs);
  assert.equal(full.warmLatencyMs.samples, 2);
  assert.ok(full.workerPeakRssKiB > 0);
  assert.ok(full.observation.retainedSnippetBytes > 0);
  assert.equal(full.emittedTokens, null);
  assert.equal(full.emittedTokensEstimate, Math.ceil(full.observation.emittedBytes / 4));
  const raw = await measure(root, pin, item, "raw-rg", 2);
  assert.equal(raw.observation.candidates.length, 2);
  assert.equal(raw.observation.returned[0]?.path, "other.ts");
}));

test("raw shortlist contains only files visible inside the output line limit", () => repository({
  "a.ts": "needle\n".repeat(2001), "target.ts": "export const needle = 1;\n",
}, async (root, pin) => {
  const item = { ...scenario, targets: [{ path: "target.ts", startLine: 1, endLine: 1 }] };
  const raw = await measure(root, pin, item, "raw-rg", 1);
  assert.equal(raw.metrics.candidateRecall, 1);
  assert.equal(raw.metrics.recallAt5, 0);
  assert.deepEqual(raw.observation.returned.map((file) => file.path), ["a.ts"]);
}));

test("fresh-process samples execute exactly one query in a different process", () => repository({ "target.ts": "export const needle = 1;\n" }, async (root, pin) => {
  const item = { ...scenario, targets: [{ path: "target.ts", startLine: 1, endLine: 1 }] };
  const fresh = measureFresh(root, pin, item, "full", 1, "cold");
  assert.ok(Number.isInteger(fresh.measurement.workerPid));
  assert.notEqual(fresh.measurement.workerPid, process.pid);
  assert.equal(fresh.measurement.queryExecutions, 1);
  assert.equal(fresh.measurement.warmLatencyMs, null);
  assert.ok(fresh.totalProcessMs >= fresh.measurement.firstQueryCompletedUptimeMs);
  assert.ok(fresh.measurement.firstQueryCompletedUptimeMs >= fresh.measurement.firstQueryMs);
}));

test("catalog loading accepts only known public projects and unique case identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-catalog-"));
  const item = { ...scenario, project: "pi" };
  try {
    await writeFile(join(root, "one.json"), JSON.stringify([item]));
    assert.deepEqual(await loadCases(root), [item]);
    await writeFile(join(root, "two.json"), JSON.stringify([item]));
    await assert.rejects(loadCases(root), /Duplicate/);
    await writeFile(join(root, "two.json"), JSON.stringify([{ ...item, id: "other", project: "constructor" }]));
    await assert.rejects(loadCases(root), /Unknown public source/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a malformed native oracle cannot manufacture a completed miss", () => repository({ "target.ts": "needle\n" }, async (root, pin) => {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = new Proxy(original, { apply(target, receiver, args) {
    if (args[0] === "rg") return { status: 0, signal: null, stdout: '{"type":"match","data":{}}\n', stderr: "" };
    return Reflect.apply(target, receiver, args);
  } });
  try {
    const item = { ...scenario, targets: [{ path: "target.ts", startLine: 1, endLine: 1 }] };
    await assert.rejects(measure(root, pin, item, "raw-rg", 1), /native.*JSON/i);
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
}));

const ablations: Array<{ mode: Mode; files: Record<string, string>; params: EvaluationCase["params"]; target: string; other: string; line?: number }> = [
  { mode: "no-path-priors", files: { "src/z.ts": "needle();\n", "a.test.ts": "needle();\n" }, params: { query: "needle", intent: "auto" }, target: "src/z.ts", other: "a.test.ts" },
  { mode: "no-context", files: { "a.ts": "// retail\nneedle();\n", "z.ts": "// wholesale\nneedle();\n" }, params: { query: "needle", context: "wholesale", intent: "definition" }, target: "z.ts", other: "a.ts", line: 2 },
  { mode: "no-definition-scoring", files: { "src/a.ts": "needle();\n", "src/z.ts": "export function needle() {}\n" }, params: { query: "needle", intent: "definition" }, target: "src/z.ts", other: "src/a.ts" },
  { mode: "no-graph", files: { "main.ts": "import { needle } from './impl.ts';\nneedle();\n", "impl.ts": "export function needle() {}\n" }, params: { query: "needle", literal: true, path: "main.ts", intent: "definition", expand_related: true }, target: "impl.ts", other: "main.ts" },
];
for (const example of ablations) test(`${example.mode} removes only the named contribution`, () => repository(example.files, async (root, pin) => {
  const line = example.line ?? 1;
  const item = { ...scenario, params: example.params, targets: [{ path: example.target, startLine: line, endLine: line }], requiredRoots: Object.keys(example.files) };
  const full = await measure(root, pin, item, "full", 1);
  const disabled = await measure(root, pin, item, example.mode, 1);
  assert.equal(full.observation.returned[0]?.path, example.target);
  assert.equal(disabled.observation.returned[0]?.path, example.other);
  if (example.mode === "no-graph") {
    assert.equal(disabled.metrics.requiredCoverage, false);
    assert.deepEqual(disabled.observation.candidates, ["main.ts"]);
  } else {
    assert.deepEqual([...disabled.observation.candidates].sort(), [...full.observation.candidates].sort());
    assert.deepEqual(disabled.observation.matchedLineCounts, full.observation.matchedLineCounts);
  }
}));

test("guidance ablation preserves retrieval and ranking while reducing emitted instructions", () => repository({ "target.ts": "export function needle() {}\n" }, async (root, pin) => {
  const item = { ...scenario, targets: [{ path: "target.ts", startLine: 1, endLine: 1 }] };
  const full = await measure(root, pin, item, "full", 1);
  const disabled = await measure(root, pin, item, "no-guidance", 1);
  assert.deepEqual(disabled.metrics, full.metrics);
  assert.deepEqual(disabled.observation.returned, full.observation.returned);
  assert.deepEqual(disabled.observation.matchedLineCounts, full.observation.matchedLineCounts);
  assert.ok(disabled.observation.emittedBytes < full.observation.emittedBytes);
  const signal = AbortSignal.abort("evaluation cancellation");
  const interrupted = await runSearch(item.params, root, signal);
  const unguided = await runSearch(item.params, root, signal, { guidance: false });
  assert.equal(unguided.details.coverage.status, "partial");
  assert.deepEqual(unguided.details.files, interrupted.details.files);
  assert.ok(Buffer.byteLength(unguided.content[0]!.text) < Buffer.byteLength(interrupted.content[0]!.text));
}));

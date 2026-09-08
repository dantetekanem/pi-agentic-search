import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { assessQuality, PinnedSource, summarize, validateCase, type EvaluationCase, type Observation, type SourcePin } from "./evaluation/core.ts";
import { measure } from "./evaluation/worker.ts";
import { loadCases, measureFresh } from "./evaluation/run.ts";

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

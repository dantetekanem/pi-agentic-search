import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export interface SourcePin { repository: string; revision: string }
export const SOURCE_PINS: Record<string, SourcePin> = {
  pi: { repository: "earendil-works/pi", revision: "b2602be77cb7b0de45dd616407fd210daa48aa75" },
  rails: { repository: "rails/rails", revision: "e970c80fd668f3f4ee08201bbbbcadfb2f29b1df" },
  zod: { repository: "colinhacks/zod", revision: "804e0f522747345d6b37581888899be420baa3e9" },
};
const Span = Type.Object({ path: Type.String(), startLine: Type.Integer({ minimum: 1 }), endLine: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const Intent = Type.Union([Type.Literal("definition"), Type.Literal("references"), Type.Literal("tests"), Type.Literal("file"), Type.Literal("auto")]);
const CaseSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }), project: Type.String({ minLength: 1, maxLength: 32 }),
  split: Type.Union([Type.Literal("development"), Type.Literal("holdout")]), task: Type.String({ minLength: 1, maxLength: 1000 }),
  params: Type.Object({
    query: Type.String({ minLength: 1, maxLength: 512 }), path: Type.Optional(Type.String()), context: Type.Optional(Type.String({ maxLength: 512 })),
    intent: Type.Optional(Intent), literal: Type.Optional(Type.Boolean()), case_sensitive: Type.Optional(Type.Boolean()), expand_related: Type.Optional(Type.Boolean()),
    max_files: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })), max_matches_per_file: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  }, { additionalProperties: false }),
  targets: Type.Array(Span, { maxItems: 100 }), alternatives: Type.Array(Span, { maxItems: 100 }),
  requiredRoots: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });
export type EvaluationCase = Static<typeof CaseSchema>;
export function safePath(path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path) || /^[a-z]:/i.test(path) || path.split("/").includes("..")) throw new Error("Unsafe source path");
  return posix.normalize(path).replace(/\/$/, "") || ".";
}
export function validateCase(value: unknown): EvaluationCase {
  if (!Value.Check(CaseSchema, value)) throw new Error("Invalid evaluation case schema");
  if (value.params.path) safePath(value.params.path);
  for (const root of value.requiredRoots) safePath(root);
  for (const span of [...value.targets, ...value.alternatives]) {
    safePath(span.path);
    if (span.endLine < span.startLine) throw new Error("Invalid span range");
  }
  return value;
}

export class PinnedSource {
  readonly regularFiles = new Set<string>();
  private constructor(readonly root: string, readonly pin: SourcePin) {}
  private git(...args: string[]): string {
    return execFileSync("git", ["--no-pager", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd: this.root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  }
  static async open(root: string, pin: SourcePin): Promise<PinnedSource> {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(pin.repository) || !/^[a-f0-9]{40}$/.test(pin.revision)) throw new Error("Invalid source pin");
    const source = new PinnedSource(await realpath(root), pin);
    if (source.git("rev-parse", "HEAD").trim() !== pin.revision) throw new Error("Source revision mismatch");
    const remote = source.git("config", "--get", "remote.origin.url").trim().replace(/\.git$/, "");
    if (remote !== `https://github.com/${pin.repository}`) throw new Error("Source repository mismatch");
    if (source.git("status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all").trim()) throw new Error("Source checkout is dirty");
    // Include ignored untracked files: a private ignored file is not public source.
    if (source.git("ls-files", "--others", "-z")) throw new Error("Source has untracked files");
    for (const entry of source.git("ls-tree", "-rz", "--full-tree", pin.revision).split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab >= 0 && /^100(?:644|755) blob /.test(entry)) source.regularFiles.add(entry.slice(tab + 1));
    }
    return source;
  }
  hasScope(path: string): boolean {
    const normalized = safePath(path);
    return normalized === "." || this.regularFiles.has(normalized) || [...this.regularFiles].some((file) => file.startsWith(`${normalized}/`));
  }
  publicPath(path: string): string | undefined {
    const normalized = relative(this.root, resolve(this.root, path)).replaceAll("\\", "/") || ".";
    try { return this.hasScope(normalized) ? normalized : undefined; } catch { return undefined; }
  }
  read(path: string): string {
    const normalized = safePath(path);
    if (!this.regularFiles.has(normalized)) throw new Error("Not a pinned regular source file");
    return this.git("show", "--no-ext-diff", "--no-textconv", `${this.pin.revision}:${normalized}`);
  }
  validate(scenario: EvaluationCase): void {
    for (const root of [scenario.params.path ?? ".", ...scenario.requiredRoots]) if (!this.hasScope(root)) throw new Error(`Unknown corpus scope: ${root}`);
    for (const span of [...scenario.targets, ...scenario.alternatives]) {
      if (span.endLine > this.read(span.path).split("\n").length) throw new Error(`Span outside pinned source: ${span.path}`);
    }
  }
}

export interface Observation {
  candidates: string[];
  returned: Array<{ path: string; line: number }>;
  totalMatches: number;
  coverage: { status: "complete" | "partial" | "failed"; completedRoots: string[]; unvisitedRoots: string[]; reasons: string[] };
  oracleCandidates: string[];
  matchedLineCounts: Record<string, number>;
  oracleLineCounts: Record<string, number>;
  outsideCorpusCandidates: number;
  retainedSnippetBytes: number;
  emittedBytes: number;
  processes: number;
  listings: number;
}
const covers = (scope: string, path: string) => scope === "." || scope === path || path.startsWith(`${scope}/`);
export function assessQuality(scenario: EvaluationCase, result: Observation) {
  const relevant = [...scenario.targets, ...scenario.alternatives];
  const paths = new Set(relevant.map((span) => span.path));
  const rank = result.returned.findIndex((file) => paths.has(file.path));
  const first = result.returned[0];
  const recall = (visited: string[]) => paths.size ? [...paths].filter((path) => visited.includes(path)).length / paths.size : null;
  const completed = result.coverage.completedRoots.map(safePath);
  const requiredCoverage = scenario.requiredRoots.every((root) => completed.some((scope) => covers(scope, safePath(root))));
  const incompleteClaim = result.coverage.unvisitedRoots.length > 0 || result.coverage.reasons.length > 0 ||
    result.oracleCandidates.some((path) => completed.some((scope) => covers(scope, path)) && !result.candidates.includes(path)) ||
    Object.entries(result.oracleLineCounts).some(([path, count]) => completed.some((scope) => covers(scope, path)) && count > (result.matchedLineCounts[path] ?? 0));
  const complete = result.coverage.status === "complete" && !incompleteClaim;
  return {
    candidateRecall: recall(result.candidates), recallAt5: recall(result.returned.slice(0, 5).map((file) => file.path)),
    top1: paths.size ? Number(rank === 0) : null, mrr: paths.size ? rank < 0 ? 0 : 1 / (rank + 1) : null,
    correctFirstSpan: paths.size ? Boolean(first && relevant.some((span) => span.path === first.path && first.line >= span.startLine && first.line <= span.endLine)) : null,
    validMiss: paths.size ? null : complete && requiredCoverage && result.totalMatches === 0 && result.oracleCandidates.length === 0,
    falseMiss: paths.size ? result.returned.length === 0 : null,
    completenessError: result.coverage.status === "complete" && incompleteClaim,
    requiredCoverage,
  };
}
export type QualityMetrics = ReturnType<typeof assessQuality>;
export function summarize(rows: Array<{ scenario: EvaluationCase; metrics: QualityMetrics }>) {
  const groups: Record<string, Record<string, Array<QualityMetrics>>> = {};
  for (const { scenario, metrics } of rows) ((groups[scenario.split] ??= {})[scenario.params.intent ?? "auto"] ??= []).push(metrics);
  return Object.fromEntries(Object.entries(groups).map(([split, intents]) => [split, Object.fromEntries(Object.entries(intents).map(([intent, metrics]) => {
    const averages: Record<string, number | null> = {
      cases: metrics.length, positiveCases: metrics.filter((row) => row.top1 !== null).length,
      negativeCases: metrics.filter((row) => row.validMiss !== null).length,
    };
    for (const key of Object.keys(metrics[0]!) as Array<keyof QualityMetrics>) {
      const values = metrics.flatMap((row) => row[key] === null ? [] : [Number(row[key])]);
      averages[key] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    }
    return [intent, averages];
  }))]));
}

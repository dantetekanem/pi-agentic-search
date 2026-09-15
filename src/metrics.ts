import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RubyIndex } from "./adapters/ruby-index.ts";
import type { Language, SparsityEdge, SparsityNode } from "./sparsity.ts";

export interface RunMetrics {
  kind: "sparsity_scan" | "sparsity_collect";
  at: string;
  cwd: string;
  label: string;
  head?: string;
  elapsedMs: number;
  setupMs?: number;
  rgCalls: number;
  truncatedBy: string;
  files?: { total: number; code: number; test: number; generated: number; other: number };
  anchors?: { expanded: number; skipped: number };
  nodes: number;
  edges: number;
  resolution: Record<string, number>;
  via: Record<string, number>;
  unresolvedRate: number;
  byLanguage: Record<string, { edges: number; unresolved: number; external: number }>;
  tokens?: { inline: number; spilled: number };
  index: Array<{ root: string; files: number; definitions: number; cacheHit: boolean; builtMs: number; skipped?: string }>;
  programs: Array<{ config: string; roots: number; files: number; ms: number }>;
}

function count<T extends string>(values: Array<T | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) if (value) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export function edgeMetrics(nodes: SparsityNode[], edges: SparsityEdge[]): Pick<RunMetrics, "resolution" | "via" | "unresolvedRate" | "byLanguage"> {
  const languageOf = new Map<string, Language>(nodes.map((node) => [node.id, node.language]));
  const byLanguage: RunMetrics["byLanguage"] = {};
  for (const edge of edges) {
    const language = languageOf.get(edge.from) ?? "unknown";
    const bucket = (byLanguage[language] ??= { edges: 0, unresolved: 0, external: 0 });
    bucket.edges += 1;
    if (edge.resolution === "unresolved") bucket.unresolved += 1;
    if (edge.resolution === "external") bucket.external += 1;
  }
  const unresolved = edges.filter((edge) => edge.resolution === "unresolved").length;
  return {
    resolution: count(edges.map((edge) => edge.resolution)),
    via: count(edges.map((edge) => edge.via)),
    unresolvedRate: edges.length ? Number((unresolved / edges.length).toFixed(3)) : 0,
    byLanguage,
  };
}

export function indexMetrics(indexes: Iterable<RubyIndex>): RunMetrics["index"] {
  return [...indexes].map((index) => ({ root: index.root, files: index.fileCount, definitions: index.definitions.length, cacheHit: index.cacheHit, builtMs: index.builtMs, skipped: index.skipped }));
}

export async function appendMetricsLine(logPath: string, metrics: RunMetrics): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  await appendFile(logPath, `${JSON.stringify(metrics)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function writeMetrics(metrics: RunMetrics, jsonPath: string, logPath?: string): Promise<void> {
  await mkdir(dirname(jsonPath), { recursive: true, mode: 0o700 });
  await writeFile(jsonPath, `${JSON.stringify(metrics, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (logPath) {
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    await appendFile(logPath, `${JSON.stringify(metrics)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export async function summarizeMetrics(logPath: string, last = 20): Promise<string> {
  let lines: string[];
  try {
    lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
  } catch {
    return `No sparsity runs recorded yet (${logPath}).`;
  }
  const runs = lines.slice(-last).flatMap((line) => {
    try {
      return [JSON.parse(line) as RunMetrics];
    } catch {
      return [];
    }
  });
  if (!runs.length) return `No readable sparsity runs in ${logPath}.`;
  const scanRuns = runs.filter((run) => run.kind === "sparsity_scan");
  const collectRuns = runs.filter((run) => run.kind === "sparsity_collect");
  const indexes = runs.flatMap((run) => run.index);
  const hits = indexes.filter((index) => index.cacheHit).length;
  const languages = new Map<string, { edges: number; unresolved: number }>();
  for (const run of runs) {
    for (const [language, bucket] of Object.entries(run.byLanguage)) {
      const total = languages.get(language) ?? { edges: 0, unresolved: 0 };
      total.edges += bucket.edges;
      total.unresolved += bucket.unresolved;
      languages.set(language, total);
    }
  }
  const perLanguage = [...languages.entries()].map(([language, total]) => `${language} ${total.edges ? Math.round((total.unresolved / total.edges) * 100) : 0}% unresolved`).join(", ");
  return [
    `sparsity: ${scanRuns.length} scan run${scanRuns.length === 1 ? "" : "s"}, ${collectRuns.length} collect run${collectRuns.length === 1 ? "" : "s"} (last ${runs.length})`,
    `median scan run ${median(scanRuns.map((run) => run.elapsedMs))} ms, ${median(scanRuns.map((run) => run.anchors?.expanded ?? 0))} anchors, ${median(scanRuns.map((run) => run.edges))} edges, ${median(scanRuns.map((run) => Math.round(run.unresolvedRate * 100)))}% unresolved`,
    `Ruby lookup cache hits ${hits}/${indexes.length}; ${perLanguage || "no edges"}`,
    `median inline ${median(scanRuns.map((run) => run.tokens?.inline ?? 0))} tokens, spilled ${median(scanRuns.map((run) => run.tokens?.spilled ?? 0))} tokens`,
  ].join("\n");
}

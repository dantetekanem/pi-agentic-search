import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { clampInt } from "./shared.ts";
import { collectSparsity } from "./sparsity.ts";
import { scanSparsity } from "./sparsity-scan.ts";

interface ContextInput {
  max_depth?: number;
  vicinity_check?: number;
  max_nodes?: number;
  root?: string;
  budget_ms?: number;
}
export interface CollectInput extends ContextInput {
  target: string;
  callers?: boolean;
}
export interface ScanInput extends ContextInput {
  diff?: string;
  anchors?: string[];
  max_anchors?: number;
  inline_budget_kb?: number;
}
export interface ContextRuntime {
  indexCacheDir?: string;
  metricsLog?: string;
  signal?: AbortSignal;
}

export async function repositoryCwd(requested: unknown, fallback: string): Promise<string> {
  if (typeof requested !== "string" || !requested.trim()) return fallback;
  const resolved = resolve(requested.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  const stats = await stat(resolved).catch(() => undefined);
  if (!stats?.isDirectory()) throw new Error(`cwd is not a directory: ${requested}`);
  return resolved;
}

export function collectContext(params: CollectInput, cwd: string, runtime: ContextRuntime = {}) {
  return collectSparsity({
    cwd,
    target: params.target,
    maxDepth: clampInt(params.max_depth, 3, 1, 4),
    vicinity: clampInt(params.vicinity_check, 20, 5, 60),
    maxNodes: clampInt(params.max_nodes, 24, 2, 60),
    root: typeof params.root === "string" && params.root.trim() ? params.root.trim() : undefined,
    callers: params.callers ?? true,
    budgetMs: clampInt(params.budget_ms, 20_000, 2_000, 60_000),
    ...runtime,
  });
}

export function scanContext(params: ScanInput, cwd: string, outputDir: string, runtime: ContextRuntime = {}) {
  return scanSparsity({
    cwd,
    diff: typeof params.diff === "string" ? params.diff : "worktree",
    anchors: Array.isArray(params.anchors) && params.anchors.length ? params.anchors.map(String) : undefined,
    maxDepth: clampInt(params.max_depth, 2, 1, 4),
    vicinity: clampInt(params.vicinity_check, 20, 5, 60),
    maxNodes: clampInt(params.max_nodes, 120, 2, 300),
    maxAnchors: clampInt(params.max_anchors, 60, 1, 200),
    root: typeof params.root === "string" && params.root.trim() ? params.root.trim() : undefined,
    budgetMs: clampInt(params.budget_ms, 30_000, 2_000, 120_000),
    outputDir,
    inlineBudgetBytes: clampInt(params.inline_budget_kb, 40, 4, 48) * 1024,
    ...runtime,
  });
}

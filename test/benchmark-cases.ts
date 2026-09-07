export interface Target { path: string; line: number }
export interface BenchmarkCase {
  id: string;
  intent: "definition" | "references" | "file";
  files: Record<string, string>;
  params: { query: string; path?: string; max_files?: number; intent?: string };
  targets: Target[];
  requiredRoots: string[];
  requiredCounts?: Record<string, number>;
  expectedProcesses?: number;
  expectedListings?: number;
}

export function assess(returned: Target[], relevant: Target[]) {
  const paths = new Set(relevant.map((target) => target.path));
  const rank = returned.findIndex((target) => paths.has(target.path));
  return {
    top1: rank === 0 ? 1 : 0,
    reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1),
    recallAt5: paths.size === 0 ? 0 : new Set(returned.slice(0, 5).filter((target) => paths.has(target.path)).map((target) => target.path)).size / paths.size,
    correctFirstSpan: relevant.some((target) => target.path === returned[0]?.path && target.line === returned[0]?.line),
  };
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) throw new Error("Cannot compute a percentile of empty samples");
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]!;
}

const lateFiles = Object.fromEntries(Array.from({ length: 205 }, (_, index) => [
  `src/${String(index + 1).padStart(3, "0")}.ts`,
  index === 199 ? "const intermediate = needle();\nneedle();\n" : "needle();\n",
]));
lateFiles["src/zzz-needle.ts"] = "export function needle() {}\n";

const ambiguousFiles = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
  `widgets/${index + 1}/widget.ts`, index === 5 ? "export const needle = 1;\n" : "export const other = 1;\n",
]));

export const benchmarkCases: BenchmarkCase[] = [
  {
    id: "late-definition", intent: "definition", files: lateFiles,
    params: { query: "needle", max_files: 10, intent: "definition" },
    targets: [{ path: "src/zzz-needle.ts", line: 1 }], requiredRoots: ["."],
    requiredCounts: { "src/200.ts": 2 },
  },
  ...[1, 5, 10].map((limit): BenchmarkCase => ({
    id: `ambiguous-filenames-limit-${limit}`, intent: "file", files: ambiguousFiles,
    params: { query: "needle", path: "widget.ts", max_files: limit },
    targets: [{ path: "widgets/6/widget.ts", line: 1 }], requiredRoots: Object.keys(ambiguousFiles),
  })),
  {
    id: "rg-inline-flag", intent: "references", files: { "src/case.ts": "NEEDLE\n" },
    params: { query: "(?i)needle", path: "src/case.ts" },
    targets: [{ path: "src/case.ts", line: 1 }], requiredRoots: ["src/case.ts"],
  },
  {
    id: "caller-versus-definition", intent: "definition",
    files: { "src/caller.ts": "const cached = resolveNeedle();\n", "src/definition.ts": "export function resolveNeedle() {}\n" },
    params: { query: "resolveNeedle", intent: "definition" },
    targets: [{ path: "src/definition.ts", line: 1 }], requiredRoots: ["."],
  },
  ...[0, 7999].map((unrelated): BenchmarkCase => ({
    id: `exact-file-${unrelated}-unrelated`, intent: "file",
    files: {
      "src/target.ts": "export const needle = 1;\n",
      ...Object.fromEntries(Array.from({ length: unrelated }, (_, index) => [`other/${index}.ts`, "export const unrelated = 0;\n".repeat(20)])),
    },
    params: { query: "needle", path: "src/target.ts" },
    targets: [{ path: "src/target.ts", line: 1 }], requiredRoots: ["src/target.ts"],
    expectedProcesses: 1, expectedListings: 0,
  })),
];

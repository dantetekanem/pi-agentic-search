export interface Target { path: string; line: number }
export interface BenchmarkCase {
  id: string;
  intent: "definition" | "references" | "file" | "tests" | "auto";
  files: Record<string, string>;
  params: { query: string; path?: string; max_files?: number; intent?: string; context?: string; expand_related?: boolean };
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

export function summarizeByIntent(results: Array<{ intent: string; metrics: { top1: number; reciprocalRank: number } }>) {
  const totals: Record<string, { cases: number; top1: number; mrr: number }> = {};
  for (const { intent, metrics } of results) {
    const total = totals[intent] ??= { cases: 0, top1: 0, mrr: 0 };
    total.cases++;
    total.top1 += metrics.top1;
    total.mrr += metrics.reciprocalRank;
  }
  return Object.fromEntries(Object.entries(totals).map(([intent, total]) => [intent, {
    cases: total.cases, top1: total.top1 / total.cases, mrr: total.mrr / total.cases,
  }]));
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

const anchorFiles = {
  "src/main.ts": "import { needle } from './impl';\nconst cached = needle();\n",
  "src/impl.ts": "export function needle() {}\n",
};
const intentFiles = {
  "src/needle.ts": "export function needle() {}\n",
  "src/caller.ts": "needle();\n",
  "test/needle.test.ts": "test('needle handles empty values', () => needle());\n",
};

export const benchmarkCases: BenchmarkCase[] = [
  ...(["definition", "file", "auto"] as const).map((intent): BenchmarkCase => ({
    id: `navigation-anchor-${intent}`, intent, files: anchorFiles,
    params: { query: "needle", path: "src/main.ts", expand_related: true, intent },
    targets: [{ path: intent === "definition" ? "src/impl.ts" : "src/main.ts", line: intent === "definition" ? 1 : 2 }],
    requiredRoots: Object.keys(anchorFiles),
  })),
  ...(["references", "tests"] as const).map((intent): BenchmarkCase => ({
    id: `requested-${intent}`, intent, files: intentFiles,
    params: { query: "needle", intent, ...(intent === "references" ? { path: "src" } : {}) },
    targets: [{ path: intent === "tests" ? "test/needle.test.ts" : "src/caller.ts", line: 1 }],
    requiredRoots: [intent === "references" ? "src" : "."],
  })),
  {
    id: "context-surrounding-block", intent: "definition",
    files: { "src/a.ts": "// wholesale\nexport function needle() {}\n", "src/z.ts": "// sale reconciliation\nexport function needle() {}\n" },
    params: { query: "needle", intent: "definition", context: "sale" },
    targets: [{ path: "src/z.ts", line: 2 }], requiredRoots: ["."],
  },
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

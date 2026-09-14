import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getAgentDir, truncateHead, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { summarizeMetrics } from "./metrics.ts";
import { clampInt } from "./shared.ts";
import { collectSparsity, formatSparsity } from "./sparsity.ts";
import { indexSparsity, packId } from "./sparsity-index.ts";

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const metricsLogPath = () => join(getAgentDir(), "sparsity", "metrics.jsonl");
const indexCacheDir = () => join(getAgentDir(), "sparsity", "index");

export function renderSparsityCall(args: any, theme: ThemeLike): Text {
  if (args.target === undefined) {
    let index = theme.fg("toolTitle", theme.bold("sparsity_index "));
    index += theme.fg("accent", Array.isArray(args.anchors) ? `${args.anchors.length} anchors` : String(args.diff ?? "worktree"));
    if (args.cwd) index += theme.fg("dim", ` in ${String(args.cwd)}`);
    if (args.max_depth !== undefined) index += theme.fg("dim", ` depth ${args.max_depth}`);
    if (args.output_dir) index += theme.fg("dim", ` → ${String(args.output_dir)}`);
    return new Text(index, 0, 0);
  }
  let text = theme.fg("toolTitle", theme.bold("sparsity_collect "));
  text += theme.fg("accent", String(args.target ?? ""));
  if (args.max_depth !== undefined) text += theme.fg("dim", ` depth ${args.max_depth}`);
  if (args.vicinity_check !== undefined) text += theme.fg("dim", ` vicinity ${args.vicinity_check}`);
  if (args.root) text += theme.fg("dim", ` root ${String(args.root)}`);
  if (args.callers === false) text += theme.fg("dim", " callers false");
  return new Text(text, 0, 0);
}

async function writeFullOutputIfTruncated(output: string, prefix: string, details: { truncation?: TruncationResult; fullOutputPath?: string }): Promise<string> {
  const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncation.truncated) return truncation.content;

  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  const fullOutputPath = join(tempDir, "output.txt");
  await writeFile(fullOutputPath, output, "utf8");
  details.truncation = truncation;
  details.fullOutputPath = fullOutputPath;
  return `${truncation.content}\n\n[Output truncated. Full output saved to ${fullOutputPath}]`;
}

async function repositoryCwd(requested: unknown, fallback: string): Promise<string> {
  if (typeof requested !== "string" || !requested.trim()) return fallback;
  const resolved = resolve(requested.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  const stats = await stat(resolved).catch(() => undefined);
  if (!stats?.isDirectory()) throw new Error(`cwd is not a directory: ${requested}`);
  return resolved;
}

const SparsityParams = Type.Object({
  cwd: Type.Optional(Type.String({ description: "Repository checkout containing the target. Default: the session's working directory." })),
  target: Type.String({ description: "Anchor as path:line, where line is inside the Ruby/JS/TS method, scope, function or component to collect around. Example: app/models/billing/reader.rb:14" }),
  max_depth: Type.Optional(Type.Number({ description: "How many call hops to follow from the anchor. Default 3, max 4." })),
  vicinity_check: Type.Optional(Type.Number({ description: "Lines of context to show around each anchor line, bounded by the definition. Default 20, max 60." })),
  max_nodes: Type.Optional(Type.Number({ description: "Hard cap on definitions returned. Default 24, max 60." })),
  root: Type.Optional(Type.String({ description: "Search root for resolution. Default: nearest component root above the target (component.yml, gemspec, package.json, Gemfile, .git), never above cwd." })),
  callers: Type.Optional(Type.Boolean({ description: "Also list static callers of the anchor within the root (depth 1, capped). Default true." })),
  budget_ms: Type.Optional(Type.Number({ description: "Total ripgrep time budget in milliseconds. Default 20000, max 60000." })),
});

const IndexParams = Type.Object({
  cwd: Type.Optional(Type.String({ description: "Repository checkout to index. Default: the session's working directory. Use when the session is not inside the reviewed repository." })),
  diff: Type.Optional(Type.String({ description: "What changed: a git range like base..head or base...head, a single commit, or worktree (default) for uncommitted changes including untracked files." })),
  anchors: Type.Optional(Type.Array(Type.String(), { description: "Instead of a diff, index these path:line anchors." })),
  max_depth: Type.Optional(Type.Number({ description: "Call hops to follow from each changed definition. Default 2, max 4." })),
  vicinity_check: Type.Optional(Type.Number({ description: "Lines of context around changed lines inside each changed definition. Default 20, max 60." })),
  max_nodes: Type.Optional(Type.Number({ description: "Hard cap on callee definitions expanded across the whole pack; callers and tests have their own per-anchor caps. Default 120, max 300." })),
  max_anchors: Type.Optional(Type.Number({ description: "Hard cap on changed definitions expanded. Default 60, max 200. Production methods rank before tests and declarations." })),
  root: Type.Optional(Type.String({ description: "Search root override for every file. Default: nearest component root per file (component.yml, gemspec, package.json, Gemfile, .git), never above cwd." })),
  budget_ms: Type.Optional(Type.Number({ description: "Total ripgrep/git time budget in milliseconds. Default 30000, max 120000." })),
  output_dir: Type.Optional(Type.String({ description: "Directory for pack.md and pack.json. Default: the Pi agent directory under sparsity/<id>. Give a review run's artifact directory to keep the pack with the run." })),
  inline_budget_kb: Type.Optional(Type.Number({ description: "How much of the pack to return inline before spilling sections to pack.md. Default 40 KB, max 48 KB." })),
});

export function registerSparsityTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "sparsity_index",
    label: "Sparsity Index",
    description: "Index the code changes of a diff in one call. Finds every changed Ruby/JS/TS definition, expands what each one calls (to max_depth hops, resolved to definitions with exact/static_candidate/ambiguous/unresolved/external labels), lists static callers and tests for each, reports definitions removed by the diff that still have callers, and returns a ranked pack: manifest, changed definitions with their edges, direct callees, dangling symbols, recap of unresolved and untested paths, then depth-2 signatures. Changed files are read at the range head even when the checkout is elsewhere. Sections beyond the inline budget are written to pack.md with line ranges in the manifest. Run this once at the start of a review instead of exploring files by hand.",
    promptSnippet: "At the start of a review, call sparsity_index once with the diff (base..head or worktree) and, for a review run, output_dir set to the run's artifact directory. Read the manifest, then the anchor sections; read spilled sections from pack.md by line range only when a zone needs them. Unresolved edges and the frontier are coverage gaps to disclose, not evidence of absence.",
    promptGuidelines: [
      "Use sparsity_index for the whole diff first; use sparsity_collect for one more anchor only when a reviewer needs deeper context on a specific definition.",
      "Anchors whose tests list is empty are untested by name; say so instead of assuming coverage.",
    ],
    parameters: IndexParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = await repositoryCwd(params.cwd, ctx.cwd);
      const diff = typeof params.diff === "string" ? params.diff : "worktree";
      const outputDir = typeof params.output_dir === "string" && params.output_dir.trim()
        ? params.output_dir.trim()
        : join(getAgentDir(), "sparsity", packId(cwd, diff, String(Date.now())));
      const result = await indexSparsity({
        cwd,
        diff,
        anchors: Array.isArray(params.anchors) && params.anchors.length ? params.anchors.map(String) : undefined,
        maxDepth: clampInt(params.max_depth, 2, 1, 4),
        vicinity: clampInt(params.vicinity_check, 20, 5, 60),
        maxNodes: clampInt(params.max_nodes, 120, 2, 300),
        maxAnchors: clampInt(params.max_anchors, 60, 1, 200),
        root: typeof params.root === "string" && params.root.trim() ? params.root.trim() : undefined,
        budgetMs: clampInt(params.budget_ms, 30_000, 2_000, 120_000),
        outputDir,
        inlineBudgetBytes: clampInt(params.inline_budget_kb, 40, 4, 48) * 1024,
        indexCacheDir: indexCacheDir(),
        metricsLog: metricsLogPath(),
        signal,
      });
      const { inline, ...details } = result;
      const text = await writeFullOutputIfTruncated(inline, "pi-sparsity-index-", details as unknown as { truncation?: TruncationResult; fullOutputPath?: string });
      return { content: [{ type: "text", text }], details: { ...details, nodes: undefined, edges: undefined, sections: details.sections.map((section) => ({ ...section, body: undefined })) } };
    },

    renderCall: renderSparsityCall,
  });

  pi.registerTool({
    name: "sparsity_collect",
    label: "Sparsity Collect",
    description: "Bounded call-context collection for one Ruby or JS/TS definition. Give it path:line inside a method, scope, function or component; it returns the enclosing definition with a fingerprint and ±N lines, the calls inside it resolved to definitions (exact, static candidate, ambiguous, unresolved or external) up to max_depth hops within the nearest component root, static callers of the anchor, cycles, the unexpanded frontier and coverage. Ruby resolution is by definition name and is a static candidate, not runtime proof. Use it instead of reading files by hand when tracing what a changed method touches.",
    promptSnippet: "For a changed Ruby/JS/TS method or scope, call sparsity_collect with target path:line, max_depth 3 and vicinity_check 20 before reading neighbors by hand. Read the returned snippets and edges, not just the summary; follow unresolved or ambiguous edges with a direct read. Node IDs belong to that call; fingerprints let a later pass detect unchanged definitions.",
    promptGuidelines: [
      "Use sparsity_collect once per changed method or scope to gather its call context; use agentic_search to locate a definition when you only know a name.",
      "Treat Ruby edges as static candidates: a matching def name is not proof the call reaches it at runtime. Unresolved edges and the frontier are coverage gaps to disclose, not evidence of absence.",
    ],
    parameters: SparsityParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await collectSparsity({
        cwd: await repositoryCwd(params.cwd, ctx.cwd),
        target: params.target,
        maxDepth: clampInt(params.max_depth, 3, 1, 4),
        vicinity: clampInt(params.vicinity_check, 20, 5, 60),
        maxNodes: clampInt(params.max_nodes, 24, 2, 60),
        root: typeof params.root === "string" && params.root.trim() ? params.root.trim() : undefined,
        callers: params.callers ?? true,
        budgetMs: clampInt(params.budget_ms, 20_000, 2_000, 60_000),
        indexCacheDir: indexCacheDir(),
        metricsLog: metricsLogPath(),
        signal,
      });
      const details: Record<string, unknown> = { ...result };
      const text = await writeFullOutputIfTruncated(formatSparsity(result), "pi-sparsity-collect-", details as { truncation?: TruncationResult; fullOutputPath?: string });
      return { content: [{ type: "text", text }], details };
    },

    renderCall: renderSparsityCall,
  });

  pi.registerCommand("agentic-search-stats", {
    description: "Summarize recent sparsity runs: timing, anchors, edges, unresolved rate, cache hits, tokens",
    handler: async (args, ctx) => {
      const last = clampInt(Number.parseInt(String(args ?? "").trim(), 10), 20, 1, 500);
      ctx.ui.notify(await summarizeMetrics(metricsLogPath(), last), "info");
    },
  });
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { collectContext, repositoryCwd, scanContext } from "./context.ts";
import { runSearch } from "./search.ts";
import { formatSparsity } from "./sparsity.ts";
import type { SearchIntent } from "./types.ts";

interface Option {
  type: "string" | "boolean";
  description: string;
  short?: string;
  multiple?: boolean;
  min?: number;
  max?: number;
}
const numberOption = (description: string, fallback: number, min: number, max: number): Option =>
  ({ type: "string", description: `${description} (default ${fallback}; ${min}–${max})`, min, max });
const common: Record<string, Option> = {
  help: { type: "boolean", short: "h", description: "Show help" },
  cwd: { type: "string", description: "Repository directory (default: working directory)" },
  json: { type: "boolean", description: "Write {text, details} as JSON instead of text" },
};
const contextOptions: Record<string, Option> = {
  root: { type: "string", description: "Narrow the component root" },
  "vicinity-check": numberOption("Snippet context lines", 20, 5, 60),
};
const commands: Record<string, { usage: string; options: Record<string, Option> }> = {
  search: { usage: "search <query>", options: {
    context: { type: "string", description: "Domain hint for ranking; query stays code syntax" },
    intent: { type: "string", description: "definition | references | tests | file | auto (default)" },
    path: { type: "string", description: "Exact file, directory or partial path" },
    "expand-related": { type: "boolean", description: "Follow supported imports and Ruby mixins" },
    literal: { type: "boolean", description: "Treat query as literal text, not regex" },
    "case-sensitive": { type: "boolean", description: "Override smart-case matching" },
    "max-files": numberOption("Ranked files displayed", 5, 1, 10),
    "max-matches-per-file": numberOption("Snippets per file", 10, 1, 10),
  } },
  collect: { usage: "collect <path:line>", options: {
    ...contextOptions,
    "max-depth": numberOption("Call hops", 3, 1, 4),
    "max-nodes": numberOption("Definitions", 24, 2, 60),
    "budget-ms": numberOption("Traversal budget after parser setup", 20_000, 2_000, 60_000),
    "no-callers": { type: "boolean", description: "Skip static callers" },
  } },
  scan: { usage: "scan [--diff <worktree|commit|range>]", options: {
    ...contextOptions,
    diff: { type: "string", description: "Git diff target (default: worktree, including untracked files)" },
    anchor: { type: "string", multiple: true, description: "path:line instead of a diff; repeat for multiple anchors" },
    "max-depth": numberOption("Call hops", 2, 1, 4),
    "max-nodes": numberOption("Expanded definitions", 120, 2, 300),
    "max-anchors": numberOption("Changed definitions", 60, 1, 200),
    "budget-ms": numberOption("Git/ripgrep budget", 30_000, 2_000, 120_000),
    "output-dir": { type: "string", description: "Pack directory (default: new system temporary directory)" },
    "inline-budget-kb": numberOption("Inline pack size in KiB", 40, 4, 48),
  } },
};

class UsageError extends Error {}

function help(command?: string): string {
  const definition = command ? commands[command] : undefined;
  const options = { ...common, ...definition?.options };
  return [
    `Usage: agentic-search ${definition?.usage ?? "<search|collect|scan>"} [options]`,
    ...(definition ? [] : ["search: locate code; collect: trace one definition; scan: collect a diff.", "Run agentic-search <command> --help for command options."]),
    ...Object.entries(options).map(([name, option]) => `  --${name}${option.type === "string" ? " <value>" : ""}  ${option.description}`),
    "Exit: 0 result (may have coverage gaps), 1 execution failure, 2 usage error, 130 interrupted.",
    "A complete search with no matches exits 0. Read coverage before drawing conclusions.",
  ].join("\n");
}

async function boundedText(text: string): Promise<string> {
  const lines: string[] = [];
  let bytes = 0;
  for (const line of text.split("\n")) {
    const size = Buffer.byteLength(line) + (lines.length ? 1 : 0);
    if (lines.length >= 2000 || bytes + size > 50 * 1024) {
      const path = join(await mkdtemp(join(tmpdir(), "agentic-search-")), "output.txt");
      await writeFile(path, text, "utf8");
      return `${lines.join("\n")}\n\n[Output truncated. Full output: ${path}]`;
    }
    lines.push(line);
    bytes += size;
  }
  return text;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let indexCacheDir: string | undefined;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("interrupted"));
  process.once("SIGINT", interrupt);
  try {
    const [command, ...args] = argv;
    if (!command || command === "--help" || command === "-h") {
      process.stdout.write(`${help()}\n`);
      return 0;
    }
    const definition = Object.hasOwn(commands, command) ? commands[command] : undefined;
    if (!definition) throw new UsageError(`Unknown command: ${command}`);
    const options = { ...common, ...definition.options };
    let parsed;
    try {
      parsed = parseArgs({ args, options, allowPositionals: true });
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const { values, positionals } = parsed;
    const string = (name: string) => typeof values[name] === "string" ? values[name] : undefined;
    const number = (name: string) => string(name) === undefined ? undefined : Number(string(name));
    if (values.help) {
      process.stdout.write(`${help(command)}\n`);
      return 0;
    }
    for (const [name, option] of Object.entries(options)) {
      if (option.min === undefined || option.max === undefined || values[name] === undefined) continue;
      const value = number(name);
      if (value === undefined || !Number.isInteger(value) || value < option.min || value > option.max) {
        throw new UsageError(`--${name} must be an integer from ${option.min} to ${option.max}`);
      }
    }
    if (positionals.length !== (command === "scan" ? 0 : 1) || positionals.some((value) => !value.trim())) {
      throw new UsageError(`Expected: agentic-search ${definition.usage}`);
    }
    const intent = string("intent");
    if (intent !== undefined && !["definition", "references", "tests", "file", "auto"].includes(intent)) throw new UsageError(`Invalid intent: ${intent}`);
    if (values.diff !== undefined && values.anchor !== undefined) throw new UsageError("Use --diff or --anchor, not both");
    const cwd = await repositoryCwd(string("cwd"), process.cwd());
    if (command !== "search") indexCacheDir = await mkdtemp(join(tmpdir(), "agentic-search-index-"));
    const runtime = { indexCacheDir, signal: controller.signal };
    const context = {
      root: string("root"),
      max_depth: number("max-depth"),
      max_nodes: number("max-nodes"),
      vicinity_check: number("vicinity-check"),
      budget_ms: number("budget-ms"),
    };
    let output: { text: string; details: unknown };
    let failed = false;
    if (command === "search") {
      const result = await runSearch({
        query: positionals[0],
        context: string("context"),
        intent: intent as SearchIntent | undefined,
        path: string("path"),
        expand_related: values["expand-related"] === true,
        literal: values.literal === true,
        case_sensitive: values["case-sensitive"] === true,
        max_files: number("max-files"),
        max_matches_per_file: number("max-matches-per-file"),
      }, cwd, controller.signal);
      output = { text: result.content[0].text, details: result.details };
      failed = result.details.coverage.status === "failed";
    } else if (command === "collect") {
      const result = await collectContext({ ...context, target: positionals[0], callers: values["no-callers"] !== true }, cwd, runtime);
      output = { text: formatSparsity(result), details: result };
    } else {
      const requested = string("output-dir");
      const outputDir = requested ? resolve(cwd, requested) : await mkdtemp(join(tmpdir(), "agentic-search-"));
      const { inline, ...details } = await scanContext({
        ...context,
        diff: string("diff"),
        anchors: Array.isArray(values.anchor) ? values.anchor.filter((value): value is string => typeof value === "string") : undefined,
        max_anchors: number("max-anchors"),
        inline_budget_kb: number("inline-budget-kb"),
      }, cwd, outputDir, runtime);
      output = { text: inline, details };
    }
    process.stdout.write(`${values.json ? JSON.stringify(output) : await boundedText(output.text)}\n`);
    return controller.signal.aborted ? 130 : failed ? 1 : 0;
  } catch (error) {
    process.stderr.write(`agentic-search: ${error instanceof Error ? error.message : String(error)}\n`);
    return controller.signal.aborted ? 130 : error instanceof UsageError ? 2 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    if (indexCacheDir) await rm(indexCacheDir, { recursive: true, force: true });
  }
}

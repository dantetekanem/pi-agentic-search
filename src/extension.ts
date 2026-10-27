import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderCall, renderResult } from "./render.ts";
import { runSearch as search } from "./search.ts";
import { registerSparsityTools } from "./sparsity-extension.ts";
export { parseRipgrepJsonLines } from "./matches.ts";
export { rankFileGroups } from "./ranking.ts";
export { formatSearchResults } from "./format.ts";
export type { CodeMatch, RankedFileResult, PathMatch } from "./types.ts";

const SearchParams = Type.Object({
  query: Type.String({ description: "Precise code syntax regex or literal string to search for. For Rails scopes use scope\\s+:." }),
  context: Type.Optional(Type.String({ description: "Optional natural-language disambiguation hint used only for ranking, not as the ripgrep query. Example: actual goal progress" })),
  intent: Type.Optional(StringEnum(["definition", "references", "tests", "file", "auto"] as const)),
  path: Type.Optional(Type.String({ description: "Optional exact path, filename, partial path, or absolute file/directory root." })),
  max_files: Type.Optional(Type.Number({ description: "Maximum ranked files displayed, default 5, max 10. Does not limit searched candidates." })),
  max_matches_per_file: Type.Optional(Type.Number({ description: "Maximum snippets per file, default 10, max 10." })),
  expand_related: Type.Optional(Type.Boolean({ description: "Search Ruby/Rails mixins or JS/TS imports and owning/imported packages; report incomplete traversal explicitly." })),
  literal: Type.Optional(Type.Boolean({ description: "Treat query as literal text instead of a regex." })),
  case_sensitive: Type.Optional(Type.Boolean({ description: "Use case-sensitive matching instead of rg smart-case." })),
});

export async function runSearch(...args: Parameters<typeof search>) {
  const result = await search(...args);
  const { details } = result;
  let text = result.content[0].text;
  const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (truncation.truncated) {
    const dir = await mkdtemp(join(tmpdir(), "pi-agentic-search-"));
    details.fullOutputPath = join(dir, "output.txt");
    details.truncation = truncation;
    await writeFile(details.fullOutputPath, text, "utf8");
    text = `${truncation.content}\n\n[Output truncated. Full output: ${details.fullOutputPath}]`;
  }
  return { content: [{ type: "text" as const, text }], details };
}

export default function agenticSearchExtension(pi: ExtensionAPI) {
  registerSparsityTools(pi);
  pi.registerTool({
    name: "agentic_search", label: "Agentic Search",
    description: `Preferred ranked search for files, classes, scopes, methods, and call sites. Use intent for definition, references, tests, or file lookup; context disambiguates ranking. Set expand_related true for Ruby/Rails mixins or JS/TS imports, owning packages, and imported packages. Check coverage before treating a miss as decisive. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Code Mode: await tools.agentic_search(args) returns a text string, not structured JSON.`,
    promptSnippet: "Preferred ranked search for locating files, classes, scopes, methods, and call sites. Use context for natural-language disambiguation, intent for the requested evidence, and expand_related for module relationships. Inspect reported unfinished scopes when coverage is partial.",
    promptGuidelines: [
      "Prefer agentic_search over grep for locating files, classes, scopes, methods, and call sites.",
      "In Code Mode, call await tools.agentic_search(args) with the same arguments as a direct call and read the returned text. Use searchTools or describeTool to discover callable tools and their arguments even when inline declarations are omitted.",
      "For agentic_search, keep query as code syntax and context as a domain hint; for example query remaining_value with context actual goal progress.",
      "For Rails scopes in a named file, use agentic_search query scope\\s+: and path event_occurrence.rb, then read the target.",
      "For Rails questions such as 'how many scopes does User have', enable agentic_search expand_related true for concerns and mixins.",
      "For JS/TS questions about imported behavior, enable agentic_search expand_related true. One agentic_search call searches the target, relative imports, owning package and resolvable imported packages, and reports unfinished work.",
      "Use agentic_search intent definition to find the declaration, references for callers, tests for test evidence, or file to prefer the navigation anchor. Auto preserves a named-file preference.",
      "If agentic_search returns a matching target, read that target first before sibling tests, migrations, git status, or additional discovery. Follow reported unvisited scopes when coverage is incomplete.",
      "A complete agentic_search miss applies only to the reported pattern and completed scopes. Partial or failed coverage requires inspecting its unvisited roots or unresolved relationships.",
    ],
    parameters: SearchParams,
    async execute(_id, params, signal, _onUpdate, ctx) { return runSearch(params, ctx.cwd, signal); },
    renderCall, renderResult,
  });
  pi.registerCommand("agentic-search-info", {
    description: "Show pi-agentic-search status and tool names",
    handler: async (_args, ctx) => { ctx.ui.notify("pi-agentic-search loaded: agentic_search (intent-aware ranking with explicit retrieval coverage), sparsity_scan (one call per diff) and sparsity_collect (one anchor).", "info"); },
  });
}

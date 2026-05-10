import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agenticSearchExtension, { formatSearchResults, parseRipgrepJsonLines, rankFileGroups } from "../index.ts";

function rgMatch(path: string, lineNumber: number, text: string): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: `${text}\n` },
      line_number: lineNumber,
      submatches: [{ match: { text: "Widget" }, start: 10, end: 16 }],
    },
  });
}

const output = [
  rgMatch("test/widget.test.ts", 5, "expect(renderWidget()).toBeTruthy();"),
  rgMatch("src/widget.ts", 1, "export function renderWidget() {"),
  rgMatch("src/widget.ts", 7, "return new Widget();"),
].join("\n");

const matches = parseRipgrepJsonLines(output);
assert.equal(matches.length, 3);
assert.equal(matches[1]?.isDefinition, true);

const ranked = rankFileGroups(matches, "Widget", 3);
assert.equal(ranked[0]?.path, "src/widget.ts");
assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
assert.ok(ranked[0]?.reasons.some((reason) => reason.includes("definition-like")));

const formatted = formatSearchResults("Widget", ranked.slice(0, 1), matches.length);
assert.match(formatted, /TARGET FILE: src\/widget\.ts/);
assert.match(formatted, /export function renderWidget/);
assert.doesNotMatch(formatted, /\[object Object\]/);
assert.match(formatted, /read only the TARGET FILE/);

const registeredTools: string[] = [];
const registeredCommands: string[] = [];
let searchTool: any;
agenticSearchExtension({
  registerTool(tool: { name: string }) {
    registeredTools.push(tool.name);
    if (tool.name === "agentic_search") searchTool = tool;
  },
  registerCommand(name: string) {
    registeredCommands.push(name);
  },
} as any);

assert.deepEqual(registeredTools, ["agentic_search"]);
assert.deepEqual(registeredCommands, ["agentic-search-info"]);
assert.ok(searchTool, "agentic_search tool should be registered");

assert.match(searchTool.description, /preferred/i);
assert.match(searchTool.description, /files/i);
assert.match(searchTool.description, /classes/i);
assert.match(searchTool.description, /scopes/i);
assert.match(searchTool.description, /methods/i);
assert.match(searchTool.description, /call sites/i);
assert.match(searchTool.description, /ranked/i);
assert.match(searchTool.promptSnippet, /preferred/i);
assert.match(searchTool.promptSnippet, /locating/i);
assert.match(searchTool.promptSnippet, /files/i);
assert.match(searchTool.promptSnippet, /classes/i);
assert.match(searchTool.promptSnippet, /scopes/i);
assert.match(searchTool.promptSnippet, /methods/i);
assert.match(searchTool.promptSnippet, /call sites/i);
assert.ok(
  searchTool.promptGuidelines.some((guideline: string) => /Prefer agentic_search over grep/.test(guideline)),
  "promptGuidelines should explicitly prefer agentic_search over grep for discovery",
);
assert.ok(
  searchTool.promptGuidelines.some((guideline: string) => /files, classes, scopes, methods, and call sites/.test(guideline)),
  "promptGuidelines should name common code-discovery targets",
);
assert.ok(
  searchTool.promptGuidelines.some((guideline: string) => /query scope\\s\+:/i.test(guideline) && /path event_occurrence\.rb/i.test(guideline)),
  "promptGuidelines should map Rails scope filename prompts to query plus path",
);
assert.ok(
  searchTool.promptGuidelines.some((guideline: string) => /stop discovery/i.test(guideline) && /tests/i.test(guideline) && /git status/i.test(guideline)),
  "promptGuidelines should prevent extra discovery after the target file contains the requested matches",
);
assert.doesNotMatch(searchTool.promptGuidelines.join("\n"), /path_glob|file_type|--glob|--type/);

const identityTheme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};
const malformedRender = searchTool.renderResult(
  {
    content: [{ type: "text", text: "agentic_search: fallback line\nTARGET FILE: src/widget.ts" }],
    details: {},
  },
  { expanded: false, isPartial: false },
  identityTheme,
).render(120).join("\n");
assert.doesNotMatch(malformedRender, /undefined\/undefined|undefined matches/);
assert.match(malformedRender, /agentic_search: fallback line/);

const repo = await mkdtemp(join(tmpdir(), "pi-agentic-search-smoke-"));
await mkdir(join(repo, "app/models"), { recursive: true });
await mkdir(join(repo, "test/fixtures"), { recursive: true });
await writeFile(
  join(repo, "app/models/event_occurrence.rb"),
  [
    "class EventOccurrence < ApplicationRecord",
    "  scope :upcoming, -> { where(\"date >= ?\", Date.current).order(:date) }",
    "  scope :past, -> { where(\"date < ?\", Date.current).order(date: :desc) }",
    "  scope :by_date_range, ->(start_date, end_date) { where(date: start_date..end_date) }",
    "  scope :with_budget, -> { where.not(budget_cents: nil) }",
    "end",
  ].join("\n"),
);
await writeFile(
  join(repo, "app/models/goal_step.rb"),
  [
    "class GoalStep < ApplicationRecord",
    "  scope :upcoming, -> { where(\"scheduled_date >= ?\", Date.current) }",
    "end",
  ].join("\n"),
);
await writeFile(join(repo, "test/fixtures/event_occurrences.yml"), "one:\n  date: 2026-01-01\n");

const pathOnlyResult = await searchTool.execute(
  "tool-call-1",
  { query: "event_occurrence.rb", max_files: 3 },
  undefined,
  undefined,
  { cwd: repo },
);
const pathOnlyText = pathOnlyResult.content[0].text;
assert.match(pathOnlyText, /TARGET FILE: app\/models\/event_occurrence\.rb/);
assert.doesNotMatch(pathOnlyText, /TARGET FILE: test\/fixtures\/event_occurrences\.yml/);
assert.equal(pathOnlyResult.details.files[0].path, "app/models/event_occurrence.rb");
assert.ok(pathOnlyResult.details.files[0].reasons.some((reason: string) => /filename|path/.test(reason)));

const scopeResult = await searchTool.execute(
  "tool-call-2",
  { query: "scope\\s+:", path: "event_occurrence.rb" },
  undefined,
  undefined,
  { cwd: repo },
);
const scopeText = scopeResult.content[0].text;
assert.equal(scopeResult.details.files[0].path, "app/models/event_occurrence.rb");
assert.match(scopeText, /confidence sum 1\.000/);
assert.match(scopeText, /Do not inspect alternate candidates, sibling models, tests, migrations, git status, or run more searches/);
assert.match(scopeText, /\[scope\] scope :upcoming/);
assert.match(scopeText, /\[scope\] scope :past/);
assert.match(scopeText, /\[scope\] scope :by_date_range/);
assert.match(scopeText, /\[scope\] scope :with_budget/);
assert.equal(scopeResult.details.files[0].matchCount, 4);
assert.equal(scopeResult.details.files[0].confidence, 1);

console.log("pi-agentic-search smoke test passed");

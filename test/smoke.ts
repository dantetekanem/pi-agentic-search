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
assert.match(formatted, /read the TARGET FILE first/);

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
assert.match(JSON.stringify(searchTool.parameters), /context/);
assert.match(JSON.stringify(searchTool.parameters), /disambiguation hint used only for ranking/);

assert.match(searchTool.description, /preferred/i);
assert.match(searchTool.description, /files/i);
assert.match(searchTool.description, /classes/i);
assert.match(searchTool.description, /scopes/i);
assert.match(searchTool.description, /methods/i);
assert.match(searchTool.description, /call sites/i);
assert.match(searchTool.description, /ranked/i);
assert.match(searchTool.description, /expand_related true/i);
assert.match(searchTool.promptSnippet, /preferred/i);
assert.match(searchTool.promptSnippet, /locating/i);
assert.match(searchTool.promptSnippet, /files/i);
assert.match(searchTool.promptSnippet, /classes/i);
assert.match(searchTool.promptSnippet, /scopes/i);
assert.match(searchTool.promptSnippet, /methods/i);
assert.match(searchTool.promptSnippet, /call sites/i);
assert.match(searchTool.promptSnippet, /context.*natural-language disambiguation/i);
assert.ok(
  searchTool.promptGuidelines.some((guideline: string) => /Prefer agentic_search over grep/.test(guideline)),
  "promptGuidelines should explicitly prefer agentic_search over grep for discovery",
);
assert.ok(
  searchTool.promptGuidelines.some((guideline: string) => /files, classes, scopes, methods, and call sites/.test(guideline)),
  "promptGuidelines should name common code-discovery targets",
);
assert.ok(
  searchTool.promptGuidelines.some((guideline: string) => /context actual goal progress/i.test(guideline) && /query remaining_value/i.test(guideline)),
  "promptGuidelines should explain context disambiguation without replacing query",
);
assert.ok(
  searchTool.promptGuidelines.some((guideline: string) => /query scope\\s\+:/i.test(guideline) && /path event_occurrence\.rb/i.test(guideline)),
  "promptGuidelines should map Rails scope filename prompts to query plus path",
);
assert.ok(
  searchTool.promptGuidelines.some((guideline: string) => /how many scopes does User have/i.test(guideline) && /expand_related true/i.test(guideline)),
  "promptGuidelines should tell agents to enable expand_related for model scope questions",
);
assert.ok(
  searchTool.promptGuidelines.some((guideline: string) => /JS\/TS questions/i.test(guideline) && /expand_related true/i.test(guideline)),
  "promptGuidelines should tell agents to enable expand_related for JS/TS import questions",
);
assert.ok(
  searchTool.promptGuidelines.some((guideline: string) => /read that target first/i.test(guideline) && /tests/i.test(guideline) && /git status/i.test(guideline)),
  "promptGuidelines should prioritize the target before extra discovery after the target file contains the requested matches",
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
await mkdir(join(repo, "app/models/goal"), { recursive: true });
await mkdir(join(repo, "app/models/user"), { recursive: true });
await mkdir(join(repo, "app/models/museum"), { recursive: true });
await mkdir(join(repo, "app/models/concerns/audit"), { recursive: true });
await mkdir(join(repo, "app/controllers"), { recursive: true });
await mkdir(join(repo, "app/services/finance"), { recursive: true });
await mkdir(join(repo, "src/helpers"), { recursive: true });
await mkdir(join(repo, "src/components"), { recursive: true });
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
await writeFile(
  join(repo, "app/models/goal/progress.rb"),
  [
    "class Goal::Progress < ApplicationRecord",
    "  def apply_update",
    "    self.remaining_value = actual_remaining_value",
    "  end",
    "end",
  ].join("\n"),
);
await writeFile(
  join(repo, "app/services/finance/payment_schedule.rb"),
  [
    "class Finance::PaymentSchedule",
    "  def remaining_value",
    "    payment_total_cents - paid_value_cents",
    "  end",
    "end",
  ].join("\n"),
);
await writeFile(join(repo, "app/controllers/application_controller.rb"), "class ApplicationController < ActionController::Base\nend\n");
await writeFile(
  join(repo, "app/models/post.rb"),
  [
    "class Post < ApplicationRecord",
    "  def topic_page",
    "    where(\"posts.created_at <= ?\", created_at)",
    "  end",
    "end",
  ].join("\n"),
);
await writeFile(
  join(repo, "app/models/user.rb"),
  [
    "class User < ApplicationRecord",
    "  include ProfileScopes",
    "  include MissingConcern",
    "  include Audit::Scopes",
    "  scope :direct_user, -> { where(active: true) }",
    "end",
  ].join("\n"),
);
await writeFile(join(repo, "app/models/museum/user.rb"), "class Museum::User < ApplicationRecord\n  scope :museum_user, -> { all }\nend\n");
await writeFile(
  join(repo, "app/models/user/profile_scopes.rb"),
  [
    "module User::ProfileScopes",
    "  extend ActiveSupport::Concern",
    "  included do",
    "    scope :profiled, -> { where.not(profile_id: nil) }",
    "  end",
    "end",
  ].join("\n"),
);
await writeFile(
  join(repo, "app/models/concerns/audit/scopes.rb"),
  [
    "module Audit::Scopes",
    "  extend ActiveSupport::Concern",
    "  included do",
    "    scope :audited, -> { where(audited: true) }",
    "  end",
    "end",
  ].join("\n"),
);
await writeFile(join(repo, "test/fixtures/event_occurrences.yml"), "one:\n  date: 2026-01-01\n");
await writeFile(
  join(repo, "src/app.ts"),
  [
    "import { computeUserScore } from './helpers/math';",
    "import Button from './components/Button';",
    "export { APP_LABEL } from './constants';",
    "export function renderApp() {",
    "  return Button(computeUserScore(2));",
    "}",
  ].join("\n"),
);
await writeFile(join(repo, "src/helpers/math.ts"), [
  "export function computeUserScore(value: number) {",
  "  return value * 10;",
  "}",
  "// NOTE: math.ts is the canonical score helper; see math.ts docs.",
].join("\n"));
await writeFile(join(repo, "src/components/Button.tsx"), "export default function Button(value: number) { return String(value); }\n");
await writeFile(join(repo, "src/constants.ts"), "export const APP_LABEL = 'Agentic Search';\n");

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
assert.match(scopeText, /read the TARGET FILE first/);
assert.match(scopeText, /\[scope\] scope :upcoming/);
assert.match(scopeText, /\[scope\] scope :past/);
assert.match(scopeText, /\[scope\] scope :by_date_range/);
assert.match(scopeText, /\[scope\] scope :with_budget/);
assert.equal(scopeResult.details.files[0].matchCount, 4);
assert.equal(scopeResult.details.files[0].confidence, 1);

const broadDirectoryResult = await searchTool.execute(
  "tool-call-3",
  { query: "created_at.*<=", path: "app", max_files: 10 },
  undefined,
  undefined,
  { cwd: repo },
);
const broadDirectoryText = broadDirectoryResult.content[0].text;
assert.equal(broadDirectoryResult.details.files[0].path, "app/models/post.rb");
assert.match(broadDirectoryText, /TARGET FILE: app\/models\/post\.rb/);
assert.match(broadDirectoryText, /L3 \[ref\] where\("posts\.created_at <= \?", created_at\)/);
assert.doesNotMatch(broadDirectoryText, /TARGET FILE: app\/controllers\/application_controller\.rb/);
assert.ok(
  broadDirectoryResult.details.files[0].reasons.some((reason: string) => reason === "content match"),
  "content-backed results should outrank broad directory path candidates",
);

const absolutePathResult = await searchTool.execute(
  "tool-call-4",
  { query: "created_at.*<=", path: join(repo, "app/models/post.rb"), max_files: 10 },
  undefined,
  undefined,
  { cwd: process.cwd() },
);
const absolutePathText = absolutePathResult.content[0].text;
assert.match(absolutePathText, /posts\.created_at <= \?/);
assert.match(absolutePathResult.details.files[0].path, /app\/models\/post\.rb$/);
assert.equal(absolutePathResult.details.files[0].confidence, 1);

const absoluteDirectoryResult = await searchTool.execute(
  "tool-call-5",
  { query: "created_at.*<=", path: join(repo, "app"), max_files: 10 },
  undefined,
  undefined,
  { cwd: process.cwd() },
);
const absoluteDirectoryText = absoluteDirectoryResult.content[0].text;
assert.match(absoluteDirectoryText, /TARGET FILE: .*app\/models\/post\.rb/);
assert.match(absoluteDirectoryText, /posts\.created_at <= \?/);
assert.doesNotMatch(absoluteDirectoryText, /application_controller\.rb[\s\S]*\[path\] filename\/path match/);
assert.equal(absoluteDirectoryResult.details.files[0].confidence, 1);

const pathOnlySelectiveResult = await searchTool.execute(
  "tool-call-6",
  { query: "post.rb", max_files: 5 },
  undefined,
  undefined,
  { cwd: repo },
);
assert.equal(pathOnlySelectiveResult.details.files[0].path, "app/models/post.rb");
assert.match(pathOnlySelectiveResult.content[0].text, /\[path\] filename\/path match/);

const ambiguousSelectiveResult = await searchTool.execute(
  "tool-call-7",
  { query: "created_at.*<=", path: "post.rb", max_files: 10 },
  undefined,
  undefined,
  { cwd: repo },
);
assert.equal(ambiguousSelectiveResult.details.files[0].path, "app/models/post.rb");
assert.match(ambiguousSelectiveResult.content[0].text, /posts\.created_at <= \?/);
assert.ok(
  ambiguousSelectiveResult.details.files[0].reasons.some((reason: string) => reason === "content match"),
  "selective path hints should still rank the content-backed matching file first",
);

const noContextRemainingValueResult = await searchTool.execute(
  "tool-call-context-1",
  { query: "remaining_value", max_files: 5 },
  undefined,
  undefined,
  { cwd: repo },
);
assert.equal(noContextRemainingValueResult.details.files[0].path, "app/services/finance/payment_schedule.rb");
assert.ok(
  noContextRemainingValueResult.details.files.some((file: any) => file.path === "app/models/goal/progress.rb"),
  "no-context search should still return the competing goal/progress match",
);
assert.ok(
  noContextRemainingValueResult.details.files.every((file: any) =>
    file.reasons.every((reason: string) => !reason.startsWith("context tokens matched")),
  ),
  "context reasons should not appear when context is omitted",
);

const contextualRemainingValueResult = await searchTool.execute(
  "tool-call-context-2",
  { query: "remaining_value", context: "actual goal progress", max_files: 5 },
  undefined,
  undefined,
  { cwd: repo },
);
const contextualRemainingValueText = contextualRemainingValueResult.content[0].text;
assert.equal(contextualRemainingValueResult.details.context, "actual goal progress");
assert.equal(contextualRemainingValueResult.details.totalMatches, noContextRemainingValueResult.details.totalMatches);
assert.equal(contextualRemainingValueResult.details.files[0].path, "app/models/goal/progress.rb");
assert.match(contextualRemainingValueText, /TARGET FILE: app\/models\/goal\/progress\.rb/);
assert.match(contextualRemainingValueText, /context tokens matched snippets: actual/);
assert.match(contextualRemainingValueText, /context tokens matched path: goal, progress/);
assert.ok(
  contextualRemainingValueResult.details.files[0].reasons.some((reason: string) => reason === "context tokens matched snippets: actual"),
  "contextual ranking should explain snippet-token matches",
);
assert.ok(
  contextualRemainingValueResult.details.files[0].reasons.some((reason: string) => reason === "context tokens matched path: goal, progress"),
  "contextual ranking should explain path-token matches",
);

const mixinExpandedResult = await searchTool.execute(
  "tool-call-8",
  { query: "scope\\s+:", path: "app/models/user.rb", expand_related: true, max_files: 10 },
  undefined,
  undefined,
  { cwd: repo },
);
const mixinExpandedText = mixinExpandedResult.content[0].text;
assert.equal(mixinExpandedResult.details.files[0].path, "app/models/user.rb");
assert.match(mixinExpandedText, /scope :direct_user/);
assert.match(mixinExpandedText, /scope :profiled/);
assert.match(mixinExpandedText, /scope :audited/);
assert.match(mixinExpandedText, /TARGET FILE: app\/models\/user\.rb\. Read this file first; expand_related also searched 2 resolved mixin files shown below as 1\.x related targets\./);
assert.match(mixinExpandedText, /expand_related: searched 2 resolved mixin files/);
assert.match(mixinExpandedText, /Resolved mixins: ProfileScopes -> app\/models\/user\/profile_scopes\.rb/);
assert.match(mixinExpandedText, /Audit::Scopes -> app\/models\/concerns\/audit\/scopes\.rb/);
assert.match(mixinExpandedText, /Unresolved mixins: MissingConcern/);
assert.doesNotMatch(mixinExpandedText, /ActiveSupport::Concern/);
assert.deepEqual(
  mixinExpandedResult.details.related.roots.sort(),
  ["app/models/concerns/audit/scopes.rb", "app/models/user/profile_scopes.rb"],
);
assert.deepEqual(
  mixinExpandedResult.details.files.slice(1, 3).map((file: any) => file.path).sort(),
  ["app/models/concerns/audit/scopes.rb", "app/models/user/profile_scopes.rb"],
);
assert.ok(
  mixinExpandedResult.details.files.slice(1, 3).every((file: any) => file.reasons[0].startsWith("mixin target:")),
  "mixin-expanded files should appear directly below the primary file and be labelled as likely targets",
);
const mixinExpandedRender = searchTool.renderResult(
  mixinExpandedResult,
  { expanded: true, isPartial: false },
  identityTheme,
).render(200).join("\n");
assert.match(mixinExpandedRender, /mixin files below are likely targets too/);
assert.match(mixinExpandedRender, /mixin results are included search values and likely targets too/);
assert.match(mixinExpandedRender, /↳ 1\.\d\. app\/models\/user\/profile_scopes\.rb/);
assert.match(mixinExpandedRender, /\[included by app\/models\/user\.rb via ProfileScopes; mixin also includes search values, very likely a target too\]/);

const basenameMixinExpandedResult = await searchTool.execute(
  "tool-call-9",
  { query: "scope\\s+:", path: "user.rb", expand_related: true, max_files: 10 },
  undefined,
  undefined,
  { cwd: repo },
);
const basenameMixinExpandedText = basenameMixinExpandedResult.content[0].text;
assert.equal(basenameMixinExpandedResult.details.files[0].path, "app/models/user.rb");
assert.match(basenameMixinExpandedText, /scope :direct_user/);
assert.match(basenameMixinExpandedText, /scope :profiled/);
assert.match(basenameMixinExpandedText, /scope :audited/);
assert.match(basenameMixinExpandedText, /expand_related also searched 2 resolved mixin files/);

const importExpandedResult = await searchTool.execute(
  "tool-call-10",
  { query: "computeUserScore", path: "src/app.ts", expand_related: true, max_files: 10 },
  undefined,
  undefined,
  { cwd: repo },
);
const importExpandedText = importExpandedResult.content[0].text;
assert.equal(importExpandedResult.details.files[0].path, "src/app.ts");
assert.equal(importExpandedResult.details.related.label, "import");
assert.match(importExpandedText, /TARGET FILE: src\/app\.ts\. Read this file first; expand_related also searched 3 resolved import files shown below as 1\.x related targets\./);
assert.match(importExpandedText, /↳ 1\.1\. src\/helpers\/math\.ts/);
assert.match(importExpandedText, /imported by src\/app\.ts via \.\/helpers\/math; related import also includes search values, very likely a target too/);
assert.match(importExpandedText, /L1 \[def\] export function computeUserScore/);
assert.match(importExpandedText, /src\/components\/Button\.tsx/);
assert.match(importExpandedText, /src\/constants\.ts/);
const importExpandedRender = searchTool.renderResult(
  importExpandedResult,
  { expanded: true, isPartial: false },
  identityTheme,
).render(220).join("\n");
assert.match(importExpandedRender, /import files below are likely targets too/);
assert.match(importExpandedRender, /↳ 1\.1\. src\/helpers\/math\.ts/);
assert.match(importExpandedRender, /related import also includes search values, very likely a target too/);

const importDisabledResult = await searchTool.execute(
  "tool-call-11",
  { query: "computeUserScore", path: "src/app.ts", max_files: 10 },
  undefined,
  undefined,
  { cwd: repo },
);
assert.equal(importDisabledResult.details.files[0].path, "src/app.ts");
assert.doesNotMatch(importDisabledResult.content[0].text, /src\/helpers\/math\.ts/);
assert.equal(importDisabledResult.details.related, undefined);

const mixinDisabledResult = await searchTool.execute(
  "tool-call-12",
  { query: "scope\\s+:", path: "app/models/user.rb", max_files: 10 },
  undefined,
  undefined,
  { cwd: repo },
);
assert.match(mixinDisabledResult.content[0].text, /scope :direct_user/);
assert.doesNotMatch(mixinDisabledResult.content[0].text, /scope :profiled|scope :audited/);
assert.equal(mixinDisabledResult.details.related, undefined);

// ── New behavior assertions ────────────────────────────────────────────────

// 1. Query that is both a filename and content in another file: both lanes surface.
//    math.ts itself now contains a literal "math.ts" comment; app.ts does not.
//    The path lane must still surface math.ts, and a separate query for a content
//    string that only app.ts has must surface app.ts (proving content isn't dropped).
const mathPathResult = await searchTool.execute(
  "tool-call-new-1a",
  { query: "math.ts", literal: true, max_files: 10 },
  undefined,
  undefined,
  { cwd: repo },
);
const mathPathPaths = mathPathResult.details.files.map((f: any) => f.path);
assert.ok(mathPathPaths.includes("src/helpers/math.ts"), "path lane should find math.ts");
assert.ok(mathPathResult.details.files.find((f: any) => f.path === "src/helpers/math.ts")?.matchCount >= 1, "math.ts content match should be counted");

const mathContentResult = await searchTool.execute(
  "tool-call-new-1b",
  { query: "computeUserScore", max_files: 10 },
  undefined,
  undefined,
  { cwd: repo },
);
const mathContentPaths = mathContentResult.details.files.map((f: any) => f.path);
assert.ok(mathContentPaths.includes("src/app.ts"), "content lane should find app.ts which calls computeUserScore");
assert.ok(mathContentPaths.includes("src/helpers/math.ts"), "content lane should find math.ts which defines computeUserScore");

// 2. Absolute path outside cwd is confined to that exact file (allowed deliberately,
//    e.g. tmp fixtures) but cannot broaden into the repo.
const outsideResult = await searchTool.execute(
  "tool-call-new-2",
  { query: "secret_token", path: join(repo, ".outside-secret.rb"), max_files: 5 },
  undefined,
  undefined,
  { cwd: repo },
);
assert.match(outsideResult.content[0].text, /No matches found/, "search outside the named file returns nothing");

// 3. Go receiver-method definition detection.
{
  const goOut = JSON.stringify({ type: "match", data: { path: { text: "main.go" }, lines: { text: "func (s *Server) Start() error {\n" }, line_number: 10, submatches: [] } });
  const goMatches = parseRipgrepJsonLines(goOut);
  assert.equal(goMatches[0]?.isDefinition, true, "Go method should be definition-like");
}

// 4. expand_related on a directory root now expands.
const dirExpandedResult = await searchTool.execute(
  "tool-call-new-4",
  { query: "scope\\s+:", path: "app/models", expand_related: true, max_files: 10 },
  undefined,
  undefined,
  { cwd: repo },
);
assert.ok(dirExpandedResult.details.related !== undefined, "expand_related should fire on directory root");
assert.ok(dirExpandedResult.details.related.roots.length >= 2, "should resolve mixins from directory walk");
assert.match(dirExpandedResult.content[0].text, /expand_related: searched/);

// 5. Invalid regex pre-validation avoids the rg spawn (still returns results).
const sigBraceResult = await searchTool.execute(
  "tool-call-new-5",
  { query: "sig {", max_files: 5 },
  undefined,
  undefined,
  { cwd: repo },
);
assert.equal(sigBraceResult.details.literalFallback, true, "invalid regex should mark literalFallback");
assert.match(sigBraceResult.content[0].text, /literal string/);

console.log("pi-agentic-search smoke test passed");

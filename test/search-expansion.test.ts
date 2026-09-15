import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runSearch } from "../src/extension.ts";
import { coverageNotes, groupCoverageReasons } from "../src/coverage-summary.ts";
import { renderResult } from "../src/render.ts";

async function fixture(files: Record<string, string>, run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "search-seeds-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), source);
    }
    await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

const files = {
  "package.json": '{"name":"fixture"}',
  "billing/app/services/eligibility.rb": "class Eligibility\n  def eligible\n    Incentives::Incentive.active.for_surface_view(view).by_priority\n  end\nend\n",
  "billing/app/services/unrelated.rb": "class Unrelated\n  include MissingBillingHelper\nend\n",
  "billing/test/fixture.rb": "Incentives::Incentive.new\n",
  "outside.rb": "Incentives::Incentive.new\n",
};

for (const absolute of [false, true]) {
  test(`directory expansion starts from ranked matches (${absolute ? "absolute" : "relative"} path)`, () => fixture(files, async (cwd) => {
    const result = await runSearch({
      query: "Incentives::Incentive", intent: "references", path: absolute ? join(cwd, "billing") : "billing",
      context: "production composing active for_surface_view by_priority", expand_related: true, literal: true, case_sensitive: true, max_files: 1,
    }, cwd);
    assert.equal(result.details.files[0]?.path, "billing/app/services/eligibility.rb");
    assert.deepEqual(result.details.coverage.relatedSeeding?.roots, ["billing/app/services/eligibility.rb"]);
    assert.equal(result.details.coverage.relatedSeeding?.omittedFiles, 1);
    assert.equal(result.details.coverage.ownerRoot, undefined);
    assert.equal(result.details.totalFiles, 2);
    assert.ok(!result.details.coverage.runs.some((run) => run.kind === "inventory"));
    assert.doesNotMatch(result.content[0]!.text, /MissingBillingHelper|outside.rb/);
    assert.match(result.content[0]!.text, /related seed budget/);
  }));
}

test("an exact file still expands its mixins even when the file itself does not match", () => fixture({
  "app/models/account.rb": "class Account\n  include Scopes\nend\n",
  "app/models/concerns/scopes.rb": "module Scopes\n  scope :active, -> { all }\nend\n",
}, async (cwd) => {
  const result = await runSearch({ query: "scope\\s+:", path: "app/models/account.rb", expand_related: true }, cwd);
  assert.deepEqual(result.details.related?.roots, ["app/models/concerns/scopes.rb"]);
  assert.equal(result.details.files[0]?.path, "app/models/concerns/scopes.rb");
}));

test("a directory with no matching files does not walk unrelated source files", () => fixture(files, async (cwd) => {
  const result = await runSearch({ query: "not_present", path: "billing", expand_related: true }, cwd);
  assert.equal(result.details.totalFiles, 0);
  assert.match(result.content[0]!.text, /no matching files.*to expand from/);
  assert.ok(!result.details.coverage.runs.some((run) => run.kind === "inventory"));
}));

test("related paths already searched by an absolute directory are not searched a second time", () => fixture({
  "app/models/account.rb": "class Account\n  include Scopes\n  scope :needle, -> { all }\nend\n",
  "app/models/concerns/scopes.rb": "module Scopes\n  scope :needle, -> { all }\nend\n",
}, async (cwd) => {
  const result = await runSearch({ query: "scope\\s+:", path: join(cwd, "app"), expand_related: true }, cwd);
  assert.equal(result.details.related?.resolved[0]?.name, "Scopes");
  assert.equal(result.details.totalMatches, 2);
  assert.ok(!result.details.coverage.runs.some((run) => run.stage === "related"));
}));

test("repeated coverage reasons stay complete in details and short in text and TUI", () => fixture({ "main.rb": "needle\n" }, async (cwd) => {
  const result = await runSearch({ query: "needle", path: "main.rb" }, cwd);
  const reasons = [
    ...Array.from({ length: 200 }, (_, i) => `unresolved T::Helpers from app/models/file-${i}.rb`),
    ...Array.from({ length: 50 }, (_, i) => `source byte budget at app/models/large-${i}.rb (256/999 bytes)`),
  ];
  result.details.coverage.status = "partial";
  result.details.coverage.reasons = reasons;
  const groups = groupCoverageReasons(reasons);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.names.get("T::Helpers"), 200);
  const notes = coverageNotes(result.details.coverage).join("\n");
  assert.match(notes, /T::Helpers ×200/);
  assert.match(notes, /source byte budget ×50/);
  assert.match(notes, /250 reasons in details.coverage.reasons/);
  assert.ok(notes.length < 1400, notes);
  assert.deepEqual(result.details.coverage.reasons, reasons);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const rendered = renderResult(result, { expanded: false, isPartial: false }, theme).render(120).join("\n");
  assert.ok(rendered.length < 1200);
  assert.doesNotMatch(rendered, /file-199|large-49/);
}));

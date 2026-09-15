import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import agenticSearchExtension, { parseUnifiedDiff, scanSparsity } from "../index.ts";

const base: Record<string, string> = {
  "component.yml": "name: billing\n",
  "app/models/billing/reader.rb": `# frozen_string_literal: true

module Billing
  class Reader
    def initialize(shop)
      @shop = shop
    end

    def applicable?
      return false unless @shop.organization_id
      entity = Admin::LegalEntity.for_shop(@shop)
      return false if entity.nil?

      complete_entity?(entity) && !exempt?
    end

    private

    def complete_entity?(entity)
      entity.complete?
    end

    def exempt?
      Billing::Exemptions.applies?(@shop)
    end
  end
end
`,
  "app/models/admin/legal_entity.rb": `# frozen_string_literal: true

module Admin
  class LegalEntity
    def self.for_shop(shop)
      where(organization_id: shop.organization_id).first
    end

    def complete?
      true
    end
  end
end
`,
  "app/models/billing/exemptions.rb": `# frozen_string_literal: true

module Billing
  class Exemptions
    def self.applies?(shop)
      shop.exempt_from_registration?
    end

    def self.legacy_applies?(shop)
      shop.legacy_exempt?
    end
  end
end
`,
  "app/jobs/billing/registration_check_job.rb": `# frozen_string_literal: true

module Billing
  class RegistrationCheckJob
    def perform(shop)
      return unless Billing::Reader.new(shop).applicable?

      mark_complete(shop)
    end
  end
end
`,
  "test/models/billing/reader_test.rb": `# frozen_string_literal: true

class ReaderTest < ActiveSupport::TestCase
  test "applicable for complete entities" do
    assert Billing::Reader.new(shop).applicable?
  end
end
`,
  "web/package.json": `{ "name": "web" }\n`,
  "web/src/team.ts": `export function loadTeam(id: string) {
  return { id };
}
`,
  "web/src/reader.ts": `import { loadTeam } from "./team";

export function readProfile(id: string) {
  const team = loadTeam(id);
  return team.id;
}
`,
  "config/settings.yml": "registration: true\n",
};

const cwd = await mkdtemp(join(tmpdir(), "sparsity-scan-"));
const writeAll = async (files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content, "utf8");
  }
};
const run = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });

await writeAll(base);
run(["init", "-q", "-b", "main"]);
run(["add", "."]);
run(["commit", "-q", "-m", "base"]);

// Change set: modify applicable?, add a method, remove legacy_applies? (still called from the job), touch the test and the TS file, edit YAML.
await writeAll({
  "app/models/billing/reader.rb": base["app/models/billing/reader.rb"]!
    .replace("return false unless @shop.organization_id\n", "return false unless @shop.organization_id\n      return false if @shop.frozen?\n")
    .replace("    def exempt?\n", "    def registration_due?\n      Billing::Exemptions.legacy_applies?(@shop)\n    end\n\n    def exempt?\n"),
  "app/models/billing/exemptions.rb": base["app/models/billing/exemptions.rb"]!.replace(`
    def self.legacy_applies?(shop)
      shop.legacy_exempt?
    end
`, ""),
  "app/jobs/billing/registration_check_job.rb": base["app/jobs/billing/registration_check_job.rb"]!.replace("      mark_complete(shop)\n", "      mark_complete(shop) if Billing::Exemptions.legacy_applies?(shop)\n"),
  "app/models/billing/new_policy.rb": `module Billing
  class NewPolicy
    def allowed?
      true
    end
  end
end
`,
  "test/models/billing/reader_test.rb": base["test/models/billing/reader_test.rb"]!
    .replace("    assert Billing::Reader.new(shop).applicable?\n", "    assert Billing::Reader.new(shop).applicable?\n    assert_not Billing::Reader.new(frozen_shop).applicable?\n")
    .replace("  end\nend\n", `  end

  test "inactive" do
    assert_not Billing::Reader.new(inactive_shop).applicable?
  end

  test "frozen" do
    assert_not Billing::Reader.new(frozen_shop).applicable?
  end

  test "missing entity" do
    assert_not Billing::Reader.new(missing_entity_shop).applicable?
  end

  test "incomplete entity" do
    assert_not Billing::Reader.new(incomplete_entity_shop).applicable?
  end

  test "complete entity" do
    assert Billing::Reader.new(complete_entity_shop).applicable?
  end

  test "legacy registration" do
    assert Billing::Reader.new(legacy_shop).registration_due?
  end

  test "new registration" do
    assert Billing::Reader.new(new_shop).registration_due?
  end

  test "exempt" do
    assert Billing::Reader.new(exempt_shop).exempt?
  end
end
`),
  "web/src/reader.ts": base["web/src/reader.ts"]!.replace("  return team.id;\n", "  return team.id.toUpperCase();\n"),
  "config/settings.yml": "registration: false\n",
});
run(["add", "."]);
run(["commit", "-q", "-m", "change"]);

const outputDir = join(cwd, ".sparsity-out");
const defaults = { cwd, maxDepth: 2, vicinity: 20, maxNodes: 60, maxAnchors: 40, budgetMs: 30_000, outputDir, inlineBudgetBytes: 40 * 1024 };

// Diff parsing on its own
const parsed = parseUnifiedDiff(run(["diff", "--unified=0", "--no-color", "--no-ext-diff", "HEAD~1", "HEAD"]));
assert.equal(parsed.length, 7);
const readerFile = parsed.find((file) => file.path === "app/models/billing/reader.rb")!;
assert.equal(readerFile.kind, "code");
assert.equal(readerFile.language, "ruby");
assert.ok(readerFile.newRanges.length >= 2);
assert.equal(parsed.find((file) => file.path === "config/settings.yml")?.kind, "other");
assert.equal(parsed.find((file) => file.path === "test/models/billing/reader_test.rb")?.kind, "test");

// Index the committed range
const result = await scanSparsity({ ...defaults, diff: "HEAD~1..HEAD" });
assert.match(result.label, /HEAD~1\.\.HEAD/);
assert.equal(result.dirty, false);
assert.deepEqual(result.roots.sort(), [".", "web"]);
assert.equal(result.files.length, 7);

const dotRoot = await scanSparsity({ ...defaults, diff: "HEAD~1..HEAD", root: ".", outputDir: join(cwd, ".sparsity-dot-root") });
assert.deepEqual(dotRoot.roots.sort(), [".", "web"], "root dot keeps automatic per-component roots instead of collapsing to the repository");
assert.match(dotRoot.coverage.notes.join("\n"), /Whole-repository root override ignored/);

const symbols = result.anchors.map((anchor) => anchor.symbol);
assert.ok(symbols.includes("Billing::Reader#applicable?"), `anchors: ${symbols.join(", ")}`);
assert.ok(symbols.includes("Billing::Reader#registration_due?"));
assert.ok(symbols.includes("Billing::RegistrationCheckJob#perform"));
assert.ok(symbols.includes("Billing::NewPolicy#allowed?"));
assert.ok(!result.anchors.some((anchor) => anchor.path === "app/models/billing/new_policy.rb" && ["class", "module"].includes(anchor.kind)), "added class/module wrappers are redundant when a changed child definition is anchored");
assert.ok(symbols.includes("readProfile"));
assert.ok(symbols.some((symbol) => symbol.includes('test "applicable for complete entities"')), "changed test body is an anchor");
assert.equal(result.anchors.filter((anchor) => anchor.path === "test/models/billing/reader_test.rb").length, 2, "only the first two changed test definitions become anchors");
assert.equal(result.testGroups.length, 1);
assert.equal(result.testGroups[0]!.entries.length, 7, "overflow test definitions stay readable in one group");
assert.match(result.inline, /GROUPED TESTS.*test-group:t1/s);
assert.equal(result.fileHunks.length, 1);
assert.equal(result.fileHunks[0]!.path, "config/settings.yml");
assert.match(result.inline, /## file:f1[\s\S]*f1 config\/settings\.yml[\s\S]*1 -\| registration: true[\s\S]*1 \+\| registration: false/);
const applicable = result.anchors.find((anchor) => anchor.symbol === "Billing::Reader#applicable?")!;
assert.ok(applicable.changedLines.includes(11), `changed lines ${applicable.changedLines.join(",")}`);
const applicableNode = result.nodes.find((node) => node.id === applicable.id)!;
assert.match(applicableNode.snippet, /^11 \+\| +return false if @shop\.frozen\?$/m, "added line carries a + mark");
assert.match(applicableNode.snippet, /^10 {2}\| /m, "unchanged line carries no mark");
const perform = result.anchors.find((anchor) => anchor.symbol === "Billing::RegistrationCheckJob#perform")!;
assert.ok(perform.removed.some((block) => block.lines.some((line) => /mark_complete\(shop\)$/.test(line))), "replaced old line is listed as removed");
assert.ok(applicable.callers.some((caller) => caller.path === "app/jobs/billing/registration_check_job.rb"));
assert.ok(applicable.callers.find((caller) => caller.path === "app/jobs/billing/registration_check_job.rb")?.changed, "changed caller is flagged");
assert.ok(applicable.tests.some((test) => test.path === "test/models/billing/reader_test.rb"));
assert.ok(!applicable.callers.some((caller) => caller.test), "tests are not listed as callers");

// Production anchors rank before test anchors
const firstTestIndex = result.anchors.findIndex((anchor) => anchor.path.startsWith("test/"));
const lastProdIndex = result.anchors.map((anchor) => anchor.path.startsWith("test/")).lastIndexOf(false);
assert.ok(firstTestIndex > lastProdIndex);

// Removed definition with a surviving caller
const dangling = result.dangling.find((item) => item.name === "legacy_applies?");
assert.ok(dangling, "removed legacy_applies? is reported");
assert.equal(dangling.stillDefined, false);
assert.ok(dangling.callers.some((caller) => caller.path === "app/jobs/billing/registration_check_job.rb"), "surviving caller found");
assert.ok(dangling.callers.some((caller) => caller.path === "app/models/billing/reader.rb"), "new caller inside the changed file found");

// Edges resolved through the shared graph
const forShop = result.edges.find((edge) => edge.from === applicable.id && edge.name === "Admin::LegalEntity.for_shop");
assert.equal(forShop?.resolution, "exact");
assert.ok(result.edges.some((edge) => edge.from === applicable.id && edge.name === "@shop.organization_id" && edge.resolution === "unresolved"));
assert.ok(!result.edges.some((edge) => edge.name === "frozen?"), "common Object methods are not followed");

// Pack files and sections
const pack = await readFile(result.packPath, "utf8");
assert.match(pack, /^## manifest\n/);
assert.match(pack, /## anchor:n\d+/);
assert.match(pack, /## dangling/);
assert.match(pack, /## recap/);
const manifest = result.sections.find((section) => section.id === "manifest")!;
assert.equal(manifest.inline, true);
for (const section of result.sections) {
  const lines = pack.split("\n");
  assert.equal(lines[section.startLine - 1], `## ${section.id}`, `section ${section.id} starts at its declared line`);
  assert.ok(section.endLine >= section.startLine);
}
assert.match(result.inline, /SPARSITY SCAN HEAD~1\.\.HEAD/);
assert.match(result.inline, /FILES\n/);
assert.match(result.inline, /M app\/models\/billing\/reader\.rb {2}\[code, ruby\]/);
assert.match(result.inline, /M config\/settings\.yml {2}\[other\]/);
assert.match(result.inline, /legacy_applies\? removed from app\/models\/billing\/exemptions\.rb:\d+: NO definition left/);
assert.match(result.inline, /^Resolution: exact .* name_only \(root-wide name match\)/m);
const json = JSON.parse(await readFile(result.jsonPath, "utf8"));
assert.equal(json.anchors.length, result.anchors.length);
assert.equal(json.inline, undefined);

// Inline budget spills sections and the manifest says where they went
const tight = await scanSparsity({ ...defaults, diff: "HEAD~1..HEAD", outputDir: join(cwd, ".sparsity-tight"), inlineBudgetBytes: 1500 });
assert.ok(tight.sections.some((section) => !section.inline && section.id !== "manifest"), "some section spilled");
assert.match(tight.inline, /\[spilled: read .*pack\.md lines \d+-\d+/);
assert.match(tight.sections.find((section) => section.id === "manifest")!.body, /spilled/);

// Worktree mode: an uncommitted edit plus an untracked file
await writeAll({
  "app/models/admin/legal_entity.rb": base["app/models/admin/legal_entity.rb"]!.replace("      true\n", "      organization_id.present?\n"),
  "app/models/billing/notice.rb": "# frozen_string_literal: true\n\nmodule Billing\n  class Notice\n    def deliver\n      Billing::Reader.new(shop).applicable?\n    end\n  end\nend\n",
});
const worktree = await scanSparsity({ ...defaults, diff: "worktree", outputDir: join(cwd, ".sparsity-wt") });
assert.equal(worktree.dirty, true);
assert.ok(worktree.anchors.some((anchor) => anchor.symbol === "Admin::LegalEntity#complete?"));
assert.ok(worktree.anchors.some((anchor) => anchor.symbol === "Billing::Notice#deliver"), "untracked file definitions are anchors");
assert.ok(worktree.files.find((file) => file.path === "app/models/billing/notice.rb")?.status === "added");

// With a Ruby index: callers and tests come from the inverse call map, edges carry how they were resolved
const indexed = await scanSparsity({ ...defaults, diff: "HEAD~1..HEAD", outputDir: join(cwd, ".sparsity-scanned"), indexCacheDir: join(cwd, ".sparsity-cache") });
assert.match(indexed.inline, /^index: Ruby index for \.: \d+ files, \d+ definitions/m, "manifest reports the index");
const indexedApplicable = indexed.anchors.find((anchor) => anchor.symbol === "Billing::Reader#applicable?")!;
assert.ok(indexedApplicable.callers.some((caller) => caller.symbol === "Billing::RegistrationCheckJob#perform"), "caller found through the call index");
assert.ok(indexedApplicable.tests.some((test) => test.path === "test/models/billing/reader_test.rb"), "test found through the call index");
const indexedForShop = indexed.edges.find((edge) => edge.from === indexedApplicable.id && edge.name === "Admin::LegalEntity.for_shop")!;
assert.deepEqual([indexedForShop.resolution, indexedForShop.via], ["exact", "constant"]);
const indexedComplete = indexed.edges.find((edge) => edge.from === indexedApplicable.id && edge.name === "complete_entity?")!;
assert.deepEqual([indexedComplete.resolution, indexedComplete.via], ["exact", "self"], "implicit receiver resolved through the owner");
const indexedCompleteNode = indexed.nodes.find((node) => node.id === indexedComplete.to)!;
const entityComplete = indexed.edges.find((edge) => edge.from === indexedCompleteNode.id && edge.name === "entity.complete?")!;
assert.deepEqual([entityComplete.resolution, entityComplete.via], ["static_candidate", "name_only"], "untyped parameter falls back to a name-only search and says so");
assert.match(indexed.inline, /\[exact, constant\]/);
const indexedDangling = indexed.dangling.find((item) => item.name === "legacy_applies?")!;
assert.ok(indexedDangling.callers.some((caller) => caller.path === "app/jobs/billing/registration_check_job.rb"), "dangling callers through the call index");

// Metrics: one file per run, one line per run in the rolling log, summarizable
const metricsLog = join(cwd, ".sparsity-metrics.jsonl");
const measured = await scanSparsity({ ...defaults, diff: "HEAD~1..HEAD", outputDir: join(cwd, ".sparsity-metrics"), indexCacheDir: join(cwd, ".sparsity-cache"), metricsLog });
const metrics = JSON.parse(await readFile(measured.metricsPath, "utf8"));
assert.equal(metrics.kind, "sparsity_scan");
assert.equal(metrics.anchors.expanded, measured.anchors.length);
assert.equal(metrics.edges, measured.edges.length);
assert.ok(metrics.resolution.exact > 0);
assert.ok(metrics.via.self > 0, `via labels counted: ${JSON.stringify(metrics.via)}`);
assert.ok(metrics.byLanguage.ruby.edges > 0 && metrics.byLanguage.javascript.edges > 0);
assert.ok(metrics.index.some((entry: { cacheHit: boolean }) => entry.cacheHit === true), "cached Ruby index reported");
assert.ok(metrics.programs.some((entry: { files: number }) => entry.files > 0), "TypeScript program reported");
assert.ok(metrics.tokens.inline > 0);
const logLines = (await readFile(metricsLog, "utf8")).trim().split("\n");
assert.equal(logLines.length, 1);
assert.equal(JSON.parse(logLines[0]!).label, metrics.label);
const { summarizeMetrics } = await import("../src/metrics.ts");
assert.match(await summarizeMetrics(metricsLog), /1 scan run, 0 collect runs \(last 1\)\nmedian scan run \d+ ms/);
assert.match(await summarizeMetrics(join(cwd, "missing.jsonl")), /No sparsity runs recorded yet/);

// Explicit anchors bypass the diff
const explicit = await scanSparsity({ ...defaults, diff: "", anchors: ["app/models/billing/reader.rb:10"], outputDir: join(cwd, ".sparsity-explicit") });
assert.equal(explicit.anchors.length, 1);
assert.equal(explicit.anchors[0]!.symbol, "Billing::Reader#applicable?");

// A committed range indexed from a checkout that is not at the range head reads the changed files at the head
const headSha = run(["rev-parse", "HEAD"]).trim();
const baseSha = run(["rev-parse", "HEAD~1"]).trim();
run(["checkout", "-q", baseSha]);
try {
  const detached = await scanSparsity({ ...defaults, diff: `${baseSha}..${headSha}`, outputDir: join(cwd, ".sparsity-detached"), indexCacheDir: join(cwd, ".sparsity-detached-cache") });
  const applicable = detached.anchors.find((anchor) => anchor.symbol === "Billing::Reader#applicable?")!;
  assert.ok(applicable, "the changed method is still an anchor");
  const detachedPack = await readFile(join(cwd, ".sparsity-detached", "pack.md"), "utf8");
  assert.match(detachedPack, /\+\|.*return false if @shop\.frozen\?/, "the snippet shows the range head's line, not the checkout's");
  assert.ok(applicable.changedLines.length > 0, "changed lines line up with the head content");
  assert.ok(detached.anchors.some((anchor) => anchor.symbol === "Billing::Reader#registration_due?"), "a method that only exists at the head is an anchor");
  assert.match(detached.inline, /checkout HEAD \w{12} differs from range head \w{12}: the \d+ changed files were read at/);
  assert.match(detached.inline.split("\n")[3]!, /^revision: changed files, anchors, snippets and line numbers are from the range head/, "the revision line sits directly under the header");
  assert.equal(detached.checkoutHead, baseSha);
  assert.equal(result.checkoutHead, result.head, "a range ending at the checkout carries no revision line");
  assert.ok(!result.inline.includes("\nrevision:"));
  assert.ok(!detached.inline.includes("toUpperCase") || detached.inline.includes("team.id.toUpperCase()"), "TypeScript anchors come from the head content too");
} finally {
  run(["checkout", "-q", "main"]);
}

// Registration
const registered: string[] = [];
let tool: any;
agenticSearchExtension({
  registerTool(definition: { name: string }) {
    registered.push(definition.name);
    if (definition.name === "sparsity_scan") tool = definition;
  },
  registerCommand() {},
} as any);
assert.deepEqual(registered, ["sparsity_scan", "sparsity_collect", "agentic_search"]);
const executed = await tool.execute("call", { diff: "HEAD~1..HEAD", output_dir: join(cwd, ".sparsity-tool") }, undefined, undefined, { cwd });
assert.match(executed.content[0].text, /SPARSITY SCAN/);
assert.equal(executed.details.nodes, undefined, "bulky arrays stay out of tool details");
assert.ok(executed.details.packPath.endsWith("pack.md"));

console.log(`sparsity_scan ok: ${result.anchors.length} anchors, ${result.nodes.length} nodes, ${result.edges.length} edges, ${result.dangling.length} dangling, inline ${Buffer.byteLength(result.inline)} bytes, ${result.coverage.elapsedMs} ms`);

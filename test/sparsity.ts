import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import agenticSearchExtension, { collectSparsity, formatSparsity } from "../index.ts";

const files: Record<string, string> = {
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
      Billing::Exemptions.applies?(@shop) || Billing::Exemptions::EXEMPT_COUNTRIES.include?(@shop.country_code) || Billing::Exemptions.applies_to?(GRACE_DAYS)
    end

    GRACE_DAYS = 14
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
    EXEMPT_COUNTRIES = %w[BR PT].freeze

    def self.applies?(shop)
      Billing::Reader.new(shop).applicable?
    end

    def self.applies_to?(days)
      days > 7
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
  "web/src/team.ts": `export function loadTeam(id: string) {
  return { id };
}

export const TEAM_LIMIT = 3;
`,
  "web/src/index.ts": `export { loadTeam } from "./team";
`,
  "web/src/reader.ts": `import { loadTeam } from "./index";
import { format } from "date-fns";

function normalize(profile: { id: string }) {
  return profile.id.trim();
}

export function readProfile(id: string) {
  const team = loadTeam(id);
  const label = format(new Date(), "yyyy");
  return normalize(team) + label;
}
`,
  "web/package.json": `{ "name": "web" }\n`,
};

const cwd = await mkdtemp(join(tmpdir(), "sparsity-fixture-"));
for (const [path, content] of Object.entries(files)) {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), content, "utf8");
}

const defaults = { cwd, maxDepth: 3, vicinity: 20, maxNodes: 24, callers: true, budgetMs: 20_000 };

// Ruby: anchor, resolution kinds, cycle, callers
const ruby = await collectSparsity({ ...defaults, target: "app/models/billing/reader.rb:10" });
assert.equal(ruby.target.language, "ruby");
assert.equal(ruby.coverage.root, ".");
assert.equal(ruby.anchor.symbol, "Billing::Reader#applicable?");
assert.equal(ruby.anchor.kind, "method");
assert.equal(ruby.anchor.startLine, 9);
assert.equal(ruby.anchor.endLine, 15);
assert.match(ruby.anchor.fingerprint, /^[0-9a-f]{16}$/);
assert.match(ruby.anchor.snippet, /^ 9 \| {5}def applicable\?$/m);

const byName = (name: string) => ruby.edges.filter((edge) => edge.from === ruby.anchor.id && edge.name === name);
const nodeOf = (id?: string) => ruby.nodes.find((node) => node.id === id);

const forShop = byName("Admin::LegalEntity.for_shop")[0];
assert.ok(forShop, "constant method call resolved");
assert.equal(forShop.resolution, "exact");
assert.equal(nodeOf(forShop.to)?.path, "app/models/admin/legal_entity.rb");
assert.equal(nodeOf(forShop.to)?.symbol, "Admin::LegalEntity.for_shop");
assert.equal(nodeOf(forShop.to)?.kind, "singleton_method");

const organizationId = byName("@shop.organization_id")[0];
assert.ok(organizationId, "receiver attribute recorded");
assert.equal(organizationId.resolution, "unresolved");

const complete = byName("complete_entity?")[0];
assert.equal(complete?.resolution, "exact");
assert.equal(nodeOf(complete?.to)?.path, "app/models/billing/reader.rb");

const exempt = byName("exempt?")[0];
const exemptNode = nodeOf(exempt?.to);
const exemptCountries = ruby.edges.find((edge) => edge.from === exemptNode?.id && edge.name === "Billing::Exemptions::EXEMPT_COUNTRIES");
assert.equal(exemptCountries?.resolution, "exact", "namespaced value constant resolves to its assignment");
assert.equal(nodeOf(exemptCountries?.to)?.kind, "constant");
assert.equal(nodeOf(exemptCountries?.to)?.startLine, 5);
const graceDays = ruby.edges.find((edge) => edge.from === exemptNode?.id && edge.name === "GRACE_DAYS");
assert.equal(graceDays?.resolution, "exact", "bare value constant in the same file resolves");
assert.equal(nodeOf(graceDays?.to)?.symbol, "Billing::Reader::GRACE_DAYS");
assert.equal(exempt?.resolution, "exact");
assert.ok(!ruby.edges.some((edge) => edge.name === "nil?"), "common methods are not followed");
assert.ok(!ruby.edges.some((edge) => edge.name === "Admin"), "constant prefixes are not split off");

const applies = ruby.edges.find((edge) => edge.name === "Billing::Exemptions.applies?");
assert.equal(applies?.resolution, "exact");
const appliesNode = nodeOf(applies?.to);
assert.equal(appliesNode?.depth, 2);
const backToReader = ruby.edges.find((edge) => edge.from === appliesNode?.id && edge.name.endsWith("applicable?"));
assert.equal(backToReader?.to, ruby.anchor.id, "call back into the anchor reuses its node");
assert.ok(ruby.coverage.cycles.length >= 1, "cycle recorded");
assert.ok(ruby.coverage.cycles[0]!.includes(ruby.anchor.id));

const callers = ruby.edges.filter((edge) => edge.relationship === "called_by");
const callerPaths = callers.map((edge) => nodeOf(edge.from)?.path).sort();
assert.deepEqual(callerPaths, [
  "app/jobs/billing/registration_check_job.rb",
  "app/models/billing/exemptions.rb",
  "test/models/billing/reader_test.rb",
]);
const testCaller = callers.find((edge) => nodeOf(edge.from)?.path.startsWith("test/"));
assert.equal(testCaller?.note, "test");
assert.match(nodeOf(testCaller?.from)?.symbol ?? "", /ReaderTest test "applicable for complete entities"/);
const jobCaller = callers.find((edge) => nodeOf(edge.from)?.path.startsWith("app/jobs"));
assert.equal(nodeOf(jobCaller?.from)?.symbol, "Billing::RegistrationCheckJob#perform");

assert.equal(ruby.coverage.truncatedBy, "none");
assert.ok(ruby.coverage.rgCalls > 0);
assert.ok(ruby.coverage.notes.some((note) => /static candidates/.test(note)));

const rendered = formatSparsity(ruby);
assert.match(rendered, /^sparsity_collect app\/models\/billing\/reader\.rb:10 \(ruby\) root \./);
assert.match(rendered, /ANCHOR n1 Billing::Reader#applicable\?/);
assert.match(rendered, /-calls-> .*Admin::LegalEntity\.for_shop.*\[exact, constant\]/);
assert.match(rendered, /`@shop\.organization_id` \[unresolved/);
assert.match(rendered, /CALLERS of Billing::Reader#applicable\?/);
assert.match(rendered, /cycles: /);
assert.match(rendered, /COVERAGE/);

// Fingerprints are stable across calls
const again = await collectSparsity({ ...defaults, target: "app/models/billing/reader.rb:12" });
assert.equal(again.anchor.fingerprint, ruby.anchor.fingerprint);
assert.equal(again.anchor.startLine, 9);

// Depth limit leaves a frontier instead of silently stopping
const shallow = await collectSparsity({ ...defaults, target: "app/models/billing/reader.rb:10", maxDepth: 1, callers: false });
assert.ok(shallow.coverage.frontier.some((item) => /\(depth 1\)/.test(item)), "frontier names the depth cap");
assert.ok(shallow.nodes.every((node) => node.depth <= 1));
assert.ok(!shallow.edges.some((edge) => edge.relationship === "called_by"));

// Node cap is reported
const tiny = await collectSparsity({ ...defaults, target: "app/models/billing/reader.rb:10", maxNodes: 2, callers: false });
assert.equal(tiny.nodes.length, 2);
assert.equal(tiny.coverage.truncatedBy, "max_nodes");
assert.ok(tiny.coverage.frontier.some((item) => /max_nodes/.test(item)));

// Class line as anchor
const klass = await collectSparsity({ ...defaults, target: "app/models/billing/reader.rb:4", callers: false });
assert.equal(klass.anchor.kind, "class");
assert.equal(klass.anchor.symbol, "Billing::Reader");
assert.equal(klass.anchor.endLine, 28);

// JS/TS: same-file, barrel re-export, external package, local receiver
const js = await collectSparsity({ ...defaults, target: "web/src/reader.ts:9", callers: false });
assert.equal(js.target.language, "javascript");
assert.equal(js.coverage.root, "web", "nearest package.json is the root");
assert.equal(js.anchor.symbol, "readProfile");
assert.equal(js.anchor.startLine, 8);
assert.equal(js.anchor.endLine, 12);

const jsEdge = (name: string) => js.edges.find((edge) => edge.from === js.anchor.id && edge.name === name);
const loadTeam = jsEdge("loadTeam");
assert.equal(loadTeam?.resolution, "exact");
assert.equal(js.nodes.find((node) => node.id === loadTeam?.to)?.path, "web/src/team.ts", "barrel re-export followed to the definition");
const format = jsEdge("format");
assert.equal(format?.resolution, "external");
assert.match(format?.note ?? "", /date-fns/);
const normalize = jsEdge("normalize");
assert.equal(normalize?.resolution, "exact");
const normalizeNode = js.nodes.find((node) => node.id === normalize?.to);
assert.equal(normalizeNode?.startLine, 4);
assert.ok(!js.edges.some((edge) => edge.name === "id.trim"), "builtin member calls on locals are not recorded");
assert.ok(!js.edges.some((edge) => edge.name === "Date"), "globals are not followed");

// Safety: never outside cwd, never a bad target
await assert.rejects(collectSparsity({ ...defaults, target: "../outside.rb:1" }), /escapes|not found/);
await assert.rejects(collectSparsity({ ...defaults, target: "app/models/billing/reader.rb" }), /path:line/);
await assert.rejects(collectSparsity({ ...defaults, target: "component.yml:1" }), /unsupported language/);

// Registration
const registered: string[] = [];
let tool: any;
agenticSearchExtension({
  registerTool(definition: { name: string }) {
    registered.push(definition.name);
    if (definition.name === "sparsity_collect") tool = definition;
  },
  registerCommand() {},
} as any);
assert.deepEqual(registered, ["sparsity_scan", "sparsity_collect", "agentic_search"]);
assert.match(JSON.stringify(tool.parameters), /"target"/);
assert.match(JSON.stringify(tool.parameters), /max_depth/);
assert.match(JSON.stringify(tool.parameters), /vicinity_check/);

const executed = await tool.execute("call", { target: "app/models/billing/reader.rb:10", max_depth: 2 }, undefined, undefined, { cwd });
assert.match(executed.content[0].text, /ANCHOR n1 Billing::Reader#applicable\?/);
assert.equal(executed.details.coverage.maxDepth, 2);

console.log(`sparsity ok: ruby ${ruby.nodes.length} nodes/${ruby.edges.length} edges in ${ruby.coverage.elapsedMs} ms (${ruby.coverage.rgCalls} rg calls); ts ${js.nodes.length} nodes/${js.edges.length} edges in ${js.coverage.elapsedMs} ms`);

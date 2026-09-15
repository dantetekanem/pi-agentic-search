import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectSparsity, formatSparsity } from "../src/sparsity.ts";
import { TsPrograms } from "../src/adapters/ts.ts";

async function fixture(files: Record<string, string>, run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "sparsity-regression-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), source);
    }
    await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

const options = { root: ".", maxDepth: 4, maxNodes: 60, vicinity: 20, callers: false, budgetMs: 20_000 };

const busySource = [
  "import { join } from 'node:path';",
  "export function execute(operation: () => void) {",
  ...Array.from({ length: 55 }, () => "  join('a', 'b'); operation();"),
  ...Array.from({ length: 20 }, () => "  first();"),
  "  rankFileGroups(); enrichContext(); formatSearchResults();",
  "}",
  "function first() {}",
  "function rankFileGroups() {}",
  "function enrichContext() {}",
  "function formatSearchResults() {}",
].join("\n");

test("late internal calls survive many external calls, callbacks and repeated targets", () => fixture({
  "main.ts": busySource,
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "main.ts:2" });
  for (const name of ["first", "rankFileGroups", "enrichContext", "formatSearchResults"]) {
    const edge = result.edges.find((edge) => edge.name === name);
    assert.equal(edge?.resolution, "exact", name);
    assert.equal(result.nodes.find((node) => node.id === edge?.to)?.symbol, name);
  }
  assert.equal(result.edges.filter((edge) => edge.name === "join" && edge.resolution === "external").length, 55);
  assert.equal(result.edges.filter((edge) => edge.name === "operation" && edge.resolution === "local").length, 55);
  assert.deepEqual(result.coverage.cycles, []);
  assert.deepEqual(result.coverage.frontier, []);
  const lines = result.edges.filter((edge) => edge.from === result.anchor.id).map((edge) => edge.line);
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b), "priority does not rewrite source order");
}));

test("same-line callback parameters are local while a real recursive method remains a cycle", () => fixture({
  "main.ts": `class SearchRequest {
  replaceFile(operation: () => void) {
    operation();
    const local = () => {};
    local();
    this.replaceFile(operation);
  }
}
`,
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "main.ts:2" });
  const callback = result.edges.find((edge) => edge.name === "operation")!;
  assert.equal(callback.resolution, "local");
  assert.equal(callback.to, undefined);
  assert.match(callback.note!, /parameter/);
  assert.equal(result.edges.find((edge) => edge.name === "local")?.resolution, "local");
  assert.equal(result.edges.find((edge) => edge.name === "this.replaceFile")?.to, result.anchor.id);
  assert.equal(result.coverage.cycles.length, 1);
}));

test("wall time includes program preparation, with an explicit setup boundary", () => fixture({
  "main.ts": "export function run() { helper(); }\nfunction helper() {}\n",
}, async (cwd) => {
  const prepare = TsPrograms.prototype.prepare;
  const now = Date.now;
  let clock = 10_000;
  Date.now = () => clock;
  TsPrograms.prototype.prepare = function (...args) {
    clock += 700;
    prepare.apply(this, args);
  };
  try {
    const result = await collectSparsity({ ...options, cwd, target: "main.ts:1" });
    assert.equal(result.coverage.setupMs, 700);
    assert.equal(result.coverage.elapsedMs, 700);
    assert.match(formatSparsity(result), /700 ms wall \(setup 700 ms/);
  } finally {
    TsPrograms.prototype.prepare = prepare;
    Date.now = now;
  }
}));

test("call and depth caps remain visible when depth reaches the requested maximum", () => fixture({
  "main.ts": [
    "export function run() {",
    ...Array.from({ length: 30 }, (_, i) => `  call${i}();`),
    "}",
    ...Array.from({ length: 30 }, (_, i) => `function call${i}() { leaf(); }`),
    "function leaf() {}",
  ].join("\n"),
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "main.ts:1", maxDepth: 1 });
  assert.equal(result.coverage.depthReached, 1);
  assert.ok(result.coverage.frontier.some((item) => item.includes("call cap")));
  assert.ok(result.coverage.frontier.some((item) => item.includes("depth 1")));
  const header = formatSparsity(result).split("\n")[0]!;
  assert.match(header, /depth 1\/1.*bounded:.*call cap/);
  assert.match(header, /depth cap/);
}));

test("multi-candidate Ruby calls cannot exceed the per-definition destination allowance", () => fixture({
  "main.rb": [
    "class Main", "  def run(mystery)",
    ...Array.from({ length: 23 }, (_, i) => `    helper_${i}`),
    "    mystery.shared", "  end",
    ...Array.from({ length: 23 }, (_, i) => `  def helper_${i}; true; end`),
    "end", "class First", "  def shared; true; end", "end", "class Second", "  def shared; false; end", "end",
  ].join("\n"),
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "main.rb:2", maxDepth: 1, indexCacheDir: join(cwd, ".cache") });
  assert.equal(result.edges.filter((edge) => edge.from === result.anchor.id && edge.name.startsWith("helper_") && edge.to).length, 23);
  assert.equal(result.edges.filter((edge) => edge.from === result.anchor.id && edge.name === "mystery.shared" && edge.to).length, 1, "only one destination slot remains for the two static candidates");
  assert.equal(result.nodes.length, 25, "anchor plus at most 24 new destinations");
  assert.ok(result.coverage.frontier.some((item) => item.includes("shared") && item.includes("call cap")));
}));

test("the node cap still permits edges to known definitions and includes callers in its bound", () => fixture({
  "main.ts": "export function runTask() {\n  helper();\n  helper();\n}\nfunction helper() {}\nfunction caller() {\n  runTask();\n}\n",
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "main.ts:1", maxNodes: 2, callers: true });
  assert.equal(result.nodes.length, 2);
  assert.equal(result.edges.filter((edge) => edge.name === "helper" && edge.to).length, 2);
  assert.ok(result.coverage.frontier.some((item) => item.includes("caller") && item.includes("max_nodes")));
}));

test("a full graph reuses checker-resolved class methods without consuming another node", () => fixture({
  "main.ts": "class Main {\n  run() {\n    this.helper();\n    this.helper();\n  }\n  helper() {}\n}\n",
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "main.ts:2", maxNodes: 2 });
  assert.equal(result.nodes.length, 2);
  const calls = result.edges.filter((edge) => edge.name === "this.helper");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.to, calls[1]?.to);
  assert.deepEqual(result.coverage.frontier, []);
}));

const rubyFiles = {
  "component.yml": "name: incentives\n",
  "app/eligibility.rb": `module Incentives
  class Eligibility
    def self.eligible_incentives(surface_view)
      incentives = CoreGeneral2Record.connected_to(role: :reading) do
        Incentives::Incentive.active.for_surface_view(surface_view).by_priority
      end
      evaluators = incentives.map do |incentive|
        IncentiveEvaluator.new(incentive: incentive)
      end
      eligible_evaluators = evaluators.select(&:evaluate_and_publish)
      eligible_evaluators.map(&:incentive)
    end
  end
end
`,
  "app/incentive.rb": `module Incentives
  class Incentive < CoreGeneral2Record
    scope :active, -> { where(active: true) }
    scope :for_surface_view, ->(view) { where(surface_view: view) }
    scope :by_priority, -> { order(:priority) }
  end
end
`,
  "app/evaluator.rb": `module Incentives
  class IncentiveEvaluator
    attr_reader :incentive
    def initialize(incentive:)
      @incentive = incentive
      prepare
    end
    def prepare
      true
    end
    def evaluate_and_publish
      eligible?
    end
    def eligible?
      criteria
    end
    def criteria
      true
    end
  end
end
`,
};

test("Ruby scopes, constructor and symbol-to-proc calls form the incentives chain", () => fixture(rubyFiles, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "app/eligibility.rb:3", indexCacheDir: join(cwd, ".cache") });
  const destination = (symbol: string) => {
    const node = result.nodes.find((node) => node.symbol === symbol);
    assert.ok(node, symbol);
    return result.edges.find((edge) => edge.to === node.id && edge.from === result.anchor.id)!;
  };
  assert.equal(destination("Incentives::Incentive scope :active").resolution, "exact");
  for (const scope of ["for_surface_view", "by_priority"]) {
    const edge = destination(`Incentives::Incentive scope :${scope}`);
    assert.equal(edge.resolution, "exact");
    assert.equal(edge.via, "chain");
  }
  assert.match(destination("Incentives::IncentiveEvaluator#initialize").name, /IncentiveEvaluator.new/);
  for (const symbol of ["Incentives::IncentiveEvaluator#evaluate_and_publish", "Incentives::IncentiveEvaluator attr_reader :incentive"]) {
    const edge = destination(symbol);
    assert.equal(edge.via, "assigned");
    assert.match(edge.note!, /element type IncentiveEvaluator/);
    assert.match(edge.name, /&:/);
  }
  assert.ok(result.nodes.some((node) => node.symbol === "Incentives::IncentiveEvaluator#prepare"));
  assert.ok(result.nodes.some((node) => node.symbol === "Incentives::IncentiveEvaluator#criteria"));
  assert.ok(result.coverage.depthReached >= 3);
  assert.equal(result.edges.find((edge) => edge.name === "CoreGeneral2Record.connected_to")?.resolution, "external");
  assert.equal(result.coverage.unresolved, 0);
}));

test("unknown symbol-proc receivers and runtime block arguments are explicit gaps", () => fixture({
  ...rubyFiles,
  "app/unknown.rb": `class Unknown
  def run(values, callback)
    values.map(&:incentive)
    values.select(&callback)
    values.each(&method(:publish))
  end
  def publish(value)
    value
  end
end
`,
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "app/unknown.rb:2", indexCacheDir: join(cwd, ".cache") });
  const proc = result.edges.find((edge) => edge.name === "values.map(&:incentive)");
  assert.equal(proc?.resolution, "unresolved", "an unrelated attr_reader is not a receiver type");
  assert.ok(result.edges.some((edge) => edge.resolution === "unresolved" && /callback/.test(edge.name)));
  const method = result.edges.find((edge) => edge.name === "values.each(&method(:publish))");
  assert.equal(result.nodes.find((node) => node.id === method?.to)?.symbol, "Unknown#publish", "&method is bound to self, not to the collection element");
}));

test("collection inference respects map results, block shadowing and reassignment", () => fixture({
  ...rubyFiles,
  "app/flow.rb": `module Incentives
  class Flow
    def run
      evaluators = Incentive.active.map { |item| IncentiveEvaluator.new(incentive: item) }
      evaluators.each do |evaluators|
        evaluators.map(&:incentive)
      end
      evaluators.select(&:evaluate_and_publish)
      mapped = evaluators.map(&:incentive)
      mapped.map(&:evaluate_and_publish)
      evaluators = unknown_value
      evaluators.map(&:incentive)
    end
  end
end
`,
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "app/flow.rb:3", indexCacheDir: join(cwd, ".cache") });
  const call = (line: number) => result.edges.find((edge) => edge.from === result.anchor.id && edge.line === line && edge.name.includes("&:"));
  assert.equal(call(6)?.resolution, "unresolved", "a shadowed element is not the outer collection");
  assert.equal(call(8)?.via, "assigned", "the outer collection survives block shadowing");
  assert.equal(call(10)?.resolution, "unresolved", "a map return type is not its input element type");
  assert.equal(call(12)?.resolution, "unresolved", "an unknown reassignment invalidates the previous element type");
}));

test("Ruby custom new and scope bodies are inspected without claiming unknown chain returns", () => fixture({
  ...rubyFiles,
  "app/custom.rb": `class Custom
  def self.new
    build_object
  end
  def self.build_object
    true
  end
end
class Entry
  def run
    Custom.new
    Incentives::Incentive.unknown_scope.by_priority
  end
end
class DynamicScope
  scope :opaque, callable
  scope :visible, -> { custom_filter }
  def self.custom_filter
    true
  end
end
`,
}, async (cwd) => {
  const collect = (target: string) => collectSparsity({ ...options, cwd, target, indexCacheDir: join(cwd, ".cache") });
  const result = await collect("app/custom.rb:10");
  const constructor = result.edges.find((edge) => edge.name === "Custom.new");
  assert.equal(result.nodes.find((node) => node.id === constructor?.to)?.symbol, "Custom.new");
  assert.ok(result.nodes.some((node) => node.symbol === "Custom.build_object"));
  assert.equal(result.edges.find((edge) => edge.name.endsWith(".by_priority"))?.resolution, "static_candidate");
  const opaque = await collect("app/custom.rb:16");
  assert.equal(opaque.coverage.unresolved, 1);
  assert.match(opaque.edges[0]?.note ?? "", /scope body/);
  const visible = await collect("app/custom.rb:17");
  assert.ok(visible.edges.some((edge) => edge.name === "custom_filter" && edge.to));
}));

test("conditional assignments and dynamic dispatch stay explicit instead of claiming a receiver type", () => fixture({
  ...rubyFiles,
  "app/conditional.rb": `module Incentives
  class Conditional
    def run(flag, operation)
      evaluators = Incentive.active.map { |item| IncentiveEvaluator.new(incentive: item) }
      if flag
        evaluators = unknown_value
      end
      evaluators.map(&:incentive)
      public_send(operation)
      public_send(:publish)
    end
    def publish
      true
    end
  end
end
`,
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "app/conditional.rb:3", indexCacheDir: join(cwd, ".cache") });
  assert.equal(result.edges.find((edge) => edge.name === "evaluators.map(&:incentive)")?.resolution, "unresolved");
  assert.equal(result.edges.find((edge) => edge.name === "public_send(...)")?.resolution, "unresolved");
  assert.equal(result.edges.find((edge) => edge.name === "public_send(:publish)")?.resolution, "static_candidate");
}));

test("typed collection parameters use element methods without treating Hash keys as receiver types", () => fixture({
  ...rubyFiles,
  "app/typed.rb": `module Incentives
  class Typed
    sig { params(evaluators: T::Array[IncentiveEvaluator], data: T::Hash[String, T.untyped]).void }
    def run(evaluators, data)
      evaluators.filter(&:evaluate_and_publish).map(&:incentive)
      data[:key]
    end
  end
end
`,
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "app/typed.rb:4", indexCacheDir: join(cwd, ".cache") });
  for (const name of ["evaluate_and_publish", "incentive"]) {
    const edge = result.edges.find((edge) => edge.name.includes(`&:${name}`));
    assert.equal(edge?.via, "typed");
    assert.equal(edge?.resolution, "exact");
  }
  const hash = result.edges.find((edge) => edge.name === "data.[]");
  assert.equal(hash?.resolution, "external");
  assert.match(hash?.note ?? "", /receiver Hash/);
}));

test("TypeScript definitions outside an explicit component root stay external", () => fixture({
  "component/main.ts": "import { outside } from '../other';\nexport function run() { outside(); }\n",
  "other.ts": "export function outside() {}\n",
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, root: "component", target: "component/main.ts:2" });
  assert.equal(result.edges.find((edge) => edge.name === "outside")?.resolution, "external");
  assert.equal(result.nodes.length, 1);
}));

test("unknown Ruby constructors remain visible rather than becoming zero unresolved calls", () => fixture({
  "main.rb": "class Local\nend\nclass Main\n  def run\n    Local.new\n    Outside.new\n  end\nend\n",
}, async (cwd) => {
  const result = await collectSparsity({ ...options, cwd, target: "main.rb:4", indexCacheDir: join(cwd, ".cache") });
  assert.equal(result.edges.find((edge) => edge.name === "Local.new")?.resolution, "unresolved");
  assert.equal(result.edges.find((edge) => edge.name === "Outside.new")?.resolution, "external");
}));

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Collector } from "../src/sparsity.ts";
import { rubyAdapter } from "../src/adapters/ruby.ts";
import { indexOfSources } from "../src/adapters/ruby-index.ts";

async function fixture(files: Record<string, string>, run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "ruby-constant-cache-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), source);
    }
    assert.equal(await rubyAdapter.ready(), true);
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const options = { maxDepth: 1, maxNodes: 24, vicinity: 5, budgetMs: 20_000 };
const owners = Object.fromEntries(["A", "B"].map((name) => [`app/${name.toLowerCase()}.rb`, `class ${name}
  FEATURES = [:${name.toLowerCase()}]
  def run
    FEATURES
  end
end
`]));

async function resolveCalls(collector: Collector, path: string, line = 3) {
  const anchor = await collector.node(path, line, 0);
  assert.ok(anchor);

  const start = collector.edges.length;
  await collector.expand(anchor.node, anchor.def, 0, [], []);

  return collector.edges.slice(start).map((edge) => ({
    name: edge.name,
    resolution: edge.resolution,
    via: edge.via,
    target: collector.nodes.find((node) => node.id === edge.to),
  }));
}

for (const indexed of [false, true]) {
  for (const order of [["a", "b"], ["b", "a"]]) {
    test(`${indexed ? "indexed" : "fallback"} constants keep their origin in ${order.join(" then ")} order`, () => fixture(owners, async (cwd) => {
      const collector = new Collector({ ...options, cwd }, cwd, {
        rubyReady: true,
        ...(indexed ? { rubyIndex: indexOfSources(new Map(Object.entries(owners))) } : {}),
      });

      for (const name of order) {
        const path = `app/${name}.rb`;
        const calls = await resolveCalls(collector, path);
        const constants = calls.filter((call) => call.name === "FEATURES");

        assert.deepEqual(constants.map((call) => call.target?.path), [path]);
        assert.equal(constants[0]?.target?.startLine, 2);
        assert.equal(constants[0]?.resolution, "exact");
        if (indexed) assert.equal(constants[0]?.via, "lexical");
      }

      const rgCalls = collector.budget.rgCalls;
      const repeated = await resolveCalls(collector, `app/${order[0]}.rb`);
      assert.equal(repeated.find((call) => call.name === "FEATURES")?.target?.path, `app/${order[0]}.rb`);
      assert.equal(collector.budget.rgCalls, rgCalls, "same-origin hits are reused");
      assert.equal(collector.budget.truncatedBy, "none");
    }));
  }
}

test("a fallback miss cannot hide another origin's explicitly searched assignment", () => fixture({
  ...owners,
  ".ignore": "app/b.rb\n",
  "app/a.rb": "class A\n  def run\n    FEATURES\n  end\nend\n",
}, async (cwd) => {
  const collector = new Collector({ ...options, cwd }, cwd, { rubyReady: true });
  const missing = await resolveCalls(collector, "app/a.rb", 2);
  assert.equal(missing.find((call) => call.name === "FEATURES")?.resolution, "external");

  const found = await resolveCalls(collector, "app/b.rb");
  assert.equal(found.find((call) => call.name === "FEATURES")?.target?.path, "app/b.rb");
  assert.equal(found.find((call) => call.name === "FEATURES")?.resolution, "exact");

  const rgCalls = collector.budget.rgCalls;
  const repeated = await resolveCalls(collector, "app/a.rb", 2);
  assert.equal(repeated.find((call) => call.name === "FEATURES")?.resolution, "external");
  assert.equal(collector.budget.rgCalls, rgCalls, "same-origin misses are reused");
}));

test("fallback namespace lookup retains warm aliases, cold modules and external namespaces", () => fixture({
  "app/aliases.rb": `module FeatureSpace
  class Worker
  end
end
FEATURES = FeatureSpace
class UseAliases
  def run
    FEATURES
    FEATURES::Worker
    FeatureSpace::Worker
    MissingSpace::Worker
  end
end
`,
}, async (cwd) => {
  const collector = new Collector({ ...options, cwd }, cwd, { rubyReady: true });
  const calls = await resolveCalls(collector, "app/aliases.rb", 7);

  for (const name of ["FEATURES::Worker", "FeatureSpace::Worker"]) {
    const call = calls.find((call) => call.name === name);
    assert.equal(call?.target?.path, "app/aliases.rb", name);
    assert.equal(call?.target?.symbol, "FeatureSpace::Worker", name);
    assert.equal(call?.resolution, "exact", name);
  }
  assert.equal(calls.find((call) => call.name === "MissingSpace::Worker")?.resolution, "external");
  assert.equal(collector.budget.truncatedBy, "none");
}));

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanSparsity, type ScanResult } from "../src/sparsity-scan.ts";
import { Collector } from "../src/sparsity.ts";

const sources = {
  ts: "export function run() {\n  helper();\n  helper();\n  run();\n}\nfunction helper() {}\n",
  rb: "def run\n  helper\n  helper\n  run\nend\ndef helper; true; end\n",
};

async function fixture(
  extensions: Array<keyof typeof sources>,
  maxNodes: number,
  check: (result: ScanResult) => void,
) {
  const cwd = await mkdtemp(join(tmpdir(), "scan-node-budget-"));
  try {
    const anchors = [];
    for (const [index, extension] of extensions.entries()) {
      const root = `component-${index}`;
      await mkdir(join(cwd, root));
      await writeFile(join(cwd, root, "component.yml"), `name: ${root}\n`);
      await writeFile(join(cwd, root, `main.${extension}`), sources[extension]);
      anchors.push(`${root}/main.${extension}:1`);
    }

    const result = await scanSparsity({
      cwd,
      anchors,
      diff: "worktree",
      maxNodes,
      maxDepth: 1,
      maxAnchors: 10,
      vicinity: 5,
      budgetMs: 30_000,
      outputDir: join(cwd, "pack"),
      inlineBudgetBytes: 40 * 1024,
    });
    check(result);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

for (const extensions of [["ts", "ts"], ["rb", "rb"], ["ts", "rb"]] as const) {
  test(`two ${extensions.join("/")} roots share one callee slot and report the suppressed root`, () => fixture([...extensions], 1, (result) => {
    assert.equal(result.roots.length, 2);
    assert.equal(result.anchors.length, 2, "anchors do not consume callee slots");

    const helpers = result.nodes.filter((node) => node.symbol === "helper");
    assert.equal(helpers.length, 1, "only one new callee across both roots");
    const helper = helpers[0];
    assert.ok(helper);

    assert.equal(result.coverage.truncatedBy, "max_nodes");
    assert.ok(result.coverage.frontier.some((item) => item.includes("helper") && item.includes("max_nodes")));
    assert.equal(result.edges.filter((edge) => edge.to === helper.id).length, 2, "repeated edges to a known callee survive the cap");
    for (const anchor of result.anchors.filter((entry) => entry.path.endsWith(".rb"))) {
      assert.ok(result.edges.some((edge) => edge.from === anchor.id && edge.to === anchor.id), "Ruby edges to existing anchors survive the cap");
    }
  }));
}

test("enough shared slots expand both roots without truncation", () => fixture(["ts", "ts"], 2, (result) => {
  assert.equal(result.nodes.filter((node) => node.symbol === "helper").length, 2);
  assert.equal(result.coverage.truncatedBy, "none");
  assert.deepEqual(result.coverage.frontier, []);
}));

test("failed creation in one root leaves the shared slot available to the next root", async () => {
  const original = Collector.prototype.node;
  let failures = 0;
  Collector.prototype.node = async function (path, line, depth, ...rest) {
    if (path === "component-0/main.ts" && depth > 0 && line === 6) {
      failures += 1;
      return undefined;
    }
    return original.call(this, path, line, depth, ...rest);
  };
  try {
    await fixture(["ts", "ts"], 1, (result) => {
      assert.equal(failures, 2, "both attempts to create the unreadable destination failed");
      const helpers = result.nodes.filter((node) => node.symbol === "helper");
      assert.deepEqual(helpers.map((node) => node.path), ["component-1/main.ts"]);
      const helper = helpers[0];
      assert.ok(helper);
      assert.equal(result.edges.filter((edge) => edge.to === helper.id).length, 2);

      const unresolved = result.edges.filter((edge) => edge.name === "helper" && edge.resolution === "unresolved");
      assert.equal(unresolved.length, 2);
      assert.ok(unresolved.every((edge) => edge.reason === "no-definition"));
      assert.equal(result.coverage.truncatedBy, "none");
      assert.deepEqual(result.coverage.frontier, []);
    });
  } finally {
    Collector.prototype.node = original;
  }
});

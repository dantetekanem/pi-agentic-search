import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { scanSparsity, type ScanResult } from "../src/sparsity-scan.ts";

const JS = "mixed/entry.js";
const RUBY = "mixed/reader.rb";
const RUBY_TEST = "mixed/test/reader_test.rb";
const FILES: Record<string, string> = {
  "component.yml": "name: parent\n",
  "entry.js": "export function parent() { return 1; }\n",
  "mixed/component.yml": "name: mixed\n",
  [JS]: "export function load() { return 1; }\n",
  [RUBY]: "class Reader\n  def total\n    subtotal\n  end\n\n  def subtotal\n    2\n  end\nend\n",
  "mixed/checkout.rb": "class Checkout\n  def run\n    Reader.new.total\n  end\nend\n",
  [RUBY_TEST]: "class ReaderTest\n  def test_total\n    Reader.new.total\n  end\nend\n",
};

async function fixture(run: (
  scan: (order: string[], cache: string) => Promise<ScanResult>,
  change: (files: Record<string, string>) => Promise<void>,
  index: string,
) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "scan-mixed-root-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "user.name=t", "-c", "user.email=t@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd, encoding: "utf8", timeout: 20_000 });
  const write = async (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), content);
    }
  };
  const index = join(root, "index");
  let packs = 0;
  try {
    git("init", "-q", "-b", "main");
    await write(FILES);
    git("add", ".");
    git("commit", "-qm", "base");
    const orderFile = join(root, "order");
    await writeFile(orderFile, "");
    git("config", "diff.orderFile", orderFile);
    await run(async (order, cache) => {
      await writeFile(orderFile, `${order.join("\n")}\n`);
      const result = await scanSparsity({
        cwd,
        diff: "HEAD~1..HEAD",
        maxDepth: 1,
        vicinity: 5,
        maxNodes: 30,
        maxAnchors: 10,
        budgetMs: 30_000,
        indexCacheDir: join(index, cache),
        outputDir: join(root, `pack-${++packs}`),
        inlineBudgetBytes: 40 * 1024,
      });
      assert.deepEqual(result.files.map((file) => file.path), order, "the real Git diff uses the requested changed-file order");
      return result;
    }, async (files) => {
      await write(files);
      git("commit", "-qam", "change");
    }, index);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function rubyGraph(result: ScanResult) {
  const reader = result.anchors.find((anchor) => anchor.symbol === "Reader#total");
  assert.ok(reader, "the changed Ruby method is an anchor");
  const edge = result.edges.find((entry) => entry.from === reader.id && entry.name === "subtotal");
  assert.ok(edge, "the Ruby anchor's outgoing call is expanded");
  const target = result.nodes.find((node) => node.id === edge.to);
  return {
    edge: [edge.resolution, edge.via, target?.symbol],
    callers: reader.callers.map((caller) => [caller.path, caller.symbol, caller.resolution]),
    tests: reader.tests.map((entry) => [entry.path, entry.symbol]),
  };
}

test("mixed diffs share an indexed Ruby graph in either changed-file order and on cache reuse", () => fixture(async (scan, change) => {
  await change({
    [JS]: FILES[JS]!.replace("return 1", "return 2"),
    [RUBY]: FILES[RUBY]!.replace("    subtotal\n", "    subtotal + 1\n"),
  });
  const jsFirst = await scan([JS, RUBY], "js-first");
  const rubyFirst = await scan([RUBY, JS], "ruby-first");
  const warm = await scan([JS, RUBY], "js-first");
  const expected = {
    edge: ["exact", "self", "Reader#subtotal"],
    callers: [["mixed/checkout.rb", "Checkout#run", "exact"]],
    tests: [[RUBY_TEST, "ReaderTest#test_total"]],
  };
  for (const result of [jsFirst, rubyFirst, warm]) {
    assert.deepEqual(result.roots, ["mixed"]);
    assert.deepEqual(rubyGraph(result), expected);
    assert.match(result.coverage.notes.join("\n"), /Ruby index for mixed: \d+ files, \d+ definitions/);
  }
  assert.match(warm.coverage.notes.join("\n"), /cache hit/);
}));

for (const order of [[JS, RUBY_TEST], [RUBY_TEST, JS]]) {
  test(`${order[0] === JS ? "JavaScript" : "Ruby test"}-first test-only Ruby diffs keep name-based fallback without creating an index`, () => fixture(async (scan, change, index) => {
    await change({
      [JS]: FILES[JS]!.replace("return 1", "return 2"),
      [RUBY_TEST]: FILES[RUBY_TEST]!.replace("Reader.new.total", "Reader.new.total + 1"),
    });
    const result = await scan(order, "tests");
    assert.match(result.coverage.notes.join("\n"), /Ruby index for mixed skipped: only test files changed/);
    const anchor = result.anchors.find((entry) => entry.path === RUBY_TEST);
    assert.ok(anchor, "the changed Ruby test remains an anchor");
    const edge = result.edges.find((entry) => entry.from === anchor.id && entry.name === "Reader.new.total");
    assert.ok(edge, "name-based fallback still resolves the test's call");
    assert.equal(edge.resolution, "exact");
    assert.ok(result.nodes.some((node) => node.id === edge.to && node.symbol === "Reader#total"));
    await assert.rejects(readdir(index), { code: "ENOENT" });
  }));
}

test("Ruby changes in a nested component do not initialize an index for a JavaScript-only parent", () => fixture(async (scan, change, index) => {
  await change({
    "entry.js": FILES["entry.js"]!.replace("return 1", "return 2"),
    [RUBY]: FILES[RUBY]!.replace("    subtotal\n", "    subtotal + 1\n"),
  });
  const result = await scan(["entry.js", RUBY], "nested");
  assert.deepEqual(result.roots.sort(), [".", "mixed"]);
  const notes = result.coverage.notes.join("\n");
  assert.match(notes, /Ruby index for mixed: \d+ files, \d+ definitions/);
  assert.doesNotMatch(notes, /Ruby index for \.:/);
  assert.equal((await readdir(join(index, "nested"))).length, 1, "only the Ruby component writes an index");
  assert.deepEqual(rubyGraph(result).edge, ["exact", "self", "Reader#subtotal"]);
}));

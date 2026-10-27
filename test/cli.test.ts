import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { formatSparsity, type SparsityResult } from "../src/sparsity.ts";
import type { ScanResult } from "../src/sparsity-scan.ts";
import type { SearchDetails } from "../src/types.ts";
import { main } from "../src/cli.ts";

const root = resolve(import.meta.dirname, "..");
const bin = join(root, "bin/agentic-search.mjs");
const tools = new Map<string, Pick<ToolDefinition, "execute">>();
const adapter: Pick<ExtensionAPI, "registerTool" | "registerCommand"> = {
  registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
};
extension(adapter as ExtensionAPI);

async function fixture(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "agentic-cli-test-"));
  try {
    await writeFile(join(cwd, "package.json"), '{"name":"fixture"}');
    await writeFile(join(cwd, "cart.ts"), "export function total() { return price(); }\nfunction price() { return 4; }\n");
    await writeFile(join(cwd, "cart.rb"), "def ruby_total\n  ruby_price\nend\ndef ruby_price\n  4\nend\n");
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture"], { cwd });
    await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

function cli(cwd: string, args: string[], executable = bin, env = process.env) {
  return spawnSync(process.execPath, [executable, ...args], { cwd, encoding: "utf8", timeout: 30_000, env });
}

function json<T = SearchDetails>(cwd: string, args: string[], executable = bin): { text: string; details: T } {
  const result = cli(cwd, [...args, "--json"], executable);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function pi(name: string, cwd: string, args: Record<string, unknown>) {
  const tool = tools.get(name);
  assert.ok(tool);
  return tool.execute("cli-parity", args, undefined, undefined, { cwd } as ExtensionContext);
}

const graph = (result: SparsityResult) => ({ anchor: result.anchor, nodes: result.nodes, edges: result.edges, frontier: result.coverage.frontier });

test("CLI search text and JSON preserve Pi ranking, snippets and coverage", () => fixture(async (cwd) => {
  const params = { query: "total", path: "cart.ts", intent: "definition", expand_related: true };
  const expected = await pi("agentic_search", cwd, params);
  const args = ["search", "total", "--path", "cart.ts", "--intent", "definition", "--expand-related"];
  const actual = json(cwd, args);
  assert.deepEqual(actual.details, JSON.parse(JSON.stringify(expected.details)));
  assert.equal(actual.text, expected.content.find((item) => item.type === "text")?.text);
  assert.equal(cli(cwd, args).stdout.trimEnd(), actual.text);
  const elsewhere = json(tmpdir(), [...args, "--cwd", cwd]);
  assert.deepEqual(elsewhere.details.files, actual.details.files);
  assert.equal(json(cwd, ["search", "no_such_symbol"]).details.totalMatches, 0);
}));

test("CLI collect matches Pi call graphs for TypeScript and Ruby", () => fixture(async (cwd) => {
  await writeFile(join(cwd, "costs.rb"), "module Costs\n  def base_price\n    4\n  end\nend\n");
  await writeFile(join(cwd, "object.rb"), "class Cart\n  include Costs\n  def subtotal\n    base_price\n  end\nend\n");
  await writeFile(join(cwd, "other.rb"), "class Other\n  def base_price\n    9\n  end\nend\n");
  for (const target of ["cart.ts:1", "cart.rb:2", "object.rb:4"]) {
    const expected = await pi("sparsity_collect", cwd, { target, max_depth: 2, callers: false });
    const actual = json<SparsityResult>(cwd, ["collect", target, "--max-depth", "2", "--no-callers"]);
    assert.deepEqual(graph(actual.details), JSON.parse(JSON.stringify(graph(expected.details as SparsityResult))));
    assert.equal(actual.text, formatSparsity(actual.details));
  }
}));

test("CLI scan writes a readable pack and preserves Pi anchors", () => fixture(async (cwd) => {
  const cliDir = join(cwd, "cli-pack");
  const piDir = join(cwd, "pi-pack");
  await writeFile(join(cwd, ".gitignore"), "*-pack/\n");
  const expected = await pi("sparsity_scan", cwd, { diff: "worktree", output_dir: piDir });
  const actual = json<ScanResult>(tmpdir(), ["scan", "--cwd", cwd, "--diff", "worktree", "--output-dir", "cli-pack"]);
  assert.deepEqual(actual.details.anchors, JSON.parse(JSON.stringify((expected.details as ScanResult).anchors)));
  assert.equal(actual.details.packPath, join(cliDir, "pack.md"));
  assert.match(await readFile(actual.details.packPath, "utf8"), /total/);
  assert.match(actual.text, /SPARSITY SCAN/);
  const anchored = json<ScanResult>(cwd, ["scan", "--anchor", "cart.ts:1", "--anchor", "cart.rb:2", "--output-dir", cliDir]);
  assert.ok(anchored.details.anchors.some((anchor) => anchor.symbol === "total"));
  assert.ok(anchored.details.anchors.some((anchor) => anchor.symbol === "ruby_total"));
}));

test("CLI rejects invalid arguments before executing", () => fixture(async (cwd) => {
  for (const args of [
    ["unknown"], ["search"], ["collect"], ["scan", "extra"],
    ["search", "total", "--unknown"], ["search", "total", "--intent", "wrong"],
    ["collect", "cart.ts:1", "--max-depth", "NaN"], ["collect", "cart.ts:1", "--max-depth", "0"],
    ["scan", "--diff", "worktree", "--anchor", "cart.ts:1"],
  ]) {
    const result = cli(cwd, args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.length > 0);
  }
  assert.equal(cli(cwd, ["collect", "missing.ts:1"]).status, 1);
  assert.equal(cli(cwd, ["search", "total", "--cwd", join(cwd, "missing")]).status, 1);
  assert.equal(cli(cwd, ["search", "total"], bin, { ...process.env, PATH: "" }).status, 1);
}));

test("CLI help is available without a repository or search executables", async () => {
  for (const args of [[], ["--help"], ["search", "--help"], ["collect", "--help"], ["scan", "--help"]]) {
    const result = cli(tmpdir(), args, bin, { ...process.env, PATH: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /agentic-search/);
  }
});

test("CLI spills oversized text without losing source bytes", () => fixture(async (cwd) => {
  const comment = `  // ${"é".repeat(600)}\n`;
  await writeFile(join(cwd, "wide.ts"), `export function wide() {\n${comment.repeat(100)}}\n`);
  const result = cli(cwd, ["collect", "wide.ts:1", "--vicinity-check", "60"]);
  assert.equal(result.status, 0, result.stderr);
  const path = result.stdout.match(/Full output: (.+)\]/)?.[1];
  assert.ok(path);
  try {
    const full = await readFile(path, "utf8");
    assert.ok(Buffer.byteLength(full) > 50 * 1024);
    assert.ok(full.includes("é".repeat(600)));
    assert.ok(result.stdout.startsWith(full.split("\n").slice(0, 3).join("\n")));
  } finally { await rm(dirname(path), { recursive: true, force: true }); }
}));

test("CLI reports cancellation and releases its signal listener", () => fixture(async (cwd) => {
  const listeners = process.listenerCount("SIGINT");
  const result = main(["search", "total", "--cwd", cwd]);
  process.emit("SIGINT");
  assert.equal(await result, 130);
  assert.equal(process.listenerCount("SIGINT"), listeners);
}));

test("built CLI runs with only declared runtime dependencies, without Pi or tsx", () => fixture(async (cwd) => {
  const isolated = await mkdtemp(join(tmpdir(), "agentic-cli-package-"));
  try {
    for (const directory of ["bin", "dist"]) await cp(join(root, directory), join(isolated, directory), { recursive: true });
    await cp(join(root, "package.json"), join(isolated, "package.json"));
    const manifest = JSON.parse(await readFile(join(isolated, "package.json"), "utf8"));
    for (const name of Object.keys(manifest.dependencies)) {
      const destination = join(isolated, "node_modules", name);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(await realpath(join(root, "node_modules", name)), destination, "dir");
    }
    for (const name of Object.keys(manifest.peerDependencies)) assert.equal(manifest.peerDependenciesMeta[name].optional, true);
    const executable = join(isolated, manifest.bin["agentic-search"]);
    assert.equal(json(cwd, ["search", "total", "--path", "cart.ts"], executable).details.files[0].path, "cart.ts");
    assert.equal(json<SparsityResult>(cwd, ["collect", "cart.rb:2"], executable).details.anchor.symbol, "ruby_total");
    const scanned = json<ScanResult>(cwd, ["scan"], executable);
    assert.ok(scanned.details.anchors.length >= 2);
    assert.ok(scanned.details.packPath.startsWith(tmpdir()));
    await rm(dirname(scanned.details.packPath), { recursive: true, force: true });
  } finally { await rm(isolated, { recursive: true, force: true }); }
}));

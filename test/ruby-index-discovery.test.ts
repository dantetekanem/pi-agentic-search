import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { buildRubyIndex } from "../src/adapters/ruby-index.ts";

const realRg = execFileSync("which", ["rg"], { encoding: "utf8" }).trim();

async function fixture(run: (cwd: string, cacheDir: string, tools: string) => Promise<void>, empty = false) {
  const root = await mkdtemp(join(tmpdir(), "ruby-discovery-"));
  const cwd = join(root, "repo");
  const cacheDir = join(root, "cache");
  const tools = join(root, "tools");
  await mkdir(cwd);
  await mkdir(cacheDir);
  await mkdir(tools);
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "user.name=t", "-c", "user.email=t@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd, encoding: "utf8", timeout: 10_000 });
  try {
    if (!empty) {
      await writeFile(join(cwd, "first.rb"), "class First\n  def call\n    true\n  end\nend\n");
      await writeFile(join(cwd, "second.rb"), "class Second\nend\n");
      await writeFile(join(cwd, "report"), "#!/usr/bin/env ruby\nclass Report\nend\n");
    }
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "--allow-empty", "-qm", "base");
    await run(cwd, cacheDir, tools);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withRg(tools: string, stage: "ruby" | "script", failure: string, run: () => Promise<void>) {
  const executable = join(tools, "rg");
  await writeFile(executable, `#!${process.execPath}
import { spawnSync } from "node:child_process";
if (process.argv.includes("-t") === ${stage === "ruby"}) {
  ${failure}
} else {
  const child = spawnSync(${JSON.stringify(realRg)}, process.argv.slice(2), { stdio: "inherit" });
  if (child.error) throw child.error;
  process.exit(child.status ?? 2);
}
`);
  await chmod(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${tools}:${previous}`;
  try {
    await run();
  } finally {
    process.env.PATH = previous;
  }
}

for (const stage of ["ruby", "script"] as const) {
  for (const [name, failure, reason] of [
    ["exit 2 without output", "process.exit(2);", /discovery.*code 2/i],
    ["exit 2 after partial output", 'process.stdout.write("first.rb\\nreport\\n"); process.exitCode = 2;', /discovery.*code 2/i],
    ["exit 1 after partial output", 'process.stdout.write("first.rb\\nreport\\n"); process.exitCode = 1;', /discovery.*code 1/i],
    ["signal termination", 'process.kill(process.pid, "SIGTERM");', /discovery.*SIGTERM/i],
  ] as const) {
    test(`${stage} discovery rejects ${name} and rebuilds at unchanged HEAD`, () => fixture(async (cwd, cacheDir, tools) => {
      const options = { cwd, root: ".", cacheDir };
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
      await withRg(tools, stage, failure, async () => {
        await assert.rejects(buildRubyIndex(options), reason);
        assert.deepEqual(await readdir(cacheDir), [], "a failed discovery cannot persist a baseline");
      });
      const recovered = await buildRubyIndex(options);
      assert.equal(recovered.cacheHit, false, "recovery rebuilds instead of reusing partial discovery");
      assert.equal(recovered.fileCount, 3);
      assert.deepEqual([...recovered.namespaces.keys()].sort(), ["First", "Report", "Second"]);
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }), head);
      assert.equal((await buildRubyIndex(options)).cacheHit, true);
    }));
  }
}

test("a missing rg executable rejects discovery without creating a baseline", () => fixture(async (cwd, cacheDir, tools) => {
  const previous = process.env.PATH;
  process.env.PATH = tools;
  try {
    await assert.rejects(buildRubyIndex({ cwd, root: ".", cacheDir }), { code: "ENOENT" });
    assert.deepEqual(await readdir(cacheDir), []);
  } finally {
    process.env.PATH = previous;
  }
  assert.equal((await buildRubyIndex({ cwd, root: ".", cacheDir })).fileCount, 3);
}));

test("pre-cancelled discovery is rejected rather than returned as an empty index", () => fixture(async (cwd, cacheDir) => {
  const signal = AbortSignal.abort();
  await assert.rejects(buildRubyIndex({ cwd, root: ".", cacheDir, signal }), { name: "AbortError" });
  assert.deepEqual(await readdir(cacheDir), []);
}));

test("legitimate empty discovery is cacheable, unlike failure or the file cap", () => fixture(async (cwd, cacheDir) => {
  const options = { cwd, root: ".", cacheDir };
  const empty = await buildRubyIndex(options);
  assert.equal(empty.skipped, undefined);
  assert.equal(empty.fileCount, 0);
  assert.equal(empty.cacheHit, false);
  assert.equal((await buildRubyIndex(options)).cacheHit, true);
}, true));

test("intentional discovery caps skip caching and can recover", () => fixture(async (cwd, cacheDir) => {
  const options = { cwd, root: ".", cacheDir };
  const capped = await buildRubyIndex({ ...options, maxFiles: 1 });
  assert.match(capped.skipped!, /index cap; discovery stopped at 2/);
  assert.deepEqual(await readdir(cacheDir), []);
  const recovered = await buildRubyIndex(options);
  assert.equal(recovered.cacheHit, false);
  assert.equal(recovered.fileCount, 3);
}));

test("a baseline from before discovery validation is rebuilt even at unchanged HEAD", () => fixture(async (cwd, cacheDir) => {
  const treeHash = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8" }).trim();
  const key = createHash("sha256").update(`${cwd}\n.\n${treeHash}\n9`).digest("hex").slice(0, 24);
  await writeFile(join(cacheDir, `${key}.json.gz`), gzipSync(JSON.stringify({ version: 9, root: ".", treeHash, strings: [], files: [] })));
  const rebuilt = await buildRubyIndex({ cwd, root: ".", cacheDir });
  assert.equal(rebuilt.cacheHit, false);
  assert.equal(rebuilt.fileCount, 3);
}));

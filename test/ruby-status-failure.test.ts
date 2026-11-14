import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { buildRubyIndex } from "../src/adapters/ruby-index.ts";

async function fixture(run: (cwd: string, cacheDir: string, bin: string, git: (...args: string[]) => string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ruby-status-"));
  const cwd = join(root, "repo");
  const cacheDir = join(root, "cache");
  const bin = join(root, "bin");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const git = (...args: string[]) => execFileSync(realGit, [
    "-c", "user.name=t",
    "-c", "user.email=t@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], { cwd, encoding: "utf8", timeout: 20_000 });
  try {
    await mkdir(cwd);
    await mkdir(bin);
    await writeFile(join(bin, "git"), `#!/bin/sh
if [ "$1" = status ]; then
  echo 'injected status failure' >&2
  exit 128
fi
exec '${realGit.replaceAll("'", "'\\''")}' "$@"
`);
    await chmod(join(bin, "git"), 0o755);
    await writeFile(join(cwd, "reader.rb"), "class Reader\n  def original; end\nend\n");
    await writeFile(join(cwd, "deleted.rb"), "class Deleted\n  def original; end\nend\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "base");
    await run(cwd, cacheDir, bin, git);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const warm of [false, true]) {
  test(`status failure rejects a ${warm ? "warm" : "cold"} HEAD index without poisoning recovery`, () => fixture(async (cwd, cacheDir, bin, git) => {
    const options = { cwd, root: ".", cacheDir };
    if (warm) {
      const initial = await buildRubyIndex(options);
      assert.equal(initial.skipped, undefined);
      assert.ok(initial.bySymbol.has("Reader#original"));
    }
    const cacheBefore = await Promise.all(
      (await readdir(cacheDir).catch(() => [])).map(async (path) => [
        path, await readFile(join(cacheDir, path), "base64"),
      ]),
    );
    await writeFile(join(cwd, "reader.rb"), "class Reader\n  def changed; end\nend\n");
    await rm(join(cwd, "deleted.rb"));
    await writeFile(join(cwd, "added.rb"), "class Added\n  def current; end\nend\n");

    const path = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${path}`;
      await assert.rejects(buildRubyIndex(options), /git status --porcelain failed: injected status failure/);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
    const cacheAfter = await Promise.all(
      (await readdir(cacheDir).catch(() => [])).map(async (path) => [
        path, await readFile(join(cacheDir, path), "base64"),
      ]),
    );
    assert.deepEqual(cacheAfter, cacheBefore, "failed status neither creates nor changes a baseline");

    const recovered = await buildRubyIndex(options);
    assert.equal(recovered.skipped, undefined);
    assert.equal(recovered.cacheHit, warm);
    assert.equal(recovered.overlayFiles, 3);
    assert.ok(recovered.bySymbol.has("Reader#changed"));
    assert.ok(recovered.bySymbol.has("Added#current"));
    assert.ok(!recovered.bySymbol.has("Reader#original"));
    assert.ok(!recovered.bySymbol.has("Deleted#original"));

    git("restore", ".");
    await rm(join(cwd, "added.rb"));
    const clean = await buildRubyIndex(options);
    assert.equal(clean.cacheHit, true);
    assert.equal(clean.overlayFiles, 0);
    assert.ok(clean.bySymbol.has("Reader#original"));
    assert.ok(clean.bySymbol.has("Deleted#original"));
    assert.ok(!clean.bySymbol.has("Reader#changed"));
    assert.ok(!clean.bySymbol.has("Added#current"));
  }));
}

test("a baseline from before status validation is rebuilt", () => fixture(async (cwd, cacheDir, _bin, git) => {
  const treeHash = git("rev-parse", "HEAD^{tree}").trim();
  const key = createHash("sha256").update(`${cwd}\n.\n${treeHash}\n8`).digest("hex").slice(0, 24);
  await mkdir(cacheDir);
  await writeFile(join(cacheDir, `${key}.json.gz`), gzipSync(JSON.stringify({ version: 8, root: ".", treeHash, strings: [], files: [] })));
  const rebuilt = await buildRubyIndex({ cwd, root: ".", cacheDir });
  assert.equal(rebuilt.cacheHit, false);
  assert.ok(rebuilt.bySymbol.has("Reader#original"));
  assert.ok(rebuilt.bySymbol.has("Deleted#original"));
}));

test("a non-Git directory still indexes its worktree without a persistent baseline", () => fixture(async (cwd, cacheDir) => {
  await rm(join(cwd, ".git"), { recursive: true });
  const index = await buildRubyIndex({ cwd, root: ".", cacheDir });
  assert.equal(index.skipped, undefined);
  assert.equal(index.treeHash, "worktree");
  assert.equal(index.cacheHit, false);
  assert.ok(index.bySymbol.has("Reader#original"));
  assert.deepEqual(await readdir(cacheDir).catch(() => []), []);
}));

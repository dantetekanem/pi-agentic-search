import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildRubyIndex } from "../src/adapters/ruby-index.ts";

const committedSource = "class CommittedGemfile\n  def original; true; end\nend\n";
const dirtySource = "class DirtyGemfile\n  def replacement; true; end\nend\n";
const rubyPaths = [
  "Gemfile", "nested/Gemfile", "Rakefile", "config.ru", ".irbrc",
  "sample.gemspec", "sample.rbw", "sample.rb", "sample.rake",
];

async function fixture(t: TestContext, paths = ["Gemfile"]) {
  const cwd = await mkdtemp(join(tmpdir(), "ruby-gemfile-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const cacheDir = join(cwd, ".cache");
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd, encoding: "utf8", timeout: 20_000 }).trim();
  const write = async (path: string, source: string) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), source);
  };
  await write(".gitignore", ".cache/\n");
  for (const path of paths) await write(path, committedSource);
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  const treeHash = git("rev-parse", "HEAD^{tree}");
  const build = () => buildRubyIndex({ cwd, root: ".", cacheDir });
  const cachedPayload = async () => {
    const entries = await readdir(cacheDir);
    assert.equal(entries.length, 1);
    const payload: { version: number; treeHash: string; strings: string[] } = JSON.parse(
      gunzipSync(await readFile(join(cacheDir, entries[0]!))).toString("utf8"),
    );
    return payload;
  };
  return { cwd, cacheDir, git, write, treeHash, build, cachedPayload };
}

test("warm Ruby cache overlays every discovered Ruby filename, including Gemfile", async (t) => {
  const f = await fixture(t, rubyPaths);
  const cold = await f.build();
  assert.equal(cold.skipped, undefined);
  assert.equal(cold.bySymbol.get("CommittedGemfile#original")?.length, rubyPaths.length);

  for (const path of rubyPaths) await f.write(path, dirtySource);
  await f.write("notes.txt", "class NotRuby; end\n");
  const modified = await f.build();

  assert.equal(modified.cacheHit, true);
  assert.equal(modified.treeHash, f.treeHash);
  assert.equal(modified.bySymbol.get("DirtyGemfile#replacement")?.length, rubyPaths.length);
  assert.equal(modified.bySymbol.has("CommittedGemfile"), false);
  assert.equal(modified.bySymbol.has("NotRuby"), false);
  assert.equal(modified.overlayFiles, rubyPaths.length);
});

test("warm Ruby cache removes deleted Gemfiles and other discovered Ruby filenames", async (t) => {
  const f = await fixture(t, rubyPaths);
  await f.build();
  for (const path of rubyPaths) await rm(join(f.cwd, path));

  const deleted = await f.build();

  assert.equal(deleted.cacheHit, true);
  assert.equal(deleted.fileCount, 0);
  assert.deepEqual(deleted.definitions, []);
  assert.equal(deleted.overlayFiles, rubyPaths.length);
});

test("cold dirty Gemfile keeps committed definitions in the baseline and restores them at unchanged HEAD", async (t) => {
  const f = await fixture(t);
  await f.write("Gemfile", dirtySource);

  const dirty = await f.build();
  const baseline = await f.cachedPayload();

  assert.equal(dirty.cacheHit, false);
  assert.equal(dirty.bySymbol.has("DirtyGemfile#replacement"), true);
  assert.equal(dirty.bySymbol.has("CommittedGemfile"), false);
  assert.equal(baseline.treeHash, f.treeHash);
  assert.equal(baseline.strings.includes("CommittedGemfile#original"), true);
  assert.equal(baseline.strings.includes("DirtyGemfile#replacement"), false);
  assert.equal(dirty.overlayFiles, 1);

  f.git("restore", "Gemfile");
  const restored = await f.build();
  assert.equal(f.git("rev-parse", "HEAD^{tree}"), f.treeHash);
  assert.equal(restored.cacheHit, true);
  assert.equal(restored.overlayFiles, 0);
  assert.equal(restored.bySymbol.has("CommittedGemfile#original"), true);
  assert.equal(restored.bySymbol.has("DirtyGemfile"), false);
});

test("cold deleted Gemfile retains the committed baseline for restoration", async (t) => {
  const f = await fixture(t);
  await rm(join(f.cwd, "Gemfile"));
  const deleted = await f.build();
  assert.equal(deleted.fileCount, 0);
  assert.equal(deleted.overlayFiles, 1);

  f.git("restore", "Gemfile");
  const restored = await f.build();
  assert.equal(restored.treeHash, f.treeHash);
  assert.equal(restored.cacheHit, true);
  assert.equal(restored.bySymbol.has("CommittedGemfile#original"), true);
});

test("untracked Gemfile stays out of a warmed committed baseline", async (t) => {
  const f = await fixture(t, ["sample.rb"]);
  await f.build();
  await f.write("Gemfile", dirtySource);
  const added = await f.build();
  assert.equal(added.cacheHit, true);
  assert.equal(added.overlayFiles, 1);
  assert.equal(added.bySymbol.has("DirtyGemfile#replacement"), true);

  await rm(join(f.cwd, "Gemfile"));
  const removed = await f.build();
  assert.equal(removed.cacheHit, true);
  assert.equal(removed.bySymbol.has("DirtyGemfile"), false);
  assert.equal(removed.bySymbol.has("CommittedGemfile#original"), true);
});

test("old Gemfile-poisoned baselines are rebuilt instead of reused", async (t) => {
  const f = await fixture(t);
  await f.write("Gemfile", dirtySource);
  await f.build();
  const payload = await f.cachedPayload();
  payload.version = 8;
  payload.strings = payload.strings.map((value) => value
    .replaceAll("CommittedGemfile", "DirtyGemfile")
    .replaceAll("original", "replacement"));
  await rm(f.cacheDir, { recursive: true });
  await mkdir(f.cacheDir);
  const legacyKey = createHash("sha256").update(`${f.cwd}\n.\n${f.treeHash}\n8`).digest("hex").slice(0, 24);
  await writeFile(join(f.cacheDir, `${legacyKey}.json.gz`), gzipSync(JSON.stringify(payload)));
  f.git("restore", "Gemfile");

  const restored = await f.build();

  assert.equal(restored.cacheHit, false);
  assert.equal(restored.bySymbol.has("CommittedGemfile#original"), true);
  assert.equal(restored.bySymbol.has("DirtyGemfile"), false);
});

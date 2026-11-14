import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { buildRubyIndex } from "../src/adapters/ruby-index.ts";

const source = "class Renamed\n  def run\n    target\n  end\nend\n";

async function fixture(run: (cwd: string, cacheDir: string, git: (...args: string[]) => string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ruby-rename-"));
  const cwd = join(root, "repo");
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "user.name=t", "-c", "user.email=t@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
    ...args,
  ], { cwd, encoding: "utf8", timeout: 20_000 });
  try {
    await mkdir(cwd);
    git("init", "-q", "-b", "main");
    git("config", "status.renames", "true");
    await run(cwd, join(root, "cache"), git);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const paths = [
  ["old.rb", "new.rb"],
  ['old folder/old -> "é".rb', 'new folder/new -> "é"\tfile.rb'],
  ["old.rb", "new.txt"],
  ["old.txt", "new.rb"],
] as const;
for (const [oldPath, newPath] of paths) {
  for (const warm of [false, true]) {
    test(`${warm ? "warm" : "cold"} staged rename ${JSON.stringify(oldPath)} -> ${JSON.stringify(newPath)} preserves only current paths`, () => fixture(async (cwd, cacheDir, git) => {
      await mkdir(dirname(join(cwd, oldPath)), { recursive: true });
      await mkdir(dirname(join(cwd, newPath)), { recursive: true });
      await writeFile(join(cwd, oldPath), source);
      await writeFile(join(cwd, "modified.rb"), "class Modified\n  def original; end\nend\n");
      await writeFile(join(cwd, "deleted.rb"), "class Deleted; end\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const options = { cwd, root: ".", cacheDir };
      if (warm) assert.equal((await buildRubyIndex(options)).skipped, undefined);
      git("mv", oldPath, newPath);
      assert.match(git("status", "--porcelain"), /^R /m, "fixture must exercise Git's rename record");
      await writeFile(join(cwd, "modified.rb"), "class Modified\n  def current; end\nend\n");
      await rm(join(cwd, "deleted.rb"));
      await writeFile(join(cwd, "untracked.rb"), "class Added; end\n");

      const renamed = await buildRubyIndex(options);
      assert.equal(renamed.skipped, undefined);
      assert.equal(renamed.cacheHit, warm);
      const expected = newPath.endsWith(".rb") ? [newPath] : [];
      assert.deepEqual(renamed.bySymbol.get("Renamed#run")?.map((def) => def.path) ?? [], expected);
      assert.deepEqual(renamed.callSites.get("target")?.map((site) => site.path) ?? [], expected);
      assert.deepEqual(renamed.namespaces.get("Renamed")?.paths ?? [], expected);
      assert.ok(renamed.bySymbol.has("Modified#current"));
      assert.ok(!renamed.bySymbol.has("Modified#original"));
      assert.ok(!renamed.bySymbol.has("Deleted"));
      assert.ok(renamed.bySymbol.has("Added"));
      assert.equal(renamed.fileCount, expected.length + 2);

      const fresh = await buildRubyIndex({ ...options, cacheDir: `${cacheDir}-fresh` });
      const facts = (index: typeof renamed) => ({
        definitions: index.definitions.map((def) => [def.symbol, def.path]).sort(),
        namespaces: [...index.namespaces].map(([symbol, namespace]) => [symbol, [...namespace.paths].sort()]).sort(),
        callers: [...index.callSites].flatMap(([name, sites]) => sites.map((site) => [name, site.path, site.line, site.inDef])).sort(),
      });
      assert.deepEqual(facts(renamed), facts(fresh), "warm and cold indexes agree");
      assert.deepEqual(facts(await buildRubyIndex(options)), facts(renamed), "repeated overlay is stable");

      git("reset", "--hard", "-q", "HEAD");
      await rm(join(cwd, "untracked.rb"));
      const restored = await buildRubyIndex(options);
      assert.equal(restored.cacheHit, true);
      const original = oldPath.endsWith(".rb") ? [oldPath] : [];
      assert.deepEqual(restored.bySymbol.get("Renamed#run")?.map((def) => def.path) ?? [], original, "cold rename must retain the original HEAD baseline");
      assert.deepEqual(restored.callSites.get("target")?.map((site) => site.path) ?? [], original);
      assert.ok(restored.bySymbol.has("Modified#original"));
      assert.ok(restored.bySymbol.has("Deleted"));
      assert.ok(!restored.bySymbol.has("Added"));
    }));
  }
}

test("version 9 baselines made before safe rename parsing are rebuilt", () => fixture(async (cwd, cacheDir, git) => {
  await writeFile(join(cwd, "old.rb"), source);
  git("add", ".");
  git("commit", "-qm", "base");
  const options = { cwd, root: ".", cacheDir };
  await buildRubyIndex(options);
  const [file] = await readdir(cacheDir);
  const path = join(cacheDir, file!);
  const payload = JSON.parse(gunzipSync(await readFile(path)).toString("utf8"));
  payload.version = 9;
  payload.files = [];
  await writeFile(path, gzipSync(JSON.stringify(payload)));
  const rebuilt = await buildRubyIndex(options);
  assert.equal(rebuilt.cacheHit, false);
  assert.deepEqual(rebuilt.bySymbol.get("Renamed#run")?.map((def) => def.path), ["old.rb"]);
}));

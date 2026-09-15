import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ancestorsOf, buildRubyIndex, resolveConstant } from "../src/adapters/ruby-index.ts";

const cwd = await mkdtemp(join(tmpdir(), "ruby-index-"));
const cacheDir = join(cwd, ".cache");
const files: Record<string, string> = {
  "Gemfile": "source 'https://rubygems.org'\n",
  "app/models/application_record.rb": "class ApplicationRecord\n  def save!\n    true\n  end\nend\n",
  "app/models/concerns/auditable.rb": "module Auditable\n  def audit!\n    save!\n  end\nend\n",
  "app/models/billing/reader.rb": `module Billing
  class Reader < ApplicationRecord
    include Auditable

    def applicable?(shop)
      entity = Admin::LegalEntity.for_shop(shop)
      entity.complete? && audit!
    end
  end
end
`,
  "app/models/admin/legal_entity.rb": `module Admin
  class LegalEntity
    def self.for_shop(shop)
      new
    end

    def complete?
      true
    end
  end
end
`,
  "test/models/billing/reader_test.rb": `class ReaderTest < ActiveSupport::TestCase
  test "applicable" do
    assert Billing::Reader.new.applicable?(shop)
  end
end
`,
};
const write = async (path: string, content: string) => {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), content, "utf8");
};
for (const [path, content] of Object.entries(files)) await write(path, content);
const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
git(["init", "-q", "-b", "main"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

const logs: string[] = [];
const cold = await buildRubyIndex({ cwd, root: ".", cacheDir, log: (message) => logs.push(message) });
assert.equal(cold.skipped, undefined);
assert.equal(cold.cacheHit, false);
assert.equal(cold.fileCount, 6, "five .rb files plus the Gemfile");
assert.ok(logs[0]?.startsWith("Scanning code changes for agents"), "progress note printed on a cold build");
assert.ok(cold.bySymbol.has("Billing::Reader#applicable?"));
assert.ok(cold.bySymbol.has("Admin::LegalEntity.for_shop"));
assert.equal(cold.namespaces.get("Billing::Reader")?.superclass, "ApplicationRecord");
assert.deepEqual(cold.namespaces.get("Billing::Reader")?.mixins, ["Auditable"]);
assert.deepEqual(ancestorsOf(cold, "Billing::Reader"), ["Billing::Reader", "Auditable", "ApplicationRecord"]);
assert.equal(resolveConstant(cold, "Admin::LegalEntity", "Billing::Reader#applicable?"), "Admin::LegalEntity");
assert.equal(resolveConstant(cold, "Reader", "Billing::Reader#applicable?"), "Billing::Reader", "lexical nesting resolves a sibling name");
assert.equal(resolveConstant(cold, "Missing", "Billing::Reader"), undefined);

const callers = cold.callSites.get("applicable?") ?? [];
assert.ok(callers.some((site) => site.path === "test/models/billing/reader_test.rb" && site.inDef?.includes('test "applicable"')), "inverse call index records the test call site with its enclosing definition");
const forShop = cold.callSites.get("for_shop") ?? [];
assert.deepEqual([forShop[0]?.receiverType, forShop[0]?.inDef], ["Admin::LegalEntity", "Billing::Reader#applicable?"]);
const complete = (cold.callSites.get("complete?") ?? [])[0]!;
assert.deepEqual([complete.receiverType, complete.via], ["Admin::LegalEntity", "assigned"], "local assigned from a factory call carries its type into the call site");

const cacheFiles = await readdir(cacheDir);
assert.equal(cacheFiles.length, 1);
assert.ok(cacheFiles[0]!.endsWith(".json.gz"));

const warm = await buildRubyIndex({ cwd, root: ".", cacheDir });
assert.equal(warm.cacheHit, true);
assert.equal(warm.definitions.length, cold.definitions.length);
assert.equal(warm.callSites.size, cold.callSites.size);
assert.equal(warm.namespaces.get("Billing::Reader")?.superclass, "ApplicationRecord");

const capped = await buildRubyIndex({ cwd, root: ".", cacheDir, maxFiles: 1 });
assert.match(capped.skipped ?? "", /more than 1 Ruby files.*discovery stopped at 2/, "file discovery stops as soon as the cap is proven");
assert.equal(capped.fileCount, 0);

// Overlay: modify a tracked file, add an untracked file, delete a tracked file
await write("app/models/admin/legal_entity.rb", files["app/models/admin/legal_entity.rb"]!.replace("def complete?", "def complete?(strict = false)"));
await write("app/models/billing/notice.rb", "module Billing\n  class Notice\n    def deliver\n      Billing::Reader.new.applicable?(shop)\n    end\n  end\nend\n");
await rm(join(cwd, "app/models/concerns/auditable.rb"));
const overlay = await buildRubyIndex({ cwd, root: ".", cacheDir });
assert.equal(overlay.cacheHit, true, "base index still served from cache");
assert.equal(overlay.overlayFiles, 3);
assert.ok(overlay.bySymbol.has("Billing::Notice#deliver"), "untracked file indexed through the overlay");
assert.ok(!overlay.bySymbol.has("Auditable#audit!"), "deleted file removed from the merged index");
assert.equal(overlay.bySymbol.get("Admin::LegalEntity#complete?")?.[0]?.params?.length ?? overlay.bySymbol.get("Admin::LegalEntity#complete?")?.length, 1);
assert.ok((overlay.callSites.get("applicable?") ?? []).some((site) => site.path === "app/models/billing/notice.rb"));
assert.equal((await readdir(cacheDir)).length, 1, "overlay does not write a new cache file");

console.log(`ruby index ok: ${cold.definitions.length} definitions, cold ${cold.builtMs} ms, warm ${warm.builtMs} ms, overlay ${overlay.overlayFiles} files`);

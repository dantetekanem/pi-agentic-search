import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { expandRelatedFiles } from "../src/related.ts";
import { ProjectFiles, RESOLUTION_LIMITS } from "../src/inventory.ts";
import { SearchRequest } from "../src/retrieval.ts";

async function fixture(files: Record<string, string>, run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "search-traversal-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), source);
    }
    await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("a request shares its visible inventory and canonical source cache", () => fixture({
  ".git/HEAD": "ref: refs/heads/main\n", ".gitignore": "ignored.ts\n",
  "ignored.ts": "ignored", "src/main.ts": "export const needle = 1;\n",
}, async (cwd) => {
  await symlink(join(cwd, "src/main.ts"), join(cwd, "alias.ts"));
  const request = new SearchRequest();
  try {
    const files = new ProjectFiles(cwd, request);
    const first = await files.list(".");
    assert.deepEqual(await files.list(cwd), first);
    assert.ok(!first.some((path) => path.endsWith("ignored.ts")));
    assert.equal(await files.read("src/main.ts"), await files.read("alias.ts"));
    assert.equal(files.stats.sourceReads, 1);
    assert.equal(request.runs.filter((run) => run.kind === "inventory").length, 1);
  } finally { request.dispose(); }
}));

test("Ruby lookup uses lexical namespace constants rather than guessing a filename", () => fixture({
  "app/models/admin/user.rb": "module Admin\n  class User\n    include ScopeRules\n  end\nend\n",
  "app/models/admin/behavior.rb": "module Admin::ScopeRules\n  scope :needle, -> { all }\nend\n",
  "app/models/concerns/scope_rules.rb": "module ScopeRules\n  scope :other, -> { all }\nend\n",
}, async (cwd) => {
  const result = await expandRelatedFiles(cwd, ["app/models/admin/user.rb"]);
  assert.deepEqual(result?.roots, ["app/models/admin/behavior.rb"]);
  assert.equal(result?.resolved[0]?.provenance, "ruby-constant-index");
}));

for (const declaration of ["class Admin::User", "module Admin::User"]) {
  test(`${declaration} does not add Admin to lexical mixin lookup`, () => fixture({
    "app/models/admin/user.rb": `${declaration}\n  include ScopeRules\nend\n`,
    "app/models/admin/behavior.rb": "module Admin::ScopeRules\nend\n",
    "app/models/concerns/scope_rules.rb": "module ScopeRules\nend\n",
  }, async (cwd) => {
    const result = await expandRelatedFiles(cwd, ["app/models/admin/user.rb"]);
    assert.deepEqual(result?.roots, ["app/models/concerns/scope_rules.rb"]);
    assert.equal(result?.resolved[0]?.provenance, "ruby-constant-index");
    assert.deepEqual(result?.unresolved, []);
  }));
}

for (const declaration of ["class Admin::User", "class ::Admin::User"]) {
  test(`${declaration} preserves the actual outer lexical module`, () => fixture({
    "app/models/outer.rb": `module Outer\n  ${declaration}\n    include ScopeRules\n  end\nend\n`,
    "app/models/outer/rules.rb": "module Outer::ScopeRules\nend\n",
    "app/models/outer/admin/rules.rb": "module Outer::Admin::ScopeRules\nend\n",
    "app/models/admin/rules.rb": "module Admin::ScopeRules\nend\n",
    "app/models/concerns/scope_rules.rb": "module ScopeRules\nend\n",
  }, async (cwd) => {
    const result = await expandRelatedFiles(cwd, ["app/models/outer.rb"]);
    assert.deepEqual(result?.roots, ["app/models/outer/rules.rb"]);
    assert.equal(result?.resolved[0]?.provenance, "ruby-constant-index");
  }));
}

test("Ruby constant indexing honors literal configured autoload roots", () => fixture({
  "config/application.rb": "config.autoload_paths << Rails.root.join('domain')\n",
  "app/models/user.rb": "class User\n  include DomainScopes\nend\n",
  "domain/behavior.rb": "module DomainScopes\n  scope :needle, -> { all }\nend\n",
}, async (cwd) => {
  const result = await expandRelatedFiles(cwd, ["app/models/user.rb"]);
  assert.deepEqual(result?.roots, ["domain/behavior.rb"]);
}));

test("Ruby include, prepend, and extend preserve their relationship", () => fixture({
  "app/models/user.rb": "class User\n  include Attributes\n  prepend Hooks\n  extend Scopes\nend\n",
  "app/models/concerns/attributes.rb": "module Attributes\nend\n",
  "app/models/concerns/hooks.rb": "module Hooks\nend\n",
  "app/models/concerns/scopes.rb": "module Scopes\nend\n",
}, async (cwd) => {
  const result = await expandRelatedFiles(cwd, ["app/models/user.rb"]);
  assert.deepEqual(result?.resolved.map(({ name, relationship }) => [name, relationship]), [
    ["Attributes", "included by"], ["Hooks", "prepended by"], ["Scopes", "extended by"],
  ]);
}));

test("dynamic Ruby mixins remain explicit unresolved edges", () => fixture({
  "app/models/user.rb": "class User\n  include selected_concern\nend\n",
}, async (cwd) => {
  const result = await expandRelatedFiles(cwd, ["app/models/user.rb"]);
  assert.deepEqual(result?.unresolved, [{ from: "app/models/user.rb", name: "selected_concern" }]);
}));

test("deep Ruby lexical nesting stops with explicit partial coverage", () => fixture({
  "app/models/deep.rb": [...Array(80).fill("module A"), "include Missing", ...Array(80).fill("end")].join("\n"),
  "app/models/qualified.rb": `module ${Array(80).fill("A").join("::")}\n  include Missing\nend\n`,
}, async (cwd) => {
  for (const path of ["app/models/deep.rb", "app/models/qualified.rb"]) {
    const result = await expandRelatedFiles(cwd, [path]);
    assert.ok(result?.skipped?.some((reason) => reason.includes("namespace depth budget") && reason.includes(path)));
  }
}));

test("canonical traversal terminates Ruby cycles and duplicate symlink roots", () => fixture({
  "app/models/a.rb": "module A\n  include B\nend\n",
  "app/models/b.rb": "module B\n  include A\nend\n",
}, async (cwd) => {
  await symlink(join(cwd, "app/models/a.rb"), join(cwd, "alias.rb"));
  const result = await expandRelatedFiles(cwd, ["app/models/a.rb", "alias.rb"]);
  assert.equal(result?.traversal?.visitedFiles, 2);
  assert.equal(result?.unresolved.length, 0);
}));

test("mixed Ruby and JS traversal enumerates a directory only once", () => fixture({
  "app/models/user.rb": "class User\n  include Scopes\nend\n",
  "app/models/concerns/scopes.rb": "module Scopes\nend\n",
  "src/main.ts": "import './helper';\n",
  "src/helper.ts": "export const needle = 1;\n",
}, async (cwd) => {
  const result = await expandRelatedFiles(cwd, ["."]);
  assert.equal(result?.traversal?.inventories, 1);
  assert.equal(result?.label, "related");
}));

test("source-byte limits retain a bounded prefix and report skipped work", () => fixture({
  "large.ts": "import './one';\n".repeat(100),
}, async (cwd) => {
  const request = new SearchRequest();
  try {
    const files = new ProjectFiles(cwd, request, { ...RESOLUTION_LIMITS, sourceBytes: 32 });
    const source = await files.read("large.ts");
    assert.ok(Buffer.byteLength(source ?? "") <= 32);
    assert.ok(files.skipped.some((reason) => reason.includes("source byte budget")));
  } finally { request.dispose(); }
}));

test("concurrent source reads share one cache-byte budget", () => fixture({
  "a.ts": "12345678", "b.ts": "12345678",
}, async (cwd) => {
  const request = new SearchRequest();
  try {
    const files = new ProjectFiles(cwd, request, { ...RESOLUTION_LIMITS, textBytes: 10 });
    const sources = await Promise.all([files.read("a.ts"), files.read("b.ts")]);
    assert.ok(sources.reduce((bytes, source) => bytes + Buffer.byteLength(source ?? ""), 0) <= 10);
    assert.ok(files.stats.bytesRead <= 10);
  } finally { request.dispose(); }
}));

test("cancellation during a source read stops subsequent graph expansion", () => fixture({
  "src/main.ts": "import './helper';\n", "src/helper.ts": "export const needle = 1;\n",
}, async (cwd) => {
  const controller = new AbortController();
  const request = new SearchRequest(controller.signal);
  try {
    const files = new ProjectFiles(cwd, request);
    const read = files.read.bind(files);
    files.read = async (path, limit) => { const source = await read(path, limit); controller.abort(); return source; };
    const result = await expandRelatedFiles(cwd, ["src/main.ts"], controller.signal, files);
    assert.equal(result?.traversal?.visitedFiles, 1);
    assert.equal(result?.traversal?.omittedEdges, 1);
    assert.equal(files.stats.sourceReads, 1);
  } finally { request.dispose(); }
}));

test("cancellation reaches traversal before a filesystem inventory starts", () => fixture({
  "src/main.ts": "import './helper';\n", "src/helper.ts": "export const needle = 1;\n",
}, async (cwd) => {
  const controller = new AbortController();
  controller.abort();
  const result = await expandRelatedFiles(cwd, ["."], controller.signal);
  assert.ok(result?.skipped?.some((reason) => /abort|cancel|deadline/i.test(reason)));
  assert.equal(result?.traversal?.inventories, 0);
}));

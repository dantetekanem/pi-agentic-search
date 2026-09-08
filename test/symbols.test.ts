import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { expandRelatedFiles } from "../src/related.ts";
import extension from "../index.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SearchDetails } from "../src/types.ts";
import { ProjectFiles } from "../src/inventory.ts";
import { SearchRequest } from "../src/retrieval.ts";
import { JavascriptResolver } from "../src/resolvers/javascript.ts";

async function fixture(files: Record<string, string>, run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "search-symbols-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), source);
    }
    await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
const cases = [
  { name: "named import alias", main: "import { original as run } from './impl';", impl: "export function original() {}", symbol: "original" },
  { name: "default import alias", main: "import run from './impl';", impl: "export default function original() {}", symbol: "original" },
  { name: "require destructuring alias", main: "const { original: run } = require('./impl');", impl: "exports.original = function original() {};", symbol: "original" },
  { name: "require property binding", main: "const run = require('./impl').original;", impl: "exports.original = function original() {};", symbol: "original" },
  { name: "CommonJS default binding", main: "const run = require('./impl');", impl: "module.exports = function original() {};", symbol: "original" },
];
for (const scenario of cases) {
  test(`symbol graph follows ${scenario.name}`, () => fixture({ "main.ts": scenario.main, "impl.ts": scenario.impl }, async (cwd) => {
    const related = await expandRelatedFiles(cwd, ["main.ts"], undefined, undefined, "definition", "run");
    assert.ok(related?.symbolSearches?.some((item) => item.path === "impl.ts" && item.symbol === scenario.symbol));
    assert.equal(related?.unresolved.length, 0);
  }));
}

test("registered search exposes scoped alias evidence", () => fixture({
  "main.ts": "import { original as run } from './impl';\nrun();",
  "impl.ts": "export function original() {}",
}, async (cwd) => {
  let registered: Pick<ToolDefinition, "execute"> | undefined;
  const adapter: Pick<ExtensionAPI, "registerTool" | "registerCommand"> = {
    registerTool(tool) { registered = tool; }, registerCommand() {},
  };
  extension(adapter as ExtensionAPI);
  assert.ok(registered);
  const result = await registered.execute("symbol-test", { query: "run", path: "main.ts", intent: "definition", expand_related: true }, undefined, undefined, { cwd } as ExtensionContext);
  const details = result.details as SearchDetails;
  assert.ok(details.related?.symbolSearches?.some((item) => item.path === "impl.ts" && item.symbol === "original" && item.querySymbol === "run"));
  assert.deepEqual(details.related?.resolved[0]?.bindings, [{ local: "run", imported: "original" }]);
}));

test("symbol graph follows re-export and local export aliases", () => fixture({
  "main.ts": "import { publicName as run } from './barrel';",
  "barrel.ts": "export { localName as publicName } from './impl';",
  "impl.ts": "function original() {}\nexport { original as localName };",
}, async (cwd) => {
  const related = await expandRelatedFiles(cwd, ["main.ts"], undefined, undefined, "definition", "run");
  assert.ok(related?.symbolSearches?.some((item) => item.path === "impl.ts" && item.symbol === "original"));
}));

test("require in an ESM file selects the require export condition", () => fixture({
  "main.mts": "const { original: run } = require('conditional');",
  "node_modules/conditional/package.json": '{"name":"conditional","exports":{"import":"./esm.mjs","require":"./common.cjs"}}',
  "node_modules/conditional/esm.mjs": "export function original() {}",
  "node_modules/conditional/common.cjs": "exports.original = function original() {};",
}, async (cwd) => {
  const related = await expandRelatedFiles(cwd, ["main.mts"], undefined, undefined, "definition", "run");
  assert.equal(related?.packageRoots[0]?.entryPath, "node_modules/conditional/common.cjs");
  assert.ok(related?.symbolSearches?.some((item) => item.path.endsWith("common.cjs") && item.symbol === "original"));
}));

test("workspace aliases retain one canonical package identity", () => fixture({
  "main.ts": "import { original as run } from 'workspace-core';\nimport { original as other } from './packages/core/index';",
  "packages/core/package.json": '{"name":"workspace-core","main":"./index.ts"}',
  "packages/core/index.ts": "export function original() {}",
}, async (cwd) => {
  await mkdir(join(cwd, "node_modules"));
  await symlink(join(cwd, "packages/core"), join(cwd, "node_modules/workspace-core"));
  const related = await expandRelatedFiles(cwd, ["main.ts"], undefined, undefined, "definition", "run");
  assert.equal(related?.packageRoots[0]?.path, "packages/core");
  assert.equal(related?.symbolSearches?.filter((item) => item.path === "packages/core/index.ts" && item.symbol === "original").length, 1);
}));

test("duplicate imported symbols do not exhaust the binding budget", () => fixture({
  "main.ts": "const { original: first, original: second } = require('./impl');",
}, async (cwd) => {
  const request = new SearchRequest();
  try {
    const files = new ProjectFiles(cwd, request);
    const result = await new JavascriptResolver(files).inspect("const { original: first, original: second } = require('./impl');", join(cwd, "main.ts"), ["first", "second"]);
    assert.deepEqual(result.references[0]?.symbols, ["original"]);
    assert.deepEqual(files.skipped, []);
  } finally { request.dispose(); }
}));

test("host fallback retains the originating symbol edge", () => fixture({ "main.ts": "export {};" }, async (cwd) => {
  const request = new SearchRequest();
  try {
    const files = new ProjectFiles(cwd, request);
    const bindings = [{ local: "run", imported: "createSourceFile" }];
    const targets = await new JavascriptResolver(files).resolve(join(cwd, "main.ts"), {
      name: "typescript", relationship: "imported by", bindings, symbols: ["createSourceFile"],
    });
    assert.deepEqual(targets[0]?.bindings, bindings);
    assert.deepEqual(targets[0]?.symbols, ["createSourceFile"]);
  } finally { request.dispose(); }
}));

test("binding caps retain the relevant late alias", () => fixture({
  "main.ts": `import { ${Array.from({ length: 70 }, (_, index) => `other${index}`).join(", ")}, original as run } from './impl';`,
  "impl.ts": "export function original() {}",
}, async (cwd) => {
  const related = await expandRelatedFiles(cwd, ["main.ts"], undefined, undefined, "definition", "run");
  assert.ok(related?.symbolSearches?.some((item) => item.path === "impl.ts" && item.symbol === "original"));
  assert.equal(related?.resolved[0]?.bindings?.length, 32);
  assert.ok(related?.skipped?.some((reason) => reason.includes("symbol binding budget")));
}));

test("syntax discovery distinguishes dynamic calls from text lookalikes", () => fixture({
  "main.ts": "// import 'comment-only';\nconst text = \"require('string-only')\";\nimport(variable);",
}, async (cwd) => {
  const related = await expandRelatedFiles(cwd, ["main.ts"], undefined, undefined, "definition", "run");
  assert.deepEqual(related?.unresolved.map((item) => item.name), ["<dynamic import>"]);
  assert.ok(related?.skipped?.some((reason) => reason.includes("<dynamic import>")));
}));

test("cyclic re-exports preserve the requested symbol and terminate", () => fixture({
  "main.ts": "import { publicName as run } from './a';",
  "a.ts": "export * from './b';",
  "b.ts": "export * from './a';\nexport { original as publicName } from './impl';",
  "impl.ts": "export function original() {}",
}, async (cwd) => {
  const related = await expandRelatedFiles(cwd, ["main.ts"], undefined, undefined, "definition", "run");
  assert.ok(related?.symbolSearches?.some((item) => item.path === "impl.ts" && item.symbol === "original"));
  assert.ok((related?.traversal?.examinedEdges ?? Infinity) < 12);
}));

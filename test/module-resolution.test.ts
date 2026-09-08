import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type ts from "typescript";
import extension from "../index.ts";
import { ProjectFiles, RESOLUTION_LIMITS } from "../src/inventory.ts";
import { JavascriptResolver } from "../src/resolvers/javascript.ts";
import { SearchRequest } from "../src/retrieval.ts";
import type { SearchDetails, SearchIntent } from "../src/types.ts";

const nodeConfig = JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } });
async function fixture(files: Record<string, string>, run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "search-module-resolution-"));
  try {
    for (const [path, source] of Object.entries({ "package.json": '{"name":"fixture","type":"module"}', "tsconfig.json": nodeConfig, ...files })) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), source);
    }
    if (!Object.keys(files).some((path) => path.startsWith("node_modules/typescript/"))) {
      await mkdir(join(cwd, "node_modules"), { recursive: true });
      await symlink(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), join(cwd, "node_modules/typescript"));
    }
    await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
async function resolveModule(cwd: string, from: string, name: string, intent: SearchIntent = "auto") {
  const request = new SearchRequest();
  try {
    const files = new ProjectFiles(cwd, request);
    const resolver = new JavascriptResolver(files, { intent });
    const targets = await resolver.resolve(await files.canonical(from), { name, relationship: "imported by" });
    return { target: targets[0], skipped: files.skipped };
  } finally { request.dispose(); }
}

for (const [imported, source] of [["impl.js", "impl.ts"], ["impl.mjs", "impl.mts"], ["impl.cjs", "impl.cts"]] as const) {
  test(`project resolution substitutes ${imported} with ${source}`, () => fixture({
    "src/main.ts": `import { needle } from './${imported}';\n`,
    [`src/${source}`]: "export function needle() {}\n",
  }, async (cwd) => {
    const { target } = await resolveModule(cwd, "src/main.ts", `./${imported}`);
    assert.equal(target?.path, `src/${source}`);
  }));
}

test("project paths aliases and inherited config resolve through TypeScript", () => fixture({
  "tsconfig.json": '{"extends":"./config/base.json","compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"}}',
  "config/base.json": '{"compilerOptions":{"baseUrl":"..","paths":{"@core/*":["src/core/*"]}}}',
  "src/main.ts": "import { needle } from '@core/impl';\n",
  "src/core/impl.ts": "export function needle() {}\n",
}, async (cwd) => {
  const { target } = await resolveModule(cwd, "src/main.ts", "@core/impl");
  assert.equal(target?.path, "src/core/impl.ts");
}));

test("package imports resolve project-local # specifiers", () => fixture({
  "package.json": '{"name":"fixture","type":"module","imports":{"#core/*":"./src/core/*.js"}}',
  "src/main.ts": "import { needle } from '#core/impl';\n",
  "src/core/impl.ts": "export function needle() {}\n",
}, async (cwd) => {
  const { target } = await resolveModule(cwd, "src/main.ts", "#core/impl");
  assert.equal(target?.path, "src/core/impl.ts");
}));

const conditionalPackage = {
  "node_modules/conditional/package.json": JSON.stringify({ name: "conditional", exports: {
    ".": { import: "./esm.mjs", require: "./common.cjs" },
    "./feature": { import: "./feature.mjs", require: "./feature.cjs" },
  } }),
  "node_modules/conditional/esm.mjs": "export function needle() {}\n",
  "node_modules/conditional/common.cjs": "exports.needle = function() {};\n",
  "node_modules/conditional/feature.mjs": "export function needle() {}\n",
  "node_modules/conditional/feature.cjs": "exports.needle = function() {};\n",
};
for (const [from, entry] of [["src/main.mts", "esm.mjs"], ["src/main.cts", "common.cjs"]] as const) {
  test(`${from} chooses the matching package export condition`, () => fixture({
    ...conditionalPackage, [from]: "import { needle } from 'conditional';\n",
  }, async (cwd) => {
    const { target } = await resolveModule(cwd, from, "conditional");
    assert.equal(target?.entryPath, `node_modules/conditional/${entry}`);
  }));
}

test("package subpaths retain their entry surface", () => fixture({
  ...conditionalPackage, "src/main.mts": "import { needle } from 'conditional/feature';\n",
}, async (cwd) => {
  const { target } = await resolveModule(cwd, "src/main.mts", "conditional/feature");
  assert.equal(target?.entryPath, "node_modules/conditional/feature.mjs");
}));

test("declaration lookup distinguishes API declarations from runtime implementations", () => fixture({
  "src/main.mts": "import { needle } from 'typed';\n",
  "node_modules/typed/package.json": '{"name":"typed","exports":{"types":"./index.d.ts","import":"./index.mjs"}}',
  "node_modules/typed/index.d.ts": "export declare function needle(): void;\n",
  "node_modules/typed/index.mjs": "export function needle() {}\n",
}, async (cwd) => {
  const definition = await resolveModule(cwd, "src/main.mts", "typed", "definition");
  const runtime = await resolveModule(cwd, "src/main.mts", "typed", "auto");
  assert.equal(definition.target?.entryPath, "node_modules/typed/index.d.ts");
  assert.equal(runtime.target?.entryPath, "node_modules/typed/index.mjs");
  assert.equal(runtime.target?.declarationPath, "node_modules/typed/index.d.ts");
  assert.equal(definition.target?.implementationPath, "node_modules/typed/index.mjs");
}));

test("search intent selects the package's declaration entry", () => fixture({
  "src/main.mts": "import { needle } from 'typed';\nneedle();\n",
  "node_modules/typed/package.json": '{"name":"typed","exports":{"types":"./index.d.ts","import":"./index.mjs"}}',
  "node_modules/typed/index.d.ts": "export declare function needle(): void;\n",
  "node_modules/typed/index.mjs": "export function needle() {}\n",
}, async (cwd) => {
  let registered: Pick<ToolDefinition, "execute"> | undefined;
  const adapter: Pick<ExtensionAPI, "registerTool" | "registerCommand"> = {
    registerTool(tool) { registered = tool; }, registerCommand() {},
  };
  extension(adapter as ExtensionAPI);
  assert.ok(registered);
  const result = await registered.execute("resolution-test", {
    query: "needle", path: "src/main.mts", expand_related: true, intent: "definition",
  }, undefined, undefined, { cwd } as ExtensionContext);
  const details = result.details as SearchDetails;
  assert.equal(details.related?.packageRoots[0]?.entryPath, "node_modules/typed/index.d.ts");
  assert.ok(details.files.some((file) => file.path === "node_modules/typed/index.d.ts"));
}));

test("an unexported package subpath remains unresolved", () => fixture({
  ...conditionalPackage, "src/main.mts": "import 'conditional/private';\n",
  "node_modules/conditional/private.js": "export function needle() {}\n",
}, async (cwd) => {
  const { target } = await resolveModule(cwd, "src/main.mts", "conditional/private");
  assert.equal(target, undefined);
}));

const oracleFiles = {
  ...conditionalPackage,
  "tsconfig.json": JSON.stringify({ compilerOptions: {
    module: "NodeNext", moduleResolution: "NodeNext", baseUrl: ".",
    paths: { "@core/*": ["src/core/*.ts"] }, customConditions: ["development"],
  } }),
  "package.json": '{"name":"fixture","type":"module","imports":{"#core/*":"./src/core/*.js"}}',
  "src/main.mts": "export {};\n", "src/main.cts": "export {};\n",
  "src/impl.ts": "export const needle = 1;\n", "src/impl.mts": "export const needle = 1;\n",
  "src/impl.cts": "export const needle = 1;\n", "src/core/aliased.ts": "export const needle = 1;\n",
  "node_modules/typed/package.json": '{"name":"typed","exports":{"types":"./index.d.ts","import":"./index.mjs"}}',
  "node_modules/typed/index.d.ts": "export declare const needle: number;\n",
  "node_modules/typed/index.mjs": "export const needle = 1;\n",
  "node_modules/custom/package.json": '{"name":"custom","exports":{"development":"./dev.mjs","default":"./prod.mjs"}}',
  "node_modules/custom/dev.mjs": "export const needle = 1;\n",
  "node_modules/custom/prod.mjs": "export const needle = 2;\n",
};
for (const [label, from, specifier] of [
  ["JS substitution", "src/main.mts", "./impl.js"], ["MJS substitution", "src/main.mts", "./impl.mjs"],
  ["CJS substitution", "src/main.cts", "./impl.cjs"], ["paths", "src/main.mts", "@core/aliased"],
  ["baseUrl", "src/main.mts", "src/impl.js"], ["#imports", "src/main.mts", "#core/aliased"],
  ["import condition", "src/main.mts", "conditional"], ["require condition", "src/main.cts", "conditional"],
  ["subpath", "src/main.mts", "conditional/feature"], ["types", "src/main.mts", "typed"],
  ["custom condition", "src/main.mts", "custom"], ["blocked export", "src/main.mts", "conditional/private"],
] as const) {
  test(`project compiler oracle: ${label}`, () => fixture(oracleFiles, async (cwd) => {
    // The fixture's compiler is an explicit link to the existing trusted dependency.
    const compiler: typeof ts = createRequire(join(cwd, "package.json"))("typescript");
    const configPath = join(cwd, "tsconfig.json");
    const config = compiler.readConfigFile(configPath, compiler.sys.readFile);
    const { options } = compiler.parseJsonConfigFileContent(config.config, compiler.sys, cwd, undefined, configPath);
    const file = join(cwd, from);
    const mode = compiler.getImpliedNodeFormatForFile(file, undefined, compiler.sys, options);
    const expected = compiler.resolveModuleName(specifier, file, options, compiler.sys, undefined, undefined, mode).resolvedModule;
    const { target } = await resolveModule(cwd, from, specifier, "definition");
    if (!expected) { assert.equal(target, undefined); return; }
    assert.ok(target);
    assert.equal(await realpath(resolve(cwd, target.entryPath ?? target.path)), await realpath(expected.resolvedFileName));
    assert.equal(target.compilerVersion, compiler.version);
    assert.equal(target.projectCompilerVersion, compiler.version);
    assert.equal(target.provenance, "typescript-project-config");
    assert.equal(target.configPath, "tsconfig.json");
  }));
}

test("resolving config never executes repository compiler or plugin code", () => fixture({
  "tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","plugins":[{"name":"project-plugin"}]}}',
  "src/main.ts": "import './impl.js';\n", "src/impl.ts": "export const needle = 1;\n",
  "node_modules/typescript/package.json": '{"name":"typescript","version":"0.0.0","main":"index.cjs"}',
  "node_modules/project-plugin/package.json": '{"name":"project-plugin","main":"index.cjs"}',
}, async (cwd) => {
  const marker = join(cwd, "executed");
  const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`;
  for (const name of ["typescript", "project-plugin"]) await writeFile(join(cwd, "node_modules", name, "index.cjs"), source);
  const { target, skipped } = await resolveModule(cwd, "src/main.ts", "./impl.js");
  assert.equal(target?.path, "src/impl.ts");
  assert.equal(target?.projectCompilerVersion, "0.0.0");
  assert.ok(skipped.some((reason) => reason.includes("differs from trusted resolver")));
  await assert.rejects(access(marker), { code: "ENOENT" });
}));

test("compiler host reuses bounded request reads without listing project files", () => fixture(oracleFiles, async (cwd) => {
  const request = new SearchRequest();
  try {
    const files = new ProjectFiles(cwd, request);
    const resolver = new JavascriptResolver(files);
    const from = await files.canonical("src/main.mts");
    const reference = { name: "conditional", relationship: "imported by" };
    assert.equal((await resolver.resolve(from, reference))[0]?.entryPath, "node_modules/conditional/esm.mjs");
    const reads = files.stats.sourceReads;
    await resolver.resolve(from, reference);
    assert.equal(files.stats.sourceReads, reads);
    assert.equal(files.stats.inventories, 0);
    assert.ok(files.stats.bytesRead <= files.limits.textBytes);
    assert.deepEqual(files.skipped, []);
  } finally { request.dispose(); }
}));

test("compiler pass exhaustion reports incomplete work", () => fixture(oracleFiles, async (cwd) => {
  const request = new SearchRequest();
  try {
    const files = new ProjectFiles(cwd, request, { ...RESOLUTION_LIMITS, compilerPasses: 1 });
    const resolver = new JavascriptResolver(files);
    assert.deepEqual(await resolver.resolve(await files.canonical("src/main.mts"), { name: "conditional", relationship: "imported by" }), []);
    assert.equal(files.stats.compilerPasses, 1);
    assert.ok(files.skipped.some((reason) => reason.includes("compiler resolution pass budget")));
  } finally { request.dispose(); }
}));

test("cancellation during compiler filesystem discovery stops resolution", () => fixture(oracleFiles, async (cwd) => {
  const controller = new AbortController();
  const request = new SearchRequest(controller.signal);
  class CancellingFiles extends ProjectFiles {
    override async fileStat(path: string) {
      const result = await super.fileStat(path);
      controller.abort("stop compiler discovery");
      return result;
    }
  }
  try {
    const files = new CancellingFiles(cwd, request);
    assert.deepEqual(await new JavascriptResolver(files).resolve(join(cwd, "src/main.mts"), { name: "conditional", relationship: "imported by" }), []);
    assert.equal(files.stats.sourceReads, 0);
    assert.ok(files.skipped.some((reason) => reason.includes("resolution cancelled")));
  } finally { request.dispose(); }
}));

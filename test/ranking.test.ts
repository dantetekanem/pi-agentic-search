import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension, { parseRipgrepJsonLines } from "../index.ts";
import type { SearchDetails } from "../src/types.ts";

let registered: Pick<ToolDefinition, "execute"> | undefined;
const adapter: Pick<ExtensionAPI, "registerTool" | "registerCommand"> = {
  registerTool(tool) { registered = tool; }, registerCommand() {},
};
extension(adapter as ExtensionAPI);
async function search(cwd: string, params: Record<string, unknown>): Promise<SearchDetails> {
  const result = await registered!.execute("ranking", params, undefined, undefined, { cwd } as ExtensionContext);
  return result.details as SearchDetails;
}
async function fixture(files: Record<string, string>, run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "search-ranking-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), source);
    }
    await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
function match(source: string, query: string, path = "src/target.ts") {
  const start = Buffer.byteLength(source.slice(0, source.indexOf(query)));
  return parseRipgrepJsonLines(JSON.stringify({ type: "match", data: {
    path: { text: path }, lines: { text: `${source}\n` }, line_number: 1,
    submatches: [{ match: { text: query }, start, end: start + Buffer.byteLength(query) }],
  } }))[0]!;
}

test("declaration evidence belongs to the matched name, not an initializer or body", () => {
  assert.equal(match("const cached = needle();", "needle").isDefinition, false);
  assert.equal(match("export function other() { return needle(); }", "needle").isDefinition, false);
  assert.equal(match("export const needle = () => 1;", "needle").isDefinition, true);
  assert.equal(match("export function needle() {}", "needle").isDefinition, true);
  assert.equal(match("export function ação() {}", "ação").isDefinition, true);
  assert.equal(match("  scope :active, -> { all }", "scope :", "user.rb").isDefinition, true);
  assert.equal(match("  def needle!", "needle!", "user.rb").isDefinition, true);
  assert.equal(match("  def User.needle", "needle", "user.rb").isDefinition, true);
  assert.equal(match("const text = 'needle';", "needle").kind, "string");
  assert.equal(match("// export function needle() {}", "needle").kind, "comment");
  assert.equal(match("import { needle } from './impl';", "needle").kind, "import");
});

test("definition intent beats callers and directory path priors", () => fixture({
  "src/a-caller.ts": "const cached = needle();\n",
  "src/zzz-definition.ts": "export function needle() {}\n",
}, async (cwd) => {
  for (const path of [undefined, "src"]) {
    const result = await search(cwd, { query: "needle", path, intent: "definition" });
    assert.equal(result.files[0]?.path, "src/zzz-definition.ts");
    assert.equal(result.files[0]?.topMatch?.marker, "def");
  }
}));

test("definition intent distinguishes the navigation anchor from its implementation", () => fixture({
  "src/main.ts": "import { needle } from './impl';\nconst cached = needle();\n",
  "src/impl.ts": "export function needle() {}\n",
}, async (cwd) => {
  const definition = await search(cwd, { query: "needle", path: "src/main.ts", intent: "definition", expand_related: true });
  assert.equal(definition.files[0]?.path, "src/impl.ts");
  const file = await search(cwd, { query: "needle", path: "src/main.ts", intent: "file", expand_related: true });
  assert.equal(file.files[0]?.path, "src/main.ts");
}));

test("test and reference intents prefer their relevant evidence", () => fixture({
  "src/needle.ts": "export function needle() {}\n",
  "src/caller.ts": "needle();\n",
  "test/needle.test.ts": "test('needle handles empty values', () => needle());\n",
}, async (cwd) => {
  const tests = await search(cwd, { query: "needle", intent: "tests" });
  assert.equal(tests.files[0]?.path, "test/needle.test.ts");
  const references = await search(cwd, { query: "needle", intent: "references", path: "src" });
  assert.equal(references.files[0]?.path, "src/caller.ts");
}));

test("an unrelated variable declaration does not suppress imported-package expansion", () => fixture({
  "package.json": '{"name":"fixture"}',
  "src/main.ts": "import { needle } from 'dependency';\nconst cached = needle();\n",
  "node_modules/dependency/package.json": '{"name":"dependency","main":"index.js"}',
  "node_modules/dependency/index.js": "export function needle() {}\n",
}, async (cwd) => {
  const result = await search(cwd, { query: "needle", path: "src/main.ts", intent: "definition", expand_related: true });
  assert.equal(result.files[0]?.path, "node_modules/dependency/index.js");
}));

test("context uses identifier boundaries and a bounded surrounding block", () => fixture({
  "src/a-payment.ts": "// wholesale catalogue\nexport function needle() {}\n",
  "src/z-orders.ts": "// sale reconciliation\nexport function needle() {}\n",
}, async (cwd) => {
  const result = await search(cwd, { query: "needle", context: "sale", intent: "definition" });
  assert.equal(result.files[0]?.path, "src/z-orders.ts");
}));

test("context splits camel-case path words before case normalization", () => fixture({
  "src/a.ts": "export function needle() {}\n",
  "src/actualGoal.ts": "export function needle() {}\n",
}, async (cwd) => {
  const result = await search(cwd, { query: "needle", context: "goal", intent: "definition" });
  assert.equal(result.files[0]?.path, "src/actualGoal.ts");
}));

test("context enrichment reports its shortlist independently of display limits", () => fixture(
  Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`src/${index}.ts`, "// sale\nexport function needle() {}\n"])),
  async (cwd) => {
    const result = await search(cwd, { query: "needle", context: "sale", max_files: 1 });
    assert.deepEqual(result.coverage.contextRanking, {
      fileLimit: 8, readByteLimit: 65_536, blockByteLimit: 512, enrichedCandidates: 8, unexaminedCandidates: 4,
    });
    assert.equal(result.coverage.status, "complete");
  },
));

test("snippet selection prefers relevant evidence and removes neighboring duplicates", () => fixture({
  "src/target.ts": "// needle in commentary\nconst text = 'needle';\n\n\nexport function needle() {\n  return needle;\n}\n\n\n\nneedle();\n",
}, async (cwd) => {
  const result = await search(cwd, { query: "needle", intent: "definition", max_matches_per_file: 2 });
  assert.equal(result.files[0]?.topMatch?.lineNumber, 5);
  assert.equal(result.files[0]?.topMatch?.marker, "def");
}));

test("verbose context cannot promote a reference snippet over a declaration", () => fixture({
  "src/target.ts": "needle({one, two, three, four, five, six, seven, eight, nine, ten, eleven});\n\n\n\n\nexport function needle() {}\n",
}, async (cwd) => {
  const result = await search(cwd, { query: "needle", intent: "definition", context: "one two three four five six seven eight nine ten eleven" });
  assert.equal(result.files[0]?.topMatch?.marker, "def");
}));

test("a candidate's assessment is independent of the display limit", () => fixture({
  "src/needle.ts": "export function needle() {}\n",
  "src/caller.ts": "needle();\n",
}, async (cwd) => {
  const one = await search(cwd, { query: "needle", max_files: 1, intent: "definition" });
  const many = await search(cwd, { query: "needle", max_files: 10, intent: "definition" });
  assert.deepEqual(one.files[0], many.files[0]);
  assert.equal(one.files[0]?.evidence?.competingCandidates, 0);
}));

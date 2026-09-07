import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension, { parseRipgrepJsonLines } from "../index.ts";
import { SearchRequest, RETRIEVAL_LIMITS, runRg } from "../src/retrieval.ts";
import type { SearchDetails as Details } from "../src/types.ts";

let registered: Pick<ToolDefinition, "execute"> | undefined;
const adapter: Pick<ExtensionAPI, "registerTool" | "registerCommand"> = {
  registerTool(tool) { registered = tool; }, registerCommand() {},
};
extension(adapter as ExtensionAPI);
const tool = registered!;
async function search(cwd: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Details> {
  const result = await tool.execute("retrieval-test", params, signal, undefined, { cwd } as ExtensionContext);
  return result.details as Details;
}
async function fixture(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "search-retrieval-"));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("output limits do not change ambiguous filename coverage", () => fixture(async (cwd) => {
  for (let i = 0; i < 6; i++) {
    await mkdir(join(cwd, String(i)));
    await writeFile(join(cwd, String(i), "widget.ts"), i === 5 ? "needle\n" : "other\n");
  }
  const results = [];
  for (const max_files of [1, 5, 10]) results.push(await search(cwd, { query: "needle", path: "widget.ts", max_files }));
  for (const result of results) {
    assert.equal(result.files[0]?.path, "5/widget.ts");
    assert.equal(result.coverage.status, "complete");
    assert.deepEqual(result.coverage.completedRoots, results[0]!.coverage.completedRoots);
  }
}));

test("valid rg regex syntax is not rewritten; compile errors alone fall back", () => fixture(async (cwd) => {
  await writeFile(join(cwd, "target.ts"), "NEEDLE\nsig {\n");
  const valid = await search(cwd, { query: "(?i)needle", path: "target.ts" });
  assert.equal(valid.totalMatches, 1);
  assert.equal(valid.literalFallback, false);
  assert.equal(valid.coverage.status, "complete");
  const invalid = await search(cwd, { query: "sig {", path: "target.ts" });
  assert.equal(invalid.totalMatches, 1);
  assert.equal(invalid.literalFallback, true);
}));

test("Rust regex fixtures agree with direct rg and the public decoder", () => fixture(async (cwd) => {
  await writeFile(join(cwd, "target.ts"), "NEEDLE\nαβ\n");
  for (const query of ["(?m)^NEEDLE$", "\\p{Greek}+", "(?P<name>NEEDLE)", "(?i:needle)"]) {
    const raw = execFileSync("rg", ["--json", "--smart-case", "-e", query, "--", "target.ts"], { cwd, encoding: "utf8" });
    const direct = parseRipgrepJsonLines(raw);
    const result = await search(cwd, { query, path: "target.ts" });
    assert.equal(result.totalMatches, direct.length);
    assert.equal(result.literalFallback, false);
    assert.equal(result.coverage.status, "complete");
  }
}));

test("completed searches leave no abort listeners", () => fixture(async (cwd) => {
  await writeFile(join(cwd, "target.ts"), "needle\n");
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, "abort").length;
  for (let i = 0; i < 12; i++) await search(cwd, { query: "needle", path: "target.ts" }, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, before);
}));

test("high-hit single file keeps counts while bounding snippet retention", () => fixture(async (cwd) => {
  await writeFile(join(cwd, "target.ts"), "needle();\n".repeat(50_000));
  const result = await search(cwd, { query: "needle", path: "target.ts" });
  assert.equal(result.totalMatches, 50_000);
  assert.equal(result.files[0]?.matchCount, 50_000);
  assert.equal(result.coverage.status, "complete");
  assert.ok(result.coverage.retainedMatches <= 32);
  assert.ok(result.coverage.omittedMatches >= 49_968);
}));

test("unresolved relationships make related coverage partial", () => fixture(async (cwd) => {
  await writeFile(join(cwd, "target.ts"), "import { needle } from './missing';\nneedle();\n");
  const result = await search(cwd, { query: "needle", path: "target.ts", expand_related: true });
  assert.equal(result.coverage.status, "partial");
  assert.ok(result.coverage.reasons.some((reason) => reason.includes("missing")));
}));

test("late candidates and file 200 retain recall in both traversal orders", () => fixture(async (cwd) => {
  await mkdir(join(cwd, "src"));
  for (let i = 1; i <= 205; i++) {
    await writeFile(join(cwd, "src", `${String(i).padStart(3, "0")}.ts`), i === 200 ? "const cached = needle();\nneedle();\n" : "needle();\n");
  }
  await writeFile(join(cwd, "src/zzz-needle.ts"), "export function needle() {}\n");
  const previous = process.env.RIPGREP_CONFIG_PATH;
  try {
    for (const ordering of ["--sort=path", "--sortr=path"]) {
      const config = join(cwd, "rg-config");
      await writeFile(config, `${ordering}\n`);
      process.env.RIPGREP_CONFIG_PATH = config;
      const result = await search(cwd, { query: "needle", max_files: 10 });
      assert.equal(result.totalFiles, 206);
      assert.equal(result.totalMatches, 207);
      assert.equal(result.files[0]?.path, "src/zzz-needle.ts");
      assert.equal(result.files.find((file) => file.path === "src/200.ts")?.matchCount, 2);
      assert.equal(result.coverage.status, "complete");
    }
  } finally {
    if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previous;
  }
}));

test("candidate and event budgets preserve termination reasons", () => fixture(async (cwd) => {
  for (const name of ["a.ts", "b.ts", "c.ts"]) await writeFile(join(cwd, name), "needle\n");
  const request = new SearchRequest(undefined, 30_000, { ...RETRIEVAL_LIMITS, candidates: 2 });
  try {
    const result = await runRg(["--json", "--sort=path", "needle", "."], cwd, ["."], request);
    assert.equal(result.status, "partial");
    assert.match(result.reason!, /candidate budget/);
    assert.equal(request.files.size, 2);
    const unvisited = await runRg(["--json", "needle", "c.ts"], cwd, ["c.ts"], request);
    assert.equal(unvisited.status, "partial");
    assert.equal(unvisited.signal, null);
  } finally { request.dispose(); }
  const smallEvent = new SearchRequest(undefined, 30_000, { ...RETRIEVAL_LIMITS, eventBytes: 32 });
  try {
    const result = await runRg(["--json", "needle", "."], cwd, ["."], smallEvent);
    assert.equal(result.status, "partial");
    assert.match(result.reason!, /event byte budget/);
  } finally { smallEvent.dispose(); }
}));

test("a 60-import file obeys the traversal cap and identifies skipped edges", () => fixture(async (cwd) => {
  const imports: string[] = [];
  for (let i = 0; i < 60; i++) {
    imports.push(`import './dependency-${i}';`);
    await writeFile(join(cwd, `dependency-${i}.ts`), "export const needle = 1;\n");
  }
  await writeFile(join(cwd, "target.ts"), imports.join("\n"));
  const result = await search(cwd, { query: "needle", path: "target.ts", expand_related: true });
  assert.equal(result.related?.roots.length, 50);
  assert.equal(result.coverage.status, "partial");
  assert.ok(result.related?.skipped?.some((reason) => reason.includes("dependency-59")));
}));

test("omission counts survive the bounded diagnostic list", () => fixture(async (cwd) => {
  const imports: string[] = [];
  for (let index = 0; index < 600; index++) {
    imports.push(`import './dependency-${index}';`);
    await writeFile(join(cwd, `dependency-${index}.ts`), "export const needle = 1;\n");
  }
  await writeFile(join(cwd, "target.ts"), imports.join("\n"));
  const result = await search(cwd, { query: "needle", path: "target.ts", expand_related: true });
  assert.equal(result.related?.roots.length, 50);
  assert.equal(result.coverage.omittedRelatedCandidates, 550);
  assert.equal(result.coverage.status, "partial");
}));

test("one request deadline terminates a child and releases its listener", () => fixture(async (cwd) => {
  await mkdir(join(cwd, "bin"));
  const executable = join(cwd, "bin", "rg");
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  await chmod(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${join(cwd, "bin")}:${previous}`;
  const request = new SearchRequest(undefined, 20);
  try {
    const result = await runRg([], cwd, ["."], request);
    assert.equal(result.status, "partial");
    assert.match(result.reason!, /deadline/);
    assert.equal(getEventListeners(request.signal, "abort").length, 0);
  } finally { request.dispose(); process.env.PATH = previous; }
}));

test("pre-cancellation reports unvisited roots without completing a miss", () => fixture(async (cwd) => {
  await writeFile(join(cwd, "target.ts"), "needle\n");
  const controller = new AbortController();
  controller.abort();
  const result = await search(cwd, { query: "needle", path: "target.ts" }, controller.signal);
  assert.equal(result.coverage.status, "partial");
  assert.deepEqual(result.coverage.completedRoots, []);
  assert.deepEqual(result.coverage.unvisitedRoots, ["target.ts"]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
}));

test("unexpected rg termination is never a complete miss", () => fixture(async (cwd) => {
  await writeFile(join(cwd, "target.ts"), "needle\n");
  await mkdir(join(cwd, "bin"));
  const executable = join(cwd, "bin", "rg");
  await writeFile(executable, `#!${process.execPath}\nprocess.kill(process.pid, 'SIGTERM');\n`);
  await chmod(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${join(cwd, "bin")}:${previous}`;
  try {
    const result = await search(cwd, { query: "needle", path: "target.ts" });
    assert.equal(result.coverage.status, "failed");
    assert.equal(result.literalFallback, false);
    assert.deepEqual(result.coverage.completedRoots, []);
  } finally { process.env.PATH = previous; }
}));

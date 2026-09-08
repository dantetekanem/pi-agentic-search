import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { SearchRequest, runRg } from "../src/retrieval.ts";
import type { SearchDetails } from "../src/types.ts";

let registered: Pick<ToolDefinition, "execute"> | undefined;
const adapter: Pick<ExtensionAPI, "registerTool" | "registerCommand"> = {
  registerTool(tool) { registered = tool; }, registerCommand() {},
};
extension(adapter as ExtensionAPI);
async function search(cwd: string, params: Record<string, unknown>, signal?: AbortSignal) {
  assert.ok(registered);
  return (await registered.execute("execution-test", params, signal, undefined, { cwd } as ExtensionContext)).details as SearchDetails;
}
async function fixture(files: Record<string, string>, run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "search-execution-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), source);
    }
    await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("renamed imports lead to the implementation, not just the caller", () => fixture({
  "main.ts": "import { original as run } from './impl';\nrun();\n",
  "impl.ts": "export function original() {}\n",
}, async (cwd) => {
  const result = await search(cwd, { query: "run", path: "main.ts", intent: "definition", expand_related: true });
  assert.equal(result.files[0]?.path, "impl.ts");
  assert.equal(result.files[0]?.evidence?.definitionCount, 1);
  assert.equal(result.coverage.status, "complete");
  assert.equal(result.totalMatches, 3);
}));

test("lookup by an imported name follows a renamed re-export", () => fixture({
  "main.ts": "import { original as run } from './barrel';\nrun();\n",
  "barrel.ts": "export { implementation as original } from './impl';\n",
  "impl.ts": "export function implementation() {}\n",
}, async (cwd) => {
  const result = await search(cwd, { query: "original", path: "main.ts", intent: "definition", expand_related: true });
  assert.equal(result.files[0]?.path, "impl.ts");
  assert.equal(result.files[0]?.evidence?.definitionCount, 1);
}));

test("alias replacement preserves smart-case matches and counts each line once", () => fixture({
  "main.ts": "import { Original as run } from './impl';\nrun();\n",
  "impl.ts": "export function Original() {} // RUN\nRUN();\n",
}, async (cwd) => {
  const result = await search(cwd, { query: "run", path: "main.ts", intent: "definition", expand_related: true });
  assert.equal(result.files[0]?.path, "impl.ts");
  assert.equal(result.files[0]?.evidence?.definitionCount, 1);
  assert.equal(result.files[0]?.matchCount, 2);
  assert.equal(result.totalMatches, 4);
}));

test("explicit case sensitivity wins over an rg configuration", () => fixture({
  "main.ts": "RUN();\nrun();\n", "rg.conf": "--ignore-case\n",
}, async (cwd) => {
  const previous = process.env.RIPGREP_CONFIG_PATH;
  process.env.RIPGREP_CONFIG_PATH = join(cwd, "rg.conf");
  try {
    const result = await search(cwd, { query: "run", path: "main.ts", case_sensitive: true });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.files[0]?.topMatch?.lineNumber, 2);
  } finally {
    if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previous;
  }
}));

test("the target is searched before related file discovery", () => fixture({
  "main.ts": "import { needle } from './impl';\nneedle();\n",
  "impl.ts": "export function needle() {}\n",
}, async (cwd) => {
  const result = await search(cwd, { query: "needle", path: "main.ts", intent: "definition", expand_related: true });
  assert.deepEqual(result.coverage.runs[0]?.roots, ["main.ts"]);
  assert.equal(result.coverage.runs[0]?.stage, "target");
}));

const packageFiles: Record<string, string> = { "package.json": '{"name":"fixture"}' };
for (let i = 0; i < 5; i++) {
  packageFiles[`node_modules/pkg-${i}/package.json`] = JSON.stringify({ name: `pkg-${i}`, main: "index.js" });
  packageFiles[`node_modules/pkg-${i}/index.js`] = "exports.needle = function needle() {};\n";
}
packageFiles["main.ts"] = Array.from({ length: 5 }, (_, i) => `import { needle as needle${i} } from 'pkg-${i}';\nneedle${i}();`).join("\n");
test("package entries precede bounded concurrent searches and cancellation stops queued work", () => fixture(packageFiles, async (cwd) => {
  const childProcess: typeof import("node:child_process") = createRequire(import.meta.url)("node:child_process");
  const original = childProcess.spawn;
  let active = 0;
  let peak = 0;
  let started = 0;
  let cancel: AbortController | undefined;
  childProcess.spawn = ((...args: Parameters<typeof original>) => {
    const child = Reflect.apply(original, childProcess, args);
    const commandArgs = args[1];
    const options = args[2];
    if (Array.isArray(commandArgs) && commandArgs.at(-1) === "." && String(options?.cwd).includes("node_modules/pkg-")) {
      peak = Math.max(peak, ++active);
      const controller = cancel;
      if (++started === 3 && controller) queueMicrotask(() => controller.abort());
      child.once("close", () => active--);
    }
    return child;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const result = await search(cwd, { query: "needle", path: "main.ts", intent: "references", expand_related: true });
    const stages = result.coverage.runs.map((run) => run.stage);
    assert.ok(stages.indexOf("entry") >= 0 && stages.indexOf("entry") < stages.indexOf("package"));
    assert.ok(peak >= 2 && peak <= 3, `observed ${peak} concurrent package searches`);
    assert.equal(active, 0);
    started = 0;
    cancel = new AbortController();
    const cancelled = await search(cwd, { query: "needle", path: "main.ts", intent: "references", expand_related: true }, cancel.signal);
    assert.equal(cancelled.coverage.status, "partial");
    assert.equal(started, 3);
    assert.equal(active, 0);
    assert.equal(getEventListeners(cancel.signal, "abort").length, 0);
    assert.ok(cancelled.coverage.unvisitedRoots.some((root) => root.includes("pkg-4")));
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
}));

test("a failed alias replacement preserves previous complete results", () => fixture({ "target.ts": "needle();\n" }, async (cwd) => {
  const request = new SearchRequest();
  try {
    await runRg(["--json", "needle", "target.ts"], cwd, ["target.ts"], request);
    const previous = request.files.get("target.ts");
    const retained = request.retainedBytes;
    assert.ok(previous?.complete);
    await request.replaceFile("target.ts", () => runRg(["\0"], cwd, ["target.ts"], request));
    assert.equal(request.files.get("target.ts"), previous);
    assert.equal(request.retainedBytes, retained);
    await assert.rejects(request.replaceFile("target.ts", async () => { throw new Error("replacement failed"); }));
    assert.equal(request.files.get("target.ts"), previous);
    assert.equal(request.totalMatches, 1);
  } finally { request.dispose(); }
}));

test("a deadline checkpoint works before the timer callback can run", () => {
  const request = new SearchRequest(undefined, 0);
  try {
    assert.equal(request.checkpoint(), false);
    assert.equal(request.signal.aborted, true);
  } finally { request.dispose(); }
});

test("subprocess argument errors are structured failures", async () => {
  const request = new SearchRequest();
  try {
    const run = await runRg(["\0"], process.cwd(), ["."], request);
    assert.equal(run.status, "failed");
    assert.ok(run.error);
    assert.equal(request.runs.length, 1);
  } finally { request.dispose(); }
});

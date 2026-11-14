import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { scanSparsity, type ScanResult } from "../src/sparsity-scan.ts";

async function scanChange(before: Record<string, string>, after: Record<string, string | null>): Promise<ScanResult> {
  const cwd = await mkdtemp(join(tmpdir(), "sparsity-dangling-"));
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const write = async (files: Record<string, string | null>) => {
    for (const [path, source] of Object.entries(files)) {
      if (source === null) await rm(join(cwd, path));
      else {
        await mkdir(dirname(join(cwd, path)), { recursive: true });
        await writeFile(join(cwd, path), source);
      }
    }
  };
  try {
    await write(before);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    await write(after);
    return await scanSparsity({
      cwd, diff: "worktree", maxDepth: 1, vicinity: 3, maxNodes: 30, maxAnchors: 20,
      budgetMs: 30_000, outputDir: join(cwd, ".pack"), inlineBudgetBytes: 40_000,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const rubyMethod = (owner: string, method = "process_tasks", singleton = false) =>
  `class ${owner}\n  def ${singleton ? "self." : ""}${method}\n    true\n  end\nend\n`;

for (const method of ["run", "process_tasks"]) {
  test(`Ruby removal retains ${method} callers despite unrelated and singleton namesakes`, async () => {
    const before = rubyMethod("A", method) + rubyMethod("B", method) + rubyMethod("A", method, true);
    const result = await scanChange({
      "component.yml": "name: app\n", "workers.rb": before,
      "caller.rb": `def dispatch_work(worker)\n  worker.${method}\nend\n`,
    }, { "workers.rb": rubyMethod("B", method) + rubyMethod("A", method, true) });
    const removed = result.dangling.find((item) => item.name === method);
    assert.ok(removed, "the removed instance method is assessed, even for a common name");
    assert.equal(removed.stillDefined, false, "neither B's instance method nor A's singleton is A's instance method");
    assert.equal(removed.symbol, `A#${method}`);
    const caller = removed.callers.find((item) => item.path === "caller.rb");
    assert.ok(caller);
    assert.equal(caller.resolution, "static_candidate");
    assert.match(result.sections.find((section) => section.id === "dangling")!.body, /static_candidate/);
  });
}

test("a deleted file searches its own component even when another component sorts first", async () => {
  const result = await scanChange({
    "a/package.json": '{"name":"other"}\n',
    "a/changed.ts": "export function visibleChange() { return 1; }\n",
    "a/caller.rb": "def unrelated_caller\n  worker.process_tasks\nend\n",
    "z/component.yml": "name: removed-owner\n",
    "z/worker.rb": rubyMethod("RemovedWorker"),
    "z/caller.rb": "def surviving_caller\n  worker.process_tasks\nend\n",
  }, { "a/changed.ts": "export function visibleChange() { return 2; }\n", "z/worker.rb": null });
  const removed = result.dangling.find((item) => item.name === "process_tasks");
  assert.ok(removed);
  assert.equal(removed.stillDefined, false);
  assert.equal(removed.root, "z");
  assert.deepEqual(removed.callers.map((caller) => caller.path), ["z/caller.rb"]);
  assert.ok(result.roots.includes("z"));
});

test("a reopened Ruby owner can genuinely retain the removed method in another file", async () => {
  const result = await scanChange({
    "component.yml": "name: app\n", "old.rb": rubyMethod("Worker"),
    "reopened.rb": rubyMethod("Other") + rubyMethod("Worker"),
  }, { "old.rb": null });
  assert.equal(result.dangling.find((item) => item.name === "process_tasks")?.stillDefined, true);
});

test("editing a Ruby method signature preserves its definition status", async () => {
  const before = rubyMethod("Worker");
  const result = await scanChange({ "worker.rb": before }, {
    "worker.rb": before.replace("def process_tasks", "def process_tasks(batch)"),
  });
  assert.equal(result.dangling.find((item) => item.name === "process_tasks")?.stillDefined, true);
});

test("JavaScript definitions require the original file and owner, not a module namesake", async () => {
  const before = "export class A {\n  process_tasks() {\n    return 1;\n  }\n}\n";
  const result = await scanChange({
    "package.json": '{"name":"app"}\n', "worker.ts": before,
    "other.ts": before,
    "caller.ts": "export function dispatchWork(worker: any) {\n  return worker.process_tasks();\n}\n",
  }, { "worker.ts": before.replace("class A", "class B").replace("process_tasks()", "process_tasks(batch: unknown)") });
  const removed = result.dangling.find((item) => item.name === "process_tasks");
  assert.ok(removed);
  assert.equal(removed.stillDefined, false);
  assert.equal(removed.symbol, "A.process_tasks");
  assert.ok(removed.callers.some((caller) => caller.path === "caller.ts"));
});

test("a JavaScript signature edit retains the original definition", async () => {
  const result = await scanChange({
    "worker.ts": "export function processTasks() {\n  return true;\n}\n",
  }, { "worker.ts": "export function processTasks(batch: unknown) {\n  return true;\n}\n" });
  assert.equal(result.dangling.find((item) => item.name === "processTasks")?.stillDefined, true);
});

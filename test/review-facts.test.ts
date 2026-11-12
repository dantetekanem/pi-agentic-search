import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { scanSparsity, type ScanOptions } from "../src/sparsity-scan.ts";

interface Repo {
  cwd: string;
  git: (...args: string[]) => string;
  write: (files: Record<string, string>) => Promise<void>;
  scan: (diff: string, options?: Partial<ScanOptions>) => ReturnType<typeof scanSparsity>;
}

async function repo(run: (repo: Repo) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "review-facts-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", timeout: 20_000 });
  const write = async (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), content);
    }
  };
  let packs = 0;
  const scan = (diff: string, options: Partial<ScanOptions> = {}) => scanSparsity({
    cwd, diff, maxDepth: 2, vicinity: 5, maxNodes: 60, maxAnchors: 40, budgetMs: 30_000,
    outputDir: join(root, `pack-${++packs}`), inlineBudgetBytes: 40 * 1024, ...options,
  });
  try {
    git("init", "-q", "-b", "main");
    await run({ cwd, git, write, scan });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const padding = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join("\n");

test("a range scanned from a later, edited checkout reads references at the range head", () => repo(async ({ git, write, scan }) => {
  await write({
    "package.json": '{"name":"fixture"}\n',
    "src/total.ts": "export function total() {\n  return 1;\n}\n\nexport function twice() {\n  return total() * 2;\n}\n",
    "src/use.ts": 'import { total } from "./total";\n\nexport function use() {\n  return total();\n}\n',
    "app/cart.rb": "class Cart\n  def subtotal\n    1\n  end\n\n  def doubled\n    subtotal * 2\n  end\nend\n",
  });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({
    "src/total.ts": "export function total() {\n  return 2;\n}\n\nexport function twice() {\n  return total() * 2;\n}\n",
    "app/cart.rb": "class Cart\n  def subtotal\n    2\n  end\n\n  def doubled\n    subtotal * 2\n  end\nend\n",
  });
  git("commit", "-qam", "change");
  // Later history moves every line of both files far below the range head's last line.
  await write({
    "src/total.ts": `${padding(30, "export const pad = ")}\n\nexport function total() {\n  return 3;\n}\n\nexport function twice() {\n  return total() * 2;\n}\n`,
    "app/cart.rb": `class Cart\n${padding(30, "  # note ")}\n  def subtotal\n    3\n  end\n\n  def doubled\n    subtotal * 2\n  end\nend\n`,
  });
  git("commit", "-qam", "later");
  // Uncommitted edits add callers that the range head does not have.
  await write({
    "src/total.ts": `${padding(30, "export const pad = ")}\n\nexport function total() {\n  return 3;\n}\n\nexport function twice() {\n  return total() * 2;\n}\n\nexport function thrice() {\n  return total() * 3;\n}\n`,
    "app/cart.rb": `class Cart\n${padding(30, "  # note ")}\n  def subtotal\n    3\n  end\n\n  def doubled\n    subtotal * 2\n  end\n\n  def tripled\n    subtotal * 3\n  end\nend\n`,
  });

  const result = await scan("HEAD~2..HEAD~1");
  const total = result.anchors.find((anchor) => anchor.symbol === "total");
  assert.ok(total, `anchors: ${result.anchors.map((anchor) => anchor.symbol).join(", ")}`);
  assert.deepEqual(total.callers.map((caller) => [caller.symbol, caller.path, caller.line, caller.text]).sort(), [
    ["twice", "src/total.ts", 6, "return total() * 2;"],
    ["use", "src/use.ts", 4, "return total();"],
  ], "the caller inside the changed file is read at the range head, not at the checkout's line");

  const subtotal = result.anchors.find((anchor) => anchor.symbol === "Cart#subtotal");
  assert.ok(subtotal);
  assert.deepEqual(subtotal.callers.map((caller) => [caller.symbol, caller.line, caller.text]), [["Cart#doubled", 7, "subtotal * 2"]]);
  assert.ok(!result.nodes.some((node) => node.symbol === "thrice" || node.symbol === "Cart#tripled"), "callers that only the checkout has are not reported");
}));

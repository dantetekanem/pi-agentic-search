import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectSparsity, formatSparsity } from "../src/sparsity.ts";
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

test("anchors say whether the base defined them, which lines changed only whitespace, and whether parameters changed", () => repo(async ({ git, write, scan }) => {
  await write({
    "package.json": '{"name":"fixture"}\n',
    "app/models/order.rb": `class Order
  def total(items)
    items.sum
  end

  def label
    if paid?
      "paid"
    end
  end

  def legacy_discount
    0
  end

  scope :recent, ->(days) { where(days: days) }
end
`,
    "src/price.ts": `export function price(amount: number) {
  return amount;
}

export function fee(amount: number) {
  return amount * 0.1;
}
`,
  });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({
    "app/models/order.rb": `class Order
  def total(items, tax)
    items.sum + tax
  end

  def label
    if paid?
        "paid"
    end
  end

  def round_money(value)
    value.round(2)
  end

  scope :recent, ->(days, limit) { where(days: days).limit(limit) }
end
`,
    "src/price.ts": `export function price(amount: number, currency: string) {
  return amount;
}

export function fee(amount: number) {
    return amount * 0.1;
}

export function discount(amount: number) {
  return amount * 0.2;
}
`,
  });
  git("commit", "-qam", "change");

  const result = await scan("HEAD~1..HEAD");
  const facts = (symbol: string) => {
    const anchor = result.anchors.find((item) => item.symbol === symbol);
    assert.ok(anchor, `${symbol} in ${result.anchors.map((item) => item.symbol).join(", ")}`);
    return { status: anchor.status, whitespaceOnly: anchor.whitespaceOnly, signatureChanged: anchor.signatureChanged };
  };
  assert.deepEqual(facts("Order#total"), { status: "modified", whitespaceOnly: [], signatureChanged: true });
  assert.deepEqual(facts("Order#label"), { status: "modified", whitespaceOnly: [8], signatureChanged: false });
  assert.deepEqual(facts("Order#round_money"), { status: "added", whitespaceOnly: [], signatureChanged: false }, "a new definition is added even when git pairs its lines with a removed one");
  assert.deepEqual(facts("Order scope :recent"), { status: "modified", whitespaceOnly: [], signatureChanged: true }, "a scope lambda's parameters are its signature");
  assert.deepEqual(facts("price"), { status: "modified", whitespaceOnly: [], signatureChanged: true });
  // git diff pairs fee's closing brace with the inserted function; git diff -w does not, so both lines drop out.
  assert.deepEqual(facts("fee"), { status: "modified", whitespaceOnly: [6, 7], signatureChanged: false });
  assert.deepEqual(facts("discount"), { status: "added", whitespaceOnly: [], signatureChanged: false });
  assert.match(await readFile(result.packPath, "utf8"), /base: modified; parameters changed/);

  // Uncommitted and untracked work compares with HEAD; explicit anchors have no base to compare with.
  await write({ "src/price.ts": "export function price(amount: number, currency: string) {\n  return amount + 1;\n}\n", "src/new.ts": "export function fresh() {\n  return 1;\n}\n" });
  const worktree = await scan("worktree");
  assert.deepEqual(["price", "fresh"].map((symbol) => worktree.anchors.find((item) => item.symbol === symbol)?.status), ["modified", "added"]);
  assert.deepEqual(worktree.anchors.find((item) => item.symbol === "fresh")?.whitespaceOnly, []);
  const explicit = await scan("", { anchors: ["src/price.ts:2"] });
  assert.deepEqual([explicit.anchors[0]?.status, explicit.anchors[0]?.whitespaceOnly, explicit.anchors[0]?.signatureChanged], [undefined, undefined, undefined]);
}));

test("unresolved edges say why, and coverage counts them by reason", () => repo(async ({ cwd, git, write, scan }) => {
  await write({
    "package.json": '{"name":"fixture"}\n',
    "app/models/billing/invoice.rb": "module Billing\n  class Invoice\n    def total(amount)\n      amount\n    end\n  end\nend\n",
    "src/gone.ts": "export function useGone(input: any) {\n  return input;\n}\n",
  });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({
    "app/models/billing/invoice.rb": `module Billing
  class Invoice
    def total(amount, name)
      sum = amount + 1
      region = @cart.region
      public_send(name)
      Billing::Ghost.run_it
      sum
    end

    #: (Money) -> Money
    def add(money)
      money + 1
    end
  end
end
`,
    "app/models/money.rb": "class Money\nend\n",
    "src/gone.ts": `import { gone } from "./missing";

export function useGone(input: any) {
  input.doThing();
  return gone();
}
`,
  });
  git("commit", "-qam", "change");

  const expected = {
    "amount.+": "operator",
    "money.+": "operator",
    "@cart.region": "unknown-receiver",
    "public_send(...)": "dynamic",
    "Billing::Ghost": "no-definition",
    "Billing::Ghost.run_it": "no-definition",
    "input.doThing": "unknown-receiver",
    gone: "no-definition",
  };
  const result = await scan("HEAD~1..HEAD");
  const reasons = Object.fromEntries(result.edges.filter((edge) => edge.resolution === "unresolved").map((edge) => [edge.name, edge.reason]));
  assert.deepEqual(reasons, expected);
  assert.ok(result.edges.every((edge) => (edge.resolution === "unresolved") === (edge.reason !== undefined)), "only unresolved edges carry a reason");
  assert.deepEqual(result.coverage.unresolvedByReason, { operator: 2, "unknown-receiver": 2, dynamic: 1, "no-definition": 3 });
  assert.match(result.inline, /unresolved edges \(8; 3 no-definition, 2 operator, 2 unknown-receiver, 1 dynamic\):\n  - `[^`]+` ×1 from n\d+:\d+ \[[a-z-]+\]/);

  // With a Ruby index a typed receiver is looked up first; an operator it lacks is still an operator, and a missing receiver constant is external.
  const indexed = await scan("HEAD~1..HEAD", { indexCacheDir: join(cwd, "..", "index") });
  const { "Billing::Ghost.run_it": _external, ...indexedExpected } = expected;
  assert.deepEqual(Object.fromEntries(indexed.edges.filter((edge) => edge.resolution === "unresolved").map((edge) => [edge.name, edge.reason])), indexedExpected);
  assert.equal(indexed.edges.find((edge) => edge.name === "Billing::Ghost.run_it")?.resolution, "external");
  assert.match(indexed.edges.find((edge) => edge.name === "money.+")?.note ?? "", /Money and its ancestors .* define no \+/, "the index looked the operator up on Money");

  const collected = await collectSparsity({ cwd, target: "app/models/billing/invoice.rb:4", maxDepth: 1, vicinity: 5, maxNodes: 10, callers: false, budgetMs: 20_000 });
  assert.deepEqual(collected.coverage.unresolvedByReason, { operator: 1, "unknown-receiver": 1, dynamic: 1, "no-definition": 2 });
  assert.match(formatSparsity(collected), /unresolved 5 \(2 no-definition, 1 dynamic, 1 operator, 1 unknown-receiver\)/);
}));

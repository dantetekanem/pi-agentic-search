import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { rubyAdapter } from "../src/adapters/ruby.ts";
import { tsAdapter } from "../src/adapters/ts.ts";
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
  const unresolvedReasons = (scanned: Awaited<ReturnType<Repo["scan"]>>) => Object.fromEntries(scanned.edges
    .filter((edge) => edge.resolution === "unresolved")
    .map((edge) => [edge.name, edge.reason]));

  const result = await scan("HEAD~1..HEAD");

  assert.deepEqual(unresolvedReasons(result), expected);
  assert.ok(result.edges.every((edge) => (edge.resolution === "unresolved") === (edge.reason !== undefined)), "only unresolved edges carry a reason");
  assert.deepEqual(result.coverage.unresolvedByReason, { operator: 2, "unknown-receiver": 2, dynamic: 1, "no-definition": 3 });
  assert.match(result.inline, /unresolved edges \(8; 3 no-definition, 2 operator, 2 unknown-receiver, 1 dynamic\):\n  - `[^`]+` ×1 from n\d+:\d+ \[[a-z-]+\]/);

  // With a Ruby index a typed receiver is looked up first; an operator it lacks is still an operator, and a missing receiver constant is external.
  const indexed = await scan("HEAD~1..HEAD", { indexCacheDir: join(cwd, "..", "index") });

  const { "Billing::Ghost.run_it": _external, ...indexedExpected } = expected;
  assert.deepEqual(unresolvedReasons(indexed), indexedExpected);
  assert.equal(indexed.edges.find((edge) => edge.name === "Billing::Ghost.run_it")?.resolution, "external");
  assert.match(indexed.edges.find((edge) => edge.name === "money.+")?.note ?? "", /Money and its ancestors .* define no \+/, "the index looked the operator up on Money");

  const collected = await collectSparsity({ cwd, target: "app/models/billing/invoice.rb:4", maxDepth: 1, vicinity: 5, maxNodes: 10, callers: false, budgetMs: 20_000 });
  assert.deepEqual(collected.coverage.unresolvedByReason, { operator: 1, "unknown-receiver": 1, dynamic: 1, "no-definition": 2 });
  assert.match(formatSparsity(collected), /unresolved 5 \(2 no-definition, 1 dynamic, 1 operator, 1 unknown-receiver\)/);
}));

test("files are classed by where they take effect, and load-time anchors say so", () => repo(async ({ git, write, scan }) => {
  await write({ "README.md": "fixture\n" });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({
    "package.json": '{"name":"fixture","dependencies":{"left-pad":"1.0.0"}}\n',
    "Gemfile": "source 'https://rubygems.org'\ngem 'rails'\n",
    "Gemfile.lock": "GEM\n  specs:\n    rails (8.0.0)\n",
    "db/migrate/20260101000000_add_total.rb": "class AddTotal < ActiveRecord::Migration[8.0]\n  def change\n    add_column :orders, :total, :integer\n  end\nend\n",
    "db/schema.rb": "ActiveRecord::Schema[8.0].define(version: 2026_01_01_000000) do\n  create_table :orders do |t|\n    t.integer :total\n  end\nend\n",
    "prisma/schema.prisma": "model Order {\n  id Int @id\n}\n",
    "config/settings.yml": "registration: true\n",
    "config/initializers/flags.rb": "Rails.application.config.x.checkout = true\n",
    "vite.config.ts": "export default { plugins: [] };\n",
    "app/models/order.rb": `class Order < ApplicationRecord
  TAX = 0.2
  has_many :items
  validates :total, presence: true
  scope :recent, -> { where(recent: true) }

  def total
    items.sum(:price) * (1 + TAX)
  end
end
`,
    "src/flags.ts": `export const LIMIT = 3;
export const ROUTES = { checkout: "/checkout" };

function registerPlugin(name: string) {
  return name;
}

registerPlugin("audit");

export function limited(count: number) {
  return count > LIMIT;
}
`,
  });
  git("add", ".");
  git("commit", "-qm", "change");

  const result = await scan("HEAD~1..HEAD");
  assert.deepEqual(Object.fromEntries(result.files.map((file) => [file.path, file.kind])), {
    "Gemfile": "dependency",
    "Gemfile.lock": "dependency",
    "app/models/order.rb": "code",
    "config/initializers/flags.rb": "config",
    "config/settings.yml": "config",
    "db/migrate/20260101000000_add_total.rb": "migration",
    "db/schema.rb": "schema",
    "package.json": "dependency",
    "prisma/schema.prisma": "schema",
    "src/flags.ts": "code",
    "vite.config.ts": "config",
  });
  assert.deepEqual(result.fileHunks.map((file) => [file.path, file.kind]).sort(), [
    ["Gemfile", "dependency"], ["Gemfile.lock", "dependency"], ["config/settings.yml", "config"],
    ["db/schema.rb", "schema"], ["package.json", "dependency"], ["prisma/schema.prisma", "schema"],
  ], "files without a parser, and schema dumps, keep hunk sections");
  assert.ok(result.anchors.some((anchor) => anchor.symbol === "AddTotal#change"), "a migration's definitions are still anchors");
  assert.ok(result.anchors.some((anchor) => anchor.path === "config/initializers/flags.rb"), "parsed configuration code is still anchored");

  const loadTime = Object.fromEntries(result.anchors.filter((anchor) => anchor.path === "app/models/order.rb" || anchor.path === "src/flags.ts").map((anchor) => [anchor.symbol, anchor.loadTime]));
  assert.deepEqual(loadTime, {
    "Order::TAX": true,
    "Order has_many :items": true,
    "Order validates :total": true,
    "Order scope :recent": undefined,
    "Order#total": undefined,
    LIMIT: true,
    ROUTES: true,
    'registerPlugin("audit")': true,
    registerPlugin: undefined,
    limited: undefined,
  });
  assert.equal(result.anchors.find((anchor) => anchor.path === "config/initializers/flags.rb")?.loadTime, true);
  assert.match(result.inline, /files 11 \(code 2, tests 0, generated 0, other 0, migration 1, config 3, dependency 3, schema 2\)/);
}));

const rubyGuards = `class Checkout
  def total(cart)
    return 0 unless Feature.enabled?(:checkout)
    if cart.empty?
      log_empty
    elsif cart.gift?
      wrap(cart)
    else
      charge(cart)
    end
    discount = cart.vip? ? vip_rate : base_rate
    cart.ready? && submit(cart)
    notify(cart) if cart.notify?
    cart.total
  end
end
`;

test("the Ruby adapter reports the conditions that dominate a line and a call site, as written", async () => {
  assert.equal(await rubyAdapter.ready(), true);
  const facts = rubyAdapter.parse("app/checkout.rb", rubyGuards)!;
  const def = facts.definitions.find((item) => item.symbol === "Checkout#total")!;
  const exit = { line: 3, text: "unless Feature.enabled?(:checkout)", branch: "after-return" };
  const at = (line: number) => rubyAdapter.guardsAt(facts, def, line);
  assert.deepEqual(at(3), [{ line: 3, text: "unless Feature.enabled?(:checkout)", branch: "then" }], "the early return runs on the guard's own branch");
  assert.deepEqual(at(4), [exit]);
  assert.deepEqual(at(5), [exit, { line: 4, text: "if cart.empty?", branch: "then" }]);
  assert.deepEqual(at(6), [exit, { line: 4, text: "if cart.empty?", branch: "else" }]);
  assert.deepEqual(at(7), [exit, { line: 4, text: "if cart.empty?", branch: "else" }, { line: 6, text: "elsif cart.gift?", branch: "then" }]);
  assert.deepEqual(at(9), [exit, { line: 4, text: "if cart.empty?", branch: "else" }, { line: 6, text: "elsif cart.gift?", branch: "else" }]);
  assert.deepEqual(at(11), [exit], "a line that starts outside the ternary is only behind the early return");
  assert.deepEqual(at(13), [exit, { line: 13, text: "if cart.notify?", branch: "then" }]);
  assert.deepEqual(at(14), [exit]);
  assert.deepEqual(at(20), [], "lines outside the definition have no guards");

  const sites = rubyAdapter.calls(facts, def);
  const guardsOf = (name: string) => sites.find((site) => site.name === name)?.guards;
  assert.equal(guardsOf("enabled?"), undefined, "a condition is not behind itself");
  assert.deepEqual(guardsOf("empty?"), [exit]);
  assert.deepEqual(guardsOf("log_empty"), [exit, { line: 4, text: "if cart.empty?", branch: "then" }]);
  assert.deepEqual(guardsOf("vip_rate"), [exit, { line: 11, text: "cart.vip?", branch: "then" }]);
  assert.deepEqual(guardsOf("base_rate"), [exit, { line: 11, text: "cart.vip?", branch: "else" }]);
  assert.deepEqual(guardsOf("submit"), [exit, { line: 12, text: "cart.ready?", branch: "then" }]);
});

const tsGuards = `export function total(cart: Cart) {
  if (!isEnabled("checkout")) return 0;
  if (cart.empty) {
    logEmpty();
  } else if (cart.gift) {
    wrap(cart);
  } else {
    charge(cart);
  }
  const rate = cart.vip ? vipRate() : baseRate();
  cart.ready && submit(cart);
  return cart.total;
}
`;

test("the TypeScript adapter reports the conditions that dominate a line and a call site, as written", () => {
  const facts = tsAdapter.parse("src/total.ts", tsGuards, true)!;
  const def = facts.definitions.find((item) => item.symbol === "total")!;
  const exit = { line: 2, text: 'if (!isEnabled("checkout"))', branch: "after-return" };
  const at = (line: number) => tsAdapter.guardsAt(facts, def, line);
  assert.deepEqual(at(2), []);
  assert.deepEqual(at(3), [exit]);
  assert.deepEqual(at(4), [exit, { line: 3, text: "if (cart.empty)", branch: "then" }]);
  assert.deepEqual(at(5), [exit, { line: 3, text: "if (cart.empty)", branch: "else" }], "a leading brace and else are not the line's code");
  assert.deepEqual(at(6), [exit, { line: 3, text: "if (cart.empty)", branch: "else" }, { line: 5, text: "if (cart.gift)", branch: "then" }]);
  assert.deepEqual(at(8), [exit, { line: 3, text: "if (cart.empty)", branch: "else" }, { line: 5, text: "if (cart.gift)", branch: "else" }]);
  assert.deepEqual(at(10), [exit]);
  assert.deepEqual(at(12), [exit]);

  const sites = tsAdapter.calls(facts, def);
  const guardsOf = (name: string) => sites.find((site) => site.name === name)?.guards;
  assert.equal(guardsOf("isEnabled"), undefined);
  assert.deepEqual(guardsOf("logEmpty"), [exit, { line: 3, text: "if (cart.empty)", branch: "then" }]);
  assert.deepEqual(guardsOf("vipRate"), [exit, { line: 10, text: "cart.vip", branch: "then" }]);
  assert.deepEqual(guardsOf("baseRate"), [exit, { line: 10, text: "cart.vip", branch: "else" }]);
  assert.deepEqual(guardsOf("submit"), [exit, { line: 11, text: "cart.ready", branch: "then" }]);
});

test("scan anchors carry the guards of their changed lines, and call edges the guards of their call sites", () => repo(async ({ git, write, scan }) => {
  await write({
    "package.json": '{"name":"fixture"}\n',
    "app/checkout.rb": "class Checkout\n  def total(cart)\n    cart.total\n  end\n\n  def notify(cart)\n    cart\n  end\nend\n",
  });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({ "app/checkout.rb": "class Checkout\n  def total(cart)\n    return 0 unless Feature.enabled?(:checkout)\n    notify(cart) if cart.notify?\n    cart.total\n  end\n\n  def notify(cart)\n    cart\n  end\nend\n" });
  git("commit", "-qam", "gate");

  const result = await scan("HEAD~1..HEAD");
  const anchor = result.anchors.find((item) => item.symbol === "Checkout#total")!;
  const exit = { line: 3, text: "unless Feature.enabled?(:checkout)", branch: "after-return" };
  assert.deepEqual(anchor.guards, [
    { line: 3, guards: [{ line: 3, text: "unless Feature.enabled?(:checkout)", branch: "then" }] },
    { line: 4, guards: [exit, { line: 4, text: "if cart.notify?", branch: "then" }] },
  ]);
  const notify = result.edges.find((edge) => edge.from === anchor.id && edge.name === "notify");
  assert.deepEqual(notify?.guards, [exit, { line: 4, text: "if cart.notify?", branch: "then" }]);
  assert.deepEqual(result.anchors.find((item) => item.symbol === "Checkout#notify")?.guards ?? [], [], "an unchanged anchor or one without guards carries none");
}));

test("enqueues reach the job or mailer action, and writes, enqueues and cache calls are effects", () => repo(async ({ cwd, git, write, scan }) => {
  await write({
    "package.json": '{"name":"fixture"}\n',
    "app/jobs/receipt_job.rb": "class ReceiptJob < ApplicationJob\n  def perform(order_id)\n    Order.find(order_id)\n  end\nend\n",
    "app/mailers/order_mailer.rb": "class OrderMailer < ApplicationMailer\n  def confirmation(order)\n    mail(to: order.email)\n  end\nend\n",
    "app/models/checkout.rb": "class Checkout\n  def complete(order)\n    order.total\n  end\nend\n",
  });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({
    "app/models/checkout.rb": `class Checkout
  def complete(order)
    order.update!(status: :complete)
    ReceiptJob.perform_later(order.id)
    ReceiptJob.set(wait: 5.minutes).perform_later(order.id)
    OrderMailer.confirmation(order).deliver_later
    OrderMailer.with(order: order).confirmation.deliver_later
    Rails.cache.delete("orders/#{order.id}")
    order.total
  end
end
`,
  });
  git("commit", "-qam", "complete");

  for (const options of [{}, { indexCacheDir: join(cwd, "..", "index") }]) {
    const result = await scan("HEAD~1..HEAD", options);
    const anchor = result.anchors.find((item) => item.symbol === "Checkout#complete")!;
    const symbolOf = (id?: string) => result.nodes.find((node) => node.id === id)?.symbol;
    const enqueues = result.edges.filter((edge) => edge.from === anchor.id && edge.relationship === "enqueues").map((edge) => [edge.line, edge.name, symbolOf(edge.to), edge.resolution]);
    assert.deepEqual(enqueues, [
      [4, "ReceiptJob.perform_later", "ReceiptJob#perform", "exact"],
      [5, "ReceiptJob.set(...).perform_later", "ReceiptJob#perform", "exact"],
      [6, "OrderMailer.confirmation(...).deliver_later", "OrderMailer#confirmation", "exact"],
      [7, "OrderMailer.with(...).confirmation.deliver_later", "OrderMailer#confirmation", "exact"],
    ], JSON.stringify(options));
    assert.ok(result.edges.some((edge) => edge.from === anchor.id && edge.name === "ReceiptJob" && edge.relationship === "references"), "the constant reference stays");
    const effects = [
      { kind: "write", line: 3, text: "order.update!(status: :complete)" },
      { kind: "enqueue", line: 4, text: "ReceiptJob.perform_later(order.id)" },
      { kind: "enqueue", line: 5, text: "ReceiptJob.set(wait: 5.minutes).perform_later(order.id)" },
      { kind: "enqueue", line: 6, text: "OrderMailer.confirmation(order).deliver_later" },
      { kind: "enqueue", line: 7, text: "OrderMailer.with(order: order).confirmation.deliver_later" },
      { kind: "cache", line: 8, text: 'Rails.cache.delete("orders/#{order.id}")' },
    ];
    assert.deepEqual(anchor.effects, effects);
    assert.deepEqual(result.nodes.find((node) => node.id === anchor.id)?.effects, effects);
    assert.deepEqual(result.nodes.find((node) => node.symbol === "ReceiptJob#perform")?.effects, undefined, "a node without effects omits them");
  }
}));

test("anchors count their callers, say whether the list is complete, and give each call site's guards", () => repo(async ({ cwd, git, write, scan }) => {
  await write({
    "package.json": '{"name":"fixture"}\n',
    "app/services/pricing.rb": "class Pricing\n  def quote(cart)\n    cart.total\n  end\nend\n",
    "app/models/checkout.rb": `class Checkout
  def total(cart)
    pricing = Pricing.new
    return 0 unless Features.enabled?(:quotes)
    pricing.quote(cart)
    if cart.vip?
      pricing.quote(cart)
    end
  end
end
`,
    "app/services/charge.rb": "class Charge\n  def call(order)\n    order\n  end\nend\n",
    "app/services/shop.rb": "class Shop\n  def buy(order)\n    Charge.new.call(order)\n  end\n\n  def retry_later(order, callback)\n    callback.call(order)\n  end\nend\n",
    "app/services/other.rb": "class Other\n  def call\n    1\n  end\n\n  def run\n    Other.new.call\n  end\nend\n",
    "app/jobs/receipt_job.rb": "class ReceiptJob < ApplicationJob\n  def perform(id)\n    id\n  end\nend\n",
    "app/models/order.rb": "class Order\n  def complete\n    ReceiptJob.perform_later(id) if paid?\n  end\nend\n",
    "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["src"]}\n',
    "src/price.ts": "export function price(amount: number) {\n  return amount;\n}\n",
    "src/use.ts": 'import { price } from "./price";\n\nexport function charge(flag: boolean) {\n  if (flag) {\n    return price(1);\n  }\n  return 0;\n}\n',
  });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({
    "src/price.ts": "export function price(amount: number) {\n  return amount * 2;\n}\n",
    // A changed caller is in the TypeScript program, so the checker resolves its call.
    "src/use.ts": 'import { price } from "./price";\n\nexport function charge(flag: boolean) {\n  if (flag) {\n    return price(1);\n  }\n  return -1;\n}\n',
    "app/services/pricing.rb": "class Pricing\n  def quote(cart)\n    cart.total * 2\n  end\nend\n",
    "app/services/charge.rb": "class Charge\n  def call(order)\n    order.id\n  end\nend\n",
    "app/jobs/receipt_job.rb": "class ReceiptJob < ApplicationJob\n  def perform(id)\n    id.to_s\n  end\nend\n",
  });
  git("commit", "-qam", "change");

  type Scanned = Awaited<ReturnType<Repo["scan"]>>;
  const anchorOf = (result: Scanned, symbol: string) => {
    const anchor = result.anchors.find((item) => item.symbol === symbol);
    assert.ok(anchor, `${symbol} in ${result.anchors.map((item) => item.symbol).join(", ")}`);
    return anchor;
  };
  const countOf = (result: Scanned, symbol: string) => anchorOf(result, symbol).callerCount;
  const callersOf = (result: Scanned, symbol: string) => anchorOf(result, symbol).callers.map((caller) => [caller.symbol, caller.line, caller.resolution, caller.guards]);
  const calledBy = (result: Scanned, symbol: string) => result.edges
    .filter((edge) => edge.to === anchorOf(result, symbol).id && edge.relationship === "called_by")
    .map((edge) => [edge.line, edge.resolution, edge.via, edge.guards, edge.note]);
  const exit = { line: 4, text: "unless Features.enabled?(:quotes)", branch: "after-return" };
  const vip = { line: 6, text: "if cart.vip?", branch: "then" };

  // Without the index, callers are found by name: one per file, and common names are not searched.
  const plain = await scan("HEAD~1..HEAD");
  assert.deepEqual(countOf(plain, "Pricing#quote"), { total: 2, shown: 1, complete: false }, "the per-file rule cut the second call site");
  assert.deepEqual(callersOf(plain, "Pricing#quote"), [["Checkout#total", 5, "static_candidate", [exit]]]);
  assert.deepEqual(calledBy(plain, "Pricing#quote"), [[5, "static_candidate", undefined, [exit], undefined]]);
  assert.deepEqual(countOf(plain, "Charge#call"), { total: 0, shown: 0, complete: false }, "a common name is not searched without an index");
  assert.deepEqual(countOf(plain, "ReceiptJob#perform"), { total: 0, shown: 0, complete: false });
  assert.deepEqual(countOf(plain, "price"), { total: 1, shown: 1, complete: true });
  assert.deepEqual(calledBy(plain, "price"), [[5, "exact", "checker", [{ line: 4, text: "if (flag)", branch: "then" }], undefined]], "the TypeScript checker resolves the call to the anchor");

  const all = await scan("HEAD~1..HEAD", { allCallers: true });
  assert.deepEqual(countOf(all, "Pricing#quote"), { total: 2, shown: 2, complete: true });
  assert.deepEqual(callersOf(all, "Pricing#quote"), [["Checkout#total", 5, "static_candidate", [exit]], ["Checkout#total", 7, "static_candidate", [exit, vip]]]);

  // With the index, a caller whose receiver type dispatches to the anchor is exact, and common names are filtered by receiver type.
  const indexCacheDir = join(cwd, "..", "index");
  const indexed = await scan("HEAD~1..HEAD", { indexCacheDir });
  assert.deepEqual(countOf(indexed, "Pricing#quote"), { total: 2, shown: 1, complete: false });
  assert.deepEqual(calledBy(indexed, "Pricing#quote"), [[5, "exact", "assigned", [exit], undefined]]);
  assert.deepEqual(countOf(indexed, "Charge#call"), { total: 1, shown: 1, complete: false }, "callback.call has no known receiver type, so the list may miss a caller; Other.new.call is another class's");
  assert.deepEqual(callersOf(indexed, "Charge#call"), [["Shop#buy", 3, "exact", []]]);
  assert.deepEqual(countOf(indexed, "ReceiptJob#perform"), { total: 1, shown: 1, complete: true }, "every perform call site has a known receiver type");
  assert.deepEqual(calledBy(indexed, "ReceiptJob#perform"), [[3, "exact", "constant", [{ line: 3, text: "if paid?", branch: "then" }], "enqueue"]], "an enqueue calls the job's perform");
  assert.equal(anchorOf(indexed, "ReceiptJob#perform").callers[0]?.text, "ReceiptJob.perform_later(id) if paid?");

  const indexedAll = await scan("HEAD~1..HEAD", { indexCacheDir, allCallers: true });
  assert.deepEqual(countOf(indexedAll, "Pricing#quote"), { total: 2, shown: 2, complete: true });
  assert.deepEqual(calledBy(indexedAll, "Pricing#quote"), [[5, "exact", "assigned", [exit], undefined], [7, "exact", "assigned", [exit, vip], undefined]]);
  assert.match(await readFile(indexedAll.packPath, "utf8"), /callers \(2 of 2, complete\):\n {2}- n\d+ Checkout#total app\/models\/checkout\.rb:5 \[exact, assigned\]/);
}));

test("a reference on the first line of a file with a byte order mark still counts", () => repo(async ({ cwd, write }) => {
  await write({
    "package.json": '{"name":"fixture"}\n',
    "src/total.ts": "export function total() {\n  return 1;\n}\n",
    "src/boot.ts": "\uFEFFtotal();\n",
  });

  const result = await collectSparsity({ cwd, target: "src/total.ts:1", maxDepth: 1, vicinity: 5, maxNodes: 10, callers: true, budgetMs: 20_000 });

  const callerPaths = result.edges.filter((edge) => edge.relationship === "called_by").map((edge) => result.nodes.find((node) => node.id === edge.from)?.path);
  assert.deepEqual(callerPaths, ["src/boot.ts"], "ripgrep drops the mark from the line it reports, so the served line is compared without it");
}));

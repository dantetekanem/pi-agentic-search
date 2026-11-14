import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { rubyAdapter } from "../src/adapters/ruby.ts";
import { readRoutes } from "../src/adapters/ruby-routes.ts";
import { tsAdapter } from "../src/adapters/ts.ts";
import { runSearch } from "../src/search.ts";
import { collectSparsity, declaresName, formatSparsity } from "../src/sparsity.ts";
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

test("a search for tests keeps to the anchor's language, though ripgrep's test globs override its file types", () => repo(async ({ git, write, scan }) => {
  await write({
    "package.json": '{"name":"fixture"}\n',
    "app/models/cart.rb": "class Cart\n  def total\n    1\n  end\nend\n",
    "test/models/cart_test.rb": 'require "test_helper"\n\nclass CartTest < ActiveSupport::TestCase\n  test "totals" do\n    assert_equal 1, Cart.new.total\n  end\nend\n',
    "src/cart.ts": "export function total() {\n  return 1;\n}\n",
    "src/cart.test.ts": 'import { total } from "./cart";\n\nit("totals", () => {\n  expect(total()).toBe(1);\n});\n',
  });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({ "app/models/cart.rb": "class Cart\n  def total\n    2\n  end\nend\n", "src/cart.ts": "export function total() {\n  return 2;\n}\n" });
  git("commit", "-qam", "change");

  const result = await scan("HEAD~1..HEAD");
  const testsOf = (symbol: string) => result.anchors.find((anchor) => anchor.symbol === symbol)?.tests.map((test) => test.path);
  assert.deepEqual(testsOf("Cart#total"), ["test/models/cart_test.rb"]);
  assert.deepEqual(testsOf("total"), ["src/cart.test.ts"]);
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

test("the routes reader lists the controller actions config/routes.rb draws, with verbs, paths and URL helpers", async () => {
  assert.equal(await rubyAdapter.ready(), true);
  const table = readRoutes(`Rails.application.routes.draw do
  root "pages#home"
  resources :orders, only: [:index, :create, :show] do
    member do
      post :pay
    end
    get :search, on: :collection
    resources :items, only: :index
  end
  resource :profile, only: [:show, :update]
  namespace :admin do
    resources :orders, only: :destroy
  end
  post "checkout", to: "checkout#create"
  get "status" => "health#show", as: :health
  mount Sidekiq::Web => "/sidekiq"
  draw :api
end
`);
  assert.ok(table);
  assert.deepEqual(table.routes.map((route) => `${route.verbs.join("|")} ${route.path} ${route.controller}#${route.action} ${route.helper ?? "-"} :${route.line}`), [
    "GET / pages#home root :2",
    "POST /orders/:id/pay orders#pay pay_order :5",
    "GET /orders/search orders#search search_orders :7",
    "GET /orders/:order_id/items items#index order_items :8",
    "GET /orders orders#index orders :3",
    "POST /orders orders#create orders :3",
    "GET /orders/:id orders#show order :3",
    "GET /profile profiles#show profile :10",
    "PATCH|PUT /profile profiles#update profile :10",
    "DELETE /admin/orders/:id admin/orders#destroy admin_order :12",
    "POST /checkout checkout#create checkout :14",
    "GET /status health#show health :15",
  ]);
  assert.deepEqual(table.unread, [{ line: 17, text: "draw :api" }], "a statement the reader does not interpret is listed; a mount routes no action");
  assert.equal(readRoutes("Rails.application.routes.draw do\n  get 'a' => \n"), undefined, "a file that does not parse has no table");
});

test("the Ruby adapter records which methods are private or protected", async () => {
  assert.equal(await rubyAdapter.ready(), true);
  const facts = rubyAdapter.parse("app/controllers/orders_controller.rb", `class OrdersController < ApplicationController
  def index; end
  private def secret; end
  def create; end

  protected

  def audit; end

  private

  def order_params; end
  public def show; end
  def helper; end
  public :helper

  class << self
    private

    def build; end
  end

  def self.find_order; end
end
`, true)!;
  const visibility = Object.fromEntries(facts.definitions.filter((def) => def.kind.endsWith("method")).map((def) => [def.symbol, def.visibility ?? "public"]));
  assert.deepEqual(visibility, {
    "OrdersController#index": "public",
    "OrdersController#secret": "private",
    "OrdersController#create": "public",
    "OrdersController#audit": "protected",
    "OrdersController#order_params": "private",
    "OrdersController#show": "public",
    "OrdersController#helper": "public",
    "OrdersController.build": "private",
    "OrdersController.find_order": "public",
  });
});

test("nodes and anchors that the framework calls say so: jobs, controller actions, and whether a route names them", () => repo(async ({ cwd, git, write, scan }) => {
  await write({
    "Gemfile": "source 'https://rubygems.org'\n",
    "app/controllers/application_controller.rb": "class ApplicationController < ActionController::Base\nend\n",
    "app/controllers/orders_controller.rb": `class OrdersController < ApplicationController
  def create
    Checkout.new.complete(order)
  end

  def preview
    order
  end

  private

  def order
    Order.find(params[:id])
  end
end
`,
    "app/controllers/carts_controller.rb": "class CartsController < ApplicationController\n  def show\n    Checkout.new.complete(cart)\n  end\nend\n",
    "app/jobs/application_job.rb": "class ApplicationJob < ActiveJob::Base\nend\n",
    "app/jobs/receipt_job.rb": "class ReceiptJob < ApplicationJob\n  def perform(id)\n    id\n  end\nend\n",
    "app/workers/sync_worker.rb": "class SyncWorker\n  include Sidekiq::Job\n\n  def perform\n    1\n  end\nend\n",
    "app/models/checkout.rb": "class Checkout\n  def complete(order)\n    order\n  end\nend\n",
    "config/routes.rb": "Rails.application.routes.draw do\n  resources :orders, only: :create\n  draw :admin\nend\n",
  });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({
    "app/controllers/orders_controller.rb": `class OrdersController < ApplicationController
  def create
    Checkout.new.complete(order) if order
  end

  def preview
    order.id
  end

  private

  def order
    Order.find_by(id: params[:id])
  end
end
`,
    "app/jobs/receipt_job.rb": "class ReceiptJob < ApplicationJob\n  def perform(id)\n    id.to_s\n  end\nend\n",
    "app/workers/sync_worker.rb": "class SyncWorker\n  include Sidekiq::Job\n\n  def perform\n    2\n  end\nend\n",
    "app/models/checkout.rb": "class Checkout\n  def complete(order)\n    ReceiptJob.perform_later(order.id)\n  end\nend\n",
  });
  git("commit", "-qam", "change");

  const result = await scan("HEAD~1..HEAD", { indexCacheDir: join(cwd, "..", "index") });
  const entries = Object.fromEntries(result.anchors.map((anchor) => [anchor.symbol, anchor.entry]));
  const routed = { kind: "controller", exact: true, routes: [{ verbs: ["POST"], path: "/orders", file: "config/routes.rb", line: 2, text: "resources :orders, only: :create" }] };
  assert.deepEqual(entries, {
    "OrdersController#create": routed,
    "OrdersController#preview": { kind: "controller", exact: false },
    "OrdersController#order": undefined,
    "ReceiptJob#perform": { kind: "job", exact: true },
    "SyncWorker#perform": { kind: "job", exact: true },
    "Checkout#complete": undefined,
  });
  const nodeEntry = (symbol: string) => result.nodes.find((node) => node.symbol === symbol)?.entry;
  assert.deepEqual(nodeEntry("CartsController#show"), { kind: "controller", exact: false }, "a caller that is not an anchor carries its entry too");
  assert.deepEqual(nodeEntry("OrdersController#create"), routed);
  assert.ok(result.coverage.notes.some((note) => /config\/routes\.rb: 1 statement not read \(draw :admin\)/.test(note)), result.coverage.notes.join("\n"));
  assert.match(result.inline, /entry: controller, routed by config\/routes\.rb/);

  const unindexed = await scan("HEAD~1..HEAD");
  assert.ok(unindexed.anchors.every((anchor) => anchor.entry === undefined) && unindexed.nodes.every((node) => node.entry === undefined), "without the index there is no entry registry");
}));

test("search for an entry point's tests also finds them by convention, by route and, for a job, by enqueue or perform", () => repo(async ({ cwd, write }) => {
  await write({
    "Gemfile": "source 'https://rubygems.org'\n",
    "app/controllers/application_controller.rb": "class ApplicationController < ActionController::Base\nend\n",
    "app/controllers/orders_controller.rb": "class OrdersController < ApplicationController\n  def create\n    ReceiptJob.perform_later(1)\n  end\n\n  def show\n  end\nend\n",
    "app/jobs/application_job.rb": "class ApplicationJob < ActiveJob::Base\nend\n",
    "app/jobs/receipt_job.rb": "class ReceiptJob < ApplicationJob\n  def perform(id)\n    id\n  end\nend\n",
    "app/models/checkout.rb": "class Checkout\n  def total\n    1\n  end\nend\n",
    "config/routes.rb": "Rails.application.routes.draw do\n  resources :orders, only: [:create, :show]\n  post \"checkout\", to: \"orders#create\"\nend\n",
    "test/controllers/orders_controller_test.rb": `require "test_helper"

class OrdersControllerTest < ActionDispatch::IntegrationTest
  test "creates" do
    post orders_url, params: { order: { id: 1 } }
  end

  test "shows" do
    get order_url(1)
  end
end
`,
    "test/integration/checkout_flow_test.rb": `require "test_helper"

class CheckoutFlowTest < ActionDispatch::IntegrationTest
  test "checks out" do
    post checkout_path
    post "/orders"
  end
end
`,
    "spec/requests/orders_spec.rb": 'require "rails_helper"\n\nRSpec.describe "Orders", type: :request do\n  it "creates" do\n    post "/orders", params: {}\n  end\nend\n',
    "spec/controllers/legacy_spec.rb": 'require "rails_helper"\n\nRSpec.describe OrdersController, type: :controller do\n  it "works" do\n    post :create\n  end\nend\n',
    // A JavaScript test is not one of the Ruby tests the entry point's search lists.
    "test/javascript/checkout.test.js": 'it("posts", async () => {\n  await post("/orders");\n});\n',
    "test/jobs/receipt_job_test.rb": 'require "test_helper"\n\nclass ReceiptJobTest < ActiveJob::TestCase\n  test "performs" do\n    ReceiptJob.perform_now(1)\n  end\nend\n',
    "test/models/order_test.rb": `require "test_helper"

class OrderTest < ActiveSupport::TestCase
  test "enqueues a receipt" do
    assert_enqueued_with(job: ReceiptJob) { Order.new.complete }
  end

  test "names the job" do
    assert ReceiptJob.name
  end
end
`,
  });
  const entryTests = async (query: string, extra: { path?: string; intent?: "tests" | "auto" } = {}) => (await runSearch({ query, intent: extra.intent ?? "tests", path: extra.path }, cwd)).details.entryTests;
  const found = (tests: NonNullable<Awaited<ReturnType<typeof entryTests>>>["tests"]) => tests.map((test) => `${test.path}:${test.line} ${test.found}`);

  const action = await entryTests("OrdersController#create");
  assert.ok(action);
  assert.deepEqual(action.entry, { symbol: "OrdersController#create", kind: "controller", exact: true, path: "app/controllers/orders_controller.rb", line: 2 });
  assert.deepEqual(found(action.tests), [
    "spec/controllers/legacy_spec.rb:3 class",
    "spec/requests/orders_spec.rb:3 path",
    "spec/requests/orders_spec.rb:5 route",
    "test/controllers/orders_controller_test.rb:3 path",
    "test/controllers/orders_controller_test.rb:5 route",
    "test/integration/checkout_flow_test.rb:5 route",
    "test/integration/checkout_flow_test.rb:6 route",
  ], "get order_url requests show, not create");
  assert.deepEqual(action.tests.find((test) => test.line === 5 && test.path.startsWith("test/controllers"))?.detail, "post orders_url → orders#create (POST /orders)");
  assert.deepEqual(action.tests.find((test) => test.line === 6)?.detail, 'post "/orders" → orders#create (POST /orders)');
  assert.deepEqual(await entryTests("create", { path: "app/controllers/orders_controller.rb" }).then((result) => result?.entry), action.entry, "a method name and its file name the same entry point");

  const job = await entryTests("ReceiptJob");
  assert.ok(job);
  assert.deepEqual(job.entry, { symbol: "ReceiptJob#perform", kind: "job", exact: true, path: "app/jobs/receipt_job.rb", line: 2 });
  assert.deepEqual(found(job.tests), [
    "test/jobs/receipt_job_test.rb:3 path",
    "test/jobs/receipt_job_test.rb:5 perform",
    "test/models/order_test.rb:5 enqueue",
  ], "a line that only names the job is not a test of it");

  const text = (await runSearch({ query: "OrdersController#create", intent: "tests" }, cwd)).content[0].text;
  assert.match(text, /ENTRY POINT OrdersController#create \(controller, routed\) app\/controllers\/orders_controller\.rb:2/);
  assert.match(text, /test\/integration\/checkout_flow_test\.rb:5 \[route\] post checkout_path → orders#create \(POST \/checkout\)/);
  assert.equal(await entryTests("Checkout"), undefined, "a class the framework does not call is not an entry point");
  assert.equal(await entryTests("OrdersController#create", { intent: "auto" }), undefined, "only a tests search looks for life-cycle tests");
}));

test("with every test listed, each test definition that references an anchor comes with its calls and setup blocks", () => repo(async ({ cwd, git, write, scan }) => {
  const minitest = (again: string) => `require "test_helper"

class CartTest < ActiveSupport::TestCase
  setup do
    Flipper.enable(:new_totals)
  end

  test "totals" do
    cart = Cart.new
    assert_equal 1, cart.total
    audit(cart)
  end

  test "totals again" do
    ${again}
  end

  test "unrelated" do
    assert true
  end

  private

  def audit(cart)
    cart
  end
end
`;
  await write({
    "package.json": '{"name":"fixture"}\n',
    "app/models/cart.rb": "class Cart\n  def total\n    1\n  end\nend\n",
    "test/models/cart_test.rb": minitest("assert Cart.new.total"),
    "spec/models/cart_spec.rb": `require "rails_helper"

RSpec.describe Cart do
  before { Flipper.disable(:new_totals) }

  context "with a coupon" do
    before(:each) do
      @coupon = 1
    end

    it "totals" do
      expect(Cart.new.total).to eq(1)
    end
  end
end
`,
    "src/cart.ts": "export function total() {\n  return 1;\n}\n",
    "src/cart.test.ts": `import { describe, it, beforeEach, expect } from "vitest";
import { total } from "./cart";

describe("cart", () => {
  beforeEach(() => {
    setFlag("totals", true);
  });

  it("totals", () => {
    expect(total()).toBe(1);
  });
});
`,
  });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({
    "app/models/cart.rb": "class Cart\n  def total\n    2\n  end\nend\n",
    "src/cart.ts": "export function total() {\n  return 2;\n}\n",
    "test/models/cart_test.rb": minitest("assert_equal 2, Cart.new.total"),
  });
  git("commit", "-qam", "change");

  const result = await scan("HEAD~1..HEAD", { indexCacheDir: join(cwd, "..", "index"), allTests: true });
  const symbolOf = (id?: string) => result.nodes.find((node) => node.id === id)?.symbol;
  assert.ok(result.testDefinitions);
  assert.deepEqual(result.testDefinitions.map((test) => ({
    symbol: test.symbol,
    path: test.path,
    anchors: test.anchors.map((anchor) => [symbolOf(anchor.id), anchor.lines]),
    setup: test.setup.map((block) => [block.startLine, block.endLine]),
    changed: test.changed,
  })), [
    { symbol: 'it "totals"', path: "spec/models/cart_spec.rb", anchors: [["Cart#total", [12]]], setup: [[4, 4], [7, 9]], changed: false },
    { symbol: 'describe "cart".totals', path: "src/cart.test.ts", anchors: [["total", [10]]], setup: [[5, 7]], changed: false },
    { symbol: 'CartTest test "totals"', path: "test/models/cart_test.rb", anchors: [["Cart#total", [10]]], setup: [[4, 6]], changed: false },
    { symbol: 'CartTest test "totals again"', path: "test/models/cart_test.rb", anchors: [["Cart#total", [15]]], setup: [[4, 6]], changed: true },
  ]);
  assert.deepEqual(result.testDefinitions[2]!.setup[0]!.lines, ["  setup do", "    Flipper.enable(:new_totals)", "  end"]);

  const calls = (symbol: string) => {
    const node = result.nodes.find((item) => item.symbol === symbol)!;
    return result.edges.filter((edge) => edge.from === node.id && edge.relationship === "calls").map((edge) => [edge.name, symbolOf(edge.to)]);
  };
  assert.ok(calls('CartTest test "totals"').some(([name, to]) => name === "cart.total" && to === "Cart#total"), JSON.stringify(calls('CartTest test "totals"')));
  assert.ok(calls('CartTest test "totals"').some(([name, to]) => name === "audit" && to === "CartTest#audit"), "a helper the test calls is followed one hop");
  assert.ok(calls('it "totals"').some(([, to]) => to === "Cart#total"), "an RSpec example inside RSpec.describe has its calls");
  assert.ok(calls('describe "cart".totals').some(([name, to]) => name === "total" && to === "total"));
  assert.equal(calls('CartTest test "totals again"').filter(([, to]) => to === "Cart#total").length, 1, "a changed test is expanded once, as an anchor");
  assert.match(result.inline, /## tests/);
  assert.match(await readFile(result.packPath, "utf8"), /CartTest test "totals" test\/models\/cart_test\.rb:8-12 references n\d+:10\n {2}setup 4-6:\n/);

  const plain = await scan("HEAD~1..HEAD");
  assert.equal(plain.testDefinitions, undefined, "the test list is opt-in");
  const plainTest = plain.nodes.find((node) => node.symbol === 'CartTest test "totals"');
  assert.ok(plainTest && !plain.edges.some((edge) => edge.from === plainTest.id && edge.relationship === "calls"), "without it, tests found by name are not expanded");
}));

test("a semantic fingerprint ignores comments and layout, and changes with the code", async () => {
  assert.equal(await rubyAdapter.ready(), true);
  const ruby = (source: string) => {
    const facts = rubyAdapter.parse("app/models/cart.rb", source, true)!;
    return rubyAdapter.semanticFingerprint(facts, facts.definitions.find((def) => def.symbol === "Cart#total")!);
  };
  const base = ruby("class Cart\n  def total(items)\n    items.sum { |item| item.price } # the sum\n  end\nend\n");
  assert.match(base ?? "", /^[0-9a-f]{16}$/);
  assert.equal(ruby("class Cart\n  # Totals the cart.\n  def total( items )\n      # each price\n      items.sum { |item|\n        item.price\n      }\n  end\nend\n"), base, "comments, indentation and line breaks are not code");
  assert.notEqual(ruby("class Cart\n  def total(items)\n    items.sum { |item| item.cost }\n  end\nend\n"), base);
  assert.notEqual(ruby('class Cart\n  def total(items)\n    "a  b"\n  end\nend\n'), ruby('class Cart\n  def total(items)\n    "a b"\n  end\nend\n'), "spaces inside a string are part of it");

  const ts = (source: string) => {
    const facts = tsAdapter.parse("src/cart.ts", source, true)!;
    return tsAdapter.semanticFingerprint(facts, facts.definitions.find((def) => def.symbol === "total")!);
  };
  const tsBase = ts("export function total(items: number[]) {\n  return items.reduce((sum, item) => sum + item, 0); // sum\n}\n");
  assert.match(tsBase ?? "", /^[0-9a-f]{16}$/);
  assert.equal(ts("/** Totals. */\nexport function total(items: number[]) {\n  // add them up\n  return items.reduce(\n    (sum, item) => sum + item,\n    0,\n  );\n}\n"), tsBase);
  assert.notEqual(ts("export function total(items: number[]) {\n  return items.reduce((sum, item) => sum - item, 0);\n}\n"), tsBase);
  assert.notEqual(ts('export function total() {\n  return "a  b";\n}\n'), ts('export function total() {\n  return "a b";\n}\n'));
});

test("nodes and anchors carry the semantic fingerprint beside the raw one", () => repo(async ({ cwd, git, write, scan }) => {
  await write({ "package.json": '{"name":"fixture"}\n', "app/models/cart.rb": "class Cart\n  def total(items)\n    items.sum\n  end\nend\n" });
  git("add", ".");
  git("commit", "-qm", "base");
  const collect = () => collectSparsity({ cwd, target: "app/models/cart.rb:3", maxDepth: 1, vicinity: 5, maxNodes: 10, callers: false, budgetMs: 20_000 });
  const before = (await collect()).anchor;
  await write({ "app/models/cart.rb": "class Cart\n  def total(items)\n    # every item\n      items.sum\n  end\nend\n" });
  const commented = (await collect()).anchor;
  assert.notEqual(commented.fingerprint, before.fingerprint, "the raw fingerprint says the text changed");
  assert.equal(commented.semanticFingerprint, before.semanticFingerprint, "the semantic one says the code did not");

  await write({ "app/models/cart.rb": "class Cart\n  def total(items)\n    items.sum * 2\n  end\nend\n" });
  git("commit", "-qam", "double");
  const anchor = (await scan("HEAD~1..HEAD")).anchors.find((item) => item.symbol === "Cart#total");
  assert.match(anchor?.semanticFingerprint ?? "", /^[0-9a-f]{16}$/);
  assert.notEqual(anchor?.semanticFingerprint, before.semanticFingerprint);
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

test("a call written as an assignment or an export is a caller, and a declaration of the name is not", () => repo(async ({ cwd, write }) => {
  await write({
    "package.json": '{"name":"fixture"}\n',
    "src/target.ts": "export function hostReviews(options: object) {\n  return options;\n}\n",
    "src/viaConst.ts": 'import { hostReviews } from "./target";\n\nexport const reviews = hostReviews({});\n',
    "src/viaAwait.ts": 'import { hostReviews } from "./target";\n\nexport async function open() {\n  const host = await hostReviews({});\n  return host;\n}\n',
    "src/viaRequire.ts": 'const { hostReviews } = require("./target");\n',
    "app/models/pricing.rb": "class Pricing\n  def quote_total(cart)\n    cart\n  end\nend\n",
    "app/models/checkout.rb": "class Checkout\n  def total(cart)\n    amount = quote_total(cart)\n    amount\n  end\nend\n",
  });

  const callers = async (target: string) => {
    const result = await collectSparsity({ cwd, target, maxDepth: 1, vicinity: 5, maxNodes: 20, callers: true, budgetMs: 20_000 });
    return result.edges.filter((edge) => edge.relationship === "called_by").map((edge) => result.nodes.find((node) => node.id === edge.from)?.path).sort();
  };
  assert.deepEqual(await callers("src/target.ts:1"), ["src/viaAwait.ts", "src/viaConst.ts"]);
  assert.deepEqual(await callers("app/models/pricing.rb:2"), ["app/models/checkout.rb"]);

  for (const text of ["function foo() {", "export async function foo(a) {", "import { foo } from './x'", "import foo from './x'", "const foo = () => 1", "export const foo = 1", "const { foo } = require('x')", "export { foo }", "require 'foo'", "def foo", "def self.foo(a)", "scope :foo, -> { all }", "class foo"]) {
    assert.equal(declaresName(text, "foo"), true, text);
  }
  for (const text of ["const x = foo(1)", "export const y = foo()", "const host = await foo({", "let z = foo", "x = foo(1)", "  result = Foo.new.foo", "const { a } = foo()", "var v = obj.foo()", "export default foo()"]) {
    assert.equal(declaresName(text, "foo"), false, text);
  }
}));

test("a changed line inside a top-level call's callback anchors that statement, whatever the line before it ends with", () => repo(async ({ git, write, scan }) => {
  const worker = (fallback: string, helper: string) => `const known = new Map();

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("fetch", (event) => {
  const version = known.get(event.request.url);
  if (!version) {
    ${fallback}
    return;
  }
  event.respondWith(fetch(event.request));
});
${helper}
function cacheName(version) {
  return \`assets-v\${version}\`;
}
`;
  const anyCache = `
async function fromAnyCache(request) {
  const names = await caches.keys();
  for (const name of names) {
    const hit = await (await caches.open(name)).match(request);
    if (hit) return hit;
  }
  return fetch(request);
}
`;
  await write({ "package.json": '{"name":"fixture"}\n', "public/sw.js": worker("event.respondWith(fromAnyCache(event.request));", anyCache) });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({
    "public/sw.js": worker("event.respondWith(fetch(event.request));", ""),
    "test/javascript/sw.test.js": 'import { test, expect } from "bun:test";\n\nfunction startWorker() {\n  return {};\n}\n\ntest("an unknown version goes to the network", () => {\n  expect(startWorker()).toEqual({});\n});\n',
  });
  git("add", ".");
  git("commit", "-qm", "change");

  const result = await scan("HEAD~1..HEAD");
  const inWorker = result.anchors.filter((anchor) => anchor.path === "public/sw.js").map((anchor) => [anchor.kind, anchor.startLine, anchor.endLine, anchor.changedLines]);
  assert.deepEqual(inWorker, [["statement", 5, 12, [8]], ["function", 14, 21, []]], "the line after `if (!version) {` sits inside the fetch listener the parser read, so it is that listener's change; the helper went whole");
  assert.deepEqual(result.dangling.map((entry) => [entry.name, entry.stillDefined]), [["fromAnyCache", false]]);
}));

test("a definition the change deletes whole is an anchor at its base lines, and the definition before the deletion is not changed by it", () => repo(async ({ git, write, scan }) => {
  const anyCache = "async function fromAnyCache(request) {\n  const names = await caches.keys();\n  for (const name of names) {\n    const hit = await (await caches.open(name)).match(request);\n    if (hit) return hit;\n  }\n  return fetch(request);\n}\n\n";
  const worker = (helper: string) => `self.addEventListener("fetch", (event) => {\n  event.respondWith(fetch(event.request));\n});\n\n${helper}function cacheName(version) {\n  return \`assets-v\${version}\`;\n}\n`;
  const cart = (legacy: string) => `class Cart\n  def total\n    1\n  end\n${legacy}end\n`;
  await write({ "package.json": '{"name":"fixture"}\n', "public/sw.js": worker(anyCache), "app/models/cart.rb": cart("\n  def legacy_total\n    2\n  end\n") });
  git("add", ".");
  git("commit", "-qm", "base");
  await write({ "public/sw.js": worker(""), "app/models/cart.rb": cart("") });
  git("commit", "-qam", "change");

  const result = await scan("HEAD~1..HEAD");
  const anchorsIn = (path: string) => result.anchors.filter((anchor) => anchor.path === path).map((anchor) => [anchor.symbol, anchor.kind, anchor.startLine, anchor.endLine, anchor.changedLines, anchor.goneAtHead]);
  assert.deepEqual(anchorsIn("public/sw.js"), [["fromAnyCache", "function", 5, 12, [], true]], "nothing calls it and nothing defines it again: it is still what the change did");
  assert.deepEqual(anchorsIn("app/models/cart.rb"), [["Cart#legacy_total", "method", 6, 8, [], true]], "git places the deletion after `total`'s last line, which does not make `total` changed");
  const gone = result.anchors.find((anchor) => anchor.symbol === "fromAnyCache")!;
  assert.deepEqual(gone.removed, [{ oldStart: 5, lines: anyCache.split("\n").slice(0, 8) }], "its own lines, as the base had them");
  assert.ok(result.nodes.some((node) => node.id === gone.id && node.path === "public/sw.js"), "an anchor is a node of the pack");
}));

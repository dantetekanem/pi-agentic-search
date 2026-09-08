import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PinnedSource } from "./evaluation/core.ts";
import { PublicTools, projectResult } from "./evaluation/model-tools.ts";
import { runSearch } from "../src/extension.ts";
import { ModelClient, loadSdk, parseAction, type ProbeRuntime } from "./evaluation/model-client.ts";
import { navigate } from "./evaluation/model-run.ts";
import type { EvaluationCase } from "./evaluation/core.ts";
import test from "node:test";
import { maximumReservation, usageDebit, SpendLedger, type PriceModel } from "./evaluation/model-budget.ts";

const model: PriceModel = {
  id: "gpt-5.6-luna", provider: "openai-codex", api: "openai-codex-responses", contextWindow: 272000, maxTokens: 128000,
  cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25,
    tiers: [{ inputTokensAbove: 272000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }] },
};
async function temporary(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "model-evaluation-"));
  try { await run(join(directory, "budget.jsonl")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("reservation covers full catalog input, cache and output ceilings without a requested cap", () => {
  const reserved = maximumReservation(model);
  assert.ok(reserved >= 972160 && reserved <= 972162);
  assert.ok(reserved < 1_000_000);
  assert.ok(maximumReservation({ ...model, cost: { ...model.cost, output: 50 } }) > 5_000_000);
  assert.throws(() => maximumReservation({ ...model, maxTokens: NaN }));
});

test("only finite bounded usage can refund a reservation", () => {
  const usage = { input: 100, output: 10, cacheRead: 20, cacheWrite: 0 };
  assert.ok(usageDebit(model, usage)! >= 118);
  assert.ok(usageDebit(model, usage)! < maximumReservation(model));
  for (const invalid of [undefined, {}, { ...usage, input: -1 }, { ...usage, output: 128001 }, { ...usage, output: NaN }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]) {
    assert.equal(usageDebit(model, invalid), undefined);
  }
});

test("a shared journal reserves before dispatch, rejects repeats and cannot exceed five dollars", () => temporary(async (path) => {
  const ledger = await SpendLedger.open(path, "a".repeat(64));
  const reserve = maximumReservation(model);
  try {
    for (let index = 0; index < 5; index++) await ledger.reserve(`case/full/${index}`, reserve);
    await assert.rejects(ledger.reserve("case/full/5", reserve), /budget/);
    await assert.rejects(ledger.reserve("case/full/0", reserve), /already attempted/);
    await assert.rejects(SpendLedger.open(path, "a".repeat(64)), /locked/);
    assert.equal(ledger.spentMicro, reserve * 5);
    assert.match(await readFile(path, "utf8"), /case\/full\/4/);
    await ledger.settle("case/full/0", usageDebit(model, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 })!);
    assert.ok(ledger.spentMicro < reserve * 5);
    await ledger.reserve("case/full/5", reserve);
    assert.ok(ledger.spentMicro <= 5_000_000);
  } finally { await ledger.close(); }
}));

test("restart keeps unknown charges, disallows later refunds and checks the fixed configuration", () => temporary(async (path) => {
  const ledger = await SpendLedger.open(path, "a".repeat(64));
  await ledger.reserve("case/full/0", maximumReservation(model));
  await ledger.close();
  const resumed = await SpendLedger.open(path, "a".repeat(64));
  try {
    assert.equal(resumed.spentMicro, maximumReservation(model));
    assert.equal(resumed.hasAttempt("case/full/"), true);
    await assert.rejects(resumed.settle("case/full/0", 0), /current process/);
  } finally { await resumed.close(); }
  await assert.rejects(SpendLedger.open(path, "b".repeat(64)), /configuration/);
}));

async function publicFixture(path: string) {
  const root = join(dirname(path), "source");
  await mkdir(root);
  await writeFile(join(root, "target.ts"), "export const needle = 1;\nneedle;\n");
  await writeFile(join(root, "AGENTS.md"), "ambient instruction sentinel needle\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("remote", "add", "origin", "https://github.com/fixture/public");
  git("add", "target.ts", "AGENTS.md");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture");
  return PinnedSource.open(root, { repository: "fixture/public", revision: git("rev-parse", "HEAD").trim() });
}

test("public tools read committed blobs and deny ambient instructions and escaping paths", () => temporary(async path => {
  const source = await publicFixture(path);
  const tools = new PublicTools(source);
  await writeFile(join(source.root, "target.ts"), "PRIVATE WORKING TREE\n");
  assert.match(tools.read("target.ts", 1).text, /export const needle/);
  for (const name of ["../private.ts", "AGENTS.md", "/etc/passwd"]) assert.throws(() => tools.read(name, 1));
}));

test("raw probe respects an explicit case-insensitive query", () => temporary(async path => {
  const tools = new PublicTools(await publicFixture(path));
  const output = await tools.search({ query: "NEEDLE", path: "target.ts", case_sensitive: false }, "raw-rg");
  assert.match(output.text, /target\.ts:1:export const needle/);
}));

test("projection preserves ranked snippets while removing non-public paths and opaque diagnostics", () => temporary(async path => {
  const source = await publicFixture(path);
  const result = await runSearch({ query: "needle", path: "target.ts" }, source.root);
  const full = projectResult(source, "needle", result, true);
  const plain = projectResult(source, "needle", result, false);
  assert.deepEqual(full.rows, plain.rows);
  assert.deepEqual(full.rows.flatMap(row => row.lines), [...result.content[0]!.text.matchAll(/^\s+L(\d+) \[/gm)].map(match => Number(match[1])));
  const contaminated = structuredClone(result);
  contaminated.details.coverage.reasons.push("PRIVATE DIAGNOSTIC /home/private");
  contaminated.details.files.push({ path: "/home/private.ts", score: 1, reasons: ["PRIVATE REASON"], matchCount: 1 });
  contaminated.content.push({ type: "text", text: "PRIVATE CONTENT" });
  assert.doesNotMatch(projectResult(source, "needle", contaminated, true).text, /PRIVATE|\/home\/private/);
  const changed = structuredClone(result);
  changed.content[0]!.text = changed.content[0]!.text.replace("export const needle = 1;", "PRIVATE REPLACEMENT");
  assert.throws(() => projectResult(source, "needle", changed, true), /pinned snippet/);
}));

test("navigation actions cannot invoke arbitrary tools or supply unbounded inputs", () => {
  assert.deepEqual(parseAction({ action: "read", path: "target.ts", line: 1 }), { action: "read", path: "target.ts", line: 1 });
  for (const action of [{ action: "shell", command: "pwd" }, { action: "read", path: "target.ts", line: 0 }, { action: "search", query: "x".repeat(513) }, { action: "finish" }]) assert.throws(() => parseAction(action), /action/);
});

test("provider dispatch is reserved before the only permitted fetch and refunds verified usage", () => temporary(async path => {
  const ledger = await SpendLedger.open(path, "a".repeat(64));
  let calls = 0;
  const runtime: ProbeRuntime = { getModel() { return model; }, async complete(_model, context, options) {
    await options.onPayload({ model: model.id, instructions: context.systemPrompt, input: [{ role: "user", content: [{ type: "input_text", text: context.messages[0]!.content }] }], store: false, stream: true, service_tier: "default" });
    await options.fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST" });
    await assert.rejects(options.fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST" }), /second dispatch/);
    return { stopReason: "toolUse", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.000032 } }, content: [{ type: "toolCall", name: "navigate", arguments: { action: "read", path: "target.ts", line: 1 } }] };
  } };
  const client = new ModelClient(runtime, model, ledger, async () => { calls++; assert.ok(ledger.spentMicro >= 972160); return new Response("", { status: 200 }); });
  try {
    const result = await client.request("case/full/0", "Fixed instructions", "Public source", AbortSignal.timeout(1000));
    assert.equal(calls, 1); assert.equal(result.action?.action, "read"); assert.ok(ledger.spentMicro < 1000);
    await assert.rejects(client.request("case/full/0", "Fixed instructions", "Public source", AbortSignal.timeout(1000)), /already attempted/);
  } finally { await ledger.close(); }
}));

test("installed SDK respects mocked fetch, SSE, payload guard and zero retries", { skip: !process.env.PI_EVALUATION_SDK_ROOT }, () => temporary(async path => {
  const { runtime, model: current } = await loadSdk(process.env.PI_EVALUATION_SDK_ROOT!);
  const ledger = await SpendLedger.open(path, "a".repeat(64));
  let calls = 0;
  const fakeJwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`;
  const client = new ModelClient(runtime, current, ledger, async () => { calls++; return new Response("Temporary fixture failure", { status: 503 }); }, fakeJwt);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected real network in SDK test"); };
  try {
    await assert.rejects(client.request("fixture/full/0", "Fixed fixture instructions", "Only public fixture text", AbortSignal.timeout(5000)), /provider_error/);
    assert.equal(calls, 1);
    assert.equal(ledger.spentMicro, maximumReservation(current));
  } finally { globalThis.fetch = previousFetch; await ledger.close(); }
}));

test("navigation scoring requires a relevant source read, not just a correct final guess", () => temporary(async path => {
  const tools = new PublicTools(await publicFixture(path));
  const scenario: EvaluationCase = { id: "fixture", project: "fixture", split: "development", task: "Find the declaration of needle.", params: { query: "needle", path: "target.ts" }, targets: [{ path: "target.ts", startLine: 1, endLine: 1 }], alternatives: [], requiredRoots: ["target.ts"] };
  for (const readLine of [1, 2]) {
    let calls = 0;
    const checkpoints: number[] = [];
    const result = await navigate(scenario, "full", tools, { async request(_id, _system, input) {
      const sent = JSON.parse(input);
      assert.equal(Object.hasOwn(sent, "targets"), false);
      assert.equal(Object.hasOwn(sent, "alternatives"), false);
      return { action: parseAction(calls++ ? { action: "finish", path: "target.ts", line: 1 } : { action: "read", path: "target.ts", line: readLine }), payloadHash: "fixture", wallMs: 1, httpStatus: 200, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, catalogCostUSD: 0, debitMicro: 1 };
    } }, async progress => { checkpoints.push(progress.trace.length); });
    assert.deepEqual(checkpoints, [1, 2]);
    assert.equal(result.taskSuccess, readLine === 1);
    assert.equal(result.correctFirstRead, readLine === 1);
    assert.equal(result.followUpDiscoveryCalls, 0);
    assert.equal(result.modelCalls, 2);
  }
}));

test("navigation stops after four actions and counts every follow-up discovery", () => temporary(async path => {
  const tools = new PublicTools(await publicFixture(path));
  const scenario: EvaluationCase = { id: "fixture", project: "fixture", split: "development", task: "Find needle.", params: { query: "needle", path: "target.ts" }, targets: [{ path: "target.ts", startLine: 1, endLine: 1 }], alternatives: [], requiredRoots: ["target.ts"] };
  const result = await navigate(scenario, "raw-rg", tools, { async request() { return { action: parseAction({ action: "search", query: "needle", path: "target.ts" }), payloadHash: "fixture", wallMs: 1, httpStatus: 200, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, catalogCostUSD: 0, debitMicro: 1 }; } });
  assert.equal(result.status, "step_limit");
  assert.equal(result.modelCalls, 4);
  assert.equal(result.followUpDiscoveryCalls, 4);
  assert.equal(result.taskSuccess, false);
}));

test("a torn journal fails closed rather than resetting the available budget", () => temporary(async (path) => {
  await writeFile(path, '{"type":"reserve"');
  await assert.rejects(SpendLedger.open(path, "a".repeat(64)), /Invalid ledger/);
  assert.equal(await readFile(path, "utf8"), '{"type":"reserve"');
}));

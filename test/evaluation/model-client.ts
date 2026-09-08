import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assertPriceModel, maximumReservation, record, SpendLedger, usageDebit, type PriceModel } from "./model-budget.ts";

export const MODEL_ID = "gpt-5.6-luna";
export const PROVIDER = "openai-codex";
export const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const Intent = Type.Union([Type.Literal("definition"), Type.Literal("references"), Type.Literal("tests"), Type.Literal("file"), Type.Literal("auto")]);
export const ActionSchema = Type.Object({
  action: Type.Union([Type.Literal("read"), Type.Literal("search"), Type.Literal("finish")]),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), line: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), context: Type.Optional(Type.String({ maxLength: 512 })),
  intent: Type.Optional(Intent), literal: Type.Optional(Type.Boolean()), case_sensitive: Type.Optional(Type.Boolean()), expand_related: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type NavigationAction =
  | { action: "read"; path: string; line: number }
  | { action: "finish"; path: string; line: number }
  | (Omit<Static<typeof ActionSchema>, "action" | "line" | "query"> & { action: "search"; query: string });
export function parseAction(value: unknown): NavigationAction {
  if (!Value.Check(ActionSchema, value)) throw new Error("Invalid navigation action");
  if (value.action === "search" && value.query) return { action: "search", query: value.query, path: value.path, context: value.context, intent: value.intent, literal: value.literal, case_sensitive: value.case_sensitive, expand_related: value.expand_related };
  if (value.action !== "search" && value.path && value.line) return { action: value.action, path: value.path, line: value.line };
  throw new Error("Invalid navigation action");
}
interface ProbeContext {
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
  tools: Array<{ name: string; description: string; parameters: typeof ActionSchema }>;
}
interface RequestOptions {
  signal: AbortSignal; apiKey?: string; transport: "sse"; maxRetries: 0; cacheRetention: "none";
  serviceTier: "default"; reasoningEffort: "low"; reasoningSummary: "auto"; textVerbosity: "low"; toolChoice: "required"; timeoutMs: number;
  onPayload: (payload: unknown) => object;
  fetch: typeof globalThis.fetch;
}
export interface ProbeRuntime {
  getModel(provider: string, id: string): unknown;
  complete(model: PriceModel, context: ProbeContext, options: RequestOptions): Promise<unknown>;
}
export async function loadSdk(directory: string) {
  const root = await realpath(directory);
  const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!record(manifest) || manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== "0.85.1") throw new Error("Probe requires the verified installed Pi SDK 0.85.1");
  const sdk: unknown = await import(pathToFileURL(join(root, "dist/index.js")).href);
  if (!record(sdk) || typeof sdk.ModelRuntime !== "function" || !("create" in sdk.ModelRuntime) || typeof sdk.ModelRuntime.create !== "function") throw new Error("Unsupported model runtime");
  const loaded: unknown = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, signal: AbortSignal.timeout(10000) });
  if (!record(loaded) || typeof loaded.getModel !== "function" || typeof loaded.complete !== "function") throw new Error("Unsupported model runtime methods");
  const getModel = loaded.getModel.bind(loaded);
  const complete = loaded.complete.bind(loaded);
  const runtime: ProbeRuntime = { getModel, complete };
  const model = runtime.getModel(PROVIDER, MODEL_ID);
  assertPriceModel(model);
  if (model.id !== MODEL_ID || model.provider !== PROVIDER || model.api !== "openai-codex-responses") throw new Error("Fixed model unavailable");
  // Locate the installed dependency only for provenance; calls use ModelRuntime's public API.
  let adapterHash: string | undefined;
  for (const directory of createRequire(join(root, "package.json")).resolve.paths("@earendil-works/pi-ai") ?? []) {
    try { adapterHash = hash(await readFile(join(directory, "@earendil-works/pi-ai/dist/api/openai-codex-responses.js"))); break; } catch { /* next Node dependency directory */ }
  }
  if (!adapterHash) throw new Error("Cannot verify installed provider adapter");
  return { runtime, model, sdk: { version: manifest.version, adapterHash, modelRuntimeHash: hash(await readFile(join(root, "dist/core/model-runtime.js"))) } };
}

export class ModelClient {
  constructor(private readonly runtime: ProbeRuntime, readonly model: PriceModel, private readonly ledger: SpendLedger,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch, private readonly apiKey?: string) {
    if (model.id !== MODEL_ID || model.provider !== PROVIDER || model.api !== "openai-codex-responses" || maximumReservation(model) > ledger.limitMicro) throw new Error("Fixed model exceeds probe budget or configuration");
  }
  async request(id: string, systemPrompt: string, input: string, signal: AbortSignal) {
    if (this.ledger.hasAttempt(id)) throw new Error("Request already attempted");
    if (Buffer.byteLength(input) > 65536 || Buffer.byteLength(systemPrompt) > 8192) throw new Error("Model input budget");
    signal.throwIfAborted();
    const start = performance.now();
    const reservation = maximumReservation(this.model);
    let payloadHash: string | undefined;
    let dispatches = 0;
    let httpStatus: number | undefined;
    const response = await this.runtime.complete(this.model, {
      systemPrompt, messages: [{ role: "user", content: input, timestamp: 0 }],
      tools: [{ name: "navigate", description: "Choose one read, search, or finish action. Reads show up to 80 lines starting at line. Search accepts query/path/context/intent/literal/case_sensitive/expand_related. Finish requires the answer file and line.", parameters: ActionSchema }],
    }, {
      signal, apiKey: this.apiKey, transport: "sse", maxRetries: 0, cacheRetention: "none", serviceTier: "default",
      reasoningEffort: "low", reasoningSummary: "auto", textVerbosity: "low", toolChoice: "required", timeoutMs: 30000,
      onPayload: payload => {
        if (payloadHash || !record(payload) || payload.model !== this.model.id || payload.instructions !== systemPrompt || payload.store !== false || payload.stream !== true || payload.service_tier !== "default" || !Array.isArray(payload.input) || payload.input.length !== 1) throw new Error("Unexpected provider payload");
        const message: unknown = payload.input[0];
        if (!record(message) || message.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1 || !record(message.content[0]) || message.content[0].type !== "input_text" || message.content[0].text !== input) throw new Error("Unexpected provider context");
        const body = { ...payload, parallel_tool_calls: false, tool_choice: "required" };
        const text = JSON.stringify(body);
        if (Buffer.byteLength(text) > 96 * 1024) throw new Error("Provider payload budget");
        payloadHash = hash(text);
        return body;
      },
      fetch: async (url, init) => {
        if (dispatches++) throw new Error("Refused second dispatch");
        if (!payloadHash || String(url) !== "https://chatgpt.com/backend-api/codex/responses" || init?.method !== "POST") throw new Error("Unexpected provider endpoint");
        signal.throwIfAborted();
        await this.ledger.reserve(id, reservation); // fsync completes before any network send
        signal.throwIfAborted();
        const result = await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) });
        httpStatus = result.status;
        let bytes = 0;
        const body = result.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 4 * 1024 * 1024) throw new Error("Provider response byte budget");
          controller.enqueue(chunk);
        } }));
        return new Response(body, { status: result.status, statusText: result.statusText, headers: result.headers });
      },
    });
    if (!record(response) || !["stop", "toolUse", "length"].includes(String(response.stopReason))) throw new Error(`provider_error (HTTP ${httpStatus ?? "not dispatched"}); reservation retained`);
    const debit = usageDebit(this.model, response.usage);
    if (debit === undefined || debit > reservation || !record(response.usage)) throw new Error("provider_error: unknown usage; reservation retained");
    const cost = record(response.usage.cost) ? response.usage.cost.total : undefined;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || Math.ceil(cost * 1_000_000) > reservation) throw new Error("provider_error: unverified price; reservation retained");
    await this.ledger.settle(id, Math.max(debit, Math.ceil(cost * 1_000_000)));
    const calls = Array.isArray(response.content) ? response.content.filter(item => record(item) && item.type === "toolCall") : [];
    const call: unknown = calls[0];
    let action: NavigationAction | undefined;
    try { if (calls.length === 1 && record(call) && call.name === "navigate") action = parseAction(call.arguments); } catch { /* measured protocol failure, not a retry */ }
    return {
      action, payloadHash, wallMs: performance.now() - start, httpStatus,
      usage: { input: Number(response.usage.input), output: Number(response.usage.output), cacheRead: Number(response.usage.cacheRead), cacheWrite: Number(response.usage.cacheWrite) },
      catalogCostUSD: cost, debitMicro: Math.max(debit, Math.ceil(cost * 1_000_000)),
    };
  }
}

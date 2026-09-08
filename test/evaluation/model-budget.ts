import { constants } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";

const TOKEN_KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type TokenKind = typeof TOKEN_KINDS[number];
type Rates = Record<TokenKind, number>;
export interface PriceModel {
  id: string; provider: string; api: string; contextWindow: number; maxTokens: number;
  cost: Rates & { tiers?: Array<Rates & { inputTokensAbove: number }> };
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function assertPriceModel(value: unknown): asserts value is PriceModel {
  if (!record(value) || ![value.id, value.provider, value.api].every(item => typeof item === "string") ||
      !integer(value.contextWindow) || value.contextWindow === 0 || !integer(value.maxTokens) || value.maxTokens === 0 || !record(value.cost)) throw new Error("Invalid model ceilings");
  const tiers = value.cost.tiers ?? [];
  if (!Array.isArray(tiers) || ![value.cost, ...tiers].every(row => record(row) && TOKEN_KINDS.every(key => typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0))) throw new Error("Invalid model prices");
}
function ceilingRates(model: PriceModel): Rates {
  assertPriceModel(model);
  const maximum = (key: TokenKind) => Math.max(model.cost[key], ...(model.cost.tiers ?? []).map(tier => tier[key]));
  return { input: maximum("input"), output: maximum("output"), cacheRead: maximum("cacheRead"), cacheWrite: maximum("cacheWrite") };
}
// Luna's priority multiplier is 2. Reserve every input/cache ceiling separately;
// neither requested maxTokens (omitted by Codex) nor flex discounts reduce this bound.
export function maximumReservation(model: PriceModel): number {
  const rate = ceilingRates(model);
  return Math.ceil(2 * (model.contextWindow * (rate.input + rate.cacheRead + rate.cacheWrite) + model.maxTokens * rate.output)) + 1;
}
export function usageDebit(model: PriceModel, usage: unknown): number | undefined {
  if (!record(usage) || !TOKEN_KINDS.every(key => integer(usage[key]) && usage[key] <= (key === "output" ? model.maxTokens : model.contextWindow))) return;
  const rate = ceilingRates(model);
  const amount = TOKEN_KINDS.reduce((sum, key) => sum + Number(usage[key]) * rate[key], 0);
  if (TOKEN_KINDS.every(key => usage[key] === 0)) return;
  return Math.ceil(2 * amount) + 1; // microdollars; round upward, including floating-point slack
}

interface Reservation { reserved: number; charged?: number }
export class SpendLedger {
  readonly limitMicro = 5_000_000;
  private readonly attempts = new Map<string, Reservation>();
  private readonly issuedHere = new Set<string>();
  private busy = false;
  private closed = false;
  private constructor(private readonly file: FileHandle, private readonly lock: FileHandle, private readonly lockPath: string) {}
  static async open(path: string, configuration: string): Promise<SpendLedger> {
    if (!/^[a-f0-9]{64}$/.test(configuration)) throw new Error("Invalid configuration hash");
    const lockPath = `${path}.lock`;
    const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error("Evaluation ledger is locked"); });
    let file: FileHandle | undefined;
    try {
      file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Invalid ledger file");
      const ledger = new SpendLedger(file, lock, lockPath);
      const text = await file.readFile("utf8");
      if (!text) await ledger.append({ type: "configuration", hash: configuration, limitMicro: ledger.limitMicro });
      else {
        if (!text.endsWith("\n")) throw new Error("Invalid ledger: incomplete record");
        let rows: unknown[];
        try { rows = text.trimEnd().split("\n").map(line => JSON.parse(line)); }
        catch { throw new Error("Invalid ledger JSON"); }
        const first = rows.shift();
        if (!record(first) || first.type !== "configuration" || first.hash !== configuration || first.limitMicro !== ledger.limitMicro) throw new Error("Invalid ledger configuration");
        for (const row of rows) ledger.apply(row);
      }
      return ledger;
    } catch (error) {
      await file?.close(); await lock.close(); await unlink(lockPath); throw error;
    }
  }
  get spentMicro(): number { return [...this.attempts.values()].reduce((sum, row) => sum + (row.charged ?? row.reserved), 0); }
  hasAttempt(prefix: string): boolean { return [...this.attempts.keys()].some(id => id.startsWith(prefix)); }
  snapshot() { return { limitMicro: this.limitMicro, spentMicro: this.spentMicro, attempts: [...this.attempts].map(([id, row]) => ({ id, ...row })) }; }
  private apply(row: unknown): void {
    if (!record(row) || typeof row.id !== "string" || !/^[a-zA-Z0-9/_-]{1,160}$/.test(row.id) || !integer(row.amount)) throw new Error("Invalid ledger record");
    const prior = this.attempts.get(row.id);
    if (row.type === "reserve" && !prior && row.amount > 0 && this.spentMicro + row.amount <= this.limitMicro) this.attempts.set(row.id, { reserved: row.amount });
    else if (row.type === "settle" && prior && prior.charged === undefined && row.amount <= prior.reserved) prior.charged = row.amount;
    else throw new Error("Invalid ledger transition");
  }
  private async append(row: object): Promise<void> {
    await this.file.appendFile(`${JSON.stringify(row)}\n`);
    await this.file.sync();
  }
  async reserve(id: string, amount: number): Promise<void> {
    if (this.closed || this.busy) throw new Error("Ledger unavailable");
    if (this.attempts.has(id)) throw new Error("Request already attempted");
    if (!/^[a-zA-Z0-9/_-]{1,160}$/.test(id) || !integer(amount) || amount === 0 || this.spentMicro + amount > this.limitMicro) throw new Error("Evaluation budget exhausted or invalid reservation");
    this.busy = true;
    try {
      const row = { type: "reserve", id, amount };
      await this.append(row); this.apply(row); this.issuedHere.add(id);
    } finally { this.busy = false; }
  }
  async settle(id: string, amount: number): Promise<void> {
    if (!this.issuedHere.has(id)) throw new Error("Refund requires a response from the current process");
    if (this.closed || this.busy) throw new Error("Ledger unavailable");
    const prior = this.attempts.get(id)!;
    if (!integer(amount) || amount > prior.reserved || prior.charged !== undefined) throw new Error("Invalid refund");
    this.busy = true;
    try { const row = { type: "settle", id, amount }; await this.append(row); this.apply(row); this.issuedHere.delete(id); }
    finally { this.busy = false; }
  }
  async close(): Promise<void> {
    if (this.busy) throw new Error("Ledger operation in progress");
    if (this.closed) return;
    this.closed = true;
    await this.file.close(); await this.lock.close(); await unlink(this.lockPath);
  }
}

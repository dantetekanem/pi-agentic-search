import { spawn } from "node:child_process";
import { decodeRipgrepEvent } from "./matches.ts";
import { normalizeRepoRelativePath } from "./shared.ts";
import type { CodeMatch, FileSummary, SearchRun, SearchIntent } from "./types.ts";
import { snippetPriority } from "./evidence.ts";

export const RETRIEVAL_LIMITS = {
  candidates: 10_000, snippetsPerFile: 16, snippetBytes: 1024,
  retainedBytes: 8 * 1024 * 1024, eventBytes: 1024 * 1024,
};

export class SearchRequest {
  readonly files = new Map<string, FileSummary>();
  readonly runs: SearchRun[] = [];
  readonly inventories = new Map<string, Promise<string[]>>();
  readonly inventoryReasons: string[] = [];
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly limits: typeof RETRIEVAL_LIMITS;
  retainedBytes = 0;
  exhaustedReason?: string;
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = () => this.controller.abort(this.parentSignal?.reason);

  constructor(private readonly parentSignal?: AbortSignal, timeoutMs = 30_000, limits = RETRIEVAL_LIMITS,
    private readonly ranking: { intent?: SearchIntent; context?: string[] } = {}) {
    this.limits = limits;
    this.deadline = performance.now() + timeoutMs;
    if (parentSignal?.aborted) this.onAbort();
    else parentSignal?.addEventListener("abort", this.onAbort, { once: true });
    this.timer = setTimeout(() => this.controller.abort(new Error("request deadline")), timeoutMs);
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.parentSignal?.removeEventListener("abort", this.onAbort);
  }
  checkpoint(): boolean {
    if (!this.signal.aborted && performance.now() >= this.deadline) this.controller.abort(new Error("request deadline"));
    return !this.signal.aborted;
  }
  private removeFile(path: string): FileSummary | undefined {
    const previous = this.files.get(path);
    if (previous) {
      this.retainedBytes -= previous.matches.reduce((sum, match) => sum + Buffer.byteLength(JSON.stringify(match)), 0);
      this.files.delete(path);
    }
    return previous;
  }
  async replaceFile(path: string, operation: () => Promise<SearchRun>): Promise<void> {
    const previous = this.removeFile(path);
    let complete = false;
    try { complete = (await operation()).status === "complete"; }
    finally {
      if (!complete && previous) {
        this.removeFile(path);
        this.files.set(path, previous);
        this.retainedBytes += previous.matches.reduce((sum, match) => sum + Buffer.byteLength(JSON.stringify(match)), 0);
      }
    }
  }
  get truncatedMatches(): number { return [...this.files.values()].reduce((sum, file) => sum + (file.truncatedMatches ?? 0), 0); }
  get matches(): CodeMatch[] { return [...this.files.values()].flatMap((file) => file.matches); }
  get totalMatches(): number { return [...this.files.values()].reduce((sum, file) => sum + file.matchCount, 0); }

  consume(line: string, mapPath = normalizeRepoRelativePath): string | undefined {
    const event = decodeRipgrepEvent(line, mapPath);
    if (!event) return;
    if (event.type === "begin") {
      const previous = this.files.get(event.path);
      if (previous && !previous.complete) this.removeFile(event.path);
      return;
    }
    if (event.type === "end") {
      const file = this.files.get(event.path);
      if (file) file.complete = true;
      return;
    }
    const match = event.match;
    let file = this.files.get(match.path);
    if (file?.complete) return;
    if (!file) {
      if (this.files.size >= this.limits.candidates) {
        this.exhaustedReason = `candidate budget (${this.limits.candidates} files)`;
        return this.exhaustedReason;
      }
      file = { path: match.path, matchCount: 0, definitionCount: 0, referenceCount: 0, matches: [], complete: false };
      this.files.set(match.path, file);
    }
    file.matchCount++;
    if (match.isDefinition) file.definitionCount++;
    if (match.kind === "reference") file.referenceCount++;
    if (Buffer.byteLength(match.line) > this.limits.snippetBytes || match.submatches.length > 32) file.truncatedMatches = (file.truncatedMatches ?? 0) + 1;
    match.line = Buffer.from(match.line).subarray(0, this.limits.snippetBytes).toString("utf8");
    match.submatches = match.submatches.slice(0, 32).map((span) => ({ ...span, text: Buffer.from(span.text).subarray(0, this.limits.snippetBytes).toString("utf8") }));
    const size = Buffer.byteLength(JSON.stringify(match));
    let replacement = -1;
    if (file.matches.length >= this.limits.snippetsPerFile) {
      const priority = (candidate: CodeMatch) => snippetPriority(candidate, this.ranking.intent, this.ranking.context);
      replacement = file.matches.reduce((worst, candidate, index) => {
        const previous = file!.matches[worst]!;
        return priority(candidate) < priority(previous) || (priority(candidate) === priority(previous) && candidate.lineNumber > previous.lineNumber) ? index : worst;
      }, 0);
      const previous = file.matches[replacement]!;
      if (priority(match) < priority(previous) || (priority(match) === priority(previous) && match.lineNumber >= previous.lineNumber)) return;
    }
    const released = replacement < 0 ? 0 : Buffer.byteLength(JSON.stringify(file.matches[replacement]));
    if (this.retainedBytes - released + size > this.limits.retainedBytes) return;
    if (replacement < 0) file.matches.push(match);
    else file.matches[replacement] = match;
    this.retainedBytes += size - released;
  }
}

export async function runRg(
  args: string[], cwd: string, roots: string[], request: SearchRequest,
  consume: (line: string) => string | undefined = (line) => request.consume(line),
  delimiter = "\n",
): Promise<SearchRun> {
  if (!request.checkpoint() || request.exhaustedReason) {
    const run: SearchRun = { roots, status: "partial", exitCode: null, signal: null, reason: request.exhaustedReason ?? String(request.signal.reason ?? "cancelled") };
    request.runs.push(run);
    return run;
  }
  const run = await new Promise<SearchRun>((resolve) => {
    const child = spawn("rg", args, { cwd });
    let buffer = "";
    let stderr = "";
    let reason: string | undefined;
    let error: string | undefined;
    const terminate = (message: string) => {
      reason ??= message;
      child.kill("SIGKILL");
    };
    const abort = () => terminate(String(request.signal.reason ?? "cancelled"));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (reason || error) return;
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf(delimiter)) >= 0) {
        if (!request.checkpoint()) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + delimiter.length);
        if (Buffer.byteLength(line) > request.limits.eventBytes) { terminate("rg event byte budget"); return; }
        if (!line) continue;
        try {
          const stop = consume(line);
          if (stop) { terminate(stop); return; }
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
          child.kill("SIGKILL");
          return;
        }
      }
      if (Buffer.byteLength(buffer) > request.limits.eventBytes) terminate("rg event byte budget");
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 16_384); });
    child.on("error", (failure) => { error = failure.message; });
    child.on("close", (exitCode, signal) => {
      request.signal.removeEventListener("abort", abort);
      if (buffer.trim() && !reason && !error) error = "Incomplete rg output record";
      const succeeded = !reason && !error && signal === null && (exitCode === 0 || exitCode === 1);
      resolve({
        roots, status: succeeded ? "complete" : reason ? "partial" : "failed", exitCode, signal, reason,
        error: error ?? (!succeeded && !reason ? `rg failed (exit ${exitCode}, signal ${signal}): ${stderr.trim()}` : undefined),
      });
    });
  }).catch((failure): SearchRun => ({ roots, status: "failed", exitCode: null, signal: null,
    error: failure instanceof Error ? failure.message : String(failure),
  }));
  request.runs.push(run);
  return run;
}

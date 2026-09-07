import { constants, type Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { DEFAULT_EXCLUDES, PACKAGE_SEARCH_EXCLUDES } from "./classifications.ts";
import { runRg, type SearchRequest } from "./retrieval.ts";
import { displaySearchRoot } from "./shared.ts";

export const RESOLUTION_LIMITS = {
  nodes: 200, edges: 500, relatedFiles: 50, rubyFiles: 25,
  sourceBytes: 256 * 1024, textBytes: 8 * 1024 * 1024,
  reads: 500, probes: 10_000, diagnostics: 128, autoloadRoots: 16, namespaceDepth: 64,
};

export class ProjectFiles {
  readonly skipped: string[] = [];
  readonly stats = { sourceReads: 0, bytesRead: 0, inventories: 0, omittedDiagnostics: 0, omittedFileCandidates: 0 };
  private readonly paths = new Map<string, Promise<string>>();
  private readonly metadata = new Map<string, Promise<Stats | undefined>>();
  private readonly texts = new Map<string, Promise<string | undefined>>();
  private reservedTextBytes = 0;
  private canonicalCwd?: string;
  private cwdResolution?: Promise<string>;

  constructor(readonly cwd: string, readonly request: SearchRequest, readonly limits = RESOLUTION_LIMITS) {}

  display(path: string): string {
    const direct = displaySearchRoot(this.cwd, path);
    return isAbsolute(direct) ? displaySearchRoot(this.canonicalCwd ?? this.cwd, path) : direct;
  }
  skip(reason: string): void {
    if (this.skipped.includes(reason)) return;
    if (this.skipped.length < this.limits.diagnostics) this.skipped.push(reason);
    else this.stats.omittedDiagnostics++;
  }
  omitFiles(count: number, reason: string): void {
    this.stats.omittedFileCandidates += count;
    this.skip(reason);
  }
  alive(): boolean {
    if (!this.request.signal.aborted) return true;
    this.skip(`resolution cancelled: ${String(this.request.signal.reason ?? "abort")}`);
    return false;
  }
  async canonical(path: string): Promise<string> {
    const absolute = resolve(this.cwd, path);
    if (!this.alive()) return absolute;
    this.cwdResolution ??= realpath(resolve(this.cwd)).catch(() => resolve(this.cwd));
    this.canonicalCwd ??= await this.cwdResolution;
    let cached = this.paths.get(absolute);
    if (!cached) {
      if (this.paths.size >= this.limits.probes) { this.skip("canonical path metadata budget"); return absolute; }
      cached = absolute === resolve(this.cwd) || absolute === this.canonicalCwd
        ? this.cwdResolution : realpath(absolute).catch(() => absolute);
      this.paths.set(absolute, cached);
    }
    return cached;
  }
  async fileStat(path: string): Promise<Stats | undefined> {
    if (!this.alive()) return;
    const absolute = resolve(this.cwd, path);
    let cached = this.metadata.get(absolute);
    if (!cached) {
      if (this.metadata.size >= this.limits.probes) { this.skip("filesystem metadata budget"); return; }
      cached = stat(absolute).catch(() => undefined);
      this.metadata.set(absolute, cached);
    }
    return cached;
  }
  async read(path: string, byteLimit = this.limits.sourceBytes): Promise<string | undefined> {
    if (!this.alive()) return;
    const absolute = await this.canonical(path);
    const key = `${absolute}\0${byteLimit}`;
    let cached = this.texts.get(key);
    if (!cached) {
      if (this.texts.size >= this.limits.reads) { this.skip(`source read budget at ${this.display(absolute)}`); return; }
      cached = this.readPrefix(absolute, byteLimit);
      this.texts.set(key, cached);
    }
    return cached;
  }
  private async readPrefix(path: string, byteLimit: number): Promise<string | undefined> {
    if (!this.alive()) return;
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
    if (!handle) { this.skip(`unreadable source ${this.display(path)}`); return; }
    let reserved = 0;
    let bytesRead = 0;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || !this.alive()) { this.skip(`unreadable source ${this.display(path)}`); return; }
      const available = Math.min(byteLimit, this.limits.textBytes - this.reservedTextBytes, stats.size);
      if (available <= 0 && stats.size > 0) { this.skip(`source cache byte budget at ${this.display(path)}`); return; }
      if (stats.size > available) this.skip(`source byte budget at ${this.display(path)} (${available}/${stats.size} bytes)`);
      reserved = available;
      this.reservedTextBytes += reserved;
      const buffer = Buffer.alloc(available);
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
      this.stats.sourceReads++;
      this.stats.bytesRead += bytesRead;
      return new TextDecoder().decode(buffer.subarray(0, bytesRead), { stream: stats.size > bytesRead });
    } catch {
      this.skip(`unreadable source ${this.display(path)}`);
      return;
    } finally {
      this.reservedTextBytes -= reserved - bytesRead;
      await handle.close();
    }
  }
  async json(path: string): Promise<Record<string, unknown> | undefined> {
    if (!(await this.fileStat(path))?.isFile()) return;
    const source = await this.read(path, 64 * 1024);
    if (source === undefined) return;
    try {
      const parsed: unknown = JSON.parse(source);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
    this.skip(`invalid manifest ${this.display(resolve(this.cwd, path))}`);
    return;
  }
  async list(root: string, packageSearch = false): Promise<string[]> {
    if (!this.alive()) return [];
    const absolute = await this.canonical(root);
    const metadata = await this.fileStat(absolute);
    if (metadata?.isFile()) return [absolute];
    if (!metadata?.isDirectory()) { this.skip(`unreadable directory ${this.display(absolute)}`); return []; }
    const key = `${absolute}\0${packageSearch}`;
    let cached = this.request.inventories.get(key);
    if (!cached) {
      cached = this.listDirectory(absolute, packageSearch);
      this.request.inventories.set(key, cached);
    }
    return cached;
  }
  private async listDirectory(directory: string, packageSearch: boolean): Promise<string[]> {
    if (!this.alive()) return [];
    const paths: string[] = [];
    const args = ["--files", "--null", "--hidden", "--color=never"];
    if (packageSearch) args.push("--no-ignore");
    for (const glob of packageSearch ? PACKAGE_SEARCH_EXCLUDES : DEFAULT_EXCLUDES) args.push("--glob", glob);
    args.push("--", ".");
    this.stats.inventories++;
    const run = await runRg(args, directory, [this.display(directory)], this.request, (path) => {
      if (paths.length >= this.request.limits.candidates) return "path inventory candidate budget";
      paths.push(resolve(directory, path));
    }, "\0");
    run.kind = "inventory";
    if (run.status !== "complete") {
      const reason = run.reason ?? run.error ?? `incomplete inventory at ${this.display(directory)}`;
      this.request.inventoryReasons.push(reason);
      this.skip(reason);
    }
    return paths;
  }
}

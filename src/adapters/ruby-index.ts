import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { addRgExcludes, normalizeRepoRelativePath, runGit } from "../shared.ts";
import { rubyAdapter } from "./ruby.ts";
import type { AdapterDefinition, NamespaceInfo, ParamInfo } from "./types.ts";

export interface IndexedDefinition {
  symbol: string;
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  owner?: string;
  singleton?: boolean;
  params?: ParamInfo[];
  returns?: string;
}

export interface IndexedNamespace {
  symbol: string;
  kind: "class" | "module";
  paths: string[];
  superclass?: string;
  mixins: string[];
}

export interface IndexedCallSite {
  path: string;
  line: number;
  receiver?: string;
  receiverType?: string;
  via?: string;
  inDef?: string;
}

interface FileEntry {
  definitions: IndexedDefinition[];
  namespaces: Array<Omit<IndexedNamespace, "paths"> & { path: string }>;
  callSites: Array<IndexedCallSite & { name: string }>;
}

interface SerializedIndex {
  version: number;
  root: string;
  treeHash: string;
  strings: string[];
  files: Array<[number, Array<[number, number, number, number, number, number, number, ParamInfo[] | 0, number]>, Array<[number, number, number, number[]]>, Array<[number, number, number, number, number, number]>]>;
}

class Interner {
  readonly strings: string[] = [];
  private readonly ids = new Map<string, number>();

  id(value: string | undefined): number {
    if (value === undefined) return -1;
    const existing = this.ids.get(value);
    if (existing !== undefined) return existing;
    const id = this.strings.length;
    this.strings.push(value);
    this.ids.set(value, id);
    return id;
  }
}

function serialize(root: string, treeHash: string, files: Record<string, FileEntry>): Buffer {
  const strings = new Interner();
  const payload: SerializedIndex = { version: INDEX_VERSION, root, treeHash, strings: [], files: [] };
  for (const [path, entry] of Object.entries(files)) {
    payload.files.push([
      strings.id(path),
      entry.definitions.map((def) => [strings.id(def.symbol), strings.id(def.name), strings.id(def.kind), def.startLine, def.endLine, strings.id(def.owner), def.singleton ? 1 : 0, def.params ?? 0, strings.id(def.returns)]),
      entry.namespaces.map((namespace) => [strings.id(namespace.symbol), namespace.kind === "class" ? 0 : 1, strings.id(namespace.superclass), namespace.mixins.map((mixin) => strings.id(mixin))]),
      entry.callSites.map((site) => [strings.id(site.name), site.line, strings.id(site.receiver), strings.id(site.receiverType), strings.id(site.via), strings.id(site.inDef)]),
    ]);
  }
  payload.strings = strings.strings;
  return gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
}

function deserialize(buffer: Buffer): { root: string; treeHash: string; version: number; files: Record<string, FileEntry> } {
  const payload = JSON.parse(gunzipSync(buffer).toString("utf8")) as SerializedIndex;
  const text = (id: number): string | undefined => (id < 0 ? undefined : payload.strings[id]);
  const files: Record<string, FileEntry> = {};
  for (const [pathId, defs, namespaces, sites] of payload.files) {
    const path = text(pathId)!;
    files[path] = {
      definitions: defs.map(([symbol, name, kind, startLine, endLine, owner, singleton, params, returns]) => ({
        symbol: text(symbol)!,
        name: text(name)!,
        kind: text(kind)!,
        path,
        startLine,
        endLine,
        owner: text(owner),
        singleton: singleton === 1 ? true : undefined,
        params: params === 0 ? undefined : params,
        returns: text(returns),
      })),
      namespaces: namespaces.map(([symbol, kind, superclass, mixins]) => ({
        symbol: text(symbol)!,
        kind: kind === 0 ? "class" : "module",
        path,
        superclass: text(superclass),
        mixins: mixins.map((mixin) => text(mixin)!),
      })),
      callSites: sites.map(([name, line, receiver, receiverType, via, inDef]) => ({
        name: text(name)!,
        path,
        line,
        receiver: text(receiver),
        receiverType: text(receiverType),
        via: text(via),
        inDef: text(inDef),
      })),
    };
  }
  return { root: payload.root, treeHash: payload.treeHash, version: payload.version, files };
}

export interface RubyIndex {
  root: string;
  treeHash: string;
  fileCount: number;
  definitions: IndexedDefinition[];
  bySymbol: Map<string, IndexedDefinition[]>;
  byName: Map<string, IndexedDefinition[]>;
  namespaces: Map<string, IndexedNamespace>;
  callSites: Map<string, IndexedCallSite[]>;
  builtMs: number;
  cacheHit: boolean;
  overlayFiles: number;
  skipped?: string;
}

export interface RubyIndexOptions {
  cwd: string;
  root: string;
  cacheDir: string;
  maxFiles?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

const INDEX_VERSION = 1;
const DEFAULT_MAX_FILES = 8000;

function rgFiles(root: string, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const args = ["--files", "--hidden", "--color=never", "-t", "ruby"];
  addRgExcludes(args);
  args.push(root);
  return new Promise((resolvePromise) => {
    execFile("rg", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, signal, timeout: 30_000 }, (_error, stdout) => {
      resolvePromise(String(stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean).map(normalizeRepoRelativePath));
    });
  });
}

function fileEntry(path: string, source: string): FileEntry | undefined {
  const facts = rubyAdapter.parse(path, source);
  if (!facts) return undefined;
  const definitions: IndexedDefinition[] = facts.definitions.map((def: AdapterDefinition) => ({
    symbol: def.symbol,
    name: def.name,
    kind: def.kind,
    path,
    startLine: def.startLine,
    endLine: def.endLine,
    owner: def.owner,
    singleton: def.singleton,
    params: def.params?.some((param) => param.type) ? def.params : undefined,
    returns: def.returns,
  }));
  const namespaces = facts.namespaces.map((namespace: NamespaceInfo) => ({
    symbol: namespace.symbol,
    kind: namespace.kind,
    path,
    superclass: namespace.superclass,
    mixins: namespace.mixins,
  }));
  const callSites: FileEntry["callSites"] = [];
  for (const def of facts.definitions) {
    if (def.kind === "class" || def.kind === "module" || def.kind === "constant") continue;
    for (const site of rubyAdapter.calls(facts, def)) {
      if (site.relationship !== "calls" && site.source !== "constant") continue;
      callSites.push({ name: site.name, path, line: site.line, receiver: site.receiver, receiverType: site.receiverType, via: site.via, inDef: def.symbol });
    }
  }
  return { definitions, namespaces, callSites };
}

function assemble(root: string, treeHash: string, files: Record<string, FileEntry>, builtMs: number, cacheHit: boolean, overlayFiles: number): RubyIndex {
  const definitions: IndexedDefinition[] = [];
  const bySymbol = new Map<string, IndexedDefinition[]>();
  const byName = new Map<string, IndexedDefinition[]>();
  const namespaces = new Map<string, IndexedNamespace>();
  const callSites = new Map<string, IndexedCallSite[]>();
  for (const entry of Object.values(files)) {
    for (const def of entry.definitions) {
      definitions.push(def);
      bySymbol.set(def.symbol, [...(bySymbol.get(def.symbol) ?? []), def]);
      byName.set(def.name, [...(byName.get(def.name) ?? []), def]);
    }
    for (const namespace of entry.namespaces) {
      const existing = namespaces.get(namespace.symbol);
      if (existing) {
        if (!existing.paths.includes(namespace.path)) existing.paths.push(namespace.path);
        existing.superclass ??= namespace.superclass;
        for (const mixin of namespace.mixins) if (!existing.mixins.includes(mixin)) existing.mixins.push(mixin);
      } else {
        namespaces.set(namespace.symbol, { symbol: namespace.symbol, kind: namespace.kind, paths: [namespace.path], superclass: namespace.superclass, mixins: [...namespace.mixins] });
      }
    }
    for (const site of entry.callSites) {
      const { name, ...rest } = site;
      callSites.set(name, [...(callSites.get(name) ?? []), rest]);
    }
  }
  return { root, treeHash, fileCount: Object.keys(files).length, definitions, bySymbol, byName, namespaces, callSites, builtMs, cacheHit, overlayFiles };
}

async function treeHashFor(cwd: string, root: string, signal?: AbortSignal): Promise<string | undefined> {
  const spec = root === "." || root === "" ? "HEAD^{tree}" : `HEAD:${root}`;
  try {
    return (await runGit(["rev-parse", spec], cwd, signal)).trim();
  } catch {
    return undefined;
  }
}

async function dirtyFiles(cwd: string, root: string, signal?: AbortSignal): Promise<{ modified: string[]; deleted: string[]; untracked: string[] }> {
  const result = { modified: [] as string[], deleted: [] as string[], untracked: [] as string[] };
  let output: string;
  try {
    output = await runGit(["status", "--porcelain", "--untracked-files=all", "--", root === "" ? "." : root], cwd, signal);
  } catch {
    return result;
  }
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const path = normalizeRepoRelativePath(line.slice(3).split(" -> ").pop()!.trim());
    if (!/\.(rb|rake)$/.test(path)) continue;
    if (status.includes("?")) result.untracked.push(path);
    else if (status.includes("D")) result.deleted.push(path);
    else result.modified.push(path);
  }
  return result;
}

function cacheKey(cwd: string, root: string, treeHash: string): string {
  return createHash("sha256").update(`${cwd}\n${root}\n${treeHash}\n${INDEX_VERSION}`).digest("hex").slice(0, 24);
}

export async function buildRubyIndex(options: RubyIndexOptions): Promise<RubyIndex> {
  const started = Date.now();
  const root = normalizeRepoRelativePath(options.root === "." ? "" : options.root) || ".";
  const log = options.log ?? (() => {});
  const ready = await rubyAdapter.ready();
  if (!ready) return { ...assemble(root, "none", {}, Date.now() - started, false, 0), skipped: "Prism parser unavailable" };

  const files = await rgFiles(root, options.cwd, options.signal);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  if (files.length > maxFiles) {
    return { ...assemble(root, "none", {}, Date.now() - started, false, 0), skipped: `${files.length} Ruby files under ${root} exceed the index cap of ${maxFiles}` };
  }

  const treeHash = (await treeHashFor(options.cwd, root, options.signal)) ?? "worktree";
  const dirty = await dirtyFiles(options.cwd, root, options.signal);
  const dirtySet = new Set([...dirty.modified, ...dirty.deleted, ...dirty.untracked]);
  const cachePath = join(options.cacheDir, `${cacheKey(options.cwd, root, treeHash)}.json.gz`);

  let base: Record<string, FileEntry> | undefined;
  let cacheHit = false;
  if (treeHash !== "worktree") {
    try {
      const parsed = deserialize(await readFile(cachePath));
      if (parsed.version === INDEX_VERSION && parsed.treeHash === treeHash && parsed.root === root) {
        base = parsed.files;
        cacheHit = true;
      }
    } catch {
      base = undefined;
    }
  }

  if (!base) {
    log(`Indexing code changes for agents… parsing ${files.length} Ruby files under ${root}`);
    base = {};
    const tracked = files.filter((path) => !dirty.untracked.includes(path));
    for (const path of tracked) {
      if (options.signal?.aborted) break;
      let source: string | undefined;
      if (dirtySet.has(path) && treeHash !== "worktree") {
        source = await runGit(["show", `HEAD:${path}`], options.cwd, options.signal).catch(() => undefined);
      } else {
        source = await readFile(resolve(options.cwd, path), "utf8").catch(() => undefined);
      }
      if (source === undefined) continue;
      const entry = fileEntry(path, source);
      if (entry) base[path] = entry;
    }
    for (const path of dirty.deleted) {
      const source = await runGit(["show", `HEAD:${path}`], options.cwd, options.signal).catch(() => undefined);
      if (source === undefined) continue;
      const entry = fileEntry(path, source);
      if (entry) base[path] = entry;
    }
    if (treeHash !== "worktree" && !options.signal?.aborted) {
      await mkdir(options.cacheDir, { recursive: true, mode: 0o700 });
      const temp = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temp, serialize(root, treeHash, base), { mode: 0o600 });
      await rename(temp, cachePath);
    }
  }

  const merged: Record<string, FileEntry> = { ...base };
  let overlayFiles = 0;
  for (const path of dirty.deleted) {
    if (merged[path]) {
      delete merged[path];
      overlayFiles += 1;
    }
  }
  for (const path of [...dirty.modified, ...dirty.untracked]) {
    const source = await readFile(resolve(options.cwd, path), "utf8").catch(() => undefined);
    if (source === undefined) continue;
    const entry = fileEntry(path, source);
    if (entry) {
      merged[path] = entry;
      overlayFiles += 1;
    }
  }

  return assemble(root, treeHash, merged, Date.now() - started, cacheHit, overlayFiles);
}

export function ancestorsOf(index: RubyIndex, symbol: string, limit = 12): string[] {
  const seen: string[] = [];
  const queue = [symbol];
  while (queue.length && seen.length < limit) {
    const current = queue.shift()!;
    if (seen.includes(current)) continue;
    seen.push(current);
    const namespace = index.namespaces.get(current);
    if (!namespace) continue;
    for (const mixin of namespace.mixins) queue.push(resolveConstant(index, mixin, current) ?? mixin);
    if (namespace.superclass) queue.push(resolveConstant(index, namespace.superclass, current) ?? namespace.superclass);
  }
  return seen;
}

export function resolveConstant(index: RubyIndex, reference: string, fromSymbol: string | undefined): string | undefined {
  const clean = reference.replace(/^::/, "");
  if (reference.startsWith("::")) return index.namespaces.has(clean) || index.bySymbol.has(clean) ? clean : undefined;
  const scopes = fromSymbol ? fromSymbol.split(/[#. ]/)[0]!.split("::") : [];
  for (let depth = scopes.length; depth >= 0; depth -= 1) {
    const candidate = [...scopes.slice(0, depth), clean].join("::");
    if (index.namespaces.has(candidate) || index.bySymbol.has(candidate)) return candidate;
  }
  return undefined;
}

export function displayRoot(cwd: string, root: string): string {
  const absolute = isAbsolute(root) ? root : resolve(cwd, root);
  const rel = relative(cwd, absolute);
  return rel === "" ? "." : normalizeRepoRelativePath(rel);
}

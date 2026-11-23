import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { rubyAdapter } from "./adapters/ruby.ts";
import { ancestorsOf, indexOfSources, lookupMethod, type RubyIndex } from "./adapters/ruby-index.ts";
import { frameworkKind, type EntryKind } from "./adapters/ruby-entries.ts";
import { readRoutes, type Route } from "./adapters/ruby-routes.ts";
import { addRgExcludes, isRealPathInsideCwd } from "./sparsity-shared.ts";
import { findRoot, ofLanguage, TEST_GLOBS } from "./sparsity.ts";
import { camelToSnake, displaySearchRoot, normalizeRepoRelativePath, uniqueValues } from "./shared.ts";

/**
 * How a test of an entry point was found: its file is named after the entry's class (`path`), a test class or
 * `describe` names the class (`class`), it requests the action through a URL helper or a path of a route to it
 * (`route`), or it enqueues or performs the job (`enqueue`, `perform`).
 */
export type EntryTestFinding = "path" | "class" | "route" | "enqueue" | "perform";

export interface EntryTestHit {
  path: string;
  line: number;
  text: string;
  found: EntryTestFinding;
  /** What matched: the class the file is named after, the request and the route it reaches, or the job call. */
  detail: string;
}

/** The tests that drive an entry point, as search finds them. Whether one executes particular lines is not a search fact. */
export interface EntryTests {
  entry: { symbol: string; kind: EntryKind; exact: boolean; path: string; line: number };
  tests: EntryTestHit[];
  /** Why the list may be partial: no routes read, statements the routes reader skipped, a search that timed out. */
  notes: string[];
}

interface Hit {
  path: string;
  line: number;
  text: string;
}

const RG_TIMEOUT_MS = 8_000;
const ANCESTRY_ROUNDS = 6;
const REQUEST = "(?:^|[^\\w.])(get|post|put|patch|delete|head|visit)\\s*\\(?\\s*";
const PERFORMS = /\.(perform_now|perform_inline)\b|\.new\b.*\.(perform)\b|\b(assert_performed_with|have_been_performed|have_performed_job)\b/;
const ENQUEUES = /\.(perform_later|perform_async|perform_in|perform_at|perform_bulk|set)\b|\b(assert_enqueued_with|assert_enqueued_jobs|assert_no_enqueued_jobs|have_been_enqueued|have_enqueued_job|have_enqueued_sidekiq_job)\b/;
const TEST_HEADER = /^\s*(?:class\s+[A-Z]|(?:RSpec\.)?(?:describe|feature)\b)/;
const TEXT_LIMIT = 160;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const snakePath = (symbol: string) => symbol.split("::").map(camelToSnake).join("/");
const lastSegment = (symbol: string) => symbol.split("::").pop()!;

/** `OrdersController#create`, `Admin::OrdersController`, `ReceiptJob`; or a method name when `path` is a Ruby file. */
function parseQuery(query: string, path: string | undefined): { className?: string; method?: string } | undefined {
  const trimmed = query.trim();
  const qualified = trimmed.match(/^(?:::)?([A-Z]\w*(?:::[A-Z]\w*)*)(?:#([a-z_]\w*[?!]?))?$/);
  if (qualified) return { className: qualified[1], method: qualified[2] };
  if (path && /\.(?:rb|rake)$/.test(path) && /^[a-z_]\w*[?!]?$/.test(trimmed)) return { method: trimmed };
  return undefined;
}

/** A route path as a regex for the quoted path a test requests: dynamic segments match any one segment. */
function pathPattern(path: string): string {
  return path.split("/").map((segment) => (/^[:*]/.test(segment) ? "[^/\"'?]+" : escape(segment))).join("/");
}

class Files {
  readonly notes: string[] = [];

  constructor(private readonly cwd: string, private readonly signal?: AbortSignal) {}

  async read(path: string): Promise<string | undefined> {
    const absolute = resolve(this.cwd, path);
    if (!(await isRealPathInsideCwd(this.cwd, absolute))) return undefined;
    return readFile(absolute, "utf8").catch(() => undefined);
  }

  async exists(path: string): Promise<boolean> {
    return (await stat(resolve(this.cwd, path)).catch(() => undefined))?.isFile() === true;
  }

  private rg(args: string[]): Promise<string> {
    const full = ["--color=never", "--hidden"];
    addRgExcludes(full);
    full.push(...args);
    return new Promise((resolvePromise) => {
      execFile("rg", full, { cwd: this.cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, signal: this.signal, timeout: RG_TIMEOUT_MS }, (error, stdout) => {
        if (error && (error as { killed?: boolean }).killed) this.notes.push(`a ripgrep search timed out after ${RG_TIMEOUT_MS} ms; the list may be partial.`);
        resolvePromise(String(stdout ?? ""));
      });
    });
  }

  /** Ruby files under `root` whose path ends with `suffix`. */
  async named(suffix: string, root: string): Promise<string[]> {
    const output = await this.rg(["--files", "-t", "ruby", "--glob", `**/${suffix}`, root]);
    return output.split("\n").map((line) => line.trim()).filter(Boolean).map(normalizeRepoRelativePath);
  }

  /** Ruby files under `root` with a line matching one of `patterns`. */
  async matching(patterns: string[], root: string): Promise<string[]> {
    const output = await this.rg(["-l", "-t", "ruby", ...patterns.flatMap((pattern) => ["-e", pattern]), root]);
    return output.split("\n").map((line) => line.trim()).filter(Boolean).map(normalizeRepoRelativePath);
  }

  /** Lines of Ruby test files under `root` that match one of `patterns`. */
  async testLines(patterns: string[], root: string): Promise<Hit[]> {
    if (!patterns.length) return [];
    const output = await this.rg(["--json", "--line-number", "-t", "ruby", ...TEST_GLOBS, ...patterns.flatMap((pattern) => ["-e", pattern]), root]);
    const hits: Hit[] = [];
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const data = event?.type === "match" ? event.data : undefined;
      if (typeof data?.path?.text !== "string" || typeof data?.lines?.text !== "string" || typeof data?.line_number !== "number") continue;
      const path = normalizeRepoRelativePath(data.path.text);
      // The test globs override `-t ruby`, so other languages' test files come back too.
      if (ofLanguage(path, "ruby")) hits.push({ path, line: data.line_number, text: data.lines.text.replace(/\r?\n$/, "") });
    }
    return hits;
  }
}

/** The class an entry query names, with the sources read to find it and its ancestors. */
async function locateClass(target: { className?: string; method?: string }, path: string | undefined, files: Files): Promise<{ symbol: string; sources: Map<string, string> } | undefined> {
  const sources = new Map<string, string>();
  const candidates = path
    ? [path]
    : uniqueValues([
      ...await files.named(`${snakePath(target.className!)}.rb`, "."),
      ...await files.matching([`^\\s*class\\s+(\\w+::)*${escape(lastSegment(target.className!))}\\b`], "."),
    ]);
  for (const candidate of candidates) {
    const source = await files.read(candidate);
    if (source === undefined) continue;
    const facts = rubyAdapter.parse(candidate, source, true);
    if (!facts) continue;
    const symbol = target.className
      ? facts.namespaces.find((item) => item.kind === "class" && (item.symbol === target.className || item.symbol.endsWith(`::${target.className}`)))?.symbol
      : facts.definitions.find((item) => item.name === target.method && item.kind === "method" && item.owner)?.owner;
    if (!symbol) continue;
    sources.set(candidate, source);
    return { symbol, sources };
  }
  return undefined;
}

/** Reads the files of `symbol`'s ancestors, by Rails file naming, until one is a framework class or none is left to read. */
async function readAncestry(symbol: string, sources: Map<string, string>, files: Files): Promise<RubyIndex> {
  const tried = new Set<string>();
  let index = indexOfSources(sources);
  for (let round = 0; round < ANCESTRY_ROUNDS; round += 1) {
    const ancestors = ancestorsOf(index, symbol);
    if (frameworkKind(ancestors.slice(1))) break;
    const missing = ancestors.filter((name) => !index.namespaces.has(name) && !tried.has(name));
    if (!missing.length) break;
    for (const name of missing) {
      tried.add(name);
      for (const path of await files.named(`${snakePath(name)}.rb`, ".")) {
        const source = await files.read(path);
        if (source !== undefined) sources.set(path, source);
      }
    }
    index = indexOfSources(sources);
  }
  return index;
}

/** Test files named after the entry's class by Rails and RSpec conventions, at their first class or `describe` line. */
async function byPath(kind: EntryKind, symbol: string, root: string, files: Files): Promise<EntryTestHit[]> {
  const name = kind === "controller" ? snakePath(symbol.replace(/Controller$/, "")) : snakePath(symbol);
  const conventional = kind === "controller"
    ? [`test/controllers/${name}_controller_test.rb`, `test/integration/${name}_test.rb`, `test/integration/${name}_controller_test.rb`, `test/system/${name}_test.rb`,
      `spec/requests/${name}_spec.rb`, `spec/requests/${name}_controller_spec.rb`, `spec/controllers/${name}_controller_spec.rb`, `spec/system/${name}_spec.rb`, `spec/features/${name}_spec.rb`]
    : [`test/jobs/${name}_test.rb`, `spec/jobs/${name}_spec.rb`, `test/workers/${name}_test.rb`, `spec/workers/${name}_spec.rb`];
  const hits: EntryTestHit[] = [];
  for (const relative of conventional) {
    const path = root === "." ? relative : `${root}/${relative}`;
    if (!(await files.exists(path))) continue;
    const lines = (await files.read(path))?.split("\n") ?? [];
    const index = Math.max(0, lines.findIndex((line) => TEST_HEADER.test(line)));
    hits.push({ path, line: index + 1, text: (lines[index] ?? "").trim(), found: "path", detail: `named after ${symbol}` });
  }
  return hits;
}

/** Requests through a URL helper or a quoted path of a route to the entry, with a verb the route accepts. */
function byRoute(hits: Hit[], routes: Route[]): EntryTestHit[] {
  const found: EntryTestHit[] = [];
  const helpers = routes.filter((route) => route.helper);
  const helperRequest = new RegExp(`${REQUEST}(${helpers.map((route) => escape(route.helper!)).join("|") || "(?!)"})_(path|url)\\b`);
  const paths = routes.map((route) => ({ route, pattern: new RegExp(`${REQUEST}(["'])(${pathPattern(route.path)})(?:\\?[^"']*)?\\2`) }));
  for (const hit of hits) {
    const viaHelper = hit.text.match(helperRequest);
    if (viaHelper) {
      const verb = viaHelper[1]!;
      const route = helpers.find((item) => item.helper === viaHelper[2] && accepts(item, verb));
      if (route) found.push({ ...hit, text: hit.text.trim(), found: "route", detail: `${verb} ${viaHelper[2]}_${viaHelper[3]} → ${describeRoute(route)}` });
      continue;
    }
    for (const { route, pattern } of paths) {
      const literal = hit.text.match(pattern);
      if (!literal || !accepts(route, literal[1]!)) continue;
      found.push({ ...hit, text: hit.text.trim(), found: "route", detail: `${literal[1]} "${literal[3]}" → ${describeRoute(route)}` });
      break;
    }
  }
  return found;
}

const accepts = (route: Route, verb: string) => route.verbs.includes(verb === "visit" ? "GET" : verb.toUpperCase());
const describeRoute = (route: Route) => `${route.controller}#${route.action} (${route.verbs.join("|")} ${route.path})`;

/** Lines naming the job that enqueue or perform it. */
function byJobCall(hits: Hit[]): EntryTestHit[] {
  return hits.flatMap((hit): EntryTestHit[] => {
    const performs = hit.text.match(PERFORMS);
    if (performs) return [{ ...hit, text: hit.text.trim(), found: "perform", detail: performs.slice(1).find(Boolean)! }];
    const enqueues = hit.text.match(ENQUEUES);
    return enqueues ? [{ ...hit, text: hit.text.trim(), found: "enqueue", detail: enqueues.slice(1).find(Boolean)! }] : [];
  });
}

/**
 * For a query naming a controller action or a job (`OrdersController#create`, `ReceiptJob`, or a method name with
 * `path` set to its Ruby file), the tests that drive it: by file naming, by test class, by route (when the component's
 * `config/routes.rb` parses) and by enqueue or perform calls. Undefined when the query names no class the framework
 * calls, read from its declared ancestors.
 */
export async function findEntryTests(query: string, path: string | undefined, cwd: string, signal?: AbortSignal): Promise<EntryTests | undefined> {
  const relativePath = path ? displaySearchRoot(cwd, resolve(cwd, path)) : undefined;
  const target = parseQuery(query, relativePath);
  if (!target || !(await rubyAdapter.ready())) return undefined;
  const files = new Files(cwd, signal);
  const located = await locateClass(target, relativePath, files);
  if (!located) return undefined;
  const { symbol, sources } = located;
  const index = await readAncestry(symbol, sources, files);
  const kind = frameworkKind(ancestorsOf(index, symbol).slice(1));
  // Tests are found by the conventions of controllers and jobs; a mailer's or a channel's are not read here.
  if (kind !== "controller" && kind !== "job") return undefined;

  const method = kind === "job" ? target.method ?? "perform" : target.method;
  const def = method ? lookupMethod(index, symbol, method, false)[0] : undefined;
  const at = def ?? (index.bySymbol.get(symbol) ?? []).find((item) => item.kind === "class");
  if (!at) return undefined;
  const root = displaySearchRoot(cwd, await findRoot(cwd, resolve(cwd, at.path)));
  const notes = files.notes;

  let routes: Route[] = [];
  if (kind === "controller") {
    const routesPath = root === "." ? "config/routes.rb" : `${root}/config/routes.rb`;
    const source = await files.read(routesPath);
    const table = source === undefined ? undefined : readRoutes(source);
    if (source === undefined) notes.push(`${routesPath} not found; tests are not matched by route.`);
    else if (!table) notes.push(`${routesPath} does not parse; tests are not matched by route.`);
    else if (table.unread.length) notes.push(`${routesPath}: ${table.unread.length} statement${table.unread.length === 1 ? "" : "s"} not read (${table.unread.slice(0, 5).map((item) => item.text).join("; ")}); routes they draw are not matched.`);
    const controller = snakePath(symbol.replace(/Controller$/, ""));
    routes = (table?.routes ?? []).filter((route) => route.controller === controller && (!method || route.action === method));
  }

  const last = escape(lastSegment(symbol));
  const named = await files.testLines([`^\\s*class\\s+(\\w+::)*${last}Test\\b`, `\\bdescribe\\s*\\(?\\s*(::)?(\\w+::)*${last}\\b`], root);
  const requests = routes.length ? await files.testLines([
    ...(routes.some((route) => route.helper) ? [`${REQUEST}(${routes.flatMap((route) => route.helper ? [escape(route.helper)] : []).join("|")})_(path|url)\\b`] : []),
    `${REQUEST}["'](${routes.map((route) => pathPattern(route.path)).join("|")})(\\?[^"']*)?["']`,
  ], root) : [];
  const jobCalls = kind === "job" ? await files.testLines([`\\b${last}\\b`], root) : [];

  const tests = new Map<string, EntryTestHit>();
  const add = (hit: EntryTestHit) => {
    const key = `${hit.path}:${hit.line}`;
    if (!tests.has(key)) tests.set(key, { ...hit, text: hit.text.length > TEXT_LIMIT ? `${hit.text.slice(0, TEXT_LIMIT)}…` : hit.text });
  };
  for (const hit of await byPath(kind, symbol, root, files)) add(hit);
  for (const hit of named) add({ ...hit, text: hit.text.trim(), found: "class", detail: `names ${lastSegment(symbol)}` });
  for (const hit of byRoute(requests, routes)) add(hit);
  for (const hit of byJobCall(jobCalls)) add(hit);

  return {
    entry: { symbol: method ? `${symbol}#${method}` : symbol, kind, exact: kind === "job" || Boolean(method && routes.length), path: at.path, line: at.startLine },
    tests: [...tests.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line),
    notes: uniqueValues(notes),
  };
}

export function formatEntryTests(result: EntryTests): string {
  const { entry, tests } = result;
  const how = entry.kind === "job" ? "job" : entry.exact ? "controller, routed" : "controller, no route read names it";
  const out = [
    `ENTRY POINT ${entry.symbol} (${how}) ${entry.path}:${entry.line}`,
    `Tests that drive it, found by file name, test class, route or job call (${tests.length}). Search does not show whether a test executes particular lines; run it with coverage.`,
  ];
  for (const test of tests) out.push(`  ${test.path}:${test.line} [${test.found}] ${test.detail}  \`${test.text}\``);
  if (!tests.length) out.push("  none found");
  for (const note of result.notes) out.push(`  note: ${note}`);
  return out.join("\n");
}

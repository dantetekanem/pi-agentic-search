import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { addRgExcludes, ensureInsideCwd, ensureRealPathInsideCwd, isRealPathInsideCwd, jsImportCandidatePaths } from "./sparsity-shared.ts";
import { rubyAdapter } from "./adapters/ruby.ts";
import { tsAdapter, TsPrograms } from "./adapters/ts.ts";
import { appendMetricsLine, edgeMetrics, indexMetrics } from "./metrics.ts";
import { ancestorsOf, buildRubyIndex, resolveConstant as resolveIndexedConstant, type IndexedDefinition, type RubyIndex } from "./adapters/ruby-index.ts";
import type { CallSite as AdapterCallSite, FileFacts } from "./adapters/types.ts";
import {
  camelToSnake,
  displaySearchRoot,
  normalizeRepoRelativePath,
  uniqueValues,
} from "./shared.ts";

export type Language = "ruby" | "javascript";
export type Resolution = "exact" | "static_candidate" | "ambiguous" | "unresolved" | "external" | "local";

export type EdgeVia = "checker" | "typed" | "assigned" | "ivar" | "named" | "self" | "lexical" | "constant" | "superclass" | "same_file" | "import" | "name_only";

export const EDGE_LABELS = "Resolution: exact (the definition the name points to), static_candidate (found by name; not runtime proof), ambiguous (several candidates), unresolved (nothing found; reason given), external (a package or outside this root), local (a variable inside the same definition). How: checker (TypeScript type checker), typed (sig/RBS/YARD annotation), assigned (from an assignment), ivar (set in initialize), self (the owner or its ancestors), lexical (constant nesting), constant (explicit receiver constant), superclass, same_file, import (followed an import), named (guessed from a variable name), name_only (root-wide name match). Trust falls in that order; the last two are guesses.";
export type Truncation = "none" | "max_nodes" | "budget" | "rg_timeout";

export interface SparsityNode {
  id: string;
  path: string;
  symbol: string;
  kind: string;
  language: Language;
  startLine: number;
  endLine: number;
  fingerprint: string;
  snippet: string;
  depth: number;
}

export interface SparsityEdge {
  from: string;
  to?: string;
  name: string;
  relationship: "calls" | "references" | "called_by";
  resolution: Resolution;
  via?: EdgeVia;
  line: number;
  candidates?: string[];
  note?: string;
}

export interface SparsityCoverage {
  root: string;
  maxDepth: number;
  depthReached: number;
  vicinity: number;
  nodes: number;
  edges: number;
  unresolved: number;
  truncatedBy: Truncation;
  frontier: string[];
  cycles: string[];
  rgCalls: number;
  elapsedMs: number;
  notes: string[];
}

export interface SparsityResult {
  target: { path: string; line: number; language: Language };
  anchor: SparsityNode;
  nodes: SparsityNode[];
  edges: SparsityEdge[];
  coverage: SparsityCoverage;
}

export interface SparsityOptions {
  cwd: string;
  target: string;
  maxDepth: number;
  vicinity: number;
  maxNodes: number;
  root?: string;
  callers: boolean;
  budgetMs: number;
  indexCacheDir?: string;
  metricsLog?: string;
  signal?: AbortSignal;
}

export function describeRubyIndex(index: RubyIndex | undefined): string | undefined {
  if (!index) return undefined;
  if (index.skipped) return `Ruby index for ${index.root} skipped: ${index.skipped}; name-based ripgrep resolution used instead.`;
  return `Ruby index for ${index.root}: ${index.fileCount} files, ${index.definitions.length} definitions, ${index.namespaces.size} namespaces, ${index.cacheHit ? "cache hit" : "built cold"}${index.overlayFiles ? `, ${index.overlayFiles} dirty files overlaid` : ""}, ${index.builtMs} ms.`;
}

export interface Definition {
  name: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface CollectorOptions {
  cwd: string;
  maxDepth: number;
  vicinity: number;
  maxNodes: number;
  budgetMs: number;
  signal?: AbortSignal;
}

export interface CollectorShared {
  budget?: Budget;
  nextId?: () => string;
  expandedCount?: () => number;
  rubyIndex?: RubyIndex;
  rubyReady?: boolean;
  tsPrograms?: TsPrograms;
}

export interface ReferenceHit {
  node: SparsityNode;
  def: Definition;
  line: number;
  text: string;
  test: boolean;
}

export type QueueItem = { node: SparsityNode; def: Definition; depth: number; ancestry: string[]; focus?: number[] };

type CallSite = AdapterCallSite;

interface Candidate {
  path: string;
  line: number;
  text: string;
  symbol?: string;
}

interface RgHit {
  path: string;
  line: number;
  text: string;
}

interface ConstantResolution {
  candidates: Candidate[];
  note?: string;
}

const RUBY_EXTENSIONS = new Set([".rb", ".rake"]);
const JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]);
const ROOT_MARKERS = ["component.yml", "package.json", "Gemfile", ".git"];
const RG_CALL_TIMEOUT_MS = 8_000;
const MAX_CALLS_PER_NODE = 16;
const MAX_CANDIDATES_PER_CALL = 4;
const MAX_CALLERS = 8;
const MAX_CALLER_FILES = 40;

const EXPANDABLE_KINDS = new Set(["method", "singleton_method", "scope", "define_method", "class_method", "function", "component", "test", "it", "describe", "context", "scenario"]);

const RUBY_KEYWORDS = new Set([
  "def", "end", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "then", "begin", "rescue",
  "ensure", "return", "yield", "case", "when", "and", "or", "not", "nil", "true", "false", "self", "super", "class",
  "module", "require", "require_relative", "raise", "fail", "lambda", "proc", "loop", "next", "break", "redo", "retry",
  "alias", "undef", "defined?", "private", "public", "protected", "module_function", "attr_reader", "attr_accessor",
  "attr_writer", "include", "extend", "prepend", "sig", "params", "returns", "void", "puts", "p", "pp", "print",
  "block_given?", "binding", "freeze", "frozen?", "__method__", "extend", "using", "refine",
]);

const RUBY_COMMON_METHODS = new Set([
  "new", "each", "each_with_index", "each_with_object", "map", "flat_map", "select", "reject", "filter", "filter_map",
  "find", "detect", "any?", "all?", "none?", "empty?", "present?", "blank?", "presence", "nil?", "is_a?", "kind_of?",
  "respond_to?", "send", "public_send", "try", "tap", "then", "to_s", "to_sym", "to_i", "to_f", "to_a", "to_h",
  "to_proc", "to_json", "to_param", "inspect", "dup", "clone", "merge", "merge!", "fetch", "dig", "key?", "keys",
  "values", "first", "last", "size", "count", "length", "sum", "min", "max", "sort", "sort_by", "group_by", "uniq",
  "compact", "flatten", "join", "split", "strip", "downcase", "upcase", "include?", "exclude?", "start_with?",
  "end_with?", "gsub", "sub", "match", "match?", "format", "where", "not", "find_by", "find_by!", "find_or_create_by",
  "find_or_create_by!", "find_or_initialize_by", "create_or_find_by", "create", "create!", "update", "update!",
  "save", "save!", "destroy", "destroy!", "exists?", "pluck", "order", "limit", "offset", "joins", "includes",
  "preload", "eager_load", "left_joins", "distinct", "transaction", "with_lock", "lock!", "reload", "valid?",
  "errors", "assign_attributes", "attributes", "id", "class", "name", "logger", "info", "debug", "warn", "error",
  "render", "redirect_to", "head", "request", "response", "session", "cookies", "flash", "must", "let", "cast",
  "unsafe", "nilable", "reverse", "zip", "take", "drop", "each_slice", "reduce", "inject", "index_by", "sum",
  "abs", "round", "floor", "ceil", "positive?", "negative?", "zero?", "today", "now", "current", "ago", "from_now",
  "delete", "delete_if", "with_indifferent_access", "except", "slice", "symbolize_keys", "stringify_keys",
  "deep_symbolize_keys", "deep_stringify_keys", "each_pair", "to_set", "to_i", "in?", "presence_in", "squish",
  "titleize", "humanize", "underscore", "camelize", "pluralize", "singularize", "truncate", "sample", "shuffle",
  "index", "find_index", "each_with_index", "partition", "chunk_while", "tally", "min_by", "max_by", "sum",
  "encrypt_and_sign", "decrypt_and_verify", "call", "perform_later", "perform_now", "set", "enqueue",
  "hours", "minutes", "days", "seconds", "weeks", "months", "years", "message", "backtrace", "stubs", "expects",
  "returns", "with", "assert", "assert_equal", "refute", "test", "setup", "teardown", "describe", "it", "context",
]);

const JS_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "instanceof", "new", "function", "await", "async",
  "void", "delete", "in", "of", "yield", "super", "this", "import", "export", "default", "class", "extends",
  "const", "let", "var", "throw", "try", "finally", "else", "do", "case", "break", "continue", "as", "satisfies",
  "require", "constructor", "get", "set", "static", "readonly", "declare", "namespace", "module", "type",
  "interface", "enum", "implements", "keyof", "infer", "is", "abstract", "override", "public", "private",
  "protected",
]);

const JS_BUILTIN_MEMBERS = new Set([
  "get", "set", "has", "delete", "add", "clear", "keys", "values", "entries", "forEach", "map", "filter", "find",
  "findIndex", "findLast", "some", "every", "reduce", "flatMap", "flat", "push", "pop", "shift", "unshift", "slice",
  "splice", "concat", "join", "split", "sort", "reverse", "includes", "indexOf", "lastIndexOf", "at", "fill",
  "toString", "toLocaleString", "valueOf", "toJSON", "toFixed", "toUpperCase", "toLowerCase", "trim", "trimStart",
  "trimEnd", "startsWith", "endsWith", "replace", "replaceAll", "match", "matchAll", "test", "exec", "padStart",
  "padEnd", "charAt", "substring", "substr", "localeCompare", "normalize", "then", "catch", "finally", "bind",
  "call", "apply", "getItem", "setItem", "removeItem", "getAll", "append", "assign", "replaceState", "pushState",
  "addEventListener", "removeEventListener", "dispatchEvent", "preventDefault", "stopPropagation", "focus", "blur",
  "querySelector", "querySelectorAll", "getAttribute", "setAttribute", "toISOString", "getTime", "now", "log",
  "warn", "error", "info", "debug", "stringify", "parse", "freeze", "isArray", "from", "of", "resolve", "reject",
  "all", "allSettled", "race", "next", "return", "throw", "hasOwnProperty", "toBe", "toEqual", "toHaveBeenCalled",
  "toHaveBeenCalledWith", "toHaveBeenCalledTimes", "toBeDefined", "toBeUndefined", "toBeNull", "toBeTruthy",
  "toBeFalsy", "toContain", "toMatch", "toThrow", "toStrictEqual", "toMatchObject", "toHaveLength", "toHaveProperty",
  "toContainReactComponent", "toContainReactText", "toHaveReactProps", "mockReturnValue", "mockResolvedValue",
  "mockImplementation", "mockClear", "mockReset", "mockRestore", "not", "resolves", "rejects",
]);

const JS_GLOBALS = new Set([
  "console", "Promise", "Array", "Object", "String", "Number", "Boolean", "Math", "JSON", "Date", "Error", "Map",
  "Set", "WeakMap", "WeakSet", "Symbol", "Reflect", "Proxy", "RegExp", "parseInt", "parseFloat", "isNaN", "isFinite",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "fetch", "window", "document", "globalThis",
  "process", "Buffer", "URL", "URLSearchParams", "encodeURIComponent", "decodeURIComponent", "structuredClone",
  "queueMicrotask", "requestAnimationFrame", "Intl", "TextEncoder", "TextDecoder", "AbortController", "Number",
  "BigInt", "Atomics", "SharedArrayBuffer", "ArrayBuffer", "DataView", "Int32Array", "Uint8Array", "Float64Array",
  "Function", "Infinity", "NaN", "undefined", "null", "true", "false", "arguments", "expect", "describe", "it",
  "test", "beforeEach", "afterEach", "jest", "vi",
]);

export class Budget {
  readonly startedAt = Date.now();
  rgCalls = 0;
  truncatedBy: Truncation = "none";

  constructor(private readonly limitMs: number) {}

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get exhausted(): boolean {
    return this.elapsedMs >= this.limitMs;
  }

  spend(): boolean {
    if (this.exhausted) {
      if (this.truncatedBy === "none") this.truncatedBy = "budget";
      return false;
    }
    this.rgCalls += 1;
    return true;
  }
}

export function languageFor(path: string): Language | undefined {
  const ext = extname(path).toLowerCase();
  if (RUBY_EXTENSIONS.has(ext)) return "ruby";
  if (JS_EXTENSIONS.has(ext)) return "javascript";
  return undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function fingerprintOf(lines: string[], startLine: number, endLine: number): string {
  return createHash("sha256").update(lines.slice(startLine - 1, endLine).join("\n")).digest("hex").slice(0, 16);
}

function insideStringLiteral(text: string, name: string): boolean {
  const index = text.indexOf(name);
  if (index < 0) return false;
  let quote: string | undefined;
  for (let c = 0; c < index; c += 1) {
    const char = text[c]!;
    if (quote) {
      if (char === "\\") c += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
  }
  return quote !== undefined;
}

function insideJsImport(lines: string[], line: number): boolean {
  for (let i = line - 1; i >= Math.max(0, line - 30); i -= 1) {
    const text = lines[i]!.trim();
    if (/^import\b/.test(text)) return true;
    if (i < line - 1 && (/[;{]$/.test(text) || text === "" || /^(export|const|let|var|function|class|return|if|for)\b/.test(text))) return false;
  }
  return false;
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|spec|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /_test\.rb$/.test(path);
}

function parseTarget(target: string): { path: string; line: number } {
  const match = target.trim().match(/^(.+?):(\d+)(?::\d+)?$/);
  if (!match) throw new Error(`target must look like path:line, received ${JSON.stringify(target)}`);
  const line = Number(match[2]);
  if (!Number.isInteger(line) || line < 1) throw new Error(`target line must be a positive integer: ${target}`);
  return { path: match[1]!, line };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function findRoot(cwd: string, filePath: string, explicit?: string): Promise<string> {
  if (explicit) {
    const resolved = isAbsolute(explicit) ? resolve(explicit) : resolve(cwd, explicit);
    await ensureRealPathInsideCwd(cwd, resolved);
    return resolved;
  }

  let dir = dirname(filePath);
  const stopAt = resolve(cwd);
  while (true) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      entries = [];
    }
    if (entries.some((entry) => ROOT_MARKERS.includes(entry) || entry.endsWith(".gemspec"))) return dir;
    if (dir === stopAt || dirname(dir) === dir) return stopAt;
    dir = dirname(dir);
  }
}

// Ruby definitions

function rubyEndLine(lines: string[], start: number): number {
  const startText = lines[start - 1]!;
  const indent = indentOf(startText);
  const trimmed = startText.trim();
  if (/^def\s+(?:self\.)?[A-Za-z_]\w*[?!]?(?:\([^)]*\))?\s+=\s+\S/.test(trimmed) || /;\s*end\s*$/.test(trimmed)) return start;
  if (/\bdo\b\s*(\|[^|]*\|)?\s*$/.test(trimmed) || /^def\b/.test(trimmed) || /^(class|module)\b/.test(trimmed)) {
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (indentOf(line) === indent && /^\s*end\b/.test(line)) return i + 1;
    }
    return lines.length;
  }
  let depth = 0;
  let seen = false;
  for (let i = start - 1; i < lines.length; i += 1) {
    for (const char of lines[i]!) {
      if (char === "{") {
        depth += 1;
        seen = true;
      } else if (char === "}") depth -= 1;
    }
    if (seen && depth <= 0) return i + 1;
    if (!seen && i > start + 1) return start;
  }
  return lines.length;
}

function rubyOwner(lines: string[], start: number, indent: number): string | undefined {
  const names: string[] = [];
  let currentIndent = indent;
  for (let i = start - 2; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const lineIndent = indentOf(line);
    if (lineIndent >= currentIndent) continue;
    const match = line.match(/^\s*(?:class|module)\s+([A-Z][\w:]*)/);
    if (match) {
      names.unshift(match[1]!);
      currentIndent = lineIndent;
      if (lineIndent === 0) break;
    }
  }
  return names.length ? names.join("::") : undefined;
}

function findRubyDefinition(lines: string[], line: number): Definition | undefined {
  for (let i = Math.min(line, lines.length); i >= 1; i -= 1) {
    const text = lines[i - 1]!;
    const container = text.match(/^\s*(class|module)\s+([A-Z][\w:]*)/);
    if (container) {
      if (i < line) break;
      const owner = rubyOwner(lines, i, indentOf(text));
      const name = container[2]!;
      return { name, kind: container[1]!, startLine: i, endLine: rubyEndLine(lines, i), symbol: owner ? `${owner}::${name}` : name };
    }
    const def = text.match(/^\s*def\s+(self\.)?([A-Za-z_]\w*[?!=]?)/);
    const scope = text.match(/^\s*(scope|define_method|class_method)\s+:([A-Za-z_]\w*[?!=]?)/);
    const block = text.match(/^\s*(test|it|describe|context|scenario)\s+["']([^"']+)["'].*\bdo\b/);
    const match = def ?? scope ?? block;
    if (!match) continue;
    const endLine = rubyEndLine(lines, i);
    if (endLine < line) continue;
    const owner = rubyOwner(lines, i, indentOf(text));
    const name = match[2]!;
    const singleton = def ? Boolean(def[1]) : false;
    const kind = def ? (singleton ? "singleton_method" : "method") : match[1]!;
    const separator = singleton || kind === "scope" ? "." : block ? " " : "#";
    const label = block ? `${kind} "${name}"` : name;
    return { name, kind, startLine: i, endLine, symbol: owner ? `${owner}${separator}${label}` : label };
  }

  const text = lines[line - 1] ?? "";
  if (!text.trim()) return undefined;
  const owner = rubyOwner(lines, line, indentOf(text));
  const constant = text.match(/^\s*([A-Z]\w*)\s*=/);
  if (constant) {
    const name = constant[1]!;
    return { name, kind: "constant", startLine: line, endLine: line, symbol: owner ? `${owner}::${name}` : name };
  }
  const declaration = text.match(/^\s*([a-z_]\w*)\b/);
  const name = declaration?.[1] ?? text.trim().slice(0, 40);
  return { name, kind: "declaration", startLine: line, endLine: line, symbol: owner ? `${owner} ${name}` : name };
}

// JavaScript / TypeScript definitions

export function jsDefinitionStart(text: string): { name: string; kind: string } | undefined {
  const testBlock = text.match(/^\s*(?:it|test|describe|context)(?:\.(?:only|skip|each))?\s*\(\s*(["'`])(.+?)\1/);
  if (testBlock) return { name: testBlock[2]!, kind: "test" };
  const fn = text.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*[<(]/);
  if (fn) return { name: fn[1] ?? "default", kind: "function" };
  const assigned = text.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(.*)$/);
  if (assigned && /^(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function\b|(?:React\.)?(?:memo|forwardRef|lazy)\(|styled[.(]|create[A-Z]\w*\()/.test(assigned[2]!)) {
    return { name: assigned[1]!, kind: /^[A-Z]/.test(assigned[1]!) ? "component" : "function" };
  }
  const klass = text.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (klass) return { name: klass[1]!, kind: "class" };
  const typeDecl = text.match(/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
  if (typeDecl) return { name: typeDecl[1]!, kind: "type" };
  const valueObject = text.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*[\[{]/);
  if (valueObject) return { name: valueObject[1]!, kind: "object" };
  const moduleValue = text.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\S/);
  if (moduleValue) return { name: moduleValue[1]!, kind: "constant" };
  const method = text.match(/^\s*(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\s*\{\s*$/);
  if (method && !JS_KEYWORDS.has(method[1]!)) return { name: method[1]!, kind: "method" };
  const property = text.match(/^\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/);
  if (property && !JS_KEYWORDS.has(property[1]!)) return { name: property[1]!, kind: "function" };
  return undefined;
}

function startLineBodyBrace(text: string): number {
  if (!text.trimEnd().endsWith("{")) return -1;
  let parens = 0;
  let quote: string | undefined;
  for (let c = 0; c < text.length; c += 1) {
    const char = text[c]!;
    if (quote) {
      if (char === "\\") c += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
  }
  return parens === 0 ? text.lastIndexOf("{") : -1;
}

function jsEndLine(lines: string[], start: number): number {
  let depth = 0;
  let parens = 0;
  let opened = false;
  let inString: string | undefined;
  let inBlockComment = false;
  const startText = lines[start - 1]!;
  const startIndent = indentOf(startText);
  const bodyBraceAt = startLineBodyBrace(startText);

  for (let i = start - 1; i < lines.length; i += 1) {
    const text = lines[i]!;
    for (let c = 0; c < text.length; c += 1) {
      const char = text[c]!;
      const next = text[c + 1];
      if (i === start - 1 && bodyBraceAt >= 0 && c < bodyBraceAt && !inString && !inBlockComment) {
        if (char === '"' || char === "'" || char === "`") inString = char;
        continue;
      }
      if (inBlockComment) {
        if (char === "*" && next === "/") {
          inBlockComment = false;
          c += 1;
        }
        continue;
      }
      if (inString) {
        if (char === "\\") {
          c += 1;
        } else if (char === inString) {
          inString = undefined;
        }
        continue;
      }
      if (char === "/" && next === "/") break;
      if (char === "/" && next === "*") {
        inBlockComment = true;
        c += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        inString = char;
        continue;
      }
      if (char === "(") parens += 1;
      else if (char === ")") parens = Math.max(0, parens - 1);
      else if (char === "{" && parens === 0) {
        depth += 1;
        opened = true;
      } else if (char === "}" && parens === 0) {
        depth -= 1;
        if (opened && depth === 0) return i + 1;
      }
    }
    if (!opened && parens === 0) {
      const trimmed = text.trimEnd();
      if (i > start - 1 && indentOf(text) <= startIndent && text.trim()) return i;
      if (/[;,)]$/.test(trimmed) && !/=>\s*$/.test(trimmed)) return i + 1;
    }
    if (!opened && i - (start - 1) > 40) return i + 1;
  }
  return lines.length;
}

function jsOwner(lines: string[], start: number, indent: number): string | undefined {
  for (let i = start - 2; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.trim() || indentOf(line) >= indent) continue;
    const match = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (match) return match[1];
    if (indentOf(line) === 0) return undefined;
  }
  return undefined;
}

function findJsDefinition(lines: string[], line: number): Definition | undefined {
  let value: Definition | undefined;
  for (let i = Math.min(line, lines.length); i >= 1; i -= 1) {
    const text = lines[i - 1]!;
    const start = jsDefinitionStart(text);
    if (!start) continue;
    const endLine = jsEndLine(lines, i);
    if (endLine < line) continue;
    const owner = start.kind === "method" ? jsOwner(lines, i, indentOf(text)) : undefined;
    const def: Definition = {
      name: start.name,
      kind: start.kind,
      startLine: i,
      endLine,
      symbol: owner ? `${owner}.${start.name}` : start.name,
    };
    if (start.kind === "type" || start.kind === "object" || start.kind === "constant") {
      value ??= def;
      continue;
    }
    return def;
  }
  if (value) return value;
  const text = lines[line - 1] ?? "";
  if (!text.trim()) return undefined;
  return { name: text.trim().slice(0, 40), kind: "statement", startLine: line, endLine: line, symbol: text.trim().slice(0, 40) };
}

export function findDefinition(language: Language, lines: string[], line: number): Definition | undefined {
  return language === "ruby" ? findRubyDefinition(lines, line) : findJsDefinition(lines, line);
}

// Call extraction

function stripRubyNoise(text: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === "\\") {
        out += "  ";
        i += 1;
      } else if (char === quote) {
        quote = undefined;
        out += " ";
      } else {
        out += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (char === "#" && text[i + 1] !== "{") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

function rubyLocals(bodyLines: string[]): Set<string> {
  const locals = new Set<string>();
  const signature = bodyLines[0] ?? "";
  const params = signature.match(/\(([^)]*)\)/)?.[1] ?? signature.replace(/^\s*def\s+(?:self\.)?[\w?!=]+/, "");
  for (const raw of params.split(",")) {
    const name = raw.trim().replace(/^[*&]+/, "").match(/^([a-z_]\w*)/)?.[1];
    if (name) locals.add(name);
  }
  const body = bodyLines.join("\n");
  for (const match of body.matchAll(/(?:^|[\s(,|])([a-z_]\w*)\s*(?:\|\||&&|[+\-*/%])?=(?![=~>])/gm)) locals.add(match[1]!);
  for (const match of body.matchAll(/\|\s*([^|\n]*)\|/g)) {
    for (const raw of match[1]!.split(",")) {
      const name = raw.trim().replace(/^[*&(]+/, "").match(/^([a-z_]\w*)/)?.[1];
      if (name) locals.add(name);
    }
  }
  for (const match of body.matchAll(/rescue\b[^\n]*=>\s*([a-z_]\w*)/g)) locals.add(match[1]!);
  return locals;
}

function extractRubyCalls(lines: string[], def: Definition): CallSite[] {
  const bodyLines = lines.slice(def.startLine - 1, def.endLine);
  const locals = rubyLocals(bodyLines);
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  const push = (site: CallSite) => {
    const key = `${site.source}:${site.receiver ?? ""}:${site.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push(site);
  };

  const constantMethodNames = new Set<string>();
  bodyLines.forEach((raw, index) => {
    const line = def.startLine + index;
    const text = stripRubyNoise(raw);
    if (index === 0 && def.kind !== "declaration") return;

    for (const match of text.matchAll(/(?<![\w:])([A-Z]\w*(?:::[A-Z]\w*)*)\.new(?:\((?:[^()]|\([^()]*\))*\))?\.([a-z_]\w*[?!]?)/g)) {
      const name = match[2]!;
      if (RUBY_COMMON_METHODS.has(name)) continue;
      constantMethodNames.add(name);
      push({ name, receiver: match[1]!, line, relationship: "calls", source: "constant_method" });
    }
    for (const match of text.matchAll(/(?<![\w:])([A-Z]\w*(?:::[A-Z]\w*)*)\.([a-z_]\w*[?!]?)/g)) {
      const constant = match[1]!;
      if (constant === "T") continue;
      if (match[2] === "new" || RUBY_COMMON_METHODS.has(match[2]!)) {
        push({ name: constant, line, relationship: "references", source: "constant" });
        continue;
      }
      constantMethodNames.add(match[2]!);
      push({ name: match[2]!, receiver: constant, line, relationship: "calls", source: "constant_method" });
    }
    for (const match of text.matchAll(/(?<![\w:])([A-Z]\w*(?:::[A-Z]\w*)*)(?![\w:.])/g)) {
      const constant = match[1]!;
      if (constant === "T" || constant.startsWith("T::")) continue;
      push({ name: constant, line, relationship: "references", source: "constant" });
    }
    for (const match of text.matchAll(/\.([a-z_]\w*[?!]?)/g)) {
      const name = match[1]!;
      if (RUBY_COMMON_METHODS.has(name) || RUBY_KEYWORDS.has(name) || constantMethodNames.has(name)) continue;
      const before = text.slice(0, match.index!);
      if (/(?<![\w:])[A-Z]\w*(?:::[A-Z]\w*)*$/.test(before)) continue;
      push({ name, line, relationship: "calls", source: "receiver_method" });
    }
    for (const match of text.matchAll(/(?<![\w.:@$])([a-z_]\w*[?!]?)(?![\w:])/g)) {
      const name = match[1]!;
      if (RUBY_KEYWORDS.has(name) || RUBY_COMMON_METHODS.has(name) || locals.has(name)) continue;
      const after = text.slice(match.index! + name.length);
      if (/^\s*:(?!:)/.test(after) || /^\s*=(?!=|~|>)/.test(after)) continue;
      const before = text.slice(0, match.index!);
      if (/(?:^|[\s(,])[a-z_]\w*\s*=\s*$/.test(before) && locals.has(name)) continue;
      push({ name, line, relationship: "calls", source: "bare" });
    }
    if (def.kind === "declaration") {
      for (const match of text.matchAll(/:([a-z_]\w*[?!]?)/g)) push({ name: match[1]!, line, relationship: "references", source: "bare" });
    }
  });

  return calls;
}

function stripJsNoise(text: string): string {
  let out = "";
  let quote: string | undefined;
  let blockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const next = text[i + 1];
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
        out += "  ";
      } else out += char === "\n" ? "\n" : " ";
      continue;
    }
    if (quote) {
      if (char === "\\") {
        out += "  ";
        i += 1;
      } else if (char === quote) {
        quote = undefined;
        out += " ";
      } else if (quote === "`" && char === "$" && next === "{") {
        out += "${";
        i += 1;
        quote = undefined;
      } else out += char === "\n" ? "\n" : " ";
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      out += "  ";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

interface JsImport {
  name: string;
  specifier: string;
  imported: string;
  namespace: boolean;
}

function parseJsImports(source: string): Map<string, JsImport> {
  const imports = new Map<string, JsImport>();
  for (const match of source.matchAll(/\bimport\s+(type\s+)?([^;'"]+?)\s+from\s+["']([^"']+)["']/g)) {
    if (match[1]) continue;
    const clause = match[2]!.trim();
    const specifier = match[3]!;
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) imports.set(namespace[1]!, { name: namespace[1]!, specifier, imported: "*", namespace: true });
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const raw of named[1]!.split(",")) {
        const part = raw.trim().replace(/^type\s+/, "");
        if (!part) continue;
        const alias = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (alias) imports.set(alias[2] ?? alias[1]!, { name: alias[2] ?? alias[1]!, specifier, imported: alias[1]!, namespace: false });
      }
    }
    const defaultName = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[\w$]+/, "").replace(/,/g, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(defaultName)) imports.set(defaultName, { name: defaultName, specifier, imported: "default", namespace: false });
  }
  return imports;
}

function extractJsCalls(lines: string[], def: Definition): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  const push = (site: CallSite) => {
    const key = `${site.source}:${site.receiver ?? ""}:${site.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push(site);
  };

  for (let i = def.startLine - 1; i < def.endLine; i += 1) {
    const line = i + 1;
    const text = stripJsNoise(lines[i]!);
    if (i === def.startLine - 1) {
      const signatureEnd = text.indexOf("{") >= 0 ? text.indexOf("{") : text.indexOf("=>");
      if (signatureEnd > 0 && !text.slice(signatureEnd + 1).trim()) continue;
    }
    for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      const receiver = match[1]!;
      const name = match[2]!;
      if (JS_GLOBALS.has(receiver) || JS_BUILTIN_MEMBERS.has(name)) continue;
      push({ name, receiver, line, relationship: "calls", source: "member" });
    }
    for (const match of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1]!;
      if (JS_KEYWORDS.has(name) || JS_GLOBALS.has(name) || name === def.name) continue;
      push({ name, line, relationship: "calls", source: "call" });
    }
    for (const match of text.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)/g)) {
      if (!JS_GLOBALS.has(match[1]!)) push({ name: match[1]!, line, relationship: "references", source: "new" });
    }
    for (const match of text.matchAll(/<([A-Z][\w$]*)[\s/>]/g)) {
      if (match[1] !== def.name) push({ name: match[1]!, line, relationship: "references", source: "jsx" });
    }
  }
  return calls;
}

// Ripgrep

async function rgJson(args: string[], cwd: string, budget: Budget, signal?: AbortSignal): Promise<RgHit[]> {
  if (!budget.spend()) return [];
  const full = ["--json", "--line-number", "--color=never", "--hidden"];
  addRgExcludes(full);
  full.push(...args);

  const output = await new Promise<string>((resolvePromise) => {
    execFile("rg", full, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, signal, timeout: RG_CALL_TIMEOUT_MS }, (error, stdout) => {
      if (error && (error as { killed?: boolean }).killed) budget.truncatedBy = "rg_timeout";
      resolvePromise(String(stdout ?? ""));
    });
  });

  const hits: RgHit[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "match") continue;
    const path = event.data?.path?.text;
    const text = event.data?.lines?.text;
    const lineNumber = event.data?.line_number;
    if (typeof path !== "string" || typeof text !== "string" || typeof lineNumber !== "number") continue;
    hits.push({ path: normalizeRepoRelativePath(path), line: lineNumber, text: text.replace(/\r?\n$/, "") });
  }
  return hits;
}

async function rgFiles(glob: string, root: string, cwd: string, budget: Budget, signal?: AbortSignal): Promise<string[]> {
  if (!budget.spend()) return [];
  const args = ["--files", "--hidden", "--color=never"];
  addRgExcludes(args);
  args.push("--glob", glob, root);
  const output = await new Promise<string>((resolvePromise) => {
    execFile("rg", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, signal, timeout: RG_CALL_TIMEOUT_MS }, (_error, stdout) => {
      resolvePromise(String(stdout ?? ""));
    });
  });
  return output.split("\n").map((line) => line.trim()).filter(Boolean).map(normalizeRepoRelativePath);
}

// Resolution

export class Collector {
  private readonly files = new Map<string, string[]>();
  private readonly nodesByKey = new Map<string, SparsityNode>();
  readonly nodes: SparsityNode[] = [];
  readonly edges: SparsityEdge[] = [];
  readonly frontier: string[] = [];
  readonly cycles: string[] = [];
  readonly notes: string[] = [];
  readonly budget: Budget;
  depthReached = 0;

  private readonly root: string;
  private readonly nextId: () => string;
  private readonly expandedCount: () => number;
  private readonly rubyIndex?: RubyIndex;
  private readonly rubyReady: boolean;
  private readonly facts = new Map<string, FileFacts | undefined>();
  expandedNodes = 0;

  rubyFacts(path: string, lines: string[]): FileFacts | undefined {
    if (!this.rubyReady) return undefined;
    if (this.facts.has(path)) return this.facts.get(path);
    const facts = rubyAdapter.parse(path, lines.join("\n"));
    this.facts.set(path, facts);
    return facts;
  }

  tsFacts(path: string, lines: string[]): FileFacts | undefined {
    if (this.facts.has(path)) return this.facts.get(path);
    const facts = tsAdapter.parse(path, lines.join("\n"));
    this.facts.set(path, facts);
    return facts;
  }

  factsFor(language: Language, path: string, lines: string[]): FileFacts | undefined {
    return language === "ruby" ? this.rubyFacts(path, lines) : this.tsFacts(path, lines);
  }

  get atNodeCap(): boolean {
    return this.expandedCount() >= this.options.maxNodes;
  }

  constructor(private readonly options: CollectorOptions, absoluteRoot: string, shared: CollectorShared = {}) {
    this.budget = shared.budget ?? new Budget(options.budgetMs);
    this.root = displaySearchRoot(options.cwd, absoluteRoot);
    this.nextId = shared.nextId ?? (() => `n${this.nodes.length + 1}`);
    this.expandedCount = shared.expandedCount ?? (() => this.nodes.length);
    this.rubyIndex = shared.rubyIndex;
    this.rubyReady = shared.rubyReady ?? false;
    if (shared.tsPrograms) tsAdapter.attach(shared.tsPrograms, options.cwd);
  }

  definitionOf(node: SparsityNode): Definition {
    return { name: node.symbol.split(/[#. ]/).pop() ?? node.symbol, symbol: node.symbol, kind: node.kind, startLine: node.startLine, endLine: node.endLine };
  }

  async headLines(node: SparsityNode, count: number): Promise<string> {
    const lines = await this.lines(node.path);
    if (!lines) return "";
    const end = Math.min(node.endLine, node.startLine + count - 1);
    const width = String(node.endLine).length;
    const out = [];
    for (let n = node.startLine; n <= end; n += 1) out.push(`${String(n).padStart(width)} | ${lines[n - 1] ?? ""}`);
    if (end < node.endLine) out.push(`${" ".repeat(width)} | … ${node.endLine - end} more lines to ${node.endLine}`);
    return out.join("\n");
  }

  async lineText(path: string, line: number): Promise<string> {
    const lines = await this.lines(path);
    return lines?.[line - 1]?.trim() ?? "";
  }

  get rootDisplay(): string {
    return this.root;
  }

  private displayPath(absolute: string): string {
    return displaySearchRoot(this.options.cwd, absolute);
  }

  private absolutePath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.options.cwd, path);
  }

  preload(path: string, content: string): void {
    this.files.set(this.absolutePath(path), content.split("\n"));
  }

  async lines(path: string): Promise<string[] | undefined> {
    const absolute = this.absolutePath(path);
    const cached = this.files.get(absolute);
    if (cached) return cached;
    if (!(await isRealPathInsideCwd(this.options.cwd, absolute))) return undefined;
    try {
      const lines = (await readFile(absolute, "utf8")).split("\n");
      this.files.set(absolute, lines);
      return lines;
    } catch {
      return undefined;
    }
  }

  snippet(lines: string[], def: Definition, focus: number | number[], marks?: Set<number>): string {
    const vicinity = this.options.vicinity;
    const focuses = (Array.isArray(focus) ? focus : [focus]).filter((n) => n >= def.startLine && n <= def.endLine).sort((a, b) => a - b);
    if (!focuses.length) focuses.push(def.startLine);
    const windows: Array<[number, number]> = [];
    for (const line of focuses) {
      const start = Math.max(def.startLine, line - vicinity);
      const end = Math.min(def.endLine, line + vicinity);
      const last = windows[windows.length - 1];
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else windows.push([start, end]);
    }
    const width = String(def.endLine).length;
    const mark = (n: number) => (marks ? (marks.has(n) ? "+" : " ") : "");
    const render = (n: number) => `${String(n).padStart(width)} ${mark(n)}| ${lines[n - 1] ?? ""}`.replace(/^(\s*\d+) \|/, "$1 |");
    const gap = (count: number, suffix = "") => `${" ".repeat(width)} ${marks ? " " : ""}| … ${count} lines omitted${suffix}`;
    const out: string[] = [];
    if (windows[0]![0] > def.startLine) {
      out.push(render(def.startLine));
      if (windows[0]![0] > def.startLine + 1) out.push(gap(windows[0]![0] - def.startLine - 1));
    }
    windows.forEach(([start, end], index) => {
      const previous = windows[index - 1];
      if (previous && start > previous[1] + 1) out.push(gap(start - previous[1] - 1));
      for (let n = start; n <= end; n += 1) out.push(render(n));
    });
    const lastEnd = windows[windows.length - 1]![1];
    if (lastEnd < def.endLine) out.push(gap(def.endLine - lastEnd, ` (definition ends at ${def.endLine})`));
    return out.join("\n");
  }

  async refocus(node: SparsityNode, focus: number[], marks?: Set<number>): Promise<void> {
    const lines = await this.lines(node.path);
    if (!lines) return;
    node.snippet = this.snippet(lines, this.definitionOf(node), focus, marks);
  }

  async node(path: string, line: number, depth: number, focus?: number, symbolHint?: string): Promise<{ node: SparsityNode; created: boolean; def: Definition } | undefined> {
    const lines = await this.lines(path);
    if (!lines) return undefined;
    const language = languageFor(path);
    if (!language) return undefined;
    const display = this.displayPath(this.absolutePath(path));
    const facts = this.factsFor(language, display, lines);
    const hinted = facts && symbolHint ? facts.definitions.find((item) => item.symbol === symbolHint && item.startLine <= line && line <= item.endLine) : undefined;
    const adapterDef = facts ? (language === "ruby" ? rubyAdapter.definitionAt(facts, line) : tsAdapter.definitionAt(facts, line)) : undefined;
    const def = hinted ?? adapterDef ?? findDefinition(language, lines, line);
    if (!def) return undefined;
    const key = `${display}:${def.startLine}:${def.symbol}`;
    const existing = this.nodesByKey.get(key);
    if (existing) return { node: existing, created: false, def };

    const node: SparsityNode = {
      id: this.nextId(),
      path: display,
      symbol: def.symbol,
      kind: def.kind,
      language,
      startLine: def.startLine,
      endLine: def.endLine,
      fingerprint: fingerprintOf(lines, def.startLine, def.endLine),
      snippet: this.snippet(lines, def, focus ?? def.startLine),
      depth,
    };
    this.nodes.push(node);
    this.nodesByKey.set(key, node);
    this.depthReached = Math.max(this.depthReached, depth);
    return { node, created: true, def };
  }

  private rankCandidates(hits: RgHit[], fromPath: string, hint?: string): Candidate[] {
    const fromDir = dirname(fromPath);
    const hintPath = hint ? hint.split("::").map(camelToSnake).join("/") : undefined;
    const scored = hits.map((hit) => {
      let score = 0;
      if (hit.path === fromPath) score += 100;
      if (dirname(hit.path) === fromDir) score += 40;
      if (hintPath && hit.path.includes(`${hintPath}.rb`)) score += 80;
      else if (hintPath && hit.path.includes(`/${basename(hintPath)}.rb`)) score += 30;
      if (isTestPath(hit.path)) score -= 60;
      score -= hit.path.split("/").length;
      return { hit, score };
    });
    scored.sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path) || a.hit.line - b.hit.line);
    return scored.map(({ hit }) => hit);
  }

  private readonly constantCache = new Map<string, ConstantResolution>();

  private async resolveRubyConstant(constant: string, fromPath: string, signal?: AbortSignal): Promise<ConstantResolution> {
    const cached = this.constantCache.get(constant);
    if (cached) return cached;
    const result = await this.resolveRubyConstantUncached(constant, fromPath, signal);
    this.constantCache.set(constant, result);
    return result;
  }

  private async namespaceUnderRoot(namespace: string, signal?: AbortSignal): Promise<boolean> {
    const cached = this.constantCache.get(namespace);
    if (cached) return cached.candidates.length > 0;
    const files = await rgFiles(`**/${camelToSnake(namespace)}{.rb,}`, this.root, this.options.cwd, this.budget, signal);
    if (files.length) return true;
    const hits = await rgJson(["-t", "ruby", "--max-count", "1", "-e", `^\\s*(class|module)\\s+(\\w+::)*${escapeRegex(namespace)}([^\\w]|$)`, this.root], this.options.cwd, this.budget, signal);
    return hits.length > 0;
  }

  private async resolveRubyConstantUncached(constant: string, fromPath: string, signal?: AbortSignal): Promise<ConstantResolution> {
    const segments = constant.split("::");
    const last = segments[segments.length - 1]!;
    if (/^[A-Z][A-Z0-9_]*$/.test(last) && last.length > 1) {
      const assignment = `^\\s*(\\w+::)*${escapeRegex(last)}\\s*=[^=~>]`;
      const sameFile = await rgJson(["--max-count", "2", "-e", assignment, fromPath], this.options.cwd, this.budget, signal);
      if (sameFile.length) return { candidates: this.rankCandidates(sameFile, fromPath) };
      if (segments.length >= 2) {
        const owners = await this.resolveRubyConstant(segments.slice(0, -1).join("::"), fromPath, signal);
        const files = uniqueValues(owners.candidates.map((owner) => owner.path));
        if (files.length) {
          const inOwner = await rgJson(["--max-count", "2", "-e", assignment, ...files], this.options.cwd, this.budget, signal);
          if (inOwner.length) return { candidates: this.rankCandidates(inOwner, fromPath, constant) };
        }
      }
      const anywhere = await rgJson(["-t", "ruby", "--max-count", "1", "-e", assignment, this.root], this.options.cwd, this.budget, signal);
      if (anywhere.length) {
        const ranked = this.rankCandidates(anywhere, fromPath, segments.length >= 2 ? segments.slice(0, -1).join("::") : undefined);
        return ranked.length > MAX_CANDIDATES_PER_CALL
          ? { candidates: ranked, note: `${ranked.length} assignments of ${last} under ${this.rootDisplay}; namespace not confirmed.` }
          : { candidates: ranked, note: segments.length >= 2 ? undefined : `value constant matched by name only under ${this.rootDisplay}.` };
      }
      return { candidates: [], note: `${constant} is not assigned under ${this.rootDisplay}; it comes from the platform, a gem or another component.` };
    }
    const pathGuess = `${segments.map(camelToSnake).join("/")}.rb`;
    const files = await rgFiles(`**/${pathGuess}`, this.root, this.options.cwd, this.budget, signal);
    const hits: RgHit[] = [];
    for (const file of files.slice(0, MAX_CANDIDATES_PER_CALL)) {
      const lines = await this.lines(file);
      if (!lines) continue;
      const index = lines.findIndex((line) => new RegExp(`^\\s*(class|module)\\s+(?:\\w+::)*${escapeRegex(last)}\\b`).test(line));
      hits.push({ path: file, line: index >= 0 ? index + 1 : 1, text: lines[index >= 0 ? index : 0] ?? "" });
    }
    if (hits.length) return { candidates: this.rankCandidates(hits, fromPath, constant) };

    if (segments.length >= 2 && !(await this.namespaceUnderRoot(segments[0]!, signal))) {
      return { candidates: [], note: `${segments[0]} is not defined under ${this.rootDisplay}; ${constant} comes from a gem, the platform or another component.` };
    }

    const pattern = `^\\s*(class|module)\\s+(\\w+::)*${escapeRegex(last)}([^\\w]|$)`;
    const found = await rgJson(["-t", "ruby", "--max-count", "1", "-e", pattern, this.root], this.options.cwd, this.budget, signal);
    if (found.length) {
      const parentPath = segments.slice(0, -1).map(camelToSnake).join("/");
      const inNamespace = parentPath ? found.filter((hit) => hit.path.includes(`/${parentPath}/`) || hit.path.includes(`/${parentPath}.rb`)) : found;
      if (inNamespace.length) return { candidates: this.rankCandidates(inNamespace, fromPath, constant) };
      if (segments.length < 2) return { candidates: this.rankCandidates(found, fromPath, constant) };
    }

    if (segments.length < 2) return { candidates: [], note: `${constant} is not defined under ${this.rootDisplay}; it comes from the platform, a gem or another component.` };
    const parent = segments.slice(0, -1).join("::");
    const owners = await this.resolveRubyConstant(parent, fromPath, signal);
    const located: RgHit[] = [];
    for (const owner of owners.candidates.slice(0, MAX_CANDIDATES_PER_CALL)) {
      const lines = await this.lines(owner.path);
      if (!lines) continue;
      const index = lines.findIndex((text) => new RegExp(`^\\s*(?:(?:class|module)\\s+(?:\\w+::)*${escapeRegex(last)}\\b|${escapeRegex(last)}\\s*=)`).test(text));
      if (index >= 0) located.push({ path: owner.path, line: index + 1, text: lines[index] ?? "" });
    }
    if (located.length) return { candidates: this.rankCandidates(located, fromPath, parent) };
    if (found.length) {
      return { candidates: this.rankCandidates(found, fromPath, constant), note: `only the class name ${last} matched; none of the matches live under ${parent}. Treat as a guess.` };
    }
    return { candidates: [], note: owners.note };
  }

  private rubyMethodPattern(name: string): string[] {
    const escaped = escapeRegex(name);
    const tail = /[?!=]$/.test(name) ? "" : "([^\\w?!=]|$)";
    return [
      `^\\s*def\\s+(self\\.)?${escaped}${tail}`,
      `^\\s*(scope|attr_reader|attr_accessor|attr_writer|has_many|has_one|belongs_to|has_and_belongs_to_many|delegate|alias_method|alias|define_method|enum|store_accessor|class_attribute|attribute|mattr_accessor|cattr_accessor|thread_mattr_accessor)\\b[^#]*:${escaped}${tail}`,
    ];
  }

  private async resolveRubyMethod(name: string, fromPath: string, receiverConstant?: string, signal?: AbortSignal): Promise<{ candidates: Candidate[]; resolution: Resolution; note?: string; via?: EdgeVia }> {
    const patterns = this.rubyMethodPattern(name);
    const patternArgs = patterns.flatMap((pattern) => ["-e", pattern]);

    if (receiverConstant) {
      const resolved = await this.resolveRubyConstant(receiverConstant, fromPath, signal);
      const owners = resolved.candidates;
      if (owners.length) {
        const files = uniqueValues(owners.map((owner) => owner.path));
        const hits = await rgJson(["-t", "ruby", "--max-count", "3", ...patternArgs, ...files], this.options.cwd, this.budget, signal);
        if (hits.length) {
          const ranked = this.rankCandidates(hits, fromPath, receiverConstant);
          return { candidates: ranked, resolution: ranked.length === 1 ? "exact" : "static_candidate", via: "constant" };
        }
        return { candidates: owners.slice(0, 1), resolution: "static_candidate", via: "constant", note: `${receiverConstant} found, but no ${name} definition inside it; showing the constant. Inherited, delegated or dynamic.` };
      }
      return { candidates: [], resolution: resolved.note && /comes from the platform, a gem or another component/.test(resolved.note) ? "external" : "unresolved", via: "constant", note: resolved.note ?? `receiver ${receiverConstant} was not found under ${this.rootDisplay}; it is probably defined outside this root.` };
    }

    const sameFile = await rgJson(["--max-count", "3", ...patternArgs, fromPath], this.options.cwd, this.budget, signal);
    if (sameFile.length) return { candidates: sameFile, resolution: sameFile.length === 1 ? "exact" : "static_candidate", via: "same_file" };

    const hits = await rgJson(["-t", "ruby", "--max-count", "2", ...patternArgs, this.root], this.options.cwd, this.budget, signal);
    if (!hits.length) return { candidates: [], resolution: "unresolved" };
    const ranked = this.rankCandidates(hits, fromPath);
    if (ranked.length > MAX_CANDIDATES_PER_CALL) return { candidates: ranked, resolution: "ambiguous", via: "name_only", note: `${ranked.length} definitions named ${name} under ${this.rootDisplay}; receiver type unknown.` };
    return { candidates: ranked, resolution: "static_candidate", via: "name_only" };
  }

  private async resolveJsInFiles(name: string, files: string[], isDefault: boolean, signal?: AbortSignal): Promise<Candidate[]> {
    const escaped = escapeRegex(name);
    const patterns = isDefault
      ? ["^\\s*export\\s+default\\b"]
      : [
          `^\\s*export\\s+(default\\s+)?(async\\s+)?(function\\s*\\*?|const|let|var|class|enum|abstract\\s+class)\\s+${escaped}([^\\w$]|$)`,
          `^\\s*export\\s*\\{[^}]*\\b${escaped}\\b`,
          `^\\s*(async\\s+)?(function\\s*\\*?|const|let|var|class)\\s+${escaped}([^\\w$]|$)`,
        ];
    const hits = await rgJson(["--max-count", "3", ...patterns.flatMap((pattern) => ["-e", pattern]), ...files], this.options.cwd, this.budget, signal);
    return hits;
  }

  private async resolveJsImportFile(fromPath: string, specifier: string): Promise<string | undefined> {
    for (const candidate of jsImportCandidatePaths(this.absolutePath(fromPath), specifier)) {
      if ((await isRealPathInsideCwd(this.options.cwd, candidate)) && (await fileExists(candidate))) return this.displayPath(candidate);
    }
    return undefined;
  }

  private async resolveJs(site: CallSite, fromPath: string, imports: Map<string, JsImport>, signal?: AbortSignal): Promise<{ candidates: Candidate[]; resolution: Resolution; note?: string; via?: EdgeVia }> {
    const lookup = site.receiver && site.receiver !== "this" ? imports.get(site.receiver) : imports.get(site.name);
    if (site.receiver && site.receiver !== "this" && !lookup) {
      const local = await this.resolveJsInFiles(site.name, [fromPath], false, signal);
      if (local.length) return { candidates: local, resolution: "static_candidate", via: "same_file", note: `receiver ${site.receiver} is not an import; matched a same-file definition by name.` };
      return { candidates: [], resolution: "unresolved", note: `receiver ${site.receiver} is a local value; its type is not traced statically.` };
    }

    if (lookup) {
      if (!lookup.specifier.startsWith(".")) return { candidates: [], resolution: "external", via: "import", note: `from package ${lookup.specifier}` };
      const file = await this.resolveJsImportFile(fromPath, lookup.specifier);
      if (!file) return { candidates: [], resolution: "unresolved", via: "import", note: `import ${lookup.specifier} did not resolve to a file` };
      const imported = lookup.namespace ? site.name : lookup.imported;
      let hits = await this.resolveJsInFiles(imported, [file], imported === "default", signal);
      if (!hits.length) return { candidates: [{ path: file, line: 1, text: "" }], resolution: "static_candidate", via: "import", note: `${imported} not found as a direct export in ${file}; barrel or re-export likely.` };
      const reexport = hits.find((hit) => /^\s*export\s*\{[^}]*\}\s*from\s*["']/.test(hit.text));
      if (reexport && hits.length === 1) {
        const target = reexport.text.match(/from\s*["']([^"']+)["']/)?.[1];
        const next = target ? await this.resolveJsImportFile(file, target) : undefined;
        if (next) {
          const deeper = await this.resolveJsInFiles(imported, [next], false, signal);
          if (deeper.length) hits = deeper;
        }
      }
      return { candidates: hits, resolution: hits.length === 1 ? "exact" : "static_candidate", via: "import" };
    }

    const local = await this.resolveJsInFiles(site.name, [fromPath], false, signal);
    if (local.length) {
      const values = local.filter((hit) => /^\s*(const|let|var)\s/.test(hit.text) && !jsDefinitionStart(hit.text));
      if (values.length === local.length) {
        const value = values[0]!;
        return { candidates: [], resolution: "local", note: `local value assigned at ${value.path}:${value.line}: ${value.text.trim().slice(0, 80)}` };
      }
      return { candidates: local.filter((hit) => !values.includes(hit)), resolution: "exact", via: "same_file" };
    }
    const methodHits = await rgJson(["--max-count", "2", "-e", `^\\s*((public|private|protected|static|async|override)\\s+)*${escapeRegex(site.name)}\\s*(<[^>]*>)?\\s*\\([^)]*\\)\\s*(:[^{;=]+)?\\s*\\{\\s*$`, fromPath], this.options.cwd, this.budget, signal);
    if (methodHits.length) return { candidates: methodHits, resolution: "exact", via: "same_file" };

    const hits = await rgJson(["-t", "ts", "-t", "js", "--max-count", "2", "-e", `\\b(function\\s*\\*?|const|let|var|class)\\s+${escapeRegex(site.name)}([^\\w$]|$)`, this.root], this.options.cwd, this.budget, signal);
    if (!hits.length) return { candidates: [], resolution: "unresolved" };
    const ranked = this.rankCandidates(hits, fromPath);
    if (ranked.length > MAX_CANDIDATES_PER_CALL) return { candidates: ranked, resolution: "ambiguous", via: "name_only", note: `${ranked.length} definitions named ${site.name} under ${this.rootDisplay}; not imported here.` };
    return { candidates: ranked, resolution: "static_candidate", via: "name_only" };
  }

  async expand(node: SparsityNode, def: Definition, depth: number, ancestry: string[], queue: QueueItem[], signal?: AbortSignal, focus?: number[]): Promise<void> {
    if (depth > 0 && !EXPANDABLE_KINDS.has(def.kind)) return;
    const lines = await this.lines(node.path);
    if (!lines) return;
    const facts = this.factsFor(node.language, node.path, lines);
    let sites: CallSite[] = facts && node.language === "ruby"
      ? rubyAdapter.calls(facts, def).filter((site) => !RUBY_KEYWORDS.has(site.name) && !(RUBY_COMMON_METHODS.has(site.name) && site.source !== "constant"))
      : facts && node.language === "javascript"
        ? tsAdapter.calls(facts, def).filter((site) => site.target || !(site.source === "member" && JS_BUILTIN_MEMBERS.has(site.name)))
        : node.language === "ruby" ? extractRubyCalls(lines, def) : extractJsCalls(lines, def);
    if (focus?.length) {
      const distance = (line: number) => Math.min(...focus.map((f) => Math.abs(f - line)));
      sites = [...sites].sort((a, b) => distance(a.line) - distance(b.line) || a.line - b.line);
    }
    const imports = node.language === "javascript" ? parseJsImports(lines.join("\n")) : new Map<string, JsImport>();
    const followed = sites.slice(0, MAX_CALLS_PER_NODE);
    for (const dropped of sites.slice(MAX_CALLS_PER_NODE)) this.frontier.push(`${node.id} → ${dropped.receiver ? `${dropped.receiver}.` : ""}${dropped.name} (call cap)`);

    for (const site of followed) {
      if (this.budget.exhausted || signal?.aborted) {
        this.frontier.push(`${node.id} → ${site.receiver ? `${site.receiver}.` : ""}${site.name} (budget)`);
        continue;
      }
      if (depth >= this.options.maxDepth) {
        this.frontier.push(`${node.id} → ${site.receiver ? `${site.receiver}.` : ""}${site.name} (depth ${this.options.maxDepth})`);
        continue;
      }

      let resolved: { candidates: Candidate[]; resolution: Resolution; note?: string; via?: EdgeVia };
      if (node.language === "ruby") {
        const indexed = this.rubyIndex ? this.resolveViaIndex(site, node, def) : undefined;
        if (indexed) {
          resolved = indexed;
        } else if (site.source === "constant") {
          const { candidates, note } = await this.resolveRubyConstant(site.name, node.path, signal);
          const outside = !candidates.length && /comes from the platform, a gem or another component/.test(note ?? "");
          const resolution: Resolution = outside ? "external" : !candidates.length ? "unresolved" : note ? "static_candidate" : candidates.length === 1 ? "exact" : "static_candidate";
          resolved = { candidates, resolution, note };
        } else if (site.receiverType && site.receiverKind !== "constant" && site.via !== "named") {
          resolved = await this.resolveRubyMethod(site.name, node.path, site.receiverType, signal);
          resolved.via = site.via;
        } else {
          resolved = await this.resolveRubyMethod(site.name, node.path, site.receiverKind === "constant" ? site.receiver : undefined, signal);
        }
      } else {
        resolved = site.target ? this.resolveFromTarget(site) : await this.resolveJs(site, node.path, imports, signal);
      }

      const label = site.receiver ? `${site.receiver}.${site.name}` : site.name;
      if (!resolved.candidates.length) {
        this.edges.push({ from: node.id, name: label, relationship: site.relationship, resolution: resolved.resolution, via: resolved.via, line: site.line, note: resolved.note });
        continue;
      }

      const shown = resolved.candidates.slice(0, resolved.resolution === "ambiguous" ? 1 : Math.min(2, MAX_CANDIDATES_PER_CALL));
      for (const candidate of shown) {
        if (this.atNodeCap) {
          this.budget.truncatedBy = this.budget.truncatedBy === "none" ? "max_nodes" : this.budget.truncatedBy;
          this.frontier.push(`${node.id} → ${label} at ${candidate.path}:${candidate.line} (max_nodes)`);
          continue;
        }
        const created = await this.node(candidate.path, candidate.line, depth + 1, undefined, candidate.symbol);
        if (created?.created) this.expandedNodes += 1;
        if (!created) {
          this.edges.push({ from: node.id, name: label, relationship: site.relationship, resolution: "unresolved", line: site.line, note: `${candidate.path}:${candidate.line} could not be read or parsed` });
          continue;
        }
        if (created.node.id === node.id && candidate.line !== created.def.startLine) {
          this.edges.push({ from: node.id, name: label, relationship: site.relationship, resolution: "local", line: site.line, note: `${label} is defined inside this definition at line ${candidate.line}; a local, not a separate definition.` });
          continue;
        }
        const edge: SparsityEdge = {
          from: node.id,
          to: created.node.id,
          name: label,
          relationship: site.relationship,
          resolution: resolved.resolution,
          via: resolved.via,
          line: site.line,
          note: resolved.note,
        };
        if (resolved.resolution === "ambiguous") edge.candidates = resolved.candidates.slice(0, 8).map((c) => `${c.path}:${c.line}`);
        this.edges.push(edge);

        if (ancestry.includes(created.node.id) || created.node.id === node.id) {
          this.cycles.push(`${[...ancestry, node.id, created.node.id].join(" → ")}`);
          continue;
        }
        if (created.created && site.relationship === "calls") {
          queue.push({ node: created.node, def: created.def, depth: depth + 1, ancestry: [...ancestry, node.id] });
        }
      }
    }
  }

  private resolveViaIndex(site: CallSite, node: SparsityNode, def: Definition): { candidates: Candidate[]; resolution: Resolution; note?: string; via?: EdgeVia } | undefined {
    const index = this.rubyIndex!;
    const ownerSymbol = node.symbol.split(/[#. ]/)[0]!;
    const toCandidates = (defs: IndexedDefinition[]): Candidate[] => defs.map((item) => ({ path: item.path, line: item.startLine, text: item.symbol, symbol: item.symbol }));

    if (site.source === "constant") {
      const symbol = resolveIndexedConstant(index, site.name, node.symbol);
      if (!symbol) return undefined;
      const defs = (index.bySymbol.get(symbol) ?? []).filter((item) => ["class", "module", "constant"].includes(item.kind));
      if (!defs.length) return undefined;
      return { candidates: toCandidates(defs), resolution: "exact", via: "lexical" };
    }

    if (site.source === "super") {
      const superclass = site.receiverType ? resolveIndexedConstant(index, site.receiverType, node.symbol) ?? site.receiverType : undefined;
      if (!superclass) return { candidates: [], resolution: "unresolved", note: "super without a known superclass in this root" };
      const found = this.lookupMethod(index, superclass, def.name, def.kind === "singleton_method");
      if (found.length) return { candidates: toCandidates(found), resolution: "exact", via: "superclass" };
      return { candidates: [], resolution: "unresolved", note: `${superclass} and its ancestors under ${this.rootDisplay} define no ${def.name}; the super target is outside this root or dynamic.` };
    }

    const receiverType = site.receiverType;
    if (!receiverType) return undefined;
    const typeSymbol = resolveIndexedConstant(index, receiverType, node.symbol) ?? (index.namespaces.has(receiverType) ? receiverType : undefined);
    const singleton = site.receiverKind === "constant";
    const implicit = site.receiverKind === "implicit" || site.receiverKind === "self";
    if (!typeSymbol) {
      if (implicit) return undefined;
      if (site.via === "named") return undefined;
      return { candidates: [], resolution: "external", via: site.receiverKind === "constant" ? "constant" : site.via, note: `receiver ${receiverType} is not defined under ${this.rootDisplay}; it comes from the platform, a gem or another component.` };
    }
    const found = this.lookupMethod(index, typeSymbol, site.name, singleton || (implicit && def.kind === "singleton_method"));
    if (found.length) {
      const resolution: Resolution = site.via === "named" || found.length > 1 ? "static_candidate" : "exact";
      const via = site.receiverKind === "constant" ? "constant" : implicit ? "self" : site.via ?? "typed";
      const note = site.via === "named" ? `receiver type ${receiverType} guessed from the variable name` : site.via === "assigned" ? `receiver type ${receiverType} inferred from an assignment` : undefined;
      return { candidates: toCandidates(found.slice(0, MAX_CANDIDATES_PER_CALL)), resolution, via, note };
    }
    if (implicit) return undefined;
    if (site.via === "named") return undefined;
    return { candidates: [], resolution: "unresolved", via: site.via, note: `${typeSymbol} and its ancestors under ${this.rootDisplay} define no ${site.name}; delegated, dynamic, or defined outside this root.` };
  }

  private realCwd?: string;

  private displayRealPath(absolute: string): string {
    this.realCwd ??= (() => {
      try {
        return realpathSync(this.options.cwd);
      } catch {
        return this.options.cwd;
      }
    })();
    let real = absolute;
    try {
      real = realpathSync(absolute);
    } catch {
      real = absolute;
    }
    const direct = displaySearchRoot(this.options.cwd, absolute);
    if (!direct.startsWith("..") && !isAbsolute(direct)) return direct;
    return displaySearchRoot(this.realCwd, real);
  }

  private resolveFromTarget(site: CallSite): { candidates: Candidate[]; resolution: Resolution; note?: string; via?: EdgeVia } {
    const target = site.target!;
    if (target.external) return { candidates: [], resolution: "external", via: "checker", note: `from package ${target.external}` };
    const display = this.displayRealPath(target.path);
    if (display.startsWith("..") || isAbsolute(display)) return { candidates: [], resolution: "external", via: "checker", note: `declared outside the repository at ${target.path}` };
    const note = target.declaration ? "resolved to a declaration file; the implementation lives in the package that builds it" : undefined;
    return { candidates: [{ path: display, line: target.line, text: target.symbol ?? site.name, symbol: target.symbol }], resolution: "exact", via: "checker", note };
  }

  private lookupMethod(index: RubyIndex, typeSymbol: string, name: string, singleton: boolean): IndexedDefinition[] {
    for (const ancestor of ancestorsOf(index, typeSymbol)) {
      const direct = index.bySymbol.get(`${ancestor}${singleton ? "." : "#"}${name}`) ?? [];
      if (direct.length) return direct;
      if (singleton) {
        const instanceOnModule = index.bySymbol.get(`${ancestor}#${name}`) ?? [];
        if (instanceOnModule.length && index.namespaces.get(ancestor)?.kind === "module") return instanceOnModule;
      }
      const declared = (index.byName.get(name) ?? []).filter((item) => item.owner === ancestor && !["method", "singleton_method", "class", "module", "test"].includes(item.kind));
      if (declared.length) return declared;
    }
    return [];
  }

  tooCommon(name: string): boolean {
    return name.length < 4 || RUBY_COMMON_METHODS.has(name) || JS_GLOBALS.has(name) || ["render", "perform", "call", "execute", "run", "handle", "main", "default", "index", "show", "create", "update", "destroy"].includes(name);
  }

  private async indexedReferences(name: string, options: { exclude?: SparsityNode; onlyTests?: boolean; skipTests?: boolean; limit: number; depth?: number; perFile?: boolean }): Promise<{ hits: ReferenceHit[]; totalFiles: number }> {
    const index = this.rubyIndex!;
    const sites = index.callSites.get(name) ?? [];
    const ownerSymbol = options.exclude?.symbol.split(/[#. ]/)[0];
    const ownerAncestors = ownerSymbol ? ancestorsOf(index, ownerSymbol) : [];
    const compatible = (receiverType: string | undefined, fromDef: string | undefined): boolean => {
      if (!receiverType || !ownerSymbol) return true;
      const resolved = resolveIndexedConstant(index, receiverType, fromDef) ?? receiverType;
      if (!index.namespaces.has(resolved)) return true;
      return resolved === ownerSymbol || ancestorsOf(index, resolved).includes(ownerSymbol) || ownerAncestors.includes(resolved);
    };
    const filtered = sites
      .filter((site) => !(options.exclude && site.path === options.exclude.path && site.line >= options.exclude.startLine && site.line <= options.exclude.endLine))
      .filter((site) => !(options.skipTests && isTestPath(site.path)))
      .filter((site) => !(options.onlyTests && !isTestPath(site.path)))
      .filter((site) => compatible(site.receiverType, site.inDef))
      .sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path) || a.line - b.line);
    const chosen: typeof filtered = [];
    const seenFiles = new Set<string>();
    for (const site of filtered) {
      if (options.perFile !== false && seenFiles.has(site.path)) continue;
      seenFiles.add(site.path);
      chosen.push(site);
    }
    const hits: ReferenceHit[] = [];
    for (const site of chosen) {
      if (hits.length >= options.limit) break;
      const created = await this.node(site.path, site.line, options.depth ?? 1, site.line);
      if (!created) continue;
      hits.push({ node: created.node, def: created.def, line: site.line, text: await this.lineText(site.path, site.line), test: isTestPath(site.path) });
    }
    return { hits, totalFiles: seenFiles.size };
  }

  async references(name: string, language: Language, options: { exclude?: SparsityNode; onlyTests?: boolean; skipTests?: boolean; limit: number; depth?: number; perFile?: boolean }, signal?: AbortSignal): Promise<{ hits: ReferenceHit[]; totalFiles: number }> {
    if (language === "ruby" && this.rubyIndex && !this.rubyIndex.skipped) return this.indexedReferences(name, options);
    const escaped = escapeRegex(name);
    const tail = /[?!=]$/.test(name) ? "" : "([^\\w?!=]|$)";
    const pattern = `(^|[^\\w:@$.]|\\.)${escaped}${tail}`;
    const typeArgs = language === "ruby" ? ["-t", "ruby"] : ["-t", "ts", "-t", "js"];
    const globArgs = options.onlyTests
      ? ["-g", "**/test/**", "-g", "**/tests/**", "-g", "**/spec/**", "-g", "**/__tests__/**", "-g", "**/*.test.*", "-g", "**/*.spec.*", "-g", "**/*_test.rb", "-g", "**/*_spec.rb"]
      : [];
    const raw = await rgJson([...typeArgs, ...globArgs, "--max-count", "4", "-e", pattern, this.root], this.options.cwd, this.budget, signal);
    const filtered = raw
      .filter((hit) => !(options.exclude && hit.path === options.exclude.path && hit.line >= options.exclude.startLine && hit.line <= options.exclude.endLine))
      .filter((hit) => !/^\s*(def|function|const|let|var|class|export|scope|import|require)\b/.test(hit.text))
      .filter((hit) => !/^\s*(#|\/\/|\*)/.test(hit.text))
      .filter((hit) => !insideStringLiteral(hit.text, name))
      .filter((hit) => !(options.skipTests && isTestPath(hit.path)))
      .filter((hit) => !(options.onlyTests && !isTestPath(hit.path)));
    const chosen: RgHit[] = [];
    const seenFiles = new Set<string>();
    for (const hit of filtered) {
      if (options.perFile !== false && seenFiles.has(hit.path)) continue;
      if (language === "javascript") {
        const lines = await this.lines(hit.path);
        if (lines && insideJsImport(lines, hit.line)) continue;
        const facts = lines ? this.tsFacts(hit.path, lines) : undefined;
        if (facts && !tsAdapter.confirmsReference(facts, hit.line, name)) continue;
      }
      seenFiles.add(hit.path);
      chosen.push(hit);
    }
    const ranked = chosen.sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path) || a.line - b.line);
    const hits: ReferenceHit[] = [];
    for (const hit of ranked) {
      if (hits.length >= options.limit) break;
      const created = await this.node(hit.path, hit.line, options.depth ?? 1, hit.line);
      if (!created) continue;
      hits.push({ node: created.node, def: created.def, line: hit.line, text: hit.text.trim(), test: isTestPath(hit.path) });
    }
    return { hits, totalFiles: seenFiles.size };
  }

  async callers(anchor: SparsityNode, def: Definition, signal?: AbortSignal, limit = MAX_CALLERS): Promise<ReferenceHit[]> {
    const name = def.name;
    if (def.kind === "declaration" || def.kind === "statement" || def.kind === "constant") return [];
    if (this.tooCommon(name)) {
      this.notes.push(`callers of ${name} skipped: name too common to search usefully; search a qualified receiver instead.`);
      return [];
    }
    const { hits, totalFiles } = await this.references(name, anchor.language, { exclude: anchor, limit }, signal);
    if (totalFiles > MAX_CALLER_FILES) this.notes.push(`callers of ${name}: ${totalFiles} files reference the name; showing ${hits.length}. Treat this as a high-fanout boundary.`);
    else if (totalFiles > hits.length) this.frontier.push(`callers of ${name}: ${totalFiles - hits.length} more files not expanded`);

    for (const hit of hits) {
      this.edges.push({
        from: hit.node.id,
        to: anchor.id,
        name,
        relationship: "called_by",
        resolution: "static_candidate",
        line: hit.line,
        note: hit.test ? "test" : undefined,
      });
    }
    return hits;
  }

  async definitionExists(name: string, language: Language, signal?: AbortSignal): Promise<boolean> {
    if (language === "ruby") {
      const hits = await rgJson(["-t", "ruby", "--max-count", "1", ...this.rubyMethodPattern(name).flatMap((pattern) => ["-e", pattern]), this.root], this.options.cwd, this.budget, signal);
      return hits.length > 0;
    }
    const escaped = escapeRegex(name);
    const hits = await rgJson(["-t", "ts", "-t", "js", "--max-count", "1", "-e", `\\b(function\\s*\\*?|const|let|var|class)\\s+${escaped}([^\\w$]|$)`, "-e", `^\\s*((public|private|protected|static|async|override)\\s+)*${escaped}\\s*(<[^>]*>)?\\s*\\([^)]*\\)\\s*(:[^{;=]+)?\\s*\\{\\s*$`, this.root], this.options.cwd, this.budget, signal);
    return hits.length > 0;
  }

  async tests(anchor: SparsityNode, def: Definition, signal?: AbortSignal, limit = 10): Promise<ReferenceHit[]> {
    if (def.kind === "declaration" || def.kind === "statement" || def.kind === "constant") return [];
    if (this.tooCommon(def.name)) return [];
    const { hits } = await this.references(def.name, anchor.language, { exclude: anchor, onlyTests: true, limit, perFile: false }, signal);
    return hits;
  }
}

export async function collectSparsity(options: SparsityOptions): Promise<SparsityResult> {
  const { path, line } = parseTarget(options.target);
  const absolute = ensureInsideCwd(options.cwd, path);
  if (!(await fileExists(absolute))) throw new Error(`target file not found: ${path}`);
  await ensureRealPathInsideCwd(options.cwd, absolute);
  const language = languageFor(absolute);
  if (!language) throw new Error(`unsupported language for ${path}; sparsity_collect handles Ruby and JS/TS files`);

  const root = await findRoot(options.cwd, absolute, options.root);
  const rubyReady = language === "ruby" ? await rubyAdapter.ready() : false;
  const rubyIndex = language === "ruby" && rubyReady && options.indexCacheDir
    ? await buildRubyIndex({ cwd: options.cwd, root: displaySearchRoot(options.cwd, root), cacheDir: options.indexCacheDir, signal: options.signal })
    : undefined;
  const tsPrograms = language === "javascript" ? new TsPrograms(options.cwd) : undefined;
  tsPrograms?.prepare([absolute], options.signal);
  const collector = new Collector(options, root, { rubyReady, rubyIndex: rubyIndex && !rubyIndex.skipped ? rubyIndex : undefined, tsPrograms });
  const anchor = await collector.node(displaySearchRoot(options.cwd, absolute), line, 0, line);
  if (!anchor) throw new Error(`no definition found around ${path}:${line}`);

  const queue: QueueItem[] = [
    { node: anchor.node, def: anchor.def, depth: 0, ancestry: [] },
  ];
  while (queue.length) {
    const item = queue.shift()!;
    if (collector.budget.exhausted || options.signal?.aborted) {
      collector.frontier.push(`${item.node.id} ${item.node.symbol} not expanded (budget)`);
      continue;
    }
    await collector.expand(item.node, item.def, item.depth, item.ancestry, queue, options.signal);
  }
  if (options.callers && !collector.budget.exhausted) await collector.callers(anchor.node, anchor.def, options.signal);

  const notes = [
    ...collector.notes,
    ...(describeRubyIndex(rubyIndex) ? [describeRubyIndex(rubyIndex)!] : []),
    ...(tsPrograms?.describe() ?? []),
    ...(language === "ruby" && !rubyReady ? ["Prism parser unavailable; Ruby definitions and calls came from the regex engine."] : []),
    language === "ruby"
      ? "Ruby destinations are static candidates found by definition name; dynamic dispatch, mixins and metaprogramming are not proven."
      : "JS/TS destinations follow imports and same-file definitions; runtime dispatch and dependency injection are not proven.",
    `Searched under ${collector.rootDisplay}; nothing outside that root was inspected.`,
  ];

  const result: SparsityResult = {
    target: { path: anchor.node.path, line, language },
    anchor: anchor.node,
    nodes: collector.nodes,
    edges: collector.edges,
    coverage: {
      root: collector.rootDisplay,
      maxDepth: options.maxDepth,
      depthReached: collector.depthReached,
      vicinity: options.vicinity,
      nodes: collector.nodes.length,
      edges: collector.edges.length,
      unresolved: collector.edges.filter((edge) => edge.resolution === "unresolved").length,
      truncatedBy: collector.budget.truncatedBy,
      frontier: uniqueValues(collector.frontier),
      cycles: uniqueValues(collector.cycles),
      rgCalls: collector.budget.rgCalls,
      elapsedMs: collector.budget.elapsedMs,
      notes,
    },
  };
  if (options.metricsLog) {
    await appendMetricsLine(options.metricsLog, {
      kind: "sparsity_collect",
      at: new Date().toISOString(),
      cwd: options.cwd,
      label: `${result.target.path}:${line}`,
      elapsedMs: result.coverage.elapsedMs,
      rgCalls: result.coverage.rgCalls,
      truncatedBy: result.coverage.truncatedBy,
      nodes: result.nodes.length,
      edges: result.edges.length,
      ...edgeMetrics(result.nodes, result.edges),
      index: indexMetrics(rubyIndex ? [rubyIndex] : []),
      programs: tsPrograms?.summary() ?? [],
    }).catch(() => undefined);
  }
  return result;
}

export function formatSparsity(result: SparsityResult): string {
  const { anchor, coverage } = result;
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  const out: string[] = [];
  out.push(`sparsity_collect ${result.target.path}:${result.target.line} (${result.target.language}) root ${coverage.root} depth ${coverage.depthReached}/${coverage.maxDepth} vicinity ±${coverage.vicinity}`);
  out.push("");
  out.push(`ANCHOR ${anchor.id} ${anchor.symbol} [${anchor.kind}] ${anchor.path}:${anchor.startLine}-${anchor.endLine} fp ${anchor.fingerprint}`);
  out.push(anchor.snippet);

  const outgoing = result.edges.filter((edge) => edge.relationship !== "called_by");
  const incoming = result.edges.filter((edge) => edge.relationship === "called_by");

  if (outgoing.length) {
    out.push("");
    out.push("EDGES (from → to, resolution)");
    for (const edge of outgoing) {
      const target = edge.to ? byId.get(edge.to) : undefined;
      const destination = target ? `${edge.to} ${target.symbol} ${target.path}:${target.startLine}` : "?";
      const extra = [edge.note, edge.candidates ? `candidates: ${edge.candidates.join(", ")}` : undefined].filter(Boolean).join("; ");
      out.push(`  ${edge.from}:${edge.line} -${edge.relationship}-> ${destination}  \`${edge.name}\` [${edge.via ? `${edge.resolution}, ${edge.via}` : edge.resolution}]${extra ? `  ${extra}` : ""}`);
    }
  }

  if (incoming.length) {
    out.push("");
    out.push(`CALLERS of ${anchor.symbol} (depth 1, static, capped at ${MAX_CALLERS})`);
    for (const edge of incoming) {
      const caller = byId.get(edge.from);
      if (!caller) continue;
      out.push(`  ${caller.id} ${caller.symbol} ${caller.path}:${edge.line}${edge.note ? ` (${edge.note})` : ""}`);
    }
  }

  const others = result.nodes.filter((node) => node.id !== anchor.id);
  if (others.length) {
    out.push("");
    out.push("NODES");
    for (const node of others) {
      out.push(`${node.id} ${node.symbol} [${node.kind}] ${node.path}:${node.startLine}-${node.endLine} fp ${node.fingerprint} depth ${node.depth}`);
      out.push(node.snippet);
      out.push("");
    }
  }

  out.push("COVERAGE");
  out.push(`  nodes ${coverage.nodes}, edges ${coverage.edges}, unresolved ${coverage.unresolved}, rg calls ${coverage.rgCalls}, ${coverage.elapsedMs} ms, truncated: ${coverage.truncatedBy}`);
  if (coverage.cycles.length) out.push(`  cycles: ${coverage.cycles.join("; ")}`);
  if (coverage.frontier.length) {
    out.push(`  frontier (${coverage.frontier.length} not expanded):`);
    for (const item of coverage.frontier.slice(0, 20)) out.push(`    - ${item}`);
    if (coverage.frontier.length > 20) out.push(`    - … ${coverage.frontier.length - 20} more`);
  }
  for (const note of coverage.notes) out.push(`  note: ${note}`);
  out.push(`  labels: ${EDGE_LABELS}`);
  return out.join("\n");
}

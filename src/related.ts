import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RelatedExpansionDetails {
  enabled: boolean;
  label: "mixin" | "import" | "related";
  roots: string[];
  resolved: Array<{ from: string; name: string; path: string; relationship: string; note: string }>;
  unresolved: Array<{ from: string; name: string }>;
}

interface RubyMixinReference {
  kind: "include" | "prepend" | "extend";
  name: string;
}

const RUBY_MIXIN_IGNORE_NAMES = new Set([
  "ActiveSupport::Concern",
]);

const JS_TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];
const JS_TS_EXTENSION_SET = new Set(JS_TS_EXTENSIONS);

function normalizeRepoRelativePath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\/+/, "");
}

function camelToSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function rootToResolvedPath(cwd: string, root: string): string {
  return isAbsolute(root) ? resolve(root) : resolve(cwd, root);
}

function displaySearchRoot(cwd: string, resolved: string): string {
  const rel = relative(cwd, resolved);
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !isAbsolute(rel)) return normalizeRepoRelativePath(rel);
  return normalizeRepoRelativePath(resolved);
}

function parseRubyMixinReferences(source: string): RubyMixinReference[] {
  const references: RubyMixinReference[] = [];

  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/#.*$/, "");
    const match = line.match(/^\s*(include|prepend|extend)\s+(.+?)\s*$/);
    if (!match) continue;

    const kind = match[1] as RubyMixinReference["kind"];
    const names = match[2]!
      .split(",")
      .map((name) => name.replace(/\s+(if|unless)\b.*$/, "").trim())
      .map((name) => name.replace(/^::/, ""))
      .filter((name) => /^[A-Z][\w]*(?:::[A-Z][\w]*)*$/.test(name))
      .filter((name) => !RUBY_MIXIN_IGNORE_NAMES.has(name));

    for (const name of names) references.push({ kind, name });
  }

  return references;
}

function moduleNameToPath(name: string): string {
  return `${name.split("::").map(camelToSnake).join("/")}.rb`;
}

function inferProjectRootFromRubyPath(resolvedPath: string): string | undefined {
  const parts = normalizeRepoRelativePath(resolvedPath).split("/");
  const appIndex = parts.lastIndexOf("app");
  if (appIndex <= 0) return undefined;
  return parts.slice(0, appIndex).join("/") || "/";
}

function rubyMixinCandidatePaths(resolvedFrom: string, name: string): string[] {
  const modulePath = moduleNameToPath(name);
  const moduleBase = basename(modulePath);
  const fromDirectory = dirname(resolvedFrom);
  const fromNamespace = basename(resolvedFrom, extname(resolvedFrom));
  const projectRoot = inferProjectRootFromRubyPath(resolvedFrom);
  const candidates = [
    join(fromDirectory, fromNamespace, modulePath),
    join(fromDirectory, fromNamespace, moduleBase),
    join(fromDirectory, modulePath),
  ];

  if (projectRoot) {
    candidates.push(
      join(projectRoot, "app/models/concerns", modulePath),
      join(projectRoot, "app/models/concerns", fromNamespace, moduleBase),
      join(projectRoot, "app/controllers/concerns", modulePath),
      join(projectRoot, "app/controllers/concerns", fromNamespace, moduleBase),
      join(projectRoot, "app/models", modulePath),
      join(projectRoot, "lib", modulePath),
    );
  }

  return uniqueValues(candidates);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

export async function expandRubyMixins(cwd: string, roots: string[]): Promise<RelatedExpansionDetails> {
  const details: RelatedExpansionDetails = { enabled: true, label: "mixin", roots: [], resolved: [], unresolved: [] };
  const queue = roots.filter((root) => extname(root).toLowerCase() === ".rb");
  const visited = new Set<string>();
  const maxMixinFiles = 25;

  while (queue.length > 0 && details.roots.length < maxMixinFiles) {
    const root = queue.shift()!;
    const resolvedRoot = rootToResolvedPath(cwd, root);
    if (visited.has(resolvedRoot)) continue;
    visited.add(resolvedRoot);

    let source: string;
    try {
      source = await readFile(resolvedRoot, "utf8");
    } catch {
      continue;
    }

    for (const reference of parseRubyMixinReferences(source)) {
      const candidates = rubyMixinCandidatePaths(resolvedRoot, reference.name);
      const resolvedPath = await (async () => {
        for (const candidate of candidates) {
          if (await fileExists(candidate)) return candidate;
        }
        return undefined;
      })();

      if (!resolvedPath) {
        details.unresolved.push({ from: displaySearchRoot(cwd, resolvedRoot), name: reference.name });
        continue;
      }

      const displayPath = displaySearchRoot(cwd, resolvedPath);
      if (!details.roots.includes(displayPath)) details.roots.push(displayPath);
      details.resolved.push({
        from: displaySearchRoot(cwd, resolvedRoot),
        name: reference.name,
        path: displayPath,
        relationship: "included by",
        note: "mixin also includes search values, very likely a target too",
      });
      if (!visited.has(resolvedPath)) queue.push(displayPath);
    }
  }

  return details;
}

function parseJsImportReferences(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^"']*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier?.startsWith(".")) specifiers.push(specifier);
    }
  }

  return uniqueValues(specifiers);
}

function jsImportCandidatePaths(resolvedFrom: string, specifier: string): string[] {
  const base = resolve(dirname(resolvedFrom), specifier);
  const ext = extname(base).toLowerCase();
  const candidates: string[] = [];

  if (ext) candidates.push(base);
  for (const candidateExt of JS_TS_EXTENSIONS) candidates.push(`${base}${candidateExt}`);
  for (const candidateExt of JS_TS_EXTENSIONS) candidates.push(join(base, `index${candidateExt}`));

  return uniqueValues(candidates);
}

export async function expandJsTsImports(cwd: string, roots: string[]): Promise<RelatedExpansionDetails> {
  const details: RelatedExpansionDetails = { enabled: true, label: "import", roots: [], resolved: [], unresolved: [] };
  const queue = roots.filter((root) => JS_TS_EXTENSION_SET.has(extname(root).toLowerCase()));
  const visited = new Set<string>();
  const maxImportFiles = 50;

  while (queue.length > 0 && details.roots.length < maxImportFiles) {
    const root = queue.shift()!;
    const resolvedRoot = rootToResolvedPath(cwd, root);
    if (visited.has(resolvedRoot)) continue;
    visited.add(resolvedRoot);

    let source: string;
    try {
      source = await readFile(resolvedRoot, "utf8");
    } catch {
      continue;
    }

    for (const specifier of parseJsImportReferences(source)) {
      const candidates = jsImportCandidatePaths(resolvedRoot, specifier);
      const resolvedPath = await (async () => {
        for (const candidate of candidates) {
          if (await fileExists(candidate)) return candidate;
        }
        return undefined;
      })();

      if (!resolvedPath) {
        details.unresolved.push({ from: displaySearchRoot(cwd, resolvedRoot), name: specifier });
        continue;
      }

      const displayPath = displaySearchRoot(cwd, resolvedPath);
      if (!details.roots.includes(displayPath)) details.roots.push(displayPath);
      details.resolved.push({
        from: displaySearchRoot(cwd, resolvedRoot),
        name: specifier,
        path: displayPath,
        relationship: "imported by",
        note: "related import also includes search values, very likely a target too",
      });
      if (!visited.has(resolvedPath)) queue.push(displayPath);
    }
  }

  return details;
}

function mergeRelatedExpansions(expansions: RelatedExpansionDetails[]): RelatedExpansionDetails | undefined {
  const active = expansions.filter((expansion) => expansion.roots.length > 0 || expansion.unresolved.length > 0);
  if (active.length === 0) return undefined;

  const label = active.length === 1 ? active[0]!.label : "related";
  return {
    enabled: true,
    label,
    roots: uniqueValues(active.flatMap((expansion) => expansion.roots)),
    resolved: active.flatMap((expansion) => expansion.resolved),
    unresolved: active.flatMap((expansion) => expansion.unresolved),
  };
}

export async function expandRelatedFiles(cwd: string, roots: string[]): Promise<RelatedExpansionDetails | undefined> {
  return mergeRelatedExpansions([
    await expandRubyMixins(cwd, roots),
    await expandJsTsImports(cwd, roots),
  ]);
}

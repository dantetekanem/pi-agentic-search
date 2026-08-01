import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { camelToSnake, displaySearchRoot, normalizeRepoRelativePath, uniqueValues } from "./shared.ts";

export interface RelatedResolvedReference {
  from: string;
  name: string;
  path: string;
  relationship: string;
  note: string;
  kind?: "file" | "package";
  entryPath?: string;
}

export interface RelatedPackageRoot {
  from: string;
  name: string;
  path: string;
  entryPath: string;
}

export interface RelatedExpansionDetails {
  enabled: boolean;
  label: "mixin" | "import" | "related";
  roots: string[];
  packageRoots: RelatedPackageRoot[];
  resolved: RelatedResolvedReference[];
  unresolved: Array<{ from: string; name: string }>;
}

export function relatedReferencesForPath(
  related: RelatedExpansionDetails | undefined,
  path: string,
): RelatedResolvedReference[] {
  if (!related) return [];
  const normalizedPath = normalizeRepoRelativePath(path);
  return related.resolved.filter((reference) => {
    const normalizedReference = normalizeRepoRelativePath(reference.path);
    if (reference.kind !== "package") return normalizedReference === normalizedPath;
    return normalizedPath === normalizedReference || normalizedPath.startsWith(`${normalizedReference}/`);
  });
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
const RUBY_EXTENSION = ".rb";

const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build", "coverage", "tmp", "log", ".next", ".turbo", "target"]);
const MAX_DIR_WALK_FILES = 200;

function rootToResolvedPath(cwd: string, root: string): string {
  return isAbsolute(root) ? resolve(root) : resolve(cwd, root);
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

async function collectSourceFiles(cwd: string, root: string): Promise<string[]> {
  const resolved = rootToResolvedPath(cwd, root);
  const out: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8 || out.length >= MAX_DIR_WALK_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_DIR_WALK_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else {
        const ext = extname(entry.name).toLowerCase();
        if (ext === RUBY_EXTENSION || JS_TS_EXTENSION_SET.has(ext)) out.push(full);
      }
    }
  }

  try {
    const stats = await stat(resolved);
    if (stats.isDirectory()) await walk(resolved, 0);
    else if (stats.isFile()) out.push(resolved);
  } catch {
    // root doesn't exist
  }
  return out;
}

export async function expandRubyMixins(cwd: string, roots: string[]): Promise<RelatedExpansionDetails> {
  const details: RelatedExpansionDetails = {
    enabled: true,
    label: "mixin",
    roots: [],
    packageRoots: [],
    resolved: [],
    unresolved: [],
  };
  const queue: string[] = [];

  for (const root of roots) {
    const resolved = rootToResolvedPath(cwd, root);
    const s = await stat(resolved).catch(() => undefined);
    if (s?.isDirectory()) {
      for (const f of await collectSourceFiles(cwd, root)) {
        if (extname(f).toLowerCase() === RUBY_EXTENSION) queue.push(displaySearchRoot(cwd, f));
      }
    } else if (extname(resolved).toLowerCase() === RUBY_EXTENSION) {
      queue.push(root);
    }
  }

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
      if (specifier) specifiers.push(specifier);
    }
  }

  return uniqueValues(specifiers);
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("#") || isBuiltin(specifier)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return undefined;
  const segments = specifier.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  return specifier.startsWith("@") && segments.length >= 2
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
}

async function findPackageRoot(entryPath: string, expectedName: string): Promise<string | undefined> {
  let current = dirname(entryPath);
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as { name?: unknown };
      if (manifest.name === expectedName) return current;
    } catch {
      // Continue upward until the package owning the resolved entry is found.
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function displayCanonicalSearchRoot(cwd: string, resolvedPath: string): Promise<string> {
  const directDisplay = displaySearchRoot(cwd, resolvedPath);
  if (!isAbsolute(directDisplay) && !directDisplay.startsWith("..")) return directDisplay;

  const [canonicalCwd, canonicalPath] = await Promise.all([
    realpath(cwd).catch(() => resolve(cwd)),
    realpath(resolvedPath).catch(() => resolve(resolvedPath)),
  ]);
  const canonicalRelative = relative(canonicalCwd, canonicalPath);
  if (canonicalRelative === "") return ".";
  if (!canonicalRelative.startsWith("..") && !isAbsolute(canonicalRelative)) {
    return normalizeRepoRelativePath(canonicalRelative);
  }
  return displaySearchRoot(cwd, resolvedPath);
}

async function nodeModulesAncestors(seed: string | undefined): Promise<string[]> {
  if (!seed) return [];
  const logicalSeed = resolve(seed);
  const canonicalSeed = await realpath(logicalSeed).catch(() => logicalSeed);
  const directories: string[] = [];

  for (const candidateSeed of uniqueValues([logicalSeed, canonicalSeed])) {
    let current = dirname(candidateSeed);
    while (true) {
      directories.push(join(current, "node_modules"));
      if (basename(current) === "node_modules") directories.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return uniqueValues(directories);
}

async function packageRootFromSearchDirectories(
  packageName: string,
  searchDirectories: string[],
): Promise<string | undefined> {
  for (const directory of uniqueValues(searchDirectories)) {
    const candidate = join(directory, packageName);
    try {
      const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")) as { name?: unknown };
      if (manifest.name === packageName) return candidate;
    } catch {
      // Try the next Node resolution directory.
    }
  }
  return undefined;
}

async function resolvePackageImport(
  cwd: string,
  resolvedFrom: string,
  specifier: string,
): Promise<RelatedPackageRoot | undefined> {
  const packageName = packageNameFromSpecifier(specifier);
  if (!packageName) return undefined;

  const resolvers = [createRequire(resolvedFrom), createRequire(import.meta.url)];
  for (const resolver of resolvers) {
    let entryPath: string;
    try {
      entryPath = resolver.resolve(specifier);
    } catch {
      continue;
    }

    const packageRoot = await findPackageRoot(entryPath, packageName);
    if (!packageRoot) continue;
    return {
      from: displaySearchRoot(cwd, resolvedFrom),
      name: packageName,
      path: await displayCanonicalSearchRoot(cwd, packageRoot),
      entryPath: await displayCanonicalSearchRoot(cwd, entryPath),
    };
  }

  const runtimeSearchDirectories = await nodeModulesAncestors(process.argv[1]);
  const resolverSearchDirectories = resolvers.flatMap((resolver) => resolver.resolve.paths(packageName) ?? []);
  const packageRoot = await packageRootFromSearchDirectories(
    packageName,
    [...runtimeSearchDirectories, ...resolverSearchDirectories],
  );
  if (!packageRoot) return undefined;

  return {
    from: displaySearchRoot(cwd, resolvedFrom),
    name: packageName,
    path: await displayCanonicalSearchRoot(cwd, packageRoot),
    entryPath: await displayCanonicalSearchRoot(cwd, packageRoot),
  };
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
  const details: RelatedExpansionDetails = {
    enabled: true,
    label: "import",
    roots: [],
    packageRoots: [],
    resolved: [],
    unresolved: [],
  };
  const queue: string[] = [];

  for (const root of roots) {
    const resolved = rootToResolvedPath(cwd, root);
    const s = await stat(resolved).catch(() => undefined);
    if (s?.isDirectory()) {
      for (const f of await collectSourceFiles(cwd, root)) {
        if (JS_TS_EXTENSION_SET.has(extname(f).toLowerCase())) queue.push(displaySearchRoot(cwd, f));
      }
    } else if (JS_TS_EXTENSION_SET.has(extname(resolved).toLowerCase())) {
      queue.push(root);
    }
  }

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
      if (!specifier.startsWith(".")) {
        const packageName = packageNameFromSpecifier(specifier);
        if (!packageName) continue;
        const packageRoot = await resolvePackageImport(cwd, resolvedRoot, specifier);
        if (!packageRoot) {
          if (!details.unresolved.some((item) => item.from === displaySearchRoot(cwd, resolvedRoot) && item.name === specifier)) {
            details.unresolved.push({ from: displaySearchRoot(cwd, resolvedRoot), name: specifier });
          }
          continue;
        }
        if (!details.packageRoots.some((item) => item.path === packageRoot.path)) {
          details.packageRoots.push(packageRoot);
        }
        if (!details.resolved.some((item) => item.kind === "package" && item.path === packageRoot.path)) {
          details.resolved.push({
            from: packageRoot.from,
            name: packageRoot.name,
            path: packageRoot.path,
            entryPath: packageRoot.entryPath,
            kind: "package",
            relationship: "package imported by",
            note: "imported package surface was searched in the same agentic_search call",
          });
        }
        continue;
      }

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
        kind: "file",
        relationship: "imported by",
        note: "related import also includes search values, very likely a target too",
      });
      if (!visited.has(resolvedPath)) queue.push(displayPath);
    }
  }

  return details;
}

function mergeRelatedExpansions(expansions: RelatedExpansionDetails[]): RelatedExpansionDetails | undefined {
  const active = expansions.filter(
    (expansion) => expansion.roots.length > 0 || expansion.packageRoots.length > 0 || expansion.unresolved.length > 0,
  );
  if (active.length === 0) return undefined;

  const label = active.length === 1 ? active[0]!.label : "related";
  const packageRoots = active
    .flatMap((expansion) => expansion.packageRoots)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.path === item.path) === index);
  return {
    enabled: true,
    label,
    roots: uniqueValues(active.flatMap((expansion) => expansion.roots)),
    packageRoots,
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

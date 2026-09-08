import { extname } from "node:path";
import { JS_TS_EXTENSIONS } from "./classifications.ts";
import { ProjectFiles } from "./inventory.ts";
import { SearchRequest } from "./retrieval.ts";
import { JavascriptResolver } from "./resolvers/javascript.ts";
import { RubyResolver } from "./resolvers/ruby.ts";
import { normalizeRepoRelativePath } from "./shared.ts";
import type { RelatedExpansionDetails, RelatedResolvedReference, SearchIntent } from "./types.ts";
export type { RelatedExpansionDetails, RelatedResolvedReference, RelatedPackageRoot } from "./types.ts";

type Language = "ruby" | "javascript";
function language(path: string): Language | undefined {
  const extension = extname(path).toLowerCase();
  return extension === ".rb" ? "ruby" : JS_TS_EXTENSIONS.has(extension) ? "javascript" : undefined;
}

export function relatedReferencesForPath(related: RelatedExpansionDetails | undefined, path: string): RelatedResolvedReference[] {
  const normalized = normalizeRepoRelativePath(path);
  return related?.resolved.filter((reference) => {
    const candidate = normalizeRepoRelativePath(reference.path);
    return candidate === normalized || (reference.kind === "package" && normalized.startsWith(`${candidate}/`));
  }) ?? [];
}

async function traverse(files: ProjectFiles, roots: string[], only?: Language, intent?: SearchIntent): Promise<RelatedExpansionDetails> {
  const details: RelatedExpansionDetails = { enabled: true, label: "related", roots: [], packageRoots: [], resolved: [], unresolved: [], skipped: files.skipped };
  const queue: string[] = [];
  const explicitFiles = new Set<string>();
  const visited = new Set<string>();
  const relatedPaths = new Set<string>();
  const packages = new Set<string>();
  const languages = new Set<Language>();
  const ruby = new RubyResolver(files);
  const javascript = new JavascriptResolver(files, { intent });
  let examinedEdges = 0;
  let omittedEdges = 0;
  let rubyFiles = 0;

  for (const root of roots) {
    if (!files.alive()) break;
    const canonical = await files.canonical(root);
    if ((await files.fileStat(canonical))?.isFile()) explicitFiles.add(canonical);
    const candidates = (await files.list(root)).filter((path) => language(path) && (!only || language(path) === only));
    const room = Math.max(0, files.limits.nodes - queue.length);
    queue.push(...candidates.slice(0, room));
    if (candidates.length > room) files.omitFiles(candidates.length - room, `initial source file budget: ${candidates.length - room} candidates unvisited; next ${files.display(candidates[room]!)}`);
  }
  let cursor = 0;
  while (cursor < queue.length && files.alive()) {
    const from = await files.canonical(queue[cursor++]!);
    if (visited.has(from)) continue;
    if (visited.size >= files.limits.nodes) {
      files.omitFiles(queue.length - cursor + 1, `source node budget: ${queue.length - cursor + 1} candidates unvisited; next ${files.display(from)}`);
      break;
    }
    visited.add(from);
    const kind = language(from);
    if (!kind) continue;
    const adapter = kind === "ruby" ? ruby : javascript;
    const source = await files.read(from);
    if (source === undefined) continue;
    const references = adapter.references(source, from);
    if (references.length) languages.add(kind);
    for (const reference of references) {
      if (!files.alive() || examinedEdges >= files.limits.edges) {
        omittedEdges++;
        files.skip(`unvisited ${kind === "ruby" ? "mixin" : "import"} ${reference.name} from ${files.display(from)} (edge/deadline budget)`);
        continue;
      }
      examinedEdges++;
      const targets = await adapter.resolve(from, reference);
      if (!targets.length) {
        details.unresolved.push({ from: files.display(from), name: reference.name });
        continue;
      }
      for (const target of targets) {
        const packageTarget = target.kind === "package";
        const canonical = await files.canonical(target.path);
        const known = packageTarget ? packages.has(canonical) : relatedPaths.has(canonical) || explicitFiles.has(canonical);
        const full = relatedPaths.size + packages.size >= files.limits.relatedFiles || (kind === "ruby" && rubyFiles >= files.limits.rubyFiles);
        if (!known && full) {
          omittedEdges++;
          files.skip(`unvisited ${kind === "ruby" ? "mixin" : "import"} ${reference.name} from ${files.display(from)} (related-file budget)`);
          continue;
        }
        details.resolved.push(target);
        if (packageTarget) {
          if (!packages.has(canonical)) {
            packages.add(canonical);
            details.packageRoots.push({ from: target.from, name: target.name, path: target.path, entryPath: target.entryPath ?? target.path, provenance: target.provenance });
          }
        } else {
          if (!known) {
            relatedPaths.add(canonical);
            details.roots.push(target.path);
            if (kind === "ruby") rubyFiles++;
          }
          if (!visited.has(canonical) && !queue.includes(canonical)) queue.push(canonical);
        }
      }
    }
  }
  if (!files.alive() && cursor < queue.length) files.omitFiles(queue.length - cursor, `cancelled traversal: ${queue.length - cursor} queued files unvisited`);
  details.label = languages.size === 1 ? languages.has("ruby") ? "mixin" : "import" : only === "ruby" ? "mixin" : only === "javascript" ? "import" : "related";
  details.traversal = { visitedFiles: visited.size, examinedEdges, omittedEdges, ...files.stats, limits: files.limits };
  return details;
}

async function expand(cwd: string, roots: string[], signal?: AbortSignal, files?: ProjectFiles, only?: Language, intent?: SearchIntent): Promise<RelatedExpansionDetails> {
  const request = files?.request ?? new SearchRequest(signal);
  try { return await traverse(files ?? new ProjectFiles(cwd, request), roots, only, intent); }
  finally { if (!files) request.dispose(); }
}

export async function expandRelatedFiles(cwd: string, roots: string[], signal?: AbortSignal, files?: ProjectFiles, intent?: SearchIntent): Promise<RelatedExpansionDetails | undefined> {
  const details = await expand(cwd, roots, signal, files, undefined, intent);
  return details.resolved.length || details.unresolved.length || details.skipped?.length ? details : undefined;
}
export function expandRubyMixins(cwd: string, roots: string[], signal?: AbortSignal): Promise<RelatedExpansionDetails> {
  return expand(cwd, roots, signal, undefined, "ruby");
}
export function expandJsTsImports(cwd: string, roots: string[], signal?: AbortSignal): Promise<RelatedExpansionDetails> {
  return expand(cwd, roots, signal, undefined, "javascript");
}

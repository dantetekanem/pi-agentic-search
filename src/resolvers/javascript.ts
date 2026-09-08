import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { isDeclarationFile, ProjectCompiler } from "./compiler.ts";
import { ProjectFiles } from "../inventory.ts";
import { uniqueValues } from "../shared.ts";
import type { RelatedResolvedReference, RelationshipReference, SearchIntent } from "../types.ts";

function packageName(specifier: string): string | undefined {
  if (!specifier || /^[.#]/.test(specifier) || isBuiltin(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return;
  const parts = specifier.split("/").filter(Boolean);
  return specifier.startsWith("@") && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

export class JavascriptResolver {
  private readonly compiler: ProjectCompiler;
  constructor(private readonly files: ProjectFiles, private readonly options: { intent?: SearchIntent } = {}) {
    this.compiler = new ProjectCompiler(files);
  }

  references(source: string): RelationshipReference[] {
    const specifiers: string[] = [];
    const patterns = [
      /\bimport\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
      /\bexport\s+(?:type\s+)?[^"']*?\s+from\s+["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]?.trim();
        if (specifier && !isBuiltin(specifier)) specifiers.push(specifier);
      }
    }
    return uniqueValues(specifiers).map((name) => ({ name, relationship: "imported by" }));
  }

  private async findPackageRoot(entry: string, name: string): Promise<string | undefined> {
    let current = dirname(entry);
    while (this.files.alive()) {
      if ((await this.files.json(join(current, "package.json")))?.name === name) return current;
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
    return;
  }
  private async runtimeDirectories(): Promise<string[]> {
    const seed = process.argv[1];
    if (!seed) return [];
    const directories: string[] = [];
    for (const start of uniqueValues([resolve(seed), await this.files.canonical(seed)])) {
      let current = dirname(start);
      while (this.files.alive()) {
        directories.push(join(current, "node_modules"));
        if (basename(current) === "node_modules") directories.push(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    return uniqueValues(directories);
  }
  private async packageTarget(from: string, name: string, root: string, entry: string, provenance: string): Promise<RelatedResolvedReference> {
    return {
      from: this.files.display(from), name, path: this.files.display(await this.files.canonical(root)),
      entryPath: this.files.display(await this.files.canonical(entry)), kind: "package", provenance,
      relationship: "package imported by", note: `package entry resolved through ${provenance}`,
    };
  }
  private async resolvePackage(from: string, specifier: string): Promise<RelatedResolvedReference[]> {
    const name = packageName(specifier);
    if (!name) return [];
    const resolvers = [
      { resolver: createRequire(from), provenance: "node-project" },
      { resolver: createRequire(import.meta.url), provenance: "host-runtime" },
    ];
    for (const { resolver, provenance } of resolvers) {
      if (!this.files.alive()) break;
      let entry: string;
      try { entry = resolver.resolve(specifier); } catch { continue; }
      const root = await this.findPackageRoot(entry, name);
      if (root) return [await this.packageTarget(from, name, root, entry, provenance)];
    }
    const directories = uniqueValues([
      ...await this.runtimeDirectories(),
      ...resolvers.flatMap(({ resolver }) => resolver.resolve.paths(name) ?? []),
    ]);
    for (const directory of directories) {
      if (!this.files.alive()) break;
      const root = join(directory, name);
      if ((await this.files.json(join(root, "package.json")))?.name === name) {
        return [await this.packageTarget(from, name, root, root, "host-runtime-fallback")];
      }
    }
    return [];
  }
  private async projectPackage(from: string, name: string): Promise<string | undefined> {
    let current = dirname(from);
    while (this.files.alive()) {
      const installed = join(current, "node_modules", name);
      if ((await this.files.fileStat(installed))?.isDirectory()) return installed;
      if ((await this.files.json(join(current, "package.json")))?.name === name) return current;
      if (dirname(current) === current) break;
      current = dirname(current);
    }
    return;
  }
  async resolve(from: string, reference: RelationshipReference): Promise<RelatedResolvedReference[]> {
    if (isBuiltin(reference.name) || !this.files.alive()) return [];
    const resolution = await this.compiler.resolve(from, reference.name);
    if (!resolution || !this.files.alive()) return [];
    const { api, implementation } = resolution;
    const selected = this.options.intent === "definition" ? api ?? implementation : implementation ?? api;
    const name = packageName(reference.name);
    if (!selected) {
      if (!resolution.configPath && name && !await this.projectPackage(from, name)) return this.resolvePackage(from, reference.name);
      return [];
    }
    const entry = await this.files.canonical(selected.resolvedFileName);
    const root = selected.isExternalLibraryImport && name ? await this.findPackageRoot(entry, name) : undefined;
    const provenance = resolution.configPath ? "typescript-project-config" : "typescript-default-bundler";
    const target: RelatedResolvedReference = root && name
      ? await this.packageTarget(from, name, root, entry, provenance)
      : { from: this.files.display(from), name: reference.name, path: this.files.display(entry),
        kind: "file", relationship: reference.relationship, provenance, note: "project module target" };
    const compilerRoot = await this.projectPackage(from, "typescript");
    const projectVersion = compilerRoot ? (await this.files.json(join(compilerRoot, "package.json")))?.version : undefined;
    if (typeof projectVersion === "string" && projectVersion !== resolution.compilerVersion) {
      this.files.skip(`project TypeScript ${projectVersion} differs from trusted resolver ${resolution.compilerVersion}`);
    }
    return [{ ...target, entryPath: this.files.display(entry),
      declarationPath: api && isDeclarationFile(api.resolvedFileName) ? this.files.display(await this.files.canonical(api.resolvedFileName)) : undefined,
      implementationPath: implementation ? this.files.display(await this.files.canonical(implementation.resolvedFileName)) : undefined,
      compilerVersion: resolution.compilerVersion, projectCompilerVersion: typeof projectVersion === "string" ? projectVersion : undefined,
      configPath: resolution.configPath ? this.files.display(resolution.configPath) : undefined, resolutionMode: resolution.mode,
      note: `${reference.name}: ${resolution.mode} target via ${provenance} (${isDeclarationFile(entry) ? "declaration" : "implementation"})`,
    }];
  }
}

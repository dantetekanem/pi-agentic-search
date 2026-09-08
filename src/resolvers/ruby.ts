import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { ProjectFiles } from "../inventory.ts";
import { camelToSnake, uniqueValues } from "../shared.ts";
import type { RelatedResolvedReference, RelationshipReference } from "../types.ts";

interface RubySource { constants: string[]; references: RelationshipReference[]; truncated?: boolean }

function parseRubySource(source: string, depthLimit: number): RubySource {
  const constants: string[] = [];
  const references: RelationshipReference[] = [];
  const stack: Array<string[] | undefined> = [];
  const namespace = () => [...stack].reverse().find((item) => item !== undefined) ?? [];
  for (const raw of source.split("\n")) {
    const line = raw.replace(/#(?!\{).*$/, "");
    const declaration = /^\s*(?:class|module)\s+(::)?([A-Z]\w*(?:::[A-Z]\w*)*)/.exec(line);
    if (declaration) {
      if (stack.length >= depthLimit) return { constants, references, truncated: true };
      const parent = declaration[1] ? [] : namespace();
      const parts = declaration[2]!.split("::");
      if (parent.length + parts.length > depthLimit) return { constants, references, truncated: true };
      const names = [...parent, ...parts];
      constants.push(names.join("::"));
      stack.push(names);
      continue;
    }
    if (/^\s*end\b/.test(line)) { stack.pop(); continue; }
    const mixin = /^\s*(include|prepend|extend)\s+(.+?)\s*$/.exec(line);
    if (mixin) {
      for (const candidate of mixin[2]!.split(",")) {
        const name = candidate.replace(/\s+(?:if|unless)\b.*$/, "").trim();
        if (!name || name.replace(/^::/, "") === "ActiveSupport::Concern") continue;
        // A qualified declaration (A::B) contributes one lexical frame, not A then B.
        references.push({
          name, namespace: [...stack].reverse().flatMap((names) => names ? [names.join("::")] : []),
          relationship: mixin[1] === "prepend" ? "prepended by" : mixin[1] === "extend" ? "extended by" : "included by",
        });
      }
    }
    if (/^\s*(?:def|if|unless|case|while|until|for|begin)\b/.test(line) || /\bdo(?:\s*\|[^|]*\|)?\s*$/.test(line)) {
      if (stack.length >= depthLimit) return { constants, references, truncated: true };
      stack.push(undefined);
    }
  }
  return { constants, references };
}

export class RubyResolver {
  private readonly indexes = new Map<string, Promise<Map<string, string[]>>>();
  constructor(private readonly files: ProjectFiles) {}
  private parse(source: string, from: string): RubySource {
    const parsed = parseRubySource(source, this.files.limits.namespaceDepth);
    if (parsed.truncated) this.files.skip(`Ruby namespace depth budget at ${this.files.display(from)}`);
    return parsed;
  }
  references(source: string, from: string): RelationshipReference[] { return this.parse(source, from).references; }

  private projectRoot(path: string): string {
    for (const part of ["app", "lib"]) {
      const index = path.lastIndexOf(`/${part}/`);
      if (index >= 0) return path.slice(0, index) || "/";
    }
    return resolve(this.files.cwd);
  }
  private async autoloadRoots(project: string): Promise<string[]> {
    const roots = [join(project, "app"), join(project, "lib")];
    const config = join(project, "config/application.rb");
    if (!(await this.files.fileStat(config))?.isFile()) return roots;
    const source = await this.files.read(config, 64 * 1024);
    for (const line of (source ?? "").split("\n").filter((line) => /config\.(?:autoload|eager_load)_paths/.test(line))) {
      let resolved = false;
      for (const match of line.matchAll(/(?:Rails|config)\.root\.join\(([^)]+)\)/g)) {
        const parts = [...match[1]!.matchAll(/["']([^"']+)["']/g)].map((part) => part[1]!);
        if (parts.length) { roots.push(resolve(project, ...parts)); resolved = true; }
      }
      const list = /%[wW]\(([^)]+)\)/.exec(line);
      if (list) {
        for (const item of list[1]!.trim().split(/\s+/)) {
          const path = item.replace(/^#\{(?:Rails|config)\.root\}\//, "");
          if (!path.includes("#{")) { roots.push(resolve(project, path)); resolved = true; }
        }
      }
      if (!resolved) this.files.skip(`dynamic autoload configuration not evaluated in ${this.files.display(config)}`);
    }
    const unique = uniqueValues(roots);
    if (unique.length > this.files.limits.autoloadRoots) this.files.skip(`autoload root budget: ${unique.length - this.files.limits.autoloadRoots} roots unvisited; next ${unique[this.files.limits.autoloadRoots]}`);
    return unique.slice(0, this.files.limits.autoloadRoots);
  }
  private async buildIndex(project: string): Promise<Map<string, string[]>> {
    const index = new Map<string, string[]>();
    const roots = await this.autoloadRoots(project);
    const paths = [...await this.files.list(project)];
    for (const root of roots) {
      if (!this.files.alive()) break;
      const outside = relative(project, root);
      if (outside.startsWith("..") || isAbsolute(outside)) paths.push(...await this.files.list(root));
    }
    const candidates = uniqueValues(paths).filter((path) => extname(path) === ".rb" && roots.some((root) => path.startsWith(`${root}/`)));
    if (candidates.length > this.files.limits.nodes) this.files.omitFiles(candidates.length - this.files.limits.nodes, `Ruby constant index file budget (${this.files.limits.nodes}/${candidates.length}); next ${this.files.display(candidates[this.files.limits.nodes]!)}`);
    for (const path of candidates.slice(0, this.files.limits.nodes)) {
      if (!this.files.alive()) break;
      const source = await this.files.read(path);
      if (source === undefined) continue;
      for (const name of this.parse(source, path).constants) index.set(name, uniqueValues([...(index.get(name) ?? []), path]));
    }
    return index;
  }
  async resolve(from: string, reference: RelationshipReference): Promise<RelatedResolvedReference[]> {
    if (!/^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/.test(reference.name)) {
      this.files.skip(`dynamic mixin not evaluated in ${this.files.display(from)}: ${reference.name}`);
      return [];
    }
    const project = this.projectRoot(from);
    let pending = this.indexes.get(project);
    if (!pending) { pending = this.buildIndex(project); this.indexes.set(project, pending); }
    const index = await pending;
    const name = reference.name.replace(/^::/, "");
    const namespaces = reference.name.startsWith("::") ? [] : reference.namespace ?? [];
    for (const namespace of [...namespaces, ""]) {
      const qualified = namespace ? `${namespace}::${name}` : name;
      const paths = index.get(qualified);
      if (paths?.length) return paths.map((path) => this.target(from, reference, path, "ruby-constant-index"));
    }
    const modulePath = `${name.split("::").map(camelToSnake).join("/")}.rb`;
    const directory = dirname(from);
    const owner = basename(from, extname(from));
    const candidates = uniqueValues([
      join(directory, owner, modulePath), join(directory, owner, basename(modulePath)), join(directory, modulePath),
      ...["app/models/concerns", "app/controllers/concerns", "app/models", "lib"].map((root) => join(project, root, modulePath)),
    ]);
    for (const candidate of candidates) {
      if (!this.files.alive()) break;
      if ((await this.files.fileStat(candidate))?.isFile()) return [this.target(from, reference, await this.files.canonical(candidate), "ruby-path-fallback")];
    }
    return [];
  }
  private target(from: string, reference: RelationshipReference, path: string, provenance: string): RelatedResolvedReference {
    return {
      from: this.files.display(from), name: reference.name, path: this.files.display(path),
      relationship: reference.relationship, kind: "file", provenance,
      note: provenance === "ruby-constant-index" ? "constant definition found in an autoload-root index" : "lexical filename fallback; dynamic loading was not evaluated",
    };
  }
}

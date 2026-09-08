import { dirname, join } from "node:path";
import type * as TypeScript from "typescript";
import { ProjectFiles } from "../inventory.ts";
import { CompilerHost } from "./compiler-host.ts";

type Compiler = typeof TypeScript;
interface Configuration {
  options: TypeScript.CompilerOptions;
  path?: string;
  caches: Map<"api" | "implementation", TypeScript.ModuleResolutionCache>;
}
export interface CompilerResolution {
  api?: TypeScript.ResolvedModuleFull;
  implementation?: TypeScript.ResolvedModuleFull;
  configPath?: string;
  compilerVersion: string;
  mode: "import" | "require";
}
export const isDeclarationFile = (path: string): boolean => /\.d\.[cm]?ts$/i.test(path);

export class ProjectCompiler {
  private readonly host: CompilerHost;
  private readonly configurations = new Map<string, Promise<Configuration | undefined>>();
  constructor(private readonly files: ProjectFiles) { this.host = new CompilerHost(files); }

  private configuration(ts: Compiler, from: string): Promise<Configuration | undefined> {
    const directory = dirname(from);
    let cached = this.configurations.get(directory);
    if (!cached) {
      cached = this.readConfiguration(ts, directory);
      this.configurations.set(directory, cached);
    }
    return cached;
  }
  private async readConfiguration(ts: Compiler, directory: string): Promise<Configuration | undefined> {
    const parsed = await this.host.run(() => {
      let current = directory;
      let path: string | undefined;
      while (this.files.alive()) {
        path = [join(current, "tsconfig.json"), join(current, "jsconfig.json")].find(this.host.api.fileExists);
        if (path || dirname(current) === current) break;
        current = dirname(current);
      }
      if (!path) return { options: { module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler }, errors: [] };
      const config = ts.readConfigFile(path, this.host.api.readFile);
      const command = config.error ? undefined : ts.parseJsonConfigFileContent(config.config, this.host.api, dirname(path), undefined, path);
      return { path, options: command?.options ?? {}, errors: config.error ? [config.error] : command?.errors ?? [] };
    });
    if (!parsed) return;
    for (const diagnostic of parsed.errors) {
      if ([18002, 18003].includes(diagnostic.code)) continue;
      this.files.skip(`project config ${parsed.path ? this.files.display(parsed.path) : directory}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    }
    return { options: parsed.options, path: parsed.path, caches: new Map() };
  }

  async resolve(from: string, specifier: string, requestedMode?: "import" | "require"): Promise<CompilerResolution | undefined> {
    if (!this.files.alive()) return;
    // Resolve the extension's installed dependency, never require a compiler or
    // plugin from the searched repository. Project configuration remains data.
    const ts = await import("typescript");
    const configuration = await this.configuration(ts, from);
    if (!configuration || !this.files.alive()) return;
    return this.host.run(() => {
      const { options, caches } = configuration;
      const mode = requestedMode === "require" ? ts.ModuleKind.CommonJS : requestedMode === "import" ? ts.ModuleKind.ESNext
        : ts.getImpliedNodeFormatForFile(from, undefined, this.host.api, options)
          ?? (options.module === ts.ModuleKind.CommonJS ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext);
      const resolveSurface = (surface: "api" | "implementation") => {
        let cache = caches.get(surface);
        if (!cache) {
          cache = ts.createModuleResolutionCache(this.files.cwd, (path) => path, options);
          caches.set(surface, cache);
        }
        const host = surface === "implementation" ? { ...this.host.api,
          fileExists: (path: string) => !isDeclarationFile(path) && this.host.api.fileExists(path),
        } : this.host.api;
        return ts.resolveModuleName(specifier, from, options, host, cache, undefined, mode).resolvedModule;
      };
      const api = resolveSurface("api");
      const implementation = api && !isDeclarationFile(api.resolvedFileName) ? api : resolveSurface("implementation");
      return { api, implementation, compilerVersion: ts.version, configPath: configuration.path,
        mode: mode === ts.ModuleKind.CommonJS ? "require" : "import" };
    }, () => configuration.caches.clear());
  }
}

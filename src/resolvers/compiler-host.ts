import { resolve } from "node:path";
import type { ModuleResolutionHost, ParseConfigHost } from "typescript";
import { ProjectFiles } from "../inventory.ts";

type Fact = "file" | "directory" | "text" | "realpath";

// TypeScript's host is synchronous. Replay against settled facts rather than doing
// blocking filesystem reads or letting provisional misses enter a retained cache.
export class CompilerHost {
  private readonly facts = new Map<string, boolean | string | undefined>();
  private readonly pending = new Map<string, { kind: Fact; path: string }>();
  readonly api: ModuleResolutionHost & ParseConfigHost;

  constructor(private readonly files: ProjectFiles) {
    this.api = {
      useCaseSensitiveFileNames: true,
      fileExists: (path) => this.fact("file", path) === true,
      directoryExists: (path) => this.fact("directory", path) === true,
      readFile: (path) => {
        const value = this.fact("text", path);
        return typeof value === "string" ? value : undefined;
      },
      realpath: (path) => {
        const value = this.fact("realpath", path);
        return typeof value === "string" ? value : path;
      },
      getCurrentDirectory: () => files.cwd,
      // Only compiler options are needed; do not enumerate/typecheck project files.
      readDirectory: () => [],
    };
  }

  private fact(kind: Fact, input: string): boolean | string | undefined {
    if (!this.files.alive()) return;
    const path = resolve(this.files.cwd, input);
    const key = `${kind}\0${path}`;
    if (this.facts.has(key)) return this.facts.get(key);
    if (this.facts.size + this.pending.size >= this.files.limits.probes) {
      this.files.skip("compiler host metadata budget");
      return;
    }
    this.pending.set(key, { kind, path });
    return;
  }

  async run<T>(operation: () => T, invalidate: () => void = () => {}): Promise<T | undefined> {
    for (let round = 0; round < this.files.limits.compilerRounds && this.files.alive(); round++) {
      if (this.files.stats.compilerPasses >= this.files.limits.compilerPasses) break;
      this.files.stats.compilerPasses++;
      const result = operation();
      if (!this.pending.size) return this.files.alive() ? result : undefined;
      for (const [key, { kind, path }] of this.pending) {
        if (!this.files.alive()) return;
        const metadata = kind === "realpath" ? undefined : await this.files.fileStat(path);
        const value = kind === "realpath" ? await this.files.canonical(path)
          : kind === "file" ? metadata?.isFile() === true
          : kind === "directory" ? metadata?.isDirectory() === true
          : metadata?.isFile() ? await this.files.read(path, 64 * 1024) : undefined;
        this.facts.set(key, value);
      }
      this.pending.clear();
      invalidate();
    }
    this.files.skip("compiler resolution pass budget or cancellation");
    return;
  }
}

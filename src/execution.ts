import { basename, dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_EXCLUDES, PACKAGE_SEARCH_EXCLUDES } from "./classifications.ts";
import { ProjectFiles } from "./inventory.ts";
import { runRg } from "./retrieval.ts";
import type { SearchRun } from "./types.ts";

type SearchStage = NonNullable<SearchRun["stage"]>;
export const EXECUTION_LIMITS = { packageConcurrency: 3, packages: 20, rootBatch: 32 };
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function inPool<T>(items: T[], limit: number, visit: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await visit(items[cursor++]!);
  }));
}

export class SearchExecutor {
  private literal: boolean;
  literalFallback = false;
  regexError?: string;
  constructor(private readonly files: ProjectFiles, private readonly query: string, literal = false, private readonly caseSensitive = false) {
    this.literal = literal;
  }

  private args(roots: string[], stage: SearchStage, aliases: string[]) {
    const packageSearch = stage === "entry" || stage === "alias" || stage === "package";
    const args = ["--json", "--line-number", "--color=never", "--hidden"];
    if (packageSearch) args.push("--no-ignore");
    for (const glob of packageSearch ? PACKAGE_SEARCH_EXCLUDES : DEFAULT_EXCLUDES) args.push("--glob", glob);
    if (aliases.length) {
      // Alias expansion only receives identifier queries. Scope case flags to the
      // original identifier so an uppercase alias cannot change its smart-case rule.
      const ignoreCase = !this.caseSensitive && !/\p{Uppercase}/u.test(this.query);
      args.push("--case-sensitive", "-e", `(?${ignoreCase ? "i" : "-i"}:${escapePattern(this.query)})`);
      for (const alias of aliases) args.push("-e", escapePattern(alias));
    } else {
      if (this.literal) args.push("--fixed-strings");
      args.push(this.caseSensitive ? "--case-sensitive" : "--smart-case");
      args.push("-e", this.query);
    }
    return [...args, "--", ...roots];
  }

  private async run(cwd: string, roots: string[], reported: string[], stage: SearchStage, aliases: string[] = []): Promise<SearchRun> {
    const request = this.files.request;
    const consume = (line: string) => request.consume(line, (path) => this.files.display(resolve(cwd, path)));
    let run = await runRg(this.args(roots, stage, aliases), cwd, reported, request, consume);
    run.stage = stage;
    if (!this.literal && !aliases.length && run.exitCode === 2 && run.signal === null && /regex parse error:/i.test(run.error ?? "")) {
      run.kind = "validation";
      this.literal = true;
      this.literalFallback = true;
      this.regexError = run.error;
      run = await runRg(this.args(roots, stage, aliases), cwd, reported, request, consume);
      run.stage = stage;
    }
    return run;
  }

  async searchRoots(roots: string[], stage: SearchStage) {
    const relative = [...new Set(roots.filter((root) => !isAbsolute(root)))];
    for (let index = 0; index < relative.length; index += EXECUTION_LIMITS.rootBatch) {
      const batch = relative.slice(index, index + EXECUTION_LIMITS.rootBatch);
      await this.run(this.files.cwd, batch, batch, stage);
    }
    for (const root of new Set(roots.filter(isAbsolute))) await this.searchRoot(root, stage);
  }

  async searchRoot(root: string, stage: SearchStage, aliases: string[] = []): Promise<SearchRun> {
    const absolute = resolve(this.files.cwd, root);
    const metadata = await this.files.fileStat(absolute);
    const directory = metadata?.isDirectory();
    return this.run(directory ? absolute : dirname(absolute), [directory ? "." : basename(absolute)], [root], stage, aliases);
  }

  async searchAliases(searches: Array<{ path: string; symbol: string }>): Promise<void> {
    const byPath = new Map<string, Set<string>>();
    for (const { path, symbol } of searches) {
      if (!symbol || symbol === this.query) continue;
      const symbols = byPath.get(path) ?? new Set<string>();
      symbols.add(symbol);
      byPath.set(path, symbols);
    }
    for (const [path, symbols] of byPath) {
      await this.files.request.replaceFile(path, () => this.searchRoot(path, "alias", [...symbols]));
    }
  }
}

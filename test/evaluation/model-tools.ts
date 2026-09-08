import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { runSearch } from "../../src/extension.ts";
import { formatSearchResults, formatTopMatch } from "../../src/render.ts";
import type { RankedFileResult } from "../../src/types.ts";
import { PinnedSource, safePath, type EvaluationCase } from "./core.ts";
import { nativeSearch } from "./worker.ts";

export type ProbeMode = "full" | "raw-rg" | "no-guidance";
export const TOOL_BYTES = 16384;
const allowed = (path: string) => !path.split("/").some(part => /^(?:AGENTS\.md|CLAUDE\.md|SKILL\.md|\.pi|\.claude|\.agents)$/i.test(part));
const bounded = (text: string) => truncateHead(text, { maxLines: 200, maxBytes: TOOL_BYTES });
type SearchResult = Awaited<ReturnType<typeof runSearch>>;

// Never forward opaque rendered notes, reasons, relationship names, or error paths.
// Recreate every visible code snippet from its committed blob and verify equality.
export function projectResult(source: PinnedSource, query: string, result: SearchResult, guidance: boolean) {
  const ranked: RankedFileResult[] = [];
  const originals = new Map<string, RankedFileResult>();
  const lines = new Map<string, string[]>();
  for (const file of result.details.files) {
    const path = source.publicPath(file.path);
    if (!path || !source.regularFiles.has(path) || !allowed(path)) continue;
    const evidence = file.evidence;
    const row: RankedFileResult = {
      path, score: Number(file.score), matchCount: Number(file.matchCount), reasons: [], matches: [],
      evidence: evidence && ["definition", "reference", "text", "path"].includes(evidence.tier) && ["declaration-span", "line-pattern", "text", "path"].includes(evidence.basis)
        ? { tier: evidence.tier, basis: evidence.basis, definitionCount: Number(evidence.definitionCount), referenceCount: Number(evidence.referenceCount), competingCandidates: Number(evidence.competingCandidates) } : undefined,
    };
    ranked.push(row); originals.set(file.path, row); lines.set(path, source.read(path).split("\n"));
  }
  let current: RankedFileResult | undefined;
  for (const line of result.content.filter(part => part.type === "text").flatMap(part => part.text.split("\n"))) {
    const header = /^\s*(?:↳\s*\d+\.\d+\.|\d+\.) (.+?) \(score /.exec(line);
    if (header) { current = originals.get(header[1]!); continue; }
    const snippet = /^\s+L(\d+) \[(def|ref|scope)\] (.*)$/.exec(line);
    if (!snippet || !current) continue;
    const lineNumber = Number(snippet[1]);
    const publicLine = lines.get(current.path)![lineNumber - 1];
    if (publicLine === undefined) throw new Error("Invalid pinned snippet line");
    const match = { path: current.path, lineNumber, line: publicLine, submatches: [], isDefinition: snippet[2] !== "ref" };
    if (formatTopMatch(match).text !== snippet[3] || formatTopMatch(match).marker !== snippet[2]) throw new Error("Search differs from pinned snippet");
    current.matches.push(match);
  }
  const coverage = result.details.coverage;
  const publicRoots = (roots: string[]) => roots.flatMap(root => { const path = source.publicPath(root); return path && allowed(path) ? [path] : []; });
  const notes = [
    `Coverage: ${coverage.status}. Completed roots: ${publicRoots(coverage.completedRoots).join(", ") || "none"}.`,
    `Unvisited roots: ${publicRoots(coverage.unvisitedRoots).join(", ") || "none"}.`,
    `Reported limitations: ${coverage.reasons.length}; omitted related candidates: ${coverage.omittedRelatedCandidates}; omitted packages: ${coverage.omittedPackageRoots}.`,
    "Public-source projection: opaque diagnostics and relationship descriptions omitted; non-public and ambient-instruction files excluded.",
  ];
  const output = bounded(formatSearchResults(query, ranked, ranked.reduce((sum, row) => sum + row.matchCount, 0), notes, undefined, undefined, coverage, guidance));
  return { text: output.content, outputTruncated: output.truncated, rows: ranked.map(row => ({ path: row.path, lines: row.matches.map(match => match.lineNumber) })), status: coverage.status };
}

export class PublicTools {
  constructor(readonly source: PinnedSource) {}
  read(path: string, startLine: number) {
    path = safePath(path);
    if (!allowed(path) || !Number.isSafeInteger(startLine) || startLine < 1) throw new Error("Unsupported public read");
    const lines = this.source.read(path).split("\n");
    if (startLine > lines.length) throw new Error("Read outside public source");
    const visible: string[] = [];
    for (let index = startLine - 1; index < Math.min(lines.length, startLine + 79); index++) {
      const line = `L${index + 1} ${lines[index]}`;
      if (Buffer.byteLength([...visible, line].join("\n")) > TOOL_BYTES) break;
      visible.push(line);
    }
    if (!visible.length) throw new Error("Public source line exceeds read budget");
    return { path, startLine, endLine: startLine + visible.length - 1, text: visible.join("\n") };
  }
  async search(params: EvaluationCase["params"], mode: ProbeMode, signal?: AbortSignal) {
    const source = await PinnedSource.open(this.source.root, this.source.pin);
    const path = safePath(params.path ?? ".");
    if (!source.hasScope(path) || !allowed(path)) throw new Error("Unsupported public search scope");
    signal?.throwIfAborted();
    if (mode === "raw-rg") {
      const scenario: EvaluationCase = { id: "probe", project: "probe", split: "development", task: "Public navigation", params: { ...params, path }, targets: [], alternatives: [], requiredRoots: [path] };
      const native = nativeSearch(source, scenario, [path]);
      const blobs = new Map<string, string[]>();
      const visible = native.matches.filter(match => allowed(match.path)).map(match => {
        if (!blobs.has(match.path)) blobs.set(match.path, source.read(match.path).split("\n"));
        const line = blobs.get(match.path)![match.lineNumber - 1]?.replace(/\r$/, "");
        if (line !== match.line) throw new Error("Native search differs from pinned snippet");
        return `${match.path}:${match.lineNumber}:${line}`;
      });
      const output = bounded(visible.join("\n"));
      return { text: output.content || "No matches in the completed public scope.", outputTruncated: output.truncated, status: "complete" as const };
    }
    const temporary = await mkdtemp(join(tmpdir(), "model-rg-"));
    const previous = process.env.RIPGREP_CONFIG_PATH;
    try {
      const config = join(temporary, "rg.conf");
      await writeFile(config, "--sort=path\n"); process.env.RIPGREP_CONFIG_PATH = config;
      const result = await runSearch({ ...params, path, max_files: 5, max_matches_per_file: 10 }, source.root, signal);
      try { return projectResult(source, params.query, result, mode === "full"); }
      finally { if (result.details.fullOutputPath) await rm(dirname(result.details.fullOutputPath), { recursive: true, force: true }); }
    } finally {
      if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = previous;
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

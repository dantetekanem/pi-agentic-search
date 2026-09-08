import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { SOURCE_EXTENSIONS, JS_TS_EXTENSIONS } from "./classifications.ts";
import { selectSnippets, words } from "./evidence.ts";
import { relatedReferencesForPath, type RelatedExpansionDetails } from "./related.ts";
import { camelToSnake, normalizeRepoRelativePath, uniqueValues } from "./shared.ts";
import type { CodeMatch, FileSummary, PathMatch, RankedFileResult, SearchIntent } from "./types.ts";

const TEST_PATH = /(^|\/)(__tests__|tests?|spec|fixtures?|mocks?|stories)(\/|$)|\.(test|spec|stories)\.[^.]+$/;
const LOW_VALUE_PATH = /(^|\/)(node_modules|vendor|dist|build|coverage|tmp|log|\.git|\.next|\.turbo|target)(\/|$)/;
const GENERATED_PATH = /(generated|schema\.json|\.min\.|bundle\.|compiled)/i;
const STOPWORDS = new Set("a an and call calls class classes def file files find for in locate method methods on scope scopes site sites the to about above across around between by context domain from into named near of or related same search use using with".split(" "));

export function pathDepth(path: string): number { return path.split("/").filter(Boolean).length; }
export function contextTokens(context?: string): string[] {
  return uniqueValues(words(context ?? "").filter((word) => word.length >= 2 && !STOPWORDS.has(word)));
}

export function scorePathQueryMatch(path: string, query: string): { score: number; reasons: string[] } | undefined {
  const normalized = normalizeRepoRelativePath(path).toLowerCase();
  const filename = normalized.split("/").pop() ?? "";
  const stem = filename.replace(/\.[^.]+$/, "");
  const variants = uniqueValues([query.trim().toLowerCase(), camelToSnake(query.trim())]).filter((value) => value.length >= 3);
  const tokens = contextTokens(query);
  const reasons: string[] = [];
  let score = 0;
  for (const variant of variants) {
    if (filename === variant || stem === variant) { score += 80; reasons.push(`exact filename match "${variant}"`); break; }
    if (filename.includes(variant)) { score += 60; reasons.push(`filename contains "${variant}"`); break; }
    if (normalized.includes(variant)) { score += 45; reasons.push(`path contains "${variant}"`); break; }
  }
  const pathWords = new Set(words(path));
  if (tokens.length && tokens.every((token) => pathWords.has(token))) {
    score += Math.min(50, 20 + tokens.length * 5);
    reasons.push(`path matches query tokens: ${tokens.join(", ")}`);
  }
  return score ? { score, reasons } : undefined;
}

export const CONTEXT_LIMITS = { files: 8, readBytes: 65_536, blockBytes: 512 };

export async function enrichContext(
  matches: CodeMatch[], ranked: RankedFileResult[], cwd: string, signal?: AbortSignal,
): Promise<{ matches: CodeMatch[]; enrichedPaths: Set<string> }> {
  const blocks = new Map<string, string[]>();
  const enrichedPaths = new Set<string>();
  for (const file of ranked.slice(0, CONTEXT_LIMITS.files)) {
    if (signal?.aborted) break;
    const handle = await open(resolve(cwd, file.path), constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
    if (!handle) continue;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || signal?.aborted) continue;
      const buffer = Buffer.alloc(CONTEXT_LIMITS.readBytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (stats.size > bytesRead) lines.pop();
      blocks.set(file.path, lines);
    } catch {
      // Context is optional; preserve retrieved evidence if the source changed or became unreadable.
      continue;
    } finally { await handle.close(); }
  }
  return {
    matches: matches.map((match) => {
      const lines = blocks.get(match.path);
      if (!lines || match.lineNumber > lines.length) return match;
      enrichedPaths.add(match.path);
      const block = lines.slice(Math.max(0, match.lineNumber - 3), match.lineNumber + 2).join("\n");
      return { ...match, contextBlock: Buffer.from(block).subarray(0, CONTEXT_LIMITS.blockBytes).toString("utf8") };
    }),
    enrichedPaths,
  };
}

export interface RankingFeatures {
  pathPriors?: boolean;
  declarationEvidence?: boolean;
}
export interface RankingOptions {
  intent?: SearchIntent;
  anchorPath?: string;
  related?: RelatedExpansionDetails;
  features?: RankingFeatures;
}

function compareFiles(a: RankedFileResult, b: RankedFileResult, intent: SearchIntent, declarationEvidence: boolean): number {
  const tier = (file: RankedFileResult) => {
    const evidence = file.evidence;
    if (evidence?.tier === "path") return 0;
    if (intent === "definition" && declarationEvidence) return evidence?.definitionCount ? 3 : 1;
    if (intent === "references") return evidence?.referenceCount ? 3 : 1;
    return 1;
  };
  return tier(b) - tier(a) || b.score - a.score || b.matchCount - a.matchCount || a.path.localeCompare(b.path);
}

export function rankFileGroups(
  matches: CodeMatch[], query: string, maxMatchesPerFile: number, pathMatches: PathMatch[] = [], context?: string,
  summaries?: ReadonlyMap<string, FileSummary>, options: RankingOptions = {},
): RankedFileResult[] {
  const grouped = new Map<string, CodeMatch[]>();
  for (const match of matches) {
    const group = grouped.get(match.path) ?? [];
    group.push(match);
    grouped.set(match.path, group);
  }
  const paths = new Map(pathMatches.map((match) => [match.path, match]));
  const allPaths = new Set([...grouped.keys(), ...paths.keys(), ...(summaries?.keys() ?? [])]);
  const intent = options.intent ?? "auto";
  const declarationEvidence = options.features?.declarationEvidence !== false;
  const pathPriors = options.features?.pathPriors !== false;
  const queryWords = new Set(words(query));
  const contextWords = contextTokens(context);
  const ranked: RankedFileResult[] = [];

  for (const path of allPaths) {
    const fileMatches = grouped.get(path) ?? [];
    const summary = summaries?.get(path);
    const count = summary?.matchCount ?? fileMatches.length;
    const definitionCount = summary?.definitionCount ?? fileMatches.filter((match) => match.isDefinition).length;
    const referenceCount = summary?.referenceCount ?? fileMatches.filter((match) => match.kind === "reference" || (!match.kind && !match.isDefinition)).length;
    const reasons: string[] = [];
    let score = paths.get(path)?.score ?? 0;
    reasons.push(...(paths.get(path)?.reasons ?? []));
    if (count) reasons.push("content match");
    if (definitionCount && declarationEvidence) {
      score += 35 + Math.min(30, definitionCount * 5);
      reasons.push(`${definitionCount} definition match${definitionCount === 1 ? "" : "es"}`);
    }
    score += Math.min(20, count * 2);
    if (count > 1) reasons.push(`${count} matches`);
    const normalized = normalizeRepoRelativePath(path).toLowerCase();
    const pathWords = new Set(words(path));
    const snippetWords = new Set(fileMatches.flatMap((match) => words(`${match.line} ${match.contextBlock ?? ""}`)));
    const snippetHits = contextWords.filter((word) => snippetWords.has(word));
    const pathHits = contextWords.filter((word) => pathWords.has(word));
    if (snippetHits.length) { score += Math.min(135, snippetHits.length * 45); reasons.unshift(`context tokens matched snippets: ${snippetHits.join(", ")}`); }
    if (pathHits.length) { score += Math.min(75, pathHits.length * 25); reasons.unshift(`context tokens matched path: ${pathHits.join(", ")}`); }
    if (snippetHits.length && pathHits.length) score += 15;
    if (pathPriors && SOURCE_EXTENSIONS.has(extname(normalized))) { score += 15; reasons.push("source file"); }
    if (pathPriors && /(^|\/)(src|app|lib|packages|pkg|cmd|internal|core)\//.test(normalized)) { score += 8; reasons.push("implementation path"); }
    if (pathPriors && pathDepth(path) <= 3) { score += 5; reasons.push("shallow path"); }
    if (words(normalizeRepoRelativePath(path).split("/").pop() ?? "").some((word) => queryWords.has(word))) { score += 12; reasons.push("filename matches query words"); }
    if (pathPriors && TEST_PATH.test(normalized)) {
      score += intent === "tests" ? 150 : TEST_PATH.test(options.anchorPath ?? "") ? 0 : -30;
      reasons.push(intent === "tests" ? "requested test evidence" : "test/support path");
    }
    if (pathPriors && LOW_VALUE_PATH.test(normalized) && !LOW_VALUE_PATH.test(options.anchorPath ?? "")) { score -= 60; reasons.push("low-value path"); }
    if (pathPriors && GENERATED_PATH.test(normalized) && !GENERATED_PATH.test(options.anchorPath ?? "")) { score -= 25; reasons.push("generated/bundled path"); }
    if (path === options.anchorPath && (intent === "file" || intent === "auto")) {
      score += 200;
      reasons.unshift("primary target");
    } else {
      const related = relatedReferencesForPath(options.related, path);
      if (related.length) {
        score += 8;
        reasons.unshift(`${options.related?.label} target: ${related.map((item) => `${item.name} ${item.relationship} ${item.from}; ${item.note}`).join(", ")}`);
      }
    }
    ranked.push({
      path, score, reasons, matchCount: count || (paths.has(path) ? 1 : 0),
      evidence: {
        tier: definitionCount ? "definition" : referenceCount ? "reference" : count ? "text" : "path", definitionCount, referenceCount,
        basis: definitionCount ? JS_TS_EXTENSIONS.has(extname(path)) || extname(path) === ".rb" ? "declaration-span" : "line-pattern" : count ? "text" : "path",
        competingCandidates: 0,
      },
      matches: selectSnippets(fileMatches, maxMatchesPerFile, intent, contextWords, declarationEvidence),
    });
  }
  const tierCounts = new Map<string, number>();
  for (const file of ranked) if (file.evidence) tierCounts.set(file.evidence.tier, (tierCounts.get(file.evidence.tier) ?? 0) + 1);
  for (const file of ranked) if (file.evidence) file.evidence.competingCandidates = (tierCounts.get(file.evidence.tier) ?? 1) - 1;
  return ranked.sort((a, b) => compareFiles(a, b, intent, declarationEvidence));
}

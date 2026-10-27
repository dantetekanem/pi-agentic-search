import { relatedReferencesForPath, type RelatedExpansionDetails } from "./related.ts";
import type { CodeMatch, RankedFileResult, SearchCoverageDetails, SearchTopMatch, SearchEvidence } from "./types.ts";

export function formatEvidence(evidence?: SearchEvidence): string {
  if (!evidence) return "content";
  return `${evidence.tier}; ${evidence.basis}; ${evidence.competingCandidates} competing candidates`;
}

export function formatTopMatch(match: CodeMatch): SearchTopMatch {
  const line = match.line.trim();
  return {
    lineNumber: match.lineNumber,
    marker: match.isDefinition && /^\s*scope\s+:/.test(match.line) ? "scope" : match.isDefinition ? "def" : "ref",
    text: line.length <= 180 ? line : `${line.slice(0, 180)}... [truncated]`,
  };
}

export function formatSearchResults(
  query: string, ranked: RankedFileResult[], totalMatches: number, notes: string[] = [],
  targetInstruction = "Read this file first; use other ranked candidates if it lacks the requested context.",
  related?: RelatedExpansionDetails, coverage?: SearchCoverageDetails, guidance = true,
): string {
  if (!ranked.length) {
    return [
      coverage?.status === "failed" ? `Search failed for ${JSON.stringify(query)}.` : `No code matches found for ${JSON.stringify(query)} in the completed scopes.`,
      ...notes, "Path hints are coverage, not code matches.",
      coverage?.status === "complete" ? "Search complete for the reported pattern and scopes." : guidance
        ? "Coverage is incomplete; inspect the unvisited roots and unresolved relationships listed above." : "Coverage is incomplete.",
    ].join("\n\n");
  }
  const primary = ranked[0]!.path;
  const lines = [
    `agentic_search: ${JSON.stringify(query)} — ${ranked.length} ranked file${ranked.length === 1 ? "" : "s"} from ${totalMatches} match${totalMatches === 1 ? "" : "es"}`,
    `TARGET FILE: ${primary}.${guidance ? ` ${targetInstruction}` : ""}`, "",
  ];
  let topLevel = 0;
  let childIndex = 0;
  for (const file of ranked) {
    const references = relatedReferencesForPath(related, file.path);
    const child = file.path !== primary && references.some((item) => item.from === primary);
    const prefix = child ? `   ↳ 1.${++childIndex}.` : `${++topLevel}.`;
    const reasons = child
      ? references.map((item) => `${item.relationship} ${primary} via ${item.name}; ${item.note}`).join(", ")
      : file.reasons.slice(0, 4).join(", ");
    lines.push(`${prefix} ${file.path} (score ${file.score}, ${file.matchCount} match${file.matchCount === 1 ? "" : "es"}, evidence ${formatEvidence(file.evidence)})${reasons ? ` — ${reasons}` : ""}`);
    const indent = child ? "      " : "   ";
    if (!file.matches.length) lines.push(`${indent}${file.evidence?.tier === "path" ? "[path] filename/path match" : "[content] snippets omitted by retention budget"}`);
    for (const match of file.matches) {
      const top = formatTopMatch(match);
      lines.push(`${indent}L${top.lineNumber} [${top.marker}] ${top.text}`);
    }
    if (file.matches.length && file.matchCount > file.matches.length) lines.push(`${indent}… ${file.matchCount - file.matches.length} more matches in this file`);
    lines.push("");
  }
  lines.push(...notes);
  if (guidance) lines.push("", coverage && coverage.status !== "complete"
    ? "Next step: read the TARGET FILE, then inspect the unvisited roots and unresolved relationships listed above."
    : "Next step: read the TARGET FILE first; coverage applies only to the reported pattern and scopes.");
  return lines.join("\n").trimEnd();
}


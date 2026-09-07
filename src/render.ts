import { truncateLine } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { relatedReferencesForPath, type RelatedExpansionDetails } from "./related.ts";
import type { CodeMatch, RankedFileResult, SearchCoverageDetails, SearchDetails, SearchTopMatch, SearchEvidence } from "./types.ts";

interface ThemeLike {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

function formatEvidence(evidence?: SearchEvidence): string {
  if (!evidence) return "content";
  return `${evidence.tier}; ${evidence.basis}; ${evidence.competingCandidates} competing candidates`;
}

export function formatTopMatch(match: CodeMatch): SearchTopMatch {
  return {
    lineNumber: match.lineNumber,
    marker: match.isDefinition && /^\s*scope\s+:/.test(match.line) ? "scope" : match.isDefinition ? "def" : "ref",
    text: truncateLine(match.line.trim(), 180).text,
  };
}

export function formatSearchResults(
  query: string, ranked: RankedFileResult[], totalMatches: number, notes: string[] = [],
  targetInstruction = "Read this file first; use other ranked candidates if it lacks the requested context.",
  related?: RelatedExpansionDetails, coverage?: SearchCoverageDetails,
): string {
  if (!ranked.length) {
    return [
      coverage?.status === "failed" ? `Search failed for ${JSON.stringify(query)}.` : `No code matches found for ${JSON.stringify(query)} in the completed scopes.`,
      ...notes, "Path hints are coverage, not code matches.",
      coverage?.status === "complete" ? "Search complete for the reported pattern and scopes." : "Coverage is incomplete; inspect the unvisited roots and unresolved relationships listed above.",
    ].join("\n\n");
  }
  const primary = ranked[0]!.path;
  const lines = [
    `agentic_search: ${JSON.stringify(query)} — ${ranked.length} ranked file${ranked.length === 1 ? "" : "s"} from ${totalMatches} match${totalMatches === 1 ? "" : "es"}`,
    `TARGET FILE: ${primary}. ${targetInstruction}`, "",
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
  lines.push(...notes, "", coverage && coverage.status !== "complete"
    ? "Next step: read the TARGET FILE, then inspect the unvisited roots and unresolved relationships listed above."
    : "Next step: read the TARGET FILE first; coverage applies only to the reported pattern and scopes.");
  return lines.join("\n").trimEnd();
}

export function renderCall(args: Record<string, unknown>, theme: ThemeLike): Text {
  let text = theme.fg("toolTitle", theme.bold("agentic_search ")) + theme.fg("accent", JSON.stringify(args.query ?? ""));
  for (const key of ["path", "context", "intent", "expand_related", "literal", "case_sensitive"]) {
    if (args[key]) text += theme.fg("dim", ` ${key} ${JSON.stringify(args[key])}`);
  }
  return new Text(text, 0, 0);
}

export function renderResult(
  result: { details?: unknown; content: Array<{ type: string; text?: string }> },
  { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: ThemeLike,
): Text {
  if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
  const details = result.details as Partial<SearchDetails> | undefined;
  const files = Array.isArray(details?.files) ? details.files : [];
  const coverage = details?.coverage;
  let text: string;
  if (details?.totalMatches === 0) {
    text = theme.fg("dim", coverage?.status === "failed" ? "Search failed" : "No code matches found in completed scopes");
  } else if (typeof details?.totalMatches === "number" && typeof details.totalFiles === "number") {
    text = theme.fg("success", `${files.length}/${details.totalFiles} files ranked from ${details.totalMatches} matches`);
  } else {
    const first = result.content.find((item) => item.type === "text")?.text?.split("\n").find((line) => line.trim());
    text = theme.fg("success", first ?? "Search completed");
  }
  if (coverage?.status && coverage.status !== "complete") text += `\n${theme.fg("warning", `Coverage ${coverage.status}: ${coverage.reasons.join("; ")}`)}`;
  const top = files[0];
  if (top?.path) {
    text += `\n${theme.fg("accent", `top: ${top.path}`)}`;
    if (top.topMatch) text += theme.fg("dim", ` L${top.topMatch.lineNumber} [${top.topMatch.marker}] ${top.topMatch.text}`);
    text += theme.fg("muted", " → read target first");
  }
  if (details?.related) {
    const { roots, label } = details.related;
    text += `\n${theme.fg("muted", `expand_related: ${roots.length} ${label} files below are likely targets too; ${label} results are included search values and likely targets too`)}`;
  }
  if (coverage) {
    const covered = [
      ...(coverage.ownerRoot ? [`owner ${coverage.ownerRoot}`] : []),
      ...(coverage.packageRoots.length ? [`${coverage.packageRoots.length} imported package${coverage.packageRoots.length === 1 ? "" : "s"}`] : []),
      `${coverage.roots.length} target/relative roots`,
    ];
    text += `\n${theme.fg("muted", `one-call coverage: ${covered.join(", ")}; ${coverage.status ?? "unknown"}`)}`;
  }
  if (details?.literalFallback) text += theme.fg("warning", " (literal fallback)");
  if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
  if (expanded) {
    let topLevel = 0;
    let childIndex = 0;
    for (const file of files) {
      const references = relatedReferencesForPath(details?.related, file.path);
      const child = file.path !== top?.path && references.some((item) => item.from === top?.path);
      const prefix = child ? `↳ 1.${++childIndex}` : String(++topLevel);
      const relationship = child ? ` [${references.map((item) => `${item.relationship} ${top?.path} via ${item.name}; ${item.note}`).join(", ")}]` : "";
      const snippet = file.topMatch ? ` L${file.topMatch.lineNumber} [${file.topMatch.marker}] ${file.topMatch.text}` : "";
      text += `\n${theme.fg("accent", `${prefix}. ${file.path}`)} ${theme.fg("dim", `(score ${file.score}, ${file.matchCount} matches, evidence ${formatEvidence(file.evidence)})${relationship}${snippet}`)}`;
    }
    if (details?.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
  }
  return new Text(text, 0, 0);
}

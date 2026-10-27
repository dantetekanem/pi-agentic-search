import { Text } from "@earendil-works/pi-tui";
import { groupCoverageReasons } from "./coverage-summary.ts";
import { relatedReferencesForPath } from "./related.ts";
import type { SearchDetails } from "./types.ts";
import { formatEvidence } from "./format.ts";
export { formatSearchResults, formatTopMatch } from "./format.ts";

interface ThemeLike {
  fg(name: string, text: string): string;
  bold(text: string): string;
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
  if (coverage?.status && coverage.status !== "complete") {
    const groups = groupCoverageReasons(coverage.reasons ?? []);
    const shown = groups.slice(0, 3).map((group) => (group.count > 1 ? `${group.kind} ×${group.count}` : group.kind)).join("; ");
    const more = groups.length > 3 ? `; ${groups.length - 3} more kinds` : "";
    text += `\n${theme.fg("warning", `Coverage ${coverage.status}: ${coverage.reasons?.length ?? 0} reason${(coverage.reasons?.length ?? 0) === 1 ? "" : "s"}${shown ? ` — ${shown}${more}` : ""}`)}`;
  }
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

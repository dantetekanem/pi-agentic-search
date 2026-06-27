import { Text } from "@earendil-works/pi-tui";
import type { RelatedExpansionDetails } from "./related.ts";

interface RenderFileDetails {
  path: string;
  score: number;
  matchCount: number;
  reasons: string[];
  topMatch?: {
    lineNumber: number;
    marker: "def" | "ref" | "scope";
    text: string;
  };
  confidence?: number;
}

interface RenderSearchDetails {
  totalMatches?: number;
  totalFiles?: number;
  returnedFiles?: number;
  files?: RenderFileDetails[];
  related?: RelatedExpansionDetails;
  literalFallback?: boolean;
  truncation?: { truncated?: boolean };
  fullOutputPath?: string;
}

interface ThemeLike {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

export function renderCall(args: any, theme: ThemeLike): Text {
  let text = theme.fg("toolTitle", theme.bold("agentic_search "));
  text += theme.fg("accent", JSON.stringify(args.query ?? ""));
  if (args.path) text += theme.fg("dim", ` path ${JSON.stringify(args.path)}`);
  if (args.context) text += theme.fg("dim", ` context ${JSON.stringify(args.context)}`);
  if (args.expand_mixins) text += theme.fg("dim", " expand_mixins true");
  if (args.expand_related) text += theme.fg("dim", " expand_related true");
  return new Text(text, 0, 0);
}

export function renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: ThemeLike): Text {
  if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

  const details = result.details as Partial<RenderSearchDetails> | undefined;
  const files = Array.isArray(details?.files) ? details.files : [];
  const totalMatches = typeof details?.totalMatches === "number" ? details.totalMatches : undefined;
  const totalFiles = typeof details?.totalFiles === "number" ? details.totalFiles : undefined;
  const returnedFiles = typeof details?.returnedFiles === "number" ? details.returnedFiles : files.length;

  if (totalMatches === 0) return new Text(theme.fg("dim", "No matches found"), 0, 0);

  let text: string;
  if (totalMatches === undefined || totalFiles === undefined) {
    const firstText = result.content.find((item: any) => item.type === "text")?.text;
    const firstLine = firstText?.split("\n").find((line: string) => line.trim());
    text = theme.fg("success", firstLine ?? "Search completed");
  } else {
    const confidenceSum = files.reduce((sum, file) => sum + (typeof file.confidence === "number" ? file.confidence : 0), 0);
    const confidenceText = files.some((file) => typeof file.confidence === "number") ? `, confidence ${confidenceSum.toFixed(3)}` : "";
    text = theme.fg("success", `${returnedFiles}/${totalFiles} files ranked from ${totalMatches} matches${confidenceText}`);
  }

  const top = files[0];
  if (top?.path) {
    text += `\n${theme.fg("accent", `top: ${top.path}`)}`;
    if (top.topMatch) {
      text += theme.fg("dim", ` L${top.topMatch.lineNumber} [${top.topMatch.marker}] ${top.topMatch.text}`);
    }
    const relatedCount = details?.related?.roots.length;
    const relatedLabel = details?.related?.label ?? "related";
    text += theme.fg(
      "muted",
      relatedCount !== undefined
        ? ` → read target first; ${relatedCount} ${relatedLabel} file${relatedCount === 1 ? "" : "s"} below are likely targets too`
        : " → read target first",
    );
  }

  if (details?.related) {
    const relatedLabel = details.related.label;
    text += `\n${theme.fg("muted", `expand_related: searched ${details.related.roots.length} resolved ${relatedLabel} file${details.related.roots.length === 1 ? "" : "s"}; ${relatedLabel} results are included search values and likely targets too`)}`;
  }

  if (details?.literalFallback) text += theme.fg("warning", " (literal fallback)");
  if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");

  if (expanded && files.length > 0) {
    const primaryPath = files[0]?.path;
    const relatedByPath = new Map<string, Array<{ from: string; name: string; relationship: string; note: string }>>();
    for (const item of details?.related?.resolved ?? []) {
      const existing = relatedByPath.get(item.path) ?? [];
      existing.push({ from: item.from, name: item.name, relationship: item.relationship, note: item.note });
      relatedByPath.set(item.path, existing);
    }

    let topLevelIndex = 0;
    let relatedChildIndex = 0;
    for (const file of files.slice(0, 10)) {
      const topMatch = file.topMatch ? ` L${file.topMatch.lineNumber} [${file.topMatch.marker}] ${file.topMatch.text}` : "";
      const confidence = typeof file.confidence === "number" ? `, confidence ${file.confidence.toFixed(3)}` : "";
      const relatedReferences = relatedByPath.get(file.path) ?? [];
      const isPrimaryRelatedChild = file.path !== primaryPath && relatedReferences.some((item) => item.from === primaryPath);
      const displayIndex = isPrimaryRelatedChild ? `1.${++relatedChildIndex}` : String(++topLevelIndex);
      const prefix = isPrimaryRelatedChild ? `↳ ${displayIndex}` : displayIndex;
      const targetReason = file.reasons.includes("primary target") ? " [primary target]" : "";
      const relatedLabel = isPrimaryRelatedChild
        ? ` [${relatedReferences.map((item) => `${item.relationship} ${primaryPath} via ${item.name}; ${item.note}`).join(", ")}]`
        : "";
      text += `\n${theme.fg("accent", `${prefix}. ${file.path}`)} ${theme.fg("dim", `(score ${file.score}${confidence}, ${file.matchCount} matches)${targetReason}${relatedLabel}${topMatch}`)}`;
    }
    if (details?.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
  }

  return new Text(text, 0, 0);
}

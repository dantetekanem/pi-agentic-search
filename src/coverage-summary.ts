import type { SearchCoverageDetails } from "./types.ts";

export interface ReasonGroup {
  kind: string;
  count: number;
  names: Map<string, number>;
  examples: string[];
}

interface ReasonPattern {
  test: RegExp;
  kind: (match: RegExpMatchArray) => string;
  name?: (match: RegExpMatchArray) => string;
  example?: (match: RegExpMatchArray) => string | undefined;
}

const PATTERNS: ReasonPattern[] = [
  { test: /^unresolved (\S+) from (.+)$/, kind: () => "unresolved relationships", name: (match) => match[1]!, example: (match) => match[2] },
  { test: /^unvisited (mixin|import) (\S+) from (.+?) \((.+)\)$/, kind: (match) => `unvisited ${match[1]}s (${match[4]})`, name: (match) => match[2]!, example: (match) => match[3] },
  { test: /^dynamic mixin not evaluated in (.+): (.+)$/, kind: () => "dynamic mixins not evaluated", name: (match) => match[2]!, example: (match) => match[1] },
  { test: /^dynamic autoload configuration not evaluated in (.+)$/, kind: () => "dynamic autoload configuration not evaluated", example: (match) => match[1] },
  { test: /^unsearched imported package (.+)$/, kind: () => "unsearched imported packages", example: (match) => match[1] },
  { test: /^unreadable (source|directory) (.+)$/, kind: (match) => `unreadable ${match[1]}s`, example: (match) => match[2] },
  { test: /^invalid manifest (.+)$/, kind: () => "invalid manifests", example: (match) => match[1] },
  { test: /^(.*?\bbudget)\b(.*)$/, kind: (match) => match[1]!, example: (match) => match[2]?.replace(/^(\s+at\s+|:\s*|\s+)/, "").trim() || undefined },
];

export function groupCoverageReasons(reasons: string[]): ReasonGroup[] {
  const groups = new Map<string, ReasonGroup>();
  for (const reason of reasons) {
    let kind = reason;
    let name: string | undefined;
    let example: string | undefined;
    for (const pattern of PATTERNS) {
      const match = reason.match(pattern.test);
      if (!match) continue;
      kind = pattern.kind(match);
      name = pattern.name?.(match);
      example = pattern.example?.(match);
      break;
    }
    const group: ReasonGroup = groups.get(kind) ?? { kind, count: 0, names: new Map<string, number>(), examples: [] };
    group.count += 1;
    if (name) group.names.set(name, (group.names.get(name) ?? 0) + 1);
    if (example && !group.examples.includes(example)) group.examples.push(example);
    groups.set(kind, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

export function describeNameCounts(names: Map<string, number>, limit: number): { shown: string; more: number } {
  const ranked = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = ranked.slice(0, limit).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
  return { shown, more: Math.max(0, ranked.length - limit) };
}

export function describeReasonGroup(group: ReasonGroup, options: { names?: number; examples?: number } = {}): string {
  const nameLimit = options.names ?? 3;
  const exampleLimit = options.examples ?? 1;
  if (group.names.size) {
    const { shown, more } = describeNameCounts(group.names, nameLimit);
    const sites = group.count === 1 ? "1 site" : `${group.count} sites`;
    const example = group.examples.length ? ` (e.g. ${group.examples.slice(0, exampleLimit).join(", ")})` : "";
    return `${group.kind}: ${sites}, ${group.names.size} name${group.names.size === 1 ? "" : "s"} — ${shown}${example}${more ? `; ${more} more name${more === 1 ? "" : "s"}` : ""}`;
  }
  const examples = group.examples.slice(0, exampleLimit).join("; ");
  const more = group.examples.length > exampleLimit ? `; ${group.examples.length - exampleLimit} more` : "";
  return `${group.kind}${group.count > 1 ? ` ×${group.count}` : ""}${examples ? ` — ${examples}` : ""}${more}`;
}

export function summarizeCoverageReasons(reasons: string[], options: { skipKinds?: string[]; maxGroups?: number; names?: number; examples?: number } = {}): { lines: string[]; total: number; kinds: number } {
  const groups = groupCoverageReasons(reasons).filter((group) => !options.skipKinds?.includes(group.kind));
  const maxGroups = options.maxGroups ?? 8;
  const lines = groups.slice(0, maxGroups).map((group) => describeReasonGroup(group, options));
  if (groups.length > maxGroups) lines.push(`${groups.length - maxGroups} more kinds of coverage limit in details.coverage.reasons`);
  return { lines, total: groups.reduce((sum, group) => sum + group.count, 0), kinds: groups.length };
}

export function capList(items: string[], limit: number): string {
  if (!items.length) return "none";
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown}, and ${items.length - limit} more` : shown;
}

export function coverageNotes(coverage: SearchCoverageDetails, options: { unresolvedSummarized?: boolean } = {}): string[] {
  const parts = [`${coverage.roots.length} target/relative roots`];
  if (coverage.ownerRoot) parts.push(`owning package ${coverage.ownerRoot}`);
  if (coverage.packageRoots.length) parts.push(`${coverage.packageRoots.length} imported packages`);
  const limits = summarizeCoverageReasons(coverage.reasons, { skipKinds: options.unresolvedSummarized ? ["unresolved relationships"] : [], maxGroups: 5 });
  return [
    `One-call coverage: ${parts.join("; ")}. Status: ${coverage.status}.`,
    `Completed roots (${coverage.completedRoots.length}): ${capList(coverage.completedRoots, 3)}.`,
    ...(coverage.unvisitedRoots.length ? [`Unvisited or incomplete roots (${coverage.unvisitedRoots.length}): ${capList(coverage.unvisitedRoots, 3)}.`] : []),
    ...limits.lines.map((line) => `Coverage limit: ${line}.`),
    ...(coverage.reasons.length || coverage.completedRoots.length > 3 ? [`Full coverage details: ${coverage.reasons.length} reasons in details.coverage.reasons; all roots and runs retained in details.coverage.`] : []),
    ...(coverage.packageRoots.length ? [`Imported packages searched: ${capList(coverage.packageRoots, 3)}.`] : []),
    ...(coverage.omittedMatches ? [`Snippet retention: ${coverage.retainedMatches} retained; ${coverage.omittedMatches} omitted. Counts include all visited matching lines.`] : []),
  ];
}

import { normalizeRepoRelativePath } from "./shared.ts";
import type { CodeMatch } from "./types.ts";
import { classifyMatch } from "./evidence.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  const item = record(value);
  if (typeof item?.text === "string") return item.text;
  if (typeof item?.bytes === "string") return Buffer.from(item.bytes, "base64").toString("utf8");
  return undefined;
}

export type RipgrepEvent = { type: "begin"; path: string } | { type: "end"; path: string } | { type: "match"; match: CodeMatch };

export function decodeRipgrepEvent(line: string, mapPath = normalizeRepoRelativePath): RipgrepEvent | undefined {
  const event = record(JSON.parse(line));
  if (!event || !["begin", "match", "end"].includes(String(event.type))) return undefined;
  const data = record(event.data);
  const path = text(data?.path);
  if (!path) throw new Error("Invalid rg JSON path");
  if (event.type === "begin" || event.type === "end") return { type: event.type, path: mapPath(path) };
  const source = text(data?.lines);
  if (source === undefined || typeof data?.line_number !== "number") throw new Error("Invalid rg JSON match");
  const match: CodeMatch = {
    path: mapPath(path), lineNumber: data.line_number, line: source.replace(/\r?\n$/, ""),
    submatches: Array.isArray(data.submatches) ? data.submatches.flatMap((raw) => {
      const span = record(raw);
      const value = text(span?.match);
      return value !== undefined && typeof span?.start === "number" && typeof span.end === "number"
        ? [{ text: value, start: span.start, end: span.end }] : [];
    }) : [],
    isDefinition: false,
  };
  match.kind = classifyMatch(match);
  match.isDefinition = match.kind === "definition";
  return { type: "match", match };
}

export function parseRipgrepJsonLines(output: string): CodeMatch[] {
  const matches: CodeMatch[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = decodeRipgrepEvent(line);
      if (event?.type === "match") matches.push(event.match);
    } catch {
      // The public batch parser tolerates malformed records; live retrieval reports them.
    }
  }
  return matches;
}

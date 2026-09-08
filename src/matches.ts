import { normalizeRepoRelativePath } from "./shared.ts";
import type { CodeMatch } from "./types.ts";

const DEFINITION_PATTERNS = [
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+[A-Za-z_$][\w$]*/,
  /^\s*(export\s+)?(abstract\s+)?class\s+[A-Za-z_$][\w$]*/,
  /^\s*(export\s+)?(interface|type|enum)\s+[A-Za-z_$][\w$]*/,
  /^\s*(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
  /^\s*(def|class|module)\s+[A-Za-z_][\w!?=]*/,
  /^\s*(async\s+)?(def|class)\s+[A-Za-z_][\w]*/,
  /^\s*(pub\s+)?(async\s+)?(fn|struct|enum|trait|impl|mod|type|const)\s+[A-Za-z_][\w]*/,
  /^\s*(func|type|var|const)\s+[A-Za-z_][\w]*/,
  /^\s*func\s*\([^)]*\)\s*[A-Za-z_][\w]*/,
  /^\s*(public|private|protected)?\s*(static\s+)?(class|interface|enum|record)\s+[A-Za-z_][\w]*/,
];

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
  return {
    type: "match",
    match: {
      path: mapPath(path), lineNumber: data.line_number, line: source.replace(/\r?\n$/, ""),
      submatches: Array.isArray(data.submatches) ? data.submatches.flatMap((raw) => {
        const match = record(raw);
        const value = text(match?.match);
        return value !== undefined && typeof match?.start === "number" && typeof match.end === "number"
          ? [{ text: value, start: match.start, end: match.end }] : [];
      }) : [],
      isDefinition: DEFINITION_PATTERNS.some((pattern) => pattern.test(source)),
    },
  };
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

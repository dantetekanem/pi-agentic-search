import { extname } from "node:path";
import { JS_TS_EXTENSIONS } from "./classifications.ts";
import type { CodeMatch, MatchKind, SearchIntent } from "./types.ts";

const FALLBACK_DECLARATIONS = [
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
const JS_DECLARATIONS = [
  /^\s*(?:(?:export|default|declare|async|abstract)\s+)*(?:function\s*\*?|class|interface|type|enum)\s+(?<name>[$_\p{L}][$_\p{L}\p{N}\p{M}]*)/du,
  /^\s*(?:(?:export|declare)\s+)*(?:const|let|var)\s+(?<name>[$_\p{L}][$_\p{L}\p{N}\p{M}]*)/du,
  /^\s*(?:(?:public|private|protected|static|async|override|abstract|get|set)\s+)*(?<name>[$_\p{L}][$_\p{L}\p{N}\p{M}]*)\s*(?:<[^>]+>)?\([^)]*\)\s*(?::[^{]+)?\{/du,
];
const RUBY_DECLARATIONS = [
  /^\s*def\s+(?:self\.|[\p{Lu}][\p{L}\p{N}_:]*\.)?(?<name>[\p{L}_][\p{L}\p{N}_]*[!?=]?)/du,
  /^\s*(?:class|module)\s+(?<name>[\p{L}_][\p{L}\p{N}_]*(?:::[\p{L}_][\p{L}\p{N}_]*)*)/du,
  /^\s*scope\s+:(?<name>[\p{L}_][\p{L}\p{N}_]*[!?]?)/du,
];
const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch", "with"]);

function lexicalKind(line: string, position: number, ruby: boolean): MatchKind {
  let quote: string | undefined;
  let blockComment = false;
  for (let index = 0; index <= position && index < line.length; index++) {
    const char = line[index];
    if (blockComment) {
      if (index === position) return "comment";
      if (char === "*" && line[index + 1] === "/") { blockComment = false; index++; }
    } else if (quote) {
      if (index === position) return "string";
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
    } else if ((char === "/" && line[index + 1] === "/") || (ruby && char === "#")) {
      return "comment";
    } else if (char === "/" && line[index + 1] === "*") {
      blockComment = true;
    } else if (char === "'" || char === '"' || char === "`") quote = char;
  }
  return quote ? "string" : blockComment ? "comment" : "reference";
}

export function classifyMatch(match: CodeMatch): MatchKind {
  const ruby = extname(match.path) === ".rb";
  if (!ruby && !JS_TS_EXTENSIONS.has(extname(match.path))) {
    return FALLBACK_DECLARATIONS.some((pattern) => pattern.test(match.line)) ? "definition" : "reference";
  }
  if (/^\s*(?:\/\/|\/\*|\*\s)/.test(match.line) || (ruby && /^\s*#/.test(match.line))) return "comment";
  if (/^\s*(?:import\b|export\b.*\bfrom\s*['"])/.test(match.line)) return "import";
  const declarations = (ruby ? RUBY_DECLARATIONS : JS_DECLARATIONS).flatMap((pattern) => {
    const declaration = pattern.exec(match.line);
    const span = declaration?.indices?.groups?.name;
    return span && !CONTROL_WORDS.has(declaration?.groups?.name ?? "") ? [span] : [];
  });
  const bytes = Buffer.from(match.line);
  const spans = match.submatches.map((span) => ({
    ...span, start: bytes.subarray(0, span.start).toString("utf8").length,
    end: bytes.subarray(0, span.end).toString("utf8").length,
  }));
  if (spans.some((span) => declarations.some(([start, end]) => span.start < end && span.end > start))) return "definition";
  if (declarations.length && spans.some((span) => /^(?:scope\s*:|(?:export\s+)?(?:function|class|module|def|const|let|var)\s+)$/.test(span.text))) return "definition";
  if (spans.length === 0) return "reference";
  const kinds = spans.map((span) => lexicalKind(match.line, span.start, ruby));
  return kinds.includes("reference") ? "reference" : kinds.includes("string") ? "string" : "comment";
}

export function words(value: string): string[] {
  return value.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function snippetPriority(match: CodeMatch, intent: SearchIntent = "auto", context: string[] = [], declarationEvidence = true): number {
  const kind = match.kind ?? (match.isDefinition ? "definition" : "reference");
  const priorities: Record<MatchKind, number> = { definition: declarationEvidence ? 4 : 3, reference: 3, import: 2, string: 1, comment: 0 };
  const tier = intent === "references" && kind === "reference" ? 5 : priorities[kind];
  if (context.length === 0) return tier * 10;
  const tokens = new Set(words(`${match.line} ${match.contextBlock ?? ""}`));
  return tier * 10 + Math.min(9, context.filter((token) => tokens.has(token)).length);
}

export function selectSnippets(matches: CodeMatch[], limit: number, intent: SearchIntent = "auto", context: string[] = [], declarationEvidence = true): CodeMatch[] {
  const sorted = [...matches].sort((a, b) => snippetPriority(b, intent, context, declarationEvidence) - snippetPriority(a, intent, context, declarationEvidence) || a.lineNumber - b.lineNumber);
  const selected: CodeMatch[] = [];
  for (const match of sorted) {
    if (selected.length >= limit) break;
    if (selected.some((existing) => existing.lineNumber === match.lineNumber ||
      (Math.abs(existing.lineNumber - match.lineNumber) <= 1 && !(existing.isDefinition && match.isDefinition)))) continue;
    selected.push(match);
  }
  return selected;
}

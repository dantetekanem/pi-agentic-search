import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import type { RelatedExpansionDetails } from "./related.ts";

export interface CodeMatch {
  path: string;
  lineNumber: number;
  line: string;
  submatches: Array<{ text: string; start: number; end: number }>;
  isDefinition: boolean;
}
export interface FileSummary {
  path: string;
  matchCount: number;
  definitionCount: number;
  matches: CodeMatch[];
  complete: boolean;
}
export interface RankedFileResult {
  path: string;
  score: number;
  confidence?: number;
  reasons: string[];
  matchCount: number;
  matches: CodeMatch[];
}
export interface PathMatch { path: string; score: number; reasons: string[] }
export interface SearchTopMatch { lineNumber: number; marker: "def" | "ref" | "scope"; text: string }
export interface SearchFileDetails extends Pick<RankedFileResult, "path" | "score" | "matchCount" | "reasons"> {
  topMatch?: SearchTopMatch;
  confidence?: number;
}
export interface SearchRun {
  kind?: "content" | "inventory" | "validation";
  roots: string[];
  status: "complete" | "partial" | "failed";
  exitCode: number | null;
  signal: string | null;
  reason?: string;
  error?: string;
}
export interface SearchCoverageDetails {
  status: "complete" | "partial" | "failed";
  roots: string[];
  ownerRoot?: string;
  packageRoots: string[];
  omittedPackageRoots: number;
  omittedRelatedCandidates: number;
  packagePolicy: { excludes: string[]; respectsIgnoreFiles: false };
  completedRoots: string[];
  unvisitedRoots: string[];
  reasons: string[];
  runs: SearchRun[];
  excludes: string[];
  respectsIgnoreFiles: boolean;
  retainedMatches: number;
  omittedMatches: number;
  retainedBytes: number;
  truncatedMatches: number;
  limits: { candidates: number; snippetsPerFile: number; snippetBytes: number; retainedBytes: number; eventBytes: number };
}
export interface SearchDetails {
  query: string;
  context?: string;
  totalMatches: number;
  totalFiles: number;
  returnedFiles: number;
  files: SearchFileDetails[];
  coverage: SearchCoverageDetails;
  related?: RelatedExpansionDetails;
  truncation?: TruncationResult;
  fullOutputPath?: string;
  literalFallback?: boolean;
  regexError?: string;
}

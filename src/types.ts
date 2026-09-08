import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export interface SymbolBinding { local: string; imported: string }
export interface RelatedResolvedReference {
  from: string;
  name: string;
  path: string;
  relationship: string;
  note: string;
  kind?: "file" | "package";
  entryPath?: string;
  declarationPath?: string;
  implementationPath?: string;
  symbols?: string[];
  bindings?: SymbolBinding[];
  compilerVersion?: string;
  projectCompilerVersion?: string;
  configPath?: string;
  resolutionMode?: "import" | "require";
  provenance?: string;
}
export interface RelatedPackageRoot {
  from: string;
  name: string;
  path: string;
  entryPath: string;
  provenance?: string;
}
export interface RelatedExpansionDetails {
  enabled: boolean;
  label: "mixin" | "import" | "related";
  roots: string[];
  packageRoots: RelatedPackageRoot[];
  symbolSearches?: Array<{ path: string; symbol: string; querySymbol: string }>;
  resolved: RelatedResolvedReference[];
  unresolved: Array<{ from: string; name: string }>;
  skipped?: string[];
  traversal?: {
    visitedFiles: number; visitedStates?: number; examinedEdges: number; omittedEdges: number; omittedFileCandidates: number;
    sourceReads: number; bytesRead: number; inventories: number; compilerPasses: number; omittedDiagnostics: number;
    limits: Record<string, number>;
  };
}
export interface RelationshipReference {
  name: string;
  relationship: string;
  namespace?: string[];
  bindings?: SymbolBinding[];
  symbols?: string[];
  resolutionMode?: "import" | "require";
  dynamic?: boolean;
}

export type SearchIntent = "definition" | "references" | "tests" | "file" | "auto";
export type MatchKind = "definition" | "reference" | "import" | "string" | "comment";
export interface SearchEvidence {
  tier: "definition" | "reference" | "text" | "path";
  definitionCount: number;
  referenceCount: number;
  basis: "declaration-span" | "line-pattern" | "text" | "path";
  competingCandidates: number;
  contextRead?: "bounded" | "unavailable";
}

export interface CodeMatch {
  path: string;
  lineNumber: number;
  line: string;
  submatches: Array<{ text: string; start: number; end: number }>;
  isDefinition: boolean;
  kind?: MatchKind;
  contextBlock?: string;
}
export interface FileSummary {
  path: string;
  matchCount: number;
  definitionCount: number;
  referenceCount: number;
  matches: CodeMatch[];
  complete: boolean;
  truncatedMatches?: number;
}
export interface RankedFileResult {
  path: string;
  score: number;
  evidence?: SearchEvidence;
  reasons: string[];
  matchCount: number;
  matches: CodeMatch[];
}
export interface PathMatch { path: string; score: number; reasons: string[] }
export interface SearchTopMatch { lineNumber: number; marker: "def" | "ref" | "scope"; text: string }
export interface SearchFileDetails extends Pick<RankedFileResult, "path" | "score" | "matchCount" | "reasons" | "evidence"> {
  topMatch?: SearchTopMatch;
}
export interface SearchRun {
  stage?: "target" | "related" | "alias" | "entry" | "owner" | "package";
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
  executionLimits?: { packageConcurrency: number; packages: number; rootBatch: number; replayBytes: number };
  contextRanking?: {
    fileLimit: number; readByteLimit: number; blockByteLimit: number;
    enrichedCandidates: number; unexaminedCandidates: number;
  };
}
export interface SearchDetails {
  query: string;
  intent?: SearchIntent;
  anchorPath?: string;
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

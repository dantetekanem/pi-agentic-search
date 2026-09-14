export type Language = "ruby" | "javascript";

export interface Definition {
  name: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface ParamInfo {
  name: string;
  type?: string;
}

export interface AdapterDefinition extends Definition {
  owner?: string;
  singleton?: boolean;
  params?: ParamInfo[];
  returns?: string;
}

export interface NamespaceInfo {
  name: string;
  symbol: string;
  kind: "class" | "module";
  startLine: number;
  endLine: number;
  superclass?: string;
  mixins: string[];
}

export type InferenceVia = "typed" | "assigned" | "ivar" | "named";

export interface IvarInfo {
  name: string;
  type?: string;
  via?: InferenceVia;
  line: number;
}

export interface FileFacts {
  path: string;
  language: Language;
  definitions: AdapterDefinition[];
  namespaces: NamespaceInfo[];
  ivars: Map<string, IvarInfo[]>;
  errors: number;
}

export type CallSource = "constant_method" | "receiver_method" | "bare" | "constant" | "call" | "member" | "jsx" | "new" | "super";

export interface ResolvedTarget {
  path: string;
  line: number;
  symbol?: string;
  external?: string;
  declaration?: boolean;
}

export interface CallSite {
  name: string;
  line: number;
  receiver?: string;
  relationship: "calls" | "references";
  source: CallSource;
  receiverKind?: "implicit" | "self" | "constant" | "local" | "ivar" | "chain" | "other";
  receiverType?: string;
  via?: InferenceVia | "checker";
  target?: ResolvedTarget;
}

export interface LanguageAdapter {
  readonly language: Language;
  ready(): Promise<boolean>;
  parse(path: string, source: string): FileFacts | undefined;
  definitionAt(facts: FileFacts, line: number): AdapterDefinition | undefined;
  calls(facts: FileFacts, def: Definition): CallSite[];
}

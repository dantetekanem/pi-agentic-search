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
  collection?: CollectionKind;
}

export interface AdapterDefinition extends Definition {
  owner?: string;
  singleton?: boolean;
  params?: ParamInfo[];
  returns?: string;
  /** The parameter list as written, whitespace removed; absent for definitions that take no parameter list. */
  signature?: string;
  /** A class-body call (such as `has_many` or `validates`) that runs when its file loads. */
  loadTime?: boolean;
  /** A Ruby method that is not public; absent for public methods and everything else. */
  visibility?: "private" | "protected";
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

export type CollectionKind = "relation" | "array";

export interface IvarInfo {
  name: string;
  type?: string;
  via?: InferenceVia;
  collection?: CollectionKind;
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

export type CallSource = "constant_method" | "receiver_method" | "bare" | "constant" | "call" | "member" | "jsx" | "new" | "super" | "symbol_proc" | "dynamic" | "enqueue";

/** A call that persists (`write`), enqueues background work (`enqueue`) or touches a cache (`cache`), named by its method; `text` is the call as written, without a block. */
export interface Effect {
  kind: "write" | "enqueue" | "cache";
  line: number;
  text: string;
}

export interface ResolvedTarget {
  path: string;
  line: number;
  symbol?: string;
  external?: string;
  declaration?: boolean;
  local?: "parameter" | "local";
}

/**
 * A condition that dominates code, as written: `if x`, `elsif x`, `unless x` and TypeScript `if (x)` keep their keyword;
 * a ternary condition or the left side of `&&`/`||` is the expression alone. `then`: inside the branch taken when that
 * text holds (`unless x` holds when x is falsy; the right side of `||` is the `else` of its left side). `else`: inside the
 * other branch. `after-return`: after an early exit (return, next, break, raise, throw, continue) taken when it holds.
 * The scanner does not interpret the condition.
 */
export interface Guard {
  line: number;
  text: string;
  branch: "then" | "else" | "after-return";
}

export interface CallSite {
  name: string;
  line: number;
  receiver?: string;
  /** `enqueues`: the call schedules `receiver#name` (a job's perform or a mailer action) to run later. */
  relationship: "calls" | "references" | "enqueues";
  source: CallSource;
  receiverKind?: "implicit" | "self" | "constant" | "local" | "ivar" | "chain" | "other";
  receiverType?: string;
  via?: InferenceVia | "checker" | "chain";
  target?: ResolvedTarget;
  label?: string;
  chain?: string[];
  dynamic?: string;
  /** Conditions dominating the call inside its definition, outermost first; absent when none. */
  guards?: Guard[];
  /** Set when the call's method writes, enqueues or uses a cache, whether or not the call is followed. */
  effect?: Effect;
}

export interface LanguageAdapter {
  readonly language: Language;
  ready(): Promise<boolean>;
  /** `detached` parses text that is not the checkout's file, such as another revision, without caches or compiler programs. */
  parse(path: string, source: string, detached?: boolean): FileFacts | undefined;
  definitionAt(facts: FileFacts, line: number): AdapterDefinition | undefined;
  calls(facts: FileFacts, def: Definition): CallSite[];
  /** Conditions dominating the code that starts `line` inside `def`, outermost first. Method and class bodies start with none. */
  guardsAt(facts: FileFacts, def: Definition, line: number): Guard[];
  /** The setup blocks that run before the test `def`: Ruby `setup`, `before` and `def setup`, JS/TS `beforeEach`, `beforeAll`, `before` and `setup`, in the scopes enclosing it, outermost first. */
  setupBlocks(facts: FileFacts, def: Definition): Array<{ startLine: number; endLine: number }>;
}

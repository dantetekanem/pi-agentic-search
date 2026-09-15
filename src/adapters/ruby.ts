import type * as Prism from "@ruby/prism";
import type {
  AdapterDefinition,
  CallSite,
  CollectionKind,
  Definition,
  FileFacts,
  InferenceVia,
  IvarInfo,
  LanguageAdapter,
  NamespaceInfo,
  ParamInfo,
} from "./types.ts";

type ParseResult = { value: Prism.ProgramNode; comments: Array<{ location: Prism.Location }>; errors: unknown[] };
type ParseFn = (source: string, options?: Prism.Options) => ParseResult;
type Node = Prism.Node;

export interface LocalType {
  type: string;
  via: InferenceVia;
  collection?: CollectionKind;
  chain?: string[];
}

interface RubyFacts extends FileFacts {
  program: Prism.ProgramNode;
  lineStarts: Uint32Array;
  bytes: Buffer;
  defNodes: Map<number, Node>;
  localTypes: Map<number, Map<string, LocalType>>;
}

const DECLARATION_CALLS = new Set([
  "scope", "attr_reader", "attr_accessor", "attr_writer", "has_many", "has_one", "belongs_to",
  "has_and_belongs_to_many", "delegate", "alias_method", "define_method", "enum", "store_accessor",
  "class_attribute", "attribute", "mattr_accessor", "cattr_accessor", "thread_mattr_accessor", "validates",
  "validate", "before_validation", "after_validation", "before_save", "after_save", "before_create",
  "after_create", "before_update", "after_update", "before_destroy", "after_destroy", "after_commit",
  "after_rollback", "before_action", "after_action", "around_action", "skip_before_action", "field", "argument",
  "description", "serialize", "accepts_nested_attributes_for", "has_secure_token", "encrypts", "queue_as",
  "retry_on", "discard_on", "rescue_from", "helper_method", "layout", "protect_from_forgery", "sig",
  "T", "extend", "include", "prepend", "requires_ancestor", "abstract!", "interface!", "final!", "sealed!",
  "const", "prop", "resolve_type", "returns", "type", "graphql_name", "connection_type_class", "value",
  "table_name", "self", "private_constant", "module_function", "using", "require", "require_relative",
]);

const TEST_BLOCKS = new Set(["test", "it", "describe", "context", "scenario", "specify", "shared_examples", "feature"]);
const MIXIN_CALLS = new Set(["include", "extend", "prepend"]);
const CONSTRUCTOR_LIKE = new Set(["new", "find", "find_by", "find_by!", "find_or_create_by", "find_or_create_by!", "find_or_initialize_by", "create", "create!", "build", "first", "last", "take", "instance", "current", "for", "from", "load", "fetch", "lookup", "wrap", "parse", "cast", "must"]);

export const RELATION_METHODS = new Set([
  "where", "not", "rewhere", "order", "reorder", "limit", "offset", "joins", "left_joins", "left_outer_joins", "includes",
  "preload", "eager_load", "references", "distinct", "group", "having", "all", "none", "unscoped", "unscope", "readonly",
  "lock", "extending", "merge", "or", "and", "create_with", "strict_loading", "reselect", "excluding", "without", "in_order_of",
]);
const SCALAR_METHODS = new Set([
  "count", "size", "length", "sum", "exists?", "any?", "all?", "none?", "empty?", "many?", "pluck", "pick", "ids", "maximum",
  "minimum", "average", "calculate", "delete_all", "update_all", "destroy_all", "explain", "to_sql", "to_h", "to_json", "join",
  "index_by", "group_by", "partition", "each_slice", "zip", "tally", "reduce", "inject", "each_with_object",
]);
const MAP_METHODS = new Set(["map", "collect", "flat_map", "collect_concat", "filter_map"]);
const FILTER_METHODS = new Set(["select", "filter", "find_all", "reject", "sort", "sort_by", "uniq", "compact", "reverse", "shuffle", "take", "drop", "take_while", "drop_while", "to_a", "to_ary", "each", "each_with_index", "tap", "presence", "dup", "freeze", "lazy", "force", "entries", "load"]);
const ELEMENT_METHODS = new Set(["first", "last", "find", "detect", "sample", "min_by", "max_by", "min", "max", "pop", "shift", "find_by", "find_by!", "sole", "take"]);
const BLOCK_ITERATORS = new Set([
  "each", "each_with_index", "each_with_object", "map", "collect", "flat_map", "collect_concat", "filter_map", "select", "filter",
  "reject", "find", "detect", "find_all", "any?", "all?", "none?", "one?", "sort_by", "min_by", "max_by", "group_by", "partition",
  "index_by", "sum", "count", "find_each", "each_entry", "take_while", "drop_while", "find_index", "tally_by", "uniq",
]);
const PASSTHROUGH_BLOCK = new Set(["connected_to", "transaction", "with_connection", "uncached", "with_lock", "then", "yield_self", "benchmark", "instrument", "silence", "with_options"]);
const IDENTITY_METHODS = new Set(["tap", "itself", "dup", "clone", "freeze", "presence", "reload", "tap"]);
const DYNAMIC_DISPATCH = new Set(["send", "public_send", "__send__", "try", "try!"]);
const DYNAMIC_CONSTANT = new Set(["constantize", "safe_constantize", "const_get"]);

function constructorLike(name: string): boolean {
  return CONSTRUCTOR_LIKE.has(name) || /^(for|from|with|of|build|create|find|new|make|load|fetch|lookup|parse|wrap|instance)(_|$)/.test(name);
}

let parseFn: ParseFn | null | undefined;
let loading: Promise<boolean> | undefined;

async function loadParser(): Promise<boolean> {
  if (parseFn !== undefined) return parseFn !== null;
  loading ??= (async () => {
    try {
      const mod = await import("@ruby/prism");
      parseFn = await mod.loadPrism();
      return true;
    } catch {
      parseFn = null;
      return false;
    }
  })();
  return loading;
}

function lineStartsOf(bytes: Buffer): Uint32Array {
  const starts: number[] = [0];
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 10) starts.push(i + 1);
  return Uint32Array.from(starts);
}

function lineAt(starts: Uint32Array, offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function kindName(node: Node | null | undefined): string {
  return node ? node.constructor.name : "";
}

function sliceSource(bytes: Buffer, loc: Prism.Location | null | undefined): string {
  if (!loc) return "";
  return bytes.subarray(loc.startOffset, loc.startOffset + loc.length).toString("utf8");
}

function constantPathText(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  const kind = kindName(node);
  if (kind === "ConstantReadNode") return (node as Prism.ConstantReadNode).name;
  if (kind === "ConstantPathNode") {
    const path = node as Prism.ConstantPathNode;
    const parent = constantPathText(path.parent);
    if (!path.name) return parent;
    return parent ? `${parent}::${path.name}` : `::${path.name}`;
  }
  if (kind === "SelfNode") return "self";
  return undefined;
}

interface TypeInfo {
  type: string;
  collection?: CollectionKind;
}

function normalizeTypeInfo(text: string | undefined): TypeInfo | undefined {
  if (!text) return undefined;
  let value = text.trim();
  for (let i = 0; i < 4; i += 1) {
    const wrapped = value.match(/^T\.(?:nilable|must|let|cast|unsafe|all|any|attached_class|class_of|type_alias)\((.*)\)$/s);
    if (!wrapped) break;
    value = wrapped[1]!.trim();
  }
  if (/^(?:T::Hash|Hash)[[<]/.test(value)) return { type: "Hash" };
  const collection = value.match(/^(?:T::(?:Array|Set|Enumerable|Enumerator)|Array|Set|Enumerable)[[<](.*)[\]>]$/s);
  if (collection) {
    const element = normalizeTypeInfo(collection[1]!.split(",")[0]);
    return element && !element.collection ? { type: element.type, collection: "array" } : undefined;
  }
  const relation = value.match(/^ActiveRecord::(?:Relation|AssociationRelation)[[<](.*)[\]>]$/s);
  if (relation) {
    const model = normalizeTypeInfo(relation[1]);
    return model && !model.collection ? { type: model.type, collection: "relation" } : undefined;
  }
  const privateRelation = value.match(/^(::)?([A-Z]\w*(?:::[A-Z]\w*)*)::Private(?:Relation|AssociationRelation|CollectionProxy)$/);
  if (privateRelation) return { type: privateRelation[2]!, collection: "relation" };
  const constant = value.match(/^(::)?([A-Z]\w*(?:::[A-Z]\w*)*)$/);
  return constant ? { type: constant[2]! } : undefined;
}

function normalizeType(text: string | undefined): string | undefined {
  return normalizeTypeInfo(text)?.type;
}

function camelize(name: string): string {
  return name.split("_").filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
}

function symbolValue(node: Node | null | undefined): string | undefined {
  const kind = kindName(node);
  if (kind === "SymbolNode") return (node as Prism.SymbolNode).unescaped?.value;
  if (kind === "StringNode") return (node as Prism.StringNode).unescaped?.value;
  return undefined;
}

function argumentsOf(call: Prism.CallNode): Node[] {
  return call.arguments_?.arguments_ ?? [];
}

function firstBlockBody(call: Prism.CallNode): Node | null {
  const block = call.block;
  if (!block) return null;
  if (kindName(block) === "BlockNode") return (block as Prism.BlockNode).body;
  return null;
}

function lastExpression(body: Node | null): Node | null {
  if (!body) return null;
  const kind = kindName(body);
  if (kind === "StatementsNode") {
    const statements = (body as Prism.StatementsNode).body;
    return lastExpression(statements[statements.length - 1] ?? null);
  }
  if (kind === "BeginNode") return lastExpression((body as Prism.BeginNode).statements);
  if (kind === "ParenthesesNode") return lastExpression((body as Prism.ParenthesesNode).body);
  return body;
}

function blockParameterNames(call: Prism.CallNode): string[] {
  const block = call.block;
  if (!block || kindName(block) !== "BlockNode") return [];
  const parameters = (block as Prism.BlockNode).parameters;
  if (!parameters || kindName(parameters) !== "BlockParametersNode") return [];
  const inner = (parameters as Prism.BlockParametersNode).parameters;
  if (!inner) return [];
  return inner.requireds.flatMap((node) => {
    const name = (node as { name?: string | null }).name;
    return typeof name === "string" ? [name] : [];
  });
}

interface ChainInfo {
  root: string;
  steps: Array<{ name: string; args: boolean }>;
}

function chainOf(node: Node | null | undefined): ChainInfo | undefined {
  const steps: ChainInfo["steps"] = [];
  let current: Node | null | undefined = node;
  while (current && kindName(current) === "CallNode") {
    const call = current as Prism.CallNode;
    steps.unshift({ name: call.name, args: Boolean(call.arguments_) || Boolean(call.block) });
    current = call.receiver;
  }
  const root = constantPathText(current);
  if (!root || root === "self" || root === "T" || root.startsWith("T::") || root.startsWith("::T::")) return undefined;
  return { root: root.replace(/^::/, ""), steps };
}

function chainText(chain: ChainInfo): string {
  return `${chain.root}${chain.steps.map((step) => `.${step.name}${step.args ? "(...)" : ""}`).join("")}`;
}

function collapsedReceiver(node: Node, bytes: Buffer): string {
  const chain = chainOf(node);
  if (chain) return chainText(chain);
  const kind = kindName(node);
  if (kind === "LocalVariableReadNode") return (node as Prism.LocalVariableReadNode).name;
  if (kind === "InstanceVariableReadNode") return (node as Prism.InstanceVariableReadNode).name;
  if (kind === "CallNode") {
    const call = node as Prism.CallNode;
    const receiver = call.receiver ? collapsedReceiver(call.receiver, bytes) : "";
    const suffix = call.arguments_ || call.block ? "(...)" : "";
    return receiver ? `${receiver}.${call.name}${suffix}` : `${call.name}${suffix}`;
  }
  return sliceSource(bytes, node.location).replace(/\s+/g, " ").slice(0, 40);
}

type TypeLookup = (name: string) => LocalType | undefined;

function inferExpressionType(value: Node | null | undefined, local: TypeLookup, ivar: TypeLookup): LocalType | undefined {
  if (!value) return undefined;
  const kind = kindName(value);
  if (kind === "LocalVariableReadNode") {
    const name = (value as Prism.LocalVariableReadNode).name;
    return local(name) ?? { type: camelize(name), via: "named" };
  }
  if (kind === "InstanceVariableReadNode") return ivar((value as Prism.InstanceVariableReadNode).name);
  if (kind === "ConstantReadNode" || kind === "ConstantPathNode") {
    const constant = constantPathText(value);
    return constant ? { type: constant.replace(/^::/, ""), via: "assigned" } : undefined;
  }
  if (kind === "ParenthesesNode") return inferExpressionType(lastExpression(value), local, ivar);
  if (kind !== "CallNode") return undefined;
  const call = value as Prism.CallNode;
  const blockValue = () => (PASSTHROUGH_BLOCK.has(call.name) && firstBlockBody(call) ? inferExpressionType(lastExpression(firstBlockBody(call)), local, ivar) : undefined);
  if (!call.receiver) return blockValue();
  const receiverConstant = constantPathText(call.receiver);
  if (receiverConstant === "self") return call.name === "new" ? undefined : blockValue();
  if (receiverConstant && !/^(::)?T(::|$)/.test(receiverConstant)) {
    const root = receiverConstant.replace(/^::/, "");
    if (constructorLike(call.name)) return { type: root, via: "assigned" };
    const passthrough = blockValue();
    if (passthrough) return passthrough;
    if (SCALAR_METHODS.has(call.name) || DYNAMIC_DISPATCH.has(call.name) || DYNAMIC_CONSTANT.has(call.name) || /[?!]$/.test(call.name)) return undefined;
    return { type: root, via: "assigned", collection: "relation", chain: [call.name] };
  }
  const receiverType = inferExpressionType(call.receiver, local, ivar);
  if (!receiverType) return blockValue();
  if (receiverType.collection) {
    const element: LocalType = { type: receiverType.type, via: receiverType.via, chain: receiverType.chain };
    if (MAP_METHODS.has(call.name)) {
      const body = firstBlockBody(call);
      if (!body) return undefined;
      const params = blockParameterNames(call);
      const scoped: TypeLookup = (name) => (params[0] === name ? element : local(name));
      const mapped = inferExpressionType(lastExpression(body), scoped, ivar);
      return mapped && !mapped.collection ? { ...mapped, collection: "array" } : undefined;
    }
    if (ELEMENT_METHODS.has(call.name) && !(call.name === "take" || ((call.name === "first" || call.name === "last") && argumentsOf(call).length))) return element;
    if (SCALAR_METHODS.has(call.name) || DYNAMIC_DISPATCH.has(call.name)) return undefined;
    if (receiverType.collection === "relation" && (RELATION_METHODS.has(call.name) || (!FILTER_METHODS.has(call.name) && !/[?!]$/.test(call.name)))) {
      return { ...receiverType, chain: [...(receiverType.chain ?? []), call.name] };
    }
    if (FILTER_METHODS.has(call.name)) return { ...receiverType, collection: "array" };
    return undefined;
  }
  if (IDENTITY_METHODS.has(call.name)) return { ...receiverType };
  return blockValue();
}

class Parser {
  readonly definitions: AdapterDefinition[] = [];
  readonly namespaces: NamespaceInfo[] = [];
  readonly ivars = new Map<string, IvarInfo[]>();
  readonly defNodes = new Map<number, Node>();
  readonly localTypes = new Map<number, Map<string, LocalType>>();
  private readonly stack: NamespaceInfo[] = [];
  private singletonDepth = 0;
  private pendingSig: ParamInfo[] | undefined;
  private pendingReturns: string | undefined;
  private readonly comments: Array<{ line: number; text: string }>;

  constructor(private readonly bytes: Buffer, private readonly lineStarts: Uint32Array, comments: ParseResult["comments"]) {
    this.comments = comments.map((comment) => ({ line: lineAt(lineStarts, comment.location.startOffset), text: sliceSource(bytes, comment.location) }));
  }

  private range(node: Node): [number, number] {
    const start = lineAt(this.lineStarts, node.location.startOffset);
    const end = lineAt(this.lineStarts, Math.max(node.location.startOffset, node.location.startOffset + node.location.length - 1));
    return [start, end];
  }

  private owner(): string | undefined {
    return this.stack.length ? this.stack[this.stack.length - 1]!.symbol : undefined;
  }

  private qualify(name: string): string {
    if (name.startsWith("::")) return name.slice(2);
    const owner = this.owner();
    return owner ? `${owner}::${name}` : name;
  }

  visitProgram(program: Prism.ProgramNode): void {
    this.visitBody(program.statements, false);
  }

  private visitBody(node: Node | null, inClassBody: boolean): void {
    if (!node) return;
    const kind = kindName(node);
    if (kind === "StatementsNode") {
      for (const child of (node as Prism.StatementsNode).body) this.visitStatement(child, inClassBody);
      return;
    }
    if (kind === "BeginNode") {
      const begin = node as Prism.BeginNode;
      this.visitBody(begin.statements, inClassBody);
      return;
    }
    this.visitStatement(node, inClassBody);
  }

  private visitStatement(node: Node, inClassBody: boolean): void {
    const kind = kindName(node);
    switch (kind) {
      case "ClassNode":
        return this.visitClass(node as Prism.ClassNode);
      case "ModuleNode":
        return this.visitModule(node as Prism.ModuleNode);
      case "SingletonClassNode": {
        const singleton = node as Prism.SingletonClassNode;
        if (kindName(singleton.expression) === "SelfNode") {
          this.singletonDepth += 1;
          this.visitBody(singleton.body, true);
          this.singletonDepth -= 1;
        }
        return;
      }
      case "DefNode":
        return this.visitDef(node as Prism.DefNode);
      case "ConstantWriteNode": {
        const write = node as Prism.ConstantWriteNode;
        const [startLine, endLine] = this.range(node);
        this.definitions.push({ name: write.name, symbol: this.qualify(write.name), kind: "constant", startLine, endLine, owner: this.owner() });
        this.pendingSig = undefined;
        return;
      }
      case "CallNode":
        return this.visitClassLevelCall(node as Prism.CallNode, inClassBody);
      default:
        return;
    }
  }

  private visitClass(node: Prism.ClassNode): void {
    const name = constantPathText(node.constantPath) ?? node.name;
    const [startLine, endLine] = this.range(node);
    const info: NamespaceInfo = { name, symbol: this.qualify(name), kind: "class", startLine, endLine, superclass: constantPathText(node.superclass), mixins: [] };
    this.namespaces.push(info);
    this.definitions.push({ name, symbol: info.symbol, kind: "class", startLine, endLine, owner: this.owner() });
    this.stack.push(info);
    this.pendingSig = undefined;
    this.visitBody(node.body, true);
    this.stack.pop();
  }

  private visitModule(node: Prism.ModuleNode): void {
    const name = constantPathText(node.constantPath) ?? node.name;
    const [startLine, endLine] = this.range(node);
    const info: NamespaceInfo = { name, symbol: this.qualify(name), kind: "module", startLine, endLine, mixins: [] };
    this.namespaces.push(info);
    this.definitions.push({ name, symbol: info.symbol, kind: "module", startLine, endLine, owner: this.owner() });
    this.stack.push(info);
    this.pendingSig = undefined;
    this.visitBody(node.body, true);
    this.stack.pop();
  }

  private paramInfos(parameters: Prism.ParametersNode | null): ParamInfo[] {
    if (!parameters) return [];
    const names: string[] = [];
    const push = (node: Node | null | undefined) => {
      if (!node) return;
      const name = (node as { name?: string | null }).name;
      if (typeof name === "string") names.push(name);
    };
    parameters.requireds.forEach(push);
    parameters.optionals.forEach(push);
    push(parameters.rest);
    parameters.posts.forEach(push);
    parameters.keywords.forEach(push);
    push(parameters.keywordRest);
    push(parameters.block);
    return names.map((name) => ({ name }));
  }

  private annotationsFor(defLine: number, params: ParamInfo[]): { params: ParamInfo[]; returns?: string } {
    const byName = new Map(params.map((param) => [param.name, param]));
    let returns = this.pendingReturns;
    if (this.pendingSig) {
      for (const param of this.pendingSig) {
        const target = byName.get(param.name);
        if (!target || !param.type) continue;
        target.type = param.type;
        if (param.collection) target.collection = param.collection;
      }
    }
    const preceding = this.comments.filter((comment) => comment.line < defLine && comment.line >= defLine - 12);
    const annotate = (param: ParamInfo | undefined, info: TypeInfo | undefined) => {
      if (!param || !info || param.type) return;
      param.type = info.type;
      if (info.collection) param.collection = info.collection;
    };
    for (const comment of preceding) {
      const rbs = comment.text.match(/^#:\s*\((.*?)\)\s*->\s*(.+)$/);
      if (rbs) {
        const types = rbs[1]!.split(",").map((part) => part.trim()).filter(Boolean);
        params.forEach((param, index) => annotate(param, normalizeTypeInfo(types[index]?.replace(/^\??/, "").replace(/^[a-z_]\w*:\s*/, ""))));
        returns ??= normalizeType(rbs[2]);
      }
      const yard = comment.text.match(/^#\s*@param\s+(?:\[([^\]]+)\]\s+)?(\w+)(?:\s+\[([^\]]+)\])?/);
      if (yard) annotate(byName.get(yard[2]!), normalizeTypeInfo(yard[1] ?? yard[3]));
      const yardReturn = comment.text.match(/^#\s*@return\s+\[([^\]]+)\]/);
      if (yardReturn) returns ??= normalizeType(yardReturn[1]);
    }
    return { params, returns };
  }

  private visitDef(node: Prism.DefNode): void {
    const [startLine, endLine] = this.range(node);
    const singleton = this.singletonDepth > 0 || node.receiver !== null;
    const owner = this.owner();
    const separator = singleton ? "." : "#";
    const params = this.paramInfos(node.parameters);
    const annotated = this.annotationsFor(startLine, params);
    const definition: AdapterDefinition = {
      name: node.name,
      symbol: owner ? `${owner}${separator}${node.name}` : node.name,
      kind: singleton ? "singleton_method" : "method",
      startLine,
      endLine,
      owner,
      singleton,
      params: annotated.params,
      returns: annotated.returns,
    };
    this.definitions.push(definition);
    this.defNodes.set(startLine, node);
    this.pendingSig = undefined;
    this.pendingReturns = undefined;
    if (node.name === "initialize" && owner) this.collectIvars(node, owner, annotated.params);
    this.localTypes.set(startLine, this.paramTypes(annotated.params));
  }

  private paramTypes(params: ParamInfo[]): Map<string, LocalType> {
    const types = new Map<string, LocalType>();
    for (const param of params) {
      if (param.type) types.set(param.name, { type: param.type, via: "typed", collection: param.collection });
      else types.set(param.name, { type: camelize(param.name), via: "named" });
    }
    return types;
  }

  private ivarLookup(owner: string | undefined): TypeLookup {
    return (name) => {
      const info = owner ? this.ivars.get(owner)?.find((entry) => entry.name === name && entry.type) : undefined;
      return info?.type ? { type: info.type, via: info.via ?? "assigned", collection: info.collection } : undefined;
    };
  }

  private collectIvars(def: Prism.DefNode, owner: string, params: ParamInfo[]): void {
    const types = this.paramTypes(params);
    const entries = this.ivars.get(owner) ?? [];
    const lookup: TypeLookup = (name) => types.get(name);
    const visit = (node: Node | null) => {
      if (!node) return;
      if (kindName(node) === "InstanceVariableWriteNode") {
        const write = node as Prism.InstanceVariableWriteNode;
        const inferred = inferExpressionType(write.value, lookup, this.ivarLookup(owner));
        entries.push({ name: write.name, type: inferred?.type, via: inferred?.via, collection: inferred?.collection, line: lineAt(this.lineStarts, node.location.startOffset) });
      }
      for (const child of node.compactChildNodes()) visit(child);
    };
    visit(def.body);
    this.ivars.set(owner, entries);
  }

  private visitClassLevelCall(call: Prism.CallNode, inClassBody: boolean): void {
    if (call.receiver && kindName(call.receiver) !== "SelfNode") {
      if (call.name === "sig") this.captureSig(call);
      return;
    }
    const name = call.name;
    const [startLine, endLine] = this.range(call);
    const owner = this.owner();

    if (name === "sig") {
      this.captureSig(call);
      return;
    }
    if (TEST_BLOCKS.has(name) && call.block) {
      const label = symbolValue(argumentsOf(call)[0]) ?? name;
      const symbol = `${owner ? `${owner} ` : ""}${name} "${label}"`;
      this.definitions.push({ name: label, symbol, kind: "test", startLine, endLine, owner });
      this.defNodes.set(startLine, call);
      this.visitBody(firstBlockBody(call), false);
      return;
    }
    if (MIXIN_CALLS.has(name) && inClassBody) {
      const current = this.stack[this.stack.length - 1];
      for (const argument of argumentsOf(call)) {
        const constant = constantPathText(argument);
        if (constant && current) current.mixins.push(constant.replace(/^::/, ""));
      }
      this.definitions.push({ name, symbol: `${owner ?? ""} ${name} ${argumentsOf(call).map((argument) => constantPathText(argument) ?? "").join(", ")}`.trim(), kind: "declaration", startLine, endLine, owner });
      return;
    }
    if (name === "private" || name === "public" || name === "protected" || name === "module_function" || name === "private_constant") {
      const inner = argumentsOf(call).find((argument) => kindName(argument) === "DefNode");
      if (inner) this.visitDef(inner as Prism.DefNode);
      return;
    }
    if (inClassBody && (argumentsOf(call).length > 0 || call.block)) {
      const declared = argumentsOf(call).map(symbolValue).filter((value): value is string => Boolean(value));
      const kind = DECLARATION_CALLS.has(name) || declared.length ? name : "declaration";
      if (declared.length) {
        for (const value of declared) {
          const label = `${name} :${value}`;
          this.definitions.push({ name: value, symbol: owner ? `${owner} ${label}` : label, kind, startLine, endLine, owner });
        }
      } else {
        this.definitions.push({ name, symbol: owner ? `${owner} ${name}` : name, kind, startLine, endLine, owner });
      }
      if (name === "scope") this.defNodes.set(startLine, call);
      const body = firstBlockBody(call);
      if (body && name !== "scope") this.visitBody(body, false);
      return;
    }
    if (!inClassBody && call.block && TEST_BLOCKS.has(name)) return;
  }

  private captureSig(call: Prism.CallNode): void {
    const body = firstBlockBody(call);
    const params: ParamInfo[] = [];
    let returns: string | undefined;
    const visit = (node: Node | null) => {
      if (!node) return;
      if (kindName(node) === "CallNode") {
        const inner = node as Prism.CallNode;
        if (inner.name === "params") {
          for (const argument of argumentsOf(inner)) {
            if (kindName(argument) !== "KeywordHashNode") continue;
            for (const element of (argument as Prism.KeywordHashNode).elements) {
              if (kindName(element) !== "AssocNode") continue;
              const assoc = element as Prism.AssocNode;
              const key = symbolValue(assoc.key);
              if (!key) continue;
              const info = normalizeTypeInfo(sliceSource(this.bytes, assoc.value.location));
              params.push({ name: key, type: info?.type, collection: info?.collection });
            }
          }
        }
        if (inner.name === "returns") returns = normalizeType(sliceSource(this.bytes, argumentsOf(inner)[0]?.location));
      }
      for (const child of node.compactChildNodes()) visit(child);
    };
    visit(body);
    this.pendingSig = params;
    this.pendingReturns = returns;
  }
}

class CallCollector {
  readonly sites: CallSite[] = [];
  private readonly seen = new Set<string>();
  private readonly consumedReceivers = new Set<Node>();
  private readonly localLookup: TypeLookup;
  private readonly ivarLookup: TypeLookup;

  constructor(
    private readonly facts: RubyFacts,
    private readonly def: Definition,
    private readonly owner: string | undefined,
    private readonly locals: Map<string, LocalType>,
    private readonly ivars: Map<string, IvarInfo>,
  ) {
    this.localLookup = (name) => this.locals.get(name);
    this.ivarLookup = (name) => {
      const info = this.ivars.get(name);
      return info?.type ? { type: info.type, via: info.via ?? "assigned", collection: info.collection } : undefined;
    };
  }

  private push(site: CallSite): void {
    const key = `${site.source}:${site.receiver ?? ""}:${site.name}:${site.line}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.sites.push(site);
  }

  private line(node: Node): number {
    return lineAt(this.facts.lineStarts, node.location.startOffset);
  }

  visit(node: Node | null): void {
    if (!node || this.consumedReceivers.has(node)) return;
    const kind = kindName(node);
    if (["IfNode", "UnlessNode", "CaseNode", "CaseMatchNode", "WhileNode", "UntilNode", "RescueNode"].includes(kind)) {
      const saved = new Map(this.locals);
      const changed = new Set<string>();
      for (const child of node.compactChildNodes()) {
        this.locals.clear();
        for (const [name, value] of saved) this.locals.set(name, value);
        this.visit(child);
        for (const [name, value] of this.locals) if (value !== saved.get(name)) changed.add(name);
      }
      this.locals.clear();
      for (const [name, value] of saved) this.locals.set(name, value);
      for (const name of changed) this.locals.set(name, { type: camelize(name), via: "named" });
      return;
    }
    if (kind === "LocalVariableWriteNode") {
      const write = node as Prism.LocalVariableWriteNode;
      this.visit(write.value);
      this.locals.set(write.name, inferExpressionType(write.value, this.localLookup, this.ivarLookup) ?? { type: camelize(write.name), via: "named" });
      return;
    }
    if (kind === "CallNode") {
      const call = node as Prism.CallNode;
      if (call.name === "sig" && call.block) return;
      if (kindName(call.receiver) === "CallNode") this.visit(call.receiver);
      this.visitCall(call);
      for (const child of call.compactChildNodes()) {
        if (child === call.block || child === call.receiver && kindName(child) === "CallNode") continue;
        this.visit(child);
      }
      if (kindName(call.block) === "BlockNode") {
        const saved = new Map(this.locals);
        const params = blockParameterNames(call);
        const collection = call.receiver && BLOCK_ITERATORS.has(call.name) ? inferExpressionType(call.receiver, this.localLookup, this.ivarLookup) : undefined;
        for (const name of params) this.locals.set(name, { type: camelize(name), via: "named" });
        if (params[0] && collection?.collection) this.locals.set(params[0], { type: collection.type, via: collection.via, chain: collection.chain });
        this.visit(firstBlockBody(call));
        const changed = [...this.locals].filter(([name, value]) => saved.has(name) && !params.includes(name) && value !== saved.get(name)).map(([name]) => name);
        this.locals.clear();
        for (const [name, value] of saved) this.locals.set(name, value);
        for (const name of changed) this.locals.set(name, { type: camelize(name), via: "named" });
      } else this.visit(call.block);
      return;
    }
    if (kind === "ConstantReadNode" || kind === "ConstantPathNode") {
      if (!this.consumedReceivers.has(node)) {
        const constant = constantPathText(node);
        if (constant && constant !== "self" && !/^(T|T::.*)$/.test(constant)) {
          this.push({ name: constant.replace(/^::/, ""), line: this.line(node), relationship: "references", source: "constant" });
        }
      }
      return;
    }
    if (kind === "SuperNode" || kind === "ForwardingSuperNode") {
      this.push({ name: "super", line: this.line(node), relationship: "calls", source: "super", receiverKind: "other", receiverType: this.superclass() });
    }
    for (const child of node.compactChildNodes()) this.visit(child);
  }

  private superclass(): string | undefined {
    const namespace = this.facts.namespaces.find((item) => item.symbol === this.owner);
    return namespace?.superclass;
  }

  private receiverKindOf(receiver: Node): NonNullable<CallSite["receiverKind"]> {
    const kind = kindName(receiver);
    if (kind === "SelfNode") return "self";
    if (kind === "ConstantReadNode" || kind === "ConstantPathNode") return "constant";
    if (kind === "LocalVariableReadNode") return "local";
    if (kind === "InstanceVariableReadNode") return "ivar";
    if (kind === "CallNode") return "chain";
    return "other";
  }

  private literalMethodName(call: Prism.CallNode): string | undefined {
    const first = argumentsOf(call)[0];
    return first ? symbolValue(first) : undefined;
  }

  private visitSymbolProc(call: Prism.CallNode, line: number): void {
    const block = call.block;
    if (!block || kindName(block) !== "BlockArgumentNode") return;
    const expression = (block as Prism.BlockArgumentNode).expression;
    const receiver = call.receiver;
    const receiverText = receiver ? collapsedReceiver(receiver, this.facts.bytes) : "";
    const prefix = `${receiverText ? `${receiverText}.` : ""}${call.name}`;
    if (expression && kindName(expression) === "SymbolNode") {
      const method = symbolValue(expression)!;
      const collection = receiver && BLOCK_ITERATORS.has(call.name) ? inferExpressionType(receiver, this.localLookup, this.ivarLookup) : undefined;
      const element = collection?.collection ? collection : undefined;
      this.push({
        name: method, line, relationship: "calls", source: "symbol_proc", receiver: receiverText || undefined,
        receiverKind: "local", receiverType: element?.type, via: element?.via,
        chain: element?.chain, label: `${prefix}(&:${method})`,
      });
      return;
    }
    if (expression && kindName(expression) === "CallNode") {
      const methodCall = expression as Prism.CallNode;
      const name = symbolValue(argumentsOf(methodCall)[0]);
      if (methodCall.name === "method" && name) {
        const typed = methodCall.receiver ? this.typedReceiver(methodCall.receiver) : { receiverKind: "implicit" as const, receiverType: this.owner };
        this.push({ name, line, relationship: "calls", source: "bare", ...typed, label: `${prefix}(&${collapsedReceiver(expression, this.facts.bytes).replace("(...)", `(:${name})`)})` });
        this.consumedReceivers.add(expression);
        return;
      }
    }
    this.push({ name: call.name, line, relationship: "calls", source: "dynamic", label: `${prefix}(&${expression ? collapsedReceiver(expression, this.facts.bytes) : "..."})`, dynamic: "block argument is a runtime callback; its invoked method is not traced" });
  }

  private visitCall(call: Prism.CallNode): void {
    const line = this.line(call);
    const receiver = call.receiver;
    const name = call.name;
    this.visitSymbolProc(call, line);
    if (DYNAMIC_DISPATCH.has(name)) {
      const literal = this.literalMethodName(call);
      const receiverText = receiver ? collapsedReceiver(receiver, this.facts.bytes) : undefined;
      const label = `${receiverText ? `${receiverText}.` : ""}${name}(${literal ? `:${literal}` : "..."})`;
      if (!literal) {
        this.push({ name, line, relationship: "calls", source: "dynamic", receiver: receiverText, receiverKind: receiver ? this.receiverKindOf(receiver) : "implicit", label, dynamic: `${name} with a runtime method name; the callee is not traced statically` });
        return;
      }
      const typed = receiver ? this.typedReceiver(receiver) : { receiverKind: "implicit" as const, receiverType: this.owner };
      this.push({ name: literal, line, relationship: "calls", source: receiver ? "receiver_method" : "bare", receiver: receiverText, ...typed, label, dynamic: `${name}(:${literal}) dispatches by name at runtime` });
      return;
    }
    if (DYNAMIC_CONSTANT.has(name)) {
      const receiverText = receiver ? collapsedReceiver(receiver, this.facts.bytes) : undefined;
      this.push({ name, line, relationship: "references", source: "dynamic", receiver: receiverText, receiverKind: receiver ? this.receiverKindOf(receiver) : "implicit", label: `${receiverText ? `${receiverText}.` : ""}${name}(...)`, dynamic: `${name} resolves a constant from a runtime value; the class is not traced statically` });
      return;
    }
    if (!receiver) {
      this.push({ name, line, relationship: "calls", source: "bare", receiverKind: "implicit", receiverType: this.owner });
      return;
    }
    const receiverKind = kindName(receiver);
    if (receiverKind === "SelfNode") {
      this.push({ name, line, relationship: "calls", source: "receiver_method", receiver: "self", receiverKind: "self", receiverType: this.owner });
      return;
    }
    if (receiverKind === "ConstantReadNode" || receiverKind === "ConstantPathNode") {
      this.consumedReceivers.add(receiver);
      const constant = (constantPathText(receiver) ?? "").replace(/^::/, "");
      if (constant === "T" || constant.startsWith("T::")) return;
      this.push({ name: constant, line, relationship: "references", source: "constant" });
      this.push({ name, line, relationship: "calls", source: "constant_method", receiver: constant, receiverKind: "constant", receiverType: constant });
      return;
    }
    const receiverText = collapsedReceiver(receiver, this.facts.bytes);
    const typed = this.typedReceiver(receiver);
    const source = typed.receiverKind === "chain" && typed.via === "chain" && chainOf(receiver) ? "constant_method" : "receiver_method";
    this.push({ name, line, relationship: "calls", source, receiver: receiverText, ...typed });
  }

  private typedReceiver(receiver: Node): Pick<CallSite, "receiverKind" | "receiverType" | "via" | "chain"> {
    const receiverKind = this.receiverKindOf(receiver);
    const inferred = inferExpressionType(receiver, this.localLookup, this.ivarLookup);
    if (receiverKind === "ivar" && !inferred) {
      const ivar = (receiver as Prism.InstanceVariableReadNode).name;
      return { receiverKind, receiverType: camelize(ivar.replace(/^@/, "")), via: "named" };
    }
    if (!inferred) return { receiverKind };
    if (inferred.collection === "relation") return { receiverKind, receiverType: inferred.type, via: "chain", chain: inferred.chain ?? [] };
    if (inferred.collection === "array") return { receiverKind };
    return { receiverKind, receiverType: inferred.type, via: inferred.via };
  }
}

export class RubyAdapter implements LanguageAdapter {
  readonly language = "ruby" as const;
  private readonly cache = new Map<string, RubyFacts>();

  ready(): Promise<boolean> {
    return loadParser();
  }

  parse(path: string, source: string): FileFacts | undefined {
    if (!parseFn) return undefined;
    const cached = this.cache.get(path);
    if (cached && cached.bytes.equals(Buffer.from(source, "utf8"))) return cached;
    let result: ParseResult;
    try {
      result = parseFn(source, { filepath: path });
    } catch {
      return undefined;
    }
    const bytes = Buffer.from(source, "utf8");
    const lineStarts = lineStartsOf(bytes);
    const parser = new Parser(bytes, lineStarts, result.comments);
    parser.visitProgram(result.value);
    const facts: RubyFacts = {
      path,
      language: "ruby",
      definitions: parser.definitions.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine),
      namespaces: parser.namespaces,
      ivars: parser.ivars,
      errors: result.errors.length,
      program: result.value,
      lineStarts,
      bytes,
      defNodes: parser.defNodes,
      localTypes: parser.localTypes,
    };
    this.cache.set(path, facts);
    return facts;
  }

  definitionAt(facts: FileFacts, line: number): AdapterDefinition | undefined {
    const containing = facts.definitions.filter((def) => def.startLine <= line && line <= def.endLine);
    if (!containing.length) return undefined;
    const leaves = containing.filter((def) => def.kind !== "class" && def.kind !== "module");
    const pool = leaves.length ? leaves : containing;
    return pool.reduce((best, def) => (def.startLine >= best.startLine ? def : best));
  }

  calls(facts: FileFacts, def: Definition): CallSite[] {
    const ruby = facts as RubyFacts;
    const node = ruby.defNodes.get(def.startLine);
    if (!node) return [];
    const owner = (facts.definitions.find((item) => item.startLine === def.startLine && item.symbol === def.symbol) as AdapterDefinition | undefined)?.owner;
    const ivars = new Map<string, IvarInfo>();
    for (const info of owner ? ruby.ivars.get(owner) ?? [] : []) if (!ivars.has(info.name) || info.type) ivars.set(info.name, info);
    const locals = new Map(ruby.localTypes.get(def.startLine));
    const collector = new CallCollector(ruby, def, owner, locals, ivars);
    const call = kindName(node) === "CallNode" ? node as Prism.CallNode : undefined;
    const lambda = call ? argumentsOf(call).find((argument) => kindName(argument) === "LambdaNode") as Prism.LambdaNode | undefined : undefined;
    const body = kindName(node) === "DefNode" ? (node as Prism.DefNode).body : lambda?.body ?? (call ? firstBlockBody(call) : null);
    if (!body && def.kind === "scope") return [{ name: def.name, line: def.startLine, source: "dynamic", relationship: "calls", label: def.symbol, dynamic: "scope body is not a literal lambda or block; its calls cannot be enumerated" }];
    collector.visit(body);
    return collector.sites;
  }
}

export const rubyAdapter = new RubyAdapter();

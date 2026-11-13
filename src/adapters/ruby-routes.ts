import type * as Prism from "@ruby/prism";
import { argumentsOf, firstBlockBody, kindName, lineAt, parseProgram, sliceSource, symbolValue } from "./ruby.ts";

type Node = Prism.Node;

/** One controller action that `config/routes.rb` draws. */
export interface Route {
  /** HTTP verbs in capitals; `match` lists its `via:` verbs and `update` routes both `PATCH` and `PUT`. */
  verbs: string[];
  /** The URL pattern, without Rails's optional `(.:format)`. */
  path: string;
  /** The controller as routes name it: `admin/orders` for `Admin::OrdersController`. */
  controller: string;
  action: string;
  /** The URL helper's name without `_path` or `_url`, when the route has one. */
  helper?: string;
  line: number;
}

export interface RouteTable {
  routes: Route[];
  /** Statements the reader does not interpret, as written; the routes they draw are not in `routes`. */
  unread: Array<{ line: number; text: string }>;
}

/** The resource a block of routes is nested in, as its member, collection and nested routes need it. */
interface Resource {
  /** The helper name of the collection: `orders`, or `profile` for a singular resource. */
  collectionName: string;
  /** The helper name of one member: `order` or `profile`. */
  memberName: string;
  controller: string;
  collectionPath: string;
  memberPath: string;
  nestedPath: string;
  /** Helper name parts before the resource's own name: namespaces and parent resources. */
  as: string[];
}

interface Scope {
  module: string[];
  path: string;
  as: string[];
  controller?: string;
  resource?: Resource;
  on?: "member" | "collection";
}

interface Arguments {
  positional: Node[];
  options: Map<string, Node>;
  /** `"path" => "controller#action"` and `mount App => "/path"`. */
  mapping?: { key: Node; value: Node };
}

interface Source {
  bytes: Buffer;
  lineStarts: Uint32Array;
}

const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const VERB_CALLS = new Set(["get", "post", "put", "patch", "delete", "match"]);
// Blocks whose routes read like their surroundings.
const TRANSPARENT_CALLS = new Set(["constraints", "defaults"]);
// Calls that route something other than a controller action.
const NO_ACTION_CALLS = new Set(["mount"]);
const PLURAL_ACTIONS = ["index", "create", "new", "edit", "show", "update", "destroy"];
const SINGULAR_ACTIONS = ["create", "new", "edit", "show", "update", "destroy"];
const UNREAD_TEXT_LIMIT = 120;

function singularize(word: string): string {
  if (/[^aeiouy]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:x|ch|ss|sh|alias|status)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

function pluralize(word: string): string {
  if (/[^aeiouy]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:x|ch|ss|sh|s)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

const helperName = (parts: string[]): string => parts.filter(Boolean).join("_");

function joinPath(prefix: string, segment: string): string {
  const joined = `${prefix}/${segment.replace(/^\/+/, "")}`.replace(/\/+$/, "");
  return joined || "/";
}

/** A controller inside `module`; a leading slash names it from the top. */
function qualify(module: string[], controller: string): string {
  return controller.startsWith("/") ? controller.slice(1) : [...module, controller].join("/");
}

function textOf(node: Node | undefined): string | undefined {
  return node ? symbolValue(node) : undefined;
}

function listOf(node: Node | undefined): string[] | undefined {
  if (!node) return undefined;
  if (kindName(node) === "ArrayNode") return (node as Prism.ArrayNode).elements.flatMap((element) => textOf(element) ?? []);
  const value = textOf(node);
  return value === undefined ? undefined : [value];
}

function readArguments(call: Prism.CallNode): Arguments {
  const result: Arguments = { positional: [], options: new Map() };
  for (const argument of argumentsOf(call)) {
    const kind = kindName(argument);
    if (kind !== "KeywordHashNode" && kind !== "HashNode") {
      result.positional.push(argument);
      continue;
    }
    for (const element of (argument as Prism.KeywordHashNode | Prism.HashNode).elements) {
      if (kindName(element) !== "AssocNode") continue;
      const assoc = element as Prism.AssocNode;
      if (kindName(assoc.key) === "SymbolNode") result.options.set(symbolValue(assoc.key)!, assoc.value);
      else result.mapping ??= { key: assoc.key, value: assoc.value };
    }
  }
  return result;
}

function statementsOf(body: Node | null): Node[] {
  if (!body) return [];
  const kind = kindName(body);
  if (kind === "StatementsNode") return (body as Prism.StatementsNode).body;
  if (kind === "BeginNode") return statementsOf((body as Prism.BeginNode).statements);
  return [body];
}

class RouteReader {
  readonly table: RouteTable = { routes: [], unread: [] };

  constructor(private readonly source: Source) {}

  private line(node: Node): number {
    return lineAt(this.source.lineStarts, node.location.startOffset);
  }

  private unread(node: Node): void {
    const text = sliceSource(this.source.bytes, node.location).split("\n")[0]!.trim();
    this.table.unread.push({ line: this.line(node), text: text.length > UNREAD_TEXT_LIMIT ? `${text.slice(0, UNREAD_TEXT_LIMIT)}…` : text });
  }

  private push(route: Omit<Route, "helper"> & { helper?: string }): void {
    this.table.routes.push(route.helper ? route : { verbs: route.verbs, path: route.path, controller: route.controller, action: route.action, line: route.line });
  }

  readProgram(program: Prism.ProgramNode): void {
    const statements = statementsOf(program.statements);
    const draw = statements.find((node) => kindName(node) === "CallNode" && (node as Prism.CallNode).name === "draw" && (node as Prism.CallNode).block);
    if (!draw) {
      for (const statement of statements) this.unread(statement);
      return;
    }
    this.walk(firstBlockBody(draw as Prism.CallNode), { module: [], path: "", as: [] });
  }

  private walk(body: Node | null, scope: Scope): void {
    for (const statement of statementsOf(body)) {
      const call = kindName(statement) === "CallNode" ? statement as Prism.CallNode : undefined;
      if (!call || call.receiver || !this.read(call, scope)) this.unread(statement);
    }
  }

  /** Reads one routing call; false when the reader does not interpret it. */
  private read(call: Prism.CallNode, scope: Scope): boolean {
    const name = call.name;
    if (name === "root") return this.root(call, scope);
    if (VERB_CALLS.has(name)) return this.verb(call, scope);
    if (name === "resources" || name === "resource") return this.resources(call, scope, name === "resources");
    if (name === "namespace") return this.namespace(call, scope);
    if (name === "scope") return this.scope(call, scope);
    if (name === "controller") {
      const controller = textOf(readArguments(call).positional[0]);
      if (!controller) return false;
      this.walk(firstBlockBody(call), { ...scope, controller: qualify(scope.module, controller) });
      return true;
    }
    if ((name === "member" || name === "collection") && scope.resource) {
      this.walk(firstBlockBody(call), { ...scope, on: name });
      return true;
    }
    if (TRANSPARENT_CALLS.has(name)) {
      this.walk(firstBlockBody(call), scope);
      return true;
    }
    return NO_ACTION_CALLS.has(name);
  }

  /** `controller#action` from `to:`, a mapping value, or `controller:`/`action:` options. */
  private target(args: Arguments, value: Node | undefined): { controller?: string; action?: string } | "elsewhere" {
    if (value && textOf(value) === undefined) return "elsewhere";
    const to = textOf(value);
    const [controller, action] = to?.includes("#") ? to.split("#") as [string, string] : [undefined, to];
    return { controller: textOf(args.options.get("controller")) ?? controller, action: textOf(args.options.get("action")) ?? action };
  }

  private root(call: Prism.CallNode, scope: Scope): boolean {
    const args = readArguments(call);
    const target = this.target(args, args.positional[0] ?? args.options.get("to"));
    if (target === "elsewhere") return true;
    if (!target.controller || !target.action) return false;
    this.push({ verbs: ["GET"], path: scope.path || "/", controller: qualify(scope.module, target.controller), action: target.action, helper: helperName([...scope.as, "root"]), line: this.line(call) });
    return true;
  }

  private verb(call: Prism.CallNode, scope: Scope): boolean {
    const args = readArguments(call);
    const verbs = call.name === "match" ? this.via(args.options.get("via")) : [call.name.toUpperCase()];
    if (!verbs.length) return false;
    const pathNode = args.mapping?.key ?? args.positional[0];
    const pathText = textOf(pathNode);
    const target = this.target(args, args.mapping?.value ?? args.options.get("to"));
    if (target === "elsewhere") return true;
    if (pathText === undefined) return false;
    const as = textOf(args.options.get("as"));
    const line = this.line(call);
    const resource = scope.resource;

    if (resource && !pathText.replace(/^\//, "").includes("/")) {
      const segment = pathText.replace(/^\//, "");
      const own = (as ?? segment).replace(/-/g, "_");
      const on = (textOf(args.options.get("on")) as Scope["on"] | undefined) ?? scope.on;
      const controller = target.controller ? qualify(scope.module, target.controller) : resource.controller;
      const action = target.action ?? segment.replace(/-/g, "_");
      if (on === "member") this.push({ verbs, path: `${resource.memberPath}/${segment}`, controller, action, helper: helperName([own, ...resource.as, resource.memberName]), line });
      else if (on === "collection") this.push({ verbs, path: `${resource.collectionPath}/${segment}`, controller, action, helper: helperName([own, ...resource.as, resource.collectionName]), line });
      else this.push({ verbs, path: `${resource.nestedPath}/${segment}`, controller, action, helper: helperName([...resource.as, resource.memberName, own]), line });
      return true;
    }

    let controller = target.controller ? qualify(scope.module, target.controller) : undefined;
    let action = target.action;
    const segments = pathText.split("/").filter((segment) => segment && !/^[:*(]/.test(segment));
    if (!controller && !action) {
      if (scope.controller && kindName(pathNode) === "SymbolNode") [controller, action] = [scope.controller, pathText];
      else if (segments.length === 2) [controller, action] = [qualify(scope.module, segments[0]!), segments[1]!];
    } else {
      controller ??= scope.controller;
    }
    if (!controller || !action) return false;
    const derived = segments.join("_").replace(/-/g, "_");
    const helper = as ? helperName([...scope.as, as]) : derived ? helperName([...scope.as, derived]) : undefined;
    this.push({ verbs, path: joinPath(scope.path, pathText), controller, action, helper, line });
    return true;
  }

  private via(node: Node | undefined): string[] {
    const verbs = listOf(node) ?? [];
    return verbs.includes("all") ? HTTP_VERBS : verbs.map((verb) => verb.toUpperCase()).filter((verb) => HTTP_VERBS.includes(verb));
  }

  private resources(call: Prism.CallNode, scope: Scope, plural: boolean): boolean {
    const args = readArguments(call);
    const names = args.positional.flatMap((node) => textOf(node) ?? []);
    if (!names.length) return false;
    const option = (key: string) => textOf(args.options.get(key));
    // Shallow nesting and concerns change routes the reader does not draw; the plain routes are still read.
    if (args.options.has("shallow") || args.options.has("concerns")) this.unread(call);
    const defaults = plural ? PLURAL_ACTIONS : SINGULAR_ACTIONS;
    const only = listOf(args.options.get("only"));
    const except = listOf(args.options.get("except")) ?? [];
    const actions = defaults.filter((action) => (only ?? defaults).includes(action) && !except.includes(action));
    const module = option("module") ? [...scope.module, option("module")!] : scope.module;
    const parent = scope.resource;
    const line = this.line(call);

    for (const name of names) {
      const collectionName = option("as") ?? name;
      const memberName = plural ? singularize(collectionName) : collectionName;
      const collectionPath = joinPath(parent ? parent.nestedPath : scope.path, option("path") ?? name);
      const param = option("param") ?? "id";
      const resource: Resource = {
        collectionName,
        memberName,
        controller: qualify(module, option("controller") ?? (plural ? name : pluralize(name))),
        collectionPath,
        memberPath: plural ? `${collectionPath}/:${param}` : collectionPath,
        nestedPath: plural ? `${collectionPath}/:${singularize(name)}_${param}` : collectionPath,
        as: parent ? [...parent.as, parent.memberName] : scope.as,
      };
      this.walk(firstBlockBody(call), { module, path: scope.path, as: scope.as, resource });

      const one = helperName([...resource.as, memberName]);
      const draw: Record<string, Omit<Route, "controller" | "action" | "line">> = {
        index: { verbs: ["GET"], path: collectionPath, helper: helperName([...resource.as, collectionName]) },
        create: { verbs: ["POST"], path: collectionPath, helper: plural ? helperName([...resource.as, collectionName]) : one },
        new: { verbs: ["GET"], path: `${collectionPath}/new`, helper: helperName(["new", ...resource.as, memberName]) },
        edit: { verbs: ["GET"], path: `${resource.memberPath}/edit`, helper: helperName(["edit", ...resource.as, memberName]) },
        show: { verbs: ["GET"], path: resource.memberPath, helper: one },
        update: { verbs: ["PATCH", "PUT"], path: resource.memberPath, helper: one },
        destroy: { verbs: ["DELETE"], path: resource.memberPath, helper: one },
      };
      for (const action of actions) this.push({ ...draw[action]!, controller: resource.controller, action, line });
    }
    return true;
  }

  private namespace(call: Prism.CallNode, scope: Scope): boolean {
    const args = readArguments(call);
    const name = textOf(args.positional[0]);
    if (!name) return false;
    const option = (key: string) => textOf(args.options.get(key));
    this.walk(firstBlockBody(call), {
      module: [...scope.module, option("module") ?? name],
      path: joinPath(scope.path, option("path") ?? name),
      as: [...scope.as, option("as") ?? name],
    });
    return true;
  }

  private scope(call: Prism.CallNode, scope: Scope): boolean {
    const args = readArguments(call);
    const option = (key: string) => textOf(args.options.get(key));
    const path = option("path") ?? textOf(args.positional[0]);
    const controller = option("controller");
    this.walk(firstBlockBody(call), {
      ...scope,
      module: option("module") ? [...scope.module, option("module")!] : scope.module,
      path: path ? joinPath(scope.path, path) : scope.path,
      as: option("as") ? [...scope.as, option("as")!] : scope.as,
      controller: controller ? qualify(scope.module, controller) : scope.controller,
    });
    return true;
  }
}

/**
 * The controller actions a Rails `config/routes.rb` draws, read from its syntax tree: `root`, verbs and `match`,
 * `resources` and `resource` with `only`/`except`, member, collection and nested routes, `namespace`, `scope` and
 * `controller` blocks. Anything else is listed in `unread`. Undefined when the file does not parse cleanly.
 */
export function readRoutes(source: string): RouteTable | undefined {
  const parsed = parseProgram(source);
  if (!parsed || parsed.errors) return undefined;
  const reader = new RouteReader(parsed);
  reader.readProgram(parsed.program);
  return reader.table;
}

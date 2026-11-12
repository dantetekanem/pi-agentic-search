import type * as Prism from "@ruby/prism";
import { ancestorsOf, lookupMethod, resolveConstant, type IndexedDefinition, type RubyIndex } from "./ruby-index.ts";
import { argumentsOf, constantPathText, kindName, lineAt, parseProgram, symbolValue } from "./ruby.ts";
import type { RouteTable } from "./ruby-routes.ts";

export type EntryKind = "controller" | "job";

/** A route that reaches a controller action: its verbs and path, and the line of the routes file that draws it, as written. */
export interface EntryRoute {
  verbs: string[];
  path: string;
  file: string;
  line: number;
  text?: string;
}

/** Where Rails sends a request that raised, when its exceptions app is a controller action: the lines that say so, the first as written. */
export interface EntryExceptionsApp {
  file: string;
  line: number;
  endLine: number;
  text?: string;
}

/**
 * A definition the framework calls: a job's `perform`, or a public method of a controller. `exact` is true for a job
 * and for an action a route read from `config/routes.rb` names; a public controller method no read route names may
 * be routed by code the reader did not interpret, or not at all. A routed action lists its routes, and the action
 * `config.exceptions_app` names says where.
 */
export interface Entry {
  kind: EntryKind;
  exact: boolean;
  routes?: EntryRoute[];
  exceptionsApp?: EntryExceptionsApp;
}

/** A controller action `config.exceptions_app` sends failing requests to: `ErrorsController.action(:show)`. */
export interface ExceptionsApp {
  controller: string;
  action: string;
  line: number;
  endLine: number;
}

/** The controller actions `config.exceptions_app = …` hands requests to, read from the syntax tree of a config file. */
export function readExceptionsApps(source: string): ExceptionsApp[] {
  const parsed = parseProgram(source);
  if (!parsed) return [];
  const found: ExceptionsApp[] = [];
  const line = (offset: number) => lineAt(parsed.lineStarts, offset);
  const visit = (node: Prism.Node, assignment?: Prism.CallNode) => {
    const call = kindName(node) === "CallNode" ? node as Prism.CallNode : undefined;
    const within = call?.name === "exceptions_app=" ? call : assignment;
    if (call && within && call.name === "action") {
      const controller = constantPathText(call.receiver);
      const action = symbolValue(argumentsOf(call)[0]);
      if (controller && controller !== "self" && action) {
        const at = within.location;
        found.push({ controller: controller.replace(/^::/, ""), action, line: line(at.startOffset), endLine: line(at.startOffset + Math.max(0, at.length - 1)) });
      }
    }
    for (const child of node.compactChildNodes()) visit(child, within);
  };
  visit(parsed.program);
  return found;
}

const JOB_ANCESTORS = /(^|::)ApplicationJob$|^ActiveJob::Base$|^Sidekiq::(?:Job|Worker)$/;
const CONTROLLER_ANCESTORS = /(^|::)ApplicationController$|^ActionController::(?:Base|API)$/;

/** What a class is to the framework, from its ancestors other than itself, as declared superclasses and mixins name them. */
export function frameworkKind(ancestors: string[]): EntryKind | undefined {
  if (ancestors.some((name) => JOB_ANCESTORS.test(name))) return "job";
  if (ancestors.some((name) => CONTROLLER_ANCESTORS.test(name))) return "controller";
  return undefined;
}

/** The class a route's controller names: `admin/orders` is `Admin::OrdersController`. */
export function controllerClass(controller: string): string {
  const camelize = (part: string) => part.split("_").filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
  return `${controller.split("/").map(camelize).join("::")}Controller`;
}

export const entryKey = (path: string, startLine: number): string => `${path}:${startLine}`;

/**
 * Entry points by `path:startLine` of their definition, from the index's ancestry and, when given, the routes read from
 * `routesFile` and the exceptions apps read from `config`, a config file such as `config/application.rb`.
 */
export function entryRegistry(index: RubyIndex, routes?: RouteTable, routesFile = "config/routes.rb", config?: { file: string; apps: ExceptionsApp[]; lines?: string[] }, routeLines?: string[]): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const mark = (def: IndexedDefinition, entry: Entry) => {
    const key = entryKey(def.path, def.startLine);
    const known = entries.get(key);
    if (!known?.exact) entries.set(key, { ...entry, ...(known?.routes ? { routes: known.routes } : {}), ...(known?.exceptionsApp ? { exceptionsApp: known.exceptionsApp } : {}) });
    return entries.get(key)!;
  };
  /** The public methods of a controller named by a route or a config file. */
  const actions = (controller: string, action: string) => {
    const symbol = resolveConstant(index, controller, undefined);
    return symbol ? lookupMethod(index, symbol, action, false).filter((def) => def.kind === "method" && !def.visibility) : [];
  };
  const byOwner = new Map<string, IndexedDefinition[]>();
  for (const def of index.definitions) if (def.owner) byOwner.set(def.owner, [...(byOwner.get(def.owner) ?? []), def]);

  for (const namespace of index.namespaces.values()) {
    if (namespace.kind !== "class") continue;
    const kind = frameworkKind(ancestorsOf(index, namespace.symbol).slice(1));
    if (kind === "job") {
      for (const def of lookupMethod(index, namespace.symbol, "perform", false)) if (def.kind === "method") mark(def, { kind, exact: true });
    } else if (kind === "controller") {
      for (const def of byOwner.get(namespace.symbol) ?? []) if (def.kind === "method" && !def.visibility) mark(def, { kind, exact: false });
    }
  }
  for (const route of routes?.routes ?? []) {
    for (const def of actions(controllerClass(route.controller), route.action)) {
      const entry = mark(def, { kind: "controller", exact: true });
      const said = routeLines?.[route.line - 1]?.trim();
      const drawn: EntryRoute = { verbs: route.verbs, path: route.path, file: routesFile, line: route.line, ...(said ? { text: said } : {}) };
      if (!entry.routes?.some((known) => known.path === drawn.path && known.verbs.join() === drawn.verbs.join())) entry.routes = [...(entry.routes ?? []), drawn];
    }
  }
  for (const app of config?.apps ?? []) {
    const said = config!.lines?.[app.line - 1]?.trim();
    for (const def of actions(app.controller, app.action)) mark(def, { kind: "controller", exact: true }).exceptionsApp = { file: config!.file, line: app.line, endLine: app.endLine, ...(said ? { text: said } : {}) };
  }
  return entries;
}

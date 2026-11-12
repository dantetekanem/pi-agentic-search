import { ancestorsOf, lookupMethod, resolveConstant, type IndexedDefinition, type RubyIndex } from "./ruby-index.ts";
import type { RouteTable } from "./ruby-routes.ts";

export type EntryKind = "controller" | "job";

/**
 * A definition the framework calls: a job's `perform`, or a public method of a controller. `exact` is true for a job
 * and for an action a route read from `config/routes.rb` names; a public controller method no read route names may
 * be routed by code the reader did not interpret, or not at all.
 */
export interface Entry {
  kind: EntryKind;
  exact: boolean;
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

/** Entry points by `path:startLine` of their definition, from the index's ancestry and, when given, the routes. */
export function entryRegistry(index: RubyIndex, routes?: RouteTable): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const mark = (def: IndexedDefinition, entry: Entry) => {
    const key = entryKey(def.path, def.startLine);
    if (!entries.get(key)?.exact) entries.set(key, entry);
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
    const symbol = resolveConstant(index, controllerClass(route.controller), undefined);
    if (!symbol) continue;
    for (const def of lookupMethod(index, symbol, route.action, false)) {
      if (def.kind === "method" && !def.visibility) mark(def, { kind: "controller", exact: true });
    }
  }
  return entries;
}

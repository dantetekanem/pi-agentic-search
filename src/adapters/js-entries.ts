import ts from "typescript";
import type { EntryRoute } from "./ruby-entries.ts";

/**
 * A way into a Node or browser app that its own code registers: a handler in a map of handlers by name, a listener of
 * an event, a route, or the handler a JSX element's event prop is given (`ui-handler`).
 */
export type CodeEntryKind = "handler" | "listener" | "route" | "ui-handler";

const CODE_ENTRY_KINDS = new Set<string>(["handler", "listener", "route", "ui-handler"]);

/** An entry of a kind code registers, as against one a framework's ancestry or a package.json gives. */
export const isCodeEntry = (entry: { kind: string }): entry is CodeEntry => CODE_ENTRY_KINDS.has(entry.kind);

/** The line that registers the way in, as written, and the name it is reached by: a handler's key, a listener's event. */
export interface CodeDoor {
  kind: CodeEntryKind;
  title: string;
  file: string;
  line: number;
  text?: string;
}

/**
 * A way in that code registers, in the shape of the other entries: `doors` name it where a line of code says so, and
 * `routes`, when it has them, are read like Rails's. `exact` is true only when the code shows the registration is used
 * as one; each kind's rule is in the README.
 */
export interface CodeEntry {
  kind: CodeEntryKind;
  exact: boolean;
  doors?: CodeDoor[];
  routes?: EntryRoute[];
}

/**
 * Where a reference to a name sits, seen from the definition that holds it: inside a function that is the value of an
 * object literal's property, or as that value itself. Absent when neither.
 */
export interface WayIn {
  /** The property's key as written: the text of a name or a quoted key, a computed key with its brackets. */
  key?: string;
  /** The way in: a handler of a map of handlers by name, or the listener a call registers. */
  entry?: CodeEntry;
  /** The name is the registered value itself (`again: sync`, `bus.on('x', sync)`), not a call inside it: the definition it names is the way in. */
  registers?: true;
}

type ObjectMethod = (ts.MethodDeclaration | ts.AccessorDeclaration) & { parent: ts.ObjectLiteralExpression };

/** A method or accessor written in an object literal: `prepare() {}`, `get size() {}`. */
function isObjectMethod(node: ts.Node): node is ObjectMethod {
  const method = ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
  return method && ts.isObjectLiteralExpression(node.parent);
}

/** A function as written in place: an arrow, a function expression, or a method or accessor of an object literal. */
function isFunctionValue(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || isObjectMethod(node);
}

const isWrapper = (node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression | ts.TypeAssertion | ts.NonNullExpression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node);

/** The expression a value is written as, out of parentheses, `as`, `satisfies` and `!`. */
function outermost(node: ts.Node): ts.Node {
  let current = node;
  while (isWrapper(current.parent)) current = current.parent;
  return current;
}

/** The value inside parentheses, `as`, `satisfies` and `!`. */
function innermost(node: ts.Expression): ts.Expression {
  let current = node;
  while (isWrapper(current)) current = current.expression;
  return current;
}

/** `name`, `this.name` or `a.b.name`: a name, with nothing called on the way. */
function isNameChain(node: ts.Expression): boolean {
  return ts.isIdentifier(node) || (ts.isPropertyAccessExpression(node) && (node.expression.kind === ts.SyntaxKind.ThisKeyword || isNameChain(node.expression)));
}

function keyText(name: ts.PropertyName, sf: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return name.getText(sf);
}

const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** The line as written, without its indentation. */
function lineText(sf: ts.SourceFile, line: number): string | undefined {
  const starts = sf.getLineStarts();
  const text = sf.text.slice(starts[line - 1], starts[line] ?? sf.text.length).trim();
  return text || undefined;
}

interface Property {
  key: string;
  property: ts.ObjectLiteralElementLike;
  map: ts.ObjectLiteralExpression;
}

/** The property `value` is the value of, or is, in an object literal. */
function propertyOf(value: ts.Node, sf: ts.SourceFile): Property | undefined {
  if (isObjectMethod(value)) return { key: keyText(value.name, sf), property: value, map: value.parent };

  const written = outermost(value);
  const parent = written.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === written) {
    return { key: keyText(parent.name, sf), property: parent, map: parent.parent };
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === value) {
    return { key: parent.name.text, property: parent, map: parent.parent };
  }
  return undefined;
}

/** A property whose value is a function written in place. */
const inPlace = (property: ts.ObjectLiteralElementLike) => isFunctionValue(property) || (ts.isPropertyAssignment(property) && isFunctionValue(innermost(property.initializer)));

/** A property whose value names something, which may be a function: `again: sync`, `{ sync }`. */
const named = (property: ts.ObjectLiteralElementLike) => ts.isShorthandPropertyAssignment(property) || (ts.isPropertyAssignment(property) && isNameChain(innermost(property.initializer)));

/** A key that has to be quoted, for it is no name: `'review.prepare'`, `'user:created'`. */
const quotedKey = (property: ts.ObjectLiteralElementLike) =>
  property.name !== undefined && (ts.isStringLiteral(property.name) || ts.isNoSubstitutionTemplateLiteral(property.name)) && !/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(property.name.text);

/**
 * Whether the file reads the map by a key it is given: the map is a variable's value, or a class field's, and somewhere
 * in the file `map[key]` (or `this.map[key]`) is read with a key that is no literal.
 */
function readByKey(map: ts.ObjectLiteralExpression, sf: ts.SourceFile): boolean {
  const written = outermost(map);
  const holder = written.parent;
  const variable = ts.isVariableDeclaration(holder) && holder.initializer === written && ts.isIdentifier(holder.name) ? holder.name.text : undefined;
  const field = ts.isPropertyDeclaration(holder) && holder.initializer === written ? keyText(holder.name, sf) : undefined;
  if (variable === undefined && field === undefined) return false;
  const holds = (target: ts.Expression) => variable !== undefined
    ? ts.isIdentifier(target) && target.text === variable
    : ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword && target.name.text === field;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isElementAccessExpression(node) && holds(innermost(node.expression))) {
      const key = innermost(node.argumentExpression);
      if (!ts.isStringLiteral(key) && !ts.isNumericLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key)) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * A handler, when the property belongs to a map of handlers by name. `exact`: every value is a function or names one,
 * and the file reads the map by a key it is given. Not exact: every value is a function written in place and at least
 * one key has to be quoted, for it is no name; the map is sent by key elsewhere, or not at all. Any other object, such
 * as one of options or of methods under plain names, holds no handler.
 */
function handlerOf({ key, property, map }: Property, sf: ts.SourceFile, path: string): CodeEntry | undefined {
  const properties = map.properties.filter((item) => !ts.isSpreadAssignment(item));
  const exact = readByKey(map, sf);
  const handlerMap = exact
    ? properties.every((item) => inPlace(item) || named(item))
    : properties.every(inPlace) && properties.some(quotedKey);
  if (!handlerMap) return undefined;

  const line = lineOf(sf, property);
  return { kind: "handler", exact, doors: [doorAt("handler", key, sf, path, line)] };
}

/** Where a way in is registered: the file, the line, and the line as written. */
function writtenAt(sf: ts.SourceFile, path: string, line: number): { file: string; line: number; text?: string } {
  const text = lineText(sf, line);
  return { file: path, line, ...(text ? { text } : {}) };
}

/** The door at `line` of the file, titled by the name the way in is reached by. */
function doorAt(kind: CodeEntryKind, title: string, sf: ts.SourceFile, path: string, line: number): CodeDoor {
  return { kind, title, ...writtenAt(sf, path, line) };
}

/**
 * Where the value a name holds comes from, seen at `at`: a parameter or local of a function around it, an import (with
 * its module) or a declaration at the file's top, or neither, which is a global such as `process` or `window`.
 */
type Origin = { from: "local" } | { from: "import"; module: string } | { from: "module" } | { from: "global" };

/** The module `require('x')` or `require('x').y` loads. */
function requiredModule(node: ts.Expression | undefined): string | undefined {
  let current = node && innermost(node);
  while (current && ts.isPropertyAccessExpression(current)) current = innermost(current.expression);
  if (!current || !ts.isCallExpression(current) || !ts.isIdentifier(current.expression) || current.expression.text !== "require") return undefined;
  const [specifier] = current.arguments;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : undefined;
}

/** Whether a binding (a name, or a destructuring pattern) declares `name`. */
function binds(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) => !ts.isOmittedExpression(element) && binds(element.name, name));
}

/** Whether `body`, at any depth, declares `name` as a variable, a function or a class. */
function declaresInside(body: ts.Node, name: string): boolean {
  let declared = false;
  const visit = (node: ts.Node): void => {
    if (declared) return;
    const variable = ts.isVariableDeclaration(node) && binds(node.name, name);
    const named = (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name;
    if (variable || named) declared = true;
    else ts.forEachChild(node, visit);
  };
  visit(body);
  return declared;
}

/** Whether an import clause binds `name`: its default, a namespace or a named import. */
function importsName(clause: ts.ImportClause, name: string): boolean {
  if (clause.name?.text === name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === name;
  return bindings.elements.some((element) => element.name.text === name);
}

function originOf(name: string, at: ts.Node): Origin {
  for (let node: ts.Node | undefined = at.parent; node && !ts.isSourceFile(node); node = node.parent) {
    if (!ts.isFunctionLike(node)) continue;
    if (node.parameters.some((parameter) => binds(parameter.name, name))) return { from: "local" };
    if ("body" in node && node.body && declaresInside(node.body, name)) return { from: "local" };
  }
  for (const statement of at.getSourceFile().statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause) {
      if (importsName(statement.importClause, name)) return { from: "import", module: statement.moduleSpecifier.text };
    } else if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find((item) => binds(item.name, name));
      if (declaration) {
        const module = requiredModule(declaration.initializer);
        return module ? { from: "import", module } : { from: "module" };
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
      return { from: "module" };
    }
  }
  return { from: "global" };
}

/**
 * What a receiver starts with: `this` (`this.bus`), a name (`bus`, `ipcMain`, `getCurrentWindow()`), with `called`
 * when a call is on the way to the receiver, or another expression.
 */
type Receiver =
  | { starts: "this" }
  | { starts: "expression" }
  | { starts: "name"; name: string; origin: Origin; called: boolean };

function receiverOf(expression: ts.Expression): Receiver {
  let current = innermost(expression);
  let called = false;
  for (;;) {
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = innermost(current.expression);
    } else if (ts.isCallExpression(current)) {
      called = true;
      current = innermost(current.expression);
    } else {
      break;
    }
  }
  if (current.kind === ts.SyntaxKind.ThisKeyword) return { starts: "this" };
  if (!ts.isIdentifier(current)) return { starts: "expression" };
  return { starts: "name", name: current.text, origin: originOf(current.text, current), called };
}

const EMITTER_METHODS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener", "addEventListener"]);
/** Globals that are event sources of the process or the page. */
const GLOBAL_SOURCES = new Set(["process", "window", "document", "globalThis", "self"]);
const fromElectron = (origin: Origin | undefined) => origin?.from === "import" && origin.module === "electron";
const fromTauri = (origin: Origin | undefined) => origin?.from === "import" && origin.module.startsWith("@tauri-apps/");
const fromProcess = (origin: Origin | undefined) => origin?.from === "import" && (origin.module === "process" || origin.module === "node:process");

/** A string written as a literal: an event's name or a route's path. */
function literalText(node: ts.Expression | undefined): string | undefined {
  const inner = node && innermost(node);
  return inner && (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) ? inner.text : undefined;
}

/**
 * Whether a listener of the event `call` names first is exact, when the function at `index` is one: true on a known
 * event source (`process`, `window`, `document`, a bare `addEventListener`, what Electron's or Tauri's modules give),
 * false on an emitter the module holds, imports from elsewhere or finds as a global it does not declare, and for
 * `addEventListener` on any other value; no listener on a parameter, local or member of the code around it, or on what
 * a call returns, such as a stream's `data` inside a function. The event is a literal, or there is no listener.
 * Electron's `handle` and `handleOnce` count only on what `electron` gives, Tauri's `listen` only from `@tauri-apps/`.
 */
function listenerExact(call: ts.CallExpression, index: number): boolean | undefined {
  if (index < 1 || literalText(call.arguments[0]) === undefined) return undefined;
  const callee = innermost(call.expression);
  if (ts.isIdentifier(callee)) {
    const origin = originOf(callee.text, callee);
    if (callee.text === "addEventListener" && origin.from === "global") return true;
    if ((callee.text === "listen" || callee.text === "once") && fromTauri(origin)) return true;
    return undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;

  const method = callee.name.text;
  const receiver = receiverOf(callee.expression);
  const origin = receiver.starts === "name" ? receiver.origin : undefined;
  if (method === "handle" || method === "handleOnce") return fromElectron(origin) ? true : undefined;
  if (method === "listen") return fromTauri(origin) ? true : undefined;
  if (!EMITTER_METHODS.has(method)) return undefined;

  // A name the receiver is, with no call on the way: `bus`, `process.stdin`, not `getBus()`.
  const plain = receiver.starts === "name" && !receiver.called ? receiver : undefined;
  const frameworkSource = fromElectron(origin) || fromTauri(origin);
  const globalSource = plain !== undefined && (fromProcess(plain.origin) || (plain.origin.from === "global" && GLOBAL_SOURCES.has(plain.name)));
  if (frameworkSource || globalSource) return true;

  const heldByModule = plain !== undefined && plain.origin.from !== "local";
  if (heldByModule) return false;
  return method === "addEventListener" ? false : undefined;
}

/** The verbs a router method registers; `all` takes the ones Rails's `via: :all` does. */
const VERB_METHODS: Record<string, string[]> = {
  get: ["GET"], post: ["POST"], put: ["PUT"], patch: ["PATCH"], delete: ["DELETE"], head: ["HEAD"], options: ["OPTIONS"],
  all: ["GET", "POST", "PUT", "PATCH", "DELETE"],
};
const HTTP_VERB = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
/** The packages whose apps and routers register routes: Express, Hono, Fastify, Koa's router, Elysia. */
const ROUTER_MODULES = /^(?:express|hono|fastify|@koa\/router|koa-router|elysia)(?:\/|$)/;
/** A receiver named like an app or a router: `app`, `router`, `api`, `adminRouter`. */
const ROUTER_NAME = /^(?:app|api|router|routes|server|fastify|hono)$|(?:App|Api|Router|Routes|Server)$/;

/** The verbs Hono's `on` names: `'GET'` or `['PUT', 'PATCH']`. */
function verbsOf(node: ts.Expression | undefined): string[] | undefined {
  const inner = node && innermost(node);
  const verbs = inner && ts.isArrayLiteralExpression(inner) ? inner.elements.map((element) => literalText(element)) : [literalText(inner)];
  return verbs.length && verbs.every((verb): verb is string => verb !== undefined && HTTP_VERB.test(verb)) ? verbs : undefined;
}

/** The name a type is written with starts with a name imported from a router package: `Express`, `express.Router`. */
function routerType(type: ts.TypeNode | undefined): boolean {
  if (!type || !ts.isTypeReferenceNode(type)) return false;
  let name: ts.EntityName = type.typeName;
  while (ts.isQualifiedName(name)) name = name.left;
  const origin = originOf(name.text, name);
  return origin.from === "import" && ROUTER_MODULES.test(origin.module);
}

/** A value made by what a router package exports: `express()`, `express.Router()`, `new Hono()`, `Fastify()`. */
function routerMade(value: ts.Expression | undefined): boolean {
  const made = value && innermost(value);
  if (!made || !(ts.isCallExpression(made) || ts.isNewExpression(made))) return false;
  let callee = innermost(made.expression);
  while (ts.isPropertyAccessExpression(callee)) callee = innermost(callee.expression);
  if (!ts.isIdentifier(callee)) return false;
  const origin = originOf(callee.text, callee);
  return origin.from === "import" && ROUTER_MODULES.test(origin.module);
}

/**
 * Whether the name `at` holds is an app or a router a router package made: a parameter written with such a type, or a
 * variable made by such a call, in the functions around it or at the file's top.
 */
function madeByRouterPackage(at: ts.Identifier): boolean {
  const name = at.text;
  for (let node: ts.Node | undefined = at.parent; node && !ts.isSourceFile(node); node = node.parent) {
    if (!ts.isFunctionLike(node)) continue;
    const parameter = node.parameters.find((item) => ts.isIdentifier(item.name) && item.name.text === name);
    if (parameter) return routerType(parameter.type);
  }
  let made = false;
  const visit = (node: ts.Node): void => {
    if (made) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) made = routerMade(node.initializer) || routerType(node.type);
    else ts.forEachChild(node, visit);
  };
  visit(at.getSourceFile());
  return made;
}

/**
 * The route a call registers the function at `index` as: `R.get('/path', ...fns)` and the other verbs, or Hono's
 * `R.on(verbs, '/path', ...fns)`, with the path a literal that starts with `/` (or is `*`) and the function after it,
 * handler or middleware. `exact` when R is an app or a router a router package made; not exact when R is only named
 * like one (`app`, `router`, `this.app`, `adminRouter`); no route otherwise, so a store's `get('/key', load)` is none.
 */
function routeOf(call: ts.CallExpression, index: number): { exact: boolean; verbs: string[]; path: string } | undefined {
  const callee = innermost(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  // Hono's `on` names its verbs first and its path second; every other method is a verb, its path first.
  const hono = method === "on";
  const verbMethod = Object.hasOwn(VERB_METHODS, method) ? VERB_METHODS[method] : undefined;
  const verbs = hono ? verbsOf(call.arguments[0]) : verbMethod;
  const pathAt = hono ? 1 : 0;
  const path = literalText(call.arguments[pathAt]);
  if (!verbs || path === undefined || index <= pathAt) return undefined;
  if (!path.startsWith("/") && path !== "*") return undefined;

  const receiver = innermost(callee.expression);
  const last = ts.isIdentifier(receiver) ? receiver : ts.isPropertyAccessExpression(receiver) ? receiver.name : undefined;
  const root = ts.isIdentifier(receiver) ? receiver : undefined;
  if (root && madeByRouterPackage(root)) return { exact: true, verbs, path };
  return last && ROUTER_NAME.test(last.text) ? { exact: false, verbs, path } : undefined;
}

/** The way in a call registers the function at `index` of its arguments as: a route, or a listener of the event it names. */
function registrationOf(call: ts.CallExpression, index: number, sf: ts.SourceFile, path: string): CodeEntry | undefined {
  const line = lineOf(sf, call);
  const route = routeOf(call, index);
  if (route) {
    const drawn: EntryRoute = { verbs: route.verbs, path: route.path, ...writtenAt(sf, path, line) };
    return { kind: "route", exact: route.exact, routes: [drawn] };
  }

  const exact = listenerExact(call, index);
  const event = literalText(call.arguments[0]);
  if (exact === undefined || event === undefined) return undefined;
  return { kind: "listener", exact, doors: [doorAt("listener", event, sf, path, line)] };
}

/**
 * The handler a JSX event prop is given, when `value` is the prop's expression: an `on` prop such as `onClick`, titled
 * by the element and the prop (`button onClick`) at the prop's line. Never exact: an element's prop says the interface
 * may call it, and a component's `on` prop is a callback it is handed, which may not come from the user at all.
 */
function uiHandlerOf(value: ts.Node, sf: ts.SourceFile, path: string): CodeEntry | undefined {
  const written = outermost(value);
  const container = written.parent;
  if (!ts.isJsxExpression(container) || container.expression !== written || !ts.isJsxAttribute(container.parent)) return undefined;
  const attribute = container.parent;
  const prop = attribute.name.getText(sf);
  if (!/^on[A-Z]/.test(prop)) return undefined;
  const element = attribute.parent.parent;
  const title = ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element) ? `${element.tagName.getText(sf)} ${prop}` : prop;
  return { kind: "ui-handler", exact: false, doors: [doorAt("ui-handler", title, sf, path, lineOf(sf, attribute))] };
}

/** The call `value` is an argument of, and where. */
function argumentOf(value: ts.Node): { call: ts.CallExpression; index: number } | undefined {
  const written = outermost(value);
  const parent = written.parent;
  if (!ts.isCallExpression(parent)) return undefined;
  const index = parent.arguments.indexOf(written as ts.Expression);
  return index >= 0 ? { call: parent, index } : undefined;
}

/**
 * The way in of the reference `name` at `reference`, up to `stop`, the node of the definition that holds it. First the
 * reference as a value: a property's (`'review.prepare': prepare`, `{ prepare }`, `handlers.prepare`), a registered
 * listener or route (`bus.on('x', prepare)`), or a JSX event prop's (`onClick={prepare}`). Then the nearest function
 * written in place around it that is one of those; a function around it that is none, such as a callback of `map`,
 * passes through. `path` is the file's path as the pack writes it.
 */
export function wayInOf(reference: ts.Identifier, stop: ts.Node | undefined, path: string): WayIn | undefined {
  const sf = reference.getSourceFile();
  let value: ts.Node = reference;
  while (ts.isPropertyAccessExpression(value.parent) && value.parent.name === value) value = value.parent;

  const own = propertyOf(value, sf);
  if (own) {
    const entry = handlerOf(own, sf, path);
    return { key: own.key, ...(entry ? { entry, registers: true as const } : {}) };
  }
  const passed = argumentOf(value);
  const registered = (passed && registrationOf(passed.call, passed.index, sf, path)) || uiHandlerOf(value, sf, path);
  if (registered) return { entry: registered, registers: true };

  for (let node = value.parent; node && node !== stop && !ts.isSourceFile(node); node = node.parent) {
    if (!isFunctionValue(node)) continue;
    const around = propertyOf(node, sf);
    if (around) {
      const entry = handlerOf(around, sf, path);
      return { key: around.key, ...(entry ? { entry } : {}) };
    }
    const argument = argumentOf(node);
    const entry = (argument && registrationOf(argument.call, argument.index, sf, path)) || uiHandlerOf(node, sf, path);
    if (entry) return { entry };
  }
  return undefined;
}

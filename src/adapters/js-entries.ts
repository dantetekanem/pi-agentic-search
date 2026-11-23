import ts from "typescript";
import type { EntryRoute } from "./ruby-entries.ts";

/** A way into a Node or browser app that its own code registers: a handler in a map of handlers by name. */
export type CodeEntryKind = "handler";

const CODE_ENTRY_KINDS = new Set<string>(["handler"]);

/** An entry of a kind code registers, as against one a framework's ancestry or a package.json gives. */
export const isCodeEntry = (entry: { kind: string }): entry is CodeEntry => CODE_ENTRY_KINDS.has(entry.kind);

/** The line that registers the way in, as written, and the name it is reached by: a handler's key. */
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
  /** The way in the property is: a handler of a map of handlers by name. */
  entry?: CodeEntry;
  /** The name is the registered value itself (`again: sync`), not a call inside it: the definition it names is the way in. */
  registers?: true;
}

/** A function as written in place: an arrow, a function expression, or a method or accessor of an object literal. */
function isFunctionValue(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
    || ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && ts.isObjectLiteralExpression(node.parent));
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
  if ((ts.isMethodDeclaration(value) || ts.isGetAccessorDeclaration(value) || ts.isSetAccessorDeclaration(value)) && ts.isObjectLiteralExpression(value.parent)) {
    return { key: keyText(value.name, sf), property: value, map: value.parent };
  }
  const written = outermost(value);
  const parent = written.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === written) return { key: keyText(parent.name, sf), property: parent, map: parent.parent };
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === value) return { key: parent.name.text, property: parent, map: parent.parent };
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
  if (exact ? !properties.every((item) => inPlace(item) || named(item)) : !properties.every(inPlace) || !properties.some(quotedKey)) return undefined;
  const line = lineOf(sf, property);
  const text = lineText(sf, line);
  return { kind: "handler", exact, doors: [{ kind: "handler", title: key, file: path, line, ...(text ? { text } : {}) }] };
}

/**
 * The way in of the reference `name` at `reference`, up to `stop`, the node of the definition that holds it: the
 * reference as a property's value (`'review.prepare': prepare`, `{ prepare }`, `handlers.prepare`), else the nearest
 * function written in place around it that is a property's value. A function around it that is neither passes through.
 * `path` is the file's path as the pack writes it.
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
  for (let node = value.parent; node && node !== stop && !ts.isSourceFile(node); node = node.parent) {
    if (!isFunctionValue(node)) continue;
    const around = propertyOf(node, sf);
    if (!around) continue;
    const entry = handlerOf(around, sf, path);
    return { key: around.key, ...(entry ? { entry } : {}) };
  }
  return undefined;
}

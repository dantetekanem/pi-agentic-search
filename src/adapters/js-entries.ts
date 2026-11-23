import ts from "typescript";

/**
 * Where a reference to a name sits, seen from the definition that holds it: inside a function that is the value of an
 * object literal's property, or as that value itself. Absent when neither.
 */
export interface WayIn {
  /** The property's key as written: the text of a name or a quoted key, a computed key with its brackets. */
  key?: string;
}

/** A function as written in place: an arrow, a function expression, or a method or accessor of an object literal. */
function isFunctionValue(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
    || ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && ts.isObjectLiteralExpression(node.parent));
}

/** The expression a value is written as, out of parentheses, `as`, `satisfies` and `!`. */
function outermost(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent) || ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent)) current = current.parent;
  return current;
}

function keyText(name: ts.PropertyName, sf: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return name.getText(sf);
}

/** The key `value` is written under, when it is the value of an object literal's property or is that property. */
function propertyKey(value: ts.Node, sf: ts.SourceFile): string | undefined {
  if ((ts.isMethodDeclaration(value) || ts.isGetAccessorDeclaration(value) || ts.isSetAccessorDeclaration(value)) && ts.isObjectLiteralExpression(value.parent)) return keyText(value.name, sf);
  const written = outermost(value);
  const parent = written.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === written) return keyText(parent.name, sf);
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === value) return parent.name.text;
  return undefined;
}

/**
 * The way in of the reference `name` at `reference`, up to `stop`, the node of the definition that holds it: the
 * reference as a property's value (`'review.prepare': prepare`, `{ prepare }`, `handlers.prepare`), else the nearest
 * function written in place around it that is a property's value. A function around it that is neither passes through.
 */
export function wayInOf(reference: ts.Identifier, stop: ts.Node | undefined): WayIn | undefined {
  const sf = reference.getSourceFile();
  let value: ts.Node = reference;
  while (ts.isPropertyAccessExpression(value.parent) && value.parent.name === value) value = value.parent;
  const own = propertyKey(value, sf);
  if (own !== undefined) return { key: own };
  for (let node = value.parent; node && node !== stop && !ts.isSourceFile(node); node = node.parent) {
    if (!isFunctionValue(node)) continue;
    const key = propertyKey(node, sf);
    if (key !== undefined) return { key };
  }
  return undefined;
}

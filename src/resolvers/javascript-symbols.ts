import { isBuiltin } from "node:module";
import type * as TypeScript from "typescript";
import type { ProjectFiles } from "../inventory.ts";
import type { RelationshipReference, SymbolBinding } from "../types.ts";

export async function inspectJavascript(source: string, from: string, wanted: string[], files: ProjectFiles) {
  const ts = await import("typescript");
  const tree = ts.createSourceFile(from, source, ts.ScriptTarget.Latest, true);
  const references: RelationshipReference[] = [];
  const exports = new Map<string, string>();
  const name = (node: TypeScript.Node | undefined): string | undefined =>
    node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;
  const implementation = (node: TypeScript.Expression, fallback: string): string =>
    name(node) ?? ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) ? name(node.name) : undefined) ?? fallback;
  const add = (specifier: TypeScript.Expression | undefined, bindings: SymbolBinding[], mode?: "import" | "require") => {
    const literal = specifier && ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
    if (literal && isBuiltin(literal)) return;
    references.push({ name: literal ?? `<dynamic ${mode ?? "import"}>`, relationship: "imported by", bindings, resolutionMode: mode, dynamic: !literal });
  };
  const visit = (node: TypeScript.Node): void => {
    if (!files.alive()) return;
    if (ts.isImportDeclaration(node)) {
      const bindings: SymbolBinding[] = [];
      const clause = node.importClause;
      if (clause?.name) bindings.push({ local: clause.name.text, imported: "default" });
      const named = clause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const item of named.elements) bindings.push({ local: item.name.text, imported: (item.propertyName ?? item.name).text });
      if (named && ts.isNamespaceImport(named)) bindings.push({ local: named.name.text, imported: "*" });
      add(node.moduleSpecifier, bindings);
    } else if (ts.isExportDeclaration(node)) {
      const bindings: SymbolBinding[] = [];
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const item of node.exportClause.elements) {
          const local = item.name.text;
          const imported = (item.propertyName ?? item.name).text;
          if (node.moduleSpecifier) bindings.push({ local, imported });
          else exports.set(local, imported);
        }
      } else bindings.push({ local: "*", imported: "*" });
      if (node.moduleSpecifier) add(node.moduleSpecifier, bindings);
    } else if (ts.isExportAssignment(node)) {
      exports.set("default", implementation(node.expression, "default"));
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const bindings: SymbolBinding[] = [];
      const parent = node.parent;
      const access = ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent : undefined;
      const declaration = access?.parent ?? parent;
      if (ts.isVariableDeclaration(declaration)) {
        if (ts.isIdentifier(declaration.name)) bindings.push({ local: declaration.name.text, imported: access?.name.text ?? "default" });
        else if (ts.isObjectBindingPattern(declaration.name)) {
          for (const item of declaration.name.elements) {
            const local = name(item.name);
            const imported = name(item.propertyName) ?? local;
            if (local && imported && !item.dotDotDotToken) bindings.push({ local, imported });
          }
        }
      }
      add(node.arguments[0], bindings, node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import" : "require");
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left.getText(tree).replace(/\s/g, "");
      if (left === "module.exports") exports.set("default", implementation(node.right, "module.exports"));
      else if (ts.isPropertyAccessExpression(node.left) && ["exports", "module.exports"].includes(node.left.expression.getText(tree).replace(/\s/g, ""))) {
        exports.set(node.left.name.text, implementation(node.right, node.left.name.text));
      }
    }
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) exports.set("default", name(node.name) ?? "default");
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const localSymbols = [...new Set(wanted.map((symbol) => {
    const seen = new Set<string>();
    while (exports.has(symbol) && !seen.has(symbol)) { seen.add(symbol); symbol = exports.get(symbol)!; }
    return symbol;
  }))];
  for (const reference of references) {
    const bindings = reference.bindings ?? [];
    const matching = bindings.filter((binding) => binding.local === "*" || localSymbols.includes(binding.local) || localSymbols.includes(binding.imported));
    const symbols = [...new Set(matching.flatMap((binding) => binding.imported === "*" ? localSymbols : [binding.imported]))];
    reference.symbols = symbols.slice(0, files.limits.symbolBindings);
    reference.bindings = [...matching, ...bindings.filter((binding) => !matching.includes(binding))].slice(0, files.limits.symbolBindings);
    if (bindings.length > reference.bindings.length || symbols.length > reference.symbols.length) files.skip(`symbol binding budget at ${files.display(from)} for ${reference.name}`);
  }
  references.sort((a, b) => (b.symbols?.length ?? 0) - (a.symbols?.length ?? 0));
  return { references, localSymbols };
}

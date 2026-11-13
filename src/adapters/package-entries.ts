import ts from "typescript";
import { dirname, join, normalize } from "node:path";

/** What a package.json sends work to: a command (`bin`), a module Pi loads (`pi.extensions`), or what the package exports (`main`, `module`, `exports`). */
export type PackageDoorKind = "command" | "extension" | "export";

/** Where package.json says so: the line, as written, and what it calls the way in. */
export interface PackageDoor {
  kind: PackageDoorKind;
  /** The command, the module Pi loads, or the package and the name it exports: `agentic-search`, `./index.ts`, `pi-agentic-search: runSearch`. */
  title: string;
  file: string;
  line: number;
  text?: string;
}

/**
 * A JavaScript or TypeScript definition its package exposes: a statement of a command's file, which runs when the
 * command does; the default export of a module Pi loads as an extension; a name the package's entry module exports.
 * `exact`: package.json names the file, and the module's own export statements name the definition.
 */
export interface PackageEntry {
  kind: PackageDoorKind;
  exact: true;
  doors: PackageDoor[];
}

/** The exposures of one package, by `path#name` of a definition, and the command files whose statements all run. */
export interface PackageEntries {
  byName: Map<string, PackageEntry>;
  commands: Map<string, PackageEntry>;
}

const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** How many re-exports deep a name is followed. */
const MOST_REEXPORTS = 4;

/** The 1-based line of package.json where a key, or a string value, is written first after `after`. */
function lineOf(lines: string[], wanted: RegExp, after = 0): number {
  const index = lines.findIndex((line, at) => at >= after && wanted.test(line));
  return index >= 0 ? index + 1 : 1;
}

const quoted = (value: string) => new RegExp(`"${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);

/** The string paths a package.json `exports` field gives, at any depth of conditions. */
function exportPaths(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(exportPaths);
  return [];
}

/** The names a module exports, each with the module and local name it comes from, following re-exports. */
function exportedNames(module: string, read: (path: string) => string | undefined, depth = 0): Map<string, { module: string; local: string }> {
  const names = new Map<string, { module: string; local: string }>();
  const source = read(module);
  if (source === undefined || depth > MOST_REEXPORTS) return names;
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, false);
  const resolveFrom = (specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = normalize(join(dirname(module), specifier));
    const tries = [base, ...MODULE_EXTENSIONS.map((extension) => base.replace(/\.(?:m|c)?js$/, "") + extension), ...MODULE_EXTENSIONS.map((extension) => join(base, `index${extension}`))];
    return tries.find((path) => read(path) !== undefined);
  };
  const exported = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  for (const statement of file.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && exported(statement) && statement.name) {
      names.set(isDefault(statement) ? "default" : statement.name.text, { module, local: statement.name.text });
    } else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.set(declaration.name.text, { module, local: declaration.name.text });
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.set("default", { module, local: statement.expression.text });
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? resolveFrom(statement.moduleSpecifier.text) : undefined;
      const inner = from ? exportedNames(from, read, depth + 1) : undefined;
      if (!statement.exportClause) {
        // export * from "./x": every name but its default.
        for (const [name, target] of inner ?? []) if (name !== "default" && !names.has(name)) names.set(name, target);
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const local = (element.propertyName ?? element.name).text;
          const target = inner ? inner.get(local) : statement.moduleSpecifier ? undefined : { module, local };
          if (target) names.set(element.name.text, target);
        }
      }
    }
  }
  return names;
}

/**
 * What a package.json at `root` exposes, read from its `bin`, `pi.extensions`, `main`, `module` and `exports` fields,
 * with each module's exports followed through its re-exports. `read` gives a file's text, or undefined.
 */
export function packageEntries(root: string, read: (path: string) => string | undefined): PackageEntries {
  const entries: PackageEntries = { byName: new Map(), commands: new Map() };
  const manifest = root === "." ? "package.json" : `${root}/package.json`;
  const text = read(manifest);
  if (text === undefined) return entries;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return entries;
  }
  const lines = text.split("\n");
  const inRoot = (path: string) => normalize(root === "." ? path : join(root, path)).replace(/^\.\//, "");
  const door = (kind: PackageDoorKind, title: string, line: number): PackageDoor => ({ kind, title, file: manifest, line, ...(lines[line - 1]?.trim() ? { text: lines[line - 1]!.trim() } : {}) });
  const add = (map: Map<string, PackageEntry>, key: string, kind: PackageDoorKind, opening: PackageDoor) => {
    const known = map.get(key);
    if (!known) map.set(key, { kind, exact: true, doors: [opening] });
    else if (!known.doors.some((item) => item.line === opening.line && item.title === opening.title)) known.doors.push(opening);
  };
  const name = typeof parsed.name === "string" ? parsed.name : undefined;

  // A command runs its file from the top: every statement there is where its work starts.
  const bin = typeof parsed.bin === "string" && name ? { [name.replace(/^@[^/]+\//, "")]: parsed.bin } : parsed.bin && typeof parsed.bin === "object" ? parsed.bin as Record<string, unknown> : {};
  const binLine = lineOf(lines, /"bin"\s*:/);
  for (const [command, file] of Object.entries(bin)) {
    if (typeof file !== "string") continue;
    add(entries.commands, inRoot(file), "command", door("command", command, lineOf(lines, quoted(command), binLine - 1)));
  }

  // Pi calls the default export of each module its package lists as an extension.
  const pi = parsed.pi && typeof parsed.pi === "object" ? parsed.pi as Record<string, unknown> : {};
  const extensionsLine = lineOf(lines, /"extensions"\s*:/);
  for (const file of Array.isArray(pi.extensions) ? pi.extensions : []) {
    if (typeof file !== "string") continue;
    const target = exportedNames(inRoot(file), read).get("default");
    if (target) add(entries.byName, `${target.module}#${target.local}`, "extension", door("extension", file, lineOf(lines, quoted(file), extensionsLine - 1)));
  }

  // What the package gives whoever imports it.
  const modules = [
    ...(typeof parsed.main === "string" ? [{ file: parsed.main, line: lineOf(lines, /"main"\s*:/) }] : []),
    ...(typeof parsed.module === "string" ? [{ file: parsed.module, line: lineOf(lines, /"module"\s*:/) }] : []),
    ...exportPaths(parsed.exports).map((file) => ({ file, line: lineOf(lines, quoted(file), lineOf(lines, /"exports"\s*:/) - 1) })),
  ];
  for (const { file, line } of modules) {
    for (const [exportedAs, target] of exportedNames(inRoot(file), read)) {
      // What Pi loads already says how work gets there; the same function exported is no other way in.
      const key = `${target.module}#${target.local}`;
      if (entries.byName.get(key)?.kind === "extension") continue;
      add(entries.byName, key, "export", door("export", `${name ?? file}: ${exportedAs}`, line));
    }
  }
  return entries;
}

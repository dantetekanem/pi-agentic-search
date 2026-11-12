import ts from "typescript";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { excerpt, normalizeSignature } from "../shared.ts";
import type { AdapterDefinition, CallSite, Definition, FileFacts, Guard, LanguageAdapter, ResolvedTarget } from "./types.ts";

interface TsFacts extends FileFacts {
  sourceFile: ts.SourceFile;
  defNodes: Map<number, ts.Node>;
  handle?: ProgramHandle;
}

export interface ProgramHandle {
  configPath?: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  roots: Set<string>;
  createdMs: number;
  fileCount: number;
  byRealPath: Map<string, ts.SourceFile>;
}

const MAX_PROGRAMS_PER_RUN = 4;

const TEST_CALLS = new Set(["describe", "it", "test", "context", "specify", "suite"]);
const COMPONENT_WRAPPERS = /^(?:React\.)?(?:memo|forwardRef|lazy|observer)$|^styled(?:\.|\(|$)|^create[A-Z]\w*$/;
const BASE_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  skipLibCheck: true,
  allowJs: true,
  checkJs: false,
  declaration: false,
  composite: false,
  incremental: false,
  noResolve: false,
};

export class TsPrograms {
  private readonly handles = new Map<string, ProgramHandle>();
  readonly notes: string[] = [];

  constructor(private readonly cwd: string, private readonly overlay: Map<string, string> = new Map()) {}

  private host(options: ts.CompilerOptions): ts.CompilerHost {
    const host = ts.createCompilerHost(options, true);
    if (!this.overlay.size) return host;
    const overlay = this.overlay;
    const lookup = (fileName: string): string | undefined => overlay.get(fileName) ?? overlay.get(realOf(fileName));
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.readFile = (fileName) => lookup(fileName) ?? readFile(fileName);
    host.fileExists = (fileName) => lookup(fileName) !== undefined || fileExists(fileName);
    return host;
  }

  configFor(absolutePath: string): string | undefined {
    return ts.findConfigFile(dirname(absolutePath), ts.sys.fileExists, "tsconfig.json");
  }

  prepare(absolutePaths: string[], signal?: AbortSignal): void {
    const groups = new Map<string, string[]>();
    for (const path of absolutePaths) {
      const config = this.configFor(path) ?? "";
      groups.set(config, [...(groups.get(config) ?? []), path]);
    }
    for (const [config, roots] of groups) {
      if (signal?.aborted) return;
      this.ensure(config || undefined, roots);
    }
  }

  sourceFileFor(absolutePath: string): { handle: ProgramHandle; sourceFile: ts.SourceFile } | undefined {
    const real = realOf(absolutePath);
    for (const handle of this.handles.values()) {
      const direct = handle.program.getSourceFile(absolutePath) ?? handle.byRealPath.get(real);
      if (direct) return { handle, sourceFile: direct };
    }
    const config = this.configFor(absolutePath) ?? "";
    if (this.handles.has(config) || this.handles.size >= MAX_PROGRAMS_PER_RUN) return undefined;
    const created = this.ensure(config || undefined, [absolutePath]);
    const sourceFile = created?.program.getSourceFile(absolutePath) ?? created?.byRealPath.get(real);
    return created && sourceFile ? { handle: created, sourceFile } : undefined;
  }

  private ensure(configPath: string | undefined, roots: string[], previous?: ProgramHandle): ProgramHandle | undefined {
    const started = Date.now();
    let options: ts.CompilerOptions = { ...BASE_OPTIONS, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve };
    let projectReferences: readonly ts.ProjectReference[] | undefined;
    if (configPath) {
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      if (read.error) {
        this.notes.push(`tsconfig ${relative(this.cwd, configPath)} could not be read; default compiler options used.`);
      } else {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), BASE_OPTIONS, configPath);
        options = { ...parsed.options, ...BASE_OPTIONS };
        projectReferences = parsed.projectReferences;
      }
    }
    try {
      const program = ts.createProgram({ rootNames: roots, options, projectReferences, oldProgram: previous?.program, host: this.host(options) });
      const byRealPath = new Map<string, ts.SourceFile>();
      for (const sourceFile of program.getSourceFiles()) byRealPath.set(realOf(sourceFile.fileName), sourceFile);
      const handle: ProgramHandle = {
        configPath,
        program,
        checker: program.getTypeChecker(),
        roots: new Set(roots),
        createdMs: Date.now() - started,
        fileCount: program.getSourceFiles().length,
        byRealPath,
      };
      this.handles.set(configPath ?? "", handle);
      this.notes.push(`TypeScript program for ${configPath ? relative(this.cwd, configPath) : "default options"}: ${roots.length} root file${roots.length === 1 ? "" : "s"}, ${handle.fileCount} source files, ${handle.createdMs} ms.`);
      return handle;
    } catch (error) {
      this.notes.push(`TypeScript program for ${configPath ?? "default options"} failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  describe(): string[] {
    return this.notes;
  }

  summary(): Array<{ config: string; roots: number; files: number; ms: number }> {
    return [...this.handles.values()].map((handle) => ({
      config: handle.configPath ? relative(this.cwd, handle.configPath) : "default options",
      roots: handle.roots.size,
      files: handle.fileCount,
      ms: handle.createdMs,
    }));
  }
}

function realOf(path: string): string {
  try {
    return ts.sys.realpath ? ts.sys.realpath(path) : path;
  } catch {
    return path;
  }
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function rangeOf(sf: ts.SourceFile, node: ts.Node): [number, number] {
  return [lineOf(sf, node.getStart(sf)), lineOf(sf, node.getEnd())];
}

function nameText(node: ts.Node | undefined, sf: ts.SourceFile): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.getText(sf);
}

function isFunctionLike(node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)));
}

function kindForName(name: string, functionLike: boolean): string {
  if (!functionLike) return "constant";
  return /^[A-Z]/.test(name) ? "component" : "function";
}

function localDeclarationKind(declaration: ts.Node): ResolvedTarget["local"] | undefined {
  let node: ts.Node | undefined = declaration;
  while (node && !ts.isSourceFile(node)) {
    if (ts.isParameter(node)) return "parameter";
    if (node !== declaration && (ts.isFunctionLike(node) || ts.isBlock(node))) return "local";
    if (ts.isClassLike(node) || ts.isModuleBlock(node)) return undefined;
    node = node.parent;
  }
  return undefined;
}

function packageNameFrom(fileName: string): string | undefined {
  const match = fileName.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g);
  if (!match) return undefined;
  const last = match[match.length - 1]!;
  return last.replace(/^node_modules\//, "");
}

// Guards: the conditions that dominate code, as written. Shared by the call visitor and guardsAt.

const GUARD_TEXT_LIMIT = 300;

/** A guard whose text is `expression` as written. */
function expressionGuard(expression: ts.Expression, sf: ts.SourceFile, branch: Guard["branch"]): Guard {
  return {
    line: lineOf(sf, expression.getStart(sf)),
    text: excerpt(expression.getText(sf), GUARD_TEXT_LIMIT),
    branch,
  };
}

/** An `if` keeps its keyword: `if (x)`. */
function ifGuard(statement: ts.IfStatement, sf: ts.SourceFile, branch: Guard["branch"]): Guard {
  const guard = expressionGuard(statement.expression, sf, branch);
  return { ...guard, text: `if (${guard.text})` };
}

/** The guard that `child` runs under inside `node`, when `node` branches. */
function branchGuard(node: ts.Node, child: ts.Node, sf: ts.SourceFile): Guard | undefined {
  if (ts.isIfStatement(node)) {
    if (child === node.thenStatement) return ifGuard(node, sf, "then");
    if (child === node.elseStatement) return ifGuard(node, sf, "else");
  } else if (ts.isConditionalExpression(node)) {
    if (child === node.whenTrue) return expressionGuard(node.condition, sf, "then");
    if (child === node.whenFalse) return expressionGuard(node.condition, sf, "else");
  } else if (ts.isBinaryExpression(node) && child === node.right) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return expressionGuard(node.left, sf, "then");
    if (operator === ts.SyntaxKind.BarBarToken) return expressionGuard(node.left, sf, "else");
  }
  return undefined;
}

function exits(statement: ts.Statement | undefined): boolean {
  if (!statement) return false;
  if (ts.isBlock(statement)) return exits(statement.statements[statement.statements.length - 1]);
  return ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isContinueStatement(statement) || ts.isBreakStatement(statement);
}

/** An `if` without an else whose branch ends in return, throw, continue or break guards the statements after it. */
function exitGuard(statement: ts.Node, sf: ts.SourceFile): Guard | undefined {
  if (!ts.isIfStatement(statement) || statement.elseStatement || !exits(statement.thenStatement)) return undefined;
  return ifGuard(statement, sf, "after-return");
}

function holdsStatements(node: ts.Node): boolean {
  return ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node);
}

/** Code inside these runs on its own later; conditions around them do not dominate it. */
function isGuardBoundary(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isClassExpression(node);
}

/** One step down toward `offset`: the child holding it and the guards entering that child adds. */
function stepToward(node: ts.Node, offset: number, sf: ts.SourceFile): { child: ts.Node; guards: Guard[] } | undefined {
  const exitGuards: Guard[] = [];
  let found: { child: ts.Node; guards: Guard[] } | undefined;
  ts.forEachChild(node, (child) => {
    if (child.getStart(sf) <= offset && offset < child.getEnd()) {
      const guard = branchGuard(node, child, sf);
      found = { child, guards: guard ? [...exitGuards, guard] : exitGuards };
      return true;
    }
    const exit = holdsStatements(node) ? exitGuard(child, sf) : undefined;
    if (exit) exitGuards.push(exit);
    return undefined;
  });
  return found;
}

/** Where the code of `line` starts: after indentation, closing brackets and a leading `else`. Undefined for a blank or comment line. */
function firstCodeOffset(sf: ts.SourceFile, line: number): number | undefined {
  const text = sf.text;
  const starts = sf.getLineStarts();
  const end = line < starts.length ? starts[line]! : text.length;
  let offset = starts[line - 1]!;
  const skipClosers = () => {
    while (offset < end && " \t\r})]".includes(text[offset]!)) offset += 1;
  };

  skipClosers();
  if (text.startsWith("else", offset) && !/[\w$]/.test(text[offset + 4] ?? "")) {
    offset += "else".length;
    skipClosers();
  }

  if (offset >= end || text[offset] === "\n" || text.startsWith("//", offset) || text.startsWith("/*", offset)) return undefined;
  return offset;
}

class Extractor {
  readonly definitions: AdapterDefinition[] = [];
  readonly defNodes = new Map<number, ts.Node>();

  constructor(private readonly sf: ts.SourceFile) {}

  private push(node: ts.Node, name: string, kind: string, owner?: string, callable?: ts.SignatureDeclarationBase): void {
    const [startLine, endLine] = rangeOf(this.sf, node);
    const symbol = owner ? `${owner}.${name}` : name;
    const signature = callable ? normalizeSignature(this.sf.text.slice(callable.parameters.pos, callable.parameters.end)) : undefined;
    this.definitions.push({ name, symbol, kind, startLine, endLine, owner, signature });
    if (!this.defNodes.has(startLine)) this.defNodes.set(startLine, node);
  }

  run(): void {
    for (const statement of this.sf.statements) this.visitStatement(statement, undefined, true);
  }

  private visitStatement(node: ts.Node, owner: string | undefined, topLevel: boolean): void {
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? "default";
      this.push(node, name, kindForName(name, true), owner, node);
      this.visitTestsInside(node.body, owner);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const name = nameText(declaration.name, this.sf);
        if (!name) continue;
        if (!declaration.initializer) {
          if (declaration.type) this.push(node, name, ts.isFunctionTypeNode(declaration.type) ? "function" : "constant", owner);
          continue;
        }
        const init = declaration.initializer;
        if (isFunctionLike(init)) {
          this.push(node, name, kindForName(name, true), owner, init);
          this.visitTestsInside(init.body, owner);
        } else if (ts.isCallExpression(init) && COMPONENT_WRAPPERS.test(init.expression.getText(this.sf))) {
          this.push(node, name, kindForName(name, true), owner, init.arguments.find(isFunctionLike));
        } else if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
          this.push(node, name, "object", owner);
        } else if (topLevel) {
          this.push(node, name, "constant", owner);
        }
      }
      return;
    }
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.text ?? "default";
      this.push(node, name, "class", owner);
      for (const member of node.members) {
        const memberName = member.name ? nameText(member.name, this.sf) : ts.isConstructorDeclaration(member) ? "constructor" : undefined;
        if (!memberName) continue;
        if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          this.push(member, memberName, "method", name, member);
        } else if (ts.isPropertyDeclaration(member) && isFunctionLike(member.initializer)) {
          this.push(member, memberName, "method", name, member.initializer);
        }
      }
      return;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      this.push(node, node.name.text, "type", owner);
      return;
    }
    if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
      const name = nameText(node.name, this.sf) ?? "namespace";
      for (const statement of node.body.statements) this.visitStatement(statement, owner ? `${owner}.${name}` : name, false);
      return;
    }
    if (ts.isExportAssignment(node) && isFunctionLike(node.expression)) {
      this.push(node, "default", "function", owner, node.expression);
      return;
    }
    if (ts.isExpressionStatement(node)) {
      const expression = node.expression;
      if (ts.isCallExpression(expression)) {
        const test = this.testBlock(expression);
        if (test) {
          this.push(node, test.label, "test", owner);
          this.visitTestsInside(test.body, owner ? `${owner} ${test.callee} "${test.label}"` : `${test.callee} "${test.label}"`);
          return;
        }
        if (topLevel) this.push(node, expression.getText(this.sf).slice(0, 60), "statement", owner);
        return;
      }
      if (topLevel && ts.isBinaryExpression(expression) && /^(module\.exports|exports\.[\w$]+)$/.test(expression.left.getText(this.sf))) {
        const callable = isFunctionLike(expression.right) ? expression.right : undefined;
        this.push(node, expression.left.getText(this.sf), callable ? "function" : "constant", owner, callable);
      }
    }
  }

  private testBlock(call: ts.CallExpression): { callee: string; label: string; body: ts.Node | undefined } | undefined {
    const calleeText = call.expression.getText(this.sf);
    const callee = calleeText.split(".")[0]!;
    if (!TEST_CALLS.has(callee)) return undefined;
    const first = call.arguments[0];
    const label = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) || ts.isTemplateExpression(first)) ? (ts.isTemplateExpression(first) ? first.getText(this.sf).slice(1, -1) : first.text) : undefined;
    if (label === undefined) return undefined;
    const fn = call.arguments.find((argument) => isFunctionLike(argument));
    return { callee, label, body: fn && (fn as ts.ArrowFunction).body };
  }

  private visitTestsInside(body: ts.Node | undefined, owner: string | undefined): void {
    if (!body || !ts.isBlock(body)) return;
    for (const statement of body.statements) {
      if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && this.testBlock(statement.expression)) {
        this.visitStatement(statement, owner, false);
      }
    }
  }
}

class Calls {
  readonly sites: CallSite[] = [];
  private readonly seen = new Set<string>();
  private guards: Guard[] = [];

  constructor(private readonly facts: TsFacts, private readonly def: Definition, private readonly cwd: string, private readonly root: ts.Node) {}

  private push(site: CallSite): void {
    const key = `${site.source}:${site.receiver ?? ""}:${site.name}:${site.line}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.guards.length) site.guards = [...this.guards];
    this.sites.push(site);
  }

  private resolve(nameNode: ts.Node): { target?: ResolvedTarget; builtin: boolean } {
    const handle = this.facts.handle;
    if (!handle) return { builtin: false };
    let symbol = handle.checker.getSymbolAtLocation(nameNode);
    if (!symbol) return { builtin: false };
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = handle.checker.getAliasedSymbol(symbol);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return { builtin: false };
    const declFile = declaration.getSourceFile();
    const fileName = declFile.fileName;
    if (handle.program.isSourceFileDefaultLibrary(declFile) || /\/typescript\/lib\/lib\./.test(fileName)) return { builtin: true };
    const local = localDeclarationKind(declaration);
    if (local) {
      const real = ts.sys.realpath ? ts.sys.realpath(fileName) : fileName;
      return { target: { path: real, line: lineOf(declFile, declaration.getStart(declFile)), symbol: symbol.getName(), local }, builtin: false };
    }
    const external = packageNameFrom(fileName);
    if (external && !fileName.includes(`${this.cwd}/`.replace(/\/node_modules\/.*/, ""))) {
      return { target: { path: fileName, line: lineOf(declFile, declaration.getStart(declFile)), external, symbol: symbol.getName() }, builtin: false };
    }
    if (external && fileName.includes("/node_modules/")) {
      const real = ts.sys.realpath ? ts.sys.realpath(fileName) : fileName;
      if (real.includes("/node_modules/")) return { target: { path: real, line: lineOf(declFile, declaration.getStart(declFile)), external, symbol: symbol.getName() }, builtin: false };
      return { target: { path: real, line: lineOf(declFile, declaration.getStart(declFile)), symbol: symbol.getName(), declaration: real.endsWith(".d.ts") }, builtin: false };
    }
    const real = ts.sys.realpath ? ts.sys.realpath(fileName) : fileName;
    return { target: { path: real, line: lineOf(declFile, declaration.getStart(declFile)), symbol: symbol.getName(), declaration: real.endsWith(".d.ts") }, builtin: false };
  }

  private receiverType(node: ts.Expression): string | undefined {
    const handle = this.facts.handle;
    if (!handle) return undefined;
    try {
      const type = handle.checker.getTypeAtLocation(node);
      const text = handle.checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
      return text === "any" || text === "unknown" ? undefined : text.slice(0, 60);
    } catch {
      return undefined;
    }
  }

  visit(node: ts.Node): void {
    const sf = this.facts.sourceFile;
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const line = lineOf(sf, node.getStart(sf));
      if (ts.isPropertyAccessExpression(expression)) {
        const receiver = expression.expression.getText(sf).slice(0, 40);
        const { target, builtin } = this.resolve(expression.name);
        if (!builtin) {
          this.push({ name: expression.name.text, receiver, line, relationship: "calls", source: "member", receiverKind: receiver === "this" ? "self" : "local", receiverType: this.receiverType(expression.expression), via: target ? "checker" : undefined, target });
        }
      } else if (ts.isIdentifier(expression)) {
        if (expression.text !== this.def.name || this.def.kind === "test") {
          const { target, builtin } = this.resolve(expression);
          if (!builtin) this.push({ name: expression.text, line, relationship: "calls", source: "call", via: target ? "checker" : undefined, target });
        }
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const { target, builtin } = this.resolve(node.expression);
      if (!builtin) this.push({ name: node.expression.text, line: lineOf(sf, node.getStart(sf)), relationship: "references", source: "new", via: target ? "checker" : undefined, target });
    } else if (ts.isJsxOpeningLikeElement(node)) {
      const tag = node.tagName;
      const text = tag.getText(sf);
      if (/^[A-Z]/.test(text) || text.includes(".")) {
        const nameNode = ts.isPropertyAccessExpression(tag) ? tag.name : tag;
        const { target, builtin } = this.resolve(nameNode);
        if (!builtin) this.push({ name: text, line: lineOf(sf, node.getStart(sf)), relationship: "references", source: "jsx", via: target ? "checker" : undefined, target });
      }
    }
    this.visitChildren(node);
  }

  /** Visits each child under the conditions it runs under; a nested function or class starts with none. */
  private visitChildren(node: ts.Node): void {
    const sf = this.facts.sourceFile;
    const outer = this.guards;
    if (node !== this.root && isGuardBoundary(node)) this.guards = [];
    const depth = this.guards.length;
    const isStatementList = holdsStatements(node);

    ts.forEachChild(node, (child) => {
      const guard = branchGuard(node, child, sf);
      if (guard) this.guards.push(guard);
      this.visit(child);
      if (guard) this.guards.pop();

      const exit = isStatementList ? exitGuard(child, sf) : undefined;
      if (exit) this.guards.push(exit);
    });

    this.guards.length = depth;
    this.guards = outer;
  }
}

export class TsAdapter implements LanguageAdapter {
  readonly language = "javascript" as const;
  private programs?: TsPrograms;
  private cwd = "";

  attach(programs: TsPrograms, cwd: string): void {
    this.programs = programs;
    this.cwd = cwd;
  }

  ready(): Promise<boolean> {
    return Promise.resolve(true);
  }

  parse(path: string, source: string, detached = false): FileFacts | undefined {
    const absolute = isAbsolute(path) ? path : resolve(this.cwd || process.cwd(), path);
    const found = detached ? undefined : this.programs?.sourceFileFor(absolute);
    const handle = found?.handle;
    const fromProgram = found?.sourceFile;
    const sourceFile = fromProgram && fromProgram.text === source
      ? fromProgram
      : ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, /\.(tsx|jsx)$/.test(absolute) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(absolute) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const extractor = new Extractor(sourceFile);
    extractor.run();
    return {
      path,
      language: "javascript",
      definitions: extractor.definitions.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine),
      namespaces: [],
      ivars: new Map(),
      errors: 0,
      sourceFile,
      defNodes: extractor.defNodes,
      handle: fromProgram && fromProgram.text === source ? handle : undefined,
    } as TsFacts;
  }

  definitionAt(facts: FileFacts, line: number): AdapterDefinition | undefined {
    const containing = facts.definitions.filter((def) => def.startLine <= line && line <= def.endLine);
    if (!containing.length) return undefined;
    const leaves = containing.filter((def) => def.kind !== "class" && def.kind !== "type" && def.kind !== "object" && def.kind !== "constant");
    const pool = leaves.length ? leaves : containing;
    return pool.reduce((best, def) => (def.startLine >= best.startLine ? def : best));
  }

  confirmsReference(facts: FileFacts, line: number, name: string): boolean {
    const sf = (facts as TsFacts).sourceFile;
    if (line < 1 || line > sf.getLineStarts().length) return false;
    const lineStart = sf.getPositionOfLineAndCharacter(line - 1, 0);
    const lineEnd = line < sf.getLineStarts().length ? sf.getPositionOfLineAndCharacter(line, 0) : sf.getEnd();
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found || node.getEnd() < lineStart || node.getStart(sf) >= lineEnd) return;
      if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text === name) {
        const parent = node.parent;
        const declaring = parent && (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent) || ((ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isParameter(parent) || ts.isPropertyDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node));
        if (!declaring) found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  calls(facts: FileFacts, def: Definition): CallSite[] {
    const tsFacts = facts as TsFacts;
    const node = tsFacts.defNodes.get(def.startLine);
    if (!node) return [];
    const collector = new Calls(tsFacts, def, this.cwd, node);
    collector.visit(node);
    return collector.sites;
  }

  guardsAt(facts: FileFacts, def: Definition, line: number): Guard[] {
    const sf = (facts as TsFacts).sourceFile;
    const offset = line >= def.startLine && line <= def.endLine && line <= sf.getLineStarts().length ? firstCodeOffset(sf, line) : undefined;
    if (offset === undefined) return [];
    let guards: Guard[] = [];
    let node: ts.Node = sf;
    for (;;) {
      if (isGuardBoundary(node)) guards = [];
      const step = stepToward(node, offset, sf);
      if (!step) return guards;
      guards.push(...step.guards);
      node = step.child;
    }
  }
}

export const tsAdapter = new TsAdapter();

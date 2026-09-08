export const JS_TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]);
export const SOURCE_EXTENSIONS = new Set([
  ...JS_TS_EXTENSIONS, ".c", ".cc", ".clj", ".cpp", ".cs", ".ex", ".exs", ".go", ".h", ".hpp",
  ".java", ".kt", ".lua", ".php", ".py", ".rb", ".rs", ".scala", ".swift", ".zig",
]);
export const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build", "coverage", "tmp", "log", ".next", ".turbo", "target"]);
const excludeDirectories = (directories: Iterable<string>) => [...directories].flatMap((name) => [`!${name}/**`, `!**/${name}/**`]);
const LOCK_EXCLUDES = ["!*.lock", "!**/*.lock", "!package-lock.json", "!**/package-lock.json", "!pnpm-lock.yaml", "!**/pnpm-lock.yaml", "!yarn.lock", "!**/yarn.lock"];
export const DEFAULT_EXCLUDES = [...excludeDirectories(SKIP_DIRS), ...LOCK_EXCLUDES];
export const PACKAGE_SEARCH_EXCLUDES = [...excludeDirectories([".git", "node_modules", "coverage"]), "!*.map", "!**/*.map", "!*.min.*", "!**/*.min.*", ...LOCK_EXCLUDES];

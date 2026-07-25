import { isAbsolute, relative, resolve, sep } from "node:path";

export function normalizeRepoRelativePath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\/+/, "");
}

export function camelToSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function displaySearchRoot(cwd: string, resolved: string): string {
  const rel = relative(cwd, resolved);
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !isAbsolute(rel)) return normalizeRepoRelativePath(rel);
  return normalizeRepoRelativePath(resolved);
}

export function ensureInsideCwd(cwd: string, candidate: string): string {
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
  const rel = relative(cwd, resolved);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolved;
  throw new Error(`Path escapes current repository: ${candidate}`);
}

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value ?? fallback)));
}

export function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

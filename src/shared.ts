import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function runGit(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, signal, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) rejectPromise(new Error(`git ${args.slice(0, 2).join(" ")} failed: ${String(stderr || error.message).trim()}`));
      else resolvePromise(String(stdout ?? ""));
    });
  });
}

export const DEFAULT_EXCLUDES = [
  "!.git/**",
  "!**/.git/**",
  "!node_modules/**",
  "!**/node_modules/**",
  "!vendor/**",
  "!**/vendor/**",
  "!dist/**",
  "!**/dist/**",
  "!build/**",
  "!**/build/**",
  "!coverage/**",
  "!**/coverage/**",
  "!tmp/**",
  "!**/tmp/**",
  "!log/**",
  "!**/log/**",
  "!.next/**",
  "!**/.next/**",
  "!.turbo/**",
  "!**/.turbo/**",
  "!target/**",
  "!**/target/**",
  "!*.lock",
  "!**/*.lock",
  "!package-lock.json",
  "!**/package-lock.json",
  "!pnpm-lock.yaml",
  "!**/pnpm-lock.yaml",
  "!yarn.lock",
  "!**/yarn.lock",
];

export function addRgExcludes(args: string[]): void {
  for (const glob of DEFAULT_EXCLUDES) args.push("--glob", glob);
}

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

function isInsidePath(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function ensureInsideCwd(cwd: string, candidate: string): string {
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
  if (isInsidePath(cwd, resolved)) return resolved;
  throw new Error(`Path escapes current repository: ${candidate}`);
}

export async function isRealPathInsideCwd(cwd: string, candidate: string): Promise<boolean> {
  try {
    const [realCwd, realCandidate] = await Promise.all([realpath(cwd), realpath(candidate)]);
    return isInsidePath(realCwd, realCandidate);
  } catch {
    return false;
  }
}

export async function ensureRealPathInsideCwd(cwd: string, candidate: string): Promise<void> {
  const [realCwd, realCandidate] = await Promise.all([realpath(cwd), realpath(candidate)]);
  if (isInsidePath(realCwd, realCandidate)) return;
  throw new Error(`Path escapes current repository: ${candidate}`);
}

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value ?? fallback)));
}

export function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

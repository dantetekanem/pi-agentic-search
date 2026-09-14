import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_EXCLUDES, JS_TS_EXTENSIONS } from "./classifications.ts";
import { uniqueValues } from "./shared.ts";

export function runGit(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, signal, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) rejectPromise(new Error(`git ${args.slice(0, 2).join(" ")} failed: ${String(stderr || error.message).trim()}`));
      else resolvePromise(String(stdout ?? ""));
    });
  });
}

export function addRgExcludes(args: string[]): void {
  for (const glob of DEFAULT_EXCLUDES) args.push("--glob", glob);
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

export function jsImportCandidatePaths(resolvedFrom: string, specifier: string): string[] {
  const base = resolve(dirname(resolvedFrom), specifier);
  const ext = extname(base).toLowerCase();
  const candidates: string[] = [];

  if (ext) candidates.push(base);
  for (const candidateExt of JS_TS_EXTENSIONS) candidates.push(`${base}${candidateExt}`);
  for (const candidateExt of JS_TS_EXTENSIONS) candidates.push(join(base, `index${candidateExt}`));

  return uniqueValues(candidates);
}

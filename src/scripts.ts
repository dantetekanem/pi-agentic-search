import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { normalizeRepoRelativePath } from "./shared.ts";
import { addRgExcludes } from "./sparsity-shared.ts";

/** The languages a script without a file ending can be read as. A shell script has no adapter, so it stays plain text. */
export type ScriptLanguage = "ruby" | "javascript";

/** How many files with no ending a root may have looked at for a first line, so a large tree stays quick. */
const MOST_CANDIDATES = 4000;
const FIRST_BYTES = 256;
const RUBY = /^(?:ruby|jruby|truffleruby)[\d.]*$/;
const NODE = /^(?:node|nodejs|tsx|ts-node|bun|deno)$/;

/** A statement at a script's top level: it runs when the script is run from the command line, so work starts there. */
export interface ScriptEntry {
  kind: "command";
  exact: true;
}

/** A file name with no ending: `production-errors`, not `production_errors.rb` or `.env`. */
export const hasNoEnding = (path: string): boolean => !basename(path).includes(".");

/**
 * The language a script's first line names: `#!/usr/bin/env ruby`, `#!/usr/bin/ruby`, `#!/usr/bin/env -S node
 * --flags`. Undefined for a shell, another language, or a line that is no shebang.
 */
export function shebangLanguage(firstLine: string | undefined): ScriptLanguage | undefined {
  const match = /^#!\s*(\S+)(.*)$/.exec((firstLine ?? "").replace(/^﻿/, "").trimEnd());
  if (!match) return undefined;
  const words = [basename(match[1]!), ...match[2]!.trim().split(/\s+/).filter(Boolean)];
  const program = words[0] === "env" ? words.slice(1).find((word) => !word.startsWith("-") && !word.includes("=")) : words[0];
  if (!program) return undefined;
  if (RUBY.test(program)) return "ruby";
  if (NODE.test(program)) return "javascript";
  return undefined;
}

/** The language of a file with no ending, by its first line, or undefined. */
export const scriptLanguage = (path: string, firstLine: string | undefined): ScriptLanguage | undefined => (hasNoEnding(path) ? shebangLanguage(firstLine) : undefined);

async function firstLine(path: string): Promise<string | undefined> {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return undefined;
  try {
    const buffer = Buffer.alloc(FIRST_BYTES);
    const { bytesRead } = await file.read(buffer, 0, FIRST_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
  } finally {
    await file.close();
  }
}

/**
 * The scripts under `root` that have no file ending and whose first line names Ruby or Node, by path relative to `cwd`.
 * Files are listed the way the rest of the search lists them (hidden ones too, the default excludes left out); only
 * the first bytes of each are read.
 */
export async function scriptFiles(root: string, cwd: string, signal?: AbortSignal): Promise<Map<string, ScriptLanguage>> {
  const args = ["--files", "--hidden", "--color=never"];
  addRgExcludes(args);
  args.push(root);
  const listed = await new Promise<string[]>((resolvePromise, reject) => {
    const found: string[] = [];
    let carry = "";
    let hasOutput = false;
    const child = spawn("rg", args, { cwd, signal, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      hasOutput ||= Boolean(chunk.trim());
      const lines = (carry + chunk).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) if (line.trim() && hasNoEnding(line.trim()) && found.length < MOST_CANDIDATES) found.push(normalizeRepoRelativePath(line.trim()));
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const noMatches = code === 1 && !hasOutput;
      if (code !== 0 && !noMatches) {
        const reason = signal ? `terminated by ${signal}` : `exited with code ${code}`;
        reject(new Error(`Script discovery failed: rg ${reason}`));
        return;
      }
      if (carry.trim() && hasNoEnding(carry.trim()) && found.length < MOST_CANDIDATES) found.push(normalizeRepoRelativePath(carry.trim()));
      resolvePromise(found);
    });
  });
  const scripts = new Map<string, ScriptLanguage>();
  for (const path of listed) {
    const language = shebangLanguage(await firstLine(resolve(cwd, path)));
    if (language) scripts.set(path, language);
  }
  return scripts;
}

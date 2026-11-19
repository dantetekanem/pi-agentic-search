import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TsAdapter, TsPrograms } from "../src/adapters/ts.ts";
import { collectSparsity, formatSparsity } from "../src/sparsity.ts";
import { scanSparsity } from "../src/sparsity-scan.ts";

const config = JSON.stringify({
  compilerOptions: { noLib: true, types: [], strict: true, jsx: "preserve" },
});
const modes = ["standalone", "program", "stale-program", "detached"] as const;

function sourceFor(extension: "ts" | "tsx", kind: "malformed" | "valid" | "semantic"): string {
  let value = "1";
  if (kind === "semantic") value = '"wrong type"';
  else if (kind === "malformed" && extension === "ts") value = "";

  let result = "helper(value)";
  if (extension === "tsx") {
    const closingTag = kind === "malformed" ? "div" : "span";
    result = `<span>{helper(value)}</${closingTag}>`;
  }
  return [
    "export function Runner() {",
    `  const value: number = ${value};`,
    `  return ${result};`,
    "}",
    "function helper(value: number) { return value; }",
    "",
  ].join("\n");
}

async function fixture(path: string, source: string, run: (cwd: string, absolute: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "ts-parse-coverage-"));
  try {
    await writeFile(join(cwd, "tsconfig.json"), config);
    const absolute = join(cwd, path);
    await writeFile(absolute, source);
    await run(cwd, absolute);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

for (const extension of ["ts", "tsx"] as const) {
  for (const mode of modes) {
    for (const kind of ["malformed", "valid", "semantic"] as const) {
      test(`${extension} ${mode}: ${kind} source reports syntax coverage and retains definitions`, async () => {
        const source = sourceFor(extension, kind);
        const stale = mode === "stale-program" || mode === "detached";
        const diskSource = stale ? sourceFor(extension, kind === "malformed" ? "valid" : "malformed") : source;
        await fixture(`main.${extension}`, diskSource, async (cwd, absolute) => {
          const adapter = new TsAdapter();
          if (mode !== "standalone") {
            const programs = new TsPrograms(cwd);
            programs.prepare([absolute]);
            const found = programs.sourceFileFor(absolute);
            assert.ok(found, "fixture has a compiler-backed source file");
            assert.equal(found.sourceFile.text, diskSource);
            if (kind === "semantic" && !stale) {
              const diagnostics = found.handle.program.getSemanticDiagnostics(found.sourceFile);
              assert.ok(diagnostics.some((item) => item.code === 2322), "the fixture really has a type error");
            }
            adapter.attach(programs, cwd);
          }

          const facts = adapter.parse(absolute, source, mode === "detached");
          assert.ok(facts);
          assert.deepEqual(facts.definitions.map((item) => item.symbol), ["Runner", "helper"]);
          assert.equal(Boolean(facts.errors), kind === "malformed", `${facts.errors} syntax errors for ${kind} input`);
        });
      });
    }
  }

  for (const kind of ["malformed", "semantic"] as const) {
    test(`${extension} collector: ${kind} source has honest parser frontier coverage`, async () => {
      const path = `main.${extension}`;
      await fixture(path, sourceFor(extension, kind), async (cwd) => {
        const result = await collectSparsity({
          cwd,
          target: `${path}:1`,
          root: ".",
          maxDepth: 1,
          vicinity: 5,
          maxNodes: 8,
          callers: false,
          budgetMs: 20_000,
        });

        assert.equal(result.anchor.symbol, "Runner");
        const parseNotes = result.coverage.frontier.filter((item) => item.includes("parse errors"));
        assert.equal(parseNotes.length, kind === "malformed" ? 1 : 0);
        if (kind === "malformed") {
          assert.match(parseNotes[0]!, new RegExp(`^main\\.${extension}: [1-9]\\d* parse errors; call detection may be incomplete \\(parser\\)$`));
          assert.match(formatSparsity(result), /parse errors; call detection may be incomplete \(parser\)/);
        }
        const helper = result.edges.find((edge) => edge.name === "helper");
        assert.equal(result.nodes.find((node) => node.id === helper?.to)?.symbol, "helper", "usable recovered call remains available");
      });
    });

    test(`${extension} scan: ${kind} source has honest parser frontier coverage`, async () => {
      const path = `main.${extension}`;
      await fixture(path, sourceFor(extension, kind), async (cwd) => {
        const result = await scanSparsity({
          cwd,
          diff: "worktree",
          anchors: [`${path}:1`],
          maxDepth: 1,
          vicinity: 5,
          maxNodes: 8,
          maxAnchors: 4,
          budgetMs: 20_000,
          outputDir: join(cwd, "pack"),
          inlineBudgetBytes: 40 * 1024,
        });

        assert.equal(result.anchors[0]?.symbol, "Runner");
        const parseNotes = result.coverage.frontier.filter((item) => item.includes("parse errors"));
        assert.equal(parseNotes.length > 0, kind === "malformed");
        if (kind === "malformed") {
          assert.match(result.inline, /parse errors; call detection may be incomplete \(parser\)/);
        }
      });
    });
  }
}

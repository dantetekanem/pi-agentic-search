import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectFiles } from "../src/inventory.ts";
import { RETRIEVAL_LIMITS, SearchRequest } from "../src/retrieval.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "agentic-large-inventory-"));
  const bin = join(root, "bin");
  const source = join(root, "source");
  const marker = join(root, "rg-called");
  await mkdir(bin);
  await mkdir(source);
  await writeFile(join(source, "target.ts"), "export const target = true;\n");
  const rg = join(bin, "rg");
  await writeFile(rg, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_RG_MARKER, "called");
for (let i = 0; i < 15000; i++) {
  const name = "file-" + String(i).padStart(5, "0") + "-" + "x".repeat(480) + ".ts\\0";
  if (!process.stdout.write(name)) process.stdout.once("drain", () => {});
}
`);
  await chmod(rg, 0o755);
  const previousPath = process.env.PATH;
  const previousMarker = process.env.FAKE_RG_MARKER;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.FAKE_RG_MARKER = marker;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.FAKE_RG_MARKER;
    else process.env.FAKE_RG_MARKER = previousMarker;
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, marker };
}

test("exact files bypass inventory and oversized directories stop through the streaming candidate limit", async t => {
  const { source, marker } = await fixture(t);
  const request = new SearchRequest(undefined, 30_000, { ...RETRIEVAL_LIMITS, candidates: 10_000 });
  const files = new ProjectFiles(source, request);

  const exact = await files.list(join(source, "target.ts"));
  assert.equal(exact.length, 1);
  assert.ok(exact[0]!.endsWith("/source/target.ts"));
  await assert.rejects(readFile(marker), /ENOENT/, "an exact file does not call rg --files");

  const inventory = await files.list(source);
  assert.equal(inventory.length, 10_000);
  assert.equal(await readFile(marker, "utf8"), "called");
  assert.match(request.inventoryReasons.join("\n"), /path inventory candidate budget/);
  assert.match(files.skipped.join("\n"), /path inventory candidate budget/);
  const run = request.runs.find(item => item.kind === "inventory");
  assert.equal(run?.status, "partial");
  assert.equal(run?.reason, "path inventory candidate budget");
  assert.doesNotMatch(run?.error ?? "", /maxBuffer/);
  request.dispose();
});

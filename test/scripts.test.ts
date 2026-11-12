import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { shebangLanguage } from "../src/scripts.ts";
import { scanSparsity, type ScanOptions, type ScanResult } from "../src/sparsity-scan.ts";

/** A script with no file ending, `bin/report`, is read in the language its first line names, like any .rb or .js file. */
const FILES: Record<string, string> = {
  "Gemfile": "source 'https://rubygems.org'\n",
  "bin/report": `#!/usr/bin/env ruby
# frozen_string_literal: true

class Report
  def self.run(args)
    new(args).total
  end

  def initialize(args)
    @args = args
  end

  def total
    Pricing.round(@args.size)
  end
end

exit Report.run(ARGV) if $PROGRAM_NAME == __FILE__
`,
  "app/models/pricing.rb": "class Pricing\n  def self.round(value)\n    value.round\n  end\nend\n",
  "test/bin/report_test.rb": `require "minitest/autorun"
load File.expand_path("../../bin/report", __dir__)

class ReportTest < Minitest::Test
  def test_counts_its_arguments
    assert_equal 0, run_report
  end

  private

  def run_report
    Report.run([])
  end
end
`,
  "package.json": '{"name":"tools","type":"module"}\n',
  "bin/tool": '#!/usr/bin/env -S node --no-warnings\nimport { shout } from "../src/shout.js";\n\nconsole.log(shout("hi"));\n',
  "src/shout.js": "export function shout(text) {\n  return text.toUpperCase();\n}\n",
  "bin/setup": "#!/usr/bin/env bash\necho setup\n",
  "bin/worker": "#!/usr/bin/env ruby\nclass Worker\n  def call\n    Pricing.round(2.5)\n  end\nend\n\nWorker.new.call\n",
  "bin/cleanup": "#!/usr/bin/env ruby\nrequire \"json\"\n\ndef main\n  puts JSON.generate(done: true)\nend\n\nmain\n",
};

async function repo(run: (scan: (options: Partial<ScanOptions>) => Promise<ScanResult>, change: (files: Record<string, string>) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "scripts-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", timeout: 20_000 });
  const write = async (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), content);
      if (path.startsWith("bin/")) await chmod(join(cwd, path), 0o755);
    }
  };
  let packs = 0;
  const scan = (options: Partial<ScanOptions>) => scanSparsity({
    cwd, diff: "", maxDepth: 1, vicinity: 5, maxNodes: 60, maxAnchors: 30, budgetMs: 30_000, indexCacheDir: join(root, "index"),
    outputDir: join(root, `pack-${++packs}`), inlineBudgetBytes: 40 * 1024, ...options,
  });
  try {
    git("init", "-q", "-b", "main");
    await write(FILES);
    git("add", ".");
    git("commit", "-qm", "base");
    await run(scan, async (files) => {
      await write(files);
      git("commit", "-qam", "change");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a script's first line names its language: Ruby and Node, through env and its flags, and no shell", () => {
  assert.equal(shebangLanguage("#!/usr/bin/env ruby"), "ruby");
  assert.equal(shebangLanguage("#!/usr/local/bin/ruby3.3 -w"), "ruby");
  assert.equal(shebangLanguage("#!/usr/bin/env -S node --no-warnings"), "javascript");
  assert.equal(shebangLanguage("#!/usr/bin/env tsx"), "javascript");
  assert.equal(shebangLanguage("#!/usr/bin/env bash"), undefined, "a shell script has no adapter: it stays plain text");
  assert.equal(shebangLanguage("#!/usr/bin/env python3"), undefined);
  assert.equal(shebangLanguage("# ruby"), undefined);
});

test("a changed Ruby script with no file ending is anchored like a .rb file, and the test that loads it and calls it is its test", () => repo(async (scan, change) => {
  await change({
    "bin/report": FILES["bin/report"]!.replace("new(args).total", "new(args).total.to_i").replace("Pricing.round(@args.size)", "Pricing.round(@args.size * 1.0)"),
    "bin/tool": FILES["bin/tool"]!.replace('shout("hi")', 'shout("hello")'),
    "bin/setup": "#!/usr/bin/env bash\necho setting up\n",
  });
  const result = await scan({ diff: "HEAD~1..HEAD", allTests: true });
  const byPath = Object.fromEntries(result.files.map((file) => [file.path, [file.kind, file.language]]));
  assert.deepEqual([byPath["bin/report"], byPath["bin/tool"], byPath["bin/setup"]], [["code", "ruby"], ["code", "javascript"], ["other", undefined]]);

  const anchors = result.anchors.filter((anchor) => anchor.path === "bin/report").map((anchor) => [anchor.symbol, anchor.kind]);
  assert.deepEqual(anchors, [["Report.run", "singleton_method"], ["Report#total", "method"]]);
  const run = result.anchors.find((anchor) => anchor.symbol === "Report.run")!;
  assert.deepEqual(run.tests.map((entry) => [entry.path, entry.symbol, entry.line]), [["test/bin/report_test.rb", "ReportTest#run_report", 12]]);
  const total = result.anchors.find((anchor) => anchor.symbol === "Report#total")!;
  assert.deepEqual(total.callers.map((caller) => [caller.symbol, caller.line, caller.resolution]), [["Report.run", 6, "static_candidate"]]);
  assert.ok(result.anchors.some((anchor) => anchor.path === "bin/tool"), "the Node script's changed statement");
  assert.ok(!result.anchors.some((anchor) => anchor.path === "bin/setup"));
}));

test("a script is searched for callers like any file of its language", () => repo(async (scan) => {
  const result = await scan({ anchors: ["app/models/pricing.rb:2", "src/shout.js:1"] });
  const callers = (symbol: string) => result.anchors.find((anchor) => anchor.symbol === symbol)!.callers.map((caller) => [caller.path, caller.symbol]);
  assert.deepEqual(callers("Pricing.round"), [["bin/report", "Report#total"], ["bin/worker", "Worker#call"]]);
  assert.deepEqual(callers("shout").map(([path]) => path), ["bin/tool"]);
}));

test("a script's top-level call is a caller of what it calls, and the command line is where its work starts", () => repo(async (scan) => {
  const result = await scan({ anchors: ["bin/report:5", "bin/worker:3", "bin/cleanup:4", "src/shout.js:1"] });
  const callers = (symbol: string) => result.anchors.find((anchor) => anchor.symbol === symbol)!.callers.map((caller) => {
    const node = result.nodes.find((entry) => entry.id === caller.id)!;
    return [node.path, node.kind, caller.line, caller.resolution, node.entry];
  });
  const command = { kind: "command", exact: true };
  assert.deepEqual(callers("Report.run"), [["bin/report", "statement", 18, "exact", command]], "exit Report.run(ARGV) if $PROGRAM_NAME == __FILE__");
  assert.deepEqual(callers("Worker#call"), [["bin/worker", "statement", 8, "exact", command]], "Worker.new.call");
  assert.deepEqual(callers("main"), [["bin/cleanup", "statement", 8, "exact", command]], "main, at the bottom of the script that defines it");
  assert.deepEqual(callers("shout"), [["bin/tool", "statement", 4, "exact", command]], "the Node script's top-level call");
  const statement = result.nodes.find((node) => node.path === "bin/report" && node.kind === "statement")!;
  assert.equal(statement.symbol, "exit Report.run(ARGV) if $PROGRAM_NAME == __FILE__");
  assert.ok(!result.nodes.some((node) => node.kind === "statement" && /require/.test(node.symbol)), "a require loads code, and runs none");
}));

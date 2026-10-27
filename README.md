# pi-agentic-search

`pi-agentic-search` finds code with fewer tool round-trips. Use its CLI from any coding harness with shell access, or its native tools in Pi.

I built it to avoid the repeated searches and file reads an agent goes through before reaching the right place in a codebase. It ranks search results and collects related code in one call, so the agent doesn't have to fetch each file separately.

## Finding code

`agentic_search` ranks ripgrep matches, suggests which file to read first, and includes source snippets. It can look for definitions, references, or tests. When the same name appears in several parts of the codebase, context helps rank the relevant matches.

For example, searching for `remaining_value` with context `actual goal progress` helps separate goal-related code from unrelated financial calculations. The search pattern stays the same; the context changes how matches are ranked.

The search can also follow supported Ruby mixins and JavaScript/TypeScript imports into other files and packages. That lets the agent find the definition behind an imported name without opening every file along the way. Directory and partial-path searches follow relationships from a limited set of ranked matches, with the selected and omitted files reported in the results.

## Following calls and reviewing changes

The context tools collect definitions, calls, callers, and related tests for Ruby, JavaScript, and TypeScript.

`sparsity_collect` takes a file and line number, finds the enclosing definition, and follows its calls up to the requested depth. The result includes source snippets, the file lines above and below the definition (`vicinity above`/`vicinity below`, as many as `vicinity_check`), static callers, and calls it couldn't resolve.

`sparsity_scan` collects context for a whole diff, including removed definitions that still have callers. It accepts commits, Git ranges, or uncommitted changes with untracked files.

A manifest lists the pack's contents and points to sections in `pack.md`. The agent can read the section it needs without loading the whole pack into the conversation. Each changed definition comes with its vicinity (the file lines above and below it) and three lines around every caller's call site. Schemas, configuration, and files without a parser include their changed hunks and the surrounding file lines without call expansion, with a note that callers, tests and sibling definitions must be read by hand. Additional test definitions are grouped by file.

## Installation

You need Node.js 22+ and `rg` ([ripgrep](https://github.com/BurntSushi/ripgrep)) on your `PATH`. Diff context also uses Git. The package includes its Ruby parser and TypeScript dependency. The CLI does not need Pi or a TypeScript loader.

### CLI and other harnesses

```bash
pnpm add -g pi-agentic-search
agentic-search --help
```

From a source checkout with dependencies already present, run the `build` script, then `node bin/agentic-search.mjs --help`. Published packages include the compiled CLI.

The portable [skill](skills/agentic-search/SKILL.md) explains when to search, collect or scan without listing every option. Copy its `agentic-search` directory into a skill location supported by your harness, or point the harness at the file as instructions. Installation does not edit harness configuration.

### Pi

```bash
pi install npm:pi-agentic-search
```

Then run `/reload` in Pi. To try the published package for one session without saving it to your package settings:

```bash
pi -e npm:pi-agentic-search
```

## Usage

### CLI

```bash
agentic-search search 'remaining_value' --intent definition --context 'actual goal progress'
agentic-search search 'calculateTotal' --path src/cart.ts --expand-related
agentic-search collect app/models/goal.rb:42 --max-depth 3
agentic-search scan --diff main..HEAD
agentic-search scan --diff worktree --output-dir /tmp/review-context
```

Run in the repository or add `--cwd /path/to/repo` after the subcommand. Use `search --help`, `collect --help` or `scan --help` for all options. Numeric CLI options reject values outside their documented limits. `scan --anchor path:line` accepts repeated anchors instead of `--diff`.

Text is the default. `--json` writes one `{text, details}` object to stdout, including coverage and pack paths. JSON is not truncated; text is capped at 2,000 lines or 50 KiB, with overflow saved to a reported temporary file. Diagnostics go to stderr. Ruby parsing can emit Node's WASI warning there.

Exit codes: `0` for a result, including a complete search with no matches; `1` for execution failure; `2` for invalid arguments; `130` for interruption. A successful exit can still contain partial coverage or unresolved calls. Inspect the result before drawing conclusions.

Scan packs default to a fresh system temporary directory. A relative `--output-dir` resolves against the selected repository. The CLI builds its Ruby index in temporary storage and removes that index when the command finishes. It does not use Pi's metrics log or persistent cache; Pi keeps its existing storage locations. Use a dedicated output directory: a scan writes `pack.md`, `pack.json` and `metrics.json` there. These files contain source and remain until you remove them.

### Pi tools

Pi can call these tools during coding work. You can also ask for one by name:

> Use `sparsity_scan` to collect context for my uncommitted changes. Explain what changed and which callers might be affected.

Pi can collect the diff with `diff: "worktree"`, read the relevant sections, and use `sparsity_collect` for a closer look at a definition. When starting from a name rather than a diff, `agentic_search` finds candidates first.

### Code Mode

All three tools support Pi's Code Mode with the same arguments as direct calls. They are callable while active in both `codemode.mode: "on"` and `"only"`; `"only"` hides their direct declarations without disabling script calls.

The extension does not enable `codemode` itself. If needed, add it in Pi's user or project settings:

```json
{
  "defaultTools": ["+codemode"]
}
```

An explicit `--tools` allowlist must include `codemode` and the search tools you want, alongside any other tools you need. Tool exclusions can disable them.

Inside a `codemode` script (replace the example query and target with your own):

```js
text(await tools.agentic_search({ query: "calculateTotal", intent: "definition" }));
text(await tools.sparsity_collect({ target: "src/cart.ts:12" }));
text(await tools.sparsity_scan({ diff: "worktree" }));
```

Each awaited call returns a text string, not structured JSON. Read coverage notes and any context-pack paths in that text.

Find tools through `ALL_TOOLS` or `await searchTools("sparsity")`; inspect a tool's arguments with `await describeTool("sparsity_collect")`. A tool omitted from Code Mode's inline declarations can still be discovered and called.

Pi's built-in tool guidance comes from its registrations. The package also ships the portable skill; it prefers native tools when they are available.

## Scope and limitations

Depth, file, node, and time limits bound each search or traversal. When a tool stops early, it reports unfinished scopes and unresolved relationships so the agent knows where to follow up. The collector reports setup time and total wall time separately. Its traversal budget doesn't interrupt initial parser, index, or compiler setup.

Call resolution is static. A matching name, especially in Ruby, doesn't prove which method gets called at runtime. Labels distinguish exact declarations from candidates, ambiguous matches, and unresolved calls. The tools find tests that reference the code, but don't run them or establish coverage. They also omit common library operations, so zero unresolved edges doesn't mean they found every runtime call.

Context collection defaults to the nearest component root within the working directory. Use `cwd` to select another checkout. For a diff, omitting `root` or passing `.` keeps separate component roots; an explicit path narrows the scan. Files absent from a sparse checkout aren't searchable.

For committed ranges, changed files come from the range's head. Callers, tests, and unchanged files come from the checkout. The manifest records which revisions it used.

Large TypeScript projects can use a lot of memory. Building a compiler program for one recorded 5,800-file import closure took about two seconds and 1 GB. Those numbers describe that workload, not a resource limit.

## Evaluation

The [public evaluation](https://github.com/dantetekanem/pi-agentic-search/blob/main/docs/evaluation.md) compares search results on 15 frozen Pi, Rails, and Zod cases, including six holdouts. Its [baseline report](https://github.com/dantetekanem/pi-agentic-search/blob/main/docs/benchmarks/real-baseline.json) records:

| Measure | Raw rg | Full search |
| --- | ---: | ---: |
| Correct first file, positive cases | 6/12 | 11/12 |
| Correct first span, positive cases | 5/12 | 10/12 |
| Valid negative misses | 3/3 | 3/3 |

These cases were selected manually. They measure search quality, not how many tool round-trips the extension saves in general. Two Zod ranking/span limitations remain; the evaluation documents them alongside the feature ablations and model runs.

The [synthetic benchmarks](https://github.com/dantetekanem/pi-agentic-search/blob/main/docs/benchmark.md) check ranking and execution behavior. Exact-file searches without related expansion use one ripgrep process and no path listing, including in fixtures with 7,999 unrelated files.

Use `/agentic-search-stats` in Pi to inspect recent context-tool runs, or `/agentic-search-stats 10` for the last ten.

## Data access

The extension makes no direct network requests. It reads local source and configuration, runs ripgrep and Git, and writes context packs, metrics, Ruby index caches, and oversized output. Packs contain source snippets.

The [runtime access document](docs/access.md) describes search's filesystem and subprocess access. Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## Other installation options

Install from GitHub:

```bash
pi install git:github.com/dantetekanem/pi-agentic-search
```

Or use a local checkout:

```bash
git clone https://github.com/dantetekanem/pi-agentic-search.git
cd pi-agentic-search
npm ci
pi install .
```

## Development

This repository uses npm and `package-lock.json` for development, CI, and publishing. Use Node.js 22, as CI does, with `rg` on your `PATH`. Keep dependency changes in `package.json` and `package-lock.json` together; don't maintain a second lockfile.

```bash
npm ci
npm run check
npm test
npm run smoke
npm run benchmark -- --samples 15 --check --output /tmp/search-benchmark.json
```

The `build` script compiles the standalone CLI. `prepack` runs it before packaging. The `test:cli` script builds and checks the CLI against Pi results, argument errors, and execution without Pi packages. The regular test script also builds before running tests.

The smoke command covers search, call cycles, committed-range context, the language adapters, cached Ruby indexing, and boundary ranking. Write new benchmark runs to a separate output file.

Public-source and opt-in model measurements have separate [reproduction instructions](https://github.com/dantetekanem/pi-agentic-search/blob/main/docs/evaluation.md#reproduction). Normal tests don't make live model requests.

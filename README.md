# pi-agentic-search

`pi-agentic-search` ranks `rg` matches and tells Pi which file to read first. It was inspired by Entire's `pgr` article.

## Try without installing

```bash
pi -e npm:pi-agentic-search
```

This runs the published package for the current Pi invocation without adding it to your project configuration.

## Install

```bash
pi install npm:pi-agentic-search
```

Then reload Pi:

```text
/reload
```

The extension requires `rg` (`ripgrep`) on your `PATH`.

## Usage

Use `agentic_search` to locate files, classes, scopes, methods, and call sites:

```text
agentic_search query="remaining_value" context="actual goal progress"
```

Parameters:

- `query`: code syntax, a regular expression, or literal text. Search for the construct rather than the full request. For Rails scopes, use `scope\s+:`.
- `context`: optional words used to rank matches without changing the `rg` query.
- `intent`: `definition`, `references`, `tests`, `file`, or `auto` (default). Use `definition` to follow an imported symbol to its declaration; `file` and `auto` preserve preference for a named navigation anchor.
- `path`: an optional exact path, filename, or partial path such as `event_occurrence.rb`.
- `max_files`: maximum ranked files to return. Defaults to 5 and accepts up to 10.
- `max_matches_per_file`: maximum snippets per file. Defaults to 10 and accepts up to 10.
- `expand_related`: includes related Ruby and Rails mixins, JavaScript and TypeScript imports, the owning package, and resolvable imported packages.
- `literal`: treats `query` as literal text instead of a regular expression.
- `case_sensitive`: `true` forces case-sensitive matching. `false` or omission uses ripgrep's smart-case behavior.

After the search, read the `TARGET FILE`. Use other candidates only when that file does not contain the requested context.

Check `coverage.status` before treating a miss as decisive. `complete` applies only to the reported pattern and scopes. For `partial` or `failed` coverage, inspect `unvisitedRoots`, unresolved imports/mixins, and the reported budget or error reasons. Built-in grep and shell search remain useful for exact confirmation or those unfinished scopes.

## How it works

### Search scope

- An existing exact file without related expansion uses one content-search process and no path listings.
- Filenames and partial paths are resolved against visible repository paths before content search. `max_files` limits displayed results, not the number of filename candidates searched.
- Repository-wide path listings are memoized within one request. There is no cache between requests.
- The target is searched before related discovery. Related files and scoped aliases come next, followed by package entries. Definition-oriented searches can stop widening after finding a declaration; references and tests still widen to the owning and imported packages. Unsearched package trees remain explicit partial coverage, even when an entry file answered the question.
- `expand_related` can continue through Ruby and Rails mixins, JavaScript and TypeScript relative imports, the owning package, and resolvable bare-package imports. Both language adapters share the same visible-path inventory and canonical source-text cache.
- Ruby lookup indexes constant definitions in conventional `app/` and `lib/` roots, plus literal `autoload_paths`/`eager_load_paths` additions using `root.join` or `%w` lists. Lexical namespace lookup precedes filename fallback. `include`, `prepend`, and `extend` retain their relationship in results.
- Ruby resolution is static discovery, not proof that a constant is loaded at runtime. It does not execute application configuration or dynamic mixin expressions; unsupported dynamic references and configuration are reported as unresolved or skipped.
- JS/TS lookup uses the extension's TypeScript dependency with the nearest `tsconfig.json` or `jsconfig.json`, including inherited options. Its public resolver handles source extension substitution, `paths`/`baseUrl`, `#imports`, package subpaths, export conditions, and `customConditions`. It does not create a typechecking program or enumerate configured source files.
- Related results include the compiler version, config path, import/require mode, and resolution provenance. The compiler is loaded from the extension, never from the searched repository. A different installed project compiler version is reported as a coverage limitation; compiler plugins and bundler configuration code are not executed.
- `definition` intent selects the compiler's API target, which can be a declaration file. Other intents prefer an implementation candidate. `declarationPath` and `implementationPath` distinguish the available targets. Implementation lookup uses a separate resolver host that omits declaration files; this is a source-navigation heuristic, not proof of runtime execution. See TypeScript's [extension substitution](https://www.typescriptlang.org/docs/handbook/modules/reference.html#file-extension-substitution) and [package exports](https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-exports) rules.
- Without a config, JS/TS resolution uses a labeled Bundler-mode default. Host-runtime fallback is limited to missing packages without project configuration; it does not override a project's blocked export. Host-only package-root fallback remains heuristic. Solution-project source redirects and bundler plugins are not resolved.
- Source parsing records named/default imports, local and re-export aliases, and literal CommonJS `require` bindings. Explicit `require` and dynamic `import()` calls select their matching package condition. Dynamic specifiers remain unresolved; comments and strings are not import declarations.
- For identifier queries, the graph follows relevant symbol names through canonical file and package-entry paths, including workspace symlinks and cyclic re-exports. Related details retain edge bindings and scoped `symbolSearches`. Scoped content searches use the original query plus discovered names, so `import { original as run }` can lead a search for `run` to `original`. A combined file rescan replaces its previous summary rather than counting overlapping lines twice; a failed rescan preserves the previous results and reports incomplete work. Original-query smart-case behavior is preserved, while discovered symbol names are matched case-sensitively. Binding discovery is syntactic; it does not establish runtime values or lexical shadowing.

### Ranking

- Definition intent puts declaration evidence ahead of callers, even when the caller is the named file. Reference intent prefers reference evidence; test intent favors test paths.
- JS/TS and Ruby classification compares rg's byte spans with declaration names on the matching line. Calls in another symbol's initializer or body are not declarations. Imports, inline strings, and comments receive separate classifications; Rails scopes count as definitions.
- This is lexical matching, not a full parser. Multiline lexical context and dynamic declarations are not established. Broad construct regexes use declaration-span overlap or recognized prefixes; other languages retain line-pattern heuristics, identified in the evidence.
- Content evidence sorts above path-only evidence without a score offset. Source paths receive a small boost. Test/generated/vendor penalties are conditional on intent and explicit scope.
- Context words use identifier boundaries, including camel-case and underscore splitting. With context supplied, ranking reads at most eight candidate prefixes of 64 KiB each. Each retained match gets at most 512 bytes from its two neighboring lines on either side. Candidates not enriched are marked `contextRead: unavailable`.
- Snippets prefer evidence relevant to the intent and suppress neighboring redundant hits, while retaining adjacent distinct declarations.
- Results expose the evidence tier, declaration/reference counts, classification basis, and number of competing candidates in that tier. These describe visited evidence, not calibrated probabilities, and do not change when `max_files` changes.

Scoring is in `src/ranking.ts`; declaration and snippet classification is in `src/evidence.ts`.

### Output and fallbacks

- The highest-ranked result is labeled `TARGET FILE` and includes its best snippet.
- Rails scopes receive scope-specific formatting.
- Invalid regular expressions are retried as literal text and reported in the output.
- A resolved path hint counts as searched coverage, not as a code match.
- Missing result counts fall back to the text summary when rendering.
- Output beyond Pi's 2,000-line or 50KB display limit is saved to a file.
- Batch and live retrieval share a ripgrep JSON decoder. Ripgrep validates regex syntax; only a regex compilation error triggers literal fallback.
- Retrieval visits up to 10,000 matching files within a 30-second request deadline. It keeps per-file counts, up to 16 snippets per file, 1,024 bytes per snippet line, and at most 8 MiB of serialized snippet payload. Individual rg JSON records are capped at 1 MiB. Reaching a retrieval/event budget produces partial coverage; snippet omission is reported separately without turning a completed search into a miss.
- Relative search roots are batched in groups of 32. At most 20 imported package trees are selected and at most three are searched concurrently. Alias rescans run sequentially and retain one previous-file snapshot, capped by the same 8 MiB snippet limit, until replacement succeeds. `coverage.runs[].stage` and `coverage.executionLimits` report stages and execution caps.
- The deadline uses a monotonic clock and is checked during output consumption, traversal, ranking preparation, and before/after formatting. Cancellation stops active children and prevents queued package searches from starting. An interrupted request can return a short summary instead of formatting every candidate; synchronous parsing and individual filesystem operations remain cooperative rather than preemptible.
- Path inventories are request-local and capped at 10,000 entries per inventory. Repository searches and graph inventories use rg ignore rules and the same explicit exclusions; imported-package searches use a separate policy and `--no-ignore`.
- Related traversal caps visited file/symbol states at 200, reference edges at 500, distinct related targets at 50 (up to 25 Ruby targets), and source/manifest reads at 500. Source prefixes are capped at 256 KiB, manifest/config reads at 64 KiB, and cached text at 8 MiB. Canonical and stat caches each allow 10,000 entries. Ruby indexing allows 16 autoload roots and 64 lexical nesting levels. Concurrent reads reserve the shared text budget before reading.
- Symbol metadata keeps up to 32 bindings per edge, 32 propagated symbols per file, and 200 scoped symbol searches. Relevant bindings precede unrelated ones when truncation is necessary; skipped metadata is reported. `visitedStates` distinguishes graph work from distinct `visitedFiles`.
- The compiler host shares those filesystem budgets. It allows 10,000 cached/pending facts, 64 passes per config/module lookup, and 2,000 passes per request. Filesystem reads are asynchronous; provisional misses invalidate the affected module-resolution cache before another pass. Cancellation is cooperative between compiler passes and filesystem operations.
- `related.traversal` reports these limits, visited files, reads, bytes, inventories, compiler passes, and known omitted edge/file candidates. Diagnostics retain up to 128 reasons; omission counts continue after that list fills. Unknown relationships beyond a truncated source remain uncertain, not certified absent.

## Examples

### Rails scopes in a named file

User request:

```text
Add predicates for the scopes in event_occurrence.rb.
```

Tool call:

```text
agentic_search query="scope\\s+:" path="event_occurrence.rb"
```

Example result:

```text
agentic_search: "scope\\s+:" — 1 ranked file from 4 matches
TARGET FILE: app/models/event_occurrence.rb. Read this file first; use other ranked candidates if it lacks the requested context.

1. app/models/event_occurrence.rb (score 406, 4 matches, evidence definition; declaration-span; 0 competing candidates) — primary target, exact filename match "event_occurrence.rb", path matches query tokens: event, occurrence, rb, content match
   L2 [scope] scope :upcoming, -> { where("date >= ?", Date.current).order(:date) }
   L3 [scope] scope :past, -> { where("date < ?", Date.current).order(date: :desc) }
   L4 [scope] scope :by_date_range, ->(start_date, end_date) { where(date: start_date..end_date) }
   L5 [scope] scope :with_budget, -> { where.not(budget_cents: nil) }

Next step: read the TARGET FILE first; coverage applies only to the reported pattern and scopes.
```

### Disambiguation with context

```text
agentic_search query="remaining_value" context="actual goal progress"
```

`rg` searches only for `remaining_value`. The context can move matches containing `actual`, `goal`, or `progress` above unrelated finance and payment matches.

### Related code in one call

```text
agentic_search query="filterMap" path="pi-work-context/index.ts" context="existing utility for extracting text response parts" expand_related=true
```

The search reads the target first, follows relative imports and aliases, and checks resolved package entries before scanning whole packages. If those files do not define the utility, it widens to the owning package and imported package trees. The result ranks the available evidence and reports which scopes were searched or left unfinished.

## Performance

Run the [committed benchmark](docs/benchmark.md) with `npm run benchmark`. Its original baseline records the reviewed implementation's failures, not the performance of the current code. The [ranking report](docs/benchmarks/ranking.json) passes all 14 synthetic runs and reports top-1 accuracy and MRR separately for each intent. The [execution report](docs/benchmarks/execution.json) also passes all 14 runs at 15 samples each; its exact-file cases use one process and zero listings with both zero and 7,999 unrelated files. These regression fixtures are development evidence, not a representative quality estimate. Record new runs to a different output file.

The [public evaluation](docs/evaluation.md) adds 15 frozen Pi, Rails and Zod cases, including six holdouts. Its [baseline report](docs/benchmarks/real-baseline.json) records:

| Measure | Raw rg | Full search |
| --- | ---: | ---: |
| Correct first file, positive cases | 6/12 | 11/12 |
| Correct first span, positive cases | 5/12 | 10/12 |
| Valid negative misses | 3/3 | 3/3 |

These manually selected cases are not a general accuracy estimate. Two Zod ranking/span limitations remain. The guide documents those failures, five feature ablations and nine successful model conditions on three seeded tasks; model success does not erase a ranking failure.

Exact-file searches issue one rg process regardless of unrelated file count. Basename hints require a visible-path scan; broad content searches start without waiting for a repository listing. Counts and coverage remain independent of output limits.

Sparse checkouts reduce the searchable tree because ripgrep only sees checked-out files.

## Security and data access

Read [SECURITY.md](SECURITY.md) for private vulnerability reporting and [docs/access.md](docs/access.md) for the exact ripgrep subprocess, filesystem, temporary-output, and network behavior.

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

npm is the supported package workflow. `package-lock.json` is authoritative for development, CI and publishing; do not maintain a second lockfile. Use Node.js 22, as CI does, and have `rg` on PATH.

```bash
npm ci
npm run check
npm test
npm run smoke
npm run benchmark -- --samples 15 --check --output /tmp/search-benchmark.json
```

Keep dependency changes in `package.json` and `package-lock.json` together. Public-source and opt-in model measurements have separate [reproduction instructions](docs/evaluation.md#reproduction); normal tests do not make live model requests.

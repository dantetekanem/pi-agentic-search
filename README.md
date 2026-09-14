# pi-agentic-search

Pi extension for agent-oriented local code search, inspired by Entire's `pgr` article about improving search workflows in coding agents.

`agentic_search` shells out to `rg`, then ranks, groups, and formats results so a coding agent can choose the next file to read with less unnecessary exploration.

## Why this extension exists

Coding agents are good at following instructions, but ordinary search output often encourages the wrong workflow:

1. run a broad search
2. inspect several plausible files
3. check sibling models, tests, fixtures, migrations, or git status
4. eventually return to the file that was probably obvious from the first result

That extra exploration is expensive in tokens, latency, and attention. `agentic_search` is designed to make the next step obvious: search once, identify the best target file, read that file, and stop discovery when the requested construct is present.

The extension does not replace `rg`. It uses `rg` for fast local search, then adds agent-oriented ranking and output conventions on top.

## Why it works

`agentic_search` improves agent behavior by combining several small constraints that are useful together:

- it asks for a precise construct query instead of a whole natural-language request
- it accepts optional natural-language `context` only as a ranking/disambiguation hint
- it accepts an optional path hint, such as a filename or partial path, and resolves likely files internally
- it ranks implementation files above tests, fixtures, generated files, build output, vendor files, and lockfiles
- it boosts definition-like matches, such as functions, classes, types, Ruby classes, Rails scopes, Rust functions, Go types, and similar declarations
- it groups matches by file instead of returning a flat stream of lines
- it labels the best result as `TARGET FILE`
- it tells the agent to read only that target file before editing when the requested construct matches are present
- with `expand_related`, it completes the relevant target, owning-package, and imported-package discovery inside the same tool call
- it distinguishes real code matches from path hints and returns a decisive, coverage-backed miss instead of sending the agent to another search tool
- it includes confidence values across returned candidates
- it retries invalid regular expressions as literal text, so useful searches do not fail just because a query contains characters like `{`

The important part is not the scoring alone. The important part is that the result format teaches the agent a shorter workflow.

## Tool

- `agentic_search` — preferred ranked search for locating files, classes, scopes, methods, and call sites across a repository.

Parameters:

- `query` — precise code syntax regex or literal string to search for. Prefer construct syntax over the whole user prompt. For Rails scopes, use `scope\s+:`.
- `context` — optional natural-language disambiguation hint used only for ranking, not for the ripgrep search query; for example `actual goal progress`.
- `path` — optional exact path, filename, or partial path hint, such as `event_occurrence.rb`.
- `max_files` — maximum ranked candidate files to return. Defaults to 5, maximum 10.
- `max_matches_per_file` — maximum snippet matches per file. Defaults to 10, maximum 10.
- `expand_related` — complete related discovery in one call: Ruby/Rails mixins; JS/TS relative imports, the owning package, and resolvable imported package surfaces when the focused files do not answer the query.
- `literal` — treat `query` as a literal string instead of a regex.
- `case_sensitive` — use case-sensitive matching. Defaults to ripgrep smart-case behavior.

By default, `agentic_search` returns ranked files. After `agentic_search`, the usual next step is to use Pi's built-in `read` tool on the target path.

Built-in grep and shell search remain useful for narrow exact confirmation in a known file. They are not a follow-up discovery step after `agentic_search` reports its one-call coverage.

### `sparsity_collect`

Bounded call-context collection for one Ruby or JS/TS definition. Give it a `path:line` inside a method, scope, function or component and it returns:

- the enclosing definition (start/end lines, symbol, kind, a sha256 fingerprint of its text, and a snippet of `vicinity_check` lines around the anchor line, bounded by the definition);
- the calls inside it resolved to definitions up to `max_depth` hops, each edge marked `exact`, `static_candidate`, `ambiguous`, `unresolved` or `external`, with a note explaining why;
- static callers of the anchor within the root (depth 1, capped);
- cycles, the unexpanded frontier, and coverage (root, depth reached, node/edge counts, ripgrep calls, elapsed time, and what truncated the walk).

Resolution is static, not runtime. Ruby is parsed with [Prism](https://github.com/ruby/prism) (`@ruby/prism`, WASM): exact definition ranges for methods, setters, endless and singleton defs, `class << self`, DSL declarations (`scope`, `attr_*`, `has_many`, `delegate`, `validates`, GraphQL `field`, ...), value constants and test blocks; every call site carries its receiver kind and, when known, the receiver type. Types come from an inference ladder and the edge says which rung answered: `typed` (Sorbet `sig`, inline RBS `#:`, YARD `@param`), `assigned` (`x = Foo.new`, `Foo.find`, `Foo.for_*`), `ivar` (set in `initialize`), `named` (variable name `legal_entity` → `LegalEntity`, a guess), `self`/`lexical` (owner and nesting), `constant`, `same_file`, `name_only` (a root-wide name match). Methods resolve through the receiver's ancestor chain (superclass and mixins) using a per-component index of every Ruby definition, built once per git tree hash (about 2 s for 3,000 files, 0.3 s from cache, gzipped) and overlaid with dirty and untracked files. Callers and tests come from the same index's inverse call map, which excludes strings, comments and imports by construction. A constant or receiver outside the component root is `external`, with the missing namespace named. If Prism fails to load, the regex engine below takes over.

TypeScript and JavaScript use the `typescript` compiler API. Definitions come from the AST (functions, arrow and wrapped components, classes and methods, interfaces, types, enums, module-level constants, `describe`/`it` blocks, CommonJS `module.exports`). For each run, one program per nearest `tsconfig.json` is created with the changed files as roots (about 2 s and 1 GB for a 5,800-file import closure; at most four programs per run), and the type checker resolves every call, `new` and JSX tag to its declaration: `paths` aliases, workspace symlinks, barrels and re-exports, `require()` in JS. Declarations in `node_modules` are `external` with the package name; built `.d.ts` files inside the repository are `exact` with a note; TypeScript's own `lib` methods are dropped; closures over locals are `local`. Callers are ripgrep candidates confirmed by the AST, so imports, strings and comments never count.

Without an index or program (very large roots, test-only roots, a failed program) Ruby methods resolve through `def name`, `def self.name`, and declarative definitions. Constants follow the Zeitwerk path convention first (`Billing::PlanSummaries::Builder` → `**/billing/plan_summaries/builder.rb`), then `class`/`module` declarations in the right namespace, then value constants inside the parent (`BillingPeriod::Monthly`). `Const.new(args).method` chains keep their receiver. JS/TS follows relative imports and barrel re-exports; non-relative imports are reported as `external` with the package name; local `const` values are reported as locals, not definitions.

The search root defaults to the nearest component root above the target (`component.yml`, a gemspec, `package.json`, `Gemfile`, or `.git`), never above the working directory. Anything outside that root is reported as outside it, with the namespace that was missing. Pass `root` to widen on purpose.

Parameters:

- `target` — `path:line`, required.
- `max_depth` — call hops to follow. Default 3, maximum 4.
- `vicinity_check` — context lines around each anchor line. Default 20, maximum 60.
- `max_nodes` — hard cap on definitions returned. Default 24, maximum 60.
- `root` — search root override, inside the working directory.
- `callers` — include static callers of the anchor. Default true.
- `budget_ms` — total ripgrep time budget. Default 20000, maximum 60000.

Typical cost on a large monorepo component: 10–40 ripgrep calls and under two seconds. Ruby destinations are static candidates: a matching `def` is not proof that dynamic dispatch reaches it.

### `sparsity_index`

One call for a whole diff. Give it a git range (`base..head`, `base...head`, a single commit) or `worktree` for uncommitted changes including untracked files, and it returns a ranked context pack:

1. Manifest: revision, roots, every changed file classified as code, test, generated or other, the changed definitions (anchors) with caller and test counts, and a table of sections with line ranges in `pack.md`, token estimates, and whether each is inline or spilled.
2. One section per changed definition: windows of `vicinity_check` lines around every changed line with a `+|` gutter mark on added or modified lines, the removed old lines of overlapping hunks with `-|` and their old line numbers, the calls inside it resolved as in `sparsity_collect` (call sites nearest the change first), production callers (flagged when the caller itself changed in this diff), and tests that reference the symbol by name.
3. Definitions removed by the diff whose callers still exist on the new side.
4. Direct callees with signature plus first lines, an end recap of unresolved edges, external packages, cycles, skipped anchors and the frontier, then depth-2 signatures.

The pack goes to `pack.md` and `pack.json` in `output_dir`. Sections beyond `inline_budget_kb` are spilled whole; the inline text carries a stub with the line range to read. Anchors are ordered by band (production definitions, then tests, types and declarations) and, within a band, by boundary relevance: path structure (controllers, GraphQL, jobs, middleware, webhooks, API clients, entrypoints, migrations), domain words in identifiers (auth, secrets, tenant, money, destructive data), and failure-path words in the body (transaction, retry, rescue, async). Callers are ordered changed-in-this-diff first, then by the same relevance. The tags that fired appear in brackets in the manifest so the order can be checked. Ruby, TypeScript and JavaScript are covered; other files are listed, not expanded.

Parameters: `cwd` (repository checkout; default the session's), `diff` (default `worktree`), `anchors` (path:line list instead of a diff), `max_depth` (default 2), `vicinity_check` (20), `max_nodes` (120 callee definitions; callers and tests have per-anchor caps), `max_anchors` (60), `root`, `budget_ms` (30000), `output_dir`, `inline_budget_kb` (40).

Each run writes `metrics.json` next to the pack (timing, ripgrep calls, anchors, nodes, edges, resolution and label counts, unresolved rate per language, inline versus spilled tokens, index cache hits, program costs) and appends one line to `sparsity/metrics.jsonl` under the Pi agent directory. `/agentic-search-stats [N]` summarizes the last N runs.

Measured on a 72-file Ruby and TypeScript PR in a large monorepo: 60 anchors, 337 definitions, 589 edges (181 resolved by the TypeScript checker), 44 unresolved, 11 s with warm caches.

## Examples

### Rails scope request with a named file

User request:

```text
Add predicates for the scopes in event_occurrence.rb.
```

Recommended tool call:

```text
agentic_search query="scope\\s+:" path="event_occurrence.rb"
```

Example result:

```text
agentic_search: "scope\\s+:" — 1 ranked file from 4 matches, confidence sum 1.000
TARGET FILE: app/models/event_occurrence.rb. Read this file first; use other ranked candidates if it lacks the requested context.

1. app/models/event_occurrence.rb (score 113, confidence 1.000, 4 matches) — 4 matches, source file, implementation path
   L2 [scope] scope :upcoming, -> { where("date >= ?", Date.current).order(:date) }
   L3 [scope] scope :past, -> { where("date < ?", Date.current).order(date: :desc) }
   L4 [scope] scope :by_date_range, ->(start_date, end_date) { where(date: start_date..end_date) }
   L5 [scope] scope :with_budget, -> { where.not(budget_cents: nil) }

Next step: read only the TARGET FILE, then propose the edit from that file. Discovery is complete for the reported one-call coverage; do not repeat it with grep, find, or shell search.
```

Why this is better: the agent does not need to inspect `goal_step.rb`, fixtures, tests, migrations, or git status before proposing the edit. The file and the relevant scope lines are already identified.

### Ranking implementation above tests

Given these matches:

```text
test/widget.test.ts:5: expect(renderWidget()).toBeTruthy();
src/widget.ts:1: export function renderWidget() {
src/widget.ts:7: return new Widget();
```

`agentic_search` ranks `src/widget.ts` first because it is a source file, contains a definition-like match, and has multiple relevant matches. The test file is still available as a lower-ranked candidate when more context is needed, but it does not distract the first read step.

Example result shape:

```text
TARGET FILE: src/widget.ts. Read this file first; use other ranked candidates if it lacks the requested context.

1. src/widget.ts (score 87, 2 matches) — 1 definition-like match, 2 matches, source file, implementation path
   L1 [def] export function renderWidget() {
   L7 [ref] return new Widget();
```

### Natural-language disambiguation

When the same code name appears in multiple domains, keep `query` as the exact syntax or literal and pass domain words as `context`:

```text
agentic_search query="remaining_value" context="actual goal progress"
```

`rg` still searches only for `remaining_value`. The `context` words can lift files or matched snippets containing `actual`, `goal`, or `progress` above competing finance/payment matches.

### Path-only discovery

When the user or prompt already names a file, `agentic_search` can use that as the query:

```text
agentic_search query="event_occurrence.rb"
```

In the smoke test fixture, this ranks `app/models/event_occurrence.rb` above `test/fixtures/event_occurrences.yml` because implementation paths and source files are more useful first-read targets than fixtures.

### One-call utility and dependency discovery

When the agent needs to find an existing utility from a named JS/TS file, use one scoped call:

```text
agentic_search query="filterMap" path="pi-work-context/index.ts" context="existing utility for extracting text response parts" expand_related=true
```

The call first checks the target and its relative imports. If those files do not provide a definition, the same execution searches the owning package and any resolvable bare-package imports. The result either ranks the applicable definition or reports the exact searched coverage and a decisive miss. A resolved path hint is never counted as a code match, so the agent has no reason to repeat discovery with grep or shell `rg`.

### Invalid regex fallback

Some useful code queries are not valid regular expressions. For example:

```text
agentic_search query="sig {"
```

If ripgrep rejects the regex, `agentic_search` retries as a literal string and adds a notice to the output. The agent still gets a useful result instead of stopping on a regex parse error.

## Main improvements

Compared with plain `rg` output, `agentic_search` adds:

- ranked file candidates instead of an ungrouped stream of matching lines
- a clear `TARGET FILE` instruction for the next read step
- scoring for source files, implementation paths, filename matches, and definition-like lines
- penalties for tests, fixtures, mocks, generated files, vendor directories, build output, and lockfiles
- path-hint resolution for prompts that name a file without an exact repository path
- path hints treated as coverage rather than fake code matches on scoped misses
- one-call fallback across the owning package and resolvable imported packages
- normalized confidence values across returned candidates
- scope-specific rendering for Rails scope matches
- defensive result rendering when tool details are missing or malformed
- literal fallback for invalid regex queries
- truncation with a saved full output file when results exceed Pi output limits

The practical improvement is behavioral: agents spend less time proving they can search and more time reading the one file that matters.

## Performance notes

`agentic_search` still uses ripgrep, so exact-path searches stay fast. In synthetic benchmark runs:

- 8,000 files and 385,602 lines: exact path search took about 25 ms; basename path hint search took about 72 ms; broad no-path scope search took about 177 ms.
- 34,600 files and 2,213,002 lines: exact path search took about 26 ms; basename path hint search took about 308 ms; broad no-path scope search took about 850 ms.

Path hints matter. Exact paths let ripgrep search one file. Basename hints require scanning visible paths before content search. Broad searches still scan broad content and can produce large JSON output.

Sparse checkouts help because ripgrep only sees the sparse working tree.

## Ranking heuristics

`agentic_search` ranks results using simple lexical heuristics:

- definition-like lines score higher than plain references
- source extensions score higher than miscellaneous files
- implementation paths such as `src/`, `app/`, `lib/`, `packages/`, and `core/` score higher
- tests, fixtures, mocks, generated files, vendor, build output, and lockfiles score lower
- optional `context` tokens can boost matching file paths or snippets without changing the ripgrep query
- results are grouped by file and trimmed to a small number of snippets per file
- compact rendering shows the target file path and top snippet
- invalid regex queries are retried as literal text, so searches like `sig {` still produce a normal search result

## Try it once

```bash
pi -e git:github.com/dantetekanem/pi-agentic-search
```

Then ask Pi to use `agentic_search`, for example:

```text
Search for where checkpoint commits are written using agentic_search.
```

## Install as a Pi package

Install directly from GitHub:

```bash
pi install git:github.com/dantetekanem/pi-agentic-search
```

Then reload Pi:

```text
/reload
```

You can also install from a local checkout:

```bash
git clone https://github.com/dantetekanem/pi-agentic-search.git
cd pi-agentic-search
npm install
pi install .
```

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run check
npm run smoke
```

`npm run smoke` runs the ranking smoke test, the `sparsity_collect` fixture test (a temporary Ruby and TS repository with a call cycle, an unresolved attribute, a barrel re-export and an external package), and the `sparsity_index` test (a temporary git repository with a modified method, an added method, a removed definition that still has callers, a changed test, a worktree edit and an untracked file).

## Notes

- Requires `rg` (`ripgrep`) on PATH.
- Tool output uses Pi truncation limits: 2000 lines or 50KB, whichever comes first.
- Scoring weights are defined in `src/extension.ts`.
- Optional `expand_related` resolves Ruby/Rails mixins and JS/TS relative imports from both file and directory roots. On a scoped JS/TS miss it also searches the owning package and resolvable bare-import package surfaces inside the same tool execution.
- Exact-path searches skip the repo-wide file listing for lower latency.
- Within a single request, repeated repo-wide path listings are memoized to avoid redundant ripgrep spawns (no cross-request cache).
- Invalid regex queries are pre-validated and retried as literal text without paying a failed ripgrep spawn.
- Streaming JSON parsing avoids large-buffer limits on huge result sets.

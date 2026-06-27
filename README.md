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
- `literal` — treat `query` as a literal string instead of a regex.
- `case_sensitive` — use case-sensitive matching. Defaults to ripgrep smart-case behavior.

By default, `agentic_search` returns ranked files. After `agentic_search`, the usual next step is to use Pi's built-in `read` tool on the target path.

Built-in grep and shell search remain useful for narrow exact checks and confirming text in a known file.

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
TARGET FILE: app/models/event_occurrence.rb. Read only this file before editing when it contains the requested construct matches.

1. app/models/event_occurrence.rb (score 113, confidence 1.000, 4 matches) — 4 matches, source file, implementation path
   L2 [scope] scope :upcoming, -> { where("date >= ?", Date.current).order(:date) }
   L3 [scope] scope :past, -> { where("date < ?", Date.current).order(date: :desc) }
   L4 [scope] scope :by_date_range, ->(start_date, end_date) { where(date: start_date..end_date) }
   L5 [scope] scope :with_budget, -> { where.not(budget_cents: nil) }

Next step: read only the TARGET FILE, then propose the edit from that file. Do not inspect alternate candidates, sibling models, tests, migrations, git status, or run more searches unless the target file lacks the requested construct matches.
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
TARGET FILE: src/widget.ts. Read only this file before editing when it contains the requested construct matches.

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

## Notes

- Requires `rg` (`ripgrep`) on PATH.
- Tool output uses Pi truncation limits: 2000 lines or 50KB, whichever comes first.
- Scoring weights are defined in `index.ts`.

# pi-agentic-search

`pi-agentic-search` ranks `rg` matches and tells Pi which file to read first. It was inspired by Entire's `pgr` article.

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
- `path`: an optional exact path, filename, or partial path such as `event_occurrence.rb`.
- `max_files`: maximum ranked files to return. Defaults to 5 and accepts up to 10.
- `max_matches_per_file`: maximum snippets per file. Defaults to 10 and accepts up to 10.
- `expand_related`: includes related Ruby and Rails mixins, JavaScript and TypeScript imports, the owning package, and resolvable imported packages.
- `literal`: treats `query` as literal text instead of a regular expression.
- `case_sensitive`: enables case-sensitive matching. The default is ripgrep's smart-case behavior.

After the search, read the `TARGET FILE`. Use other candidates only when that file does not contain the requested context.

Built-in grep and shell search are still useful for exact confirmation inside a known file. They should not restart discovery after `agentic_search` has already reported its coverage.

## How it works

### Search scope

- Exact paths search one file and skip the repository-wide path listing.
- Filenames and partial paths are resolved against visible repository paths before content search.
- Repository-wide path listings are memoized within one request. There is no cache between requests.
- `expand_related` can continue through Ruby and Rails mixins, JavaScript and TypeScript relative imports, the owning package, and resolvable bare-package imports.

### Ranking

- Definitions score above references. Recognized definitions include functions, classes, types, Ruby classes, Rails scopes, Rust functions, and Go types.
- Source files and implementation paths such as `src/`, `app/`, `lib/`, `packages/`, and `core/` receive a boost.
- Tests, fixtures, mocks, generated files, vendor directories, build output, and lockfiles receive a penalty.
- Context tokens can raise matching paths or snippets without changing the search query.
- Results are grouped by file, trimmed to a small number of snippets, and assigned normalized confidence values.

Scoring weights are defined in `src/extension.ts`.

### Output and fallbacks

- The highest-ranked result is labeled `TARGET FILE` and includes its best snippet.
- Rails scopes receive scope-specific formatting.
- Invalid regular expressions are retried as literal text and reported in the output.
- A resolved path hint counts as searched coverage, not as a code match.
- Missing or malformed tool details do not break result rendering.
- Output beyond Pi's 2,000-line or 50KB display limit is saved to a file.
- Streaming JSON parsing avoids large-buffer limits on large result sets.

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
agentic_search: "scope\\s+:" — 1 ranked file from 4 matches, confidence sum 1.000
TARGET FILE: app/models/event_occurrence.rb. Read this file first; use other ranked candidates if it lacks the requested context.

1. app/models/event_occurrence.rb (score 113, confidence 1.000, 4 matches) — 4 matches, source file, implementation path
   L2 [scope] scope :upcoming, -> { where("date >= ?", Date.current).order(:date) }
   L3 [scope] scope :past, -> { where("date < ?", Date.current).order(date: :desc) }
   L4 [scope] scope :by_date_range, ->(start_date, end_date) { where(date: start_date..end_date) }
   L5 [scope] scope :with_budget, -> { where.not(budget_cents: nil) }

Next step: read only the TARGET FILE, then propose the edit from that file. Discovery is complete for the reported one-call coverage; do not repeat it with grep, find, or shell search.
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

The search starts with the target and its relative imports. If they do not define the utility, it continues through the owning package and resolvable bare-package imports. The result either ranks the definition or reports the searched coverage and a miss.

## Performance

Synthetic benchmark results:

- 8,000 files and 385,602 lines: about 25 ms for an exact path, 72 ms for a basename hint, and 177 ms for a broad search.
- 34,600 files and 2,213,002 lines: about 26 ms for an exact path, 308 ms for a basename hint, and 850 ms for a broad search.

Exact paths are faster because ripgrep can search one file immediately. Basename hints require a visible-path scan first. Broad searches scan broad content and can produce large JSON output.

Sparse checkouts reduce the searchable tree because ripgrep only sees checked-out files.

## Try without installing

```bash
pi -e git:github.com/dantetekanem/pi-agentic-search
```

Then ask Pi:

```text
Search for where checkpoint commits are written using agentic_search.
```

## Other installation options

Install from GitHub:

```bash
pi install git:github.com/dantetekanem/pi-agentic-search
```

Or use a local checkout:

```bash
git clone https://github.com/dantetekanem/pi-agentic-search.git
cd pi-agentic-search
pnpm install
pi install .
```

## Development

```bash
pnpm install
pnpm check
pnpm smoke
```

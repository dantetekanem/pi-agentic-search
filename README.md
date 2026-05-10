# pi-agentic-search

Pi extension for agent-oriented local code search, inspired by Entire's `pgr` article about improving search workflows in coding agents.

`agentic_search` shells out to `rg`, then ranks and formats results so a coding agent can choose the next file to read with less unnecessary exploration.

## Tool

- `agentic_search` — preferred ranked search for locating files, classes, scopes, methods, and call sites across a repository.

By default, `agentic_search` returns one ranked file. After `agentic_search`, the usual next step is to use Pi's built-in `read` tool on that target path.

Built-in grep and shell search remain useful for narrow exact checks and confirming text in a known file.

## Ranking heuristics

`agentic_search` ranks results using simple lexical heuristics:

- definition-like lines score higher than plain references
- source extensions score higher than miscellaneous files
- implementation paths such as `src/`, `app/`, `lib/`, `packages/`, and `core/` score higher
- tests, fixtures, mocks, generated files, vendor, build output, and lockfiles score lower
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

---
name: agentic-search
description: Find definitions, references and tests, trace Ruby/JavaScript/TypeScript calls, or gather context for a code review using the agentic-search CLI. Use when locating code or understanding a change before editing.
compatibility: Requires agentic-search on PATH, Node.js 22+, ripgrep, and Git for diff scans.
---

# Agentic search

Run from the repository, or add `--cwd /path/to/repo`. If native `agentic_search`, `sparsity_collect` and `sparsity_scan` tools are available, use those instead of the CLI.

Choose by starting point:

```bash
# Find a name, then read the recommended target.
agentic-search search 'remaining_value' --intent definition --context 'actual goal progress'

# Trace a definition and its calls.
agentic-search collect app/models/goal.rb:42 --max-depth 3

# Gather a whole diff once.
agentic-search scan --diff main..HEAD
```

Other search intents: `references`, `tests`, `file`. Narrow with `--path`; follow imports or Ruby mixins with `--expand-related`. Keep queries as code syntax and domain hints in `--context`. Quote patterns and paths. Use `scan --diff worktree` for uncommitted changes.

Read the scan manifest and anchors first. Follow printed `pack.md` line ranges only when needed. Use `collect` for deeper context on a specific definition, not every anchor again.

Inspect coverage, unresolved edges and the frontier. A partial search is not proof of absence; follow reported unvisited scopes. Ruby call matches are static candidates, not runtime proof. Tests found by name have not been run, and an empty tests list does not establish coverage.

Output is readable text. Use `--json` for `{text, details}`, or `<command> --help` for flags and limits. Exit 0 means a result was produced, not that coverage is complete. Packs and overflow files contain source; keep them local. If the command is missing, report it rather than installing software without authorization.

# Changelog

## 0.4.0 (unreleased)

### Added

- `sparsity_index`: one call per diff (`base..head`, `base...head`, a commit or `worktree`) that returns a ranked context pack: manifest, one section per changed definition with `+|` and `-|` marks, resolved calls with `[resolution, how]` labels, callers, tests by name, definitions removed with surviving callers, depth tiers and a recap of gaps; sections over the inline budget spill to `pack.md` with line ranges.
- `sparsity_collect`: bounded call context for one `path:line` with the same labels, callers, cycles and frontier.
- Ruby adapter on `@ruby/prism` with a per-component index cached by git tree hash; TypeScript and JavaScript adapter on the compiler API with one program per tsconfig; checker-resolved and inferred edges never share a label with name-only guesses.
- Boundary ranking of anchors and callers, per-run `metrics.json`, a rolling `sparsity/metrics.jsonl` log and the `/agentic-search-stats` command.
- Changed files are read at the range head when the checkout sits on another commit; the manifest says so in a `revision:` line.

## 0.3.0 (unreleased)

This version covers the search improvement stack (#1 through #9) and the Ruby lookup repair (#10).

### Added

- Search intents for definitions, references, tests, files and automatic navigation, with declaration evidence and bounded context ranking.
- Project-aware JavaScript and TypeScript resolution for configuration aliases, package exports/imports, workspace links and renamed re-exports, using the extension's trusted TypeScript compiler.
- Shared, bounded related-file traversal for JavaScript, TypeScript and Ruby, including conventional and literal-configured Ruby autoload roots.
- Reproducible synthetic benchmarks, a frozen public corpus, five feature ablations and an opt-in model navigation probe with public-source checks and a shared spending limit.

### Changed

- Retrieve candidates independently of display limits; existing exact-file searches without expansion avoid repository listings.
- Search targets, aliases and package entries before widening, with bounded concurrency, request deadlines and cancellation cleanup.
- Report evidence tiers and complete, partial or failed coverage instead of confidence-like labels.
- Use npm as the sole supported package workflow; remove the alternate pnpm lockfile and workspace configuration.

### Fixed

- Recover matches beyond the former first-200 cutoff and search every candidate for ambiguous path hints.
- Preserve native ripgrep regex behavior and smart-case matching, including renamed-symbol searches and the evaluation oracle's explicit `case_sensitive: false` handling.
- Keep counts and retained results intact when an alias rescan fails; deduplicate overlapping searches.
- Resolve Ruby mixins through actual lexical frames: `class Admin::User` does not invent `Admin` as an enclosing lexical scope.

### Known limitations

- The public corpus still contains Zod caller-ranking and constructor-span misses. Graph resolution is static and can report partial coverage; a useful result does not imply complete traversal.
- Curated measurements show retrieval and navigation gains, not universal speed, accuracy or token savings. See the [evaluation PR](https://github.com/dantetekanem/pi-agentic-search/pull/8) for results and limits.

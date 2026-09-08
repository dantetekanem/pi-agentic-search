# Changelog

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

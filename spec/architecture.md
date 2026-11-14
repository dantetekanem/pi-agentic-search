# Architecture and flows

This describes the revision and draft status in the [index](README.md).

## Entrypoints and ownership

[package.json](../package.json) requires Node 22+ and ships TypeScript and Prism as runtime dependencies. Pi integrations use optional host peers. The standalone CLI's [launcher](../bin/agentic-search.mjs) imports `dist/cli.js`; [src/cli.ts](../src/cli.ts) imports the shared implementations without importing the Pi registration modules. Building emits the CLI, not the searched project's code.

[index.ts](../index.ts) exports the default Pi extension and selected search/context helpers. [agenticSearchExtension](../src/extension.ts) registers `agentic_search` and calls `registerSparsityTools` for `sparsity_collect`, `sparsity_scan` and the stats command. The wrappers own schemas, host rendering, truncation and persistent paths. [context.ts](../src/context.ts) translates snake_case context inputs to core options and validates a requested repository directory.

```text
CLI main --------------------> search.runSearch
Pi agentic_search wrapper ---> search.runSearch
                                  | rg retrieval + optional related resolvers
                                  v
                               ranking + text/details

CLI / Pi context wrappers ---> collectContext / scanContext
                                  | Collector + language adapters
                                  v
                               graph/coverage or manifest + disk pack
```

`agentic_search` in Pi uses `ctx.cwd` at this revision; it has no separate `cwd` parameter. The CLI's three commands and both Pi context tools accept a repository override. Library results expose structured details; CLI JSON is `{text, details}`. The documented Pi Code Mode call returns text to its caller, not CLI JSON.

## Ranked search

[src/search.ts](../src/search.ts), `runSearch` / `executeSearch`:

1. Create one `SearchRequest`, then a `ProjectFiles` inventory and `SearchExecutor`. Resolve the optional path as a file, directory or ranked partial-path match; otherwise search the repository.
2. Search the target roots with rg. The code query remains regex/literal syntax. Intent and context influence retention/ranking rather than replacing that query.
3. With `expand_related`, choose named-file or bounded ranked seeds and traverse supported relationships in [related.ts](../src/related.ts). Search related roots and discovered symbol aliases. Under the exact-file expansion policy, search imported entrypoints, the owning root and bounded package roots. Report omitted seeds, unresolved relationships and unvisited scopes.
4. Rank retained evidence in [ranking.ts](../src/ranking.ts), optionally enriching it with bounded neighboring source reads. Format the selected files and snippets alongside coverage, process outcomes and fallback details.
5. Dispose the request timer and parent cancellation listener in `finally`.

[retrieval.ts](../src/retrieval.ts) owns a monotonic request deadline and bounded streamed rg JSON retention. [execution.ts](../src/execution.ts) owns search stages and at most three concurrent package searches. A rejected regex parse triggers a disclosed literal retry; unrelated process failures do not silently become literal searches. An alias rescan replaces a previous file summary only on success and restores it on failure.

[resolvers/compiler.ts](../src/resolvers/compiler.ts), `ProjectCompiler`, uses the package's TypeScript to resolve modules from project configuration. This ranked-search path does not build a typechecking program or execute project compilers/plugins. Configuration, manifests, imports and aliases are input data. The Ruby search resolver likewise reads supported declarations/configuration without executing Ruby. See [runtime access](../docs/access.md) for limits and external paths.

## Definition and diff context

[collectSparsity](../src/sparsity.ts) validates a `path:line` target, including real-path containment, selects the nearest component root and prepares the relevant language adapter. It finds the enclosing definition, expands queued static calls and optionally collects callers. Node IDs are local to a result; fingerprints describe definition content. Results carry snippets/vicinity, edge labels, cycles, a frontier and timing. Parser/compiler setup precedes the collect traversal budget and is reported separately.

The context adapters differ from search resolvers. [TsPrograms](../src/adapters/ts.ts) creates TypeScript programs/checkers for source relationships, which can read dependency closures outside the chosen expansion root. [ruby.ts](../src/adapters/ruby.ts) loads Prism; collection reports a regex fallback if that parser is unavailable. [buildRubyIndex](../src/adapters/ruby-index.ts) caches base facts keyed by repository/root/tree, then overlays dirty/deleted/untracked files and any supplied head content. A missing, invalid or incompatible cache is rebuilt; this is derived state, not source authority.

[scanSparsity](../src/sparsity-scan.ts) resolves a worktree diff, commit, two-dot range, merge-base three-dot range or explicit anchors. It classifies files and prioritizes changed production definitions, then expands them through collectors sharing the scan budget/node allowance. It gathers callers/tests and searches for remaining references to removed names. Generated or unsupported files retain changed hunks and vicinity without call expansion. Skipped anchors and capped work remain visible.

For committed ranges, changed source is read at the range head when checkout HEAD differs; callers, tests and unchanged source still come from the checkout. The manifest records head, base and checkout identities. This is mixed-revision context, not an isolated revision snapshot. Per-file component roots remain separate unless an explicit narrower root is supplied.

Scan rendering produces a manifest and ordered sections with line ranges. It writes `pack.md`, `pack.json` and metrics in the selected output directory, retaining inline sections up to a byte budget. Callers can fetch spilled sections without loading the entire pack.

## Access, storage and failure behavior

- Source access is local, but `cwd` is not a universal sandbox: explicit search roots, resolved packages, inherited compiler configuration, literal Ruby autoload roots and context compiler preparation can read outside it. Context target validation does not establish containment for every dependency read.
- Runtime subprocesses use argument arrays for rg/Git rather than building query shell commands. The extension makes no direct network requests. Local executables and the Pi host remain outside that guarantee. The opt-in development model probe is separate; it is not the runtime search engine.
- Pi context wrappers store indexes and metrics beneath `getAgentDir()/sparsity/`, with default scan packs there as well. CLI context commands use a per-command temporary Ruby index, removed in `finally`, and do not append Pi metrics. CLI packs default to fresh temporary directories. Explicit relative pack paths resolve against the selected repository.
- Packs and oversized-output files contain source, persist until removed and are not automatically redacted. A chosen scan directory's pack files can be overwritten. Collection metrics appends and scan metrics writing are best effort; pack writes themselves are awaited and can fail. Detailed access/retention behavior remains in [docs/access.md](../docs/access.md).
- Search distinguishes complete, partial and failed scopes. Complete coverage applies to the reported pattern/scopes, not every possible relationship. Static edges can be exact, candidates, ambiguous, unresolved or external; Ruby candidates do not prove runtime dispatch. Common library operations are omitted, and tests found by name are not executed coverage.
- The CLI catches usage/execution errors, writes diagnostics to stderr and handles SIGINT through an abort signal. Exit codes are 0 for a result, 1 for execution failure, 2 for invalid arguments and 130 for interruption. Partial results can exit 0. Text over 2,000 lines/50 KiB spills to a reported file; CLI JSON is not truncated. Pi wrappers apply host text truncation and report the overflow path.

## Presentation, verification and delivery

There is no web UI. [render.ts](../src/render.ts) uses Pi theme roles for call summaries, coverage warnings, the top target and expanded related results. Text formatting tells the agent which target to read and what coverage remains; it is part of navigation guidance rather than a claim of semantic correctness. Context rendering exposes manifest/section boundaries and source vicinity.

The [README](../README.md) owns setup and development commands. [CI](../.github/workflows/ci.yml) specifies Node 22, npm lockfile installation, rg, typecheck, tests and smoke checks. The [publish workflow](../.github/workflows/publish.yml) checks release tag/version agreement, typechecks and smoke-checks, then stages a public npm package with provenance. A workflow definition or successful stage does not establish public promotion or installed behavior. [Evaluation](../docs/evaluation.md) records frozen, manually selected cases and known ranking/span failures; those numbers are not general accuracy guarantees.

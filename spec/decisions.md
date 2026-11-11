# Decisions, trade-offs and open questions

This is a descriptive record for the [inspected revision](README.md), not new architecture approval. A source mechanism establishes what exists; it does not by itself establish why the author chose it.

## Choices supported by recorded evidence

| Choice | Evidence | Constraint or trade-off visible in that evidence |
| --- | --- | --- |
| Reduce repeated searches and file reads with ranked search and collected context. | The opening explanation in [README.md](../README.md); commit `52300fb`, "Rewrite README around fewer searches and file reads". | The [evaluation](../docs/evaluation.md) measures selected cases, not a universal reduction in agent round-trips. |
| Share runtime implementations between a standalone CLI and Pi. | Commit `b7f61e6`, "Add standalone agentic-search CLI and prepare 0.7.0"; [cli.ts](../src/cli.ts) imports search/context directly. | CLI artifacts, cleanup and exit codes differ from Pi's host-facing policy; not every wrapper parameter is identical. |
| Resolve JS modules using bounded project-configured TypeScript APIs. | Commit `55fc82b` with that subject; [ProjectCompiler](../src/resolvers/compiler.ts); [runtime access](../docs/access.md). | Project configuration affects resolution, but the package supplies the compiler. Search does not execute project compiler plugins or create a typechecking program. Context collection uses a different, heavier program/checker path. |
| Search targets and aliases before bounded package expansion. | Commit `c733d36`, "Search targets and aliases before bounded package expansion"; [executeSearch](../src/search.ts) and [SearchExecutor](../src/execution.ts). | Expansion is conditional and capped. A found definition does not imply complete package/relationship coverage. |
| Include surrounding source rather than isolated changed definitions alone. | Commit `fda2434` describes anchor vicinity, three caller-context lines and parser-less hunks; [scan rendering](../src/sparsity-scan.ts). | The surrounding source consumes pack space; unsupported files need manual caller/test inspection. |
| Keep one npm lockfile for development and CI. | [README development section](../README.md#development), [package.json](../package.json) and [CI](../.github/workflows/ci.yml). | Setup reproducibility depends on that graph and Node/tool availability; this draft did not install or validate it. |

These are recorded scopes or explicit documentation contracts, not retroactive claims that every alternative was considered or rejected.

## Inferred rationale, not confirmed decisions

The separation of Pi wrappers from shared search/context code appears to let the CLI avoid Pi runtime dependencies while preserving common behavior. The imports support that explanation; the maintainer has not confirmed it here as a permanent ownership rule.

Request-local inventories and bounded traversal appear to trade exhaustive graph discovery for predictable work and explicit gaps. Persistent Ruby base indexes with dirty overlays appear to avoid reparsing unchanged source. These are interpretations of [retrieval](../src/retrieval.ts), [related traversal](../src/related.ts) and [index construction](../src/adapters/ruby-index.ts), not fresh performance measurements or documented author intent.

## Questions for maintainer confirmation

1. Does the separation between ranked-search resolvers and context adapters reflect the intended boundary to preserve? The current source has both a bounded module-resolution path and a program/checker path; this draft documents rather than consolidates them.
2. Should `spec/` remain repository-only reference material, or should a later, separately approved packaging change include it in the npm artifact? The current `package.json` allowlist excludes it.

The existing [evaluation](../docs/evaluation.md) already records a Zod caller-ranking failure and a constructor-span failure. They remain documented limitations, not newly reproduced findings or authorization to change ranking. If returning callers ahead of definitions is the intended contract for reference searches, the smallest candidate correction is to revisit the declaration bonus for that intent, retaining the frozen labels and proving the affected case. This documentation item makes no such repair.

No other intended-design contradiction was established by this bounded inspection. Runtime dispatch, exhaustive resolution, current installation/deployment state and whether later branches change these boundaries remain unverified. Confirmation belongs to the rollout coordinator after local draft delivery; this worker does not file a duplicate question, edit the rollout ledger or turn the draft into an AGENTS.md rule.

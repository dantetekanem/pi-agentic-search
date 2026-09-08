# Public navigation evaluation

A search can return the right file but the wrong span, or find a definition when the task asks for a caller. This evaluation measures those outcomes separately. It also checks whether a model can use the results to finish a navigation task.

On the frozen public corpus, full search puts the correct file first in 11 of 12 positive cases and the correct span first in 10. Raw ripgrep scores 6 and 5. The remaining failures matter: the Zod caller query ranks a core definition above the requested classic caller, and the Zod constructor query starts at a different declaration in the correct file. The model probe succeeds on the caller task by choosing the lower-ranked classic file; that does not fix the ranking regression.

These are manually selected examples from three repositories, not an estimate of general search accuracy. Timing repetitions do not increase the number of labeled cases.

## Corpus and controls

The 15 cases in `test/corpus/` contain nine development cases and six holdouts. Each repository contributes a declaration, caller and test lookup to development, followed by a related-definition lookup and an absent sentinel to holdout. Labels and alternatives were frozen before any retrieval measurement. No holdout tuning was performed.

| Repository | Pinned revision | Case file |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi/tree/b2602be77cb7b0de45dd616407fd210daa48aa75) | `b2602be77cb7b0de45dd616407fd210daa48aa75` | `test/corpus/pi.json` |
| [Rails](https://github.com/rails/rails/tree/e970c80fd668f3f4ee08201bbbbcadfb2f29b1df) | `e970c80fd668f3f4ee08201bbbbcadfb2f29b1df` | `test/corpus/rails.json` |
| [Zod](https://github.com/colinhacks/zod/tree/804e0f522747345d6b37581888899be420baa3e9) | `804e0f522747345d6b37581888899be420baa3e9` | `test/corpus/zod.json` |

Development queries use identifiers or calls with directory hints, rather than supplied answer filenames. The related holdouts start at an importing or including file and require another file. All three negative sentinels were independently checked with uncapped native rg. Public `file` intent and positive `auto` cases are not covered here; the [synthetic suite](benchmark.md) covers navigation-anchor behavior.

The frozen dataset SHA-256 is `fb4461c82ec74d60763d3ac7b4736050528b5a3283780befa6e642db30881e8a`.

`PinnedSource` checks repository identity, revision, cleanliness, ignored untracked files and regular-file membership. Reads use committed Git blobs. The runners do not install dependencies or execute code from these source repositories. The resolver uses this extension's TypeScript, not a compiler or plugin from a fixture.

## Retrieval results

[real-baseline.json](benchmarks/real-baseline.json) records the labeled baseline before ablation code or numeric preservation checks. Each case/mode combination has 15 warm samples and three fresh-process samples.

| Group, three cases each | Raw first file | Full first file | Raw MRR | Full MRR | Raw first span | Full first span |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development definitions | 2/3 | 3/3 | 0.778 | 1.000 | 2/3 | 2/3 |
| Development callers | 3/3 | 2/3 | 1.000 | 0.833 | 2/3 | 2/3 |
| Development tests | 1/3 | 3/3 | 0.611 | 1.000 | 1/3 | 3/3 |
| Holdout related definitions | 0/3 | 3/3 | 0.000 | 1.000 | 0/3 | 3/3 |

Candidate recall and recall@5 are both 1.00 for both modes on development cases. On related holdouts they are 0.00 for raw rg and 1.00 for full search. Across all 12 positives, MRR is 0.597 for raw and 0.958 for full. Both modes produce three valid negative misses out of three. No completed-scope completeness errors or outside-corpus candidates were observed.

Full search retrieves the three related targets first with correct spans, but still reports partial graph coverage. Finding the required files does not establish that every relationship was explored.

Two default limitations remain in development:

- `zod-references`: `core/api.ts:1802` precedes the requested `classic/schemas.ts:619` caller. The relevant file is second, so MRR is 0.5.
- `zod-definition`: the correct `classic/schemas.ts` file is first, but its first snippet is line 387 rather than the public constructor at line 528.

## Five feature ablations

[ablations.json](benchmarks/ablations.json) contains 105 case/mode combinations, each with 15 warm and three fresh-process samples. The default per-case metrics and shortlist match the earlier baseline. All 105 independent native matching-line maps agree exactly with the reported maps.

| Mode | Correct first file /12 | Correct first span /12 | MRR | Candidate recall and recall@5 |
| --- | ---: | ---: | ---: | ---: |
| Raw rg | 6 | 5 | 0.597 | 0.75 |
| Full | 11 | 10 | 0.958 | 1.00 |
| No path priors | 11 | 10 | 0.958 | 1.00 |
| No context | 9 | 8 | 0.875 | 1.00 |
| No declaration scoring | 12 | 10 | 1.000 | 1.00 |
| No graph | 8 | 7 | 0.708 | 0.75 |
| No guidance | 11 | 10 | 0.958 | 1.00 |

Every mode retains all three valid negative misses. The switches have deliberately narrow meanings:

- No path priors removes static extension, folder, depth, test and generated-file preferences. Query-path relevance, anchors and graph evidence remain. Equal quality on this small corpus does not show that priors are redundant.
- No context omits context from retention, scoring and neighboring-source reads. It ranks Zod v3 tests above the requested v4 tests and a core re-export candidate above the classic target.
- No declaration scoring removes the declaration ranking bonus, file-tier advantage and snippet-priority advantage. Classification, collector retention and graph staging remain. It fixes the development caller ranking but moves the heldout constructor's first span to line 602 instead of 643. Its aggregate improvement hides that regression. This is not a measurement of classifier removal cost.
- No graph disables related expansion. It misses all three related targets; candidate changes are allowed only for cases that originally requested expansion.
- No guidance removes action instructions from rendered output. It preserves retrieval and ranking while reducing total emitted bytes from 82,555 to 80,323. Retrieval equality alone says nothing about model behavior.

The comparison checks preserve frozen labels and default per-case results, require equal candidate/count pools for non-graph variants, and require identical rankings with guidance disabled. They report failures rather than changing labels or suppressing unfavorable results.

## Model navigation probe

Three tasks were selected before the first model request: Pi's `ext-relative-04`, the known development failure `zod-references`, and Rails' `rails-nav-scoping-mixin`. Each ran once in full, raw-rg and no-guidance conditions, in that order. All used the same `openai-codex/gpt-5.6-luna` alias and configuration.

| Mode | Tasks completed /3 | Correct first read /3 | Model requests | Follow-up searches | Total wall time | Catalog cost estimate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Full | 3 | 3 | 6 | 0 | 18.312 s | $0.0024046 |
| Raw rg | 3 | 2 | 9 | 2 | 28.783 s | $0.0026148 |
| No guidance | 3 | 3 | 7 | 0 | 22.619 s | $0.0027580 |

The nine conditions used 22 HTTP-200 requests, 30,979 input tokens and 1,318 output tokens, with zero reported cache tokens. The catalog cost estimate totals $0.0077774. All reservations settled with known usage; the conservative shared-ledger debit is $0.029559 against the authorized $5 limit.

The individual traces explain the differences:

- Pi: full search needed one read and a final answer. Raw rg opened the correct `agents.ts` file at lines 1-80, missed the definition at 128, then read again. No-guidance read the definition first but also inspected the importing file. All answered line 128. Raw took 6.527 seconds, slightly less than full's 7.017 seconds despite the extra request; no-guidance took 8.397 seconds.
- Zod: all modes read the correct classic caller and answered line 619 in two requests. The full model chose it despite the core-first ranking. Full took 4.590 seconds, raw 6.689 and no-guidance 7.882.
- Rails: full and no-guidance read the concern directly and finished in two requests. Raw tried `include Default include Named`, found no match, then searched `module Scoping`, read the concern and finished. All answered line 8, inside the frozen concern-entry span. Times were 6.705, 15.567 and 6.339 seconds respectively.

A correct first read must show a labeled span, not merely open the correct file. Task success also requires a correct final location and at least one relevant source read. Discovery counts exclude the seeded initial query. The 22 requests are workflow steps, not 22 independent navigation trials.

This is an isolated, seeded navigation probe, not a normal Pi session or an unconstrained query-formulation test. There are no negative model tasks, repeated trials, randomized condition order or significance estimates. Model latency varies, and an alias can change at the provider. The traces support the observations above, not a general speed or accuracy claim.

### Isolation and spending controls

The probe uses the installed Pi SDK 0.85.1 through `ModelRuntime`, with custom model configuration disabled and network catalog refresh disabled. It never creates an agent session or loads ambient AGENTS, skills, extensions or session history. Full mode receives only this search tool's own static guidelines; no-guidance omits those and the output's action instructions.

Search results pass through a public-source projection. It preserves ranked file order and visible snippets, verifies each snippet against its committed blob, and omits opaque diagnostics and relationship descriptions. Reads deny instruction files and escaping paths. Each model request contains fixed instructions and explicit public observations so far; hidden reasoning and session context are not carried forward.

The protocol allows four read/search/finish actions per condition, a cooperative 120-second deadline, 16 KiB per tool output, 64 KiB of user input and 4 MiB of response bytes. Synchronous filesystem checks and parsing are not preemptible. The request hook verifies the fixed system prompt and sole user message; the fetch hook allows one POST to the Codex endpoint and refuses redirects and second dispatches. Transport is SSE, retries are zero and model fallback is disabled. Reasoning is low; temperature is left at the provider default.

The active `gpt-6-astra` model's standard maximum output alone exceeded $5. The lower-cost current Luna alias was fixed before any send. Codex omits requested `maxTokens`, so the budget does not rely on an output-cap option. Each attempt reserves $0.972161: the full catalog input/cache ceilings and maximum output, priced at the highest catalog tiers with a 2x priority allowance and upward rounding. Only validated usage releases unused reservation. Errors, aborted requests, missing usage and process crashes retain the full reservation.

A fsynced append-only ledger in the repository's common Git directory shares the $5 limit across worktrees. Its exclusive lock, configuration hash and attempted-request IDs prevent concurrent spending, configuration changes and retries. Reports and per-action checkpoints contain public paths, hashes and usage, not credentials or raw provider errors. Catalog estimates are not invoices.

## Measurement definitions and limits

- Candidate recall is measured before display slicing. Recall@5 uses distinct labeled relevant files in the returned shortlist; MRR uses the first relevant file. First-span correctness is independent of file correctness.
- Positive and negative denominators stay separate. `falseMiss` means an empty shortlist for a positive case. A valid negative miss requires complete relevant scopes, zero matches and independent native confirmation.
- Completeness compares candidates and distinct matching lines per file in reported completed scopes. The native oracle reproduces stage roots, ignore policy and aliases. Required-root coverage is a separate geometric check.
- Warm timing uses one warmup and 15 measured calls, excluding source validation and the independent oracle. Fresh workers execute exactly one query. First-query time excludes loader/validation/oracle; startup-through-query includes loader and validation; total worker lifetime also includes the oracle and result transfer. Filesystem caches are not flushed.
- Across full-mode cases in the ablation report, warm medians range from 3.23 to 92.06 ms. The largest warm p95 is 106.02 ms and the largest fresh-query p95 is 366.4 ms. With 15 and three samples respectively, these tails are noisy.
- Maximum observed worker RSS is 448,976 KiB. It includes the loader, validation and oracle, but excludes child rg RSS. Serialized retained-snippet bytes are not a heap measurement.
- Static-output token counts are unavailable; byte/4 is labeled as an estimate. Model reports use provider-reported token usage. Cold filesystem-cache latency and child-process peak memory remain unmeasured.
- The separate synthetic tests for Unicode aliases, generated candidates and overlapping roots do not enlarge the public corpus or its accuracy denominator.

## Reproduction

Use this repository's existing development dependencies and `rg`. Do not install or run source-repository packages. Supply clean checkouts of the three pinned revisions in directories named `pi`, `rails` and `zod` under a cache directory. The runners validate those pins and never fetch on their own.

From the corresponding measured source revision, write new reports rather than replacing the checked-in evidence:

```bash
node --import tsx test/evaluation/run.ts \
  --cache /path/to/public-corpus --samples 15 --cold-samples 3 \
  --output /tmp/real-baseline.json

node --import tsx test/evaluation/run.ts \
  --cache /path/to/public-corpus --samples 15 --cold-samples 3 \
  --modes raw-rg,full,no-path-priors,no-context,no-definition-scoring,no-graph,no-guidance \
  --baseline docs/benchmarks/real-baseline.json \
  --output /tmp/ablations.json
```

The model preflight makes no inference requests:

```bash
node --import tsx test/evaluation/model-run.ts \
  --cache /path/to/public-corpus --sdk /path/to/installed/pi-coding-agent
```

A new live experiment requires separate spending approval and configured credentials. Use an independent checkout of the measured harness revision `0cff0cfada12d7dc89b48dfecd32b31e25ab4338`, before model reports exist. A worktree shares its repository's ledger; do not delete existing reports, ledger records or locks to bypass the no-rerun rule. Add `--run --case ext-relative-04`, then `--run --case zod-references`, then `--run --case rails-nav-scoping-mixin` to the preflight command. Each case runs the three fixed conditions and writes `docs/benchmarks/model-<project>.json`. The normal test suite never makes a live model request; its optional installed-SDK check uses fake credentials and mocked HTTP.

| Evidence | Measured source revision |
| --- | --- |
| [Real baseline](benchmarks/real-baseline.json) | `ea81a506e3857b8c9439d36a8cdf97680a84ce3c` |
| [Ablations](benchmarks/ablations.json) | `45e52f4a6f03ea4d8cdba3160b69ce93215b41fc` |
| [Pi model probe](benchmarks/model-pi.json) | `0cff0cfada12d7dc89b48dfecd32b31e25ab4338` |
| [Zod model probe](benchmarks/model-zod.json) | `f618d02ec538d4f1465e8001f3e981c60eed14d1` |
| [Rails model probe](benchmarks/model-rails.json) | `6ba49e347325b1a52b0e24625eb6ee910af49ca7` |

Report commits follow their measured source commits. The JSON files contain runtime, runner and dataset hashes. Ablation and model reports also record a configuration hash; the initial real baseline predates that field. Model reports identify the SDK adapter. Evaluation file-set hashes use sorted path, NUL, then content. All model conditions share configuration `2cfae70aa876909a44f232e2ff1576dd74015192631554f2417ac8a64d365f31`. Preserve the original synthetic, execution and real baseline artifacts when measuring another revision.

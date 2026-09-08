# Search benchmark

This guide covers the synthetic regression baseline. The separate [public navigation evaluation](evaluation.md) documents the pinned Pi, Rails and Zod corpus, five feature ablations, resource measurements and bounded model probe.

Run from the repository root with the existing development dependencies and `rg` on PATH:

```bash
npm run test:benchmark
npm run benchmark -- --samples 15 --check --output /tmp/search-benchmark.json
```

The runner calls the registered `agentic_search` tool against temporary fixtures and compares its output with uncapped ripgrep. It does not change production code. The report includes source and dataset hashes, relevant file/line labels, required roots, file and line counts, top-1 accuracy, reciprocal rank, recall@5, warm median/p95 latency, subprocess counts, repository listings, and emitted bytes. Fixtures are removed and process instrumentation and environment variables restored on completion.

Use `--case exact-file` to select a case prefix, `--samples 1` for a quick functional run, and `--check` to exit nonzero when any selected acceptance check fails. Report mode intentionally exits successfully after recording known product failures. Do not use the initial baseline's failing product checks as a CI gate until the corresponding fixes land.

## Initial dataset

The original `test/benchmark-cases.ts` dataset contained five scenarios expanded to eight runs:

- 206 matching files, a second hit in file 200, and a late relevant definition.
- Six ambiguous filenames, with the only match in the sixth, at output limits 1, 5, and 10.
- Ripgrep's valid `(?i)` inline case flag.
- A function call in a variable initializer competing with its definition.
- One exact target with either zero or 7,999 unrelated files.

Definition cases pass an `intent` value to the execution adapter. The baseline implementation ignores it; it is now an explicit tool parameter. Legacy cases without that parameter still use `auto`; report labels describe the intended task, not an inferred model decision.

`docs/benchmarks/baseline.json` records the unmodified runtime at commit `7af88927ee7dc2c9c4a5f3a640e8d0d5297b0676`. Seven of the eight runs fail at least one desired contract. The limit-10 ambiguous-filename case passes. Exact-file searches retrieve the correct result but launch three rg processes, two of which are listings. The late-definition case reports 200 matching lines instead of rg's 207.

## Ranking regressions

Six additional runs cover a named caller versus its implementation under `definition`, `file`, and `auto`; explicit reference and test intent; and token-boundary context in neighboring lines. `docs/benchmarks/ranking.json` records all 14 passing runs, with top-1 accuracy and mean reciprocal rank grouped by labeled task intent in `byIntent`. Inspect individual results as well as those groups. The synthetic cases are development data; these scores do not establish general search accuracy.

The report includes a runtime hash and dirty-tree indicator because it is generated before the commit containing that runtime. Reproduce it with the command above from this PR's checkout. Leave the original baseline artifact unchanged.

## Measurement limits

Each latency cell has one warmup and 15 measured in-process calls. Fixture creation and the independent rg oracle are outside the timer. The runner counts actual Node `spawn`/`execFile` calls rather than introducing an executable wrapper. The output report records count ranges across all measured calls.

An isolated `RIPGREP_CONFIG_PATH` enables `--sort=path` for reproducible arrival order. Sorted traversal disables rg parallelism; this is a test control, not a recommended production setting. The direct oracle uses `--no-config` and the explicitly labeled roots. These fixtures contain no ignored files or package expansion.

The labels identify required relevant targets, not interchangeable alternatives. Recall@5 counts distinct relevant file paths returned in the first five results; reciprocal rank uses the first relevant file. A separate check requires the top snippet to match the labeled line. File and line count checks compare full reported retrieval counts with the oracle. They do not measure relevance recall inside an undisclosed candidate pool.

This small synthetic dataset is a regression baseline, not a representative accuracy estimate. Its cases are separate from the public corpus and do not contribute to that corpus's accuracy denominator. Cold-cache latency, retained/peak memory, tokenizer-specific tokens, model task success and agent effort are explicitly unavailable in this report. A 15-sample p95 is noisy. Keep the original baseline artifact unchanged when recording subsequent revisions to new report files.

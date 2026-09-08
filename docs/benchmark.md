# Search benchmark

Run from the repository root with the existing development dependencies and `rg` on PATH:

```bash
npm run test:benchmark
npm run benchmark -- --samples 15 --output docs/benchmarks/baseline.json
```

The runner calls the registered `agentic_search` tool against temporary fixtures and compares its output with uncapped ripgrep. It does not change production code. The report includes source and dataset hashes, relevant file/line labels, required roots, file and line counts, top-1 accuracy, reciprocal rank, recall@5, warm median/p95 latency, subprocess counts, repository listings, and emitted bytes. Fixtures are removed and process instrumentation and environment variables restored on completion.

Use `--case exact-file` to select a case prefix, `--samples 1` for a quick functional run, and `--check` to exit nonzero when any selected acceptance check fails. Report mode intentionally exits successfully after recording known product failures. Do not use the initial baseline's failing product checks as a CI gate until the corresponding fixes land.

## Initial dataset

`test/benchmark-cases.ts` contains five scenarios expanded to eight runs:

- 206 matching files, a second hit in file 200, and a late relevant definition.
- Six ambiguous filenames, with the only match in the sixth, at output limits 1, 5, and 10.
- Ripgrep's valid `(?i)` inline case flag.
- A function call in a variable initializer competing with its definition.
- One exact target with either zero or 7,999 unrelated files.

Definition cases pass an `intent` value to the execution adapter. The baseline implementation ignores it; the ranking implementation will make it an explicit tool parameter. Other intent labels describe the task, not an inferred model decision.

`docs/benchmarks/baseline.json` records the unmodified runtime at commit `7af88927ee7dc2c9c4a5f3a640e8d0d5297b0676`. Seven of the eight runs fail at least one desired contract. The limit-10 ambiguous-filename case passes. Exact-file searches retrieve the correct result but launch three rg processes, two of which are listings. The late-definition case reports 200 matching lines instead of rg's 207.

## Measurement limits

Each latency cell has one warmup and 15 measured in-process calls. Fixture creation and the independent rg oracle are outside the timer. The runner counts actual Node `spawn`/`execFile` calls rather than introducing an executable wrapper. The output report records count ranges across all measured calls.

An isolated `RIPGREP_CONFIG_PATH` enables `--sort=path` for reproducible arrival order. Sorted traversal disables rg parallelism; this is a test control, not a recommended production setting. The direct oracle uses `--no-config` and the explicitly labeled roots. These fixtures contain no ignored files or package expansion.

The labels identify required relevant targets, not interchangeable alternatives. Recall@5 counts distinct relevant file paths returned in the first five results; reciprocal rank uses the first relevant file. A separate check requires the top snippet to match the labeled line. File and line count checks compare full reported retrieval counts with the oracle. They do not measure relevance recall inside an undisclosed candidate pool.

This small synthetic dataset is a regression baseline, not a representative accuracy estimate. It has no held-out real-project cases yet. Cold-cache latency, retained/peak memory, tokenizer-specific tokens, model task success and agent effort are explicitly unavailable in this report. A 15-sample p95 is noisy. Keep the original baseline artifact unchanged when recording subsequent revisions to new report files.

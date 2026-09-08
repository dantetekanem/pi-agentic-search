import assert from "node:assert/strict";
import type { EvaluationCase, Observation, QualityMetrics } from "./core.ts";

export const MODES = ["raw-rg", "full", "no-path-priors", "no-context", "no-definition-scoring", "no-graph", "no-guidance"] as const;
export type Mode = typeof MODES[number];
export function parseModes(value = "raw-rg,full"): Mode[] {
  const modes = value.split(",");
  if (new Set(modes).size !== modes.length || !modes.every((mode): mode is Mode => MODES.some((known) => known === mode))) throw new Error("Invalid evaluation modes");
  return modes;
}
export const MODE_NOTES: Record<Mode, string> = {
  "raw-rg": "Sorted native rg in the requested root, no expansion or ranking; same output bounds.",
  full: "Registered public tool with all default features.",
  "no-path-priors": "Disable static extension/folder/depth/test/generated priors; retain query-path relevance, explicit anchors and graph evidence.",
  "no-context": "Omit context input, including context-based retention, scoring and neighboring reads; preserve the query and search scope.",
  "no-definition-scoring": "Disable declaration bonus, file-tier preference and snippet-priority advantage in ranking. Preserve truthful classification metadata, retrieval retention and graph staging; this does not measure classifier removal cost.",
  "no-graph": "Disable expand_related; candidate pools may change only for cases that originally enabled expansion.",
  "no-guidance": "Remove model-facing action instructions from results, keeping ranked data and coverage facts. Retrieval-only measurements cannot establish its effect on model decisions.",
};
export interface ComparisonRow { scenario: EvaluationCase; mode: Mode; observation: Observation; metrics: QualityMetrics }
export function assertComparisons(rows: ComparisonRow[], baseline: ComparisonRow[]): void {
  const controls = baseline.filter((row) => row.mode === "full");
  assert.ok(controls.length, "missing full baseline");
  for (const original of controls) {
    const full = rows.find((row) => row.mode === "full" && row.scenario.id === original.scenario.id);
    assert.ok(full, `missing full case ${original.scenario.id}`);
    assert.deepEqual(full.scenario, original.scenario, `${full.scenario.id}: changed labels`);
    assert.deepEqual(full.metrics, original.metrics, `${full.scenario.id}: changed default metrics`);
    assert.deepEqual(full.observation.returned, original.observation.returned, `${full.scenario.id}: changed default ranking`);
    assert.deepEqual([...full.observation.candidates].sort(), [...original.observation.candidates].sort(), `${full.scenario.id}: changed default candidate pool`);
    assert.deepEqual(full.observation.matchedLineCounts, original.observation.matchedLineCounts, `${full.scenario.id}: changed default counts`);
  }
  for (const row of rows) {
    assert.equal(row.observation.outsideCorpusCandidates, 0, `${row.scenario.id}/${row.mode}: non-public candidates`);
    assert.equal(row.metrics.completenessError, false, `${row.scenario.id}/${row.mode}: completeness error`);
    const full = rows.find((item) => item.mode === "full" && item.scenario.id === row.scenario.id);
    assert.ok(full && controls.some((item) => item.scenario.id === row.scenario.id), "missing full comparison case");
    assert.deepEqual(row.scenario, full.scenario, `${row.scenario.id}/${row.mode}: changed labels`);
    if (row.mode !== "raw-rg" && !(row.mode === "no-graph" && row.scenario.params.expand_related)) {
      assert.deepEqual([...row.observation.candidates].sort(), [...full.observation.candidates].sort(), `${row.scenario.id}/${row.mode}: changed candidate pool`);
      assert.deepEqual(row.observation.matchedLineCounts, full.observation.matchedLineCounts, `${row.scenario.id}/${row.mode}: changed matching-line counts`);
    }
    if (row.mode === "no-guidance") {
      assert.deepEqual(row.observation.returned, full.observation.returned, `${row.scenario.id}: changed guidance ranking`);
      assert.deepEqual(row.metrics, full.metrics, `${row.scenario.id}: changed guidance metrics`);
    }
  }
}

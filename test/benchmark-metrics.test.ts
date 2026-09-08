import assert from "node:assert/strict";
import { assess, percentile, summarizeByIntent } from "./benchmark-cases.ts";

const targets = [{ path: "src/needle.ts", line: 4 }, { path: "src/alternative.ts", line: 2 }];
assert.deepEqual(assess([{ path: "caller.ts", line: 1 }, targets[0]!], targets), {
  top1: 0, reciprocalRank: 0.5, recallAt5: 0.5, correctFirstSpan: false,
});
assert.deepEqual(assess([{ path: "src/needle.ts", line: 9 }], [targets[0]!]), {
  top1: 1, reciprocalRank: 1, recallAt5: 1, correctFirstSpan: false,
});
assert.deepEqual(assess([targets[0]!, targets[0]!], [targets[0]!]), {
  top1: 1, reciprocalRank: 1, recallAt5: 1, correctFirstSpan: true,
});
assert.equal(assess([], targets).reciprocalRank, 0);
assert.equal(percentile([5, 1, 4, 2, 3], 0.5), 3);
assert.equal(percentile([5, 1, 4, 2, 3], 0.95), 5);
assert.throws(() => percentile([], 0.5), /empty/);
assert.deepEqual(summarizeByIntent([
  { intent: "definition", metrics: { top1: 1, reciprocalRank: 1 } },
  { intent: "definition", metrics: { top1: 0, reciprocalRank: 0.5 } },
  { intent: "tests", metrics: { top1: 0, reciprocalRank: 0 } },
]), { definition: { cases: 2, top1: 0.5, mrr: 0.75 }, tests: { cases: 1, top1: 0, mrr: 0 } });
console.log("benchmark metric contracts passed");

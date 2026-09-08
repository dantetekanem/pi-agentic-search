import assert from "node:assert/strict";
import { assess, percentile } from "./benchmark-cases.ts";

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
console.log("benchmark metric contracts passed");

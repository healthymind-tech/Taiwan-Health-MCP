/**
 * Dev script: latency of checkGrounding over the golden cases (static terminology).
 *   cd node-server && node --import tsx src/grounding/scripts/bench.ts [reps]
 */
import { checkGrounding } from "../checkGrounding.js";
import { requirePrivateFixture, referenceTerminology } from "../testkit.js";

const reps = Number(process.argv[2] ?? 5);
const G = requirePrivateFixture("grounding_golden.json");
const terminology = referenceTerminology();
const t0 = performance.now();
await checkGrounding(G.cases[0].input, { terminology });
const cold = performance.now() - t0;
const times: number[] = [];
for (let r = 0; r < reps; r++) {
  for (const c of G.cases) {
    const s = performance.now();
    await checkGrounding(c.input, { terminology });
    times.push(performance.now() - s);
  }
}
times.sort((a, b) => a - b);
const q = (p: number): number => times[Math.floor(p * (times.length - 1))];
const mean = times.reduce((a, b) => a + b, 0) / times.length;
console.log(
  JSON.stringify({ calls: times.length, cold_ms: +cold.toFixed(1), p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +times[times.length - 1].toFixed(1), mean: +mean.toFixed(1) }),
);

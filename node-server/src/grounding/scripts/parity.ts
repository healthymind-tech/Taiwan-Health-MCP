/**
 * Dev script: run every golden case through the TS engine and print the first difference per case.
 *   cd node-server && node --import tsx src/grounding/scripts/parity.ts [caseIdSubstring]
 */
import { checkGrounding } from "../checkGrounding.js";
import { comparable, firstDiff, loadFixture, referenceTerminology, withoutExtendedEntries } from "../testkit.js";

const filter = process.argv[2] ?? "";
const G = loadFixture("grounding_golden.json");
const terminology = referenceTerminology();
let ok = 0;
let bad = 0;
for (const c of G.cases) {
  if (filter && !c.id.includes(filter)) continue;
  const out = await checkGrounding({ ...c.input, verbosity: "all" }, { terminology });
  const d = firstDiff(withoutExtendedEntries(comparable(out)), withoutExtendedEntries(c.expected.data));
  if (d) {
    bad++;
    console.log(`DIFF ${c.id}: ${d}`);
  } else ok++;
}
console.log(`ok ${ok} diff ${bad}`);

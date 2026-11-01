/**
 * Error classes for the parity regression (MCP fhir_validate_bundle vs validator_cli 7.0.1 + tx.fhir.org), the same
 * buckets the evaluator's comparison uses (parity_summary): a structural class where the message has one, else the
 * message with instance values / urls / numbers normalised. Content checks of MCP (grounding, record checks: messages
 * starting with '[' or record-check codes) are not validator errors and are dropped by the caller.
 */

export function errorClass(message: string): string {
  const m = String(message);
  if (/a matching slice is required, but not found/u.test(m)) return "slice-required";
  if (/does not match any known slice/u.test(m)) return "slice-nomatch";
  if (/The System URI could not be determined/u.test(m)) return "system-uri";
  const inv = /^Constraint failed: ([a-z0-9-]+):/u.exec(m);
  if (inv) return `constraint:${inv[1]}`;
  if (/isn't reachable by traversing/u.test(m)) return "reachable";
  if (/minimum required = \d+/u.test(m)) return "min-card";
  if (/max allowed = \d+/u.test(m)) return "max-card";
  if (/None of the codings provided are in the value set|is not in the value set|was not found in the value set/u.test(m)) return "valueset";
  if (/definition allows for the type .* but found type|Boolean values must be|must be a JSON (?:Object|Array)|is not a valid (?:boolean|integer|decimal)/u.test(m)) return "type";
  if (/^Wrong Display Name/u.test(m)) return "display";
  if (/^Unrecognized property/u.test(m)) return "unrecognized";
  if (/The first entry in a document must be a composition/u.test(m)) return "first-composition";
  if (/must be an Array, not a Primitive|must be a simple value, not an Object/u.test(m)) return "array";
  if (/but is fixed to|does not match the fixed value/u.test(m)) return "fixed";
  if (/is not allowed by the profile|is not allowed for /u.test(m)) return "not-allowed";
  if (/Unable to find a profile match/u.test(m)) return "profile-match";
  if (/Invalid Resource target type|is not a valid Target for this element/u.test(m)) return "target-type";
  if (/^Can't find '/u.test(m)) return "cant-find";
  if (/^Unknown code/u.test(m)) return "unknown-code";
  return m
    .split(" Note that")[0]
    .replace(/https?:\/\/\S+/gu, "<url>")
    .replace(/urn:uuid:[0-9a-f-]+/giu, "<urn>")
    .replace(/'[^']*'/gu, "'<v>'")
    .replace(/\d+(\.\d+)?/gu, "<num>")
    .slice(0, 100);
}

/** MCP's own content checks (not validator rules). */
export function isContentCheck(i: { message?: string; source?: string; code?: string }): boolean {
  const m = String(i.message ?? "");
  return i.source === "record-checks" || i.source === "grounding" || m.startsWith("[") || /[一-鿿]/u.test(m.slice(0, 12));
}

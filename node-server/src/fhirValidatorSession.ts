/**
 * The view of a ValidatorResolver one validation run works through (parity v3, large-Bundle non-determinism):
 *
 *  - pin: within the run every lookup is answered once; the first answer is what the rest of the run sees, whatever the
 *    resolver would answer later (the DB resolver's own caches are pinned too, fhirValidationSnapshot.ts);
 *  - transient failures: a rejected lookup is an infrastructure failure, never a finding. By the ValidatorResolver contract
 *    a rejection is "no answer" (a real "not found" is null / undefined / false). It is counted, and answered "undecided"
 *    where the lookup has such an answer, so the check surfaces as unverified. A lookup without one (a definition, an
 *    external reference) leaves nothing to judge against: the run ends without a verdict (`noVerdict`), since a missing
 *    StructureDefinition read as absent turns into invented errors. Nothing is remembered past the run.
 */
import type { CodeCheck, ValidatorResolver } from "./fhirValidator.js";

export class LookupSession {
  total = 0;
  noVerdict = false;
  readonly samples: Array<{ code: string | null; message: string }> = [];

  fail(lookup: string, target: string, e: unknown, abort: boolean): void {
    this.total++;
    if (abort) this.noVerdict = true;
    if (this.samples.length < 3) {
      const code = (e as { code?: unknown } | null)?.code;
      this.samples.push({ code: typeof code === "string" ? code : null, message: `${lookup} ${target}: ${String((e as Error | null)?.message ?? e)}` });
    }
  }
}

/** Unwinds a run that lost a definition; validate() reports it. */
export class LookupAbort extends Error {}

const UNDECIDED_CODE: CodeCheck = { status: "silent", undecided: true };

export function sessionResolver(inner: ValidatorResolver, session: LookupSession): ValidatorResolver {
  const pins = new Map<string, Promise<unknown>>();
  const pinned = <T>(name: string, args: unknown[], target: string, run: () => Promise<T>, onFail: { answer: T } | null): Promise<T> => {
    const key = `${name}\u0000${args.map(String).join("\u0000")}`;
    let p = pins.get(key) as Promise<T> | undefined;
    if (!p) {
      p = (async (): Promise<T> => run())().catch((e: unknown) => {
        session.fail(name, target, e, onFail === null);
        if (onFail === null) throw new LookupAbort(`${name} ${target}`);
        return onFail.answer;
      });
      pins.set(key, p);
    }
    return p;
  };
  const view: ValidatorResolver = {
    fetchStructureDefinition: (url) => pinned("StructureDefinition", [url], url, () => inner.fetchStructureDefinition(url), null),
    fetchValueSet: (url) => pinned("ValueSet", [url], url, () => inner.fetchValueSet(url), null),
    valueSetContains: (url, system, code) => pinned("membership", [url, system, code], url, () => inner.valueSetContains(url, system, code), { answer: undefined }),
    checkCode: (system, code, display, version, langs) => {
      const args: [string, string, string | null, (string | null)?, string[]?] = [system, code, display];
      if (version !== undefined || langs !== undefined) args.push(version);
      if (langs !== undefined) args.push(langs);
      return pinned("code", [system, code, display, version ?? null, langs ?? ""], `${system}#${code}`, () => inner.checkCode(...args), { answer: UNDECIDED_CODE });
    },
  };
  const hasReject = <K extends keyof ValidatorResolver>(k: K): boolean => typeof inner[k] === "function";
  if (hasReject("codeSystemResolvable")) view.codeSystemResolvable = (s) => pinned("code system", [s], s, () => inner.codeSystemResolvable!(s), { answer: true });
  // a code-less Coding's slice match depends on it and there is no "undecided" boolean: no verdict
  if (hasReject("codeSystemLocal")) view.codeSystemLocal = (s) => pinned("local code system", [s], s, () => inner.codeSystemLocal!(s), null);
  if (hasReject("definitionExists")) view.definitionExists = (u) => pinned("definition", [u], u, () => inner.definitionExists!(u), { answer: true });
  if (hasReject("codeSystemVersions")) view.codeSystemVersions = (s) => pinned("code system versions", [s], s, () => inner.codeSystemVersions!(s), { answer: [] });
  if (hasReject("codeSystemExists")) view.codeSystemExists = (u) => pinned("code system", [u, "exists"], u, () => inner.codeSystemExists!(u), { answer: false });
  if (hasReject("definitionVersionExists")) view.definitionVersionExists = (u, v) => pinned("definition version", [u, v], `${u}|${v}`, () => inner.definitionVersionExists!(u, v), { answer: true });
  // a code system's content (CodeSystemValidator / ValueSetValidator): without an answer the checks on it are skipped
  if (hasReject("fetchCodeSystem")) view.fetchCodeSystem = (u) => pinned("code system content", [u], u, () => inner.fetchCodeSystem!(u), { answer: null });
  if (hasReject("fetchReference")) view.fetchReference = (r) => pinned("reference", [r], r, () => inner.fetchReference!(r), null);
  if (hasReject("fetchSearchParameter")) view.fetchSearchParameter = (u) => pinned("search parameter", [u], u, () => inner.fetchSearchParameter!(u), { answer: null });
  if (hasReject("fetchCanonical")) view.fetchCanonical = (t, u) => pinned("canonical", [t, u], u, () => inner.fetchCanonical!(t, u), { answer: null });
  if (hasReject("fetchQuestionnaire")) view.fetchQuestionnaire = (u) => pinned("questionnaire", [u], u, () => inner.fetchQuestionnaire!(u), { answer: null });
  return view;
}

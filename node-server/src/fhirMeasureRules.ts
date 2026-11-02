/**
 * Port of instance/type/MeasureValidator.java + MeasureContext.java (validator_cli 7.0.1) for R4. Message text is
 * Messages.properties verbatim, with the Java quirks of the calls kept: MEASURE_MR_GRP_STRAT_CODE_MISMATCH is called
 * with two arguments for three placeholders, so `{2}` is printed as is and genCC's quotes double up.
 *
 * R4 has no linkId on Measure / MeasureReport groups, so the Java model's linkId is always null here: the id branch
 * (or the code branch) decides. Measure.scoring reaches Java as the cross-version extension of the conversion; here it
 * is read directly.
 *
 * Not ported: checkShareableMeasure (only with for-publication). An ELM that is not well-formed XML
 * (MEASURE_M_CRITERIA_CQL_ERROR with the XML parser's text) is treated as ELM with no statements.
 */

type Json = Record<string, any>;

export interface MeasureIssue {
  severity: "error" | "warning" | "information";
  path: string;
  code: string;
  message: string;
}

export interface MeasureDeps {
  fetchMeasure(url: string): Promise<Json | null>;
  fetchLibrary(url: string): Promise<Json | null>;
  /** InstanceValidator.localResolve + the fetcher: a subject reference's target, null when not resolvable. */
  resolveSubject(reference: string): Promise<Json | null>;
  isResourceName(name: string): boolean;
}

const EXT_CQM_SCORING = "http://hl7.org/fhir/uv/cqm/StructureDefinition/cqm-scoring";
const EXT_Q_UNIT = "http://hl7.org/fhir/StructureDefinition/questionnaire-unit";
const EXT_DEQM_SCORE = ["http://hl7.org/fhir/us/davinci-deqm/StructureDefinition/extension-alternateScoreType", "http://hl7.org/fhir/uv/deqm/StructureDefinition/deqm-alternateScoreType"];
const OBSERVATION_POPULATION = "http://terminology.hl7.org/CodeSystem/measure-population";

const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (x: unknown): any[] => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);
const objects = (x: unknown): Json[] => list(x).filter(isObject);
const noString = (s: unknown): boolean => typeof s !== "string" || s === "";
const extension = (e: Json, url: string): Json | undefined => objects(e.extension).find((x) => x.url === url);
const firstCode = (cc: unknown): string | undefined => (isObject(cc) ? objects(cc.coding)[0]?.code : undefined);

/** CodeableConcept.hasCoding(system, code). */
const hasCoding = (cc: Json, system: unknown, code: unknown): boolean => objects(cc.coding).some((c) => c.system === system && c.code === code);
const codesMatch = (cc: Json, code: Json | undefined): boolean => objects(cc.coding).some((c) => !!code && hasCoding(code, c.system, c.code));
const hasUseableCode = (cc: Json): boolean => objects(cc.coding).some((c) => !noString(c.system) && !noString(c.code));

/** MeasureValidator.genCC. */
function genCC(cc: Json | undefined | null): string {
  if (!cc) return "";
  const codings = objects(cc.coding);
  let b = codings.map((c) => `${c.system}${c.version !== undefined ? `|${c.version}` : ""}#${c.code}`).join(", ");
  if (codings.length > 1) b = `[${b}]`;
  if (codings.length && cc.text !== undefined) b += ": ";
  if (cc.text !== undefined) b += `'${cc.text}'`;
  return b;
}

function forCode<T extends Json>(items: T[], cc: Json): T | null {
  for (const t of items) {
    if (isObject(t.code)) for (const c of objects(t.code.coding)) if (hasCoding(cc, c.system, c.code)) return t;
  }
  return null;
}

function stratifierForCode(items: Json[], cc: Json): Json | null {
  for (const t of items) {
    if (!isObject(t.code)) continue;
    for (const c of objects(t.code.coding)) if (hasCoding(cc, c.system, c.code)) return t;
    if (!objects(cc.coding).length && !objects(t.code.coding).length && cc.text !== undefined && cc.text === t.code.text) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- Measure

/** The ELM of a Library (MeasureContext.seeLibrary): undefined = none. */
function elmOf(lib: Json): string | undefined {
  for (const att of objects(lib.content)) {
    if (att.contentType === "application/elm+xml" && typeof att.data === "string") return Buffer.from(att.data, "base64").toString("utf8");
  }
  return undefined;
}

/** isValidElm: the root is `library` in urn:hl7-org:elm:r1. */
const isValidElm = (xml: string): boolean => /<library\b[^>]*\bxmlns(:\w+)?=["']urn:hl7-org:elm:r1["']/.test(xml) || /<\w+:library\b[^>]*urn:hl7-org:elm:r1/.test(xml);

/** hasCqlTarget: a `def` of `statements` with that name. */
function hasCqlTarget(xml: string, name: string): boolean {
  const at = xml.indexOf("<statements");
  if (at < 0) return false;
  for (const m of xml.slice(at).matchAll(/<def\b[^>]*?\bname="([^"]*)"/g)) if (m[1] === name) return true;
  return false;
}

function criteriaIssues(crit: Json, at: string, libs: Json[], out: MeasureIssue[]): void {
  const mime = crit.language;
  if (noString(mime)) return;
  const unknown = (): void => {
    out.push({ severity: "warning", path: at, code: "required", message: `The expression language ${mime} is not supported, so can't be validated` });
  };
  if (!(mime.startsWith("text/cql") && !mime.startsWith("text/cql-expression"))) {
    unknown();
    return;
  }
  const rule = (message: string): void => {
    out.push({ severity: "error", path: at, code: "invalid", message });
  };
  let cqlRef = String(crit.expression ?? "");
  if (!libs.length) {
    rule("No CQL Libraries found on this Measure");
    return;
  }
  let lib: Json | null = null;
  if (cqlRef.includes(".")) {
    const name = cqlRef.slice(0, cqlRef.indexOf("."));
    cqlRef = cqlRef.slice(cqlRef.indexOf(".") + 1);
    for (const l of libs) {
      if (name !== l.name) continue;
      if (lib) rule(`Multiple matching libraries found for the namespace ${name}`);
      else lib = l;
    }
    if (!lib) rule(`No matching Library found for the namespace ${name}`);
  } else if (libs.length === 1) {
    lib = libs[0];
  } else {
    rule("If the CQL expression does not include a namespace, there can only be one Library for the measure");
  }
  if (!lib) return;
  const elm = elmOf(lib);
  if (elm === undefined) {
    out.push({ severity: "warning", path: at, code: "invalid", message: `Warning in ${lib.url}: No compiled version of CQL found` });
  } else if (!isValidElm(elm)) {
    rule(`= Error in ${lib.url}: Compiled version of CQL is not valid`);
  } else if (!hasCqlTarget(elm, cqlRef)) {
    rule(`The function ${cqlRef} does not exist in the library ${lib.url}`);
  }
}

/** MeasureValidator.validateMeasure l. 46-122. */
export async function validateMeasure(measure: Json, path: string, deps: MeasureDeps): Promise<MeasureIssue[]> {
  const out: MeasureIssue[] = [];
  const libs: Json[] = [];
  for (const ref of list(measure.library)) {
    if (noString(ref)) continue;
    const l = await deps.fetchLibrary(ref);
    if (l) libs.push(l);
    else out.push({ severity: "information", path, code: "not-found", message: `The Library ${ref} could not be resolved, so expression validation may not be correct` });
  }
  const warn = (ok: boolean, at: string, message: string): void => {
    if (!ok) out.push({ severity: "warning", path: at, code: "required", message });
  };
  const groups = objects(measure.group);
  warn(groups.length > 0, path, "A measure should contain at least one group");
  groups.forEach((group, c) => {
    const ns = `${path}.group[${c}]`;
    warn(groups.length === 1 || group.code !== undefined, ns, "Groups should have codes when there is more than one group");
    const pops = objects(group.population);
    warn(pops.length > 0, ns, "Measure Groups should have at least one population");
    pops.forEach((p, i) => {
      warn(pops.length === 1 || p.code !== undefined, `${ns}.population[${i}]`, "A measure group population should have a code when there is more than one population");
      if (isObject(p.criteria)) criteriaIssues(p.criteria, `${ns}.population[${i}].criteria`, libs, out);
    });
    const strats = objects(group.stratifier);
    strats.forEach((s, i) => {
      warn(strats.length === 1 || s.code !== undefined, `${ns}.stratifier[${i}]`, "A measure group stratifier should have a code when there is more than one population");
      if (isObject(s.criteria)) criteriaIssues(s.criteria, `${ns}.stratifier[${i}].criteria`, libs, out);
    });
  });
  objects(measure.supplementalData).forEach((sd, c) => {
    if (isObject(sd.criteria)) criteriaIssues(sd.criteria, `${path}.supplementalData[${c}].criteria`, libs, out);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------- MeasureReport

class ReportValidator {
  readonly out: MeasureIssue[] = [];

  constructor(
    private readonly measure: Json,
    private readonly report: Json,
    private readonly deps: MeasureDeps,
  ) {}

  private rule(ok: boolean, path: string, message: string, code = "business-rule"): boolean {
    if (!ok) this.out.push({ severity: "error", path, code, message });
    return ok;
  }

  /** MeasureContext.scoring(group). */
  private scoring(group: Json): string | undefined {
    const ext = extension(group, EXT_CQM_SCORING);
    if (ext && isObject(ext.valueCodeableConcept)) return firstCode(ext.valueCodeableConcept);
    return firstCode(this.measure.scoring);
  }

  /** validateMeasureReportGroups l. 317-408. */
  async groups(path: string): Promise<void> {
    const mgs = objects(this.measure.group);
    if (!mgs.length) return;
    const glist = objects(this.report.group);
    if (glist.length === 1 && mgs.length === 1) {
      const mrg = glist[0];
      const ns = `${path}.group[0]`;
      const mg = mgs[0];
      if (isObject(mg.code) && isObject(mrg.code)) {
        if (this.rule(hasUseableCode(mrg.code), ns, "None of the codes provided are usable for comparison - need both system and code on at least one code")) {
          this.rule(codesMatch(mrg.code, mg.code), ns, `The code provided (${genCC(mrg.code)}) does not match the code specified in the measure report (${genCC(mg.code)})`);
          const id = mrg.id;
          this.rule(id === undefined || mg.id === undefined || id === mg.id, ns, `The linkId provided (${id}) does not match the code specified in the measure report (${mg.id})`);
        }
      }
      await this.group(mg, mrg, ns);
      return;
    }
    const seen: Json[] = [];
    for (let i = 0; i < glist.length; i++) {
      const mrg = glist[i];
      const ns = `${path}.group[${i}]`;
      const cc: Json | null = isObject(mrg.code) ? mrg.code : null;
      if (!this.rule(cc !== null, ns, "Group should have a code that matches the group definition in the measure")) continue;
      let mg: Json | null;
      if (typeof mrg.id === "string") {
        mg = mgs.find((t) => t.id === mrg.id) ?? null;
        // l. 372: the id branch passes the (null) linkId
        this.rule(mg !== null, ns, "The linkId 'null' for this group has no match in the measure definition");
        if (mg) this.rule(codesMatch(cc!, mg.code), ns, `The linkId 'null' links this group to a measure group that has a different code ('${genCC(cc)}' vs '${genCC(mg.code)}')`);
      } else {
        mg = forCode(mgs, cc!);
        this.rule(mg !== null, ns, `The code '${genCC(cc)}' for this group has no match in the measure definition`);
      }
      if (mg && this.rule(!seen.includes(mg), ns, "The linkId or code for this group is duplicated with another group")) {
        seen.push(mg);
        await this.group(mg, mrg, ns);
      }
    }
    for (const mg of mgs) {
      if (!seen.includes(mg)) this.rule(this.report.type === "data-collection", path, `The MeasureReport does not include a group for the group with code '${genCC(mg.code)}'`);
    }
  }

  private async group(mg: Json, mrg: Json, ns: string): Promise<void> {
    await this.populations(mg, mrg, ns);
    this.score(mg, mrg, ns);
    this.stratifiers(mg, mrg, ns);
  }

  private async populations(mg: Json, mrg: Json, stack: string): Promise<void> {
    const pops = objects(mg.population);
    const seen: Json[] = [];
    const plist = objects(mrg.population);
    for (let i = 0; i < plist.length; i++) {
      const p = plist[i];
      const ns = `${stack}.population[${i}]`;
      const cc: Json | null = isObject(p.code) ? p.code : null;
      if (!this.rule(cc !== null || p.id !== undefined, ns, "Group should have a code that matches the group population definition in the measure")) continue;
      let mgp: Json | null;
      if (typeof p.id === "string") {
        mgp = pops.find((t) => t.id === p.id) ?? null;
        this.rule(mgp !== null, ns, `The linkId '${p.id}' for this group population has no match in the measure definition`);
        if (mgp) this.rule(cc === null || codesMatch(cc, mgp.code), ns, `The linkId 'null' links this group population to a measure group population that has a different code ('${genCC(cc)}' vs '${genCC(mgp.code)}')`);
      } else {
        mgp = forCode(pops, cc!);
        this.rule(mgp !== null, ns, "The code for this group population has no match in the measure definition");
      }
      if (mgp && this.rule(!seen.includes(mgp), ns, "The linkId or code for this group population is duplicated with another population")) {
        seen.push(mgp);
        await this.population(p, ns);
      }
    }
    for (const mgp of pops) {
      if (!seen.includes(mgp) && !(isObject(mgp.code) && hasCoding(mgp.code, OBSERVATION_POPULATION, "measure-observation"))) {
        this.rule(false, stack, `The MeasureReport does not include a population for the population with linkId '${mgp.id ?? ""}' and code '${genCC(mgp.code)}'`);
      }
    }
  }

  /** addToSubjectCount l. 697-763: -1 = cannot be counted. */
  private async subjectCount(count: number, subject: Json): Promise<number> {
    if (count < 0) return -1;
    const ref = subject.reference;
    if (typeof ref !== "string") return -1;
    const target = await this.deps.resolveSubject(ref);
    const single = ["Patient", "Practitioner", "Person", "PractitionerRole", "RelatedPerson", "Device", "Location", "Organization"];
    if (!target) {
      const parts = ref.split("/");
      return parts.length === 2 && this.deps.isResourceName(parts[0]) && single.includes(parts[0]) ? count + 1 : -1;
    }
    if (single.includes(target.resourceType)) return count + 1;
    return target.resourceType === "List" ? count + objects(target.entry).length : -1;
  }

  private async population(p: Json, ns: string): Promise<void> {
    const subjects = list(p.subjectResults).filter(isObject);
    if (this.report.type === "subject-list") {
      let n = 0;
      for (const s of subjects) n = await this.subjectCount(n, s);
      if (typeof p.count === "number" && n > -1) this.rule(p.count === n, ns, `Mismatch between count ${p.count.toLocaleString("en-US")} and number of subjects ${n.toLocaleString("en-US")}`);
      return;
    }
    this.rule(subjects.length === 0, ns, "Reports where type is not 'subject-list' don't have subjects listed");
    if (p.count === undefined) this.out.push({ severity: "warning", path: ns, code: "business-rule", message: "Count should be present for reports where type is not 'subject-list'" });
  }

  private banned(ms: Json, key: string, at: string, scoring: string): void {
    if (ms[key] !== undefined) this.rule(false, `${at}.${key}`, `A measureScore for this Measure Scoring (${scoring}) should not have units`);
  }

  /** validateScore l. 461-600. */
  private score(mg: Json, mrg: Json, stack: string): void {
    const ms: Json | undefined = isObject(mrg.measureScore) ? mrg.measureScore : undefined;
    if (this.report.type === "data-collection") {
      if (ms) this.rule(false, `${stack}.measureScore`, "No measureScore when the type of the report is 'data-collection'");
      return;
    }
    const scoring = this.scoring(mg);
    if (scoring === undefined || !["cohort", "proportion", "ratio", "continuous-variable"].includes(scoring)) return;
    if (!this.rule(ms !== undefined, stack, `A measureScore is required when the Measure.scoring=${scoring}`, "required")) return;
    const m = ms!;
    const ns = `${stack}.measureScore`;
    // getNamedChild("value"): an element with only extensions is a child too
    let v: unknown = m.value ?? m._value;
    for (const url of EXT_DEQM_SCORE) {
      if (v === undefined) {
        const e = extension(m, url);
        if (e) v = Object.entries(e).find(([k]) => k.startsWith("value"))?.[1];
      }
    }
    const valueRequired = (): boolean => this.rule(v !== undefined, ns, `A value is required when the Measure.scoring = ${scoring}`, "required");
    if (scoring === "cohort" || scoring === "proportion") {
      for (const k of ["unit", "system", "code"]) this.banned(m, k, ns, scoring);
      if (valueRequired() && typeof v === "number") {
        if (scoring === "cohort") this.rule(v >= 0, `${ns}.value`, "The value is invalid - it must be greater than or equal to 0", "required");
        else this.rule(v >= 0 && v <= 1, `${ns}.value`, "The value is invalid - it must be between 0 and 1", "required");
      }
      return;
    }
    if (!valueRequired()) return;
    const c = extension(this.measure, EXT_Q_UNIT)?.valueCoding as Json | undefined;
    if (m.code !== undefined) {
      if (c) {
        this.rule(c.code === m.code, `${ns}.code`, `This value is fixed by the Measure to '${c.code}'`, "code-invalid");
        if (m.system !== undefined) this.rule(c.system === m.system, ns, `This value is fixed by the Measure to '${c.system}'`, "code-invalid");
      }
    } else if (c) {
      // DataRenderer.display(context, c): the Coding's display, else its code
      this.rule(false, ns, `This value is fixed by the Measure to '${c.display ?? c.code}'`, "not-found");
    } else if (scoring === "ratio") {
      this.out.push({ severity: "warning", path: ns, code: "not-found", message: "A unit should be present when the scoring type is ratio" });
    }
  }

  /** validateMeasureReportGroupStratifiers l. 770-823. */
  private stratifiers(mg: Json, mrg: Json, stack: string): void {
    const strats = objects(mg.stratifier);
    const seen: Json[] = [];
    objects(mrg.stratifier).forEach((s, i) => {
      const ns = `${stack}.stratifier[${i}]`;
      const cc: Json | null = isObject(s.code) ? s.code : Array.isArray(s.code) && isObject(s.code[0]) ? s.code[0] : null;
      if (!this.rule(cc !== null || s.id !== undefined, ns, "Group should have a code that matches the group stratifier definition in the measure")) return;
      let mgs: Json | null;
      if (typeof s.id === "string") {
        mgs = strats.find((t) => t.id === s.id) ?? null;
        this.rule(mgs !== null, ns, `The linkId '${s.id}' for this group stratifier has no match in the measure definition`);
      } else {
        mgs = stratifierForCode(strats, cc!);
        this.rule(mgs !== null, ns, `The code for this group stratifier has no match in the measure definition`);
        // two arguments for three placeholders (see the module comment)
        if (mgs) this.rule(codesMatch(cc!, mgs.code), ns, `The linkId '${genCC(cc)}' links this group stratifier to a measure group that has a different code ('${genCC(mgs.code)}' vs '{2}')`);
      }
      if (this.rule(mgs !== null, ns, "The code for this group stratifier has no match in the measure definition") && this.rule(!seen.includes(mgs!), ns, "The code for this group stratifier is duplicated with another group")) seen.push(mgs!);
    });
    for (const t of strats) {
      if (!seen.includes(t)) this.rule(false, stack, `The MeasureReport does not include a stratifier for the stratifier with code '${genCC(t.code)}' (id = '${mg.id !== undefined ? t.id : ""}')`);
    }
  }
}

/** MeasureValidator.validateMeasureReport l. 250-286. */
export async function validateMeasureReport(mr: Json, path: string, deps: MeasureDeps): Promise<MeasureIssue[]> {
  const measure = typeof mr.measure === "string" && mr.measure ? mr.measure : null;
  if (measure === null) return [{ severity: "information", path, code: "required", message: "No Measure is identified, so no validation can be performed against the Measure" }];
  const source = measure.startsWith("#") ? objects(mr.contained).find((c) => c.id === measure.slice(1) && c.resourceType === "Measure") ?? null : await deps.fetchMeasure(measure);
  if (!source) return [{ severity: "warning", path, code: "required", message: `The Measure '${measure}' could not be resolved, so no validation can be performed against the Measure` }];
  const v = new ReportValidator(source, mr, deps);
  await v.groups(path);
  return v.out;
}

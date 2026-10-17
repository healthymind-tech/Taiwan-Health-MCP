/**
 * Oracle-backed audit of fhir_get_profile_required_elements.
 *
 * For every example (top-level IG examples + Bundle entry resources) that the
 * builtin validator accepts against its declared profile:
 *   - necessity:   every row the tool reports (with `instance` = the example)
 *                  must be present in the example;
 *   - sufficiency: deleting a reported element must make the example invalid;
 *   - completeness (under-report): deleting each present element one at a time
 *                  must not raise a "required"/cardinality/invariant error
 *                  about an element the tool did not report.
 * Mutants flagged as findings are written out so they can be re-checked with
 * the HL7 validator_cli oracle (harness/cli_oracle.py).
 *
 *   DATABASE_URL=postgresql://... node --import tsx scripts/validator-audit/requiredElementsAudit.ts \
 *       corpus/examples.json.gz out_dir [ONLY=<substring>] [MAX_DEL=600]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { initPool, closePool, query } from "../../src/db.js";
import { FHIRIGService } from "../../src/fhirIgService.js";
import { patternMatches } from "../../src/fhirValidator.js";

const VERSIONS: Record<string, string> = { "tw.gov.mohw.twcore": "1.0.0", "tw.gov.mohw.nhi.pas": "1.2.7" };
const MAX_DEL = Number(process.env.MAX_DEL || 600);

type Loc = { holder: any; key: string; index: number | null; path: string; strip: string };
type Row = { id: string; required_by: string; grounding_class: string; path?: string };

const sdCache = new Map<string, any>();
async function loadSd(pkg: string, canonical: string): Promise<any | null> {
  const k = `${pkg}|${canonical}`;
  if (sdCache.has(k)) return sdCache.get(k);
  const r = await query<any>(
    `SELECT raw_json FROM fhir.artifacts WHERE resource_type='StructureDefinition' AND canonical_url=$1 ORDER BY (package_id=$2) DESC LIMIT 1`,
    [canonical.split("|")[0], pkg],
  );
  const sd = r.rows[0]?.raw_json ?? null;
  sdCache.set(k, sd);
  return sd;
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function stripSlices(id: string): string {
  return id.replace(/:[^.]+/g, "");
}

/** Concrete nodes of `res` at a snapshot element id; slice segments filtered by discriminator where decidable. */
function locate(res: any, id: string, sdEls: Map<string, any>): Loc[] {
  const segs = id.split(".");
  let cur: Loc[] = [{ holder: { [segs[0]]: res }, key: segs[0], index: null, path: segs[0], strip: segs[0] }];
  let idSoFar = segs[0];
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    const colon = seg.indexOf(":");
    const name = colon >= 0 ? seg.slice(0, colon) : seg;
    const slice = colon >= 0 ? seg.slice(colon + 1) : null;
    idSoFar = `${idSoFar}.${seg}`;
    const next: Loc[] = [];
    for (const l of cur) {
      const node = l.index === null ? l.holder[l.key] : l.holder[l.key][l.index];
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const keys: string[] = [];
      if (name.endsWith("[x]")) {
        const stem = name.slice(0, -3);
        for (const k of Object.keys(node)) if (k.startsWith(stem) && k.length > stem.length && /[A-Z]/.test(k[stem.length])) keys.push(k);
      } else if (name in node) keys.push(name);
      for (const k of keys) {
        const v = node[k];
        const items: Array<[number | null, any]> = Array.isArray(v) ? v.map((x, j) => [j, x]) : [[null, v]];
        for (const [j, x] of items) {
          if (slice && !sliceMatch(x, k, idSoFar, sdEls)) continue;
          next.push({ holder: node, key: k, index: j, path: `${l.path}.${k}${j === null ? "" : `[${j}]`}`, strip: `${l.strip}.${name}` });
        }
      }
    }
    cur = next;
  }
  return cur;
}

/** Decide slice membership for the discriminators we can evaluate; unknown -> true (candidate). */
function sliceMatch(item: any, jsonKey: string, sliceId: string, sdEls: Map<string, any>): boolean {
  const sliceEl = sdEls.get(sliceId);
  if (!sliceEl) return true;
  const baseId = sliceId.slice(0, sliceId.lastIndexOf(":"));
  const base = sdEls.get(baseId);
  const sliceName = sliceId.slice(sliceId.lastIndexOf(":") + 1);
  if (baseId.endsWith("[x]")) return jsonKey.toLowerCase() === sliceName.toLowerCase() || jsonKey.endsWith(sliceName.slice(baseId.split(".").pop()!.length - 3));
  const discs: any[] = base?.slicing?.discriminator || [];
  if (/\.(extension|modifierExtension)$/.test(baseId)) {
    const url = sdEls.get(`${sliceId}.url`)?.fixedUri ?? sliceEl.type?.[0]?.profile?.[0];
    return !url || item?.url === String(url).split("|")[0];
  }
  for (const d of discs) {
    const p = String(d.path || "$this");
    if (d.type === "value" || d.type === "pattern") {
      const elId = p === "$this" ? sliceId : `${sliceId}.${p}`;
      const el = sdEls.get(elId);
      if (!el) continue;
      const fk = Object.keys(el).find((k) => k.startsWith("fixed") || k.startsWith("pattern"));
      if (!fk) {
        // required sub-slice with a pattern (e.g. code.coding:x)
        const sub = [...sdEls.values()].find((s) => s.id?.startsWith(`${elId}.coding:`) && s.min >= 1 && Object.keys(s).some((k) => k.startsWith("pattern")));
        if (!sub) continue;
        const sk = Object.keys(sub).find((k) => k.startsWith("pattern"))!;
        const vals = getRel(item, `${p === "$this" ? "" : p}.coding`.replace(/^\./, ""));
        if (!vals.some((v) => patternMatches(v, sub[sk]))) return false;
        continue;
      }
      const vals = p === "$this" ? [item] : getRel(item, p);
      if (!vals.some((v) => patternMatches(v, el[fk]))) return false;
    } else if (d.type === "type") {
      const types: string[] = ((p === "$this" ? sliceEl : sdEls.get(`${sliceId}.${p}`))?.type || []).map((t: any) => t.code);
      const vals = p === "$this" ? [item] : getRel(item, p);
      if (types.length && !vals.some((v) => v && types.includes(v.resourceType))) return false;
    } else if (d.type === "profile") {
      const el = p === "$this" ? sliceEl : sdEls.get(`${sliceId}.${p}`);
      const profs: string[] = (el?.type || []).flatMap((t: any) => t.profile || []);
      const vals = p === "$this" ? [item] : getRel(item, p);
      if (profs.length && !vals.some((v) => v && (v.meta?.profile || []).some((u: string) => profs.includes(u)))) {
        // fall back to resource type of the profile name
        const types: string[] = (el?.type || []).map((t: any) => t.code);
        if (!vals.some((v) => v && types.includes(v.resourceType))) return false;
        return "unknown" as any;
      }
    }
  }
  return true;
}

function getRel(node: any, rel: string): any[] {
  let cur: any[] = [node];
  for (const seg of rel.split(".").filter(Boolean)) {
    const nx: any[] = [];
    for (const n of cur) {
      if (!n || typeof n !== "object") continue;
      if (seg === "resolve()") {
        nx.push(n);
        continue;
      }
      const v = n[seg];
      if (Array.isArray(v)) nx.push(...v);
      else if (v !== undefined) nx.push(v);
    }
    cur = nx;
  }
  return cur;
}

/** Remove the given nodes (by JSON path) from a clone, pruning containers left empty. */
function removePaths(res: any, paths: string[]): any {
  const out = clone(res);
  // sort descending so array indices stay valid
  const parsed = paths.map((p) => p.split(".").slice(1).map((s) => {
    const m = /^(.*)\[(\d+)\]$/.exec(s);
    return m ? { k: m[1], i: Number(m[2]) } : { k: s, i: null as number | null };
  }));
  parsed.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i].k !== b[i].k) return 0;
      if ((a[i].i ?? -1) !== (b[i].i ?? -1)) return (b[i].i ?? -1) - (a[i].i ?? -1);
    }
    return b.length - a.length;
  });
  for (const segs of parsed) {
    let node: any = out;
    for (let i = 0; i < segs.length - 1 && node; i++) node = segs[i].i === null ? node[segs[i].k] : node[segs[i].k]?.[segs[i].i!];
    if (!node) continue;
    const last = segs[segs.length - 1];
    if (last.i === null) delete node[last.k];
    else if (Array.isArray(node[last.k])) node[last.k][last.i] = undefined;
  }
  return prune(out) ?? {};
}

function prune(v: any): any {
  if (Array.isArray(v)) {
    const a = v.filter((x) => x !== undefined).map(prune).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (p !== undefined) o[k] = p;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return v;
}

/** Every concrete location in the resource (depth-first), excluding resourceType / id. */
function allLocations(res: any, rt: string, sdPaths: Set<string>): Loc[] {
  const out: Loc[] = [];
  const walk = (node: any, path: string, strip: string): void => {
    for (const [k, v] of Object.entries(node)) {
      if (k === "resourceType" || k.startsWith("_")) continue;
      let name = k;
      for (const p of sdPaths) {
        if (p.startsWith(`${strip}.`) && p.endsWith("[x]")) {
          const stem = p.slice(strip.length + 1, -3);
          if (!stem.includes(".") && k.startsWith(stem) && k.length > stem.length && /[A-Z]/.test(k[stem.length])) name = `${stem}[x]`;
        }
      }
      const items: Array<[number | null, any]> = Array.isArray(v) ? v.map((x, j) => [j, x]) : [[null, v]];
      for (const [j, x] of items) {
        const p = `${path}.${k}${j === null ? "" : `[${j}]`}`;
        out.push({ holder: node, key: k, index: j, path: p, strip: `${strip}.${name}` });
        // do not descend into resources nested in Bundle.entry / contained (they have their own profile)
        if (x && typeof x === "object" && !Array.isArray(x) && !(x.resourceType && p !== rt)) walk(x, p, `${strip}.${name}`);
      }
    }
  };
  walk(res, rt, rt);
  return out;
}

/** Why deleting a reported element raised no error (see report). */
function whyNotSufficient(r: Row, locs: Loc[], sdEls: Map<string, any>): string {
  if (r.required_by.startsWith("target-implied")) return "target-implied (by design not a conformance rule)";
  // slice discriminator: the deleted element is (part of) what assigns the item to the slice
  const m = /^(.*:[^.]+)\.(.+)$/.exec(r.id);
  if (m) {
    const sliceId = m[1];
    const rel = stripSlices(m[2]).replace(/\[x\]/g, "");
    const base = sdEls.get(sliceId.slice(0, sliceId.lastIndexOf(":")));
    for (const d of base?.slicing?.discriminator || []) {
      const dp = String(d.path || "");
      if (dp === "$this" || rel === dp || dp.startsWith(`${rel}.`) || rel.startsWith(`${dp}.`)) return `slice discriminator (${d.type}:${dp}) — item leaves the optional slice`;
    }
  }
  // deletion emptied the parent, which the harness prunes (the parent is optional)
  if (locs.every((l) => {
    const parent = l.holder;
    return Object.keys(parent).filter((k) => k !== l.key && k !== "id").length === 0;
  })) return "parent emptied and pruned (parent optional)";
  return "UNEXPLAINED";
}

function errorsOf(env: any): any[] {
  const d = env.data || {};
  const iss = [...(d.issues || [])];
  return iss.filter((i) => i.severity === "error" || i.severity === "fatal");
}

const REQ_RE = /^(\S+): minimum required = (\d+), but only found (\d+) \(from ([^)]+)\)/;
const SLICE_RE = /^Slice '([^']+)': a matching slice is required, but not found \(from ([^)]+)\)/;

async function main(): Promise<void> {
  const raw = readFileSync(process.argv[2]);
  const corpus = JSON.parse((process.argv[2].endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
  const outDir = process.argv[3];
  mkdirSync(outDir, { recursive: true });
  const only = process.env.ONLY;
  initPool({ maxSize: 4 });
  const svc = new FHIRIGService(null);

  // instances: top-level + bundle entries + contained
  const insts: Array<{ key: string; pkg: string; res: any }> = [];
  const seen = new Set<string>();
  for (const c of corpus) {
    const push = (key: string, res: any): void => {
      if (!res?.meta?.profile?.length) return;
      const h = JSON.stringify(res);
      if (seen.has(h)) return;
      seen.add(h);
      insts.push({ key, pkg: c.pkg, res });
    };
    push(c.key, c.res);
    if (c.res.resourceType === "Bundle") (c.res.entry || []).forEach((e: any, i: number) => push(`${c.key}#entry[${i}]`, e.resource));
    (c.res.contained || []).forEach((r: any, i: number) => push(`${c.key}#contained[${i}]`, r));
  }

  const report: any[] = [];
  const cliItems: any[] = [];
  let nDel = 0;
  for (const inst of insts) {
    if (only && !inst.key.includes(only)) continue;
    const ver = VERSIONS[inst.pkg];
    const profile = String(inst.res.meta.profile[0]).split("|")[0];
    const sd = await loadSd(inst.pkg, profile);
    if (!sd) {
      report.push({ key: inst.key, profile, skipped: "profile not found" });
      continue;
    }
    const sdEls = new Map<string, any>((sd.snapshot?.element || []).map((e: any) => [e.id, e]));
    const sdPaths = new Set<string>((sd.snapshot?.element || []).map((e: any) => e.path));
    const validate = async (r: any): Promise<any[]> => {
      nDel++;
      return errorsOf(JSON.parse(await svc.validateResource(r, profile, inst.pkg, ver)));
    };
    const base = await validate(inst.res);
    if (base.length) {
      report.push({ key: inst.key, profile: sd.id, skipped: "baseline invalid", errors: base.slice(0, 5).map((e) => e.message) });
      continue;
    }
    const env = JSON.parse(await svc.getProfileRequiredElements(profile, inst.pkg, ver, inst.res, true, false, "full"));
    if (!env.ok) {
      report.push({ key: inst.key, profile: sd.id, skipped: `tool error ${env.error?.message}` });
      continue;
    }
    const rows: Row[] = env.data.elements;
    const rowIds = new Set(rows.map((r) => r.id));
    const rowStrip = new Set(rows.map((r) => stripSlices(r.id)));
    const rowRes = rows.map((r) => new RegExp(`^${stripSlices(r.id).replace(/[.]/g, "\\.").replace(/\[x\]/g, "(\\[x\\]|[A-Z][A-Za-z]*)")}$`));
    const coveredStrip = (strip: string): boolean => rowRes.some((re) => re.test(strip));
    // deleting a leaf can empty (and prune) its ancestors: the error then names an ancestor element;
    // it is explained when a reported row sits at that ancestor (same last segment).
    const coveredAnc = (strip: string, errEl: string): boolean => {
      const tail = errEl.split(".").pop()!.replace(/\[x\]|:.*$/g, "");
      const segs = strip.split(".");
      for (let i = segs.length; i > 1; i--) {
        const pre = segs.slice(0, i).join(".");
        const last = segs[i - 1].replace(/\[x\]$/, "");
        if ((last === tail || last.startsWith(tail)) && coveredStrip(pre)) return true;
      }
      return false;
    };
    const listedInv = new Set<string>((env.data.invariants || []).map((i: any) => i.key));
    const rec: any = { key: inst.key, profile: sd.id, rows: rows.length, missing: [], notSufficient: [], under: [], sufficiencyWeak: [], deletions: 0 };

    // necessity + sufficiency
    for (const r of rows) {
      const locs = locate(inst.res, r.id, sdEls);
      if (!locs.length) {
        rec.missing.push({ id: r.id, required_by: r.required_by });
        continue;
      }
      const mut = removePaths(inst.res, locs.map((l) => l.path));
      const errs = await validate(mut);
      rec.deletions++;
      if (!errs.length) {
        rec.notSufficient.push({ id: r.id, required_by: r.required_by, deleted: locs.map((l) => l.path), why: whyNotSufficient(r, locs, sdEls) });
        cliItems.push({ pkg: inst.pkg, key: `suff|${inst.key}|${r.id}`, res: mut });
        continue;
      }
      // CLI_SAMPLE=n: also hand every n-th confirming deletion to the CLI oracle (agreement check)
      if (Number(process.env.CLI_SAMPLE || 0) > 0 && rec.deletions % Number(process.env.CLI_SAMPLE) === 0) {
        cliItems.push({ pkg: inst.pkg, key: `suffok|${inst.key}|${r.id}`, res: mut, ours: errs.slice(0, 3).map((e) => e.message) });
      }
      const sid = stripSlices(r.id);
      const anc = r.id.split(".").map((_, i, a) => a.slice(0, i + 1).join("."));
      const key = r.required_by.startsWith("invariant:") ? r.required_by.split(" ")[0].slice(10) : null;
      const strong = errs.some(
        (e) =>
          anc.some((a) => String(e.message).includes(a) || String(e.message).includes(stripSlices(a))) ||
          (key && String(e.message).includes(key)) ||
          (r.required_by.includes("ext-1") && String(e.message).includes("ext-1")) ||
          String(e.message).includes(`.${sid.split(".").pop()}: minimum required`) ||
          String(e.path || "").includes(sid.split(".").pop()!.replace("[x]", "")),
      );
      if (!strong) rec.sufficiencyWeak.push({ id: r.id, errors: errs.slice(0, 3).map((e) => `${e.path}: ${e.message}`) });
    }

    // under-report: delete each present location one at a time
    const locs = allLocations(inst.res, inst.res.resourceType, sdPaths).slice(0, MAX_DEL);
    for (const l of locs) {
      const mut = removePaths(inst.res, [l.path]);
      const errs = await validate(mut);
      rec.deletions++;
      for (const e of errs) {
        const msg = String(e.message || "");
        let elId: string | null = null;
        let from: string | null = null;
        let m = REQ_RE.exec(msg);
        if (m) {
          elId = m[1];
          from = m[4];
        } else if ((m = SLICE_RE.exec(msg))) {
          elId = m[1];
          from = m[2];
        }
        if (elId) {
          if (rowIds.has(elId) || rowStrip.has(elId)) continue;
          if (from?.split("|")[0] !== profile && (coveredStrip(l.strip) || coveredAnc(l.strip, elId))) continue; // datatype / extension-definition row
          // a required child of the deleted node whose parent is now empty+pruned: covered when parent reported
          rec.under.push({ deleted: l.path, element: elId, from, sameProfile: from?.split("|")[0] === profile, message: msg.slice(0, 200) });
          if (from?.split("|")[0] === profile) cliItems.push({ pkg: inst.pkg, key: `under|${inst.key}|${l.path}`, res: mut });
        } else if (e.code === "invariant") {
          const k = /Constraint failed: ([^:]+):/.exec(msg)?.[1] ?? msg.slice(0, 40);
          // explained when the deleted node's element is reported, or the rule is listed in `invariants`
          if (coveredStrip(l.strip)) continue;
          const defined = /defined in ([^)\s]+)/.exec(msg)?.[1] ?? "";
          const base = /^http:\/\/hl7\.org\/fhir\/StructureDefinition\/[A-Z]/.test(defined) || k === "ext-1";
          rec.under.push({ deleted: l.path, element: `invariant ${k}`, from: defined, sameProfile: null, listed: listedInv.has(k), baseRule: base, message: msg.slice(0, 200), path: e.path });
        }
      }
    }
    report.push(rec);
    const flag = rec.missing.length + rec.notSufficient.length + rec.under.length;
    console.error(`${inst.key} [${sd.id}] rows=${rows.length} del=${rec.deletions} missing=${rec.missing.length} notSuff=${rec.notSufficient.length} weak=${rec.sufficiencyWeak.length} under=${rec.under.length}${flag ? " *" : ""}`);
  }
  writeFileSync(join(outDir, "required_audit.json"), JSON.stringify(report, null, 1));
  writeFileSync(join(outDir, "required_audit_cli_items.json"), JSON.stringify(cliItems));
  console.error(`instances=${report.length} validations=${nDel}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

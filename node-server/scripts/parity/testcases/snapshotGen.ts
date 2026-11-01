/**
 * Simplified differential → snapshot generator for the offline test-case runners (scripts only;
 * the server works on published snapshots). Not a port of ProfileUtilities: it covers what the
 * fhir-test-cases profiles use — merge onto the base snapshot by id, element ids derived from
 * path + slice context (XML differentials carry none), new slices copied from their slicer's
 * subtree, datatype children expanded on demand, choice renames (valueQuantity → value[x]),
 * constraints appended, profile-on-profile recursion.
 */

type Json = Record<string, any>;
export type SdFetch = (url: string) => Json | null;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function fhirType(t: Json): string {
  const ext = (t.extension || []).find((e: Json) => e.url === "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type");
  return ext ? (ext.valueUrl ?? ext.valueUri) : t.code;
}

/** Ids for differential elements that lack one (path + the slice context of earlier elements). */
export function assignDiffIds(diff: Json[]): void {
  const ctx = new Map<string, string>();
  for (const e of diff) {
    const path: string = e.path;
    for (const k of [...ctx.keys()]) if (k === path || k.startsWith(path + ".")) ctx.delete(k);
    if (e.sliceName) ctx.set(path, e.sliceName);
    if (e.id) continue;
    const segs = path.split(".");
    const idSegs: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const p = segs.slice(0, i + 1).join(".");
      const s = ctx.get(p);
      idSegs.push(s ? `${segs[i]}:${s}` : segs[i]);
    }
    e.id = idSegs.join(".");
  }
}

export class SnapshotGenerator {
  private done = new Map<string, Json>();
  constructor(private readonly fetch: SdFetch) {}

  /** The SD with a snapshot (generated when absent); null when the base chain cannot be resolved. */
  ensure(sd: Json): Json | null {
    if (sd.snapshot?.element?.length) return sd;
    const key = String(sd.url);
    if (this.done.has(key)) return this.done.get(key)!;
    const baseUrl = String(sd.baseDefinition || "").split("|")[0];
    const base0 = baseUrl ? this.fetch(baseUrl) : null;
    const base = base0 ? this.ensure(base0) : null;
    if (!base) return null;
    const snap: Json[] = clone(base.snapshot.element);
    const diff: Json[] = clone(sd.differential?.element || []);
    assignDiffIds(diff);
    const renames: Array<[string, string]> = [];
    for (const d0 of diff) {
      const d = { ...d0 };
      for (const [from, to] of renames) {
        if (d.id === from || d.id.startsWith(from + ".") || d.id.startsWith(from + ":")) {
          d.id = to + d.id.slice(from.length);
          break;
        }
      }
      let i = this.locate(snap, d, renames);
      if (i < 0) continue;
      this.merge(snap[i], d);
    }
    const out = { ...sd, snapshot: { element: snap } };
    this.done.set(key, out);
    return out;
  }

  private typeSd(code: string): Json | null {
    const sd = this.fetch(code.includes("/") ? code : `http://hl7.org/fhir/StructureDefinition/${code}`);
    return sd ? this.ensure(sd) : null;
  }

  /** Index of the snapshot element for diff element `d` (creating slices / expanding types). */
  private locate(snap: Json[], d: Json, renames: Array<[string, string]>, depth = 0): number {
    if (depth > 8) return -1;
    const id: string = d.id;
    let i = snap.findIndex((e) => e.id === id);
    if (i >= 0) return i;
    const lastDot = id.lastIndexOf(".");
    const lastSeg = id.slice(lastDot + 1);
    const colon = lastSeg.indexOf(":");
    if (d.sliceName && colon >= 0) {
      const name: string = d.sliceName;
      const slicerId = name.includes("/") ? id.slice(0, id.length - name.length - 1) + ":" + name.split("/").slice(0, -1).join("/") : id.slice(0, id.length - name.length - 1);
      let s = snap.findIndex((e) => e.id === slicerId);
      if (s < 0) {
        // choice type slice named by type: Observation.value[x]:valueQuantity
        s = this.locate(snap, { id: slicerId, path: d.path }, renames, depth + 1);
        if (s < 0) return -1;
      }
      const slicer = snap[s];
      let end = s;
      for (let k = s + 1; k < snap.length; k++) {
        const kid: string = snap[k].id;
        if (kid.startsWith(slicerId + ".") || kid.startsWith(slicerId + ":") || kid.startsWith(slicerId + "/")) end = k;
        else break;
      }
      const copies: Json[] = [];
      const root = clone(slicer);
      delete root.slicing;
      root.id = id;
      root.sliceName = name;
      copies.push(root);
      for (let k = s + 1; k <= end; k++) {
        const kid: string = snap[k].id;
        if (!kid.startsWith(slicerId + ".")) continue;
        const c = clone(snap[k]);
        c.id = id + kid.slice(slicerId.length);
        copies.push(c);
      }
      snap.splice(end + 1, 0, ...copies);
      return end + 1;
    }
    if (lastDot < 0) return -1;
    const parentId = id.slice(0, lastDot);
    let p = snap.findIndex((e) => e.id === parentId);
    if (p < 0) {
      p = this.locate(snap, { id: parentId, path: d.path.split(".").slice(0, -1).join(".") }, renames, depth + 1);
      if (p < 0) return -1;
    }
    const parent = snap[p];
    // choice rename: Observation.valueQuantity → Observation.value[x] (or its type slice)
    const name = colon >= 0 ? lastSeg.slice(0, colon) : lastSeg;
    for (let k = p + 1; k < snap.length; k++) {
      const kid: string = snap[k].id;
      if (!kid.startsWith(parentId + ".")) break;
      const seg = kid.slice(parentId.length + 1);
      if (!seg.endsWith("[x]") || seg.includes(".") || seg.includes(":")) continue;
      const base = seg.slice(0, -3);
      if (!name.startsWith(base) || name === seg) continue;
      const suffix = name.slice(base.length);
      const t = (snap[k].type || []).find((x: Json) => fhirType(x).toLowerCase() === suffix.toLowerCase());
      if (!t) continue;
      const xid = `${parentId}.${seg}`;
      if (snap[k].slicing) {
        const sid = `${xid}:${name}`;
        renames.push([id, sid]);
        let j = snap.findIndex((e) => e.id === sid);
        if (j < 0) j = this.locate(snap, { id: sid, path: snap[k].path, sliceName: name }, renames, depth + 1);
        if (j >= 0) {
          snap[j].type = [clone(t)];
          d.id = sid;
          d.path = snap[k].path;
          if (!d.sliceName) d.sliceName = name;
        }
        return j;
      }
      renames.push([id, xid]);
      snap[k].type = [clone(t)];
      d.id = xid;
      d.path = snap[k].path;
      return k;
    }
    // expand the parent's datatype children
    if (snap.some((e, k) => k > p && String(e.id).startsWith(parentId + ".") && k === p + 1)) return -1;
    const types = parent.type || [];
    if (types.length !== 1) return -1;
    const code = fhirType(types[0]);
    if (code === "BackboneElement" || code === "Element") {
      return -1;
    }
    const prof = (types[0].profile || [])[0];
    const tsd = (prof && code === "Extension" ? this.typeSd(prof) : null) ?? this.typeSd(code);
    if (!tsd) return -1;
    const els: Json[] = clone(tsd.snapshot.element);
    const rootPath: string = els[0].path;
    const rootId: string = els[0].id;
    const kids = els.slice(1).map((e) => ({
      ...e,
      id: parentId + String(e.id).slice(rootId.length),
      path: parent.path + String(e.path).slice(rootPath.length),
    }));
    snap.splice(p + 1, 0, ...kids);
    i = snap.findIndex((e) => e.id === id);
    return i >= 0 ? i : this.locate(snap, d, renames, depth + 1);
  }

  private merge(target: Json, d: Json): void {
    for (const [k, v] of Object.entries(d)) {
      if (k === "id" || k === "path") continue;
      if (k === "constraint") {
        target.constraint = [...(target.constraint || []), ...clone(v as Json[])];
        continue;
      }
      if (k.startsWith("fixed") || k.startsWith("pattern")) {
        for (const tk of Object.keys(target)) if (tk.startsWith("fixed") || tk.startsWith("pattern")) delete target[tk];
      }
      if (k === "slicing" && target.slicing) {
        target.slicing = { ...target.slicing, ...clone(v as Json) };
        continue;
      }
      target[k] = clone(v);
    }
  }
}

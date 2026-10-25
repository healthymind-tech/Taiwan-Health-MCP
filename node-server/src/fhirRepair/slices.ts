/**
 * Required fixed slices (ISSUES_v14.1 item 6, rule `fixed-slice`): a profile that requires a slice
 * (min ≥ 1) whose content the profile fully determines — a Coding / CodeableConcept slice given by
 * its fixed[x] / pattern[x] value, or by fixed / pattern values of its children (system, code …) —
 * and the instance has no item of that slice (e.g. a pulse-oximetry profile requiring two codings in
 * Observation.code.coding, a vital-signs profile requiring category:VSCat): the determined value is
 * added. Only when
 *   - every required child of the slice is given by the fixed / pattern value (nothing invented),
 *   - the new value is a member of that slice by the discriminators (fhirAuthoring.decidedSliceMatch),
 *   - no item present is already a member, and the element's max is not exceeded.
 * The element holding the slices must exist (its parent node is present); nothing else is touched.
 */

import { decidedSliceMatch } from "../fhirAuthoring.js";
import { fixedPattern } from "../fhirSnapshot.js";
import type { RepairChange, RepairIssue } from "./types.js";
import { baseMax, cloneTree, isObject, typeCodes, type Member, type Session, type Site } from "./walk.js";

type El = Record<string, any>;

function pinned(el: El): unknown {
  const [f, p] = fixedPattern(el);
  return f ? f.value : p ? p.value : undefined;
}

/** The value a slice definition determines (null = not fully determined). */
function determinedValue(member: Member, slice: El): Record<string, any> | null {
  const types = typeCodes(slice);
  if (types.length !== 1 || (types[0] !== "Coding" && types[0] !== "CodeableConcept")) return null;
  const sdx = member.view.sdx;
  const own = pinned(slice);
  let value: Record<string, any> | null = isObject(own) ? cloneTree(own) : null;
  const children = sdx.childrenOfId(String(slice.id));
  if (!value) {
    if (types[0] !== "Coding" || !children) return null;
    const v: Record<string, any> = {};
    for (const grp of children.values()) {
      const def = grp.base;
      if (!def) continue;
      const pv = pinned(def);
      if (pv !== undefined && (typeof pv === "string" || typeof pv === "boolean")) v[grp.name] = pv;
    }
    if (typeof v.code !== "string" || typeof v.system !== "string") return null;
    // Conventional Coding key order: system, version, code, display, then the rest.
    const order = ["system", "version", "code", "display"];
    value = Object.fromEntries([...order.filter((k) => k in v).map((k) => [k, v[k]]), ...Object.entries(v).filter(([k]) => !order.includes(k))]);
  }
  if (!value) return null;
  let fin: Record<string, any> = value;
  if (types[0] === "Coding") {
    // Conventional Coding key order (a pattern may list code before system).
    const order = ["system", "version", "code", "display"];
    const v = fin;
    fin = Object.fromEntries([...order.filter((k) => k in v).map((k) => [k, v[k]]), ...Object.entries(v).filter(([k]) => !order.includes(k))]);
  }
  // Every required child must be given by the determined value.
  if (children) {
    for (const grp of children.values()) {
      const def = grp.base;
      if (!def || Number(def.min ?? 0) < 1) continue;
      if (!(grp.name in fin)) return null;
    }
  }
  if (types[0] === "Coding" && (typeof fin.code !== "string" || typeof fin.system !== "string")) return null;
  if (types[0] === "CodeableConcept" && !(Array.isArray(fin.coding) && fin.coding.length && fin.coding.every((c: unknown) => isObject(c) && typeof c.code === "string" && typeof c.system === "string"))) return null;
  return fin;
}

export async function repairSlices(_session: Session, sites: Site[], rp: (p: string) => string, skip: (p: string) => boolean): Promise<{ changes: RepairChange[]; issues: RepairIssue[] }> {
  const changes: RepairChange[] = [];
  const issues: RepairIssue[] = [];
  // Nodes (objects) with their definitions: every object site, plus each resource root.
  const nodes = new Map<Record<string, any>, { path: string; members: Member[] }>();
  const add = (node: unknown, path: string, members: Member[]): void => {
    if (!isObject(node) || !members.length) return;
    const cur = nodes.get(node);
    if (cur) {
      for (const m of members) if (!cur.members.includes(m)) cur.members.push(m);
    } else nodes.set(node, { path, members: [...members] });
  };
  for (const s of sites) {
    if (s.ownerPath === s.resourcePath) add(s.holder, s.ownerPath, s.ownerMembers);
    if (!s.unknown) add(s.value, s.path, s.members);
  }
  const done = new Set<string>();
  for (const [node, { path, members }] of nodes) {
    for (const m of members) {
      for (const id of m.ids) {
        const groups = m.view.sdx.childrenOfId(id);
        if (!groups) continue;
        for (const grp of groups.values()) {
          if (!grp.slices.length || grp.name.endsWith("[x]") || grp.name === "extension" || grp.name === "modifierExtension") continue;
          for (const slice of grp.slices) {
            if (Number(slice.min ?? 0) < 1) continue;
            const key = `${path}\u0000${grp.name}\u0000${slice.id}`;
            if (done.has(key)) continue;
            done.add(key);
            const elPath = `${path}.${grp.name}`;
            if (skip(elPath)) continue;
            const value = determinedValue(m, slice);
            if (!value) continue;
            const raw = node[grp.name];
            if (raw !== undefined && !Array.isArray(raw) && !isObject(raw)) continue;
            const items: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
            let present = false;
            try {
              present = items.some((it) => decidedSliceMatch(it, grp.name, String(slice.id), m.view.E));
              if (present) continue;
              if (!decidedSliceMatch(value, grp.name, String(slice.id), m.view.E)) continue;
            } catch {
              continue;
            }
            const max = baseMax(grp.base || slice);
            const elMax = grp.base && grp.base.max !== undefined ? String(grp.base.max) : max;
            if (elMax !== "*" && Number(elMax) <= items.length) continue;
            if (max === "1" && items.length) continue;
            const given = items.length;
            if (Array.isArray(raw)) raw.push(value);
            else if (raw === undefined) node[grp.name] = max === "1" ? value : [value];
            else node[grp.name] = [raw, value];
            const at = Array.isArray(node[grp.name]) ? `${elPath}[${(node[grp.name] as unknown[]).length - 1}]` : elPath;
            changes.push({
              path: rp(at), from: null, to: value, rule: "fixed-slice",
              reason: `the profile ${m.view.url} requires slice '${slice.sliceName ?? String(slice.id).split(":").pop()}' of ${elPath.split(".").slice(1).join(".") || grp.name} (min ${slice.min}), whose value it fixes; none of the ${given} item(s) given is that slice`,
            });
          }
        }
      }
    }
  }
  return { changes, issues };
}

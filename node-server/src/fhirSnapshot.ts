/**
 * StructureDefinition snapshot projector. Pure, stateless helpers over a
 * StructureDefinition's `snapshot.element` array. Faithful port of
 * `src/fhir_snapshot.py`.
 */

type SD = Record<string, any>;
type El = Record<string, any>;

function elements(sd: SD): El[] {
  return (sd.snapshot || {}).element || [];
}

export interface FixedPattern {
  field: string;
  value: any;
}

/** Extract a `fixed[x]` / `pattern[x]` value (type encoded in key suffix). */
export function fixedPattern(el: El): [FixedPattern | null, FixedPattern | null] {
  let fixed: FixedPattern | null = null;
  let pattern: FixedPattern | null = null;
  for (const [key, value] of Object.entries(el)) {
    if (key.startsWith("fixed") && key !== "fixed") {
      fixed = { field: key, value };
    } else if (key.startsWith("pattern") && key !== "pattern") {
      pattern = { field: key, value };
    }
  }
  return [fixed, pattern];
}

/** True when an element belongs to a slice (slice root or any descendant). */
export function isSliceMember(el: El): boolean {
  return String(el.id || "").includes(":");
}

function types(el: El): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const t of el.type || []) {
    const item: Record<string, any> = { code: t.code };
    if (t.targetProfile) item.targetProfile = t.targetProfile;
    if (t.profile) item.profile = t.profile;
    out.push(item);
  }
  return out;
}

function binding(el: El): Record<string, any> | null {
  const b = el.binding;
  if (!b) return null;
  return { strength: b.strength, valueSet: b.valueSet };
}

function constraints(el: El): Array<Record<string, any>> {
  return (el.constraint || []).map((c: any) => ({
    key: c.key,
    severity: c.severity,
    human: c.human,
    expression: c.expression,
  }));
}

/** LLM-friendly projection of a single snapshot element. */
export function projectElement(el: El): Record<string, any> {
  const [fixed, pattern] = fixedPattern(el);
  // Mirror Python dict.get(...) — every key is present, absent values are null
  // (JSON.stringify would otherwise drop `undefined` keys, e.g. sliceName).
  return {
    id: el.id ?? null,
    path: el.path ?? null,
    sliceName: el.sliceName ?? null,
    min: el.min ?? null,
    max: el.max ?? null,
    mustSupport: Boolean(el.mustSupport),
    types: types(el),
    binding: binding(el),
    fixed,
    pattern,
    short: el.short ?? null,
    constraints: constraints(el),
  };
}

export function projectElements(sd: SD): Array<Record<string, any>> {
  return elements(sd).map(projectElement);
}

/** Set of element paths — used by the profile ranker. */
export function elementPaths(sd: SD): Set<string> {
  const out = new Set<string>();
  for (const e of elements(sd)) {
    if (e.path) out.add(e.path);
  }
  return out;
}

/** One element by path (optionally a named slice). */
export function getElement(sd: SD, path: string, sliceName: string | null = null): Record<string, any> | null {
  for (const el of elements(sd)) {
    if (el.path === path && (sliceName === null || el.sliceName === sliceName)) {
      return projectElement(el);
    }
  }
  return null;
}

export function getBinding(sd: SD, path: string): Record<string, any> | null {
  const el = getElement(sd, path);
  if (el === null) return null;
  return { path, binding: el.binding, types: el.types };
}

/** `onset[x]` + `dateTime` → `onsetDateTime` (the JSON property name). */
export function choiceProperty(path: string, typeCode: string): string {
  const base = path.split(".").pop() || "";
  const stem = base.endsWith("[x]") ? base.slice(0, -3) : base;
  if (!typeCode) return stem;
  return stem + typeCode.slice(0, 1).toUpperCase() + typeCode.slice(1);
}

/** Resolve a `[x]` choice element to allowed types + JSON property names. */
export function getChoices(sd: SD, path: string): Record<string, any> | null {
  for (const el of elements(sd)) {
    if (el.path === path) {
      const choices = (el.type || []).map((t: any) => ({
        type: t.code,
        jsonProperty: choiceProperty(path, t.code || ""),
      }));
      return { path, min: el.min, max: el.max, choices };
    }
  }
  return null;
}

/** Slicing rules/discriminator at `path` + the defined slices. */
export function getSlices(sd: SD, path: string): Record<string, any> | null {
  const els = elements(sd);
  let head: El | null = null;
  for (const el of els) {
    if (el.path === path && el.slicing) {
      head = el;
      break;
    }
  }
  if (head === null) return null;
  const slicing = head.slicing;
  const slices = els
    .filter((el: El) => el.path === path && el.sliceName)
    .map(projectElement);
  return {
    path,
    slicing: { rules: slicing.rules, discriminator: slicing.discriminator },
    slices,
  };
}

/**
 * LOINC axis vocabulary: what a query says about the specimen (SYSTEM), timing (TIME),
 * method, property and scale of the test it means — for search_loinc and the LOINC branch
 * of fhir_normalize_code (pure, no I/O).
 *
 * A LOINC term is COMPONENT : PROPERTY : TIME : SYSTEM : SCALE : METHOD. A query such as
 * "venous lactate", "24 hour urine protein", "salivary cortisol", "neutrophils %" or
 * "urine glucose dipstick" names the analyte AND one or more of the other axes; without
 * understanding those words the analyte's most common term (serum / plasma, point in
 * time) wins on its usage prior. The vocabulary is derived from LOINC's own data, shipped
 * in the release zip the LOINC import already reads:
 *  - each axis value's part name and PartDisplayName (AccessoryFiles/PartFile/Part.csv:
 *    SYSTEM "BldV" = "Venous blood", TIME "24H" = "24 hours", METHOD "Test strip");
 *  - Loinc.csv RELATEDNAMES2, which Regenstrief assembles from the synonyms of every part
 *    of a term. A related name listed on (nearly) every term of an axis value — and
 *    mostly on terms with that value — is a synonym of that value ("Venous" / "Bld ven" on BldV, "Random"
 *    on Pt, "Percent" on the fraction properties, "Dipstick" on Test strip, "Spinal
 *    fluid" on CSF, "Fecal" on Stool). A name that qualifies for several axes belongs to
 *    the one it pins down most narrowly (fewest values): "Random" → TIME Pt, not the 150
 *    properties whose terms are mostly Pt too.
 *
 * The query side ({@link parseAxisConstraints}) finds these names in a query (longest
 * span first; a plural or adjectival form folds onto the name: "hours" → "hour",
 * "salivary" → "saliva") and returns one constraint per span; {@link axisAgreement} scores
 * a term against them.
 */

export type LoincAxis = "system" | "time" | "method" | "property" | "scale";

/** Loinc.csv column, Part.csv PartTypeName and loinc.concepts column of each axis. */
export const LOINC_AXES: Record<LoincAxis, { csv: string; partType: string; column: string }> = {
  system: { csv: "SYSTEM", partType: "SYSTEM", column: "system" },
  time: { csv: "TIME_ASPCT", partType: "TIME", column: "time_aspect" },
  method: { csv: "METHOD_TYP", partType: "METHOD", column: "method_type" },
  property: { csv: "PROPERTY", partType: "PROPERTY", column: "property" },
  scale: { csv: "SCALE_TYP", partType: "SCALE", column: "scale_type" },
};
const AXES = Object.keys(LOINC_AXES) as LoincAxis[];

/** A related name is a synonym of an axis value when at least this share of the value's terms list it… */
export const MIN_VALUE_SHARE = 0.8;
/** …and the value has at least this many laboratory terms… */
export const MIN_VALUE_TERMS = 3;
/** …and most terms listing the name carry one of the values it is assigned to. */
export const MIN_EXPLAINED = 0.75;
/** A single query word inside longer names pins an axis only when it names at most this many values. */
export const MAX_WORD_VALUES = 40;

/** Words that never act as axis vocabulary on their own (connectives / generic qualifiers). */
const STOP = new Set(["in", "of", "and", "or", "by", "the", "a", "an", "for", "to", "with", "on", "at", "per", "from", "level", "test", "unspecified", "xxx"]);

/** One word of a name or query, folded: lower case, NFKC, plural "s" dropped ("hours" → "hour"). */
function foldWord(w: string): string {
  if (w.length >= 4 && /[^suia]s$/.test(w) && !/\d/.test(w)) return w.slice(0, -1);
  return w;
}

/** Words of a text: letters / digits runs, "#" kept as a word of its own and "%" read as "percent". */
export function axisWords(text: string): string[] {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .split(/([%#])|[^\p{L}\p{N}%#]+/u)
    .filter((w): w is string => !!w)
    .map((w) => (w === "%" ? "percent" : foldWord(w)));
}

/** Normalised lookup key of an axis name ("24-hours" → "24 hour", "Blood - venous" → "blood venous"). */
export function axisKey(text: string): string {
  return axisWords(text).join(" ");
}

/**
 * Where an axis name comes from: the value itself, its Part.csv display name, RELATEDNAMES2,
 * or one word of a specimen display name (matched only as a single query word).
 */
export type AxisNameSource = "part" | "display" | "related" | "word";

export interface AxisPart {
  partType: string;
  partName: string;
  displayName?: string | null;
  status?: string | null;
}

/**
 * Rows (axis, value, name, name_key, source) for loinc.axis_names. `value` is the axis value as in
 * the loinc.concepts column ("BldV", "24H", "Test strip", "NFr", "Ord").
 */
export function buildAxisNames(src: { rows: Array<Record<string, string>>; parts?: AxisPart[] | null }): string[][] {
  const terms = new Map<string, number>(); // axis|value → terms
  const labTerms = new Map<string, number>(); // axis|value → laboratory terms
  // Counts per (axis value, name) pair, keyed by interned integer ids: millions of pairs.
  const keyIds = new Map<string, number>();
  const keyList: string[] = [];
  const avIds = new Map<string, number>();
  const avList: string[] = [];
  const pairs = new Map<number, number>(); // avId * KEY_SPACE + keyId → terms listing the name
  const KEY_SPACE = 2 ** 21;
  const display = new Map<string, string>(); // key → first spelling seen
  const listings = new Map<string, number>(); // key → terms listing it (any axis value)
  for (const r of src.rows) {
    if (String(r.STATUS ?? "").toUpperCase() === "DEPRECATED") continue;
    const keys = new Set<number>();
    // Related names only from laboratory terms (CLASSTYPE 1): the clinical / radiology
    // terms' anatomical systems and survey methods carry body-part and specialty
    // abbreviations ("LE", "Up", "Cardiac") that are no specimen vocabulary.
    const lab = String(r.CLASSTYPE ?? "1").trim() === "1";
    for (const raw of lab ? String(r.RELATEDNAMES2 ?? "").split(";") : []) {
      const name = raw.trim();
      const key = axisKey(name);
      if (key.length < 2 || key.length > 60 || STOP.has(key)) continue;
      let id = keyIds.get(key);
      if (id === undefined) {
        if (keyList.length >= KEY_SPACE) continue;
        keyIds.set(key, (id = keyList.length));
        keyList.push(key);
        display.set(key, name);
      }
      if (keys.has(id)) continue;
      keys.add(id);
      listings.set(key, (listings.get(key) ?? 0) + 1);
    }
    for (const axis of AXES) {
      const value = String(r[LOINC_AXES[axis].csv] ?? "").trim();
      if (!value) continue;
      const av = `${axis}|${value}`;
      terms.set(av, (terms.get(av) ?? 0) + 1);
      if (!lab) continue;
      labTerms.set(av, (labTerms.get(av) ?? 0) + 1);
      let avId = avIds.get(av);
      if (avId === undefined) {
        avIds.set(av, (avId = avList.length));
        avList.push(av);
      }
      for (const id of keys) {
        const k = avId * KEY_SPACE + id;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
    }
  }
  const listedN = (axis: string, value: string, key: string): number => {
    const avId = avIds.get(`${axis}|${value}`);
    const id = keyIds.get(key);
    return avId === undefined || id === undefined ? 0 : (pairs.get(avId * KEY_SPACE + id) ?? 0);
  };
  // Candidate synonyms: name key → axis → values it is a synonym of.
  const cand = new Map<string, Map<LoincAxis, string[]>>();
  for (const [k, n] of pairs) {
    const av = avList[Math.floor(k / KEY_SPACE)];
    const key = keyList[k % KEY_SPACE];
    const terms = labTerms.get(av) ?? 0;
    if (terms < MIN_VALUE_TERMS || n / terms < MIN_VALUE_SHARE) continue;
    const axis = av.slice(0, av.indexOf("|")) as LoincAxis;
    const value = av.slice(av.indexOf("|") + 1);
    let byAxis = cand.get(key);
    if (!byAxis) cand.set(key, (byAxis = new Map()));
    byAxis.set(axis, [...(byAxis.get(axis) ?? []), value]);
  }
  const out = new Map<string, string[]>(); // axis|value|key → row
  const add = (axis: LoincAxis, value: string, name: string, source: AxisNameSource): void => {
    const key = axisKey(name);
    if (key.length < 1 || STOP.has(key)) return;
    const k = `${axis}|${value}|${key}`;
    const prev = out.get(k);
    // One row per (axis, value, key); the value's own names win over related names.
    if (!prev || (prev[4] === "related" && source !== "related")) out.set(k, [axis, value, name, key, source]);
  };
  for (const [key, byAxis] of cand) {
    // Most terms that list the name must carry one of the values: otherwise the name is
    // (also) an analyte / class word that merely co-occurs with them ("White blood cell"
    // on every WBC-system term, "Lactic acid" on the one analyte measured in PlasV).
    const total = listings.get(key) ?? 1;
    const fit = [...byAxis].filter(
      ([axis, values]) => values.reduce((n, v) => n + listedN(axis, v, key), 0) / total >= MIN_EXPLAINED,
    );
    if (!fit.length) continue;
    // The axis the name pins down most narrowly (fewest values); ties keep every such axis.
    const fewest = Math.min(...fit.map(([, v]) => v.length));
    for (const [axis, values] of fit) if (values.length === fewest) for (const v of values) add(axis, v, display.get(key) ?? key, "related");
  }
  // Every value's own part name and display name.
  const known = new Set(terms.keys());
  for (const axis of AXES) {
    for (const av of known) if (av.startsWith(`${axis}|`)) add(axis, av.slice(axis.length + 1), av.slice(axis.length + 1), "part");
  }
  const byType = new Map(AXES.map((a) => [LOINC_AXES[a].partType, a] as const));
  for (const p of src.parts || []) {
    const axis = byType.get(String(p.partType ?? "").trim());
    const value = String(p.partName ?? "").trim();
    if (!axis || !value || !known.has(`${axis}|${value}`)) continue;
    if (String(p.status ?? "ACTIVE").toUpperCase() !== "ACTIVE") continue;
    if (p.displayName && p.displayName.trim()) add(axis, value, p.displayName.trim(), "display");
  }
  // A name that more terms list as something else than there are terms with its values is
  // an analyte word, not this axis's vocabulary: the WBC / Neutrophil / Platelets systems'
  // names ("White blood cells", "WBC") are listed on thousands of leukocyte-count terms
  // measured in Blood; "CSF" stays (a few G-CSF terms against 2,000 CSF terms).
  const isAnalyteWord = (axis: string, key: string, values: Iterable<string>): boolean => {
    let inside = 0;
    let listedInside = 0;
    for (const v of values) {
      inside += labTerms.get(`${axis}|${v}`) ?? 0;
      listedInside += listedN(axis, v, key);
    }
    return (listings.get(key) ?? 0) - listedInside > inside;
  };
  const group = (pairs: Iterable<[string, string]>): Map<string, Set<string>> => {
    const m = new Map<string, Set<string>>();
    for (const [k, v] of pairs) m.set(k, (m.get(k) ?? new Set()).add(v));
    return m;
  };
  const byKeyAxis = group([...out.values()].map(([axis, value, , key]) => [`${axis}|${key}`, value] as [string, string]));
  const drop = new Set([...byKeyAxis].filter(([k, vs]) => isAnalyteWord(k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1), vs)).map(([k]) => k));
  const rows = [...out.values()].filter(([axis, , , key]) => !drop.has(`${axis}|${key}`));
  // Single words of multi-word specimen display names ("capillary" of "Capillary blood",
  // "spinal" of "Cerebral spinal fluid") for queries that name the specimen by one word —
  // when the word names few values and is no analyte word itself ("cell", "platelet", "free").
  const words = group(
    rows
      .filter(([axis, , , key, source]) => axis === "system" && source === "display" && key.includes(" "))
      .flatMap(([, value, , key]) =>
        key
          .split(" ")
          .filter((w) => w.length >= 4 && !STOP.has(w) && !/\d/.test(w))
          .map((w) => [w, value] as [string, string]),
      ),
  );
  for (const [w, values] of words) {
    if (values.size > MAX_WORD_VALUES || isAnalyteWord("system", w, values)) continue;
    for (const v of values) rows.push(["system", v, w, w, "word"]);
  }
  return rows;
}

// ── query side ───────────────────────────────────────────────────────────────

export interface AxisVocab {
  /** name key → (axis, value) pairs it names. */
  byKey: Map<string, Array<{ axis: LoincAxis; value: string }>>;
  /** single word → axis → values whose names contain it (word-in-name matches). */
  byWord: Map<string, Map<LoincAxis, Set<string>>>;
  /** Longest name, in words. */
  maxWords: number;
}

/** In-memory index over loinc.axis_names rows (axis, value, name_key, source). */
export function buildAxisVocab(rows: Array<{ axis: string; value: string; name_key: string; source?: string | null }>): AxisVocab {
  const byKey: AxisVocab["byKey"] = new Map();
  const byWord: AxisVocab["byWord"] = new Map();
  let maxWords = 1;
  for (const r of rows) {
    const axis = r.axis as LoincAxis;
    if (!LOINC_AXES[axis] || !r.name_key) continue;
    if (r.source === "word") {
      let m = byWord.get(r.name_key);
      if (!m) byWord.set(r.name_key, (m = new Map()));
      let s = m.get(axis);
      if (!s) m.set(axis, (s = new Set()));
      s.add(r.value);
      continue;
    }
    const list = byKey.get(r.name_key);
    if (list) {
      if (!list.some((x) => x.axis === axis && x.value === r.value)) list.push({ axis, value: r.value });
    } else byKey.set(r.name_key, [{ axis, value: r.value }]);
    const words = r.name_key.split(" ");
    maxWords = Math.max(maxWords, Math.min(words.length, 6));
  }
  return { byKey, byWord, maxWords };
}

export interface AxisConstraint {
  axis: LoincAxis;
  /** Axis values that satisfy the constraint. */
  values: Set<string>;
  /** The query words it came from (folded). */
  words: string[];
  /** Position of its first word in the query. */
  at: number;
  /** Trust: the axis's weight, lower for a specimen named after another, conflicting one. */
  weight: number;
}

/** Weight share of a SYSTEM constraint that conflicts with one named before it. */
export const LATER_SPECIMEN_SHARE = 0.25;

/** Relative trust of each axis's constraints. */
export const AXIS_WEIGHT: Record<LoincAxis, number> = { system: 1, time: 1, method: 0.6, property: 0.6, scale: 0.4 };

/** Two words are forms of one word ("salivary" / "saliva", "arterial" / "artery"): a long shared prefix. */
function sameStem(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 6 || Math.max(a.length, b.length) - min > 3) return false;
  let i = 0;
  while (i < min && a[i] === b[i]) i += 1;
  return i >= min - 1;
}

/**
 * Axis constraints named in a query, longest span first (spans do not overlap): "venous
 * blood pH" → SYSTEM ∈ {BldV}; "24 hour urine protein" → TIME ∈ {24H, 1D, …} and SYSTEM ∈
 * {Urine, …}. A span may constrain several axes when its name is listed for several.
 */
export function parseAxisConstraints(query: string, vocab: AxisVocab | null): AxisConstraint[] {
  if (!vocab || !vocab.byKey.size) return [];
  const words = axisWords(query);
  if (!words.length) return [];
  const used = new Array<boolean>(words.length).fill(false);
  const out: AxisConstraint[] = [];
  const push = (pairs: Array<{ axis: LoincAxis; value: string }>, span: string[], at: number): void => {
    const byAxis = new Map<LoincAxis, Set<string>>();
    for (const p of pairs) {
      let s = byAxis.get(p.axis);
      if (!s) byAxis.set(p.axis, (s = new Set()));
      s.add(p.value);
    }
    for (const [axis, values] of byAxis) out.push({ axis, values, words: span, at, weight: AXIS_WEIGHT[axis] });
  };
  for (let len = Math.min(vocab.maxWords, words.length); len >= 1; len -= 1) {
    for (let i = 0; i + len <= words.length; i += 1) {
      if (used.slice(i, i + len).some(Boolean)) continue;
      const span = words.slice(i, i + len);
      if (len === 1 && (STOP.has(span[0]) || (span[0].length < 2 && !/[%#]/.test(span[0])))) continue;
      const hit = vocab.byKey.get(span.join(" "));
      if (!hit) continue;
      push(hit, span, i);
      for (let j = i; j < i + len; j += 1) used[j] = true;
    }
  }
  // Single leftover words: another form of a one-word name ("salivary" → Saliva), else a
  // word of longer names when it is selective ("capillary" → Capillary blood …).
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (used[i] || w.length < 4 || STOP.has(w) || /\d/.test(w)) continue;
    let pairs: Array<{ axis: LoincAxis; value: string }> | null = null;
    if (w.length >= 6) {
      for (const [k, hit] of vocab.byKey) {
        if (!k.includes(" ") && k !== w && sameStem(k, w)) pairs = [...(pairs ?? []), ...hit];
      }
    }
    if (!pairs) {
      const m = vocab.byWord.get(w);
      if (m) {
        pairs = [];
        for (const [axis, values] of m) if (values.size <= MAX_WORD_VALUES) for (const v of values) pairs.push({ axis, value: v });
        if (!pairs.length) pairs = null;
      }
    }
    if (!pairs) continue;
    push(pairs, [w], i);
    used[i] = true;
  }
  // A test has one specimen. When the query names two that exclude each other, the first is
  // the specimen and a later one most likely part of the analyte's name ("urine blood
  // dipstick", "stool occult blood"); it keeps a small weight (the term may still say it).
  out.sort((a, b) => a.at - b.at);
  const specimens: AxisConstraint[] = [];
  for (const c of out) {
    if (c.axis !== "system") continue;
    if (specimens.some((p) => ![...c.values].some((v) => p.values.has(v)))) c.weight *= LATER_SPECIMEN_SHARE;
    specimens.push(c);
  }
  return out;
}


/**
 * How well a LOINC term agrees with the query's axis constraints: + weight for each one it
 * satisfies, − weight for each it contradicts. A constraint is satisfied when the term's
 * value on that axis is one the constraint allows, or when the term's own names already
 * contain the constraint's words (they are then part of what the term is called — "blood"
 * in "White blood cell count", "2 hours" in a "--2 hours post meal" challenge).
 */
export function axisAgreement(
  constraints: AxisConstraint[],
  term: Partial<Record<LoincAxis, string | null | undefined>>,
  names: Array<string | null | undefined>,
): number {
  if (!constraints.length) return 0;
  let words: Set<string> | null = null;
  let s = 0;
  for (const c of constraints) {
    const v = term[c.axis];
    let ok = v !== null && v !== undefined && c.values.has(String(v));
    if (!ok) {
      words ??= new Set(names.flatMap((n) => (n ? axisWords(n) : [])));
      ok = c.words.every((w) => words!.has(w));
    }
    s += (ok ? 1 : -1) * c.weight;
  }
  return s;
}

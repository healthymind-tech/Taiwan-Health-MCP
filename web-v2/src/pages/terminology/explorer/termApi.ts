/**
 * Client for the read-only terminology explorer API (GET /admin/api/terminology/*,
 * node-server/src/admin/termViz/router.ts).
 */

import { api, qs } from "@/lib/api";

export const TERM_BASE = "/admin/api/terminology/";

export function termGet<T>(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): Promise<T> {
  return api.get<T>(TERM_BASE + path + qs(params));
}

/** Query key namespace (kept out of qk so module invalidations don't refetch trees mid-browse). */
export const tk = (...parts: (string | number | Record<string, unknown>)[]) => ["termviz", ...parts] as const;

// ── ICD ──────────────────────────────────────────────────────────────────────

export type IcdKind = "chapter" | "block" | "category" | "header" | "billable";

export interface SeventhChip {
  code: string;
  char: string;
  meaning: string;
  title_zh: string | null;
  title_en: string | null;
}

export interface IcdNode {
  id: string;
  code: string;
  kind: IcdKind;
  title_en: string;
  title_zh: string | null;
  range?: string;
  has_children: boolean;
  billable_count: number;
  seventh?: SeventhChip[];
}

export interface IcdDetail {
  code: string;
  title_en: string;
  title_zh: string | null;
  is_header: boolean;
  chapter: { id: string; code: string; title_en: string; title_zh: string | null; range: string } | null;
  block: { id: string; code: string; title_en: string } | null;
  ancestors: { code: string; title_en: string; title_zh: string | null }[];
  seventh: { char: string; meaning: string } | null;
  billable_count: number;
}

export interface IcdPath {
  code: string;
  path: string[];
  children: Record<string, IcdNode[]>;
  node_id: string;
  detail?: IcdDetail;
  title?: string;
}

export interface IcdHit {
  code: string;
  title_en: string;
  title_zh: string | null;
  is_header: boolean;
  chapter: string | null;
  block: string | null;
}

// ── PCS ──────────────────────────────────────────────────────────────────────

export type PcsLabel = [string, string];

export interface PcsSection {
  code: string;
  label: string;
  label_zh: string | null;
  db_count: number;
  systems: { code: string; label: string; db_count: number; ops: { key: string; code: string; label: string; db_count: number }[] }[];
}

export interface PcsTable {
  key: string;
  section: { code: string; label: string; label_zh: string | null };
  body_system: { code: string; label: string };
  operation: { code: string; label: string; definition: string | null };
  titles: string[];
  rows: { body_part: PcsLabel[]; approach: PcsLabel[]; device: PcsLabel[]; qualifier: PcsLabel[] }[];
  db_count: number;
}

export interface PcsAxis {
  pos: number;
  title: string;
  value: string;
  label: string | null;
}

export interface PcsCodeInfo {
  code: string;
  in_db: boolean;
  name_en: string | null;
  name_zh: string | null;
  axes: PcsAxis[];
  valid: boolean;
  table_key: string | null;
  definition: string | null;
}

export interface PcsCodeRow {
  code: string;
  name_en: string | null;
  name_zh: string | null;
}

// ── SNOMED ───────────────────────────────────────────────────────────────────

export interface ConceptRef {
  id: string;
  term: string;
  fsn: string | null;
  tag: string | null;
  active: boolean;
  has_children?: boolean;
}

export interface Neighbourhood {
  concept: {
    id: string;
    active: boolean;
    fsn: string | null;
    pt: string | null;
    tag: string | null;
    synonyms: string[];
    defined: boolean | null;
    effective_time: string | null;
    module_id: string | null;
  };
  parents: ConceptRef[];
  children: { total: number; offset: number; items: ConceptRef[] };
  attributes: { type_id: string; type: string; target: ConceptRef }[];
  inbound_attribute_count: number;
  associations: { refset_id: string; label: string; target: ConceptRef }[];
  icd10_maps: { group: number; priority: number; target: string; rule: string | null; advice: string | null }[];
}

// ── LOINC ────────────────────────────────────────────────────────────────────

export const LOINC_AXES = ["component", "property", "time", "system", "scale", "method"] as const;
export type LoincAxis = (typeof LOINC_AXES)[number];
export const LOINC_FACET_KEYS = [...LOINC_AXES, "class", "status"] as const;
export type LoincFacetKey = (typeof LOINC_FACET_KEYS)[number];

export interface LoincRow {
  loinc_num: string;
  long_common_name: string;
  shortname: string | null;
  component: string;
  property: string;
  time_aspect: string;
  system: string;
  scale_type: string;
  method_type: string;
  class: string;
  status: string;
  name_zh: string | null;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface LoincFacets {
  total: number;
  page: number;
  per_page: number;
  rows: LoincRow[];
  facets: Record<LoincFacetKey, FacetValue[]>;
  facets_truncated: Record<LoincFacetKey, boolean>;
}

export interface LoincTerm {
  concept: LoincRow & { classtype: number; consumer_name: string | null; common_name_zh: string | null; specimen_type: string | null; unit: string | null };
  axes: { axis: LoincAxis; value: string; parts: { part_number: string; part_name: string | null }[] }[];
  reference_ranges: { age_min: number; age_max: number; gender: string; low: number | null; high: number | null; unit: string | null; interpretation: string | null }[];
  map_to: { map_to: string; comment: string | null; long_common_name: string | null; status: string | null }[];
  mapped_from: { loinc_num: string; long_common_name: string | null }[];
  panel_items: { seq: number; loinc_num: string; display: string | null; required: string | null; long_common_name: string | null; status: string | null; is_panel: boolean }[];
  in_panels: { parent_loinc: string; long_common_name: string | null }[];
  answer_lists: { id: string; name: string | null; link_type: string | null; context: string | null; answer_count: number; answers: { code: string; display: string | null; seq: number | null; score: string | null }[] }[];
  answer_list_total: number;
  structure_available: Record<string, boolean>;
}

// ── RxNorm ───────────────────────────────────────────────────────────────────

export interface RxConcept {
  rxcui: string;
  name: string;
  tty: string;
  suppress: string | null;
}

export interface RxSummary {
  has_relationships: boolean;
  layers: { key: string; label: string; ttys: { tty: string; label: string; count: number; suppressed: number }[] }[];
  total: number;
}

export interface RxDetail {
  concept: RxConcept & { tty_label: string };
  parsed: { clinical: string; brand: string | null; components: string[]; ingredients: string[]; doseForm: string | null };
  groups: { relation: string; label: string; total: number; items: RxConcept[] }[];
  derived: "name";
}

// ── IG CodeSystem ────────────────────────────────────────────────────────────

export interface CsNode {
  code: string;
  display: string | null;
  definition: string | null;
  designations: { language: string | null; use: string | null; value: string }[];
  properties: { code: string; value: string }[];
  child_count: number;
  descendant_count: number;
  path?: string[];
}

export interface CsMeta {
  package_id: string;
  version: string;
  artifact_key: string;
  url: string | null;
  cs_version: string | null;
  name: string | null;
  title: string | null;
  status: string | null;
  content: string | null;
  hierarchy_meaning: string | null;
  case_sensitive: boolean | null;
  declared_count: number | null;
  actual_count: number;
  top_level_count: number;
  depth: number;
  property_defs: { code: string; type: string | null; description: string | null }[];
  mode: "tree" | "flat";
  completeness: { status: string; reason: string | null };
  other_versions: { version: string; concept_count: number }[];
}

export interface Page<T> {
  total: number;
  offset: number;
  items: T[];
}

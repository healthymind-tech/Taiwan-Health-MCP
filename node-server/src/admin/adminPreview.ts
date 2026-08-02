/**
 * Admin module preview query handlers.
 *
 * Faithful port of `src/admin_preview.py`. Each function handles one module's
 * `GET /admin/api/modules/{key}/preview` request and returns a plain object
 * (JSON-serialised by the HTTP handler). All queries degrade gracefully when
 * the module is empty (return an `empty` result rather than erroring) so the UI
 * can show a "no data loaded" state without an HTTP 500.
 *
 * Parity notes:
 *  - node-pg decodes BIGINT / COUNT(*) (without ::int) to a STRING; asyncpg
 *    yields a Python int. We coerce counts with `n()` and stringify ids with
 *    `String()`. SNOMED / RxNorm concept ids exceed 2^53, so they are kept as
 *    strings end-to-end (params bound as text and cast `::bigint` in SQL) to
 *    avoid precision loss — matching the exact integer values asyncpg sends.
 *  - SQL strings are reproduced byte-for-byte from the Python source (including
 *    the deliberate single- vs double-backslash difference in the SNOMED
 *    semantic-tag regex between the WHERE clause and the SELECT/tag queries).
 *  - `fixed_value` embeds `json.dumps(value, ensure_ascii=False, default=str)`
 *    which uses Python's spaced separators (", " / ": "); `pyJson()` reproduces
 *    that spacing so the embedded string matches.
 */

import { query } from "../db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// SNOMED ids kept as strings (some exceed Number.MAX_SAFE_INTEGER).
const SNOMED_ISA_TYPE_ID = "116680003"; // IS-A relationship
const SNOMED_FSN_TYPE_ID = "900000000000003001"; // Fully Specified Name
const SNOMED_SYNONYM_TYPE_ID = "900000000000013009"; // Synonym / preferred term source
const SNOMED_ROOT_CONCEPT = "138875005"; // SNOMED CT Concept (the root)
const SNOMED_PAGE_SIZE = 50;

const LOINC_PAGE_SIZE = 20;
const DRUG_PAGE_SIZE = 50;
const HF_PAGE_SIZE = 30;
const FN_PAGE_SIZE = 30;
const RXNORM_PAGE_SIZE = 50;

// LOINC ValueSet filter property -> loinc.concepts column (whitelist).
const LOINC_FILTER_COLUMNS: Record<string, string> = {
  CLASS: "class",
  CLASSTYPE: "classtype",
  SCALE_TYP: "scale_type",
  COMPONENT: "component",
  SYSTEM: "system",
  PROPERTY: "property",
  METHOD_TYP: "method_type",
  TIME_ASPCT: "time_aspect",
};

// SNOMED historical-association refsets, most-specific first. Keyed by string
// because node-pg returns refset_id (BIGINT) as a string.
const SNOMED_HIST_ASSOC: Record<string, [number, string]> = {
  "900000000000527005": [1, "SAME AS"],
  "900000000000526001": [2, "REPLACED BY"],
  "1186924009": [3, "POSSIBLY REPLACED BY"],
  "900000000000523009": [4, "POSSIBLY EQUIVALENT TO"],
  "900000000000528000": [5, "WAS A"],
  "900000000000530003": [6, "ALTERNATIVE"],
};

type Row = Record<string, unknown>;
type Params = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirror `int(x or 0)` for node-pg string/number counts. */
function n(val: unknown): number {
  if (val === null || val === undefined) return 0;
  const num = Number(val);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

/** Mirror Python `_iso`: None -> null; datetime -> isoformat; else str. */
function iso(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) {
    // Match datetime.isoformat() (no trailing Z; +00:00 for tz-aware).
    const str = val.toISOString();
    return str.endsWith("Z") ? str.slice(0, -1) + "+00:00" : str;
  }
  return String(val);
}

/** `bool(v)`. */
function b(val: unknown): boolean {
  return Boolean(val);
}

/** Mirror Python `repr(str)`: single-quoted unless a `'` is present and no `"`. */
function pyRepr(val: string): string {
  const hasSingle = val.includes("'");
  const hasDouble = val.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let body = val.replace(/\\/g, "\\\\");
  if (quote === "'") body = body.replace(/'/g, "\\'");
  else body = body.replace(/"/g, '\\"');
  return quote + body + quote;
}

/**
 * Reproduce Python `json.dumps(value, ensure_ascii=False, default=str)`:
 * spaced separators (", " and ": "), unicode kept literal. Used only for the
 * `fixed_value` field so the embedded JSON string matches byte-for-byte.
 */
function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => pyJson(item)).join(", ") + "]";
  }
  if (typeof value === "object") {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value as Row)) {
      parts.push(JSON.stringify(k) + ": " + pyJson(v));
    }
    return "{" + parts.join(", ") + "}";
  }
  // default=str fallback for unserialisable scalars.
  return JSON.stringify(String(value));
}

function pInt(params: Params, key: string, def: number): number {
  const v = params[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return def;
}

function pStr(params: Params, key: string, def = ""): string {
  const v = params[key];
  if (v === undefined || v === null) return def;
  return String(v);
}

// ---------------------------------------------------------------------------
// ICD-10  (diagnoses tree + procedures search)
// ---------------------------------------------------------------------------

async function previewIcd(params: Params): Promise<Row> {
  const nodeIn = (params.node ?? null) as string | null;
  const q = pStr(params, "q");
  let table = pStr(params, "table", "cm");
  let category = pStr(params, "category");
  let codePrefix = pStr(params, "code_prefix");
  let codeFrom = pStr(params, "code_from");
  let codeTo = pStr(params, "code_to");
  let zhFilter = pStr(params, "zh_filter", "all");
  const sort = pStr(params, "sort", "code");
  let direction = pStr(params, "direction", "asc");
  let page = pInt(params, "page", 1);
  let perPage = pInt(params, "per_page", 50);

  const totalCm = n((await query("SELECT COUNT(*) AS c FROM icd.diagnoses")).rows[0]?.c);
  const totalPcs = n((await query("SELECT COUNT(*) AS c FROM icd.procedures")).rows[0]?.c);
  if (totalCm === 0 && totalPcs === 0) {
    return {
      type: "empty",
      message: "ICD-10 module not loaded. Run the import first.",
      total_cm: 0,
      total_pcs: 0,
    };
  }

  table = table === "pcs" ? "pcs" : "cm";
  category = category.trim().toUpperCase();
  codePrefix = codePrefix.trim().toUpperCase();
  codeFrom = codeFrom.trim().toUpperCase();
  codeTo = codeTo.trim().toUpperCase();
  zhFilter = ["all", "with_zh", "missing_zh"].includes(zhFilter) ? zhFilter : "all";
  direction = direction === "desc" ? "desc" : "asc";
  const sortMap: Record<string, string> = {
    code: "code",
    name_en: "name_en",
    name_zh: "name_zh",
    category: "category",
  };
  let sortCol = sortMap[sort] ?? "code";
  if (table === "pcs" && sortCol === "category") sortCol = "code";
  page = Math.max(1, page || 1);
  perPage = Math.max(1, Math.min(perPage || 50, 100));
  const offset = (page - 1) * perPage;

  const queryStr = q.trim();
  const showCategoryRoot =
    table === "cm" &&
    (nodeIn === null || nodeIn === "root") &&
    !queryStr &&
    !category &&
    !codePrefix &&
    !codeFrom &&
    !codeTo &&
    zhFilter === "all" &&
    sortCol === "code" &&
    direction === "asc";

  if (showCategoryRoot) {
    const rows = (
      await query(`
                SELECT
                    d.category                     AS code,
                    p.name_en                      AS name_en,
                    COALESCE(p.name_zh, '')         AS name_zh,
                    COUNT(d.code)                  AS child_count
                FROM icd.diagnoses d
                LEFT JOIN icd.diagnoses p ON p.code = d.category
                WHERE d.code <> d.category          -- exclude the category code itself
                GROUP BY d.category, p.name_en, p.name_zh
                ORDER BY d.category
                `)
    ).rows;
    const nodes = rows.map((r) => ({
      code: r.code,
      name_en: r.name_en || r.code,
      name_zh: r.name_zh || "",
      child_count: n(r.child_count),
      is_leaf: false,
    }));
    return {
      type: "tree_root",
      total_cm: totalCm,
      total_pcs: totalPcs,
      nodes,
      rows: nodes,
      total: nodes.length,
      page: 1,
      per_page: nodes.length,
      category_options: nodes,
    };
  }

  if (nodeIn && nodeIn !== "root") {
    category = nodeIn.trim().toUpperCase();
  }

  const sqlParams: unknown[] = [];
  const conditions: string[] = [];
  if (queryStr) {
    sqlParams.push(`%${queryStr}%`);
    const i = sqlParams.length;
    conditions.push(`(code ILIKE $${i} OR name_en ILIKE $${i} OR name_zh ILIKE $${i})`);
  }
  if (codePrefix) {
    sqlParams.push(`${codePrefix}%`);
    conditions.push(`code ILIKE $${sqlParams.length}`);
  }
  if (codeFrom) {
    sqlParams.push(codeFrom);
    conditions.push(`code >= $${sqlParams.length}`);
  }
  if (codeTo) {
    sqlParams.push(codeTo);
    conditions.push(`code <= $${sqlParams.length}`);
  }
  if (zhFilter === "with_zh") {
    conditions.push("NULLIF(BTRIM(name_zh), '') IS NOT NULL");
  } else if (zhFilter === "missing_zh") {
    conditions.push("NULLIF(BTRIM(name_zh), '') IS NULL");
  }
  if (table === "cm" && category) {
    sqlParams.push(category);
    conditions.push(`category = $${sqlParams.length}`);
  }

  const sourceTable = table === "pcs" ? "icd.procedures" : "icd.diagnoses";
  const selectCategory = table === "pcs" ? "CAST(NULL AS TEXT) AS category" : "category";
  const whereSql = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const orderSql = `${sortCol} ${direction.toUpperCase()} NULLS LAST, code ASC`;

  const total = n(
    (await query(`SELECT COUNT(*) AS c FROM ${sourceTable} ${whereSql}`, sqlParams)).rows[0]?.c,
  );
  const rows = (
    await query(
      `
            SELECT code, name_en, name_zh, ${selectCategory}
            FROM ${sourceTable}
            ${whereSql}
            ORDER BY ${orderSql}
            LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}
            `,
      [...sqlParams, perPage, offset],
    )
  ).rows;
  const resultRows = rows.map((r) => ({
    code: r.code,
    name_en: r.name_en || "",
    name_zh: r.name_zh || "",
    category: r.category || "",
  }));
  const categoryRows = (
    await query(`
            SELECT
                d.category AS code,
                COALESCE(p.name_en, d.category) AS name_en,
                COALESCE(p.name_zh, '') AS name_zh,
                COUNT(d.code) AS child_count
            FROM icd.diagnoses d
            LEFT JOIN icd.diagnoses p ON p.code = d.category
            WHERE d.code <> d.category
            GROUP BY d.category, p.name_en, p.name_zh
            ORDER BY d.category
            `)
  ).rows;
  const categoryOptions = categoryRows.map((r) => ({
    code: r.code,
    name_en: r.name_en || r.code,
    name_zh: r.name_zh || "",
    child_count: n(r.child_count),
  }));
  return {
    type: queryStr ? "search" : "browse",
    table,
    query: queryStr,
    category: table === "cm" ? category : "",
    code_prefix: codePrefix,
    code_from: codeFrom,
    code_to: codeTo,
    zh_filter: zhFilter,
    sort: sortCol,
    direction,
    rows: resultRows,
    results: resultRows,
    total,
    page,
    per_page: perPage,
    total_cm: totalCm,
    total_pcs: totalPcs,
    category_options: categoryOptions,
  };
}

// ---------------------------------------------------------------------------
// LOINC  (paginated table with class/status filters)
// ---------------------------------------------------------------------------

async function previewLoinc(params: Params): Promise<Row> {
  let page = pInt(params, "page", 1);
  const q = pStr(params, "q");
  const classFilter = pStr(params, "class_");
  const status = pStr(params, "status", "ACTIVE");
  let codePrefix = pStr(params, "code_prefix");
  let codeFrom = pStr(params, "code_from");
  let codeTo = pStr(params, "code_to");
  let component = pStr(params, "component");
  let system = pStr(params, "system");
  let propertyVal = pStr(params, "property_");
  let scaleType = pStr(params, "scale_type");
  let methodType = pStr(params, "method_type");
  let specimenType = pStr(params, "specimen_type");
  let unit = pStr(params, "unit");
  let zhFilter = pStr(params, "zh_filter", "all");
  let referenceFilter = pStr(params, "reference_filter", "all");
  const sort = pStr(params, "sort", "loinc_num");
  let direction = pStr(params, "direction", "asc");
  let perPage = pInt(params, "per_page", LOINC_PAGE_SIZE);

  const totalRows = n((await query("SELECT COUNT(*) AS c FROM loinc.concepts")).rows[0]?.c);
  if (totalRows === 0) {
    return { type: "empty", message: "LOINC module not loaded. Run the import first.", total: 0 };
  }

  page = Math.max(1, page || 1);
  perPage = Math.max(1, Math.min(perPage || LOINC_PAGE_SIZE, 100));
  codePrefix = codePrefix.trim().toUpperCase();
  codeFrom = codeFrom.trim().toUpperCase();
  codeTo = codeTo.trim().toUpperCase();
  component = component.trim();
  system = system.trim();
  propertyVal = propertyVal.trim();
  scaleType = scaleType.trim();
  methodType = methodType.trim();
  specimenType = specimenType.trim();
  unit = unit.trim();
  zhFilter = ["all", "with_zh", "missing_zh"].includes(zhFilter) ? zhFilter : "all";
  referenceFilter = ["all", "with_reference", "missing_reference"].includes(referenceFilter)
    ? referenceFilter
    : "all";
  direction = direction === "desc" ? "desc" : "asc";
  const sortMap: Record<string, string> = {
    loinc_num: "c.loinc_num",
    long_common_name: "c.long_common_name",
    shortname: "c.shortname",
    class: "c.class",
    status: "c.status",
    name_zh: "c.name_zh",
    component: "c.component",
    system: "c.system",
    property: "c.property",
    scale_type: "c.scale_type",
    method_type: "c.method_type",
    specimen_type: "c.specimen_type",
    unit: "c.unit",
  };
  const sortCol = sortMap[sort] ?? "c.loinc_num";

  const conditions: string[] = [];
  const sqlParams: unknown[] = [];
  let idx = 1;

  if (status && status !== "ALL") {
    conditions.push(`c.status = $${idx}`);
    sqlParams.push(status);
    idx += 1;
  }
  if (classFilter && classFilter !== "ALL") {
    conditions.push(`c.class = $${idx}`);
    sqlParams.push(classFilter);
    idx += 1;
  }
  if (q && q.trim()) {
    const term = "%" + q.trim() + "%";
    conditions.push(
      `(c.loinc_num ILIKE $${idx} OR c.long_common_name ILIKE $${idx} ` +
        `OR c.shortname ILIKE $${idx} OR c.name_zh ILIKE $${idx} ` +
        `OR c.common_name_zh ILIKE $${idx} OR c.component ILIKE $${idx} ` +
        `OR c.system ILIKE $${idx} OR c.specimen_type ILIKE $${idx})`,
    );
    sqlParams.push(term);
    idx += 1;
  }
  if (codePrefix) {
    conditions.push(`c.loinc_num ILIKE $${idx}`);
    sqlParams.push(`${codePrefix}%`);
    idx += 1;
  }
  if (codeFrom) {
    conditions.push(`c.loinc_num >= $${idx}`);
    sqlParams.push(codeFrom);
    idx += 1;
  }
  if (codeTo) {
    conditions.push(`c.loinc_num <= $${idx}`);
    sqlParams.push(codeTo);
    idx += 1;
  }
  for (const [col, value] of [
    ["component", component],
    ["system", system],
    ["property", propertyVal],
    ["scale_type", scaleType],
    ["method_type", methodType],
    ["specimen_type", specimenType],
    ["unit", unit],
  ] as [string, string][]) {
    if (value) {
      conditions.push(`c.${col} ILIKE $${idx}`);
      sqlParams.push(`%${value}%`);
      idx += 1;
    }
  }
  if (zhFilter === "with_zh") {
    conditions.push(
      "(NULLIF(BTRIM(c.name_zh), '') IS NOT NULL OR NULLIF(BTRIM(c.common_name_zh), '') IS NOT NULL)",
    );
  } else if (zhFilter === "missing_zh") {
    conditions.push(
      "NULLIF(BTRIM(c.name_zh), '') IS NULL AND NULLIF(BTRIM(c.common_name_zh), '') IS NULL",
    );
  }
  if (referenceFilter === "with_reference") {
    conditions.push(
      "EXISTS (SELECT 1 FROM loinc.reference_ranges rr WHERE rr.loinc_num = c.loinc_num)",
    );
  } else if (referenceFilter === "missing_reference") {
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM loinc.reference_ranges rr WHERE rr.loinc_num = c.loinc_num)",
    );
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const totalFiltered = n(
    (await query(`SELECT COUNT(*) AS c FROM loinc.concepts c ${where}`, sqlParams)).rows[0]?.c,
  );

  const offset = (page - 1) * perPage;
  const rows = (
    await query(
      `
            SELECT
                c.loinc_num,
                c.long_common_name,
                c.shortname,
                c.class,
                c.status,
                c.name_zh,
                c.common_name_zh,
                c.classtype,
                c.component,
                c.property,
                c.time_aspect,
                c.system,
                c.scale_type,
                c.method_type,
                c.specimen_type,
                c.unit,
                c.consumer_name,
                EXISTS (
                    SELECT 1 FROM loinc.reference_ranges rr
                    WHERE rr.loinc_num = c.loinc_num
                ) AS has_reference_range
            FROM loinc.concepts c
            ${where}
            ORDER BY ${sortCol} ${direction.toUpperCase()} NULLS LAST, c.loinc_num ASC
            LIMIT $${idx} OFFSET $${idx + 1}
            `,
      [...sqlParams, perPage, offset],
    )
  ).rows;

  const classRows = (
    await query("SELECT DISTINCT class FROM loinc.concepts WHERE class IS NOT NULL ORDER BY class")
  ).rows;
  const systemRows = (
    await query(
      "SELECT DISTINCT system FROM loinc.concepts WHERE NULLIF(BTRIM(system), '') IS NOT NULL ORDER BY system LIMIT 300",
    )
  ).rows;
  const propertyRows = (
    await query(
      "SELECT DISTINCT property FROM loinc.concepts WHERE NULLIF(BTRIM(property), '') IS NOT NULL ORDER BY property LIMIT 300",
    )
  ).rows;
  const scaleRows = (
    await query(
      "SELECT DISTINCT scale_type FROM loinc.concepts WHERE NULLIF(BTRIM(scale_type), '') IS NOT NULL ORDER BY scale_type LIMIT 300",
    )
  ).rows;

  return {
    type: "table",
    total: totalFiltered,
    total_all: totalRows,
    page,
    per_page: perPage,
    pages: Math.max(1, Math.floor((totalFiltered + perPage - 1) / perPage)),
    classes: classRows.map((r) => r.class),
    status,
    class: classFilter,
    query: q.trim(),
    code_prefix: codePrefix,
    code_from: codeFrom,
    code_to: codeTo,
    component,
    system,
    property: propertyVal,
    scale_type: scaleType,
    method_type: methodType,
    specimen_type: specimenType,
    unit,
    zh_filter: zhFilter,
    reference_filter: referenceFilter,
    sort: sortCol.replace("c.", ""),
    direction,
    systems: systemRows.map((r) => r.system),
    properties: propertyRows.map((r) => r.property),
    scale_types: scaleRows.map((r) => r.scale_type),
    rows: rows.map((r) => ({
      loinc_num: r.loinc_num,
      long_common_name: r.long_common_name || "",
      shortname: r.shortname || "",
      class: r.class || "",
      status: r.status || "",
      name_zh: r.name_zh || "",
      common_name_zh: r.common_name_zh || "",
      component: r.component || "",
      property: r.property || "",
      time_aspect: r.time_aspect || "",
      system: r.system || "",
      scale_type: r.scale_type || "",
      method_type: r.method_type || "",
      specimen_type: r.specimen_type || "",
      unit: r.unit || "",
      consumer_name: r.consumer_name || "",
      classtype: r.classtype,
      has_reference_range: b(r.has_reference_range),
    })),
  };
}

// ---------------------------------------------------------------------------
// SNOMED CT  (top-level concepts + child tree + search)
// ---------------------------------------------------------------------------

async function previewSnomed(params: Params): Promise<Row> {
  const nodeIn = (params.node ?? null) as string | null;
  let q = pStr(params, "q");
  let semanticTag = pStr(params, "semantic_tag");
  let active = pStr(params, "active", "active");
  let languageCode = pStr(params, "language_code");
  let mapFilter = pStr(params, "map_filter", "all");
  const sort = pStr(params, "sort", "concept_id");
  let direction = pStr(params, "direction", "asc");
  let page = pInt(params, "page", 1);
  let perPage = pInt(params, "per_page", SNOMED_PAGE_SIZE);

  const total = n(
    (await query("SELECT COUNT(*) AS c FROM snomed.concepts WHERE active=TRUE")).rows[0]?.c,
  );
  if (total === 0) {
    return { type: "empty", message: "SNOMED CT module not loaded. Run the import first.", total: 0 };
  }

  q = q.trim();
  semanticTag = semanticTag.trim();
  active = ["all", "active", "inactive"].includes(active) ? active : "active";
  languageCode = languageCode.trim();
  mapFilter = ["all", "with_map", "missing_map"].includes(mapFilter) ? mapFilter : "all";
  direction = direction === "desc" ? "desc" : "asc";
  page = Math.max(1, page || 1);
  perPage = Math.max(1, Math.min(perPage || SNOMED_PAGE_SIZE, 100));
  const offset = (page - 1) * perPage;

  if (nodeIn === "root") {
    const rows = (
      await query(
        `
                SELECT DISTINCT
                    r.source_id                                     AS concept_id,
                    d.term                                          AS fsn_term,
                    (SELECT COUNT(*)
                     FROM snomed.relationships r2
                     WHERE r2.destination_id = r.source_id
                       AND r2.type_id = $1
                       AND r2.active = TRUE)                        AS child_count
                FROM snomed.relationships r
                JOIN snomed.descriptions d
                    ON d.concept_id = r.source_id
                    AND d.type_id = $2
                    AND d.active = TRUE
                JOIN snomed.concepts c
                    ON c.concept_id = r.source_id AND c.active = TRUE
                WHERE r.type_id = $1
                  AND r.active = TRUE
                  AND r.destination_id = $3
                ORDER BY d.term
                `,
        [SNOMED_ISA_TYPE_ID, SNOMED_FSN_TYPE_ID, SNOMED_ROOT_CONCEPT],
      )
    ).rows;
    return {
      type: "tree_root",
      total_active_concepts: total,
      nodes: rows.map((r) => ({
        concept_id: String(r.concept_id),
        fsn_term: r.fsn_term,
        child_count: n(r.child_count),
      })),
    };
  }

  let parentId: string | null = null;
  if (nodeIn) {
    if (!/^-?\d+$/.test(nodeIn)) {
      return { type: "error", message: `Invalid concept_id: ${pyRepr(nodeIn)}` };
    }
    parentId = nodeIn;
  }

  if (parentId !== null) {
    const parentNameRow = (
      await query(
        `
                SELECT term FROM snomed.descriptions
                WHERE concept_id = $1 AND type_id = $2 AND active = TRUE
                LIMIT 1
                `,
        [parentId, SNOMED_FSN_TYPE_ID],
      )
    ).rows[0];
    const parentTerm = parentNameRow ? parentNameRow.term : String(parentId);

    const rows = (
      await query(
        `
                SELECT DISTINCT
                    r.source_id                                     AS concept_id,
                    d.term                                          AS fsn_term,
                    (SELECT COUNT(*)
                     FROM snomed.relationships r2
                     WHERE r2.destination_id = r.source_id
                       AND r2.type_id = $1
                       AND r2.active = TRUE)                        AS child_count
                FROM snomed.relationships r
                JOIN snomed.descriptions d
                    ON d.concept_id = r.source_id
                    AND d.type_id = $2
                    AND d.active = TRUE
                JOIN snomed.concepts c ON c.concept_id = r.source_id AND c.active = TRUE
                WHERE r.type_id = $1
                  AND r.active = TRUE
                  AND r.destination_id = $3
                ORDER BY d.term
                LIMIT 150
                `,
        [SNOMED_ISA_TYPE_ID, SNOMED_FSN_TYPE_ID, parentId],
      )
    ).rows;
    return {
      type: "tree_children",
      parent_id: String(parentId),
      parent_term: parentTerm,
      nodes: rows.map((r) => ({
        concept_id: String(r.concept_id),
        fsn_term: r.fsn_term,
        child_count: n(r.child_count),
      })),
    };
  }

  const conditions: string[] = ["fsn.type_id = $1", "fsn.active = TRUE"];
  const sqlParams: unknown[] = [SNOMED_FSN_TYPE_ID];
  let idx = 2;

  if (active === "active") {
    conditions.push("c.active = TRUE");
  } else if (active === "inactive") {
    conditions.push("c.active = FALSE");
  }

  if (q) {
    conditions.push(
      `(c.concept_id::text ILIKE $${idx} OR fsn.term ILIKE $${idx} OR pref.term ILIKE $${idx})`,
    );
    sqlParams.push(`%${q}%`);
    idx += 1;
  }
  if (semanticTag) {
    conditions.push(
      `LOWER(COALESCE(substring(fsn.term from '\\\\(([^()]*)\\\\)$'), '')) = LOWER($${idx})`,
    );
    sqlParams.push(semanticTag);
    idx += 1;
  }
  if (languageCode) {
    conditions.push(`fsn.language_code = $${idx}`);
    sqlParams.push(languageCode);
    idx += 1;
  }
  if (mapFilter === "with_map") {
    conditions.push(
      "EXISTS (SELECT 1 FROM snomed.icd10_map m WHERE m.referenced_component_id = c.concept_id AND m.active = TRUE)",
    );
  } else if (mapFilter === "missing_map") {
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM snomed.icd10_map m WHERE m.referenced_component_id = c.concept_id AND m.active = TRUE)",
    );
  }

  const sortMap: Record<string, string> = {
    concept_id: "c.concept_id",
    fsn_term: "fsn.term",
    preferred_term: "pref.term",
    semantic_tag: "semantic_tag",
    effective_time: "c.effective_time",
    child_count: "child_count",
    icd10_map_count: "icd10_map_count",
  };
  const sortCol = sortMap[sort] ?? "c.concept_id";
  const where = "WHERE " + conditions.join(" AND ");
  const fromSql = `
            FROM snomed.concepts c
            JOIN snomed.descriptions fsn
              ON fsn.concept_id = c.concept_id
            LEFT JOIN LATERAL (
                SELECT term
                FROM snomed.descriptions s
                WHERE s.concept_id = c.concept_id
                  AND s.type_id = ${SNOMED_SYNONYM_TYPE_ID}
                  AND s.active = TRUE
                ORDER BY LENGTH(s.term), s.term
                LIMIT 1
            ) pref ON TRUE
            ${where}
        `;
  const totalFiltered = n((await query(`SELECT COUNT(*) AS c ${fromSql}`, sqlParams)).rows[0]?.c);
  const rows = (
    await query(
      `
            SELECT
                c.concept_id,
                c.effective_time::text AS effective_time,
                c.active,
                c.module_id,
                c.definition_status_id,
                fsn.term AS fsn_term,
                fsn.language_code,
                COALESCE(pref.term, '') AS preferred_term,
                COALESCE(substring(fsn.term from '\\(([^()]*)\\)$'), '') AS semantic_tag,
                (
                    SELECT COUNT(*)
                    FROM snomed.relationships r
                    WHERE r.destination_id = c.concept_id
                      AND r.type_id = ${SNOMED_ISA_TYPE_ID}
                      AND r.active = TRUE
                ) AS child_count,
                (
                    SELECT COUNT(*)
                    FROM snomed.icd10_map m
                    WHERE m.referenced_component_id = c.concept_id
                      AND m.active = TRUE
                ) AS icd10_map_count
            ${fromSql}
            ORDER BY ${sortCol} ${direction.toUpperCase()} NULLS LAST, c.concept_id ASC
            LIMIT $${idx} OFFSET $${idx + 1}
            `,
      [...sqlParams, perPage, offset],
    )
  ).rows;
  const tagRows = (
    await query(
      `
            SELECT tag
            FROM (
                SELECT DISTINCT substring(term from '\\(([^()]*)\\)$') AS tag
                FROM snomed.descriptions
                WHERE active = TRUE AND type_id = $1
            ) t
            WHERE NULLIF(BTRIM(tag), '') IS NOT NULL
            ORDER BY tag
            LIMIT 300
            `,
      [SNOMED_FSN_TYPE_ID],
    )
  ).rows;
  const langRows = (
    await query(`
            SELECT DISTINCT language_code
            FROM snomed.descriptions
            WHERE NULLIF(BTRIM(language_code), '') IS NOT NULL
            ORDER BY language_code
            `)
  ).rows;
  const resultRows = rows.map((r) => ({
    concept_id: String(r.concept_id),
    preferred_term: r.preferred_term || "",
    fsn_term: r.fsn_term || "",
    semantic_tag: r.semantic_tag || "",
    active: b(r.active),
    language_code: r.language_code || "",
    effective_time: iso(r.effective_time) || "",
    module_id: String(r.module_id || ""),
    definition_status_id: String(r.definition_status_id || ""),
    child_count: n(r.child_count),
    icd10_map_count: n(r.icd10_map_count),
  }));
  return {
    type: "table",
    total: totalFiltered,
    total_all: total,
    page,
    per_page: perPage,
    pages: Math.max(1, Math.floor((totalFiltered + perPage - 1) / perPage)),
    query: q,
    semantic_tag: semanticTag,
    active,
    language_code: languageCode,
    map_filter: mapFilter,
    sort,
    direction,
    semantic_tags: tagRows.map((r) => r.tag),
    language_codes: langRows.map((r) => r.language_code),
    rows: resultRows,
    results: resultRows,
  };
}

// ---------------------------------------------------------------------------
// TWCore IG  (FHIR IG tree: package groups -> artifacts -> resource detail)
// ---------------------------------------------------------------------------

function jsonValue(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Row) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function stripCanonicalVersion(url: string): string {
  return url ? url.split("|")[0] : url;
}

function canonicalTail(url: string, resourceType: string): string {
  url = stripCanonicalVersion(url);
  const marker = `/${resourceType}/`;
  if (url.includes(marker)) {
    const i = url.lastIndexOf(marker);
    return url.slice(i + marker.length);
  }
  if (!url) return "";
  const trimmed = url.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

interface IgScope {
  artifacts: string;
  concepts: string;
  codesystems: string;
}

/**
 * Scope every IG preview query to one installed package.
 *
 * `fhir.artifacts / concepts / codesystems` hold all installed IGs side by side
 * (TWCore's 422 artifacts sit next to hl7.fhir.r4.core's 4,581), so an unscoped
 * preview silently merges them into a single tree. The preview is always opened
 * from one IG, so the package is required rather than defaulted.
 *
 * The id is validated against `fhir.ig_packages` and only then inlined as a SQL
 * literal. Inlining is what lets the 21 call sites keep their own parameter
 * numbering untouched; the whitelist is what makes inlining safe.
 */
async function igPackageScope(params: Params): Promise<IgScope | { error: string }> {
  const pkg = pStr(params, "package_id");
  if (!pkg) return { error: "package_id is required" };
  const known = await query("SELECT 1 FROM fhir.ig_packages WHERE package_id = $1 LIMIT 1", [pkg]);
  if (known.rows.length === 0) return { error: `Unknown IG package '${pkg}'` };
  const lit = `'${pkg.replace(/'/g, "''")}'`;
  const scoped = (table: string, alias: string): string =>
    `(SELECT * FROM ${table} WHERE package_id = ${lit}) AS ${alias}`;
  return {
    artifacts: scoped("fhir.artifacts", "artifacts"),
    concepts: scoped("fhir.concepts", "concepts"),
    codesystems: scoped("fhir.codesystems", "codesystems"),
  };
}

async function previewIg(params: Params): Promise<Row> {
  const scope = await igPackageScope(params);
  if ("error" in scope) return { type: "error", message: scope.error };
  const ARTIFACTS = scope.artifacts;
  const CONCEPTS = scope.concepts;
  const CODESYSTEMS = scope.codesystems;
  const mode = pStr(params, "mode");
  const nodeIn = (params.node ?? null) as string | null;
  const artifactKeyIn = pStr(params, "artifact_key");
  const valueSetUrlIn = pStr(params, "value_set_url");
  const fieldQ = pStr(params, "field_q");
  const csId = (params.cs_id ?? null) as string | null;
  const qIn = (params.q ?? null) as string | null;
  const resourceType = pStr(params, "resource_type");
  const groupingId = pStr(params, "grouping_id");
  const baseType = pStr(params, "base_type");
  let elementSource = pStr(params, "element_source", "differential");
  const sort = pStr(params, "sort", "title");
  let direction = pStr(params, "direction", "asc");
  let page = pInt(params, "page", 1);
  let perPage = pInt(params, "per_page", 50);

  const artifactSummary = (row: Row): Row => ({
    artifact_key: row.artifact_key,
    resource_type: row.resource_type,
    artifact_id: row.artifact_id || "",
    title: row.title || row.name || row.artifact_id || row.artifact_key,
    name: row.name || "",
    status: row.status || "",
    kind: row.kind || "",
    base_type: row.base_type || "",
    derivation: row.derivation || "",
    grouping_id: row.grouping_id || "",
    grouping_name: row.grouping_name || "",
    description: row.description || "",
    package_path: row.package_path || "",
    child_count: n(row.child_count),
    concept_count: n(row.concept_count),
  });

  const minInt = (value: unknown): number => {
    const num = Number(value);
    return Number.isInteger(num) ? num : 0;
  };

  const firstConstraintValue = (element: Row): { kind: string; value: string } => {
    for (const [key, value] of Object.entries(element)) {
      if (key.startsWith("fixed") || key.startsWith("pattern")) {
        return { kind: key, value: pyJson(value) };
      }
    }
    return { kind: "", value: "" };
  };

  const elementTypeSummary = (element: Row): string => {
    const parts: string[] = [];
    for (const item of (element.type as Row[]) || []) {
      const code = String((item as Row).code || "");
      if (!code) continue;
      const refsSrc =
        ((item as Row).targetProfile as unknown[]) || ((item as Row).profile as unknown[]) || [];
      const refs = refsSrc
        .filter((ref) => ref)
        .map((ref) => canonicalTail(String(ref), "StructureDefinition"));
      parts.push(refs.length ? `${code}(${refs.join(", ")})` : code);
    }
    return parts.join(", ");
  };

  const elementRow = (element: Row, index: number): Row => {
    const binding = (element.binding as Row) || {};
    const minValue = minInt(element.min);
    const maxValue = String(element.max || "");
    const fixed = firstConstraintValue(element);
    const path = String(element.path || "");
    const elementId = String(element.id || path || `element-${index}`);
    return {
      id: elementId,
      element_id: elementId,
      path,
      slice_name: String(element.sliceName || ""),
      label: path ? path.slice(path.lastIndexOf(".") + 1) : elementId,
      depth: Math.max(0, (path.match(/\./g) || []).length),
      min: minValue,
      max: maxValue,
      cardinality: `${minValue}..${maxValue}`,
      required: minValue >= 1 && maxValue !== "0",
      optional: minValue === 0 && maxValue !== "0",
      prohibited: maxValue === "0",
      must_support: b(element.mustSupport || false),
      is_modifier: b(element.isModifier || false),
      type: elementTypeSummary(element),
      binding: String(binding.valueSet || ""),
      binding_strength: String(binding.strength || ""),
      binding_description: String(binding.description || ""),
      short: String(element.short || ""),
      definition: String(element.definition || ""),
      comment: String(element.comment || ""),
      requirements: String(element.requirements || ""),
      fixed_kind: fixed.kind,
      fixed_value: fixed.value,
      constraints: ((element.constraint as Row[]) || []).map((item) => ({
        key: String((item as Row).key || ""),
        severity: String((item as Row).severity || ""),
        human: String((item as Row).human || ""),
        expression: String((item as Row).expression || ""),
      })),
      children: [],
    };
  };

  const structureElementRows = (data: Row): Row[] => {
    const snapshot = ((data.snapshot as Row)?.element as Row[]) || [];
    const differential = ((data.differential as Row)?.element as Row[]) || [];
    let rawElements: Row[];
    let source: string;
    if (elementSource === "snapshot") {
      if (snapshot.length) {
        rawElements = snapshot;
        source = "snapshot";
      } else {
        rawElements = differential;
        source = "differential";
      }
    } else {
      if (differential.length) {
        rawElements = differential;
        source = "differential";
      } else {
        rawElements = snapshot;
        source = "snapshot";
      }
    }
    const rows = rawElements.map((element, i) => elementRow(element, i));
    for (const row of rows) row.source = source;
    return rows;
  };

  const elementTree = (elements: Row[]): Row[] => {
    const roots: Row[] = [];
    let stack: Row[] = [];
    for (const item of elements) {
      const nodeItem: Row = { ...item, children: [] };
      const depth = Math.max(0, Number(nodeItem.depth) || 0);
      if (depth === 0 || stack.length === 0) {
        roots.push(nodeItem);
        stack = [nodeItem];
        continue;
      }
      stack = stack.slice(0, depth);
      if (stack.length === 0) {
        roots.push(nodeItem);
        stack = [nodeItem];
        continue;
      }
      const parent = stack[stack.length - 1];
      ((parent.children as Row[]) ||= []).push(nodeItem);
      stack.push(nodeItem);
    }
    return roots;
  };

  const elementMatches = (row: Row, term: string): boolean => {
    if (!term) return false;
    const haystack = [
      "id",
      "path",
      "slice_name",
      "label",
      "type",
      "binding",
      "binding_strength",
      "binding_description",
      "short",
      "definition",
      "comment",
      "requirements",
    ]
      .map((key) => String(row[key] || ""))
      .join(" ")
      .toLowerCase();
    return haystack.includes(term.toLowerCase());
  };

  const artifactStats = (elements: Row[]): Row => ({
    elements: elements.length,
    required: elements.filter((row) => row.required).length,
    must_support: elements.filter((row) => row.must_support).length,
    bindings: elements.filter((row) => row.binding).length,
    prohibited: elements.filter((row) => row.prohibited).length,
  });

  const profileResourceName = (row: Row): string => {
    const data = jsonValue(row.raw_json);
    let rawType = String(data.type || row.base_type || "");
    if (rawType.startsWith("http://") || rawType.startsWith("https://")) {
      rawType = canonicalTail(rawType, "StructureDefinition");
    }
    return rawType || (row.base_type as string) || "Other";
  };

  const resourceDetail = (data: Row, rType: string): Row => {
    if (rType === "StructureDefinition") {
      const elements = structureElementRows(data);
      return {
        url: data.url || "",
        version: data.version || "",
        base_definition: data.baseDefinition || "",
        type: data.type || "",
        kind: data.kind || "",
        derivation: data.derivation || "",
        elements,
        element_total: elements.length,
        stats: artifactStats(elements),
      };
    }
    if (rType === "ValueSet") {
      const compose = (data.compose as Row) || {};
      return {
        url: data.url || "",
        version: data.version || "",
        include: compose.include || [],
        exclude: compose.exclude || [],
        expansion_total: (data.expansion as Row)?.total ?? null,
      };
    }
    if (rType === "SearchParameter") {
      return {
        base: data.base || [],
        type: data.type || "",
        code: data.code || "",
        expression: data.expression || "",
        xpath: data.xpath || "",
      };
    }
    if (rType === "ConceptMap") {
      return {
        source: data.sourceUri || data.sourceCanonical || "",
        target: data.targetUri || data.targetCanonical || "",
        group: data.group || [],
      };
    }
    if (rType === "CapabilityStatement" || rType === "OperationDefinition") {
      return {
        url: data.url || "",
        version: data.version || "",
        kind: data.kind || "",
        fhir_version: data.fhirVersion || "",
        rest: data.rest || [],
        parameter: data.parameter || [],
      };
    }
    return {
      resource_type: rType,
      id: data.id || "",
      url: data.url || "",
      meta: data.meta || {},
    };
  };

  const propertyValue = (prop: Row): string => {
    for (const [key, value] of Object.entries(prop)) {
      if (key.startsWith("value") && value !== null && value !== undefined) {
        return String(value);
      }
    }
    return "";
  };

  const conceptPropertyMap = (concept: Row): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const prop of (concept.property as Row[]) || []) {
      const code = String((prop as Row).code || "");
      if (code) result[code] = propertyValue(prop as Row);
    }
    return result;
  };

  const conceptProperties = (concept: Row): string => {
    const properties = conceptPropertyMap(concept);
    return Object.entries(properties)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  };

  const conceptDesignations = (concept: Row): string => {
    const values: string[] = [];
    for (const item of (concept.designation as Row[]) || []) {
      const value = String((item as Row).value || "");
      if (!value) continue;
      const language = String((item as Row).language || "").trim();
      values.push(language ? `${language}: ${value}` : value);
    }
    return values.join("; ");
  };

  const conceptMatchesFilters = (concept: Row, filters: Row[]): boolean => {
    if (!filters.length) return true;
    const properties = conceptPropertyMap(concept);
    for (const filterItem of filters) {
      const prop = String((filterItem as Row).property || "");
      const op = String((filterItem as Row).op || "");
      const expected = String((filterItem as Row).value || "");
      const actual = properties[prop] ?? "";
      if (op === "=" && actual !== expected) return false;
      if (op === "!=" && actual === expected) return false;
      if (op !== "=" && op !== "!=") return false;
    }
    return true;
  };

  const loadCodesystemRaw = async (system: string): Promise<[string, Row] | null> => {
    const csIdLocal = canonicalTail(system, "CodeSystem");
    const row = (
      await query(
        `
            SELECT artifact_id, raw_json
            FROM ${ARTIFACTS}
            WHERE resource_type = 'CodeSystem'
              AND (canonical_url = $1 OR artifact_id = $2)
            LIMIT 1
            `,
        [stripCanonicalVersion(system), csIdLocal],
      )
    ).rows[0];
    if (!row) return null;
    const data = jsonValue(row.raw_json);
    return [(row.artifact_id as string) || csIdLocal, data];
  };

  const loadValuesetRaw = async (valueSetUrl: string): Promise<[string, Row] | null> => {
    const vsId = canonicalTail(valueSetUrl, "ValueSet");
    const row = (
      await query(
        `
            SELECT artifact_id, raw_json
            FROM ${ARTIFACTS}
            WHERE resource_type = 'ValueSet'
              AND (canonical_url = $1 OR artifact_id = $2)
            LIMIT 1
            `,
        [stripCanonicalVersion(valueSetUrl), vsId],
      )
    ).rows[0];
    if (!row) return null;
    return [(row.artifact_id as string) || vsId, jsonValue(row.raw_json)];
  };

  const externalDisplayMap = async (
    system: string,
    codes: string[],
  ): Promise<Record<string, string>> => {
    if (!codes.length) return {};
    try {
      if (system === "http://snomed.info/sct") {
        const numericCodes = codes.filter((code) => /^\d+$/.test(code));
        if (!numericCodes.length) return {};
        const rows = (
          await query(
            `
                    SELECT DISTINCT ON (concept_id)
                           concept_id::text AS code, term
                    FROM snomed.descriptions
                    WHERE concept_id = ANY($1::bigint[])
                      AND active
                    ORDER BY concept_id,
                             CASE
                                 WHEN type_id = 900000000000013009 AND us_preferred THEN 0
                                 WHEN type_id = 900000000000013009 THEN 1
                                 ELSE 2
                             END,
                             language_code
                    `,
            [numericCodes],
          )
        ).rows;
        const map: Record<string, string> = {};
        for (const r of rows) map[r.code as string] = (r.term as string) || "";
        return map;
      }
      if (system === "http://loinc.org") {
        const rows = (
          await query(
            `
                    SELECT loinc_num AS code,
                           COALESCE(NULLIF(common_name_zh, ''), NULLIF(name_zh, ''),
                                    NULLIF(long_common_name, ''), NULLIF(shortname, ''),
                                    component) AS display
                    FROM loinc.concepts
                    WHERE loinc_num = ANY($1::text[])
                    `,
            [codes],
          )
        ).rows;
        const map: Record<string, string> = {};
        for (const r of rows) map[r.code as string] = (r.display as string) || "";
        return map;
      }
      if (system === "http://www.nlm.nih.gov/research/umls/rxnorm") {
        const numericCodes = codes.filter((code) => /^\d+$/.test(code));
        if (!numericCodes.length) return {};
        const rows = (
          await query(
            `
                    SELECT rxcui::text AS code, name
                    FROM rxnorm.concepts
                    WHERE rxcui = ANY($1::bigint[])
                    `,
            [numericCodes],
          )
        ).rows;
        const map: Record<string, string> = {};
        for (const r of rows) map[r.code as string] = (r.name as string) || "";
        return map;
      }
    } catch {
      return {};
    }
    return {};
  };

  const valuesetAllowedRows = async (data: Row, visited?: Set<string>): Promise<Row[]> => {
    const visitedSet = new Set(visited || []);
    const valueSetId = String(data.id || data.url || "");
    if (visitedSet.has(valueSetId)) return [];
    visitedSet.add(valueSetId);

    const rows: Row[] = [];

    const addRow = (opts: {
      row_type: string;
      system?: string;
      code?: string;
      display?: string;
      definition?: string;
      meaning?: string;
      properties?: string;
      source?: string;
    }): void => {
      const display = opts.display || "";
      const definition = opts.definition || "";
      rows.push({
        row_type: opts.row_type,
        system: opts.system || "",
        code: opts.code || "",
        display,
        definition,
        meaning: opts.meaning || definition || display,
        properties: opts.properties || "",
        source: opts.source || "",
      });
    };

    const addConceptsFromCodesystem = (opts: {
      system: string;
      cs_data: Row;
      filters?: Row[];
      source: string;
    }): void => {
      for (const concept of (opts.cs_data.concept as Row[]) || []) {
        if (!conceptMatchesFilters(concept, opts.filters || [])) continue;
        addRow({
          row_type: opts.filters && opts.filters.length ? "filtered concept" : "concept",
          system: opts.system,
          code: String((concept as Row).code || ""),
          display: String((concept as Row).display || ""),
          definition: String((concept as Row).definition || ""),
          meaning: conceptDesignations(concept),
          properties: conceptProperties(concept),
          source: opts.source,
        });
      }
    };

    const snomedDescendants = async (
      root: string,
      includeSelf: boolean,
      limit: number,
    ): Promise<Row[]> => {
      return (
        await query(
          `
                WITH RECURSIVE descendants AS (
                    SELECT $1::bigint AS concept_id
                    UNION
                    SELECT r.source_id
                    FROM snomed.relationships r
                    JOIN descendants d ON r.destination_id = d.concept_id
                    WHERE r.type_id = 116680003 AND r.active = TRUE
                )
                SELECT d.concept_id::text AS code, ds.term AS display
                FROM descendants d
                JOIN LATERAL (
                    SELECT term FROM snomed.descriptions s
                    WHERE s.concept_id = d.concept_id AND s.active = TRUE
                    ORDER BY CASE
                                 WHEN s.type_id = 900000000000013009 AND s.us_preferred THEN 0
                                 WHEN s.type_id = 900000000000013009 THEN 1
                                 ELSE 2
                             END,
                             LENGTH(s.term)
                    LIMIT 1
                ) ds ON TRUE
                WHERE $2::boolean OR d.concept_id <> $1::bigint
                ORDER BY ds.term
                LIMIT $3
                `,
          [root, includeSelf, limit],
        )
      ).rows;
    };

    const resolveRetiredAnchor = async (root: string): Promise<[string[], string]> => {
      let assoc: Row[];
      try {
        assoc = (
          await query(
            `
                    SELECT target_component_id, refset_id
                    FROM snomed.historical_associations
                    WHERE referenced_component_id = $1
                    `,
            [root],
          )
        ).rows;
      } catch {
        return [[], ""];
      }
      const tiers: [number, string, string][] = [];
      for (const a of assoc) {
        const refsetId = String(a.refset_id);
        if (refsetId in SNOMED_HIST_ASSOC) {
          tiers.push([SNOMED_HIST_ASSOC[refsetId][0], refsetId, String(a.target_component_id)]);
        }
      }
      if (!tiers.length) return [[], ""];
      const bestRank = Math.min(...tiers.map((t) => t[0]));
      const bestRefset = tiers.find((t) => t[0] === bestRank)![1];
      const targets = [
        ...new Map(tiers.filter((t) => t[1] === bestRefset).map((t) => [t[2], t[2]])).keys(),
      ];
      return [targets, SNOMED_HIST_ASSOC[bestRefset][1]];
    };

    const addSnomedFilterConcepts = async (opts: {
      root_code: string;
      op: string;
      cap?: number;
    }): Promise<number> => {
      const cap = opts.cap ?? 500;
      if (!/^\d+$/.test(opts.root_code)) return 0;
      const includeSelf = opts.op === "is-a";
      const root = opts.root_code;
      let fetched: Row[];
      try {
        fetched = await snomedDescendants(root, includeSelf, cap + 1);
      } catch {
        return 0;
      }

      let substitution = "";
      if (!fetched.length) {
        const [targets, label] = await resolveRetiredAnchor(root);
        if (targets.length) {
          const seen = new Set<string>();
          const merged: Row[] = [];
          for (const target of targets) {
            let rowsT: Row[];
            try {
              rowsT = await snomedDescendants(target, includeSelf, cap + 1);
            } catch {
              rowsT = [];
            }
            for (const r of rowsT) {
              if (seen.has(r.code as string)) continue;
              seen.add(r.code as string);
              merged.push(r);
            }
            if (merged.length > cap) break;
          }
          if (merged.length) {
            fetched = merged.slice(0, cap + 1);
            substitution =
              `Anchor concept ${root} is retired in the loaded SNOMED ` +
              `edition; expanded from its ${label} successor(s): ` +
              `${targets.join(", ")}.`;
          }
        }
      }

      const truncated = fetched.length > cap;
      if (substitution) {
        addRow({
          row_type: "filter rule",
          system: "http://snomed.info/sct",
          display: substitution,
          meaning: substitution,
          source: "snomed.history",
        });
      }
      for (const r of fetched.slice(0, cap)) {
        addRow({
          row_type: "concept",
          system: "http://snomed.info/sct",
          code: r.code as string,
          display: (r.display as string) || "",
          meaning: (r.display as string) || "",
          source: "snomed.filter",
        });
      }
      if (truncated) {
        addRow({
          row_type: "filter rule",
          system: "http://snomed.info/sct",
          display: `Showing first ${cap}; full set (${opts.op} ${opts.root_code}) is larger.`,
          meaning: "Truncated — expand in a SNOMED terminology server for the complete set.",
          source: "compose.include.filter",
        });
      }
      return fetched.slice(0, cap).length;
    };

    const addLoincFilterConcepts = async (opts: {
      prop: string;
      value: string;
      cap?: number;
    }): Promise<number> => {
      const cap = opts.cap ?? 500;
      const column = LOINC_FILTER_COLUMNS[opts.prop.toUpperCase()];
      if (!column || !opts.value) return 0;
      let fetched: Row[];
      try {
        fetched = (
          await query(
            `
                    SELECT loinc_num AS code,
                           COALESCE(NULLIF(common_name_zh, ''), NULLIF(name_zh, ''),
                                    NULLIF(long_common_name, ''), NULLIF(shortname, ''),
                                    component) AS display
                    FROM loinc.concepts
                    WHERE CAST(${column} AS TEXT) = $1
                    ORDER BY loinc_num
                    LIMIT $2
                    `,
            [opts.value, cap + 1],
          )
        ).rows;
      } catch {
        return 0;
      }
      const truncated = fetched.length > cap;
      for (const r of fetched.slice(0, cap)) {
        addRow({
          row_type: "concept",
          system: "http://loinc.org",
          code: r.code as string,
          display: (r.display as string) || "",
          meaning: (r.display as string) || "",
          source: "loinc.filter",
        });
      }
      if (truncated) {
        addRow({
          row_type: "filter rule",
          system: "http://loinc.org",
          display: `Showing first ${cap}; full set (${opts.prop} = ${opts.value}) is larger.`,
          meaning: "Truncated — expand in a LOINC terminology server for the complete set.",
          source: "compose.include.filter",
        });
      }
      return fetched.slice(0, cap).length;
    };

    const addRxnormFilterConcepts = async (opts: {
      prop: string;
      op: string;
      value: string;
      cap?: number;
    }): Promise<number> => {
      const cap = opts.cap ?? 500;
      if (opts.prop.toUpperCase() !== "TTY" || !opts.value) return 0;
      let ttys: string[];
      if (opts.op === "in") {
        ttys = opts.value
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v);
      } else if (opts.op === "=") {
        ttys = [opts.value.trim()];
      } else {
        return 0;
      }
      if (!ttys.length) return 0;
      let fetched: Row[];
      try {
        fetched = (
          await query(
            `
                    SELECT rxcui::text AS code, name AS display
                    FROM rxnorm.concepts
                    WHERE tty = ANY($1::text[])
                    ORDER BY rxcui
                    LIMIT $2
                    `,
            [ttys, cap + 1],
          )
        ).rows;
      } catch {
        return 0;
      }
      const truncated = fetched.length > cap;
      for (const r of fetched.slice(0, cap)) {
        addRow({
          row_type: "concept",
          system: "http://www.nlm.nih.gov/research/umls/rxnorm",
          code: r.code as string,
          display: (r.display as string) || "",
          meaning: (r.display as string) || "",
          source: "rxnorm.filter",
        });
      }
      if (truncated) {
        addRow({
          row_type: "filter rule",
          system: "http://www.nlm.nih.gov/research/umls/rxnorm",
          display: `Showing first ${cap}; full set (${opts.prop} ${opts.op} ${opts.value}) is larger.`,
          meaning: "Truncated — expand in an RxNorm terminology server for the complete set.",
          source: "compose.include.filter",
        });
      }
      return fetched.slice(0, cap).length;
    };

    const expansion = ((data.expansion as Row)?.contains as Row[]) || [];
    for (const item of expansion) {
      addRow({
        row_type: "expansion",
        system: String((item as Row).system || ""),
        code: String((item as Row).code || ""),
        display: String((item as Row).display || ""),
        definition: String((item as Row).definition || ""),
        source: "expansion.contains",
      });
    }

    for (const include of ((data.compose as Row)?.include as Row[]) || []) {
      const system = String((include as Row).system || "");
      const filters = ((include as Row).filter as Row[]) || [];
      const concepts = ((include as Row).concept as Row[]) || [];
      const valueSets = ((include as Row).valueSet as unknown[]) || [];
      const csLoaded = system ? await loadCodesystemRaw(system) : null;
      const csData = csLoaded ? csLoaded[1] : {};
      const localConcepts: Record<string, Row> = {};
      for (const concept of (csData.concept as Row[]) || []) {
        localConcepts[String((concept as Row).code || "")] = concept as Row;
      }

      for (const valueSetUrl of valueSets) {
        const ref = await loadValuesetRaw(String(valueSetUrl));
        if (ref) {
          const [refId, refData] = ref;
          const nestedRows = await valuesetAllowedRows(
            refData,
            new Set([...visitedSet, valueSetId]),
          );
          for (const nested of nestedRows) nested.source = `ValueSet/${refId}`;
          rows.push(...nestedRows);
        } else {
          addRow({
            row_type: "ValueSet reference",
            code: canonicalTail(String(valueSetUrl), "ValueSet"),
            display: String(valueSetUrl),
            meaning: "Includes all codes from the referenced ValueSet.",
            source: "compose.include.valueSet",
          });
        }
      }

      if (concepts.length) {
        const displayMap = await externalDisplayMap(
          system,
          concepts.map((concept) => String((concept as Row).code || "")),
        );
        for (const concept of concepts) {
          const code = String((concept as Row).code || "");
          const local = localConcepts[code] || {};
          const display =
            String((concept as Row).display || "") ||
            String((local as Row).display || "") ||
            displayMap[code] ||
            "";
          const definition = String((concept as Row).definition || (local as Row).definition || "");
          addRow({
            row_type: "explicit concept",
            system,
            code,
            display,
            definition,
            meaning: conceptDesignations(local) || definition || display,
            properties: conceptProperties(local),
            source: "compose.include.concept",
          });
        }
        continue;
      }

      if (filters.length) {
        if (csLoaded) {
          const before = rows.length;
          addConceptsFromCodesystem({
            system,
            cs_data: csData,
            filters,
            source: "compose.include.filter",
          });
          if (rows.length > before) continue;
        }
        for (const filterItem of filters) {
          const prop = String((filterItem as Row).property || "");
          const op = String((filterItem as Row).op || "");
          const value = String((filterItem as Row).value || "");
          let expanded = 0;
          if (
            system === "http://snomed.info/sct" &&
            prop === "concept" &&
            ["is-a", "descendent-of", "descendant-of"].includes(op)
          ) {
            expanded = await addSnomedFilterConcepts({ root_code: value, op });
          } else if (system === "http://loinc.org" && op === "=") {
            expanded = await addLoincFilterConcepts({ prop, value });
          } else if (
            system === "http://www.nlm.nih.gov/research/umls/rxnorm" &&
            ["in", "="].includes(op)
          ) {
            expanded = await addRxnormFilterConcepts({ prop, op, value });
          }
          if (expanded) continue;
          addRow({
            row_type: "filter rule",
            system,
            code: value,
            display: `${prop} ${op} ${value}`.trim(),
            meaning: "The allowed values are produced by expanding this terminology filter.",
            properties: `${prop} ${op} ${value}`.trim(),
            source: "compose.include.filter",
          });
        }
        continue;
      }

      if (csLoaded) {
        addConceptsFromCodesystem({ system, cs_data: csData, source: "compose.include.system" });
      } else if (system) {
        addRow({
          row_type: "system include",
          system,
          display: `All codes from ${system}`,
          meaning:
            "This ValueSet includes the full external code system. Expansion requires that terminology source.",
          source: "compose.include.system",
        });
      }
    }

    for (const exclude of ((data.compose as Row)?.exclude as Row[]) || []) {
      const system = String((exclude as Row).system || "");
      for (const concept of ((exclude as Row).concept as Row[]) || []) {
        addRow({
          row_type: "excluded concept",
          system,
          code: String((concept as Row).code || ""),
          display: String((concept as Row).display || ""),
          meaning: "This code is explicitly excluded from the ValueSet.",
          source: "compose.exclude.concept",
        });
      }
    }

    return rows;
  };

  // ── main body ──
  const csCount = n((await query(`SELECT COUNT(*) AS c FROM ${CODESYSTEMS}`)).rows[0]?.c);
  const artifactCount = n((await query(`SELECT COUNT(*) AS c FROM ${ARTIFACTS}`)).rows[0]?.c);
  if (csCount === 0 && artifactCount === 0) {
    return { type: "empty", message: "TWCore IG module not loaded. Run the import first." };
  }

  page = Math.max(1, page || 1);
  perPage = Math.max(1, Math.min(perPage || 50, 100));
  const offset = (page - 1) * perPage;
  direction = direction === "desc" ? "desc" : "asc";
  elementSource = elementSource === "snapshot" ? "snapshot" : "differential";
  const sortMap: Record<string, string> = {
    title: "COALESCE(NULLIF(title, ''), NULLIF(name, ''), artifact_id, artifact_key)",
    resource_type: "resource_type",
    base_type: "base_type",
    child_count: "child_count",
    status: "status",
  };
  const sortSql = sortMap[sort] ?? sortMap.title;

  const groupRows = (
    await query(`
            SELECT grouping_id, COALESCE(NULLIF(grouping_name, ''), grouping_id) AS grouping_name,
                   COUNT(*) AS artifact_count,
                   COALESCE(SUM(child_count), 0) AS child_count
            FROM ${ARTIFACTS}
            GROUP BY grouping_id, grouping_name
            ORDER BY
                CASE grouping_id
                  WHEN 'implementation-guide' THEN 0
                  WHEN 'profiles' THEN 1
                  WHEN 'extensions-datatypes' THEN 2
                  WHEN 'terminology' THEN 3
                  WHEN 'conformance' THEN 4
                  WHEN 'search-parameters' THEN 5
                  WHEN 'examples' THEN 6
                  ELSE 9
                END,
                grouping_name
            `)
  ).rows;
  const typeRows = (
    await query(`
            SELECT grouping_id, resource_type,
                   COUNT(*) AS artifact_count,
                   COALESCE(SUM(child_count), 0) AS child_count
            FROM ${ARTIFACTS}
            GROUP BY grouping_id, resource_type
            ORDER BY grouping_id, resource_type
            `)
  ).rows;
  const childrenByGroup: Record<string, Row[]> = {};
  for (const r of typeRows) {
    const groupId = (r.grouping_id as string) || "";
    const resourceTypeValue = (r.resource_type as string) || "";
    (childrenByGroup[groupId] ||= []).push({
      node: `group:${groupId}`,
      grouping_id: groupId,
      resource_type: resourceTypeValue,
      label: resourceTypeValue,
      artifact_count: n(r.artifact_count),
      child_count: n(r.child_count),
      is_leaf: false,
    });
  }
  const treeNodes = groupRows.map((r) => ({
    node: `group:${r.grouping_id}`,
    grouping_id: (r.grouping_id as string) || "",
    label: r.grouping_name || r.grouping_id || "Ungrouped",
    artifact_count: n(r.artifact_count),
    child_count: n(r.child_count),
    children: childrenByGroup[(r.grouping_id as string) || ""] || [],
    is_leaf: false,
  }));
  const resourceTypes = (
    await query(`SELECT DISTINCT resource_type FROM ${ARTIFACTS} ORDER BY resource_type`)
  ).rows.map((r) => r.resource_type);
  const baseTypes = (
    await query(`
                SELECT DISTINCT base_type FROM ${ARTIFACTS}
                WHERE resource_type = 'StructureDefinition'
                  AND grouping_id = 'profiles'
                  AND COALESCE(base_type, '') <> ''
                ORDER BY base_type
                `)
  ).rows.map((r) => r.base_type);
  const profileRows = (
    await query(`
            SELECT *
            FROM ${ARTIFACTS}
            WHERE resource_type = 'StructureDefinition'
              AND grouping_id = 'profiles'
            ORDER BY
                COALESCE(NULLIF(base_type, ''), raw_json->>'type', artifact_id),
                COALESCE(NULLIF(title, ''), NULLIF(name, ''), artifact_id, artifact_key)
            `)
  ).rows;
  const profileOrderList = [
    "Patient",
    "Practitioner",
    "PractitionerRole",
    "Organization",
    "Encounter",
    "Condition",
    "Observation",
    "DiagnosticReport",
    "Procedure",
    "Medication",
    "MedicationRequest",
    "MedicationStatement",
    "MedicationDispense",
    "AllergyIntolerance",
    "Immunization",
    "CarePlan",
    "CareTeam",
    "Coverage",
    "Device",
    "DocumentReference",
    "Composition",
    "Bundle",
    "Location",
    "Specimen",
    "ServiceRequest",
    "Provenance",
    "RelatedPerson",
    "QuestionnaireResponse",
    "ImagingStudy",
    "Media",
    "Goal",
    "MessageHeader",
  ];
  const profileOrder: Record<string, number> = {};
  profileOrderList.forEach((name, i) => {
    profileOrder[name] = i;
  });
  const profilesByResource: Record<string, Row> = {};
  for (const profileRow of profileRows) {
    const resourceName = profileResourceName(profileRow);
    const summary = {
      ...artifactSummary(profileRow),
      node: `artifact:${profileRow.artifact_key}`,
      is_leaf: true,
      profile_resource: resourceName,
    };
    const bucket = (profilesByResource[resourceName] ||= {
      node: `resource:${resourceName}`,
      resource_name: resourceName,
      label: resourceName,
      profile_count: 0,
      child_count: 0,
      profiles: [],
    });
    (bucket.profile_count as number) += 1;
    (bucket.child_count as number) += n(profileRow.child_count);
    (bucket.profiles as Row[]).push(summary);
  }
  const profileTree = Object.values(profilesByResource).sort((a, b2) => {
    const ra = profileOrder[a.resource_name as string] ?? 999;
    const rb = profileOrder[b2.resource_name as string] ?? 999;
    if (ra !== rb) return ra - rb;
    return (a.resource_name as string) < (b2.resource_name as string)
      ? -1
      : (a.resource_name as string) > (b2.resource_name as string)
        ? 1
        : 0;
  });
  const profileCount = profileTree.reduce((acc, item) => acc + n(item.profile_count), 0);

  if (artifactCount === 0) {
    return {
      type: "tree_root",
      message:
        "TWCore CodeSystems are loaded, but the IG artifact index is missing. Re-import the TWCore package to enable the tree preview.",
      nodes: [],
      rows: [],
      total: 0,
      page: 1,
      per_page: perPage,
      counts: { codesystems: csCount, artifacts: 0, profiles: 0, profile_resources: 0 },
      profile_tree: [],
    };
  }

  const modeValue = mode.trim().toLowerCase();
  const queryStr = (qIn || "").trim();
  let selectedGroup = groupingId.trim();
  let selectedNode = nodeIn || "root";
  if (selectedNode.startsWith("group:")) {
    selectedGroup = selectedNode.split(":").slice(1).join(":");
  }

  const counts = {
    codesystems: csCount,
    artifacts: artifactCount,
    profiles: profileCount,
    profile_resources: profileTree.length,
  };

  const terminologyRowsForArtifact = async (row: Row, raw: Row): Promise<[Row[], number]> => {
    if (row.resource_type === "CodeSystem") {
      const totalRows = n(
        (
          await query(`SELECT COUNT(*) AS c FROM ${CONCEPTS} WHERE cs_id = $1`, [row.artifact_id])
        ).rows[0]?.c,
      );
      const conceptRows = (
        await query(
          `
                    SELECT code, display, definition
                    FROM ${CONCEPTS}
                    WHERE cs_id = $1
                    ORDER BY code
                    LIMIT $2 OFFSET $3
                    `,
          [row.artifact_id, perPage, offset],
        )
      ).rows;
      return [
        conceptRows.map((r) => ({
          code: r.code || "",
          display: r.display || "",
          definition: r.definition || "",
        })),
        totalRows,
      ];
    }
    if (row.resource_type === "ValueSet") {
      const valueRows = await valuesetAllowedRows(raw);
      return [valueRows.slice(offset, offset + perPage), valueRows.length];
    }
    return [[], 0];
  };

  const fetchArtifact = async (key: string): Promise<Row | undefined> =>
    (await query(`SELECT * FROM ${ARTIFACTS} WHERE artifact_key = $1`, [key])).rows[0];

  const artifactTreeResponse = async (key: string): Promise<Row> => {
    const row = await fetchArtifact(key);
    if (!row) return { type: "error", message: `Artifact '${key}' not found` };
    const selected = artifactSummary(row);
    const raw = jsonValue(row.raw_json);
    const detail = resourceDetail(raw, row.resource_type as string);
    const elements = (detail.elements as Row[]) || [];
    const [terminologyRows, terminologyTotal] = await terminologyRowsForArtifact(row, raw);
    return {
      type: "artifact_tree",
      tree: treeNodes,
      navigator: treeNodes,
      profile_tree: profileTree,
      selected,
      artifact: selected,
      detail,
      elements,
      element_tree: row.resource_type === "StructureDefinition" ? elementTree(elements) : [],
      stats: detail.stats || {},
      rows: terminologyRows,
      total: row.resource_type === "StructureDefinition" ? elements.length : terminologyTotal,
      page,
      per_page: perPage,
      counts,
      resource_types: resourceTypes,
      base_types: baseTypes,
    };
  };

  const valuesetResponse = async (urlOrKey: string): Promise<Row> => {
    const lookup = urlOrKey.trim();
    let artifactRow: Row | undefined;
    if (lookup) {
      artifactRow = (
        await query(
          `
                    SELECT *
                    FROM ${ARTIFACTS}
                    WHERE resource_type = 'ValueSet'
                      AND (
                        artifact_key = $1 OR canonical_url = $1 OR artifact_id = $2
                      )
                    LIMIT 1
                    `,
          [stripCanonicalVersion(lookup), canonicalTail(lookup, "ValueSet")],
        )
      ).rows[0];
    }
    if (!artifactRow) {
      return {
        type: "valueset_detail",
        tree: treeNodes,
        navigator: treeNodes,
        profile_tree: profileTree,
        selected: {
          resource_type: "ValueSet",
          artifact_id: canonicalTail(lookup, "ValueSet"),
          title: canonicalTail(lookup, "ValueSet") || lookup,
          canonical_url: lookup,
        },
        detail: { url: lookup },
        rows: lookup
          ? [
              {
                row_type: "external ValueSet",
                display: lookup,
                meaning:
                  "This ValueSet is referenced by the profile but is not present in the imported TWCore package.",
                source: "binding.valueSet",
              },
            ]
          : [],
        total: lookup ? 1 : 0,
        page,
        per_page: perPage,
        counts,
        resource_types: resourceTypes,
        base_types: baseTypes,
      };
    }
    const selected = artifactSummary(artifactRow);
    const raw = jsonValue(artifactRow.raw_json);
    const detail = resourceDetail(raw, "ValueSet");
    const valueRows = await valuesetAllowedRows(raw);
    return {
      type: "valueset_detail",
      tree: treeNodes,
      navigator: treeNodes,
      profile_tree: profileTree,
      selected,
      artifact: selected,
      detail,
      rows: valueRows.slice(offset, offset + perPage),
      total: valueRows.length,
      page,
      per_page: perPage,
      counts,
      resource_types: resourceTypes,
      base_types: baseTypes,
    };
  };

  if (modeValue === "navigator") {
    return {
      type: "navigator",
      tree: treeNodes,
      nodes: treeNodes,
      profile_tree: profileTree,
      rows: [],
      total: treeNodes.length,
      page: 1,
      per_page: perPage,
      counts,
      resource_types: resourceTypes,
      base_types: baseTypes,
    };
  }

  if (modeValue === "artifact_tree") {
    let key = artifactKeyIn.trim();
    if (!key && selectedNode.startsWith("artifact:")) {
      key = selectedNode.split(":").slice(1).join(":");
    }
    if (!key) {
      return { type: "error", message: "Missing artifact_key for TWCore artifact tree." };
    }
    return artifactTreeResponse(key);
  }

  if (modeValue === "valueset") {
    let lookup = valueSetUrlIn.trim() || artifactKeyIn.trim();
    if (!lookup && selectedNode) {
      lookup = selectedNode.startsWith("artifact:")
        ? selectedNode.slice("artifact:".length)
        : selectedNode;
    }
    return valuesetResponse(lookup);
  }

  if (modeValue === "search") {
    const term = queryStr || fieldQ.trim();
    const conditions: string[] = [];
    const sqlParams: unknown[] = [];
    if (term) {
      sqlParams.push(`%${term}%`);
      const i = sqlParams.length;
      conditions.push(
        `(artifact_key ILIKE $${i} OR artifact_id ILIKE $${i} ` +
          `OR canonical_url ILIKE $${i} OR name ILIKE $${i} ` +
          `OR title ILIKE $${i} OR description ILIKE $${i})`,
      );
    }
    if (selectedGroup) {
      sqlParams.push(selectedGroup);
      conditions.push(`grouping_id = $${sqlParams.length}`);
    }
    if (resourceType) {
      sqlParams.push(resourceType);
      conditions.push(`resource_type = $${sqlParams.length}`);
    }
    if (baseType) {
      sqlParams.push(baseType);
      conditions.push(`base_type = $${sqlParams.length}`);
    }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const total = n(
      (await query(`SELECT COUNT(*) AS c FROM ${ARTIFACTS} ${where}`, sqlParams)).rows[0]?.c,
    );
    const artifactSearchRows = (
      await query(
        `
                SELECT *
                FROM ${ARTIFACTS}
                ${where}
                ORDER BY ${sortSql} ${direction}, artifact_key
                LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}
                `,
        [...sqlParams, perPage, offset],
      )
    ).rows;
    let structureRows: Row[] = [];
    if (!resourceType || resourceType === "StructureDefinition") {
      const structureConditions = ["resource_type = 'StructureDefinition'"];
      const structureParams: unknown[] = [];
      if (selectedGroup) {
        structureParams.push(selectedGroup);
        structureConditions.push(`grouping_id = $${structureParams.length}`);
      }
      if (baseType) {
        structureParams.push(baseType);
        structureConditions.push(`base_type = $${structureParams.length}`);
      }
      const structureWhere = "WHERE " + structureConditions.join(" AND ");
      structureRows = (
        await query(
          `
                    SELECT *
                    FROM ${ARTIFACTS}
                    ${structureWhere}
                    ORDER BY COALESCE(NULLIF(title, ''), NULLIF(name, ''), artifact_id, artifact_key)
                    `,
          structureParams,
        )
      ).rows;
    }
    const fieldResults: Row[] = [];
    if (term) {
      for (const structureRow of structureRows) {
        const artifact = artifactSummary(structureRow);
        const raw = jsonValue(structureRow.raw_json);
        for (const element of structureElementRows(raw)) {
          if (!elementMatches(element, term)) continue;
          fieldResults.push({
            ...element,
            artifact_key: artifact.artifact_key,
            artifact_id: artifact.artifact_id,
            artifact_title: artifact.title,
            base_type: artifact.base_type,
            grouping_name: artifact.grouping_name,
            node: `artifact:${artifact.artifact_key}`,
          });
        }
      }
    }
    return {
      type: "search",
      tree: treeNodes,
      navigator: treeNodes,
      profile_tree: profileTree,
      rows: artifactSearchRows.map((r) => ({
        ...artifactSummary(r),
        node: `artifact:${r.artifact_key}`,
        is_leaf: true,
      })),
      field_results: fieldResults.slice(0, 100),
      field_results_total: fieldResults.length,
      total,
      page,
      per_page: perPage,
      counts,
      resource_types: resourceTypes,
      base_types: baseTypes,
    };
  }

  if (csId && !selectedNode.startsWith("artifact:")) {
    selectedNode = `artifact:CodeSystem/${csId}`;
  }

  if (selectedNode.startsWith("artifact:")) {
    const artifactKey = selectedNode.split(":").slice(1).join(":");
    const row = (await query(`SELECT * FROM ${ARTIFACTS} WHERE artifact_key = $1`, [artifactKey]))
      .rows[0];
    if (!row) return { type: "error", message: `Artifact '${artifactKey}' not found` };
    const selected = artifactSummary(row);
    const raw = jsonValue(row.raw_json);
    const detail = resourceDetail(raw, row.resource_type as string);
    let detailRows: Row[] = [];
    let total = 0;
    if (row.resource_type === "CodeSystem") {
      total = n(
        (
          await query(`SELECT COUNT(*) AS c FROM ${CONCEPTS} WHERE cs_id = $1`, [row.artifact_id])
        ).rows[0]?.c,
      );
      const conceptRows = (
        await query(
          `
                    SELECT code, display, definition
                    FROM ${CONCEPTS}
                    WHERE cs_id = $1
                    ORDER BY code
                    LIMIT $2 OFFSET $3
                    `,
          [row.artifact_id, perPage, offset],
        )
      ).rows;
      detailRows = conceptRows.map((r) => ({
        code: r.code || "",
        display: r.display || "",
        definition: r.definition || "",
      }));
    } else if (row.resource_type === "ValueSet") {
      const valueRows = await valuesetAllowedRows(raw);
      total = valueRows.length;
      detailRows = valueRows.slice(offset, offset + perPage);
    } else if (row.resource_type === "StructureDefinition") {
      const elementRows = (detail.elements as Row[]) || [];
      total = elementRows.length;
      detailRows = elementRows.slice(offset, offset + perPage);
    }
    return {
      type: "artifact_detail",
      tree: treeNodes,
      navigator: treeNodes,
      profile_tree: profileTree,
      selected,
      detail,
      rows: detailRows,
      total,
      page,
      per_page: perPage,
      counts,
      resource_types: resourceTypes,
      base_types: baseTypes,
    };
  }

  const conditions: string[] = [];
  const sqlParams: unknown[] = [];
  if (queryStr) {
    sqlParams.push(`%${queryStr}%`);
    const i = sqlParams.length;
    conditions.push(
      `(artifact_key ILIKE $${i} OR artifact_id ILIKE $${i} ` +
        `OR canonical_url ILIKE $${i} OR name ILIKE $${i} ` +
        `OR title ILIKE $${i} OR description ILIKE $${i})`,
    );
  }
  if (selectedGroup) {
    sqlParams.push(selectedGroup);
    conditions.push(`grouping_id = $${sqlParams.length}`);
  }
  if (resourceType) {
    sqlParams.push(resourceType);
    conditions.push(`resource_type = $${sqlParams.length}`);
  }
  if (baseType) {
    sqlParams.push(baseType);
    conditions.push(`base_type = $${sqlParams.length}`);
  }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const total = n(
    (await query(`SELECT COUNT(*) AS c FROM ${ARTIFACTS} ${where}`, sqlParams)).rows[0]?.c,
  );
  const rows = (
    await query(
      `
            SELECT *
            FROM ${ARTIFACTS}
            ${where}
            ORDER BY ${sortSql} ${direction}, artifact_key
            LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}
            `,
      [...sqlParams, perPage, offset],
    )
  ).rows;
  const artifactRows = rows.map((r) => ({
    ...artifactSummary(r),
    node: `artifact:${r.artifact_key}`,
    is_leaf: true,
  }));

  if (queryStr || selectedGroup || resourceType || baseType) {
    return {
      type: "artifact_list",
      tree: treeNodes,
      navigator: treeNodes,
      profile_tree: profileTree,
      selected_group: selectedGroup,
      rows: artifactRows,
      total,
      page,
      per_page: perPage,
      counts,
      resource_types: resourceTypes,
      base_types: baseTypes,
    };
  }

  return {
    type: "tree_root",
    tree: treeNodes,
    navigator: treeNodes,
    profile_tree: profileTree,
    nodes: treeNodes,
    rows: treeNodes,
    total: treeNodes.length,
    page: 1,
    per_page: treeNodes.length,
    counts,
    resource_types: resourceTypes,
    base_types: baseTypes,
  };
}

// ---------------------------------------------------------------------------
// Taiwan FDA Drug  (quality stats + paginated license list)
// ---------------------------------------------------------------------------

async function previewDrug(params: Params): Promise<Row> {
  const page = pInt(params, "page", 1);
  const q = pStr(params, "q");
  const quality = pStr(params, "quality");
  const perPage = pInt(params, "per_page", DRUG_PAGE_SIZE);

  const licenseCount = n((await query("SELECT COUNT(*) AS c FROM drug.licenses")).rows[0]?.c);
  if (licenseCount === 0) {
    return {
      type: "empty",
      message: "Drug module not loaded. Run the drug index import first.",
      total: 0,
    };
  }

  const qualityRows = (
    await query(`
            SELECT quality_confidence, COUNT(*) AS cnt
            FROM drug.normalized_records
            GROUP BY quality_confidence
            ORDER BY quality_confidence
            `)
  ).rows;
  const qualityStats: Record<string, number> = {};
  for (const r of qualityRows) qualityStats[r.quality_confidence as string] = n(r.cnt);

  const conditions: string[] = [];
  const sqlParams: unknown[] = [];
  let idx = 1;

  if (q && q.trim()) {
    const term = "%" + q.trim() + "%";
    conditions.push(
      `(l.license_id ILIKE $${idx} OR l.chinese_name ILIKE $${idx} OR l.english_name ILIKE $${idx})`,
    );
    sqlParams.push(term);
    idx += 1;
  }
  if (quality && quality.trim()) {
    conditions.push(`nr.quality_confidence = $${idx}`);
    sqlParams.push(quality.trim());
    idx += 1;
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const countSql = `
            SELECT COUNT(*) AS c FROM drug.licenses l
            LEFT JOIN drug.normalized_records nr ON nr.license_id = l.license_id
            ${where}
        `;
  const totalFiltered = n((await query(countSql, sqlParams)).rows[0]?.c);

  const offset = (Math.max(1, page) - 1) * perPage;
  const rows = (
    await query(
      `
            SELECT
                l.license_id,
                l.chinese_name,
                l.english_name,
                l.drug_category,
                l.is_active,
                COALESCE(nr.quality_confidence, 'index_only') AS quality_confidence,
                COALESCE(nr.primary_insert_source, 'index')   AS primary_insert_source
            FROM drug.licenses l
            LEFT JOIN drug.normalized_records nr ON nr.license_id = l.license_id
            ${where}
            ORDER BY l.license_id
            LIMIT $${idx} OFFSET $${idx + 1}
            `,
      [...sqlParams, perPage, offset],
    )
  ).rows;

  return {
    type: "drug",
    stats: { total_licenses: licenseCount, quality: qualityStats },
    total: totalFiltered,
    page,
    per_page: perPage,
    pages: Math.max(1, Math.floor((totalFiltered + perPage - 1) / perPage)),
    rows: rows.map((r) => ({
      license_id: r.license_id,
      chinese_name: r.chinese_name || "",
      english_name: r.english_name || "",
      drug_category: r.drug_category || "",
      is_active: b(r.is_active),
      quality_confidence: r.quality_confidence || "index_only",
      primary_insert_source: r.primary_insert_source || "index",
    })),
  };
}

// ---------------------------------------------------------------------------
// Taiwan FDA Health Supplements  (paginated permit list)
// ---------------------------------------------------------------------------

async function previewHealthSupplements(params: Params): Promise<Row> {
  const page = pInt(params, "page", 1);
  const q = pStr(params, "q");
  const perPage = pInt(params, "per_page", HF_PAGE_SIZE);

  const total = n((await query("SELECT COUNT(*) AS c FROM health_supplements.items")).rows[0]?.c);
  if (total === 0) {
    return {
      type: "empty",
      message: "Health Supplements module not loaded. Run a sync job first.",
      total: 0,
    };
  }

  const lastSync = (
    await query("SELECT value FROM health_supplements.sync_meta WHERE key = 'last_updated'")
  ).rows[0]?.value;

  const conditions: string[] = [];
  const sqlParams: unknown[] = [];
  if (q && q.trim()) {
    const term = "%" + q.trim() + "%";
    conditions.push(
      "(name ILIKE $1 OR applicant ILIKE $1 OR benefit_claims ILIKE $1 OR permit_no ILIKE $1)",
    );
    sqlParams.push(term);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const totalFiltered = n(
    (await query(`SELECT COUNT(*) AS c FROM health_supplements.items ${where}`, sqlParams))
      .rows[0]?.c,
  );

  const offset = (Math.max(1, page) - 1) * perPage;
  const pIdx = sqlParams.length + 1;
  const rows = (
    await query(
      `
            SELECT permit_no, name, applicant, benefit_claims, valid_from, valid_to, category
            FROM health_supplements.items ${where}
            ORDER BY permit_no
            LIMIT $${pIdx} OFFSET $${pIdx + 1}
            `,
      [...sqlParams, perPage, offset],
    )
  ).rows;

  return {
    type: "table",
    total: totalFiltered,
    total_all: total,
    last_sync: lastSync ?? null,
    page,
    per_page: perPage,
    pages: Math.max(1, Math.floor((totalFiltered + perPage - 1) / perPage)),
    rows: rows.map((r) => ({
      permit_no: r.permit_no,
      name: r.name || "",
      applicant: r.applicant || "",
      benefit_claims: r.benefit_claims || "",
      valid_from: r.valid_from || "",
      valid_to: r.valid_to || "",
      category: r.category || "",
    })),
  };
}

// ---------------------------------------------------------------------------
// Taiwan FDA Food Nutrition  (foods + ingredients)
// ---------------------------------------------------------------------------

async function previewFoodNutrition(params: Params): Promise<Row> {
  const mode = pStr(params, "mode", "foods");
  const page = pInt(params, "page", 1);
  const q = pStr(params, "q");
  const perPage = pInt(params, "per_page", FN_PAGE_SIZE);

  if (mode === "ingredients") {
    const total = n(
      (await query("SELECT COUNT(*) AS c FROM food_nutrition.ingredients")).rows[0]?.c,
    );
    if (total === 0) {
      return { type: "empty", message: "Food Nutrition ingredients not loaded.", total: 0 };
    }

    const conditions: string[] = [];
    const sqlParams: unknown[] = [];
    if (q && q.trim()) {
      const term = "%" + q.trim() + "%";
      conditions.push("(name_zh ILIKE $1 OR name_en ILIKE $1)");
      sqlParams.push(term);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const totalFiltered = n(
      (await query(`SELECT COUNT(*) AS c FROM food_nutrition.ingredients ${where}`, sqlParams))
        .rows[0]?.c,
    );

    const offset = (Math.max(1, page) - 1) * perPage;
    const pIdx = sqlParams.length + 1;
    const rows = (
      await query(
        `
                SELECT id, name_zh, name_en, major_category, sub_category
                FROM food_nutrition.ingredients ${where}
                ORDER BY id
                LIMIT $${pIdx} OFFSET $${pIdx + 1}
                `,
        [...sqlParams, perPage, offset],
      )
    ).rows;
    return {
      type: "ingredients",
      total: totalFiltered,
      total_all: total,
      page,
      per_page: perPage,
      pages: Math.max(1, Math.floor((totalFiltered + perPage - 1) / perPage)),
      rows: rows.map((r) => ({
        id: r.id,
        name_zh: r.name_zh || "",
        name_en: r.name_en || "",
        major_category: r.major_category || "",
        sub_category: r.sub_category || "",
      })),
    };
  }

  const total = n(
    (await query("SELECT COUNT(DISTINCT sample_name) AS c FROM food_nutrition.measurements"))
      .rows[0]?.c,
  );
  if (total === 0) {
    return { type: "empty", message: "Food Nutrition measurements not loaded.", total: 0 };
  }

  const lastSync = (
    await query("SELECT value FROM food_nutrition.sync_meta WHERE key = 'last_updated'")
  ).rows[0]?.value;

  const conditions: string[] = [];
  const sqlParams: unknown[] = [];
  if (q && q.trim()) {
    const term = "%" + q.trim() + "%";
    conditions.push("(sample_name ILIKE $1 OR common_name ILIKE $1 OR english_name ILIKE $1)");
    sqlParams.push(term);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const totalFiltered = n(
    (
      await query(
        `SELECT COUNT(DISTINCT sample_name) AS c FROM food_nutrition.measurements ${where}`,
        sqlParams,
      )
    ).rows[0]?.c,
  );

  const offset = (Math.max(1, page) - 1) * perPage;
  const pIdx = sqlParams.length + 1;
  const rows = (
    await query(
      `
            SELECT DISTINCT ON (sample_name)
                sample_name, common_name, english_name, food_category,
                COUNT(*) OVER (PARTITION BY sample_name) AS nutrient_count
            FROM food_nutrition.measurements
            ${where}
            ORDER BY sample_name
            LIMIT $${pIdx} OFFSET $${pIdx + 1}
            `,
      [...sqlParams, perPage, offset],
    )
  ).rows;

  return {
    type: "foods",
    total: totalFiltered,
    total_all: total,
    last_sync: lastSync ?? null,
    page,
    per_page: perPage,
    pages: Math.max(1, Math.floor((totalFiltered + perPage - 1) / perPage)),
    rows: rows.map((r) => ({
      sample_name: r.sample_name || "",
      common_name: r.common_name || "",
      english_name: r.english_name || "",
      food_category: r.food_category || "",
      nutrient_count: n(r.nutrient_count),
    })),
  };
}

// ---------------------------------------------------------------------------
// RxNorm  (concept table + TTY facet/filter)
// ---------------------------------------------------------------------------

async function previewRxnorm(params: Params): Promise<Row> {
  const q = pStr(params, "q");
  let tty = pStr(params, "tty");
  let page = pInt(params, "page", 1);
  let perPage = pInt(params, "per_page", RXNORM_PAGE_SIZE);

  const totalAll = n((await query("SELECT COUNT(*) AS c FROM rxnorm.concepts")).rows[0]?.c);
  if (totalAll === 0) {
    return {
      type: "empty",
      message: "RxNorm module not loaded. Upload the RxNorm Full Release ZIP and import first.",
      total: 0,
    };
  }

  const ttyRows = (
    await query("SELECT tty, COUNT(*) AS n FROM rxnorm.concepts GROUP BY tty ORDER BY n DESC, tty")
  ).rows;
  const ttyFacets = ttyRows.map((r) => ({ tty: r.tty, count: n(r.n) }));

  const queryStr = q.trim();
  tty = tty.trim();
  page = Math.max(1, page || 1);
  perPage = Math.max(1, Math.min(perPage || RXNORM_PAGE_SIZE, 200));

  const conditions: string[] = [];
  const sqlParams: unknown[] = [];
  if (queryStr) {
    if (/^\d+$/.test(queryStr)) {
      sqlParams.push(queryStr + "%");
      sqlParams.push("%" + queryStr + "%");
      conditions.push(
        `(rxcui::text LIKE $${sqlParams.length - 1} OR name ILIKE $${sqlParams.length})`,
      );
    } else {
      sqlParams.push("%" + queryStr + "%");
      conditions.push(`name ILIKE $${sqlParams.length}`);
    }
  }
  if (tty) {
    sqlParams.push(tty);
    conditions.push(`tty = $${sqlParams.length}`);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const totalFiltered = n(
    (await query(`SELECT COUNT(*) AS c FROM rxnorm.concepts ${where}`, sqlParams)).rows[0]?.c,
  );

  const offset = (page - 1) * perPage;
  const rows = (
    await query(
      `
            SELECT rxcui, name, tty, suppress
            FROM rxnorm.concepts
            ${where}
            ORDER BY rxcui
            LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}
            `,
      [...sqlParams, perPage, offset],
    )
  ).rows;

  return {
    type: "concepts",
    total: totalFiltered,
    total_all: totalAll,
    tty_facets: ttyFacets,
    tty_selected: tty,
    query: queryStr,
    page,
    per_page: perPage,
    pages: Math.max(1, Math.floor((totalFiltered + perPage - 1) / perPage)),
    rows: rows.map((r) => ({
      rxcui: String(r.rxcui),
      name: r.name || "",
      tty: r.tty || "",
      suppress: r.suppress || "",
    })),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const PREVIEW_HANDLERS: Record<string, (params: Params) => Promise<Row>> = {
  icd: previewIcd,
  loinc: previewLoinc,
  snomed: previewSnomed,
  ig: previewIg,
  drug: previewDrug,
  health_supplements: previewHealthSupplements,
  food_nutrition: previewFoodNutrition,
  rxnorm: previewRxnorm,
};

export const PREVIEW_SUPPORTED_MODULES: ReadonlySet<string> = new Set(Object.keys(PREVIEW_HANDLERS));

export async function dispatchPreview(moduleKey: string, params: Params): Promise<Row> {
  const handler = PREVIEW_HANDLERS[moduleKey];
  if (!handler) {
    return { type: "error", message: `No preview handler for module '${moduleKey}'` };
  }
  return handler(params);
}

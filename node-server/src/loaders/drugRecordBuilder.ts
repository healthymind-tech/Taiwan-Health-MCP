/**
 * Builds canonical drug records from index and enrichment data.
 *
 * Node port of `src/drug_record_builder.py`. Index-only records come from
 * `36_2.csv` alone; enriched records may additionally carry electronic-insert
 * data, insert/label documents with MinIO locators, and appearance records.
 *
 * The record shape is persisted verbatim as `drug.normalized_records.normalized_json`,
 * so Python's evaluation rules are reproduced rather than "cleaned up":
 * - `pick(...)` is Python's `or` chain (first *truthy* value; "" and [] are falsy)
 * - `dictGet(d, k, default)` is `dict.get(k, default)` — an existing-but-empty
 *   value wins over the default, which is NOT what an `or` chain would do
 */

import { parseDate } from "./tfdaParserUtils.js";

export const INDEX_LICENSE = "許可證字號";
export const INDEX_CANCEL_STATUS = "註銷狀態";
export const INDEX_CANCEL_DATE = "註銷日期";

const SPLIT_PATTERN = /[；;、]\s*/;
const LICENSE_TOKEN_PATTERN = /[^A-Z0-9]+/g;

export type Dict = Record<string, unknown>;
export type IndexRow = Record<string, string>;

export function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness: "", [], {}, 0, null, undefined, false are falsy. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === "" || value === false || value === 0) {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python `a or b or ""` — the first truthy value, else "". */
function pick(...values: unknown[]): unknown {
  for (const value of values) if (truthy(value)) return value;
  return "";
}

/** Python `dict.get(key, default)`. */
function dictGet(data: Dict | undefined, key: string, fallback: unknown = ""): unknown {
  if (!data || !(key in data)) return fallback;
  return data[key];
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Python `str(v)` for the values that reach it here (strings, numbers, bools). */
function pyStr(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  return String(value);
}

export function splitIndexText(value: string): string[] {
  if (!value) return [];
  return value
    .split(SPLIT_PATTERN)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export function isActiveIndexRow(row: IndexRow): boolean {
  return !row[INDEX_CANCEL_STATUS] && !row[INDEX_CANCEL_DATE];
}

/**
 * True when the electronic insert has substantive medical sections.
 *
 * An EI carrying only `basic_info` with an empty `sections` adds nothing over the
 * index CSV row and must not count as enriched.
 */
export function isEiComplete(ei: Dict | null | undefined): boolean {
  if (!ei) return false;
  const sections = ei.sections;
  return isDict(sections) && Object.keys(sections).length > 0;
}

export function normalizeLicenseToken(licenseId: string): string {
  return (licenseId || "").toUpperCase().replace(LICENSE_TOKEN_PATTERN, "");
}

export function normalizeIndexIngredients(rawSummary: string): Record<string, string>[] {
  return splitIndexText(rawSummary).map((item) => ({
    name: item,
    amount: "",
    unit: "",
    raw_text: item,
  }));
}

export function asList(value: unknown): unknown[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value;
  return [value];
}

export function textList(value: unknown): string[] {
  const output: string[] = [];
  for (const item of asList(value)) {
    if (typeof item === "string") {
      if (item.trim()) output.push(item.trim());
    } else if (isDict(item)) {
      const joined = Object.values(item)
        .map((val) => pyStr(val).trim())
        .filter((val) => val !== "")
        .join(" ");
      if (joined) output.push(joined);
    }
  }
  return output;
}

export function nestedGet(data: unknown, ...keys: string[]): unknown {
  let current: unknown = data;
  for (const key of keys) {
    if (!isDict(current)) return "";
    current = dictGet(current, key, "");
  }
  return current;
}

function normalizeIngredientItem(item: unknown): Record<string, string> {
  if (typeof item === "string") {
    return { name: item, amount: "", unit: "", raw_text: item };
  }
  if (!isDict(item)) {
    return { name: "", amount: "", unit: "", raw_text: "" };
  }
  const name = pick(item["成分"], item["成分名稱"], item.name, item.ingredient);
  const amount = pick(item["含量"], item["含量描述"], item.amount, item.quantity);
  const unit = pick(item["單位"], item.unit);
  const rawText = pick(
    item.raw_text,
    Object.values(item)
      .filter((value) => truthy(value))
      .map((value) => pyStr(value))
      .join(" "),
  );
  return {
    name: pyStr(name).trim(),
    amount: pyStr(amount).trim(),
    unit: pyStr(unit).trim(),
    raw_text: pyStr(rawText).trim(),
  };
}

function normalizeIngredients(
  row: IndexRow,
  electronicInsert: Dict | null,
  analysis: Dict | null,
): Dict {
  let active: Record<string, string>[];
  let inactive: Record<string, string>[];

  if (truthy(analysis)) {
    const analysisDict = analysis as Dict;
    active = asList(dictGet(analysisDict, "有效成分及含量")).map(normalizeIngredientItem);
    inactive = asList(dictGet(analysisDict, "其他成分")).map(normalizeIngredientItem);
    // PDF OCR sometimes misses ingredients the electronic insert parsed correctly
    // from structured HTML — fall back to EI when analysis found none.
    if (active.length === 0 && truthy(electronicInsert)) {
      const source = dictGet(electronicInsert as Dict, "ingredients", {});
      const items = isDict(source) ? dictGet(source, "成分", []) : [];
      active = asList(items).map(normalizeIngredientItem);
    }
  } else if (truthy(electronicInsert)) {
    const source = dictGet(electronicInsert as Dict, "ingredients", {});
    const items = isDict(source) ? dictGet(source, "成分", []) : [];
    active = asList(items).map(normalizeIngredientItem);
    inactive = [];
  } else {
    active = normalizeIndexIngredients(row["主成分略述"] ?? "");
    inactive = [];
  }

  return { active, inactive, raw_summary: row["主成分略述"] ?? "" };
}

function normalizeCompanies(row: IndexRow, electronicInsert: Dict | null): Dict {
  const basicRaw = electronicInsert ? dictGet(electronicInsert, "basic_info", {}) : {};
  const basic: Dict = electronicInsert && isDict(basicRaw) ? basicRaw : {};

  const manufacturers: Dict[] = [];
  for (const item of asList(
    electronicInsert ? dictGet(electronicInsert, "manufacturers", []) : [],
  )) {
    if (isDict(item)) {
      manufacturers.push({
        name: dictGet(item, "製造廠名稱"),
        factory_address: dictGet(item, "製造廠地址"),
        company_address: dictGet(item, "製造廠公司地址"),
        country: dictGet(item, "製造廠國別"),
        process: dictGet(item, "製程", dictGet(item, "類型", "")),
      });
    }
  }
  if (manufacturers.length === 0 && row["製造商名稱"]) {
    manufacturers.push({
      name: row["製造商名稱"] ?? "",
      factory_address: row["製造廠廠址"] ?? "",
      company_address: row["製造廠公司地址"] ?? "",
      country: row["製造廠國別"] ?? "",
      process: row["製程"] ?? "",
    });
  }

  return {
    applicant: {
      name: pick(row["申請商名稱"], dictGet(basic, "申請商名稱")),
      address: pick(row["申請商地址"], dictGet(basic, "申請商地址")),
      tax_id: row["申請商統一編號"] ?? "",
    },
    manufacturers,
  };
}

function pickSections(electronicInsert: Dict | null, analysis: Dict | null): [string, Dict] {
  if (truthy(analysis)) return ["pdf_insert", analysis as Dict];
  if (truthy(electronicInsert)) {
    const sections = dictGet(electronicInsert as Dict, "sections", undefined);
    if (isDict(sections) && Object.keys(sections).length > 0) return ["electronic_insert", sections];
  }
  return ["index_only", {}];
}

function normalizeUsage(sections: Dict, row: IndexRow): Dict {
  const purpose = pick(
    dictGet(sections, "用途(適應症)"),
    dictGet(sections, "適應症"),
    row["適應症"] ?? "",
  );
  const dosage = pick(
    dictGet(sections, "用法用量"),
    dictGet(sections, "用法及用量"),
    nestedGet(sections, "用法及用量", "用法用量"),
    row["用法用量"] ?? "",
  );
  return {
    purpose: typeof purpose === "string" ? splitIndexText(purpose) : textList(purpose),
    dosage_and_administration:
      typeof dosage === "string" ? splitIndexText(dosage) : textList(dosage),
    usage_text_from_index: row["用法用量"] ?? "",
  };
}

function normalizeSafety(sections: Dict): Dict {
  let precautions = dictGet(sections, "使用上注意事項", {});
  let warnings = dictGet(sections, "警語", {});
  if (!isDict(precautions)) precautions = { 其他使用上注意事項: precautions };
  if (!isDict(warnings)) warnings = { 警語: warnings };
  const prec = precautions as Dict;
  const warn = warnings as Dict;

  const electronicWarning = dictGet(sections, "警語及注意事項", {});
  // Python passes `dict.values()` to text_list, where neither strs nor dicts match,
  // so a dict here always contributes nothing. Reproduced deliberately.
  const generalWarnings = isDict(electronicWarning) ? [] : textList(electronicWarning);

  return {
    contraindications: textList(
      pick(dictGet(prec, "有下列情形者，請勿使用"), dictGet(sections, "禁忌")),
    ),
    consult_doctor_before_use: textList(dictGet(prec, "有下列情形者，使用前請洽醫師診治")),
    consult_professional_before_use: textList(
      dictGet(prec, "有下列情形者，使用前請先諮詢醫師藥師藥劑生"),
    ),
    precautions: [...textList(dictGet(prec, "其他使用上注意事項")), ...generalWarnings],
    warnings: [...textList(dictGet(warn, "警語")), ...textList(dictGet(sections, "警語及注意事項"))],
    side_effects_stop_use: textList(
      pick(
        dictGet(
          warn,
          "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生",
        ),
        dictGet(sections, "副作用/不良反應"),
      ),
    ),
    symptoms_stop_use_and_seek_care: textList(
      dictGet(warn, "使用本藥後，若有發生以下症狀時，請立即停止使用，並接受醫師診治"),
    ),
  };
}

function normalizeStorage(sections: Dict): string[] {
  const storage = dictGet(sections, "儲存方式");
  if (truthy(storage)) return textList(storage);
  const packageStorage = dictGet(sections, "包裝及儲存", {});
  if (isDict(packageStorage)) {
    return textList([
      dictGet(packageStorage, "儲存條件", ""),
      dictGet(packageStorage, "儲存注意事項", ""),
    ]);
  }
  return [];
}

/** An asset as it reaches the record builder — either a scrape or a DB row. */
export type AssetLike = Dict;

function assetMinioRef(asset: AssetLike): Dict {
  return {
    bucket: pick(asset.bucket),
    object_key: pick(asset.object_key),
    uri: pick(asset.minio_uri),
  };
}

/** Dates from the DB arrive as Date; from a scrape as an ISO string. */
function toDateStr(value: unknown): string {
  if (!truthy(value)) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return asString(value);
}

function assetFileRef(asset: AssetLike, contentSummary = ""): Dict {
  return {
    filename: pick(asset.normalized_filename, asset.source_filename),
    upload_date: toDateStr(asset.upload_date),
    source_url: pick(asset.source_url),
    document_type: pick(asset.asset_type),
    content_summary: contentSummary,
    minio: assetMinioRef(asset),
  };
}

function pickLatestDocument(documents: Dict[]): Dict | null {
  let best: Dict | null = null;
  let bestDate: Date | null = null;
  for (const doc of documents) {
    const dateVal = parseDate(asString(dictGet(doc, "upload_date", "")));
    if (dateVal === null) continue;
    // Python's max() keeps the first maximal element — strict > preserves that.
    if (bestDate === null || dateVal.getTime() > bestDate.getTime()) {
      best = doc;
      bestDate = dateVal;
    }
  }
  if (best !== null) return best;
  return documents.length > 0 ? (documents[documents.length - 1] as Dict) : null;
}

function mergeDocumentRefs(documents: Dict[]): Dict[] {
  const merged = new Map<string, Dict>();
  const order: string[] = [];
  for (const doc of documents) {
    const key = asString(pick(doc.filename, doc.source_url, String(order.length)));
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...doc });
      order.push(key);
      continue;
    }
    for (const [field, value] of Object.entries(doc)) {
      if (truthy(value) && !truthy(current[field])) current[field] = value;
    }
    if (current.document_type !== "insert_pdf" && doc.document_type === "insert_pdf") {
      current.document_type = "insert_pdf";
    }
  }
  return order.map((key) => merged.get(key) as Dict);
}

function normalizeInsertDocuments(electronicInsert: Dict | null, insertAssets: AssetLike[]): Dict[] {
  let documents: Dict[] = insertAssets.map((asset) => ({
    ...assetFileRef(asset),
    is_latest_used_for_analysis: Boolean(asset.is_latest_for_analysis),
  }));

  for (const key of ["history_pdfs", "public_pdfs", "paper_pdfs"]) {
    for (const item of asList(electronicInsert ? dictGet(electronicInsert, key, []) : [])) {
      if (isDict(item)) {
        documents.push({
          filename: pick(item.filename, item.label),
          upload_date: dictGet(item, "date", ""),
          source_url: dictGet(item, "url", ""),
          document_type: "insert_pdf",
          is_latest_used_for_analysis: false,
          minio: { bucket: "", object_key: "", uri: "" },
        });
      }
    }
  }

  documents = mergeDocumentRefs(documents);
  const latest = pickLatestDocument(documents);
  if (latest && !truthy(latest.is_latest_used_for_analysis)) {
    latest.is_latest_used_for_analysis = false;
  }
  return documents;
}

function normalizeLabelDocuments(electronicInsert: Dict | null, labelAssets: AssetLike[]): Dict[] {
  const documents: Dict[] = labelAssets.map((asset) => assetFileRef(asset));
  for (const item of asList(electronicInsert ? dictGet(electronicInsert, "label_pdfs", []) : [])) {
    if (isDict(item)) {
      documents.push({
        filename: pick(item.filename, item.label),
        upload_date: dictGet(item, "date", ""),
        source_url: dictGet(item, "url", ""),
        document_type: "label_pdf",
        content_summary: "",
        minio: { bucket: "", object_key: "", uri: "" },
      });
    }
  }
  return mergeDocumentRefs(documents);
}

function joinParts(parts: unknown[]): string {
  return parts
    .filter((part) => truthy(part))
    .map((part) => asString(part))
    .join(" ");
}

function normalizeAppearanceRecords(appearanceRecords: Dict[]): Dict {
  const records: Dict[] = [];
  for (const record of appearanceRecords) {
    let rawJson: unknown = pick(record.raw_json, {});
    if (typeof rawJson === "string") {
      try {
        rawJson = JSON.parse(rawJson);
      } catch {
        rawJson = {};
      }
    }
    if (!isDict(rawJson)) rawJson = {};
    const raw = rawJson as Dict;

    const images: Dict[] = [];
    for (const asset of asList(record.images)) {
      if (isDict(asset)) {
        images.push({
          filename: pick(asset.normalized_filename, asset.source_filename),
          source_url: pick(asset.source_url),
          upload_date: toDateStr(asset.upload_date),
          description: "",
          minio: assetMinioRef(asset),
        });
      }
    }

    records.push({
      shape_id: dictGet(record, "shape_id", ""),
      appearance_no: pick(record.appearance_no, dictGet(raw, "外觀編號", "")),
      description: pick(record.description, dictGet(raw, "藥品外觀", dictGet(raw, "外觀", ""))),
      color: pick(
        record.color,
        joinParts([dictGet(raw, "顏色"), dictGet(raw, "顏色1"), dictGet(raw, "顏色2")]),
      ),
      shape: pick(record.shape, dictGet(raw, "形狀", "")),
      scoring: pick(record.scoring, dictGet(raw, "刻痕", "")),
      symbol: pick(record.symbol, dictGet(raw, "符號", "")),
      size: pick(record.size, dictGet(raw, "大小", "")),
      imprint: pick(
        record.imprint,
        joinParts([dictGet(raw, "標記"), dictGet(raw, "標記1"), dictGet(raw, "標記2")]),
      ),
      images,
      raw_data: raw,
    });
  }
  return { records };
}

function buildQuality(record: Dict, electronicInsert: Dict | null, analysis: Dict | null): Dict {
  const drug = record.drug as Dict;
  const ingredients = record.ingredients as Dict;
  const usage = record.usage as Dict;
  const checks: Record<string, unknown> = {
    "drug.chinese_name": drug.chinese_name,
    "drug.english_name": drug.english_name,
    "ingredients.active": ingredients.active,
    "usage.purpose": usage.purpose,
    "usage.dosage_and_administration": usage.dosage_and_administration,
    storage: record.storage,
  };

  const missing: string[] = [];
  for (const [key, value] of Object.entries(checks)) {
    // Python: `value in ("", [], {})` — empty string, empty list or empty dict.
    const isEmpty =
      value === "" ||
      (Array.isArray(value) && value.length === 0) ||
      (isDict(value) && Object.keys(value).length === 0);
    if (isEmpty) missing.push(key);
  }

  let confidence = "high";
  if (missing.length > 0) confidence = "medium";
  if (!truthy(analysis) && !truthy(electronicInsert)) confidence = "low";

  const notes: string[] = [];
  if (!truthy(analysis) && truthy(electronicInsert)) {
    notes.push("PDF analysis not loaded; canonical record uses electronic insert data.");
  }
  if (!truthy(analysis) && !truthy(electronicInsert)) {
    notes.push("Index-only record; enrichment data not loaded.");
  }

  return { missing_fields: missing, conflict_fields: [], confidence, notes };
}

/**
 * Python `datetime.isoformat()` on an aware UTC datetime: `+00:00` rather than `Z`,
 * microseconds rather than milliseconds, and no fractional part at all when it is
 * zero. This string is persisted, so the shape has to match.
 */
function pyIsoformat(value: Date): string {
  const iso = value.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  const ms = value.getUTCMilliseconds();
  const fraction = ms === 0 ? "" : `.${iso.slice(20, 23)}000`;
  return `${iso.slice(0, 19)}${fraction}+00:00`;
}

export interface BuildDrugRecordOptions {
  electronicInsert?: Dict | null;
  analysis?: Dict | null;
  insertAssets?: AssetLike[];
  labelAssets?: AssetLike[];
  appearanceRecords?: Dict[];
  sourceErrors?: string[];
  normalizedAt?: Date;
}

export function buildDrugRecord(row: IndexRow, options: BuildDrugRecordOptions = {}): Dict {
  const electronicInsert = options.electronicInsert ?? null;
  const analysis = options.analysis ?? null;
  const insertAssets = options.insertAssets ?? [];
  const labelAssets = options.labelAssets ?? [];
  const appearanceRecords = options.appearanceRecords ?? [];
  const sourceErrors = options.sourceErrors ?? [];
  const normalizedAt = options.normalizedAt ?? new Date();

  const [sourceType, sections] = pickSections(electronicInsert, analysis);
  const basicRaw = electronicInsert ? dictGet(electronicInsert, "basic_info", {}) : {};
  const basic: Dict = electronicInsert && isDict(basicRaw) ? basicRaw : {};

  const insertDocuments = normalizeInsertDocuments(electronicInsert, insertAssets);
  const latestInsert = pickLatestDocument(insertDocuments);

  const record: Dict = {
    license_no: row[INDEX_LICENSE] ?? "",
    record_status: {
      is_active: isActiveIndexRow(row),
      cancellation_status: row[INDEX_CANCEL_STATUS] ?? "",
      cancellation_date: row[INDEX_CANCEL_DATE] ?? "",
      cancellation_reason: row["註銷理由"] ?? "",
      valid_until: pick(row["有效日期"], dictGet(basic, "有效日期")),
      issue_date: pick(row["發證日期"], dictGet(basic, "發證日期")),
      last_changed_date: row["異動日期"] ?? "",
    },
    source: {
      primary_insert_source: sourceType,
      has_electronic_insert: truthy(electronicInsert),
      has_pdf_insert: insertDocuments.length > 0,
      used_latest_pdf: truthy(analysis),
      latest_pdf_upload_date: latestInsert ? dictGet(latestInsert, "upload_date", "") : "",
      electronic_insert_source_url: electronicInsert
        ? dictGet(electronicInsert, "source_url", "")
        : "",
      normalized_at: pyIsoformat(normalizedAt),
      errors: sourceErrors,
    },
    drug: {
      chinese_name: pick(row["中文品名"], dictGet(basic, "中文品名")),
      english_name: pick(row["英文品名"], dictGet(basic, "英文品名")),
      license_type: row["許可證種類"] ?? "",
      old_license_no: row["舊證字號"] ?? "",
      customs_clearance_no: pick(row["通關簽審文件編號"], dictGet(basic, "通關簽審文件編號")),
      drug_category: pick(row["藥品類別"], dictGet(basic, "藥品類別")),
      controlled_drug_level: row["管制藥品分類級別"] ?? "",
      dosage_form: pick(row["劑型"], dictGet(basic, "劑型")),
      package: pick(row["包裝"], dictGet(basic, "包裝")),
      indications: splitIndexText(row["適應症"] ?? ""),
      atc_codes: electronicInsert ? dictGet(electronicInsert, "atc_codes", []) : [],
    },
    companies: normalizeCompanies(row, electronicInsert),
    ingredients: normalizeIngredients(row, electronicInsert, analysis),
    usage: normalizeUsage(sections, row),
    safety: normalizeSafety(sections),
    storage: normalizeStorage(sections),
    insert_content: {
      drug_characteristics: dictGet(sections, "藥品特性", ""),
      full_structured_sections: sections,
      insert_documents: insertDocuments,
    },
    packaging_and_labeling: {
      label_documents: normalizeLabelDocuments(electronicInsert, labelAssets),
    },
    appearance: normalizeAppearanceRecords(appearanceRecords),
  };

  record.quality = buildQuality(record, electronicInsert, analysis);
  return record;
}

export function buildIndexOnlyRecord(row: IndexRow, normalizedAt?: Date): Dict {
  return buildDrugRecord(row, { normalizedAt });
}

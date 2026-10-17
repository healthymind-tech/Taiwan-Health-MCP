/**
 * Per-module configuration for the data preview (GET /admin/api/modules/{key}/preview).
 * Query parameters mirror `buildPreviewKwargs` (adminApp.ts) and each module's
 * handler in adminPreview.ts.
 */

import { Badge, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { fmtNumber } from "@/lib/format";

export type PreviewRow = Record<string, unknown>;

export interface PreviewPayload {
  type?: string;
  message?: string;
  rows?: PreviewRow[];
  total?: number;
  total_all?: number;
  page?: number;
  per_page?: number;
  last_sync?: string | null;
  [k: string]: unknown;
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDef {
  key: string;
  label: string;
  kind: "segmented" | "select";
  defaultValue: string;
  /** Static options, or derived from the last response (facets). */
  options: FilterOption[] | ((data: PreviewPayload | undefined) => FilterOption[]);
  /** Only shown when this predicate holds for the current params. */
  visible?: (params: Record<string, string>) => boolean;
  searchable?: boolean;
}

export interface PreviewColumn {
  key: string;
  header: string;
  render?: (row: PreviewRow) => ReactNode;
  mono?: boolean;
  hideOnMobile?: boolean;
  primary?: boolean;
  align?: "left" | "right";
}

export interface PreviewConfig {
  searchPlaceholder: string;
  filters: FilterDef[];
  columns: (params: Record<string, string>, data: PreviewPayload | undefined) => PreviewColumn[];
  rowKey: (row: PreviewRow, index: number) => string;
  /** Field labels for the row detail drawer. */
  labels: Record<string, string>;
  /** Title shown in the detail drawer. */
  title: (row: PreviewRow) => string;
  /** Rows of this response are drill-down nodes: clicking applies these params instead of opening detail. */
  drillDown?: (data: PreviewPayload, row: PreviewRow) => Record<string, string> | null;
  /** Hint shown above the table for a given response. */
  hint?: (data: PreviewPayload, params: Record<string, string>) => ReactNode;
  perPage: number;
}

export function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : [];
}

const mono = (v: unknown) => (
  <Text fz="sm" ff="monospace" style={{ whiteSpace: "nowrap" }}>
    {str(v) || "—"}
  </Text>
);

const clamp = (v: unknown, lines = 2) => (
  <Text fz="sm" lineClamp={lines} style={{ wordBreak: "break-word" }}>
    {str(v) || <Text span c="dimmed">—</Text>}
  </Text>
);

const yesNo = (v: unknown, yes = "有", no = "無") =>
  v === true ? (
    <Badge size="xs" color="teal" variant="light">
      {yes}
    </Badge>
  ) : (
    <Badge size="xs" color="gray" variant="light">
      {no}
    </Badge>
  );

const ZH_FILTER: FilterDef = {
  key: "zh_filter",
  label: "中文名稱",
  kind: "select",
  defaultValue: "all",
  options: [
    { value: "all", label: "全部" },
    { value: "with_zh", label: "有中文名稱" },
    { value: "missing_zh", label: "缺中文名稱" },
  ],
};

export const PREVIEW_CONFIGS: Record<string, PreviewConfig> = {
  icd: {
    searchPlaceholder: "搜尋代碼、英文或中文名稱，例如 E11 或 糖尿病",
    perPage: 25,
    filters: [
      {
        key: "table",
        label: "資料表",
        kind: "segmented",
        defaultValue: "cm",
        options: [
          { value: "cm", label: "診斷碼 CM" },
          { value: "pcs", label: "處置碼 PCS" },
        ],
      },
      {
        key: "category",
        label: "分類",
        kind: "select",
        defaultValue: "",
        searchable: true,
        visible: (p) => p.table !== "pcs",
        options: (d) => [
          { value: "", label: "全部分類" },
          ...((d?.category_options as PreviewRow[] | undefined) ?? []).map((c) => ({
            value: str(c.code),
            label: `${str(c.code)} ${str(c.name_zh) || str(c.name_en)}`,
          })),
        ],
      },
      ZH_FILTER,
    ],
    columns: (_p, d) =>
      d?.type === "tree_root"
        ? [
            { key: "code", header: "分類", render: (r) => mono(r.code), primary: true },
            { key: "name_zh", header: "中文名稱", render: (r) => clamp(r.name_zh, 1) },
            { key: "name_en", header: "英文名稱", render: (r) => clamp(r.name_en, 1), hideOnMobile: true },
            { key: "child_count", header: "代碼數", render: (r) => fmtNumber(Number(r.child_count ?? 0)), align: "right" },
          ]
        : [
            { key: "code", header: "代碼", render: (r) => mono(r.code), primary: true },
            { key: "name_zh", header: "中文名稱", render: (r) => clamp(r.name_zh) },
            { key: "name_en", header: "英文名稱", render: (r) => clamp(r.name_en), hideOnMobile: true },
            { key: "category", header: "分類", render: (r) => mono(r.category), hideOnMobile: true },
          ],
    rowKey: (r) => str(r.code),
    labels: { code: "代碼", name_en: "英文名稱", name_zh: "中文名稱", category: "分類", child_count: "代碼數" },
    title: (r) => `${str(r.code)} ${str(r.name_zh) || str(r.name_en)}`,
    drillDown: (d, r) => (d.type === "tree_root" ? { category: str(r.code) } : null),
    hint: (d) =>
      d.type === "tree_root" ? (
        <>
          共 {fmtNumber(Number(d.total_cm ?? 0))} 筆診斷碼、{fmtNumber(Number(d.total_pcs ?? 0))} 筆處置碼。目前顯示分類清單，點選分類即可查看其下代碼，或直接搜尋。
        </>
      ) : null,
  },

  loinc: {
    searchPlaceholder: "搜尋 LOINC 碼、名稱、成分、檢體，例如 2345-7 或 glucose",
    perPage: 25,
    filters: [
      {
        key: "status",
        label: "狀態",
        kind: "select",
        defaultValue: "ACTIVE",
        options: [
          { value: "ALL", label: "全部狀態" },
          { value: "ACTIVE", label: "ACTIVE" },
          { value: "TRIAL", label: "TRIAL" },
          { value: "DISCOURAGED", label: "DISCOURAGED" },
          { value: "DEPRECATED", label: "DEPRECATED" },
        ],
      },
      {
        key: "class",
        label: "類別",
        kind: "select",
        defaultValue: "",
        searchable: true,
        options: (d) => [{ value: "", label: "全部類別" }, ...strList(d?.classes).map((c) => ({ value: c, label: c }))],
      },
      ZH_FILTER,
      {
        key: "reference_filter",
        label: "參考區間",
        kind: "select",
        defaultValue: "all",
        options: [
          { value: "all", label: "全部" },
          { value: "with_reference", label: "有參考區間" },
          { value: "missing_reference", label: "無參考區間" },
        ],
      },
    ],
    columns: () => [
      { key: "loinc_num", header: "LOINC", render: (r) => mono(r.loinc_num), primary: true },
      {
        key: "name",
        header: "名稱",
        render: (r) => (
          <>
            {clamp(r.long_common_name, 2)}
            {str(r.name_zh) && (
              <Text fz="xs" c="dimmed" lineClamp={1}>
                {str(r.name_zh)}
              </Text>
            )}
          </>
        ),
      },
      { key: "class", header: "類別", render: (r) => mono(r.class), hideOnMobile: true },
      { key: "system", header: "檢體", render: (r) => clamp(r.system, 1), hideOnMobile: true },
      { key: "unit", header: "單位", render: (r) => clamp(r.unit, 1), hideOnMobile: true },
      { key: "ref", header: "參考區間", render: (r) => yesNo(r.has_reference_range) },
    ],
    rowKey: (r) => str(r.loinc_num),
    labels: {
      loinc_num: "LOINC 碼",
      long_common_name: "Long Common Name",
      shortname: "Short Name",
      name_zh: "中文名稱",
      common_name_zh: "中文通用名",
      consumer_name: "Consumer Name",
      class: "類別",
      classtype: "Class Type",
      status: "狀態",
      component: "成分 Component",
      property: "性質 Property",
      time_aspect: "時間 Time",
      system: "檢體 System",
      scale_type: "尺度 Scale",
      method_type: "方法 Method",
      specimen_type: "檢體類型",
      unit: "單位",
      has_reference_range: "有參考區間",
    },
    title: (r) => `${str(r.loinc_num)} ${str(r.long_common_name)}`,
  },

  snomed: {
    searchPlaceholder: "搜尋概念 ID、FSN 或偏好詞，例如 73211009 或 diabetes",
    perPage: 25,
    filters: [
      {
        key: "active",
        label: "狀態",
        kind: "segmented",
        defaultValue: "active",
        options: [
          { value: "active", label: "有效" },
          { value: "inactive", label: "已停用" },
          { value: "all", label: "全部" },
        ],
      },
      {
        key: "semantic_tag",
        label: "語意標籤",
        kind: "select",
        defaultValue: "",
        searchable: true,
        options: (d) => [{ value: "", label: "全部標籤" }, ...strList(d?.semantic_tags).map((t) => ({ value: t, label: t }))],
      },
      {
        key: "map_filter",
        label: "ICD-10 對應",
        kind: "select",
        defaultValue: "all",
        options: [
          { value: "all", label: "全部" },
          { value: "with_map", label: "有 ICD-10 對應" },
          { value: "missing_map", label: "無 ICD-10 對應" },
        ],
      },
    ],
    columns: () => [
      { key: "concept_id", header: "Concept ID", render: (r) => mono(r.concept_id), primary: true },
      {
        key: "term",
        header: "名稱",
        render: (r) => (
          <>
            {clamp(r.preferred_term || r.fsn_term, 1)}
            <Text fz="xs" c="dimmed" lineClamp={1}>
              {str(r.fsn_term)}
            </Text>
          </>
        ),
      },
      { key: "semantic_tag", header: "語意標籤", render: (r) => clamp(r.semantic_tag, 1), hideOnMobile: true },
      { key: "child_count", header: "子概念", render: (r) => fmtNumber(Number(r.child_count ?? 0)), align: "right", hideOnMobile: true },
      { key: "icd10_map_count", header: "ICD-10 對應", render: (r) => fmtNumber(Number(r.icd10_map_count ?? 0)), align: "right" },
    ],
    rowKey: (r) => str(r.concept_id),
    labels: {
      concept_id: "Concept ID",
      preferred_term: "偏好詞",
      fsn_term: "完整名稱（FSN）",
      semantic_tag: "語意標籤",
      active: "有效",
      language_code: "語言",
      effective_time: "生效日期",
      module_id: "Module ID",
      definition_status_id: "Definition Status",
      child_count: "子概念數",
      icd10_map_count: "ICD-10 對應數",
    },
    title: (r) => `${str(r.concept_id)} ${str(r.preferred_term) || str(r.fsn_term)}`,
  },

  rxnorm: {
    searchPlaceholder: "搜尋 RXCUI 或名稱，例如 metformin",
    perPage: 25,
    filters: [
      {
        key: "tty",
        label: "TTY",
        kind: "select",
        defaultValue: "",
        searchable: true,
        options: (d) => [
          { value: "", label: "全部 TTY" },
          ...((d?.tty_facets as PreviewRow[] | undefined) ?? []).map((f) => ({
            value: str(f.tty),
            label: `${str(f.tty)}（${fmtNumber(Number(f.count ?? 0))}）`,
          })),
        ],
      },
    ],
    columns: () => [
      { key: "rxcui", header: "RXCUI", render: (r) => mono(r.rxcui), primary: true },
      { key: "name", header: "名稱", render: (r) => clamp(r.name) },
      { key: "tty", header: "TTY", render: (r) => mono(r.tty) },
      { key: "suppress", header: "Suppress", render: (r) => mono(r.suppress), hideOnMobile: true },
    ],
    rowKey: (r, i) => `${str(r.rxcui)}-${str(r.tty)}-${i}`,
    labels: { rxcui: "RXCUI", name: "名稱", tty: "Term Type", suppress: "Suppress" },
    title: (r) => `${str(r.rxcui)} ${str(r.name)}`,
  },

  health_supplements: {
    searchPlaceholder: "搜尋品名、許可證字號、申請商或保健功效",
    perPage: 25,
    filters: [],
    columns: () => [
      { key: "permit_no", header: "許可證字號", render: (r) => mono(r.permit_no), primary: true },
      { key: "name", header: "品名", render: (r) => clamp(r.name) },
      { key: "applicant", header: "申請商", render: (r) => clamp(r.applicant, 1), hideOnMobile: true },
      { key: "category", header: "類別", render: (r) => clamp(r.category, 1), hideOnMobile: true },
      { key: "benefit_claims", header: "保健功效", render: (r) => clamp(r.benefit_claims), hideOnMobile: true },
    ],
    rowKey: (r) => str(r.permit_no),
    labels: {
      permit_no: "許可證字號",
      name: "品名",
      applicant: "申請商",
      benefit_claims: "保健功效",
      valid_from: "有效起日",
      valid_to: "有效迄日",
      category: "類別",
    },
    title: (r) => str(r.name),
  },

  food_nutrition: {
    searchPlaceholder: "搜尋樣品名稱、俗名或英文名",
    perPage: 25,
    filters: [
      {
        key: "mode",
        label: "資料",
        kind: "segmented",
        defaultValue: "foods",
        options: [
          { value: "foods", label: "食品" },
          { value: "ingredients", label: "食材" },
        ],
      },
    ],
    columns: (p) =>
      p.mode === "ingredients"
        ? [
            { key: "id", header: "ID", render: (r) => mono(r.id), primary: true },
            { key: "name_zh", header: "中文名稱", render: (r) => clamp(r.name_zh) },
            { key: "name_en", header: "英文名稱", render: (r) => clamp(r.name_en), hideOnMobile: true },
            { key: "major_category", header: "大類", render: (r) => clamp(r.major_category, 1) },
            { key: "sub_category", header: "子類", render: (r) => clamp(r.sub_category, 1), hideOnMobile: true },
          ]
        : [
            { key: "sample_name", header: "樣品名稱", render: (r) => clamp(r.sample_name, 1), primary: true },
            { key: "common_name", header: "俗名", render: (r) => clamp(r.common_name, 1) },
            { key: "english_name", header: "英文名稱", render: (r) => clamp(r.english_name, 1), hideOnMobile: true },
            { key: "food_category", header: "食品分類", render: (r) => clamp(r.food_category, 1), hideOnMobile: true },
            { key: "nutrient_count", header: "營養素數", render: (r) => fmtNumber(Number(r.nutrient_count ?? 0)), align: "right" },
          ],
    rowKey: (r, i) => str(r.id ?? r.sample_name) || String(i),
    labels: {
      sample_name: "樣品名稱",
      common_name: "俗名",
      english_name: "英文名稱",
      food_category: "食品分類",
      nutrient_count: "營養素數",
      id: "ID",
      name_zh: "中文名稱",
      name_en: "英文名稱",
      major_category: "大類",
      sub_category: "子類",
    },
    title: (r) => str(r.sample_name ?? r.name_zh),
  },
};

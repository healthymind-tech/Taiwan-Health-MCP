/**
 * Data hooks + local types for the per-module page (and reused by the IG page).
 * Every query uses a key from `qk` so WebSocket events refresh it automatically.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useJobs } from "@/lib/jobs";
import { ACTIVE_STATUSES, type ClearScope } from "@/lib/meta";
import type { EmbeddingModule, EmbeddingStatusPayload, JobSummary, Schedule, SourceVersion } from "@/lib/types";

// ── Clear (GET/POST /admin/api/modules/{key}/clear) ─────────────────────────
export interface ClearPreview {
  module_key: string;
  scopes: ClearScope[];
  data_rows: number;
  embedding_rows: number;
  source_files: number;
  source_bytes: number;
}

export interface ClearResult {
  ok: boolean;
  module_key: string;
  scope: ClearScope;
  before: ClearPreview;
  objects_removed: number;
}

export function useClearPreview(moduleKey: string, enabled = true) {
  return useQuery({
    queryKey: qk.moduleClear(moduleKey),
    queryFn: () => api.get<ClearPreview>(`/admin/api/modules/${moduleKey}/clear`),
    enabled,
    staleTime: 10_000,
  });
}

/** Invalidate everything a module mutation can change. */
export function useInvalidateModule(moduleKey: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.modules });
    void qc.invalidateQueries({ queryKey: qk.overview });
    void qc.invalidateQueries({ queryKey: qk.embedding });
    void qc.invalidateQueries({ queryKey: qk.moduleClear(moduleKey) });
    void qc.invalidateQueries({ queryKey: qk.moduleVersions(moduleKey) });
    void qc.invalidateQueries({ queryKey: ["preview", moduleKey] });
    void qc.invalidateQueries({ queryKey: qk.jobs });
    if (moduleKey === "ig") void qc.invalidateQueries({ queryKey: qk.igs });
  };
}

export function useClearModule(moduleKey: string) {
  const invalidate = useInvalidateModule(moduleKey);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scope: ClearScope) =>
      api.post<ClearResult>(`/admin/api/modules/${moduleKey}/clear`, { scope, confirm: moduleKey }),
    onSuccess: (_res, scope) => {
      // Reflect the clear immediately; the coverage COUNT(*) refetch can take seconds.
      if (scope === "sources") return;
      qc.setQueryData<EmbeddingStatusPayload>(qk.embedding, (prev) =>
        prev
          ? {
              ...prev,
              modules: prev.modules.map((m) =>
                m.key === moduleKey
                  ? { ...m, embedded: 0, last_embedded_at: "", ...(scope === "embeddings" ? {} : { total: 0 }) }
                  : m,
              ),
            }
          : prev,
      );
    },
    onSettled: invalidate,
  });
}

// ── Embedding status ──────────────────────────────────────────────────────────
export function useEmbeddingStatus(enabled = true) {
  return useQuery({
    queryKey: qk.embedding,
    queryFn: () => api.get<EmbeddingStatusPayload>("/admin/api/embedding/status"),
    enabled,
    staleTime: 15_000,
  });
}

export function findEmbeddingModule(data: EmbeddingStatusPayload | undefined, key: string): EmbeddingModule | null {
  return data?.modules.find((m) => m.key === key) ?? null;
}

/** Vectors are stale when the source rows changed after the last embed run. */
export function isEmbeddingStale(m: EmbeddingModule | null): boolean {
  if (!m || !m.last_source_updated_at || !m.last_embedded_at) return false;
  return new Date(m.last_source_updated_at).getTime() > new Date(m.last_embedded_at).getTime();
}

// ── Versions ──────────────────────────────────────────────────────────────────
export function useModuleVersions(moduleKey: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.moduleVersions(moduleKey),
    queryFn: () => api.get<{ module_key: string; versions: SourceVersion[] }>(`/admin/api/modules/${moduleKey}/versions`),
    enabled,
  });
}

// ── Schedule ──────────────────────────────────────────────────────────────────
export function useModuleSchedule(moduleKey: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.moduleSchedule(moduleKey),
    queryFn: () => api.get<{ schedule: Schedule | null }>(`/admin/api/modules/${moduleKey}/schedule`),
    enabled,
  });
}

// ── Jobs for one module ─────────────────────────────────────────────────────
export interface ModuleJobs {
  all: JobSummary[];
  active: JobSummary[];
  /** First active job of the given types (newest first, as the API orders them). */
  activeOf: (...types: (string | null | undefined)[]) => JobSummary | null;
  latestOf: (type: string | null | undefined, statuses?: string[]) => JobSummary | null;
  loading: boolean;
}

export function useModuleJobs(moduleKey: string): ModuleJobs {
  const q = useJobs();
  const all = (q.data?.jobs ?? []).filter((j) => j.module_key === moduleKey);
  const active = all.filter((j) => ACTIVE_STATUSES.has(j.status));
  return {
    all,
    active,
    activeOf: (...types) => active.find((j) => types.includes(j.job_type)) ?? null,
    latestOf: (type, statuses) =>
      type ? (all.find((j) => j.job_type === type && (!statuses || statuses.includes(j.status))) ?? null) : null,
    loading: q.isPending,
  };
}

// ── Required source roles (mirrors HEAVY_JOB_SOURCE_SPECS in adminJobs.ts) ────
// The catalog does not say which roles an import requires; createJob refuses with
// "Missing uploaded source(s)" unless every role listed here has a file.
export const REQUIRED_ROLES: Record<string, string[]> = {
  icd: ["icd10cm", "icd10pcs", "icd_zh_tw"],
  loinc: ["loinc", "loinc_taiwan_mapping", "loinc_reference_ranges"],
  snomed: ["snomed_ct"],
  rxnorm: ["rxnorm_full"],
};

/** zh-TW copy for each catalog role (the backend labels/descriptions are English). */
export const ROLE_COPY: Record<string, { label: string; description: string }> = {
  icd10cm: { label: "ICD-10-CM 診斷碼 ZIP", description: "CMS 發布的 ICD-10-CM 年度版本壓縮檔，匯入診斷碼。" },
  icd10pcs: { label: "ICD-10-PCS 處置碼 ZIP", description: "CMS 發布的 ICD-10-PCS 年度版本壓縮檔，匯入處置碼。" },
  icd_zh_tw: { label: "衛福部中英對照 XLSX", description: "衛福部 ICD-10 中英文對照 Excel，提供中文名稱。" },
  loinc: { label: "LOINC 主檔 ZIP", description: "Regenstrief 發布的 LOINC 完整版本壓縮檔。" },
  loinc_taiwan_mapping: { label: "台灣 LOINC 對照 CSV", description: "台灣在地中文名稱對照表。" },
  loinc_reference_ranges: { label: "參考區間 CSV", description: "依年齡 / 性別區分的檢驗參考區間。" },
  snomed_ct: { label: "SNOMED CT RF2 ZIP", description: "SNOMED International 國際版 RF2 發布檔。" },
  rxnorm_full: {
    label: "RxNorm Full Release ZIP",
    description: "RxNorm_full_<日期> 壓縮檔，只匯入概念（RXNCONSO.RRF），供 IG ValueSet 展開使用。",
  },
  ig: { label: "FHIR IG package.tgz", description: "FHIR NPM 套件；相依的 IG 會自動從 Registry 下載。" },
};

/** Clamp to a 0–100 percentage. */
export function pct(part: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

/**
 * Minimum rows before moduleStatus.ts registers a module's MCP tools
 * (REQUIREMENTS in node-server/src/moduleStatus.ts). `null` = no MCP tools.
 */
export const TOOL_THRESHOLDS: Record<string, { min: number; what: string } | null> = {
  icd: { min: 10_000, what: "ICD-10-CM 診斷碼" },
  loinc: { min: 1_000, what: "LOINC 概念" },
  snomed: { min: 100_000, what: "SNOMED CT 概念" },
  rxnorm: null,
  ig: { min: 1, what: "IG 套件" },
  health_supplements: { min: 10, what: "健康食品品項" },
  food_nutrition: { min: 10, what: "營養量測資料列" },
};

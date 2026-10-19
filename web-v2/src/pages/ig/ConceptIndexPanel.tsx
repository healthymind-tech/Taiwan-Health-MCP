import { useEffect, useState } from "react";
import { Alert, Badge, Button, FileButton, Group, Progress, SimpleGrid, Stack, Table, Text, Tooltip } from "@mantine/core";
import { IconArrowBackUp, IconRefresh, IconSearch, IconTrash, IconUpload, IconVectorTriangle } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { RelativeTime } from "@/components/RelativeTime";
import { notify } from "@/components/notify";
import { api, qs, request, uploadFile } from "@/lib/api";
import { fmtNumber } from "@/lib/format";
import { jobTypeLabel } from "@/lib/meta";

interface IndexJob {
  job_id: string;
  job_type: string;
  status: string;
  current_step: string | null;
  progress_current: number | null;
  progress_total: number | null;
  created_at: string;
  finished_at: string | null;
  summary: { rebuilt?: number | null; skipped?: number | null; codesystems?: number | null; bundled_supplements_applied?: string[] | null } | null;
}

interface IndexStatus {
  packages: Array<{ package_id: string; package_version: string; codesystems: number; concepts: number; terms: number; built_at: string }>;
  unindexed_packages: Array<{ package_id: string; version: string; codesystems?: number }>;
  packages_without_indexable_codesystems?: Array<{ package_id: string; version: string }>;
  embeddings: { embeddable_terms: number; vectors: number };
  thesaurus_entries: number;
  umls: { release: string; sabs: string[]; terms: number; concepts: number; source_file: string | null; loaded_at: string } | null;
  abbreviation_lexicon_entries?: number | null;
  abbreviation_lexicon?: {
    entries: number;
    source: "bundled" | "umls" | null;
    label: string | null;
    bundled_available: { file: string; release: string } | null;
  } | null;
  recent_jobs: IndexJob[];
}

interface Supplement {
  url: string;
  version: string;
  supplements: string;
  title: string | null;
  name: string | null;
  concept_count: number;
  origin: "upload" | "bundled" | "package";
  /** Same url+version as a supplement shipped with the code (whoever stored it). */
  bundled?: boolean;
  uploaded_by: string | null;
  package: string | null;
  uploaded_at: string | null;
  applied_to: string[];
}

/** A supplement shipped with the code (node-server/data/supplements) and its state here. */
interface BundledSupplement {
  url: string;
  version: string;
  supplements: string;
  title: string | null;
  name: string | null;
  concept_count: number;
  file: string;
  state: "applied" | "pending" | "opted_out" | "conflict" | "target_missing";
  other_versions?: string[];
  stored_by?: string;
}

const ACTIVE = new Set(["queued", "running", "paused", "retryable_failed"]);

/** zh label of an ig_concept_index step (adminJobs runIgConceptIndexJob). */
const STEP_ZH: Record<string, string> = {
  applying_bundled_data: "套用內建 supplement 與縮寫表",
  indexing_codesystems: "檢查 / 重建 CodeSystem",
  building_thesaurus: "重建縮寫與雙語詞庫",
  indexing: "建立索引",
};

/** One line describing a finished ig_concept_index job. */
function indexJobResult(j: IndexJob): string | null {
  if (j.status !== "success" || !j.summary) return null;
  const rebuilt = Number(j.summary.rebuilt ?? 0);
  const skipped = Number(j.summary.skipped ?? 0);
  const applied = j.summary.bundled_supplements_applied?.length ?? 0;
  const extra = applied ? `；套用 ${applied} 個內建 supplement` : "";
  return rebuilt === 0
    ? `索引已是最新（${fmtNumber(skipped)} 個 CodeSystem 未變更）${extra}`
    : `已重建 ${fmtNumber(rebuilt)} 個 CodeSystem，${fmtNumber(skipped)} 個未變更${extra}`;
}

const BUNDLED_STATE: Record<BundledSupplement["state"], { label: string; color: string; hint: string }> = {
  applied: { label: "已套用", color: "teal", hint: "" },
  pending: { label: "待套用", color: "blue", hint: "下次 IG 匯入或按「補建索引」時自動套用。" },
  opted_out: { label: "已移除", color: "gray", hint: "管理者刪除過，不會自動加回；按「還原」重新套用。" },
  conflict: { label: "未套用（版本衝突）", color: "amber", hint: "已有使用者上傳的其他版本，內建版本不覆蓋；要改用內建版本請先刪除上傳的版本。" },
  target_missing: { label: "等待 IG", color: "gray", hint: "尚未安裝含被補充 CodeSystem 的 IG；安裝後自動套用。" },
};

const KEY = ["igs", "~concept-index"] as const;
const SUP_KEY = ["igs", "~supplements"] as const;

/**
 * IG 術語搜尋索引: status of the concept-search index (fhir_normalize_code / search_medical_codes
 * system=…), its vectors, and the CodeSystem supplements merged into it (upload / delete).
 */
export function ConceptIndexPanel() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: KEY, queryFn: () => api.get<IndexStatus>("/admin/api/igs/concept-index"), refetchInterval: 15_000 });
  const sups = useQuery({
    queryKey: SUP_KEY,
    queryFn: () => api.get<{ supplements: Supplement[]; bundled?: BundledSupplement[] }>("/admin/api/igs/supplements"),
  });
  // The rebuild job this page queued: reported when it finishes.
  const [watchJob, setWatchJob] = useState<string | null>(null);

  const rebuild = useMutation({
    mutationFn: (force: boolean) => api.post<{ job_id: string }>("/admin/api/igs/concept-index/rebuild", { force }),
    onSuccess: (r) => {
      notify.info("已排入索引工作：先套用內建資料，再檢查每個 CodeSystem（未變更者略過），完成後會在此顯示結果。");
      setWatchJob(r.job_id);
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => notify.error(e),
  });

  const restore = useMutation({
    mutationFn: (url: string | null) =>
      api.post<{ restored: string[]; reindex_job: string | null; warning?: string }>("/admin/api/igs/supplements/bundled/restore", url ? { url } : {}),
    onSuccess: (r) => {
      notify.success(
        r.restored.length
          ? `已還原 ${r.restored.length} 個內建 supplement${r.reindex_job ? "，已排入索引工作套用" : ""}`
          : "沒有需要還原的內建 supplement",
      );
      if (r.warning) notify.warn(r.warning);
      if (r.reindex_job) setWatchJob(r.reindex_job);
      void qc.invalidateQueries({ queryKey: SUP_KEY });
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => notify.error(e, "還原失敗"),
  });

  const upload = useMutation({
    mutationFn: async (file: File) =>
      request<{ supplement: { url: string; concept_count: number }; reindex_job: string | null; warning?: string }>("/admin/api/igs/supplements", {
        method: "POST",
        // Not application/json: the backend reads the raw body (supplements can exceed the 4 MB JSON cap).
        headers: { "Content-Type": "application/fhir+json" },
        rawBody: file,
      }),
    onSuccess: (r) => {
      notify.success(`已上傳 supplement（${fmtNumber(r.supplement.concept_count)} 個概念）${r.reindex_job ? "，已排入索引重建" : ""}`);
      if (r.warning) notify.warn(r.warning);
      void qc.invalidateQueries({ queryKey: SUP_KEY });
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => notify.error(e, "上傳失敗"),
  });

  const remove = useMutation({
    mutationFn: (s: Supplement) =>
      api.del<{ bundled_opt_out?: boolean; reindex_job: string | null }>(`/admin/api/igs/supplements${qs({ url: s.url, version: s.version })}`),
    onSuccess: (r) => {
      notify.success(
        r.bundled_opt_out
          ? "已刪除內建 supplement，之後匯入 IG 也不會自動加回（可按「還原」恢復）；已排入索引重建"
          : "已刪除 supplement，已排入索引重建",
      );
      void qc.invalidateQueries({ queryKey: SUP_KEY });
    },
    onError: (e) => notify.error(e),
  });

  const umlsUpload = useMutation({
    mutationFn: async (file: File) => {
      await uploadFile<unknown>(
        "/admin/api/uploads" + qs({ module_key: "ig", source_role: "umls_metathesaurus", filename: file.name, auto_activate: true }),
        file,
      );
      return api.post<{ job: { job_id: string } }>("/admin/api/jobs", { module_key: "ig", job_type: "umls_import" });
    },
    onSuccess: () => {
      notify.success("已上傳 UMLS 檔並排入 umls_import，完成後會自動重建索引。");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => notify.error(e, "UMLS 匯入失敗"),
  });

  const st = status.data;
  const indexJobs = (st?.recent_jobs ?? []).filter((j) => j.job_type === "ig_concept_index");
  const activeIndexJob = indexJobs.find((j) => ACTIVE.has(j.status)) ?? null;
  const lastIndexJob = indexJobs.find((j) => !ACTIVE.has(j.status)) ?? null;
  const lastResult = lastIndexJob ? indexJobResult(lastIndexJob) : null;
  const bundled = sups.data?.bundled ?? [];
  const optedOut = bundled.filter((b) => b.state === "opted_out");
  const notStored = bundled.filter((b) => b.state !== "applied");
  const lex = st?.abbreviation_lexicon ?? null;

  // Poll faster while an index job runs; report the job this page queued when it ends.
  const { refetch } = status;
  useEffect(() => {
    if (!activeIndexJob) return;
    const t = window.setInterval(() => void refetch(), 3000);
    return () => window.clearInterval(t);
  }, [activeIndexJob, refetch]);
  useEffect(() => {
    if (!watchJob) return;
    const j = indexJobs.find((x) => x.job_id === watchJob);
    if (!j || ACTIVE.has(j.status)) return;
    setWatchJob(null);
    void qc.invalidateQueries({ queryKey: SUP_KEY });
    if (j.status === "success") notify.success(indexJobResult(j) ?? "索引工作完成");
    else notify.warn(`索引工作結束狀態：${j.status}。請到「背景工作」查看該工作的日誌。`);
  }, [watchJob, indexJobs, qc]);
  const totals = (st?.packages ?? []).reduce((a, p) => ({ cs: a.cs + p.codesystems, concepts: a.concepts + p.concepts, terms: a.terms + p.terms }), { cs: 0, concepts: 0, terms: 0 });
  const emb = st?.embeddings ?? { embeddable_terms: 0, vectors: 0 };
  const embPct = emb.embeddable_terms ? Math.min(100, (100 * emb.vectors) / emb.embeddable_terms) : 0;

  return (
    <Stack gap="lg">
      <SectionCard
        title="術語搜尋索引"
        icon={<IconSearch size={18} />}
        description="fhir_normalize_code 與 search_medical_codes(system=…) 以此索引從中英文自由文字找 IG CodeSystem 代碼（例如健保支付標準代碼）。索引含所有語言的 designation、supplement 與 ConceptMap 連結的名稱；IG 匯入後自動建立。"
        actions={
          <Group gap="xs">
            <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} loading={rebuild.isPending} onClick={() => rebuild.mutate(false)}>
              補建索引
            </Button>
            <Tooltip label="忽略已建立的索引，全部重建（較久）">
              <Button size="xs" variant="subtle" color="gray" loading={rebuild.isPending} onClick={() => rebuild.mutate(true)}>
                全部重建
              </Button>
            </Tooltip>
          </Group>
        }
      >
        <Stack gap="md" px="lg" pb="lg">
          <SimpleGrid cols={{ base: 2, md: 4 }}>
            <StatCard label="已索引 CodeSystem" value={fmtNumber(totals.cs)} loading={status.isPending} />
            <StatCard label="概念" value={fmtNumber(totals.concepts)} loading={status.isPending} />
            <StatCard label="搜尋詞" value={fmtNumber(totals.terms)} loading={status.isPending} />
            <StatCard label="縮寫展開（SNOMED / LOINC）" value={fmtNumber(st?.thesaurus_entries ?? 0)} loading={status.isPending} />
          </SimpleGrid>
          <Stack gap={4}>
            <Group justify="space-between">
              <Group gap={6}>
                <IconVectorTriangle size={16} />
                <Text fz="sm">語意向量</Text>
              </Group>
              <Text fz="sm" c="dimmed">
                {fmtNumber(emb.vectors)} / {fmtNumber(emb.embeddable_terms)}
              </Text>
            </Group>
            <Progress value={embPct} />
            {emb.embeddable_terms > 0 && embPct < 95 && (
              <Text fz="xs" c="dimmed">
                向量未完成時搜尋會標示 search_mode=keyword_only（僅字詞比對）。超過 20,000 個概念的 CodeSystem 只建字詞索引。
              </Text>
            )}
          </Stack>
          {activeIndexJob && (
            <Stack gap={4}>
              <Group justify="space-between">
                <Text fz="sm">
                  索引工作進行中：{STEP_ZH[activeIndexJob.current_step ?? ""] ?? (activeIndexJob.status === "queued" ? "等待工作程序接手" : activeIndexJob.current_step ?? "")}
                </Text>
                {Number(activeIndexJob.progress_total) > 0 && (
                  <Text fz="sm" c="dimmed">
                    CodeSystem {fmtNumber(Number(activeIndexJob.progress_current ?? 0))} / {fmtNumber(Number(activeIndexJob.progress_total))}
                  </Text>
                )}
              </Group>
              <Progress
                value={Number(activeIndexJob.progress_total) > 0 ? (100 * Number(activeIndexJob.progress_current ?? 0)) / Number(activeIndexJob.progress_total) : 100}
                striped
                animated
              />
            </Stack>
          )}
          {!activeIndexJob && lastResult && (
            <Text fz="sm" c="dimmed">
              上次索引工作（<RelativeTime value={lastIndexJob!.finished_at ?? lastIndexJob!.created_at} fz="sm" c="dimmed" />）：{lastResult}
            </Text>
          )}
          {(st?.unindexed_packages.length ?? 0) > 0 && (
            <Alert color="amber" variant="light">
              {st!.unindexed_packages.length} 個套件尚未建立索引：
              {st!.unindexed_packages.map((p) => `${p.package_id}@${p.version}`).join("、")}。按「補建索引」建立。
            </Alert>
          )}
          {(st?.packages_without_indexable_codesystems?.length ?? 0) > 0 && (
            <Tooltip
              label={st!.packages_without_indexable_codesystems!.map((p) => `${p.package_id}@${p.version}`).join("\n")}
              multiline
              maw={420}
            >
              <Text fz="xs" c="dimmed" style={{ alignSelf: "flex-start" }}>
                另有 {st!.packages_without_indexable_codesystems!.length} 個套件沒有可索引的 CodeSystem（只含 profile 等，或其 CodeSystem 由
                ICD / LOINC / SNOMED 專用表處理、content = not-present），不需建立索引。
              </Text>
            </Tooltip>
          )}
          {(st?.recent_jobs.length ?? 0) > 0 && (
            <Group gap="xs">
              {st!.recent_jobs.slice(0, 4).map((j) => (
                <Badge key={j.job_id} variant="light" color={j.status === "success" ? "teal" : j.status === "running" || j.status === "queued" ? "blue" : "red"}>
                  {jobTypeLabel(j.job_type)}：{j.status}
                </Badge>
              ))}
            </Group>
          )}
        </Stack>
      </SectionCard>

      <SectionCard
        title="UMLS 同義字（選用）"
        icon={<IconVectorTriangle size={18} />}
        description="需 UMLS 授權。載入後，查詢與 IG 概念的英文名稱會以 UMLS 同義字 / 縮寫輔助比對（SRL 0 詞彙 + SNOMEDCT_US）；UMLS 字串不會出現在工具輸出。請上傳以 node dist/loaders/umls.js --subset 產生的精簡檔（.rrf.gz），或只含 MRCONSO / MRSAB 的 zip。產生精簡檔時可再加上 SPECIALIST Lexicon 的 LRABR 檔（縮寫表），查詢中 CodeSystem 與詞庫都不認得的縮寫會依此展開。"
        actions={
          <FileButton onChange={(f) => f && umlsUpload.mutate(f)} accept=".gz,.zip">
            {(props) => (
              <Button size="xs" variant="default" leftSection={<IconUpload size={14} />} loading={umlsUpload.isPending} {...props}>
                上傳並匯入 UMLS
              </Button>
            )}
          </FileButton>
        }
      >
        <Text fz="sm" px="lg" pb="lg" c={st?.umls ? undefined : "dimmed"}>
          {st?.umls
            ? `已載入 ${st.umls.release}：${fmtNumber(st.umls.terms)} 個字串 / ${fmtNumber(st.umls.concepts)} 個概念，來自 ${st.umls.sabs.length} 個來源詞彙（${st.umls.source_file ?? ""}）。`
            : "未載入（搜尋照常運作，只是沒有 UMLS 同義字）。"}
          {lex && lex.entries > 0
            ? ` 縮寫表（SPECIALIST LRABR）：${fmtNumber(lex.entries)} 筆，來源：${lex.source === "bundled" ? `內建（${lex.label ?? ""}，不需 UMLS 授權）` : "上傳的 UMLS 檔"}。`
            : lex && lex.bundled_available
              ? ` 縮寫表尚未載入：下次 IG 匯入或「補建索引」時會自動載入內建的 LRABR（${lex.bundled_available.release}）。`
              : st?.abbreviation_lexicon_entries
                ? ` 縮寫表（LRABR）：${fmtNumber(st.abbreviation_lexicon_entries)} 筆。`
                : ""}
        </Text>
      </SectionCard>

      <SectionCard
        title="CodeSystem supplements"
        icon={<IconUpload size={18} />}
        description="上傳 FHIR R4 CodeSystem supplement JSON（content = supplement）。其 designation（例如英文名稱）與 property 會合併進被補充 CodeSystem 的搜尋索引；不改變驗證結果。標示「內建」者隨程式提供（健保開放資料等），安裝對應 IG 時自動套用；刪除後不會自動加回，可再還原。"
        actions={
          <Group gap="xs">
          {optedOut.length > 0 && (
            <Tooltip label={optedOut.map((b) => b.title || b.url).join("\n")} multiline maw={420}>
              <Button
                size="xs"
                variant="default"
                leftSection={<IconArrowBackUp size={14} />}
                loading={restore.isPending && restore.variables === null}
                onClick={() => restore.mutate(null)}
              >
                還原內建 supplement（{optedOut.length}）
              </Button>
            </Tooltip>
          )}
          <FileButton onChange={(f) => f && upload.mutate(f)} accept=".json,application/json,application/fhir+json">
            {(props) => (
              <Button size="xs" leftSection={<IconUpload size={14} />} loading={upload.isPending} {...props}>
                上傳 CodeSystem supplement JSON
              </Button>
            )}
          </FileButton>
          </Group>
        }
        flush
      >
        {notStored.length > 0 && (
          <Stack gap={6} px="lg" pb="md">
            <Text fz="sm" fw={500}>
              內建 supplement（尚未在資料庫中）
            </Text>
            {notStored.map((b) => {
              const meta = BUNDLED_STATE[b.state];
              return (
                <Group key={`${b.url}|${b.version}`} justify="space-between" wrap="nowrap" gap="sm">
                  <Stack gap={0} style={{ minWidth: 0 }}>
                    <Group gap={6}>
                      <Badge variant="light" color="grape">
                        內建
                      </Badge>
                      <Text fz="sm">{b.title || b.name || b.url}</Text>
                      <Badge variant="light" color={meta.color}>
                        {meta.label}
                      </Badge>
                    </Group>
                    <Text fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
                      {b.url} | {b.version} → {b.supplements}（{fmtNumber(b.concept_count)} 個概念）
                      {b.other_versions?.length ? `；已上傳版本：${b.other_versions.join("、")}` : ""}
                    </Text>
                    <Text fz="xs" c="dimmed">
                      {meta.hint}
                    </Text>
                  </Stack>
                  {b.state === "opted_out" && (
                    <Button
                      size="xs"
                      variant="subtle"
                      leftSection={<IconArrowBackUp size={14} />}
                      loading={restore.isPending && restore.variables === b.url}
                      onClick={() => restore.mutate(b.url)}
                    >
                      還原
                    </Button>
                  )}
                </Group>
              );
            })}
          </Stack>
        )}
        {sups.data && sups.data.supplements.length === 0 ? (
          <Text c="dimmed" fz="sm" px="lg" pb="lg">
            尚無 supplement。
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={720}>
            <Table verticalSpacing="sm" horizontalSpacing="lg">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Supplement</Table.Th>
                  <Table.Th>補充的 CodeSystem</Table.Th>
                  <Table.Th ta="right">概念</Table.Th>
                  <Table.Th>來源</Table.Th>
                  <Table.Th>已套用</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(sups.data?.supplements ?? []).map((s) => (
                  <Table.Tr key={`${s.origin}|${s.package}|${s.url}|${s.version}`}>
                    <Table.Td>
                      <Text fz="sm" fw={500}>
                        {s.title || s.name || s.url}
                      </Text>
                      <Text fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
                        {s.url}
                        {s.version ? ` | ${s.version}` : ""}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text fz="xs" style={{ wordBreak: "break-all" }}>
                        {s.supplements}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">{fmtNumber(s.concept_count)}</Table.Td>
                    <Table.Td>
                      {s.origin !== "package" ? (
                        <Stack gap={2}>
                          <Group gap={4}>
                            {s.bundled && (
                              <Tooltip label="與程式內建的 supplement 相同（url + version）">
                                <Badge variant="light" color="grape">
                                  內建
                                </Badge>
                              </Tooltip>
                            )}
                            {s.origin === "upload" && <Badge variant="light">上傳{s.uploaded_by ? `：${s.uploaded_by}` : ""}</Badge>}
                          </Group>
                          <RelativeTime value={s.uploaded_at} fz="xs" c="dimmed" />
                        </Stack>
                      ) : (
                        <Badge variant="light" color="gray">
                          {s.package}
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {s.applied_to.length ? (
                        <Tooltip label={s.applied_to.join("\n")} multiline maw={420}>
                          <Badge color="teal" variant="light">
                            {s.applied_to.length} 個套件版本
                          </Badge>
                        </Tooltip>
                      ) : (
                        <Badge color="gray" variant="light">
                          尚未套用
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {s.origin !== "package" && (
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          loading={remove.isPending && remove.variables === s}
                          onClick={() => {
                            const msg = s.bundled
                              ? `刪除內建 supplement ${s.title || s.url}？\n刪除後之後匯入 IG 也不會自動加回，需要時可按「還原」。`
                              : `刪除 supplement ${s.url}？`;
                            if (window.confirm(msg)) remove.mutate(s);
                          }}
                        >
                          刪除
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </SectionCard>
    </Stack>
  );
}

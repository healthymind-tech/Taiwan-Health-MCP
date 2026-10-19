import { Alert, Badge, Button, FileButton, Group, Progress, SimpleGrid, Stack, Table, Text, Tooltip } from "@mantine/core";
import { IconRefresh, IconSearch, IconTrash, IconUpload, IconVectorTriangle } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { RelativeTime } from "@/components/RelativeTime";
import { notify } from "@/components/notify";
import { api, qs, request, uploadFile } from "@/lib/api";
import { fmtNumber } from "@/lib/format";
import { jobTypeLabel } from "@/lib/meta";

interface IndexStatus {
  packages: Array<{ package_id: string; package_version: string; codesystems: number; concepts: number; terms: number; built_at: string }>;
  unindexed_packages: Array<{ package_id: string; version: string }>;
  embeddings: { embeddable_terms: number; vectors: number };
  thesaurus_entries: number;
  umls: { release: string; sabs: string[]; terms: number; concepts: number; source_file: string | null; loaded_at: string } | null;
  abbreviation_lexicon_entries?: number | null;
  recent_jobs: Array<{ job_id: string; job_type: string; status: string; created_at: string; finished_at: string | null }>;
}

interface Supplement {
  url: string;
  version: string;
  supplements: string;
  title: string | null;
  name: string | null;
  concept_count: number;
  origin: "upload" | "package";
  package: string | null;
  uploaded_at: string | null;
  applied_to: string[];
}

const KEY = ["igs", "~concept-index"] as const;
const SUP_KEY = ["igs", "~supplements"] as const;

/**
 * IG 術語搜尋索引: status of the concept-search index (fhir_normalize_code / search_medical_codes
 * system=…), its vectors, and the CodeSystem supplements merged into it (upload / delete).
 */
export function ConceptIndexPanel() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: KEY, queryFn: () => api.get<IndexStatus>("/admin/api/igs/concept-index"), refetchInterval: 15_000 });
  const sups = useQuery({ queryKey: SUP_KEY, queryFn: () => api.get<{ supplements: Supplement[] }>("/admin/api/igs/supplements") });

  const rebuild = useMutation({
    mutationFn: (force: boolean) => api.post<{ job_id: string }>("/admin/api/igs/concept-index/rebuild", { force }),
    onSuccess: () => {
      notify.success("已排入索引重建工作，完成後會自動進行向量嵌入。");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => notify.error(e),
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
    mutationFn: (s: Supplement) => api.del<unknown>(`/admin/api/igs/supplements${qs({ url: s.url, version: s.version })}`),
    onSuccess: () => {
      notify.success("已刪除 supplement，已排入索引重建");
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
          {(st?.unindexed_packages.length ?? 0) > 0 && (
            <Alert color="amber" variant="light">
              {st!.unindexed_packages.length} 個套件尚未建立索引：
              {st!.unindexed_packages.map((p) => `${p.package_id}@${p.version}`).join("、")}。按「補建索引」建立。
            </Alert>
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
          {st?.abbreviation_lexicon_entries ? ` 縮寫表（LRABR）：${fmtNumber(st.abbreviation_lexicon_entries)} 筆。` : ""}
        </Text>
      </SectionCard>

      <SectionCard
        title="CodeSystem supplements"
        icon={<IconUpload size={18} />}
        description="上傳 FHIR R4 CodeSystem supplement JSON（content = supplement）。其 designation（例如英文名稱）與 property 會合併進被補充 CodeSystem 的搜尋索引；不改變驗證結果。"
        actions={
          <FileButton onChange={(f) => f && upload.mutate(f)} accept=".json,application/json,application/fhir+json">
            {(props) => (
              <Button size="xs" leftSection={<IconUpload size={14} />} loading={upload.isPending} {...props}>
                上傳 CodeSystem supplement JSON
              </Button>
            )}
          </FileButton>
        }
        flush
      >
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
                      {s.origin === "upload" ? (
                        <Stack gap={0}>
                          <Badge variant="light">上傳</Badge>
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
                      {s.origin === "upload" && (
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          loading={remove.isPending && remove.variables === s}
                          onClick={() => {
                            if (window.confirm(`刪除 supplement ${s.url}？`)) remove.mutate(s);
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

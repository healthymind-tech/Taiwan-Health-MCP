import { Alert, Anchor, Box, Button, Card, Group, SegmentedControl, SimpleGrid, Stack, Switch, Text, Tooltip } from "@mantine/core";
import {
  IconAlertTriangle,
  IconPill,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
  IconTimeline,
  IconTool,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { PageSkeleton } from "@/components/QueryBoundary";
import { SectionCard } from "@/components/SectionCard";
import { JobStatusBadge } from "@/components/StatusBadge";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import { useModulesCatalog } from "@/layout/AppLayout";
import { api } from "@/lib/api";
import { fmtDateTime, fmtNumber, fmtRelative, shortId } from "@/lib/format";
import { useActiveJobs } from "@/lib/jobs";
import { jobTypeLabel } from "@/lib/meta";
import { qk } from "@/lib/queryKeys";
import type { JobSummary } from "@/lib/types";
import { DrugSchedule } from "./DrugSchedule";
import { IndexUploads } from "./IndexUploads";
import { PipelineCharts, PipelineKpis } from "./PipelineOverview";
import { RunJobModal, type RunJobPreset } from "./RunJobModal";
import { DRUG_JOB_TYPES, DRUG_MODULE_KEY, DRUG_SOURCE_ROLE, drugDetailPath, eventStageLabel } from "./drugMeta";
import type { DrugAdminStatus, DrugJobSnapshot, DrugPipelineStatus, DrugRecentEvent } from "./drugTypes";
import { ActiveJobInline, DrugStatusBadge } from "./drugUi";

export default function DrugPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const modulesQ = useModulesCatalog();
  const activeJobs = useActiveJobs();
  const [runPreset, setRunPreset] = useState<RunJobPreset | null>(null);

  const pipelineQ = useQuery({
    queryKey: qk.drugPipeline,
    queryFn: () => api.get<DrugPipelineStatus>("/admin/api/drug/pipeline-status"),
    refetchInterval: 30_000,
  });
  const statusQ = useQuery({
    queryKey: qk.drugStatus,
    queryFn: () => api.get<DrugAdminStatus>("/admin/api/drug/status?per_page=1"),
    refetchInterval: 30_000,
  });

  const activeDrugJobs = DRUG_JOB_TYPES.map((t) => activeJobs.get(t)).filter((j): j is JobSummary => Boolean(j));
  const drugJobActive = activeDrugJobs.length > 0;

  const catalog = modulesQ.data;
  const entry = catalog?.modules.find((m) => m.module_key === DRUG_MODULE_KEY && m.source_role === DRUG_SOURCE_ROLE);
  const maintenance = Boolean(catalog?.maintenance?.[DRUG_MODULE_KEY]);
  const recordCount = catalog?.record_counts?.[DRUG_MODULE_KEY] ?? entry?.cumulative_total ?? pipelineQ.data?.index.total_licenses ?? 0;
  const populated = recordCount > 0;
  const storage = catalog?.storage;

  const toggleMaintenance = useMutation({
    mutationFn: (enabled: boolean) => api.post("/admin/api/module-maintenance", { module_key: DRUG_MODULE_KEY, enabled }),
    onSuccess: (_d, enabled) => {
      void qc.invalidateQueries({ queryKey: qk.modules });
      void qc.invalidateQueries({ queryKey: qk.overview });
      notify.success(enabled ? "藥品模組已進入維護模式" : "藥品模組已恢復服務");
    },
    onError: (e) => notify.error(e, "切換維護模式失敗"),
  });

  const onMaintenance = (enabled: boolean) => {
    if (!enabled) {
      toggleMaintenance.mutate(false);
      return;
    }
    confirmAction({
      title: "開啟藥品維護模式？",
      message: "適合在大量匯入或資料修正期間使用。",
      consequences: [
        "後台會把藥品模組標示為維護中，提醒其他管理者正在處理資料",
        "注意：目前 MCP 工具尚未讀取這個標示，search_drug 等工具仍會照常回應",
        "背景工作不受影響，仍會繼續執行",
        "完成後記得關閉，工具才會恢復服務",
      ],
      confirmLabel: "開啟維護模式",
      onConfirm: () => toggleMaintenance.mutateAsync(true),
    });
  };

  const p = pipelineQ.data;
  const queuePending = p?.pipeline.queue_pending ?? 0;
  const queueFailed = p?.pipeline.queue_failed ?? 0;
  const runDisabledReason = !populated
    ? "請先上傳並匯入許可證索引 CSV"
    : drugJobActive
      ? "已有藥品工作在執行中；請等它完成，或先暫停／停止"
      : null;

  if (modulesQ.isPending && pipelineQ.isPending) {
    return (
      <>
        <PageHeader title="藥品管線" icon={<IconPill size={24} />} breadcrumbs={[{ label: "資料模組" }, { label: "藥品" }]} />
        <PageSkeleton rows={5} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="藥品管線"
        icon={<IconPill size={24} />}
        breadcrumbs={[{ label: "資料模組" }, { label: "藥品" }]}
        description="管理食藥署藥品資料：許可證索引匯入、TFDA 仿單與外觀圖爬取、MinerU OCR 與 LLM 結構化分析。"
        badge={
          maintenance ? (
            <Tooltip label="藥品 MCP 工具目前回應「服務維護中」">
              <Box>
                <JobStatusBadge status="paused" />
              </Box>
            </Tooltip>
          ) : undefined
        }
        actions={
          <>
            <Tooltip label={maintenance ? "關閉後藥品工具恢復服務" : "暫停藥品 MCP 工具的對外服務"}>
              <Box>
                <Switch
                  label="維護模式"
                  color="amber"
                  checked={maintenance}
                  disabled={toggleMaintenance.isPending || modulesQ.isPending}
                  onChange={(e) => onMaintenance(e.currentTarget.checked)}
                />
              </Box>
            </Tooltip>
            <Button component={Link} to="/drug/explorer" leftSection={<IconSearch size={16} />}>
              開啟藥品瀏覽器
            </Button>
          </>
        }
      />

      <Stack gap="lg">
        {maintenance && (
          <Alert color="amber" variant="light" icon={<IconTool size={18} />} title="維護模式已開啟">
            藥品模組已標示為維護中。此標示目前只在管理後台生效，MCP 工具仍照常回應；資料處理完成後請關閉。
          </Alert>
        )}
        {storage && !storage.minio_enabled && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="物件儲存（MinIO）無法使用">
            {storage.detail || "未設定或連線失敗"}。上傳 CSV、儲存仿單與圖片都需要物件儲存，請至「系統設定」檢查 MinIO。
          </Alert>
        )}

        {activeDrugJobs.length > 0 && (
          <Stack gap="sm">
            {activeDrugJobs.map((j) => (
              <ActiveJobInline key={j.job_id} job={j} />
            ))}
          </Stack>
        )}

        {pipelineQ.isError ? (
          <Card>
            <ErrorState error={pipelineQ.error} onRetry={() => void pipelineQ.refetch()} title="無法載入管線狀態" />
          </Card>
        ) : (
          <PipelineKpis p={p} status={statusQ.data} loading={pipelineQ.isPending} />
        )}

        <SectionCard
          title="執行管線"
          icon={<IconPlayerPlay size={18} />}
          description="處理待處理佇列中的許可證：爬取 TFDA → 存檔 → OCR → LLM 分析 → 正規化。每批預設 200 張，成功後自動接續下一批。"
        >
          <Stack gap="md">
            <Group gap="sm" wrap="wrap">
              <Tooltip label={runDisabledReason ?? "設定批次上限與選項後開始"} disabled={!runDisabledReason}>
                <Box>
                  <Button
                    leftSection={<IconPlayerPlay size={16} />}
                    disabled={Boolean(runDisabledReason)}
                    onClick={() => setRunPreset({})}
                  >
                    執行管線{queuePending ? `（待處理 ${fmtNumber(queuePending)}）` : ""}
                  </Button>
                </Box>
              </Tooltip>
              <Tooltip label={runDisabledReason ?? (queueFailed === 0 ? "目前沒有失敗的許可證" : "重新處理失敗的許可證")}>
                <Box>
                  <Button
                    variant="light"
                    color="orange"
                    leftSection={<IconRefresh size={16} />}
                    disabled={Boolean(runDisabledReason) || queueFailed === 0}
                    onClick={() => setRunPreset({ retryFailed: true })}
                  >
                    重試失敗{queueFailed ? `（${fmtNumber(queueFailed)}）` : ""}
                  </Button>
                </Box>
              </Tooltip>
            </Group>
            {p && <LastJobs p={p} />}
          </Stack>
        </SectionCard>

        <PipelineCharts p={p} status={statusQ.data} />

        <IndexUploads
          entry={entry}
          maxUploadMb={catalog?.upload_limits.max_upload_mb ?? 512}
          drugJobActive={drugJobActive}
          onImport={(file) => setRunPreset({ file })}
        />

        <RecentEvents events={statusQ.data?.recent_events} loading={statusQ.isPending} error={statusQ.error} onRetry={() => void statusQ.refetch()} onOpen={(id) => navigate(drugDetailPath(id))} />

        <DrugSchedule />
      </Stack>

      <RunJobModal
        opened={runPreset !== null}
        onClose={() => setRunPreset(null)}
        preset={runPreset ?? {}}
        queuePending={queuePending}
        queueFailed={queueFailed}
      />
    </>
  );
}

function LastJobs({ p }: { p: DrugPipelineStatus }) {
  const rows: { label: string; job: DrugJobSnapshot; type: string }[] = [
    { label: "完整管線", job: p.pipeline.last_job, type: "drug_pipeline" },
    { label: "索引匯入", job: p.index.last_job, type: "drug_index_import" },
    { label: "爬取", job: p.enrichment.last_job, type: "drug_enrichment" },
    { label: "分析", job: p.analysis.last_job, type: "drug_analysis" },
  ].filter((r) => r.job.job_id);
  if (rows.length === 0) {
    return (
      <Text fz="sm" c="dimmed">
        尚未執行過任何藥品工作。
      </Text>
    );
  }
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
      {rows.map((r) => (
        <Group
          key={r.type}
          justify="space-between"
          wrap="nowrap"
          gap="xs"
          p="xs"
          style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8, minWidth: 0 }}
        >
          <Box style={{ minWidth: 0 }}>
            <Text fz="xs" c="dimmed">
              最近一次{r.label}
            </Text>
            <Group gap={6} wrap="wrap">
              <Anchor component={Link} to={`/jobs/${r.job.job_id}`} fz="sm" ff="monospace">
                {shortId(r.job.job_id)}
              </Anchor>
              <Tooltip label={fmtDateTime(r.job.updated_at)}>
                <Text fz="xs" c="dimmed">
                  {fmtRelative(r.job.updated_at || r.job.created_at)}
                </Text>
              </Tooltip>
            </Group>
          </Box>
          <Tooltip label={jobTypeLabel(r.type)}>
            <Box>
              <JobStatusBadge status={r.job.status} size="xs" />
            </Box>
          </Tooltip>
        </Group>
      ))}
    </SimpleGrid>
  );
}

function RecentEvents({
  events,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  events: DrugRecentEvent[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onOpen: (licenseId: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "failed">("all");
  const rows = useMemo(() => {
    const list = (events ?? []).map((e, i) => ({ ...e, _k: `${e.license_id}-${e.created_at}-${i}` }));
    return filter === "failed" ? list.filter((e) => /fail/.test(e.status) || e.error_message) : list;
  }, [events, filter]);
  const failedCount = (events ?? []).filter((e) => /fail/.test(e.status) || e.error_message).length;

  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: "license",
      header: "許可證",
      primary: true,
      render: (e) => (
        <Box style={{ minWidth: 0 }}>
          <Text fz="sm" fw={600} style={{ wordBreak: "break-all" }}>
            {e.name_zh || e.license_id}
          </Text>
          {e.name_zh && (
            <Text fz="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
              {e.license_id}
            </Text>
          )}
        </Box>
      ),
    },
    { key: "stage", header: "階段", nowrap: true, render: (e) => <Text fz="sm">{eventStageLabel(e.stage)}</Text> },
    { key: "status", header: "結果", nowrap: true, render: (e) => <DrugStatusBadge status={e.status} size="xs" /> },
    {
      key: "error",
      header: "訊息",
      hideOnMobile: false,
      render: (e) =>
        e.error_message ? (
          <Tooltip label={e.error_message} multiline maw={420}>
            <Text fz="xs" c="red" lineClamp={2} maw={360} style={{ wordBreak: "break-word" }}>
              {e.error_message}
            </Text>
          </Tooltip>
        ) : (
          <Text fz="xs" c="dimmed">
            —
          </Text>
        ),
    },
    {
      key: "at",
      header: "時間",
      nowrap: true,
      render: (e) => (
        <Tooltip label={fmtDateTime(e.created_at, true)}>
          <Text fz="xs" c="dimmed">
            {fmtRelative(e.created_at)}
          </Text>
        </Tooltip>
      ),
    },
  ];

  return (
    <SectionCard
      title="最近處理紀錄"
      icon={<IconTimeline size={18} />}
      description="最近 100 筆各階段狀態變化。點擊一列查看該許可證的完整資料與處理歷程。"
      flush
      actions={
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(v) => setFilter(v as "all" | "failed")}
          data={[
            { value: "all", label: "全部" },
            { value: "failed", label: `僅失敗${failedCount ? ` ${failedCount}` : ""}` },
          ]}
        />
      }
    >
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(e) => e._k}
          loading={loading}
          pageSize={10}
          minWidth={760}
          onRowClick={(e) => e.license_id && onOpen(e.license_id)}
          empty={
            <EmptyState
              compact
              title={filter === "failed" ? "最近沒有失敗紀錄" : "還沒有處理紀錄"}
              description={filter === "failed" ? "最近 100 筆事件中沒有失敗。" : "執行管線後，各階段的狀態變化會顯示在這裡。"}
            />
          }
        />
      )}
    </SectionCard>
  );
}

import { Badge, Box, Button, Group, Stack, Tabs, Text, Tooltip } from "@mantine/core";
import {
  IconArrowLeft,
  IconExternalLink,
  IconFileAnalytics,
  IconFiles,
  IconInfoCircle,
  IconMessageChatbot,
  IconPill,
  IconRefresh,
  IconTimeline,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { CopyText } from "@/components/CopyText";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { PageSkeleton } from "@/components/QueryBoundary";
import { ApiError, api, qs } from "@/lib/api";
import { fmtRelative } from "@/lib/format";
import { useActiveJobs } from "@/lib/jobs";
import { qk } from "@/lib/queryKeys";
import type { DrugDetailsPayload } from "@/lib/types";
import { AssetViewerModal, type ViewerTarget } from "./AssetViewer";
import { DetailAnalysis } from "./DetailAnalysis";
import { DetailFiles } from "./DetailFiles";
import { DetailHistory } from "./DetailHistory";
import { DetailLlmCalls } from "./DetailLlmCalls";
import { DetailOverview } from "./DetailOverview";
import { RunJobModal } from "./RunJobModal";
import { DRUG_JOB_TYPES } from "./drugMeta";
import type { DrugPipelineStatus, ExplorerDetail } from "./drugTypes";
import { StageStrip, safeDecode } from "./drugUi";

const TABS = ["overview", "analysis", "files", "history", "llm"] as const;
type Tab = (typeof TABS)[number];

export default function DrugDetailPage() {
  const params = useParams();
  const licenseId = safeDecode(params.licenseId);
  const location = useLocation();
  const [sp, setSp] = useSearchParams();
  const tabParam = sp.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as Tab) : "overview";
  const fromSearch = (location.state as { from?: string } | null)?.from ?? "";
  const backTo = `/drug/explorer${fromSearch}`;
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [rerun, setRerun] = useState(false);
  const rerunPreset = useMemo(() => ({ licenseIds: [licenseId], retryFailed: true }), [licenseId]);
  const activeJobs = useActiveJobs();
  const drugJobActive = DRUG_JOB_TYPES.some((t) => activeJobs.has(t));

  const detailQ = useQuery({
    queryKey: qk.drugExplorerDetail(licenseId),
    queryFn: () => api.get<ExplorerDetail>(`/admin/api/drug/explorer-detail${qs({ license_id: licenseId })}`),
    enabled: Boolean(licenseId),
  });
  const detailsQ = useQuery({
    queryKey: qk.drugDetails(licenseId),
    queryFn: () => api.get<DrugDetailsPayload>(`/admin/api/drug/details${qs({ license_id: licenseId, include_cancelled: true })}`),
    enabled: Boolean(licenseId),
    retry: false,
  });
  const pipelineQ = useQuery({
    queryKey: qk.drugPipeline,
    queryFn: () => api.get<DrugPipelineStatus>("/admin/api/drug/pipeline-status"),
    enabled: rerun,
  });
  const llmQ = useQuery({
    queryKey: qk.drugLlmCalls(licenseId),
    queryFn: () => api.get<{ calls: unknown[] }>(`/admin/api/drug/llm-calls${qs({ license_id: licenseId })}`),
    enabled: Boolean(licenseId),
  });

  const crumbs = [
    { label: "藥品", to: "/drug" },
    { label: "瀏覽器", to: backTo },
    { label: licenseId || "—" },
  ];

  if (!licenseId) {
    return (
      <>
        <PageHeader title="藥品詳情" breadcrumbs={crumbs} />
        <EmptyState title="缺少許可證字號" action={<Button component={Link} to="/drug/explorer">返回瀏覽器</Button>} />
      </>
    );
  }
  if (detailQ.isPending) {
    return (
      <>
        <PageHeader title={licenseId} icon={<IconPill size={24} />} breadcrumbs={crumbs} />
        <PageSkeleton rows={5} />
      </>
    );
  }
  if (detailQ.isError) {
    const notFound = detailQ.error instanceof ApiError && detailQ.error.status === 404;
    return (
      <>
        <PageHeader title={licenseId} icon={<IconPill size={24} />} breadcrumbs={crumbs} />
        {notFound ? (
          <EmptyState
            icon={<IconPill size={28} />}
            title="找不到這張許可證"
            description={`「${licenseId}」不在目前的許可證索引中。可能字號有誤，或該許可證已從資料集下架。`}
            action={
              <Button component={Link} to={backTo} leftSection={<IconArrowLeft size={16} />}>
                返回瀏覽器
              </Button>
            }
          />
        ) : (
          <ErrorState error={detailQ.error} onRetry={() => void detailQ.refetch()} />
        )}
      </>
    );
  }

  const detail = detailQ.data;
  const d = detail.drug;
  const statuses = Object.fromEntries(
    ["index_status", "electronic_insert_status", "insert_pdf_status", "label_pdf_status", "shape_status", "storage_status", "ocr_status", "analysis_status", "normalize_status"].map((k) => [
      k,
      String(d[k] ?? "pending"),
    ]),
  );
  const isActive = d.is_active !== false;
  const llmCount = llmQ.data?.calls.length ?? 0;
  const imageCount = detail.appearances.reduce((n, a) => n + a.images.length, 0);
  const lastError = typeof d.last_error_message === "string" ? d.last_error_message : "";

  return (
    <>
      <PageHeader
        title={d.chinese_name || licenseId}
        icon={<IconPill size={24} />}
        breadcrumbs={crumbs}
        badge={
          <Badge color={isActive ? "teal" : "gray"} variant={isActive ? "light" : "outline"}>
            {isActive ? "有效" : "已註銷"}
          </Badge>
        }
        description={d.english_name || undefined}
        actions={
          <>
            <Button component={Link} to={backTo} variant="default" leftSection={<IconArrowLeft size={16} />}>
              返回
            </Button>
            {d.tfda_url && (
              <Button component="a" href={d.tfda_url} target="_blank" rel="noreferrer noopener" variant="default" leftSection={<IconExternalLink size={16} />}>
                TFDA 頁面
              </Button>
            )}
            <Tooltip label={drugJobActive ? "已有藥品工作在執行中，請等它完成" : "對這張許可證重新執行爬取與分析"}>
              <Box>
                <Button leftSection={<IconRefresh size={16} />} disabled={drugJobActive} onClick={() => setRerun(true)}>
                  重新處理
                </Button>
              </Box>
            </Tooltip>
          </>
        }
      />

      <Stack gap="md">
        <Group gap="md" wrap="wrap" px={2} mt={-8}>
          <Box style={{ minWidth: 0, maxWidth: "100%" }}>
            <CopyText value={licenseId} mono />
          </Box>
          <StageStrip statuses={statuses} />
          <Text fz="xs" c="dimmed">
            管線狀態更新於 {fmtRelative(typeof d.pipeline_updated_at === "string" ? d.pipeline_updated_at : null)}
          </Text>
          {lastError && (
            <Tooltip label={lastError} multiline maw={420}>
              <Text fz="xs" c="red" lineClamp={1} maw={480} style={{ wordBreak: "break-word" }}>
                最近錯誤：{lastError}
              </Text>
            </Tooltip>
          )}
        </Group>

        <Tabs
          value={tab}
          onChange={(v) => {
            const next = new URLSearchParams(sp);
            if (!v || v === "overview") next.delete("tab");
            else next.set("tab", v);
            setSp(next, { replace: true, state: location.state });
          }}
          keepMounted={false}
        >
          <Box style={{ overflowX: "auto", overflowY: "hidden" }} mb="md">
            <Tabs.List style={{ flexWrap: "nowrap", minWidth: "max-content" }}>
              <Tabs.Tab value="overview" leftSection={<IconInfoCircle size={16} />}>
                概覽
              </Tabs.Tab>
              <Tabs.Tab value="analysis" leftSection={<IconFileAnalytics size={16} />}>
                結構化分析
              </Tabs.Tab>
              <Tabs.Tab value="files" leftSection={<IconFiles size={16} />} rightSection={<CountBadge n={detail.documents.length + imageCount} />}>
                文件與圖片
              </Tabs.Tab>
              <Tabs.Tab value="history" leftSection={<IconTimeline size={16} />} rightSection={<CountBadge n={detail.timeline.events.length} />}>
                處理歷程
              </Tabs.Tab>
              <Tabs.Tab value="llm" leftSection={<IconMessageChatbot size={16} />} rightSection={<CountBadge n={llmCount} />}>
                LLM 呼叫紀錄
              </Tabs.Tab>
            </Tabs.List>
          </Box>

          <Tabs.Panel value="overview">
            <DetailOverview detail={detail} details={detailsQ.data} />
          </Tabs.Panel>
          <Tabs.Panel value="analysis">
            <DetailAnalysis
              detail={detail}
              onOpenOcr={(assetId) => setViewer({ assetId, kind: "markdown", title: "OCR 文字", subtitle: d.chinese_name ?? licenseId })}
              onOpenAnalysisJson={(assetId) => setViewer({ assetId, kind: "json", title: "LLM 分析原始輸出", subtitle: d.chinese_name ?? licenseId })}
            />
          </Tabs.Panel>
          <Tabs.Panel value="files">
            <DetailFiles licenseId={licenseId} detail={detail} onView={setViewer} />
          </Tabs.Panel>
          <Tabs.Panel value="history">
            <DetailHistory detail={detail} />
          </Tabs.Panel>
          <Tabs.Panel value="llm">
            <DetailLlmCalls licenseId={licenseId} />
          </Tabs.Panel>
        </Tabs>
      </Stack>

      <AssetViewerModal target={viewer} onClose={() => setViewer(null)} />
      <RunJobModal
        opened={rerun}
        onClose={() => setRerun(false)}
        preset={rerunPreset}
        queuePending={pipelineQ.data?.pipeline.queue_pending ?? 0}
        queueFailed={pipelineQ.data?.pipeline.queue_failed ?? 0}
      />
    </>
  );
}

function CountBadge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <Badge size="xs" variant="light" color="gray" circle={n < 10}>
      {n > 99 ? "99+" : n}
    </Badge>
  );
}

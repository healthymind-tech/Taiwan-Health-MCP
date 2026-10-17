import { Alert, Anchor, Badge, Button, SimpleGrid, Stack, Tabs, Text } from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBook2,
  IconCalendarTime,
  IconClockHour4,
  IconDatabase,
  IconHistory,
  IconPlugConnected,
  IconRoute,
  IconTable,
  IconTrash,
  IconVectorTriangle,
} from "@tabler/icons-react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { PageHeader } from "@/components/PageHeader";
import { PageSkeleton } from "@/components/QueryBoundary";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { StatCard } from "@/components/StatCard";
import { SectionCard } from "@/components/SectionCard";
import { RelativeTime } from "@/components/RelativeTime";
import { useModulesCatalog } from "@/layout/AppLayout";
import { fmtCompact, fmtNumber, fmtPercent, fmtRelative } from "@/lib/format";
import { MODULE_BY_KEY, type ModuleMeta } from "@/lib/meta";
import type { ModulesPayload } from "@/lib/types";
import { findEmbeddingModule, isEmbeddingStale, pct, TOOL_THRESHOLDS, useEmbeddingStatus, useModuleJobs } from "./moduleData";
import { SourcesSection, sourceReadiness } from "./SourcesSection";
import { ImportSection } from "./ImportSection";
import { EmbeddingSection } from "./EmbeddingSection";
import { TerminologyExplorer } from "@/pages/terminology/explorer/TerminologyExplorer";
import { ScheduleSection } from "./ScheduleSection";
import { DangerZone, MaintenanceSection } from "./ModuleAdminSections";
import { RecentJobsList } from "./JobProgress";

const TABS = ["lifecycle", "preview", "schedule", "jobs", "danger"] as const;
type Tab = (typeof TABS)[number];

function StatusStrip({
  meta,
  rows,
  maintenance,
  lastImportAt,
}: {
  meta: ModuleMeta;
  rows: number;
  maintenance: boolean;
  lastImportAt: string | null;
}) {
  const emb = useEmbeddingStatus(Boolean(meta.embedJobType));
  const em = findEmbeddingModule(emb.data, meta.key);
  const stale = isEmbeddingStale(em);
  const threshold = TOOL_THRESHOLDS[meta.key];

  let toolValue: string;
  let toolColor: string;
  let toolHint: string;
  if (threshold === null || threshold === undefined) {
    toolValue = "不適用";
    toolColor = "gray";
    toolHint = "此模組是參考術語，供其他工具（如 IG ValueSet 展開）使用，本身沒有 MCP 工具。";
  } else if (rows >= threshold.min) {
    toolValue = maintenance ? "可用（維護中）" : "可用";
    toolColor = maintenance ? "amber" : "teal";
    toolHint = maintenance ? "已標示維護中，但 MCP 工具仍照常回應。" : "MCP 工具已註冊，可供 LLM 呼叫。";
  } else {
    toolValue = "未上線";
    toolColor = "gray";
    toolHint = `需至少 ${fmtNumber(threshold.min)} 筆${threshold.what}才會註冊工具。`;
  }

  return (
    <SimpleGrid cols={{ base: 2, lg: 4 }} spacing={{ base: "xs", sm: "md" }}>
      <StatCard
        label="已匯入資料"
        value={rows > 0 ? fmtCompact(rows) : "0"}
        hint={rows > 0 ? `${fmtNumber(rows)} 筆` : "尚未匯入"}
        icon={<IconDatabase size={20} />}
        color={rows > 0 ? "brand" : "gray"}
      />
      {meta.embedJobType ? (
        <StatCard
          label="向量覆蓋率"
          loading={emb.isPending}
          value={em ? fmtPercent(em.embedded, em.total) : "—"}
          hint={
            emb.isError
              ? "無法讀取嵌入狀態"
              : em
                ? `${fmtNumber(em.embedded)} / ${fmtNumber(em.total)}${stale ? " · 可能過期" : ""}`
                : "—"
          }
          progress={em ? pct(em.embedded, em.total) : 0}
          icon={<IconVectorTriangle size={20} />}
          color={stale ? "amber" : em && em.total > 0 && em.embedded >= em.total ? "teal" : "blue"}
        />
      ) : (
        <StatCard label="向量嵌入" value="不適用" hint="此模組不使用語意搜尋。" icon={<IconVectorTriangle size={20} />} color="gray" />
      )}
      <StatCard
        label="上次匯入"
        value={lastImportAt ? fmtRelative(lastImportAt) : "從未"}
        hint={lastImportAt ? <RelativeTime value={lastImportAt} fz="xs" /> : "完成匯入後顯示"}
        icon={<IconClockHour4 size={20} />}
        color={lastImportAt ? "brand" : "gray"}
      />
      <StatCard label="MCP 工具" value={toolValue} hint={toolHint} icon={<IconPlugConnected size={20} />} color={toolColor} />
    </SimpleGrid>
  );
}

function ModuleBody({ meta, catalog }: { meta: ModuleMeta; catalog: ModulesPayload }) {
  const [sp, setSp] = useSearchParams();
  const tabParam = sp.get("tab");
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "lifecycle";
  const setTab = (t: string | null) => {
    const next = new URLSearchParams(sp);
    if (!t || t === "lifecycle") next.delete("tab");
    else next.set("tab", t);
    setSp(next, { replace: true });
  };

  const jobs = useModuleJobs(meta.key);
  const rows = Number(catalog.record_counts?.[meta.countKey] ?? 0);
  const maintenance = Boolean(catalog.maintenance?.[meta.key]);
  const entries = catalog.modules.filter((e) => e.module_key === meta.key);
  const isUpload = meta.kind === "upload";
  const readiness = isUpload ? sourceReadiness(meta.key, entries) : null;

  const activeImport = jobs.activeOf(meta.importJobType);
  const activeEmbed = jobs.activeOf(meta.embedJobType);
  const anyActive = jobs.active[0] ?? null;
  const pausedEmbed = activeEmbed?.status === "paused" ? activeEmbed : null;
  const lastImport = jobs.latestOf(meta.importJobType, ["success", "partial_success", "retryable_failed", "permanent_failed", "stopped"]);
  const lastSuccess = jobs.latestOf(meta.importJobType, ["success", "partial_success"]);
  const catalogLast = entries.map((e) => e.last_imported_at).filter(Boolean).sort().pop() ?? null;
  const lastImportAt = lastSuccess?.finished_at ?? lastSuccess?.updated_at ?? catalogLast;

  const busyReason = activeImport ? "匯入工作進行中，完成後才能變更來源檔" : null;
  const minioDetail = catalog.storage.minio_enabled ? null : catalog.storage.detail || "未初始化";

  const step = (n: number) => ["①", "②", "③"][n - 1];
  const embedStep = isUpload ? step(3) : step(2);

  return (
    <Stack gap="lg">
      <StatusStrip meta={meta} rows={rows} maintenance={maintenance} lastImportAt={lastImportAt} />

      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="lifecycle" leftSection={<IconRoute size={16} />}>
            資料生命週期
          </Tabs.Tab>
          <Tabs.Tab value="preview" leftSection={<IconTable size={16} />}>
            資料預覽
          </Tabs.Tab>
          {(meta.schedulable || meta.maintenance) && (
            <Tabs.Tab value="schedule" leftSection={<IconCalendarTime size={16} />}>
              {meta.schedulable ? "排程與維護" : "維護"}
            </Tabs.Tab>
          )}
          <Tabs.Tab
            value="jobs"
            leftSection={<IconHistory size={16} />}
            rightSection={
              jobs.active.length > 0 ? (
                <Badge size="xs" color="blue" circle>
                  {jobs.active.length}
                </Badge>
              ) : null
            }
          >
            工作紀錄
          </Tabs.Tab>
          <Tabs.Tab value="danger" leftSection={<IconTrash size={16} />} color="red">
            危險操作
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="lifecycle">
          <Stack gap="lg">
            {isUpload && (
              <SourcesSection
                moduleKey={meta.key}
                entries={entries}
                maxUploadMb={catalog.upload_limits.max_upload_mb}
                hasData={rows > 0}
                busyReason={busyReason}
                minioDetail={minioDetail}
              />
            )}
            {meta.kind === "sync" && (
              <SectionCard title="上游資料來源" icon={<IconBook2 size={18} />} description="此模組不需要上傳檔案，同步時直接從食藥署開放資料平台下載。">
                <Text fz="sm">
                  {meta.source}：{meta.description}
                </Text>
              </SectionCard>
            )}
            <ImportSection
              meta={meta}
              rows={rows}
              readiness={readiness}
              activeImport={activeImport}
              activeOther={activeImport ? null : anyActive}
              lastImport={lastImport}
              stepNumber={isUpload ? step(2) : step(1)}
            />
            {meta.embedJobType && (
              <EmbeddingSection
                meta={meta}
                rows={rows}
                activeEmbed={activeEmbed}
                activeOther={activeEmbed ? null : anyActive}
                pausedEmbed={pausedEmbed}
                stepNumber={embedStep}
              />
            )}
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="preview">
          <TerminologyExplorer moduleKey={meta.key} hasData={rows > 0} />
        </Tabs.Panel>

        <Tabs.Panel value="schedule">
          <Stack gap="lg">
            {meta.schedulable && <ScheduleSection meta={meta} entries={entries} />}
            <MaintenanceSection meta={meta} enabled={maintenance} />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="jobs">
          <SectionCard
            title="最近的工作"
            icon={<IconHistory size={18} />}
            description="此模組最近的匯入、同步與嵌入工作。點選工作名稱查看步驟與日誌。"
            actions={
              <Button component={Link} to="/jobs" variant="default" size="xs">
                所有工作
              </Button>
            }
            flush
          >
            <RecentJobsList jobs={jobs.all} limit={15} />
          </SectionCard>
        </Tabs.Panel>

        <Tabs.Panel value="danger">
          <DangerZone meta={meta} activeJob={anyActive} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

export default function ModulePage() {
  const { moduleKey = "" } = useParams();
  const catalog = useModulesCatalog();
  const meta = MODULE_BY_KEY[moduleKey];

  if (moduleKey === "drug") return <Navigate to="/drug" replace />;
  if (moduleKey === "ig") return <Navigate to="/fhir/ig" replace />;

  if (!meta) {
    return (
      <>
        <PageHeader title="找不到模組" breadcrumbs={[{ label: "醫療術語", to: "/terminology" }]} />
        <EmptyState
          icon={<IconAlertTriangle size={28} />}
          title={`沒有名為「${moduleKey}」的模組`}
          description="網址可能打錯了，或此模組已不再提供。"
          action={
            <Button component={Link} to="/terminology" variant="light" leftSection={<IconArrowLeft size={16} />}>
              回到醫療術語
            </Button>
          }
        />
      </>
    );
  }

  const maintenance = Boolean(catalog.data?.maintenance?.[meta.key]);

  return (
    <>
      <PageHeader
        title={meta.label}
        description={
          <>
            {meta.description}
            <Text span fz="xs" c="dimmed" display="block" mt={4}>
              來源：{meta.source}
            </Text>
          </>
        }
        icon={<IconDatabase size={22} />}
        breadcrumbs={
          meta.group === "terminology"
            ? [{ label: "醫療術語", to: "/terminology" }, { label: meta.shortLabel }]
            : [{ label: "食藥署資料" }, { label: meta.shortLabel }]
        }
        badge={
          maintenance ? (
            <Badge color="amber" variant="filled" leftSection={<IconAlertTriangle size={12} />}>
              維護中
            </Badge>
          ) : undefined
        }
      />
      {catalog.isPending ? (
        <PageSkeleton rows={4} />
      ) : catalog.isError ? (
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      ) : (
        <>
          {maintenance && (
            <Alert color="amber" icon={<IconAlertTriangle size={16} />} mb="lg" p="sm">
              <Text fz="sm">
                此模組已標示為維護中。{" "}
                <Anchor component={Link} to="?tab=schedule" fz="sm">
                  前往維護設定
                </Anchor>
              </Text>
            </Alert>
          )}
          <ModuleBody meta={meta} catalog={catalog.data} />
        </>
      )}
    </>
  );
}

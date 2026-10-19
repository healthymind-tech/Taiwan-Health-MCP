import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowRight,
  IconBuildingHospital,
  IconCircleCheck,
  IconDatabase,
  IconListCheck,
  IconRefresh,
  IconServer,
  IconStack2,
  IconTool,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { fmtCompact, fmtNumber, fmtPercent } from "@/lib/format";
import { useJobs } from "@/lib/jobs";
import { useManualRefresh } from "@/lib/hooks";
import { ACTIVE_STATUSES, MODULES, jobTypeLabel, moduleLabel, type ModuleMeta, moduleHref } from "@/lib/meta";
import type { EmbeddingStatusPayload, JobSummary } from "@/lib/types";
import { useModulesCatalog } from "@/layout/AppLayout";
import { PageHeader } from "@/components/PageHeader";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { QueryBoundary } from "@/components/QueryBoundary";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { Dot, HealthBadge, JobStatusBadge, probeHealth, type Health } from "@/components/StatusBadge";

interface InfraEntry {
  status: string;
  detail: string;
  /** zh-TW explanation + fix (backend adminErrorCodes.explainInfrastructure). */
  detail_zh?: string;
  hint_zh?: string;
}
interface ServiceEntry {
  initialized: boolean;
  module_ready: boolean;
  maintenance?: boolean;
  health: { status: string; reason: string; search_mode: string };
}
interface WorkerEntry {
  worker_name: string;
  status: string;
  current_job_id: string;
  last_heartbeat_at: string;
  stale: boolean;
  details: Record<string, unknown>;
}
interface Overview {
  generated_at: string;
  app: { uptime: string; admin_username: string; mcp_path: string };
  infrastructure: Record<string, InfraEntry>;
  modules: Record<string, { ready: boolean; row_count: number; threshold: number }>;
  services: Record<string, ServiceEntry>;
  jobs: Record<string, number>;
  workers: WorkerEntry[];
  summary: {
    overall_status: string;
    modules_ready: number;
    modules_total: number;
    services_degraded: number;
    services_total: number;
    infrastructure_healthy: number;
    infrastructure_total: number;
    fhir_servers_total: number;
    fhir_servers_ok: number;
  };
  fhir_servers?: { total: number; ok: number; items: { server_key: string; name: string; last_probe_status: string; enabled: boolean }[] };
}

const INFRA_LABELS: Record<string, { label: string; hint: string }> = {
  database: { label: "PostgreSQL", hint: "主資料庫與向量儲存" },
  redis: { label: "Redis", hint: "即時事件廣播" },
  minio: { label: "物件儲存", hint: "來源檔、藥品仿單與圖片、備份" },
  ocr: { label: "OCR 伺服器", hint: "藥品仿單文字辨識（MinerU / Indra）" },
  mcp: { label: "MCP 端點", hint: "LLM 用戶端連線入口" },
  admin_control_plane: { label: "工作控制面", hint: "背景工作佇列" },
};

function serviceHealth(s: ServiceEntry | undefined): Health {
  if (!s) return "unknown";
  if (s.maintenance || s.health.status === "maintaining") return "warn";
  return probeHealth(s.health.status === "unavailable" ? "idle" : s.health.status);
}

interface Problem {
  level: "error" | "warn";
  text: ReactNode;
  to?: string;
}

function collectProblems(o: Overview, jobs: JobSummary[]): Problem[] {
  const out: Problem[] = [];
  for (const [key, v] of Object.entries(o.infrastructure)) {
    const why = `${v.detail_zh ?? v.detail}${v.hint_zh ? ` ${v.hint_zh}` : ""}`;
    if (v.status === "error") out.push({ level: "error", text: `${INFRA_LABELS[key]?.label ?? key} 無法使用：${why}`, to: "/health" });
    else if (v.status === "degraded") out.push({ level: "warn", text: `${INFRA_LABELS[key]?.label ?? key}：${why}`, to: "/health" });
  }
  const live = o.workers.filter((w) => !w.stale);
  if (o.workers.length === 0 || live.length === 0) {
    out.push({ level: "error", text: "沒有存活的背景 Worker，匯入與嵌入工作不會被執行。", to: "/health" });
  }
  for (const m of MODULES) {
    const svc = m.serviceKey ? o.services[m.serviceKey] : undefined;
    if (svc?.maintenance) out.push({ level: "warn", text: `${m.shortLabel} 已開啟維護模式（相關 MCP 工具暫停服務，回傳 MODULE_MAINTENANCE）。`, to: moduleLink(m) });
    else if (svc && svc.health.status === "degraded" && svc.health.reason) {
      out.push({ level: "warn", text: `${m.shortLabel}：${translateReason(svc.health.reason)}`, to: moduleLink(m) });
    }
  }
  // Only the latest run of each job type matters: an older failure that was later
  // retried successfully is not a current problem.
  const latestByType = new Map<string, JobSummary>();
  for (const j of jobs) if (!latestByType.has(j.job_type)) latestByType.set(j.job_type, j);
  for (const j of latestByType.values()) {
    if (j.status === "retryable_failed" || j.status === "permanent_failed") {
      out.push({ level: "warn", text: `最近一次「${jobTypeLabel(j.job_type)}」失敗`, to: `/jobs/${j.job_id}` });
    }
  }
  return out;
}

function translateReason(r: string): string {
  if (/Ollama unreachable/i.test(r) && /not generated/i.test(r)) return "尚未建立向量，且嵌入服務無法連線，搜尋僅能使用關鍵字。";
  if (/not generated/i.test(r)) return "尚未建立向量嵌入，搜尋僅能使用關鍵字。";
  if (/unreachable/i.test(r)) return "嵌入服務無法連線，語意搜尋暫時停用。";
  if (/analysis incomplete/i.test(r)) return "仿單 OCR / LLM 分析尚未完成。";
  if (/enrichment not run/i.test(r)) return "已匯入許可證索引，但尚未擴充仿單資料。";
  return r;
}

function moduleLink(m: ModuleMeta): string {
  return moduleHref(m.key);
}

function ModuleTile({
  m,
  rows,
  svc,
  maintenance,
  embedding,
}: {
  m: ModuleMeta;
  rows: number;
  svc?: ServiceEntry;
  maintenance: boolean;
  embedding?: { embedded: number; total: number };
}) {
  const navigate = useNavigate();
  const loaded = rows > 0;
  const state: Health = maintenance ? "warn" : !loaded ? "idle" : svc ? serviceHealth(svc) : "ok";
  const stateLabel = maintenance ? "維護中" : !loaded ? "尚未匯入" : state === "ok" ? "正常" : state === "warn" ? "部分功能受限" : state === "error" ? "異常" : "可用";
  const pct = embedding && embedding.total > 0 ? (embedding.embedded / embedding.total) * 100 : null;
  return (
    <Card padding="md" className="hover-lift" style={{ cursor: "pointer" }} onClick={() => navigate(moduleLink(m))}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" mb="sm">
        <Box style={{ minWidth: 0 }}>
          <Text fw={650} truncate="end">
            {m.shortLabel}
          </Text>
          <Text fz="xs" c="dimmed" lineClamp={1}>
            {m.label}
          </Text>
        </Box>
        <HealthBadge state={state} label={stateLabel} size="xs" />
      </Group>
      <Group gap={6} align="baseline">
        <Text fz={22} fw={700} className="tabular">
          {loaded ? fmtCompact(rows) : "—"}
        </Text>
        <Text fz="xs" c="dimmed">
          筆資料
        </Text>
      </Group>
      {m.embedJobType && (
        <Box mt="sm">
          <Group justify="space-between" mb={4}>
            <Text fz="xs" c="dimmed">
              向量嵌入
            </Text>
            <Text fz="xs" c="dimmed" className="tabular">
              {pct === null ? "—" : `${pct.toFixed(pct >= 99.95 ? 0 : 1)}%`}
            </Text>
          </Group>
          <Progress value={pct ?? 0} size="sm" radius="xl" color={pct !== null && pct >= 99.95 ? "teal" : pct && pct > 0 ? "amber" : "gray"} />
        </Box>
      )}
      {!m.embedJobType && svc && (
        <Text fz="xs" c="dimmed" mt="sm">
          {svc.health.search_mode === "n/a" ? "不使用語意搜尋" : svc.health.search_mode}
        </Text>
      )}
    </Card>
  );
}

function RecentJobs({ jobs }: { jobs: JobSummary[] }) {
  if (jobs.length === 0) return <EmptyState compact title="還沒有任何工作" description="匯入、同步或嵌入資料後，工作會出現在這裡。" />;
  return (
    <Stack gap={0}>
      {jobs.map((j, i) => {
        const pct = j.progress_total ? Math.min(100, ((j.progress_current ?? 0) / j.progress_total) * 100) : null;
        return (
          <Box
            key={j.job_id}
            component={Link}
            to={`/jobs/${j.job_id}`}
            px="lg"
            py="sm"
            style={{
              display: "block",
              color: "inherit",
              textDecoration: "none",
              borderTop: i === 0 ? undefined : "1px solid var(--mantine-color-default-border)",
            }}
            className="row-hover"
          >
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <Box style={{ minWidth: 0 }}>
                <Text fz="sm" fw={600} truncate="end">
                  {jobTypeLabel(j.job_type)}
                </Text>
                <Text fz="xs" c="dimmed">
                  {moduleLabel(j.module_key)} · <RelativeTime value={j.updated_at ?? j.created_at} fz="xs" />
                </Text>
              </Box>
              <JobStatusBadge status={j.status} />
            </Group>
            {ACTIVE_STATUSES.has(j.status) && pct !== null && (
              <Progress value={pct} size="xs" mt={6} radius="xl" animated={j.status === "running"} />
            )}
          </Box>
        );
      })}
    </Stack>
  );
}

export default function DashboardPage() {
  const overviewQ = useQuery({
    queryKey: qk.overview,
    queryFn: () => api.get<Overview>("/admin/api/overview"),
    refetchInterval: 30_000,
  });
  const embeddingQ = useQuery({
    queryKey: qk.embedding,
    queryFn: () => api.get<EmbeddingStatusPayload>("/admin/api/embedding/status"),
    staleTime: 30_000,
  });
  const modulesQ = useModulesCatalog();
  const jobsQ = useJobs();
  const jobs = jobsQ.data?.jobs ?? [];
  const manual = useManualRefresh(() => [overviewQ.refetch(), embeddingQ.refetch(), modulesQ.refetch(), jobsQ.refetch()]);

  return (
    <>
      <PageHeader
        title="儀表板"
        description="資料模組、背景工作與基礎設施的即時狀態。"
        badge={
          overviewQ.data && (
            <HealthBadge
              state={overviewQ.data.summary.overall_status === "ok" ? "ok" : "warn"}
              label={overviewQ.data.summary.overall_status === "ok" ? "系統正常" : "部分功能受限"}
            />
          )
        }
        actions={
          <Group gap="xs">
            {overviewQ.data && (
              <Text fz="xs" c="dimmed" visibleFrom="sm">
                更新於 <RelativeTime value={overviewQ.data.generated_at} fz="xs" />
              </Text>
            )}
            <Button
              variant="default"
              leftSection={<IconRefresh size={16} />}
              loading={manual.refreshing}
              onClick={manual.refresh}
            >
              重新整理
            </Button>
          </Group>
        }
      />

      <QueryBoundary query={overviewQ}>
        {(o) => {
          const problems = collectProblems(o, jobs);
          const activeJobs = jobs.filter((j) => ACTIVE_STATUSES.has(j.status));
          const liveWorkers = o.workers.filter((w) => !w.stale);
          const counts = modulesQ.data?.record_counts ?? {};
          const maint = modulesQ.data?.maintenance ?? {};
          const embByKey = new Map((embeddingQ.data?.modules ?? []).map((m) => [m.key, m]));
          return (
            <Stack gap="lg">
              {problems.length > 0 ? (
                <Alert
                  color={problems.some((p) => p.level === "error") ? "red" : "amber"}
                  icon={<IconAlertTriangle size={20} />}
                  title={`有 ${problems.length} 個項目需要注意`}
                >
                  <Stack gap={6} mt={4}>
                    {problems.slice(0, 6).map((p, i) => (
                      <Group key={i} gap={8} wrap="nowrap" align="flex-start">
                        <Box pt={6}>
                          <Dot color={p.level === "error" ? "red" : "amber"} size={6} />
                        </Box>
                        <Text fz="sm" style={{ flex: 1 }}>
                          {p.text}
                        </Text>
                        {p.to && (
                          <Anchor component={Link} to={p.to} fz="sm" style={{ whiteSpace: "nowrap" }}>
                            查看
                          </Anchor>
                        )}
                      </Group>
                    ))}
                  </Stack>
                </Alert>
              ) : (
                <Alert color="teal" icon={<IconCircleCheck size={20} />} title="一切正常">
                  基礎設施、Worker 與已載入的資料模組都運作正常。
                </Alert>
              )}

              <SimpleGrid cols={{ base: 2, lg: 4 }} spacing={{ base: "xs", sm: "md" }}>
                <StatCard
                  label="資料模組就緒"
                  value={`${o.summary.modules_ready} / ${o.summary.modules_total}`}
                  hint="資料量達到門檻、MCP 工具已註冊"
                  icon={<IconStack2 size={20} />}
                  progress={(o.summary.modules_ready / Math.max(1, o.summary.modules_total)) * 100}
                />
                <StatCard
                  label="進行中工作"
                  value={activeJobs.length}
                  hint={activeJobs.length ? `${activeJobs.filter((j) => j.status === "running").length} 個執行中` : "目前沒有工作在執行"}
                  icon={<IconListCheck size={20} />}
                  color="blue"
                  onClick={() => (window.location.href = "/admin/jobs?status=active")}
                />
                <StatCard
                  label="基礎設施"
                  value={`${o.summary.infrastructure_healthy} / ${o.summary.infrastructure_total}`}
                  hint={liveWorkers.length ? `${liveWorkers.length} 個 Worker 在線` : "沒有在線的 Worker"}
                  icon={<IconServer size={20} />}
                  color={o.summary.infrastructure_healthy === o.summary.infrastructure_total && liveWorkers.length ? "teal" : "amber"}
                />
                <StatCard
                  label="外部 FHIR 伺服器"
                  value={o.summary.fhir_servers_total ? `${o.summary.fhir_servers_ok} / ${o.summary.fhir_servers_total}` : "—"}
                  hint={o.summary.fhir_servers_total ? "最近一次探測成功" : "尚未登錄任何伺服器"}
                  icon={<IconBuildingHospital size={20} />}
                  color="indigo"
                  onClick={() => (window.location.href = "/admin/fhir-servers")}
                />
              </SimpleGrid>

              <SectionCard
                title="資料模組"
                description="點擊模組查看來源檔、匯入、向量嵌入與資料預覽。"
                icon={<IconDatabase size={18} />}
              >
                <SimpleGrid cols={{ base: 1, xs: 2, md: 3, xl: 4 }} spacing="md">
                  {MODULES.map((m) => {
                    const emb = embByKey.get(m.key) ?? embByKey.get(m.key.replace("_", "-"));
                    return (
                      <ModuleTile
                        key={m.key}
                        m={m}
                        rows={counts[m.countKey] ?? (m.serviceKey ? o.modules[m.serviceKey]?.row_count ?? 0 : 0)}
                        svc={m.serviceKey ? o.services[m.serviceKey] : undefined}
                        maintenance={Boolean(maint[m.key])}
                        embedding={emb ? { embedded: emb.embedded, total: emb.total } : undefined}
                      />
                    );
                  })}
                </SimpleGrid>
              </SectionCard>

              <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
                <SectionCard
                  title="最近的工作"
                  icon={<IconListCheck size={18} />}
                  flush
                  actions={
                    <Button component={Link} to="/jobs" variant="subtle" size="xs" rightSection={<IconArrowRight size={14} />}>
                      全部工作
                    </Button>
                  }
                >
                  <RecentJobs jobs={jobs.slice(0, 7)} />
                </SectionCard>

                <SectionCard
                  title="基礎設施"
                  icon={<IconActivity size={18} />}
                  flush
                  actions={
                    <Button component={Link} to="/health" variant="subtle" size="xs" rightSection={<IconArrowRight size={14} />}>
                      詳細探測
                    </Button>
                  }
                >
                  <Stack gap={0}>
                    {Object.entries(o.infrastructure).map(([key, v], i) => (
                      <Group
                        key={key}
                        justify="space-between"
                        wrap="nowrap"
                        px="lg"
                        py="sm"
                        gap="sm"
                        style={{ borderTop: i === 0 ? undefined : "1px solid var(--mantine-color-default-border)" }}
                      >
                        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                          <Dot color={v.status === "ok" ? "teal" : v.status === "error" ? "red" : "amber"} />
                          <Box style={{ minWidth: 0 }}>
                            <Text fz="sm" fw={600}>
                              {INFRA_LABELS[key]?.label ?? key}
                            </Text>
                            <Tooltip label={v.detail} disabled={!v.detail}>
                              <Text fz="xs" c="dimmed" truncate="end" maw={360}>
                                {v.detail_zh || v.detail || INFRA_LABELS[key]?.hint}
                              </Text>
                            </Tooltip>
                          </Box>
                        </Group>
                        <Badge color={v.status === "ok" ? "teal" : v.status === "error" ? "red" : "amber"} size="sm" style={{ flexShrink: 0 }}>
                          {v.status === "ok" ? "正常" : v.status === "error" ? "異常" : "受限"}
                        </Badge>
                      </Group>
                    ))}
                    <Group
                      justify="space-between"
                      wrap="nowrap"
                      px="lg"
                      py="sm"
                      style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
                    >
                      <Group gap="sm" wrap="nowrap">
                        <Dot color={liveWorkers.length ? "teal" : "red"} live={o.workers.some((w) => w.status === "running" && !w.stale)} />
                        <Box>
                          <Text fz="sm" fw={600}>
                            背景 Worker
                          </Text>
                          <Text fz="xs" c="dimmed">
                            {o.workers.length === 0
                              ? "沒有回報心跳的 Worker"
                              : o.workers.map((w) => `${w.worker_name}（${w.stale ? "失聯" : w.status === "running" ? "執行中" : "閒置"}）`).join("、")}
                          </Text>
                        </Box>
                      </Group>
                      <Badge color={liveWorkers.length ? "teal" : "red"} size="sm" style={{ flexShrink: 0 }}>
                        {liveWorkers.length ? `${liveWorkers.length} 在線` : "離線"}
                      </Badge>
                    </Group>
                  </Stack>
                </SectionCard>
              </SimpleGrid>

              <Card padding="md">
                <Group justify="space-between" wrap="wrap" gap="sm">
                  <Group gap="sm" wrap="nowrap">
                    <ThemeIcon variant="light" color="gray">
                      <IconTool size={18} />
                    </ThemeIcon>
                    <Text fz="sm" c="dimmed">
                      MCP 端點 <Text span ff="monospace" fz="sm">{o.app.mcp_path}</Text> · 已運行 {o.app.uptime} · 歷史工作 成功{" "}
                      {fmtNumber(o.jobs.success)} / 失敗 {fmtNumber(o.jobs.failed)}
                      {o.summary.services_total ? ` · 服務降級 ${o.summary.services_degraded}/${o.summary.services_total}` : ""}
                    </Text>
                  </Group>
                  <Text fz="xs" c="dimmed">
                    嵌入覆蓋率：
                    {(embeddingQ.data?.modules ?? [])
                      .filter((m) => m.total > 0)
                      .map((m) => `${m.label} ${fmtPercent(m.embedded, m.total, 0)}`)
                      .join("、") || "—"}
                  </Text>
                </Group>
              </Card>
            </Stack>
          );
        }}
      </QueryBoundary>
    </>
  );
}

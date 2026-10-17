import { Anchor, Box, Card, Group, Progress, SegmentedControl, SimpleGrid, Stack, Text, TextInput, ThemeIcon, Tooltip } from "@mantine/core";
import {
  IconAlertTriangle,
  IconBooks,
  IconChevronRight,
  IconDatabase,
  IconLoader2,
  IconSearch,
  IconVectorTriangle,
} from "@tabler/icons-react";
import { useQueries } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PageHeader } from "@/components/PageHeader";
import { PageSkeleton } from "@/components/QueryBoundary";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { StatCard } from "@/components/StatCard";
import { DataTable, type Column } from "@/components/DataTable";
import { HealthBadge, JobStatusBadge, type Health } from "@/components/StatusBadge";
import { RelativeTime } from "@/components/RelativeTime";
import { useModulesCatalog } from "@/layout/AppLayout";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useJobs } from "@/lib/jobs";
import { fmtCompact, fmtNumber, fmtPercent } from "@/lib/format";
import { ACTIVE_STATUSES, jobTypeLabel, moduleHref, TERMINOLOGY_MODULES, type ModuleMeta } from "@/lib/meta";
import type { EmbeddingModule, JobSummary, Schedule } from "@/lib/types";
import { findEmbeddingModule, isEmbeddingStale, pct, useEmbeddingStatus } from "@/pages/modules/moduleData";
import { roleLabel, sourceReadiness } from "@/pages/modules/SourcesSection";

const FAILED = new Set(["retryable_failed", "permanent_failed", "stopped", "cancelled"]);
const FINISHED_OK = new Set(["success", "partial_success"]);

interface Issue {
  level: "error" | "warn";
  text: string;
}

interface Row {
  meta: ModuleMeta;
  rows: number;
  maintenance: boolean;
  missingRoles: string[];
  em: EmbeddingModule | null;
  embedPct: number | null;
  stale: boolean;
  active: JobSummary | null;
  lastImportAt: string | null;
  schedule: Schedule | null;
  issues: Issue[];
  health: Health;
  healthLabel: string;
}

const HEALTH_RANK: Record<Health, number> = { error: 0, warn: 1, running: 2, idle: 3, ok: 4, unknown: 5 };

type Filter = "all" | "attention" | "running" | "empty";

export default function TerminologyPage() {
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const filter = (["all", "attention", "running", "empty"].includes(sp.get("filter") ?? "") ? sp.get("filter") : "all") as Filter;
  const [search, setSearch] = useState("");

  const catalog = useModulesCatalog();
  const jobsQ = useJobs();
  const emb = useEmbeddingStatus();
  const schedQs = useQueries({
    queries: TERMINOLOGY_MODULES.filter((m) => m.schedulable).map((m) => ({
      queryKey: qk.moduleSchedule(m.key),
      queryFn: () => api.get<{ schedule: Schedule | null }>(`/admin/api/modules/${m.key}/schedule`),
      staleTime: 30_000,
    })),
  });
  const schedules = new Map<string, Schedule>();
  for (const q of schedQs) if (q.data?.schedule) schedules.set(q.data.schedule.module_key, q.data.schedule);

  const rows: Row[] = useMemo(() => {
    if (!catalog.data) return [];
    const jobs = jobsQ.data?.jobs ?? [];
    return TERMINOLOGY_MODULES.map((meta) => {
      const count = Number(catalog.data.record_counts?.[meta.countKey] ?? 0);
      const maintenance = Boolean(catalog.data.maintenance?.[meta.key]);
      const entries = catalog.data.modules.filter((e) => e.module_key === meta.key);
      const readiness = sourceReadiness(meta.key, entries);
      const missingRoles = readiness.missing.map(roleLabel);
      const mine = jobs.filter((j) => j.module_key === meta.key || j.job_type === meta.importJobType || j.job_type === meta.embedJobType);
      const active = mine.find((j) => ACTIVE_STATUSES.has(j.status)) ?? null;
      const imports = mine.filter((j) => j.job_type === meta.importJobType);
      const lastOk = imports.find((j) => FINISHED_OK.has(j.status));
      const latestFinished = imports.find((j) => FINISHED_OK.has(j.status) || FAILED.has(j.status));
      const catalogLast = entries.map((e) => e.last_imported_at).filter(Boolean).sort().pop() || null;
      const lastImportAt = lastOk?.finished_at ?? lastOk?.updated_at ?? catalogLast;

      const em = meta.embedJobType ? findEmbeddingModule(emb.data, meta.key) : null;
      const embedPct = em && em.total > 0 ? pct(em.embedded, em.total) : null;
      const stale = isEmbeddingStale(em);
      const schedule = schedules.get(meta.key) ?? null;

      const issues: Issue[] = [];
      if (latestFinished && FAILED.has(latestFinished.status)) issues.push({ level: "error", text: "上次匯入失敗" });
      if (schedule?.is_enabled && schedule.last_run_status && FAILED.has(schedule.last_run_status))
        issues.push({ level: "error", text: "上次排程執行失敗" });
      if (count === 0 && missingRoles.length > 0) issues.push({ level: "warn", text: `缺少來源檔：${missingRoles.join("、")}` });
      if (count > 0 && embedPct !== null && embedPct < 100 && !(active && active.job_type === meta.embedJobType))
        issues.push({ level: "warn", text: em && em.embedded === 0 ? "尚未建立向量" : `向量未完整（${fmtPercent(em!.embedded, em!.total)}）` });
      if (stale) issues.push({ level: "warn", text: "資料已更新，向量可能過期" });
      if (maintenance) issues.push({ level: "warn", text: "維護中" });

      let health: Health;
      let healthLabel: string;
      if (issues.some((i) => i.level === "error")) [health, healthLabel] = ["error", "需要處理"];
      else if (active) [health, healthLabel] = ["running", "處理中"];
      else if (count === 0) [health, healthLabel] = ["idle", "尚未匯入"];
      else if (issues.length > 0) [health, healthLabel] = ["warn", "需要注意"];
      else [health, healthLabel] = ["ok", "正常"];

      return { meta, rows: count, maintenance, missingRoles, em, embedPct, stale, active, lastImportAt, schedule, issues, health, healthLabel };
    }).sort((a, b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health] || a.meta.shortLabel.localeCompare(b.meta.shortLabel));
  }, [catalog.data, jobsQ.data, emb.data, schedQs.map((q) => q.dataUpdatedAt).join()]);

  const counts = {
    all: rows.length,
    attention: rows.filter((r) => r.issues.length > 0).length,
    running: rows.filter((r) => r.active).length,
    empty: rows.filter((r) => r.rows === 0).length,
  };
  const loaded = rows.filter((r) => r.rows > 0);
  const embeddable = loaded.filter((r) => r.meta.embedJobType);
  const embeddedFull = embeddable.filter((r) => r.embedPct !== null && r.embedPct >= 100 && !r.stale);
  const totalRows = loaded.reduce((s, r) => s + r.rows, 0);

  const q = search.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (filter === "attention" && r.issues.length === 0) return false;
    if (filter === "running" && !r.active) return false;
    if (filter === "empty" && r.rows > 0) return false;
    if (!q) return true;
    return [r.meta.key, r.meta.label, r.meta.shortLabel, r.meta.description, r.meta.source].some((s) => s.toLowerCase().includes(q));
  });

  const setFilter = (f: string) => {
    const next = new URLSearchParams(sp);
    if (f === "all") next.delete("filter");
    else next.set("filter", f);
    setSp(next, { replace: true });
  };

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "術語",
      primary: true,
      sortValue: (r) => r.meta.shortLabel,
      render: (r) => (
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <ThemeIcon variant="light" color={r.rows > 0 ? "brand" : "gray"} size={34} radius="md" visibleFrom="sm">
            <IconBooks size={18} />
          </ThemeIcon>
          <Box style={{ minWidth: 0 }}>
            <Anchor component={Link} to={moduleHref(r.meta.key)} fw={650} fz="sm" c="inherit" onClick={(e) => e.stopPropagation()}>
              {r.meta.label}
            </Anchor>
            <Text fz="xs" c="dimmed" lineClamp={1}>
              {r.meta.source}
            </Text>
          </Box>
        </Group>
      ),
    },
    {
      key: "status",
      header: "狀態",
      sortValue: (r) => HEALTH_RANK[r.health],
      nowrap: true,
      render: (r) => (
        <Stack gap={4} align="flex-start">
          <HealthBadge state={r.health} label={r.healthLabel} />
          {r.issues.map((i) => (
            <Text key={i.text} fz="xs" c={i.level === "error" ? "var(--mantine-color-red-text)" : "var(--mantine-color-amber-text)"} lh={1.3} style={{ whiteSpace: "normal" }}>
              {i.text}
            </Text>
          ))}
        </Stack>
      ),
    },
    {
      key: "rows",
      header: "資料筆數",
      align: "right",
      sortValue: (r) => r.rows,
      nowrap: true,
      render: (r) =>
        r.rows > 0 ? (
          <Tooltip label={`${fmtNumber(r.rows)} 筆`}>
            <Text fz="sm" fw={600} className="tabular" span>
              {fmtCompact(r.rows)}
            </Text>
          </Tooltip>
        ) : (
          <Text fz="sm" c="dimmed" span>
            —
          </Text>
        ),
    },
    {
      key: "embed",
      header: "向量覆蓋率",
      sortValue: (r) => r.embedPct ?? -1,
      width: 180,
      render: (r) => {
        if (!r.meta.embedJobType)
          return (
            <Text fz="xs" c="dimmed">
              不使用向量
            </Text>
          );
        if (emb.isError) return <Text fz="xs" c="dimmed">無法讀取</Text>;
        if (!r.em || r.em.total === 0)
          return (
            <Text fz="xs" c="dimmed">
              —
            </Text>
          );
        const full = (r.embedPct ?? 0) >= 100;
        return (
          <Stack gap={4} miw={120}>
            <Group justify="space-between" gap="xs" wrap="nowrap">
              <Text fz="xs" fw={600} className="tabular">
                {fmtPercent(r.em.embedded, r.em.total)}
              </Text>
              <Text fz={11} c="dimmed" className="tabular">
                {fmtCompact(r.em.embedded)} / {fmtCompact(r.em.total)}
              </Text>
            </Group>
            <Progress value={r.embedPct ?? 0} size="sm" color={r.stale ? "amber" : full ? "teal" : "blue"} />
          </Stack>
        );
      },
    },
    {
      key: "imported",
      header: "上次匯入",
      sortValue: (r) => (r.lastImportAt ? new Date(r.lastImportAt).getTime() : 0),
      nowrap: true,
      render: (r) => (r.lastImportAt ? <RelativeTime value={r.lastImportAt} fz="sm" /> : <Text fz="sm" c="dimmed">從未</Text>),
    },
    {
      key: "schedule",
      header: "排程",
      hideOnMobile: true,
      nowrap: true,
      render: (r) => {
        if (!r.meta.schedulable) return <Text fz="xs" c="dimmed">不支援</Text>;
        if (!r.schedule || !r.schedule.is_enabled) return <Text fz="xs" c="dimmed">未設定</Text>;
        return r.schedule.next_run_at ? (
          <Stack gap={0}>
            <Text fz="xs" c="dimmed">
              下次
            </Text>
            <RelativeTime value={r.schedule.next_run_at} fz="sm" />
          </Stack>
        ) : (
          <Text fz="xs">已啟用</Text>
        );
      },
    },
    {
      key: "job",
      header: "進行中工作",
      nowrap: true,
      render: (r) => {
        if (!r.active)
          return (
            <Text fz="sm" c="dimmed">
              —
            </Text>
          );
        const total = r.active.progress_total ?? 0;
        const cur = r.active.progress_current ?? 0;
        return (
          <Stack gap={4} miw={130}>
            <Group gap={6} wrap="nowrap">
              <JobStatusBadge status={r.active.status} size="xs" />
              <Anchor component={Link} to={`/jobs/${r.active.job_id}`} fz="xs" onClick={(e) => e.stopPropagation()}>
                {jobTypeLabel(r.active.job_type)}
              </Anchor>
            </Group>
            {total > 0 && <Progress value={pct(cur, total)} size="xs" animated={r.active.status === "running"} />}
          </Stack>
        );
      },
    },
    {
      key: "go",
      header: "",
      width: 40,
      hideOnMobile: true,
      render: () => <IconChevronRight size={16} style={{ opacity: 0.45 }} />,
    },
  ];

  const header = (
    <PageHeader
      title="醫療術語"
      description="國際標準術語的來源檔、匯入與向量嵌入狀態。需要處理的項目排在最前面，點選任一列進入該術語的管理頁面。"
      icon={<IconBooks size={22} />}
      breadcrumbs={[{ label: "醫療術語" }]}
    />
  );

  if (catalog.isPending) {
    return (
      <>
        {header}
        <PageSkeleton rows={4} />
      </>
    );
  }
  if (catalog.isError) {
    return (
      <>
        {header}
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      </>
    );
  }

  return (
    <>
      {header}
      <Stack gap="lg">
        <SimpleGrid cols={{ base: 2, lg: 4 }} spacing={{ base: "xs", sm: "md" }}>
          <StatCard
            label="已載入術語"
            value={`${loaded.length} / ${rows.length}`}
            hint={totalRows > 0 ? `共 ${fmtNumber(totalRows)} 筆` : "尚未匯入任何術語"}
            icon={<IconDatabase size={20} />}
            color={loaded.length > 0 ? "brand" : "gray"}
            onClick={() => setFilter("empty")}
          />
          <StatCard
            label="向量完整"
            loading={emb.isPending}
            value={`${embeddedFull.length} / ${embeddable.length}`}
            hint={embeddable.length === 0 ? "沒有需要向量的術語" : "已載入且使用語意搜尋的術語"}
            progress={embeddable.length ? (embeddedFull.length / embeddable.length) * 100 : 0}
            icon={<IconVectorTriangle size={20} />}
            color={embeddable.length > 0 && embeddedFull.length === embeddable.length ? "teal" : "blue"}
          />
          <StatCard
            label="需要處理"
            value={counts.attention}
            hint={counts.attention ? "點選查看" : "一切正常"}
            icon={<IconAlertTriangle size={20} />}
            color={rows.some((r) => r.health === "error") ? "red" : counts.attention ? "amber" : "teal"}
            onClick={() => setFilter("attention")}
          />
          <StatCard
            label="進行中工作"
            value={counts.running}
            hint={counts.running ? "匯入或嵌入中" : "目前沒有工作"}
            icon={<IconLoader2 size={20} />}
            color={counts.running ? "blue" : "gray"}
            onClick={() => setFilter("running")}
          />
        </SimpleGrid>

        <Card padding={0}>
          <Group justify="space-between" p="md" gap="sm" wrap="wrap">
            <SegmentedControl
              value={filter}
              onChange={setFilter}
              size="sm"
              data={[
                { value: "all", label: `全部 ${counts.all}` },
                { value: "attention", label: `需要處理 ${counts.attention}` },
                { value: "running", label: `進行中 ${counts.running}` },
                { value: "empty", label: `尚未匯入 ${counts.empty}` },
              ]}
              style={{ maxWidth: "100%", overflowX: "auto" }}
            />
            <TextInput
              placeholder="搜尋術語名稱或來源…"
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              w={{ base: "100%", sm: 260 }}
              aria-label="搜尋術語"
            />
          </Group>
          <DataTable
            columns={columns}
            rows={visible}
            rowKey={(r) => r.meta.key}
            onRowClick={(r) => navigate(moduleHref(r.meta.key))}
            minWidth={900}
            empty={
              <EmptyState
                compact
                title={q ? `沒有符合「${search.trim()}」的術語` : "沒有符合篩選條件的術語"}
                description={filter === "attention" ? "所有術語目前都沒有需要處理的問題。" : undefined}
              />
            }
          />
        </Card>
      </Stack>
    </>
  );
}

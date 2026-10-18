import {
  Box,
  Button,
  Group,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconListCheck, IconRefresh, IconSearch, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "@/lib/api";
import { fmtDuration, durationBetween, fmtNumber, shortId } from "@/lib/format";
import { useDebounced, useManualRefresh, useNow } from "@/lib/hooks";
import {
  ACTIVE_STATUSES,
  JOB_TYPE_LABELS,
  MODULES,
  jobTypeLabel,
  matchesStatusFilter,
  moduleLabel,
} from "@/lib/meta";
import type { JobSummary, JobsPayload } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { QueryBoundary } from "@/components/QueryBoundary";
import { RelativeTime } from "@/components/RelativeTime";
import { JobStatusBadge } from "@/components/StatusBadge";

export function JobProgressCell({ job }: { job: JobSummary }) {
  const total = job.progress_total ?? 0;
  const cur = job.progress_current ?? 0;
  const pct = total > 0 ? Math.min(100, (cur / total) * 100) : null;
  const active = ACTIVE_STATUSES.has(job.status);
  return (
    <Box miw={140}>
      {pct !== null ? (
        <>
          <Group justify="space-between" gap={6} mb={4} wrap="nowrap">
            <Text fz="xs" c="dimmed" className="tabular">
              {fmtNumber(cur)} / {fmtNumber(total)}
            </Text>
            <Text fz="xs" fw={600} className="tabular">
              {pct.toFixed(pct >= 10 ? 0 : 1)}%
            </Text>
          </Group>
          <Progress
            value={pct}
            size="sm"
            radius="xl"
            animated={job.status === "running"}
            color={job.status === "success" ? "teal" : job.status.includes("failed") ? "red" : active ? "blue" : "gray"}
          />
        </>
      ) : (
        <Text fz="xs" c="dimmed">
          —
        </Text>
      )}
      {job.current_step && active && (
        <Text fz={11} c="dimmed" mt={4} truncate="end">
          {job.current_step}
        </Text>
      )}
    </Box>
  );
}

function Elapsed({ job }: { job: JobSummary }) {
  useNow(ACTIVE_STATUSES.has(job.status) ? 1000 : 60_000);
  const start = job.started_at || job.created_at;
  const end = ACTIVE_STATUSES.has(job.status) ? null : job.finished_at || job.updated_at;
  const s = durationBetween(start, end);
  return (
    <Text fz="sm" className="tabular" style={{ whiteSpace: "nowrap" }}>
      {s === null ? "—" : fmtDuration(s)}
    </Text>
  );
}

export default function JobsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "all";
  const moduleKey = params.get("module") ?? "";
  const jobType = params.get("type") ?? "";
  const search = params.get("q") ?? "";
  const debounced = useDebounced(search, 200);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const jobsQ = useQuery({
    queryKey: ["jobs", "list", 300],
    queryFn: () => api.get<JobsPayload>("/admin/api/jobs?limit=300"),
    refetchInterval: 10_000,
  });

  const manual = useManualRefresh(() => jobsQ.refetch());
  const all = jobsQ.data?.jobs ?? [];
  const filtered = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    return all.filter(
      (j) =>
        (status === "all" || matchesStatusFilter(j.status, status)) &&
        (!moduleKey || j.module_key === moduleKey) &&
        (!jobType || j.job_type === jobType) &&
        (!q ||
          j.job_id.toLowerCase().includes(q) ||
          jobTypeLabel(j.job_type).toLowerCase().includes(q) ||
          j.job_type.includes(q) ||
          (j.current_step ?? "").toLowerCase().includes(q)),
    );
  }, [all, status, moduleKey, jobType, debounced]);

  const counts = useMemo(
    () => ({
      active: all.filter((j) => ACTIVE_STATUSES.has(j.status)).length,
      running: all.filter((j) => j.status === "running").length,
      queued: all.filter((j) => j.status === "queued").length,
      paused: all.filter((j) => j.status === "paused").length,
      failed: all.filter((j) => j.status === "retryable_failed" || j.status === "permanent_failed").length,
      success: all.filter((j) => j.status === "success" || j.status === "partial_success").length,
    }),
    [all],
  );

  const typeOptions = useMemo(() => {
    const present = new Set(all.map((j) => j.job_type));
    return [...present].sort().map((t) => ({ value: t, label: JOB_TYPE_LABELS[t] ?? t }));
  }, [all]);
  const moduleOptions = useMemo(() => {
    const present = new Set(all.map((j) => j.module_key).filter(Boolean) as string[]);
    const known = MODULES.filter((m) => present.has(m.key)).map((m) => ({ value: m.key, label: m.shortLabel }));
    const extra = [...present].filter((k) => !MODULES.some((m) => m.key === k)).map((k) => ({ value: k, label: k }));
    return [...known, ...extra];
  }, [all]);

  const columns: Column<JobSummary>[] = [
    {
      key: "type",
      header: "工作",
      primary: true,
      sortValue: (j) => jobTypeLabel(j.job_type),
      render: (j) => (
        <Box style={{ minWidth: 0 }}>
          <Text fz="sm" fw={600} truncate="end">
            {jobTypeLabel(j.job_type)}
          </Text>
          <Text fz="xs" c="dimmed" ff="monospace">
            {shortId(j.job_id)} · {j.job_type}
          </Text>
        </Box>
      ),
    },
    { key: "module", header: "模組", sortValue: (j) => j.module_key ?? "", render: (j) => <Text fz="sm">{moduleLabel(j.module_key)}</Text>, nowrap: true },
    { key: "status", header: "狀態", sortValue: (j) => j.status, render: (j) => <JobStatusBadge status={j.status} />, nowrap: true },
    { key: "progress", header: "進度", render: (j) => <JobProgressCell job={j} />, hideOnMobile: false },
    {
      key: "created",
      header: "建立時間",
      sortValue: (j) => j.created_at ?? "",
      render: (j) => <RelativeTime value={j.created_at} fz="sm" />,
      nowrap: true,
    },
    { key: "elapsed", header: "耗時", render: (j) => <Elapsed job={j} />, hideOnMobile: true },
  ];

  const filtersActive = status !== "all" || moduleKey || jobType || search;

  return (
    <>
      <PageHeader
        title="背景工作"
        icon={<IconListCheck size={24} />}
        description="資料匯入、同步、向量嵌入、藥品管線與備份都在背景 Worker 執行。點擊工作查看步驟與即時日誌。"
        actions={
          <Button variant="default" leftSection={<IconRefresh size={16} />} loading={manual.refreshing} onClick={manual.refresh}>
            重新整理
          </Button>
        }
      />

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md" mb="lg">
        <StatCard
          label="執行中"
          value={counts.running}
          hint={[counts.queued ? `${counts.queued} 個排隊中` : "", counts.paused ? `${counts.paused} 個已暫停` : ""].filter(Boolean).join("、") || "沒有排隊中的工作"}
          color="blue"
          onClick={() => set("status", "running")}
          loading={jobsQ.isPending}
        />
        <StatCard label="成功" value={counts.success} color="teal" onClick={() => set("status", "success")} loading={jobsQ.isPending} />
        <StatCard label="失敗" value={counts.failed} color="red" onClick={() => set("status", "failed")} loading={jobsQ.isPending} />
        <StatCard label="最近工作總數" value={all.length} hint="顯示最近 300 筆" color="gray" onClick={() => set("status", "all")} loading={jobsQ.isPending} />
      </SimpleGrid>

      <SectionCard flush>
        <Stack gap="sm" p="md">
          <Group gap="sm" wrap="wrap" align="flex-end">
            <SegmentedControl
              value={status}
              onChange={(v) => set("status", v)}
              data={[
                { value: "all", label: "全部" },
                { value: "running", label: `執行中${counts.running ? ` ${counts.running}` : ""}` },
                { value: "queued", label: `排隊中${counts.queued ? ` ${counts.queued}` : ""}` },
                ...(counts.paused || status === "paused" ? [{ value: "paused", label: `已暫停${counts.paused ? ` ${counts.paused}` : ""}` }] : []),
                { value: "success", label: "成功" },
                { value: "failed", label: `失敗${counts.failed ? ` ${counts.failed}` : ""}` },
                { value: "stopped", label: "已停止" },
              ]}
              style={{ flex: "0 0 auto", maxWidth: "100%", overflowX: "auto" }}
            />
            <TextInput
              placeholder="搜尋工作 ID、類型、步驟…"
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(e) => set("q", e.currentTarget.value)}
              style={{ flex: "1 1 220px" }}
              rightSection={
                search ? (
                  <IconX size={14} style={{ cursor: "pointer" }} onClick={() => set("q", "")} aria-label="清除搜尋" />
                ) : null
              }
            />
            <Select
              placeholder="所有模組"
              data={moduleOptions}
              value={moduleKey || null}
              onChange={(v) => set("module", v ?? "")}
              clearable
              allowDeselect
              style={{ flex: "1 1 150px" }}
              maw={220}
            />
            <Select
              placeholder="所有工作類型"
              data={typeOptions}
              value={jobType || null}
              onChange={(v) => set("type", v ?? "")}
              clearable
              allowDeselect
              searchable
              style={{ flex: "1 1 180px" }}
              maw={260}
            />
            {filtersActive && (
              <Tooltip label="清除所有篩選">
                <Button variant="subtle" color="gray" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  清除篩選
                </Button>
              </Tooltip>
            )}
          </Group>
          <Text fz="xs" c="dimmed">
            顯示 {filtered.length} / {all.length} 筆
          </Text>
        </Stack>
        <QueryBoundary query={jobsQ}>
          {() => (
            <DataTable
              columns={columns}
              rows={filtered}
              rowKey={(j) => j.job_id}
              onRowClick={(j) => navigate(`/jobs/${j.job_id}`)}
              pageSize={25}
              minWidth={860}
              empty={
                <EmptyState
                  title={all.length ? "沒有符合篩選的工作" : "還沒有任何工作"}
                  description={all.length ? "調整或清除篩選條件。" : "從資料模組頁面匯入或同步資料後，工作會出現在這裡。"}
                  action={
                    all.length ? (
                      <Button variant="light" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                        清除篩選
                      </Button>
                    ) : (
                      <Button component={Link} to="/terminology" variant="light">
                        前往醫療術語
                      </Button>
                    )
                  }
                />
              }
            />
          )}
        </QueryBoundary>
      </SectionCard>
    </>
  );
}

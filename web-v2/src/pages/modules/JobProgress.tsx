import { Anchor, Box, Group, Progress, Stack, Text } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { Link } from "react-router";
import { JobStatusBadge } from "@/components/StatusBadge";
import { RelativeTime } from "@/components/RelativeTime";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { fmtNumber, durationBetween, fmtDuration, shortId } from "@/lib/format";
import { jobTypeLabel } from "@/lib/meta";
import type { JobSummary } from "@/lib/types";

/** Inline progress for an active job: status, step, bar, link to the job page. */
export function InlineJobProgress({ job, label }: { job: JobSummary; label?: string }) {
  const cur = Number(job.progress_current ?? 0);
  const total = Number(job.progress_total ?? 0);
  const value = total > 0 ? Math.min(100, (cur / total) * 100) : 0;
  const indeterminate = total <= 0 && job.status !== "paused";
  return (
    <Box
      p="sm"
      style={{
        border: "1px solid var(--mantine-color-default-border)",
        borderRadius: "var(--mantine-radius-md)",
        background: "var(--mantine-color-default-hover)",
      }}
    >
      <Stack gap={6}>
        <Group justify="space-between" gap="xs" wrap="wrap">
          <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
            <JobStatusBadge status={job.status} />
            <Text fz="sm" fw={600}>
              {label ?? jobTypeLabel(job.job_type)}
            </Text>
          </Group>
          <Anchor component={Link} to={`/jobs/${job.job_id}`} fz="sm">
            <Group gap={4} wrap="nowrap">
              查看工作詳情 <IconArrowRight size={14} />
            </Group>
          </Anchor>
        </Group>
        <Progress
          value={indeterminate ? 100 : value}
          animated={job.status === "running"}
          striped={indeterminate || job.status === "running"}
          color={job.status === "paused" ? "amber" : "blue"}
          size="sm"
        />
        <Group justify="space-between" gap="xs" wrap="wrap">
          <Text fz="xs" c="dimmed" style={{ wordBreak: "break-word" }}>
            {job.current_step ? `目前步驟：${job.current_step}` : "等待工作程序接手…"}
          </Text>
          {total > 0 && (
            <Text fz="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtNumber(cur)} / {fmtNumber(total)}（{value.toFixed(0)}%）
            </Text>
          )}
        </Group>
      </Stack>
    </Box>
  );
}

/** Compact list of a module's recent jobs. */
export function RecentJobsList({ jobs, limit = 10 }: { jobs: JobSummary[]; limit?: number }) {
  const columns: Column<JobSummary>[] = [
    {
      key: "type",
      header: "工作",
      primary: true,
      render: (j) => (
        <Stack gap={0}>
          <Anchor component={Link} to={`/jobs/${j.job_id}`} fz="sm" fw={600}>
            {jobTypeLabel(j.job_type)}
          </Anchor>
          <Text fz="xs" c="dimmed" ff="monospace">
            {shortId(j.job_id)}
          </Text>
        </Stack>
      ),
    },
    { key: "status", header: "狀態", render: (j) => <JobStatusBadge status={j.status} />, nowrap: true },
    {
      key: "created",
      header: "建立時間",
      render: (j) => <RelativeTime value={j.created_at} fz="sm" />,
      sortValue: (j) => j.created_at ?? "",
      nowrap: true,
    },
    {
      key: "duration",
      header: "耗時",
      hideOnMobile: true,
      align: "right",
      render: (j) => {
        const s = durationBetween(j.started_at, j.finished_at);
        return <Text fz="sm">{s === null ? "—" : fmtDuration(s)}</Text>;
      },
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={jobs.slice(0, limit)}
      rowKey={(j) => j.job_id}
      minWidth={520}
      empty={<EmptyState compact title="尚無工作紀錄" description="此模組還沒有執行過任何匯入、同步或嵌入工作。" />}
    />
  );
}

// Small presentational building blocks shared by the drug pages.

import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  Image,
  Progress,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconExternalLink, IconPhotoOff, IconPill, IconPlayerPause, IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { JobStatusBadge, Dot } from "@/components/StatusBadge";
import { notify } from "@/components/notify";
import { confirmAction } from "@/components/confirm";
import { fmtNumber, fmtRelative, shortId } from "@/lib/format";
import { useJobControl } from "@/lib/jobs";
import { jobTypeLabel } from "@/lib/meta";
import type { JobSummary } from "@/lib/types";
import { STAGE_COLUMNS, drugStatusMeta } from "./drugMeta";

/** Pipeline-stage status badge. */
export function DrugStatusBadge({ status, size = "sm" }: { status: string | null | undefined; size?: "xs" | "sm" | "md" }) {
  const m = drugStatusMeta(status);
  return (
    <Badge color={m.color} size={size} variant="light" leftSection={<Dot color={m.color} size={6} />}>
      {m.label}
    </Badge>
  );
}

/** Compact row of stage dots; hover shows each stage's status. */
export function StageStrip({ statuses }: { statuses: Record<string, string> }) {
  return (
    <Group gap={4} wrap="nowrap">
      {STAGE_COLUMNS.map((c) => {
        const m = drugStatusMeta(statuses[c.key]);
        return (
          <Tooltip key={c.key} label={`${c.label}：${m.label}`} withArrow openDelay={100}>
            <Box
              component="span"
              aria-label={`${c.label}：${m.label}`}
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                display: "inline-block",
                flexShrink: 0,
                background:
                  m.color === "gray" && statuses[c.key] === "no_data"
                    ? "transparent"
                    : `var(--mantine-color-${m.color}-${m.color === "gray" ? "light-color" : "filled"})`,
                border: `1.5px solid var(--mantine-color-${m.color}-${m.color === "gray" ? "light-color" : "filled"})`,
                opacity: m.color === "gray" ? 0.55 : 1,
              }}
            />
          </Tooltip>
        );
      })}
    </Group>
  );
}

/** Thumbnail with a graceful fallback when the object is missing in storage. */
export function DrugThumb({ src, size = 48, alt }: { src: string | null | undefined; size?: number; alt: string }) {
  const [failed, setFailed] = useState(false);
  const box = {
    width: size,
    height: size,
    borderRadius: 8,
    flexShrink: 0,
    overflow: "hidden",
    border: "1px solid var(--mantine-color-default-border)",
    background: "var(--mantine-color-default-hover)",
  } as const;
  if (!src || failed) {
    return (
      <Center style={box}>
        {src ? <IconPhotoOff size={size * 0.4} opacity={0.45} /> : <IconPill size={size * 0.42} opacity={0.4} />}
      </Center>
    );
  }
  return (
    <Box style={box}>
      <Image src={src} alt={alt} w={size} h={size} fit="contain" loading="lazy" onError={() => setFailed(true)} />
    </Box>
  );
}

/** Inline card for an active drug job: status, progress, pause/resume/stop. */
export function ActiveJobInline({ job, extra }: { job: JobSummary; extra?: ReactNode }) {
  const control = useJobControl();
  const cur = Number(job.progress_current ?? 0);
  const total = Number(job.progress_total ?? 0);
  const pct = total > 0 ? Math.min(100, (cur / total) * 100) : 0;

  const run = (action: "pause" | "resume" | "stop") => {
    const go = async () => {
      try {
        await control.mutateAsync({ jobId: job.job_id, action });
        notify.success(action === "pause" ? "已送出暫停要求，工作會在下一個檢查點暫停" : action === "resume" ? "工作已繼續" : "已送出停止要求");
      } catch (e) {
        notify.error(e);
        throw e;
      }
    };
    if (action === "stop") {
      confirmAction({
        title: "停止這個工作？",
        message: `${jobTypeLabel(job.job_type)}（${shortId(job.job_id)}）會在目前這張許可證處理完後停止。`,
        consequences: ["已處理的許可證會保留結果", "未處理的許可證維持待處理，之後可再次執行管線", "停止後無法繼續，只能重新開始新工作"],
        confirmLabel: "停止工作",
        danger: true,
        onConfirm: go,
      });
      return;
    }
    void go().catch(() => undefined);
  };

  return (
    <Card withBorder padding="md" radius="lg" bg="var(--mantine-color-blue-light)">
      <Stack gap="xs">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Group gap="xs" wrap="wrap">
            <JobStatusBadge status={job.status} />
            <Text fw={600} fz="sm">
              {jobTypeLabel(job.job_type)}
            </Text>
            <Anchor component={Link} to={`/jobs/${job.job_id}`} fz="xs" ff="monospace">
              {shortId(job.job_id)} <IconExternalLink size={11} style={{ verticalAlign: "-1px" }} />
            </Anchor>
          </Group>
          <Group gap={6}>
            {job.status === "paused" ? (
              <Tooltip label="繼續執行">
                <ActionIcon variant="default" aria-label="繼續" loading={control.isPending} onClick={() => run("resume")}>
                  <IconPlayerPlay size={16} />
                </ActionIcon>
              </Tooltip>
            ) : (
              <Tooltip label="在下一個檢查點暫停">
                <ActionIcon variant="default" aria-label="暫停" loading={control.isPending} onClick={() => run("pause")}>
                  <IconPlayerPause size={16} />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip label="停止工作">
              <ActionIcon variant="default" color="red" aria-label="停止" loading={control.isPending} onClick={() => run("stop")}>
                <IconPlayerStop size={16} />
              </ActionIcon>
            </Tooltip>
            <Button component={Link} to={`/jobs/${job.job_id}`} size="xs" variant="default">
              查看詳情
            </Button>
          </Group>
        </Group>
        <Progress value={pct} size="md" radius="xl" animated={job.status === "running"} striped={job.status === "running"} />
        <Group justify="space-between" gap="xs" wrap="wrap">
          <Text fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
            {job.current_step || "等待中"}
          </Text>
          <Text fz="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
            {total > 0 ? `${fmtNumber(cur)} / ${fmtNumber(total)}` : "—"} · 更新於 {fmtRelative(job.updated_at ?? job.created_at)}
          </Text>
        </Group>
        {extra}
      </Stack>
    </Card>
  );
}

/** Safe decode for route params (react-router may already have decoded them). */
export function safeDecode(v: string | undefined): string {
  if (!v) return "";
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

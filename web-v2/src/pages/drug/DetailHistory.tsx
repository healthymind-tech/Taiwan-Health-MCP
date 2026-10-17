// 處理歷程 tab: per-stage summary + full event timeline (newest first).

import { Badge, Box, Collapse, Group, SegmentedControl, SimpleGrid, Stack, Text, Timeline, Tooltip, UnstyledButton } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconChevronDown, IconChevronRight, IconClock, IconTimeline } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { JsonView } from "@/components/JsonView";
import { SectionCard } from "@/components/SectionCard";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { drugStatusMeta, eventStageLabel } from "./drugMeta";
import { isEmptyValue, type ExplorerDetail, type TimelineEvent } from "./drugTypes";
import { DrugStatusBadge } from "./drugUi";

function bulletIcon(status: string | null) {
  const s = String(status ?? "");
  if (s === "success") return <IconCheck size={12} />;
  if (/fail/.test(s)) return <IconAlertTriangle size={12} />;
  return <IconClock size={12} />;
}

export function DetailHistory({ detail }: { detail: ExplorerDetail }) {
  const [filter, setFilter] = useState<string>("all");
  const events = useMemo(() => [...detail.timeline.events].reverse(), [detail]);
  const shown = filter === "all" ? events : filter === "failed" ? events.filter((e) => /fail/.test(String(e.status)) || e.error_message) : events.filter((e) => e.stage === filter);
  const stages = detail.timeline.stages;

  return (
    <Stack gap="md">
      <SectionCard title="各階段目前狀態" description="點擊一個階段只顯示該階段的事件">
        <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="xs">
          {stages.map((s) => {
            const last = s.events[s.events.length - 1];
            const active = filter === s.stage;
            return (
              <UnstyledButton
                key={s.stage}
                onClick={() => setFilter(active ? "all" : s.stage)}
                p="sm"
                style={{
                  border: `1px solid ${active ? "var(--mantine-primary-color-filled)" : "var(--mantine-color-default-border)"}`,
                  borderRadius: 8,
                  background: active ? "var(--mantine-primary-color-light)" : undefined,
                }}
                aria-pressed={active}
              >
                <Group justify="space-between" gap="xs" wrap="nowrap">
                  <Text fz="sm" fw={600}>
                    {eventStageLabel(s.stage)}
                  </Text>
                  <DrugStatusBadge status={s.status} size="xs" />
                </Group>
                <Text fz="xs" c="dimmed" mt={4}>
                  {s.events.length} 筆事件{last ? ` · 最近 ${fmtRelative(last.created_at)}` : ""}
                </Text>
              </UnstyledButton>
            );
          })}
        </SimpleGrid>
      </SectionCard>

      <SectionCard
        title="事件時間軸"
        icon={<IconTimeline size={18} />}
        actions={
          <SegmentedControl
            size="xs"
            value={filter === "all" || filter === "failed" ? filter : "stage"}
            onChange={(v) => setFilter(v === "stage" ? filter : v)}
            data={[
              { value: "all", label: `全部 ${events.length}` },
              { value: "failed", label: "僅失敗" },
              ...(filter !== "all" && filter !== "failed" ? [{ value: "stage", label: eventStageLabel(filter) }] : []),
            ]}
          />
        }
      >
        {shown.length === 0 ? (
          <EmptyState compact title={events.length === 0 ? "還沒有處理事件" : "沒有符合的事件"} description={events.length === 0 ? "這張許可證尚未進入管線處理。" : undefined} />
        ) : (
          <Timeline bulletSize={22} lineWidth={2} active={-1}>
            {shown.map((e) => (
              <Timeline.Item key={String(e.event_id)} bullet={bulletIcon(e.status)} color={drugStatusMeta(e.status).color} title={<EventTitle e={e} />}>
                <EventBody e={e} />
              </Timeline.Item>
            ))}
          </Timeline>
        )}
      </SectionCard>
    </Stack>
  );
}

function EventTitle({ e }: { e: TimelineEvent }) {
  return (
    <Group gap={6} wrap="wrap">
      <Text fz="sm" fw={600}>
        {eventStageLabel(e.stage)}
      </Text>
      {e.from_status && e.from_status !== e.status && (
        <>
          <Text fz="xs" c="dimmed">
            {drugStatusMeta(e.from_status).label} →
          </Text>
        </>
      )}
      <DrugStatusBadge status={e.status} size="xs" />
    </Group>
  );
}

function EventBody({ e }: { e: TimelineEvent }) {
  const [open, setOpen] = useState(false);
  const hasPayload = !isEmptyValue(e.payload);
  return (
    <Stack gap={4} mt={2}>
      <Tooltip label={fmtDateTime(e.created_at, true)}>
        <Text fz="xs" c="dimmed" w="fit-content">
          {fmtDateTime(e.created_at)} · {fmtRelative(e.created_at)}
        </Text>
      </Tooltip>
      {(e.error_code || e.error_message) && (
        <Box p="xs" style={{ borderRadius: 6, background: "var(--mantine-color-red-light)" }}>
          {e.error_code && (
            <Badge size="xs" color="red" variant="outline" mb={4} style={{ textTransform: "none" }}>
              {e.error_code}
            </Badge>
          )}
          {e.error_message && (
            <Text fz="xs" c="red" style={{ wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
              {e.error_message}
            </Text>
          )}
        </Box>
      )}
      {hasPayload && (
        <>
          <UnstyledButton onClick={() => setOpen((o) => !o)} fz="xs" c="dimmed" style={{ display: "inline-flex", alignItems: "center", gap: 4, width: "fit-content" }}>
            {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
            詳細資料
          </UnstyledButton>
          <Collapse in={open}>
            <JsonView value={e.payload} maxHeight={260} />
          </Collapse>
        </>
      )}
    </Stack>
  );
}

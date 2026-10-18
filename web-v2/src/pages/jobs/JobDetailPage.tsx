import {
  Accordion,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Grid,
  Group,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Timeline,
  Title,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconCheck,
  IconDownload,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconRotateClockwise,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { durationBetween, fmtDateTime, fmtDuration, fmtNumber, shortId } from "@/lib/format";
import { useManualRefresh, useNow } from "@/lib/hooks";
import { useJobControl } from "@/lib/jobs";
import { useLiveLogs } from "@/lib/liveLogs";
import { ACTIVE_STATUSES, JOB_ACTION_LABELS, jobStatusMeta, jobTypeLabel, moduleLabel } from "@/lib/meta";
import type { JobDetail, JobLog, JobStep } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { SectionCard } from "@/components/SectionCard";
import { QueryBoundary } from "@/components/QueryBoundary";
import { KeyValue } from "@/components/KeyValue";
import { CopyText } from "@/components/CopyText";
import { JsonView } from "@/components/JsonView";
import { LogViewer, type LogLine } from "@/components/LogViewer";
import { EmptyState } from "@/components/EmptyState";
import { JobStatusBadge } from "@/components/StatusBadge";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";

const ACTION_ICON: Record<string, typeof IconPlayerPause> = {
  pause: IconPlayerPause,
  resume: IconPlayerPlay,
  stop: IconPlayerStop,
  restart: IconRotateClockwise,
};

const STEP_STATUS_COLOR: Record<string, string> = {
  success: "teal",
  running: "blue",
  queued: "gray",
  paused: "amber",
  stopped: "gray",
  retryable_failed: "orange",
  permanent_failed: "red",
  partial_success: "amber",
};

function ProgressPanel({ job }: { job: JobDetail }) {
  useNow(ACTIVE_STATUSES.has(job.status) ? 1000 : 60_000);
  const total = job.progress_total ?? 0;
  const cur = job.progress_current ?? 0;
  const pct = total > 0 ? Math.min(100, (cur / total) * 100) : null;
  const active = ACTIVE_STATUSES.has(job.status);
  const elapsed = durationBetween(job.started_at || job.created_at, active ? null : job.finished_at || job.updated_at);
  const rate = elapsed && elapsed > 5 && cur > 0 ? cur / elapsed : null;
  const eta = active && rate && total > cur ? (total - cur) / rate : null;
  const meta = jobStatusMeta(job.status);
  return (
    <Card padding="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm" mb="sm">
        <Box>
          <Text fz="xs" c="dimmed" fw={600}>
            進度
          </Text>
          <Group gap="xs" align="baseline">
            <Text fz={30} fw={700} className="tabular" lh={1.1}>
              {pct === null ? (active ? "處理中" : meta.label) : `${pct.toFixed(pct >= 10 ? 0 : 1)}%`}
            </Text>
            {pct !== null && (
              <Text fz="sm" c="dimmed" className="tabular">
                {fmtNumber(cur)} / {fmtNumber(total)}
              </Text>
            )}
          </Group>
        </Box>
        <Group gap="lg" wrap="wrap">
          <Box>
            <Text fz="xs" c="dimmed">
              已耗時
            </Text>
            <Text fz="sm" fw={600} className="tabular">
              {elapsed === null ? "—" : fmtDuration(elapsed)}
            </Text>
          </Box>
          {rate !== null && (
            <Box>
              <Text fz="xs" c="dimmed">
                速度
              </Text>
              <Text fz="sm" fw={600} className="tabular">
                {rate >= 1 ? `${fmtNumber(Math.round(rate))} / 秒` : `${fmtNumber(Math.round(rate * 60))} / 分`}
              </Text>
            </Box>
          )}
          {eta !== null && (
            <Box>
              <Text fz="xs" c="dimmed">
                預估剩餘
              </Text>
              <Text fz="sm" fw={600} className="tabular">
                {fmtDuration(eta)}
              </Text>
            </Box>
          )}
        </Group>
      </Group>
      <Progress
        value={pct ?? (active ? 100 : 0)}
        size="lg"
        radius="xl"
        animated={job.status === "running"}
        striped={pct === null && active}
        color={job.status === "success" ? "teal" : job.status.includes("failed") ? "red" : active ? "blue" : "gray"}
      />
      {job.current_step && (
        <Text fz="sm" c="dimmed" mt="sm">
          目前步驟：<Text span ff="monospace" fz="sm">{job.current_step}</Text>
          {job.control_state && job.control_state !== "idle" && (
            <Badge ml="xs" size="sm" color="amber">
              {job.control_state}
            </Badge>
          )}
        </Text>
      )}
    </Card>
  );
}

function StepsTimeline({ steps }: { steps: JobStep[] }) {
  if (steps.length === 0) return <EmptyState compact title="尚無步驟紀錄" description="工作被 Worker 認領後，步驟會陸續出現。" />;
  const activeIdx = steps.findIndex((s) => s.status === "running");
  return (
    <Timeline active={activeIdx >= 0 ? activeIdx : steps.length - 1} bulletSize={22} lineWidth={2}>
      {steps.map((s) => {
        const color = STEP_STATUS_COLOR[s.status] ?? "gray";
        const pct = s.progress_total > 0 ? (s.progress_current / s.progress_total) * 100 : null;
        const dur = durationBetween(s.started_at, s.finished_at);
        const hasCheckpoint = s.checkpoint && Object.keys(s.checkpoint).length > 0;
        return (
          <Timeline.Item
            key={s.job_step_id}
            color={color}
            bullet={s.status === "success" ? <IconCheck size={12} /> : s.status.includes("failed") ? <IconX size={12} /> : undefined}
            title={
              <Group gap="xs" wrap="wrap">
                <Text fw={600} fz="sm" ff="monospace">
                  {s.step_key}
                </Text>
                <Badge size="xs" color={color}>
                  {jobStatusMeta(s.status).label}
                </Badge>
              </Group>
            }
          >
            <Text fz="xs" c="dimmed" mt={2}>
              {fmtDateTime(s.started_at, true)}
              {dur !== null ? ` · ${fmtDuration(dur)}` : ""}
              {pct !== null ? ` · ${fmtNumber(s.progress_current)} / ${fmtNumber(s.progress_total)}` : ""}
            </Text>
            {pct !== null && s.status === "running" && <Progress value={pct} size="xs" mt={6} maw={360} animated />}
            {s.last_error_message && (
              <Text fz="xs" c="red" mt={4}>
                {s.last_error_message}
              </Text>
            )}
            {hasCheckpoint && (
              <Accordion variant="unstyled" chevronPosition="left" mt={2}>
                <Accordion.Item value="cp">
                  <Accordion.Control p={0} fz="xs" c="dimmed">
                    檢查點資料
                  </Accordion.Control>
                  <Accordion.Panel>
                    <JsonView value={s.checkpoint} maxHeight={220} />
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            )}
          </Timeline.Item>
        );
      })}
    </Timeline>
  );
}

function LogsPanel({ jobId, active }: { jobId: string; active: boolean }) {
  const [older, setOlder] = useState<JobLog[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [level, setLevel] = useState("all");
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);

  const logsQ = useQuery({
    queryKey: qk.jobLogs(jobId),
    queryFn: () => api.get<{ logs: JobLog[] }>(`/admin/api/jobs/${jobId}/logs?limit=300`),
    refetchInterval: active ? 5000 : false,
  });
  const live = useLiveLogs(jobId);

  const lines: LogLine[] = useMemo(() => {
    const fetched = logsQ.data?.logs ?? [];
    const lastTs = fetched.length ? fetched[fetched.length - 1].created_at : "";
    const merged: LogLine[] = [
      ...older.map((l) => ({ id: l.job_log_id, level: l.level, message: l.message, timestamp: l.created_at, payload: l.payload })),
      ...fetched.map((l) => ({ id: l.job_log_id, level: l.level, message: l.message, timestamp: l.created_at, payload: l.payload })),
      ...live
        .filter((l) => !lastTs || l.timestamp > lastTs)
        .map((l, i) => ({ id: `live-${i}-${l.timestamp}`, level: l.level, message: l.message, timestamp: l.timestamp, payload: l.payload })),
    ];
    const q = filter.trim().toLowerCase();
    return merged.filter((l) => {
      const lv = l.level.toLowerCase();
      if (level === "warn" && !(lv === "warn" || lv === "warning" || lv === "error")) return false;
      if (level === "error" && lv !== "error") return false;
      if (q && !l.message.toLowerCase().includes(q) && !JSON.stringify(l.payload ?? {}).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [older, logsQ.data, live, level, filter]);

  const loadOlder = async () => {
    const first = older[0] ?? logsQ.data?.logs[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const r = await api.get<{ logs: JobLog[] }>(`/admin/api/jobs/${jobId}/logs?limit=300&before_id=${first.job_log_id}`);
      if (r.logs.length === 0) setExhausted(true);
      setOlder((prev) => [...r.logs, ...prev]);
    } catch (e) {
      notify.error(e, "載入較早日誌失敗");
    } finally {
      setLoadingOlder(false);
    }
  };

  const download = () => {
    const text = lines
      .map((l) => `${l.timestamp ?? ""}\t${l.level.toUpperCase()}\t${l.message}${l.payload && Object.keys(l.payload).length ? `\t${JSON.stringify(l.payload)}` : ""}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `job-${shortId(jobId)}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const total = (logsQ.data?.logs.length ?? 0) + older.length;

  return (
    <SectionCard
      title="日誌"
      description={active ? "即時更新中" : `${fmtNumber(total)} 筆`}
      actions={
        <Group gap="xs">
          <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} onClick={download} disabled={lines.length === 0}>
            下載
          </Button>
        </Group>
      }
    >
      <Stack gap="sm">
        <Group gap="sm" wrap="wrap">
          <SegmentedControl
            size="xs"
            value={level}
            onChange={setLevel}
            data={[
              { value: "all", label: "全部" },
              { value: "warn", label: "警告以上" },
              { value: "error", label: "僅錯誤" },
            ]}
          />
          <TextInput
            size="xs"
            placeholder="篩選日誌內容…"
            leftSection={<IconSearch size={14} />}
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            style={{ flex: "1 1 200px" }}
          />
          <Switch size="sm" label="自動捲到底" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />
        </Group>
        {total >= 300 && !exhausted && (
          <Button size="xs" variant="subtle" onClick={() => void loadOlder()} loading={loadingOlder}>
            載入較早的日誌
          </Button>
        )}
        <QueryBoundary query={logsQ} skeleton={<Box h={420} />}>
          {() => <LogViewer lines={lines} follow={follow} height={460} />}
        </QueryBoundary>
      </Stack>
    </SectionCard>
  );
}

export default function JobDetailPage() {
  const { jobId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const control = useJobControl();

  const jobQ = useQuery({
    queryKey: qk.job(jobId),
    queryFn: () => api.get<{ job: JobDetail }>(`/admin/api/jobs/${jobId}`),
    refetchInterval: (q) => (q.state.data && ACTIVE_STATUSES.has(q.state.data.job.status) ? 3000 : false),
  });
  const stepsQ = useQuery({
    queryKey: qk.jobSteps(jobId),
    queryFn: () => api.get<{ steps: JobStep[] }>(`/admin/api/jobs/${jobId}/steps`),
    refetchInterval: jobQ.data && ACTIVE_STATUSES.has(jobQ.data.job.status) ? 4000 : false,
  });

  const manual = useManualRefresh(() => [
    jobQ.refetch(),
    stepsQ.refetch(),
    qc.invalidateQueries({ queryKey: qk.jobLogs(jobId) }),
  ]);

  const runAction = (job: JobDetail, action: string) => {
    const go = async () => {
      try {
        await control.mutateAsync({ jobId: job.job_id, action });
        notify.success(`已送出「${JOB_ACTION_LABELS[action] ?? action}」請求。Worker 會在下一個安全檢查點套用。`);
        void qc.invalidateQueries({ queryKey: qk.job(job.job_id) });
      } catch (e) {
        notify.error(e);
        throw e;
      }
    };
    if (action === "stop") {
      confirmAction({
        title: "停止這個工作？",
        message: "Worker 會在下一個檢查點停止。已完成的部分會保留，之後可用「重新開始」再執行一次。",
        confirmLabel: "停止工作",
        danger: true,
        onConfirm: go,
      });
    } else if (action === "restart") {
      confirmAction({
        title: "重新開始這個工作？",
        message: ACTIVE_STATUSES.has(job.status)
          ? "目前的執行會停止，並以相同參數建立一個新的工作從頭執行。"
          : "會以相同參數建立一個新的工作重新執行。",
        confirmLabel: "重新開始",
        onConfirm: go,
      });
    } else {
      void go();
    }
  };

  return (
    <QueryBoundary query={jobQ}>
      {({ job }) => {
        const active = ACTIVE_STATUSES.has(job.status);
        const failed = job.status === "retryable_failed" || job.status === "permanent_failed";
        const parentId = typeof job.job_options?.parent_job_id === "string" ? job.job_options.parent_job_id : null;
        return (
          <>
            <PageHeader
              breadcrumbs={[{ label: "背景工作", to: "/jobs" }, { label: shortId(job.job_id) }]}
              title={jobTypeLabel(job.job_type)}
              badge={<JobStatusBadge status={job.status} size="md" />}
              description={
                <>
                  {moduleLabel(job.module_key)} · <Text span ff="monospace" fz="sm">{job.job_type}</Text> · 由 {job.requested_by || "—"} 於{" "}
                  {fmtDateTime(job.created_at)} 建立
                </>
              }
              actions={
                <>
                  <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={() => navigate(-1)}>
                    返回
                  </Button>
                  <Button
                    variant="default"
                    leftSection={<IconRefresh size={16} />}
                    loading={manual.refreshing}
                    onClick={manual.refresh}
                  >
                    重新整理
                  </Button>
                  {job.available_actions.map((a) => {
                    const Icon = ACTION_ICON[a] ?? IconRefresh;
                    return (
                      <Button
                        key={a}
                        variant={a === "stop" ? "light" : a === "resume" ? "filled" : "default"}
                        color={a === "stop" ? "red" : undefined}
                        leftSection={<Icon size={16} />}
                        loading={control.isPending && control.variables?.action === a}
                        onClick={() => runAction(job, a)}
                      >
                        {JOB_ACTION_LABELS[a] ?? a}
                      </Button>
                    );
                  })}
                </>
              }
            />

            <Stack gap="lg">
              {failed && (job.last_error_message || job.last_error_code) && (
                <Alert color="red" icon={<IconAlertCircle size={20} />} title={job.status === "retryable_failed" ? "工作失敗（可重試）" : "工作失敗"}>
                  <Text fz="sm" style={{ wordBreak: "break-word" }}>
                    {job.last_error_zh || job.last_error_message || "未提供錯誤訊息"}
                  </Text>
                  {job.last_error_hint_zh && (
                    <Text fz="sm" mt={4}>
                      {job.last_error_hint_zh}
                    </Text>
                  )}
                  {job.last_error_zh && job.last_error_message && (
                    <Text fz="xs" c="dimmed" mt={4} ff="monospace" style={{ wordBreak: "break-word" }}>
                      技術細節：{job.last_error_message}
                    </Text>
                  )}
                  {job.last_error_code && (
                    <Text fz="xs" c="dimmed" mt={4} ff="monospace">
                      錯誤代碼：{job.last_error_code}
                    </Text>
                  )}
                  {job.available_actions.includes("restart") && (
                    <Button size="xs" mt="sm" variant="white" color="red" leftSection={<IconRotateClockwise size={14} />} onClick={() => runAction(job, "restart")}>
                      重新執行
                    </Button>
                  )}
                </Alert>
              )}
              {job.status === "paused" && job.last_error_code === "llm_unavailable" && (
                <Alert color="amber" icon={<IconAlertCircle size={20} />} title="分析 LLM 暫時無法使用">
                  所有分析模型端點都失敗，工作已自動暫停，系統會依退避時間自動恢復。你也可以按「繼續」立即重試。
                </Alert>
              )}

              <ProgressPanel job={job} />

              <Grid gutter="lg">
                <Grid.Col span={{ base: 12, lg: 5 }}>
                  <Stack gap="lg">
                    <SectionCard title="詳細資訊">
                      <KeyValue
                        cols={1}
                        items={[
                          { label: "工作 ID", value: <CopyText value={job.job_id} mono /> },
                          { label: "模組", value: moduleLabel(job.module_key) },
                          { label: "執行的 Worker", value: job.worker_name || "尚未認領" },
                          { label: "建立 / 開始 / 結束", value: `${fmtDateTime(job.created_at, true)} → ${fmtDateTime(job.started_at, true)} → ${active ? "進行中" : fmtDateTime(job.finished_at, true)}` },
                          { label: "控制狀態", value: job.control_state || "idle" },
                          {
                            label: "上層工作",
                            hidden: !parentId,
                            value: parentId ? <Link to={`/jobs/${parentId}`}>{shortId(parentId)}</Link> : null,
                          },
                        ]}
                      />
                    </SectionCard>
                    <SectionCard title="步驟">
                      <QueryBoundary query={stepsQ} skeleton={<Box h={120} />}>
                        {({ steps }) => <StepsTimeline steps={steps} />}
                      </QueryBoundary>
                    </SectionCard>
                  </Stack>
                </Grid.Col>
                <Grid.Col span={{ base: 12, lg: 7 }}>
                  <Stack gap="lg">
                    <LogsPanel jobId={job.job_id} active={active} />
                    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
                      <SectionCard title="工作參數">
                        {Object.keys(job.job_options ?? {}).length ? (
                          <JsonView value={job.job_options} maxHeight={260} />
                        ) : (
                          <Text fz="sm" c="dimmed">
                            使用預設參數
                          </Text>
                        )}
                      </SectionCard>
                      <SectionCard title="結果摘要">
                        {Object.keys(job.result_summary ?? {}).length ? (
                          <JsonView value={job.result_summary} maxHeight={260} />
                        ) : (
                          <Text fz="sm" c="dimmed">
                            {active ? "完成後顯示" : "沒有結果摘要"}
                          </Text>
                        )}
                      </SectionCard>
                    </SimpleGrid>
                  </Stack>
                </Grid.Col>
              </Grid>
            </Stack>
            <Title order={6} c="dimmed" mt="xl" fw={400} fz="xs">
              資料每 3 秒更新；日誌透過 WebSocket 即時推送。
            </Title>
          </>
        );
      }}
    </QueryBoundary>
  );
}

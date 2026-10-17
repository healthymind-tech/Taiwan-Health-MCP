// Drug index URL-fetch schedule. The backend stores UTC; operators pick Taiwan
// time (UTC+8) and we convert, including the day shift for times before 08:00.

import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { IconAlertTriangle, IconCalendarTime, IconPlayerPlay, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { KeyValue } from "@/components/KeyValue";
import { SectionCard } from "@/components/SectionCard";
import { JobStatusBadge } from "@/components/StatusBadge";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import { ApiError, api, errorMessage } from "@/lib/api";
import { fmtDateTime, fmtRelative, shortId } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { WEEKDAYS_ZH } from "@/lib/meta";
import { qk } from "@/lib/queryKeys";
import type { Schedule } from "@/lib/types";
import { DRUG_MODULE_KEY, DRUG_SOURCE_ROLE } from "./drugMeta";

const TW_OFFSET = 8;
type Freq = "daily" | "weekly" | "monthly";

interface TwTime {
  hour: number;
  minute: number;
  /** 0 = Mon … 6 = Sun (backend convention). */
  dow: number | null;
  dom: number | null;
}

/** UTC schedule fields → Taiwan wall-clock. */
function utcToTw(s: Pick<Schedule, "hour_utc" | "minute_utc" | "day_of_week" | "day_of_month">): TwTime {
  const h = s.hour_utc + TW_OFFSET;
  const carry = h >= 24 ? 1 : 0;
  return {
    hour: h % 24,
    minute: s.minute_utc,
    dow: s.day_of_week === null ? null : (s.day_of_week + carry) % 7,
    dom: s.day_of_month === null ? null : s.day_of_month + carry,
  };
}

/** Taiwan wall-clock → UTC fields; returns an error string when unrepresentable. */
function twToUtc(freq: Freq, tw: TwTime): { hour_utc: number; minute_utc: number; day_of_week: number | null; day_of_month: number | null } | string {
  const h = tw.hour - TW_OFFSET;
  const borrow = h < 0 ? 1 : 0;
  const hour_utc = (h + 24) % 24;
  let day_of_week: number | null = null;
  let day_of_month: number | null = null;
  if (freq === "weekly") day_of_week = (((tw.dow ?? 0) - borrow) % 7 + 7) % 7;
  if (freq === "monthly") {
    const d = (tw.dom ?? 1) - borrow;
    if (d < 1) return "每月 1 日 08:00 以前的時間在 UTC 屬於上個月，無法設定；請改選 08:00 之後或其他日期。";
    day_of_month = d;
  }
  return { hour_utc, minute_utc: tw.minute, day_of_week, day_of_month };
}

function describe(s: Schedule): string {
  const tw = utcToTw(s);
  const time = `${String(tw.hour).padStart(2, "0")}:${String(tw.minute).padStart(2, "0")}`;
  if (s.frequency === "daily") return `每天 ${time}（台灣時間）`;
  if (s.frequency === "weekly") return `每${WEEKDAYS_ZH[tw.dow ?? 0]} ${time}（台灣時間）`;
  return `每月 ${tw.dom ?? 1} 日 ${time}（台灣時間）`;
}

const HOURS = Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: `${String(i).padStart(2, "0")} 時` }));
const MINUTES = Array.from({ length: 12 }, (_, i) => ({ value: String(i * 5), label: `${String(i * 5).padStart(2, "0")} 分` }));
const DOW = WEEKDAYS_ZH.map((d, i) => ({ value: String(i), label: d }));
const DOM = Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 日` }));

export function DrugSchedule() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const q = useQuery({
    queryKey: qk.moduleSchedule(DRUG_MODULE_KEY),
    queryFn: () => api.get<{ schedule: Schedule | null }>(`/admin/api/modules/${DRUG_MODULE_KEY}/schedule`),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.moduleSchedule(DRUG_MODULE_KEY) });
    void qc.invalidateQueries({ queryKey: qk.jobs });
  };

  const toggle = useMutation({
    mutationFn: (s: Schedule & { is_enabled: boolean }) =>
      api.post(`/admin/api/modules/${DRUG_MODULE_KEY}/schedule`, {
        frequency: s.frequency,
        hour_utc: s.hour_utc,
        minute_utc: s.minute_utc,
        day_of_week: s.day_of_week,
        day_of_month: s.day_of_month,
        fetch_url: s.fetch_url,
        source_role: s.source_role ?? DRUG_SOURCE_ROLE,
        is_enabled: s.is_enabled,
      }),
    onSuccess: (_d, s) => {
      invalidate();
      notify.success(s.is_enabled ? "排程已啟用" : "排程已停用");
    },
    onError: (e) => notify.error(e),
  });
  const trigger = useMutation({
    mutationFn: () => api.post(`/admin/api/modules/${DRUG_MODULE_KEY}/schedule/trigger`),
    onSuccess: () => {
      notify.success("已在背景下載並建立工作，稍後可在「工作」頁查看進度。", "排程已觸發");
      setTimeout(invalidate, 2500);
    },
    onError: (e) => notify.error(e, "觸發失敗"),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/admin/api/modules/${DRUG_MODULE_KEY}/schedule`),
    onSuccess: () => {
      invalidate();
      notify.success("已刪除排程");
    },
    onError: (e) => notify.error(e, "刪除失敗"),
  });

  const sched = q.data?.schedule ?? null;

  return (
    <SectionCard
      title="自動更新排程"
      icon={<IconCalendarTime size={18} />}
      description="定期從指定網址下載最新的許可證 CSV 並建立藥品工作。時間以台灣時間（UTC+8）設定。"
      actions={
        sched ? (
          <Group gap="xs" wrap="wrap">
            <Switch
              label={sched.is_enabled ? "已啟用" : "已停用"}
              checked={sched.is_enabled}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate({ ...sched, is_enabled: e.currentTarget.checked })}
            />
            <Button size="xs" variant="default" onClick={() => setEditing(true)}>
              編輯
            </Button>
          </Group>
        ) : undefined
      }
    >
      {q.isPending ? (
        <Text fz="sm" c="dimmed">
          載入中…
        </Text>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !sched ? (
        <EmptyState
          compact
          icon={<IconCalendarTime size={22} />}
          title="尚未設定排程"
          description="設定後，系統會依排程下載 CSV 並自動建立工作，不需手動上傳。"
          action={<Button onClick={() => setEditing(true)}>設定排程</Button>}
        />
      ) : (
        <Stack gap="md">
          <KeyValue
            cols={3}
            items={[
              { label: "頻率", value: describe(sched) },
              { label: "下次執行", value: sched.is_enabled ? `${fmtDateTime(sched.next_run_at)}（${fmtRelative(sched.next_run_at)}）` : "排程已停用" },
              {
                label: "上次執行",
                value: sched.last_run_at ? (
                  <Group gap={6} wrap="wrap">
                    <Text fz="sm">{fmtRelative(sched.last_run_at)}</Text>
                    {sched.last_run_status && <JobStatusBadge status={sched.last_run_status} size="xs" />}
                    {sched.last_run_job_id && (
                      <Anchor component={Link} to={`/jobs/${sched.last_run_job_id}`} fz="xs" ff="monospace">
                        {shortId(sched.last_run_job_id)}
                      </Anchor>
                    )}
                  </Group>
                ) : (
                  "尚未執行"
                ),
              },
              { label: "下載網址", value: <Text fz="sm" ff="monospace" style={{ wordBreak: "break-all" }}>{sched.fetch_url}</Text>, full: true },
              { label: "上次錯誤", value: <Text fz="sm" c="red" style={{ wordBreak: "break-word" }}>{sched.last_error}</Text>, full: true, hidden: !sched.last_error },
            ]}
          />
          <Group gap="xs" wrap="wrap">
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlayerPlay size={14} />}
              loading={trigger.isPending}
              onClick={() =>
                confirmAction({
                  title: "立即執行排程？",
                  message: "系統會立刻從下載網址取得 CSV、存成新的上傳檔，並建立藥品工作。",
                  confirmLabel: "立即執行",
                  onConfirm: () => trigger.mutateAsync(),
                })
              }
            >
              立即執行
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="red"
              leftSection={<IconTrash size={14} />}
              loading={remove.isPending}
              onClick={() =>
                confirmAction({
                  title: "刪除排程？",
                  consequences: ["之後不會再自動下載與匯入", "已上傳的檔案與已匯入的資料不受影響"],
                  confirmLabel: "刪除排程",
                  danger: true,
                  onConfirm: () => remove.mutateAsync(),
                })
              }
            >
              刪除排程
            </Button>
          </Group>
        </Stack>
      )}
      <ScheduleModal opened={editing} onClose={() => setEditing(false)} current={sched} onSaved={invalidate} />
    </SectionCard>
  );
}

function ScheduleModal({ opened, onClose, current, onSaved }: { opened: boolean; onClose: () => void; current: Schedule | null; onSaved: () => void }) {
  const isMobile = useIsMobile();
  const [url, setUrl] = useState("");
  const [freq, setFreq] = useState<Freq>("weekly");
  const [tw, setTw] = useState<TwTime>({ hour: 3, minute: 0, dow: 0, dom: 1 });
  const [enabled, setEnabled] = useState(true);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setUrlError(null);
    setFormError(null);
    if (current) {
      const t = utcToTw(current);
      setUrl(current.fetch_url ?? "");
      setFreq(current.frequency);
      // Monthly day 29 can only appear after a UTC→TW carry; clamp for editing.
      setTw({ hour: t.hour, minute: t.minute - (t.minute % 5), dow: t.dow ?? 0, dom: Math.min(t.dom ?? 1, 28) });
      setEnabled(current.is_enabled);
    } else {
      setUrl("");
      setFreq("weekly");
      setTw({ hour: 3, minute: 0, dow: 0, dom: 1 });
      setEnabled(true);
    }
  }, [opened, current]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/admin/api/modules/${DRUG_MODULE_KEY}/schedule`, body),
    onSuccess: () => {
      notify.success("排程已儲存");
      onSaved();
      onClose();
    },
    onError: (e) => {
      const msg = errorMessage(e);
      if (e instanceof ApiError && e.status === 400 && /fetch_url/i.test(msg)) setUrlError(msg);
      else if (e instanceof ApiError && e.status === 400) setFormError(msg);
      notify.error(e, "儲存失敗");
    },
  });

  const submit = () => {
    const u = url.trim();
    if (!u) return setUrlError("請輸入下載網址");
    if (!/^https:\/\//i.test(u)) return setUrlError("網址必須以 https:// 開頭");
    try {
      new URL(u);
    } catch {
      return setUrlError("網址格式不正確");
    }
    const conv = twToUtc(freq, tw);
    if (typeof conv === "string") return setFormError(conv);
    save.mutate({ frequency: freq, ...conv, fetch_url: u, source_role: DRUG_SOURCE_ROLE, is_enabled: enabled });
  };

  const conv = twToUtc(freq, tw);

  return (
    <Modal opened={opened} onClose={onClose} size="lg" fullScreen={isMobile} title={<Text fw={650} fz="lg">{current ? "編輯排程" : "設定排程"}</Text>}>
      <Stack gap="md">
        <TextInput
          label="CSV 下載網址"
          description="必須是 HTTPS。每次執行會下載這個網址的內容，存成新的上傳檔再建立工作。"
          placeholder="https://data.fda.gov.tw/…"
          value={url}
          onChange={(e) => {
            setUrl(e.currentTarget.value);
            setUrlError(null);
          }}
          error={urlError}
          required
          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
        />
        <Stack gap={6}>
          <Text fz="sm" fw={600}>
            頻率
          </Text>
          <SegmentedControl
            fullWidth
            value={freq}
            onChange={(v) => {
              setFreq(v as Freq);
              setFormError(null);
            }}
            data={[
              { value: "daily", label: "每天" },
              { value: "weekly", label: "每週" },
              { value: "monthly", label: "每月" },
            ]}
          />
        </Stack>
        <SimpleGrid cols={{ base: 1, xs: freq === "daily" ? 2 : 3 }} spacing="sm">
          {freq === "weekly" && (
            <Select label="星期" data={DOW} value={String(tw.dow ?? 0)} onChange={(v) => setTw((t) => ({ ...t, dow: Number(v ?? 0) }))} allowDeselect={false} />
          )}
          {freq === "monthly" && (
            <Select
              label="日期"
              data={DOM}
              value={String(tw.dom ?? 1)}
              onChange={(v) => {
                setTw((t) => ({ ...t, dom: Number(v ?? 1) }));
                setFormError(null);
              }}
              allowDeselect={false}
              description="最多到 28 日，確保每個月都會執行"
            />
          )}
          <Select
            label="時（台灣時間）"
            data={HOURS}
            value={String(tw.hour)}
            onChange={(v) => {
              setTw((t) => ({ ...t, hour: Number(v ?? 0) }));
              setFormError(null);
            }}
            allowDeselect={false}
          />
          <Select label="分" data={MINUTES} value={String(tw.minute)} onChange={(v) => setTw((t) => ({ ...t, minute: Number(v ?? 0) }))} allowDeselect={false} />
        </SimpleGrid>
        {typeof conv !== "string" && (
          <Text fz="xs" c="dimmed">
            伺服器將以 UTC {String(conv.hour_utc).padStart(2, "0")}:{String(conv.minute_utc).padStart(2, "0")}
            {conv.day_of_week !== null ? `（UTC ${WEEKDAYS_ZH[conv.day_of_week]}）` : ""}
            {conv.day_of_month !== null ? `（UTC 每月 ${conv.day_of_month} 日）` : ""} 儲存。
          </Text>
        )}
        {formError && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} p="sm">
            {formError}
          </Alert>
        )}
        <Switch label="啟用排程" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
        <Alert color="amber" variant="light" icon={<IconAlertTriangle size={18} />} p="sm">
          <Text fz="xs">
            排程建立的是 <Badge size="xs" variant="light" style={{ textTransform: "none" }}>drug_pipeline</Badge> 工作，且目前不帶批次上限；請確認 OCR 與 Analysis LM 端點可用，並留意第一次執行可能處理大量許可證。
          </Text>
        </Alert>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} disabled={save.isPending}>
            取消
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            儲存排程
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

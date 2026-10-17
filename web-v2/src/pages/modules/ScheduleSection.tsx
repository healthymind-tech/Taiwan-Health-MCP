import { Alert, Anchor, Badge, Button, Group, SegmentedControl, Select, SimpleGrid, Stack, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconCalendarTime, IconPlayerPlay, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { SectionCard } from "@/components/SectionCard";
import { KeyValue } from "@/components/KeyValue";
import { RelativeTime } from "@/components/RelativeTime";
import { ErrorState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/QueryBoundary";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import { api, ApiError, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { WEEKDAYS_ZH, type ModuleMeta } from "@/lib/meta";
import { dayjs } from "@/lib/format";
import type { CatalogEntry, Schedule } from "@/lib/types";
import { useModuleSchedule } from "./moduleData";
import { roleLabel } from "./SourcesSection";

/** Modules whose schedule downloads a file from `fetch_url` (adminSchedule.ts URL_FETCH_MODULES). */
const URL_FETCH_MODULES = new Set(["icd", "ig", "drug"]);
const TW_OFFSET_MIN = 8 * 60;

type Freq = "daily" | "weekly" | "monthly";

interface LocalForm {
  enabled: boolean;
  frequency: Freq;
  /** 0 = Monday … 6 = Sunday (backend convention), Taiwan local. */
  dow: number;
  /** Taiwan local day of month. */
  dom: number;
  hour: number;
  minute: number;
  fetchUrl: string;
  sourceRole: string;
}

interface UtcValues {
  hour_utc: number;
  minute_utc: number;
  day_of_week: number | null;
  day_of_month: number | null;
}

/** Taiwan local (UTC+8) → UTC fields; returns an error when the backend cannot represent it. */
export function toUtc(f: Pick<LocalForm, "frequency" | "dow" | "dom" | "hour" | "minute">): UtcValues | { error: string } {
  let total = f.hour * 60 + f.minute - TW_OFFSET_MIN;
  let shift = 0;
  if (total < 0) {
    total += 1440;
    shift = -1;
  }
  const out: UtcValues = { hour_utc: Math.floor(total / 60), minute_utc: total % 60, day_of_week: null, day_of_month: null };
  if (f.frequency === "weekly") out.day_of_week = (f.dow + shift + 7) % 7;
  if (f.frequency === "monthly") {
    const d = f.dom + shift;
    if (d < 1 || d > 28) {
      return {
        error:
          d < 1
            ? "台灣時間每月 1 日 08:00 以前，換算成 UTC 會落在上個月的最後一天，系統無法表示。請改選 2 日以後，或 08:00 之後的時間。"
            : "換算成 UTC 後日期超過 28 日，系統只支援 1–28 日。請改選較早的日期或 08:00 之後。",
      };
    }
    out.day_of_month = d;
  }
  return out;
}

/** UTC fields → Taiwan local form values. */
function fromUtc(s: Schedule): Pick<LocalForm, "dow" | "dom" | "hour" | "minute"> {
  let total = s.hour_utc * 60 + s.minute_utc + TW_OFFSET_MIN;
  let shift = 0;
  if (total >= 1440) {
    total -= 1440;
    shift = 1;
  }
  return {
    hour: Math.floor(total / 60),
    minute: total % 60,
    dow: s.day_of_week === null ? 0 : (s.day_of_week + shift) % 7,
    dom: s.day_of_month === null ? 1 : s.day_of_month + shift,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

function describe(freq: Freq, dow: number | null, dom: number | null, h: number, m: number): string {
  const time = `${pad(h)}:${pad(m)}`;
  if (freq === "weekly") return `每${WEEKDAYS_ZH[dow ?? 0]} ${time}`;
  if (freq === "monthly") return `每月 ${dom ?? 1} 日 ${time}`;
  return `每天 ${time}`;
}

const STATUS_COPY: Record<string, { label: string; color: string }> = {
  success: { label: "已建立工作", color: "teal" },
  failed: { label: "失敗", color: "red" },
};

export function ScheduleSection({ meta, entries }: { meta: ModuleMeta; entries: CatalogEntry[] }) {
  const qc = useQueryClient();
  const q = useModuleSchedule(meta.key, meta.schedulable);
  const needsUrl = URL_FETCH_MODULES.has(meta.key);
  const existing = q.data?.schedule ?? null;

  const initial = useMemo<LocalForm>(() => {
    if (existing) {
      return {
        enabled: existing.is_enabled,
        frequency: existing.frequency,
        ...fromUtc(existing),
        fetchUrl: existing.fetch_url ?? "",
        sourceRole: existing.source_role ?? entries[0]?.source_role ?? "",
      };
    }
    return { enabled: true, frequency: "weekly", dow: 0, dom: 1, hour: 3, minute: 0, fetchUrl: "", sourceRole: entries[0]?.source_role ?? "" };
  }, [existing, entries]);

  const [form, setForm] = useState<LocalForm>(initial);
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => setForm(initial), [initial]);
  const set = <K extends keyof LocalForm>(k: K, v: LocalForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setServerError(null);
  };

  const utc = toUtc(form);
  const urlError =
    needsUrl && form.fetchUrl && !form.fetchUrl.toLowerCase().startsWith("https://") ? "必須是 https:// 開頭的網址" : null;
  const formError = "error" in utc ? utc.error : null;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.moduleSchedule(meta.key) });
    void qc.invalidateQueries({ queryKey: qk.jobs });
  };

  const save = useMutation({
    mutationFn: () => {
      if ("error" in utc) throw new Error(utc.error);
      return api.post<{ schedule: Schedule }>(`/admin/api/modules/${meta.key}/schedule`, {
        frequency: form.frequency,
        ...utc,
        is_enabled: form.enabled,
        fetch_url: needsUrl ? form.fetchUrl.trim() : null,
        source_role: needsUrl ? form.sourceRole : null,
      });
    },
    onSuccess: () => notify.success(existing ? "排程已更新" : "排程已建立"),
    onError: (e) => {
      if (e instanceof ApiError && e.status === 400) setServerError(e.message);
      else notify.error(e, "儲存排程失敗");
    },
    onSettled: invalidate,
  });
  const del = useMutation({
    mutationFn: () => api.del<{ deleted: boolean }>(`/admin/api/modules/${meta.key}/schedule`),
    onSettled: invalidate,
  });
  const trigger = useMutation({
    mutationFn: () => api.post<{ triggered: boolean }>(`/admin/api/modules/${meta.key}/schedule/trigger`),
    onSettled: () => {
      // The fire runs in the background; refresh shortly after for last-run fields.
      setTimeout(invalidate, 2500);
      invalidate();
    },
  });

  if (!meta.schedulable) return null;

  const hourOptions = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: pad(h) }));
  const minuteValues = new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, form.minute]);
  const minuteOptions = [...minuteValues].sort((a, b) => a - b).map((m) => ({ value: String(m), label: pad(m) }));
  const domOptions = Array.from({ length: Math.max(28, form.dom) }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 日` }));

  const localDesc = describe(form.frequency, form.dow, form.dom, form.hour, form.minute);
  const utcDesc =
    "error" in utc ? "—" : describe(form.frequency, utc.day_of_week, utc.day_of_month, utc.hour_utc, utc.minute_utc);

  return (
    <SectionCard
      title="自動排程"
      icon={<IconCalendarTime size={18} />}
      description={
        needsUrl
          ? "定期從指定網址下載新的來源檔並自動匯入。時間以台灣時間（UTC+8）設定，系統以 UTC 儲存。"
          : "定期從上游自動同步。時間以台灣時間（UTC+8）設定，系統以 UTC 儲存。"
      }
      actions={
        existing ? (
          <Badge color={existing.is_enabled ? "teal" : "gray"} variant="light">
            {existing.is_enabled ? "排程啟用中" : "排程已暫停"}
          </Badge>
        ) : (
          <Badge color="gray" variant="light">
            尚未設定
          </Badge>
        )
      }
    >
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <PageSkeleton rows={1} />
      ) : (
        <Stack gap="md">
          {existing && (
            <KeyValue
              cols={4}
              items={[
                {
                  label: "下次執行",
                  value: existing.is_enabled && existing.next_run_at ? (
                    <Stack gap={0}>
                      <Text fz="sm">{dayjs(existing.next_run_at).utcOffset(8).format("YYYY-MM-DD HH:mm")}（台灣）</Text>
                      <RelativeTime value={existing.next_run_at} fz="xs" c="dimmed" />
                    </Stack>
                  ) : (
                    <Text fz="sm" c="dimmed">已暫停</Text>
                  ),
                },
                {
                  label: "上次執行",
                  value: existing.last_run_at ? (
                    <Stack gap={0}>
                      <Text fz="sm">{dayjs(existing.last_run_at).utcOffset(8).format("YYYY-MM-DD HH:mm")}（台灣）</Text>
                      <RelativeTime value={existing.last_run_at} fz="xs" c="dimmed" />
                    </Stack>
                  ) : (
                    "從未執行"
                  ),
                },
                {
                  label: "上次結果",
                  value: existing.last_run_status ? (
                    <Group gap={6}>
                      <Badge size="sm" variant="light" color={STATUS_COPY[existing.last_run_status]?.color ?? "gray"}>
                        {STATUS_COPY[existing.last_run_status]?.label ?? existing.last_run_status}
                      </Badge>
                      {existing.last_run_job_id && (
                        <Anchor component={Link} to={`/jobs/${existing.last_run_job_id}`} fz="sm">
                          查看工作
                        </Anchor>
                      )}
                    </Group>
                  ) : null,
                },
                { label: "儲存值（UTC）", value: <Text fz="sm" ff="monospace">{describe(existing.frequency, existing.day_of_week, existing.day_of_month, existing.hour_utc, existing.minute_utc)}</Text> },
                {
                  label: "上次錯誤",
                  full: true,
                  hidden: !existing.last_error,
                  value: (
                    <Text fz="sm" c="red" style={{ wordBreak: "break-word" }}>
                      {existing.last_error}
                    </Text>
                  ),
                },
              ]}
            />
          )}

          <Switch
            checked={form.enabled}
            onChange={(e) => set("enabled", e.currentTarget.checked)}
            label="啟用排程"
            description="關閉後保留設定，但不會自動執行。"
          />

          <Stack gap={4}>
            <Text fz="sm" fw={500}>
              頻率
            </Text>
            <SegmentedControl
              data={[
                { value: "daily", label: "每天" },
                { value: "weekly", label: "每週" },
                { value: "monthly", label: "每月" },
              ]}
              value={form.frequency}
              onChange={(v) => set("frequency", v as Freq)}
              style={{ alignSelf: "flex-start" }}
            />
          </Stack>

          <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="sm">
            {form.frequency === "weekly" && (
              <Select
                label="星期（台灣時間）"
                data={WEEKDAYS_ZH.map((d, i) => ({ value: String(i), label: d }))}
                value={String(form.dow)}
                onChange={(v) => set("dow", Number(v ?? 0))}
                allowDeselect={false}
              />
            )}
            {form.frequency === "monthly" && (
              <Select
                label="日期（台灣時間）"
                data={domOptions}
                value={String(form.dom)}
                onChange={(v) => set("dom", Number(v ?? 1))}
                allowDeselect={false}
                error={formError}
              />
            )}
            <Select
              label="時（台灣時間）"
              data={hourOptions}
              value={String(form.hour)}
              onChange={(v) => set("hour", Number(v ?? 0))}
              allowDeselect={false}
            />
            <Select
              label="分"
              data={minuteOptions}
              value={String(form.minute)}
              onChange={(v) => set("minute", Number(v ?? 0))}
              allowDeselect={false}
            />
          </SimpleGrid>
          <Text fz="sm">
            <Text span fw={600}>{localDesc}</Text>（台灣時間）
            <Text span c="dimmed"> ＝ UTC {utcDesc}</Text>
          </Text>

          {needsUrl && (
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <Select
                label="下載後作為哪一個來源檔"
                description="每次排程只會下載這一個檔案；其他來源檔沿用目前上傳的版本。"
                data={entries.map((e) => ({ value: e.source_role, label: roleLabel(e) }))}
                value={form.sourceRole}
                onChange={(v) => set("sourceRole", v ?? "")}
                allowDeselect={false}
              />
              <TextInput
                label="下載網址"
                description="僅接受 HTTPS。"
                placeholder="https://…"
                value={form.fetchUrl}
                onChange={(e) => set("fetchUrl", e.currentTarget.value)}
                error={urlError}
                styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
              />
            </SimpleGrid>
          )}

          {serverError && (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} p="sm">
              <Text fz="sm">{serverError}</Text>
            </Alert>
          )}

          <Group justify="space-between" gap="xs" wrap="wrap">
            <Group gap="xs" wrap="wrap">
              {existing && (
                <>
                  <Button
                    variant="default"
                    leftSection={<IconPlayerPlay size={16} />}
                    loading={trigger.isPending}
                    onClick={() =>
                      confirmAction({
                        title: "立即執行排程？",
                        message: needsUrl
                          ? "會立刻依目前儲存的設定下載檔案並建立匯入工作，不影響下次排定時間以外的設定。"
                          : "會立刻建立一個同步工作，並重新計算下次執行時間。",
                        confirmLabel: "立即執行",
                        onConfirm: async () => {
                          try {
                            await trigger.mutateAsync();
                            notify.success("已觸發，背景執行中。結果會顯示在「上次結果」與工作列表。", "排程已觸發");
                          } catch (e) {
                            notify.error(e, "觸發失敗");
                            throw e;
                          }
                        },
                      })
                    }
                  >
                    立即執行一次
                  </Button>
                  <Button
                    variant="subtle"
                    color="red"
                    leftSection={<IconTrash size={16} />}
                    loading={del.isPending}
                    onClick={() =>
                      confirmAction({
                        title: "刪除排程？",
                        danger: true,
                        consequences: ["此模組不再自動更新", "已匯入的資料與過去的工作紀錄都會保留"],
                        confirmLabel: "刪除排程",
                        onConfirm: async () => {
                          try {
                            await del.mutateAsync();
                            notify.success("排程已刪除");
                          } catch (e) {
                            notify.error(e, "刪除排程失敗");
                            throw e;
                          }
                        },
                      })
                    }
                  >
                    刪除排程
                  </Button>
                </>
              )}
            </Group>
            <Tooltip
              label={formError ?? urlError ?? (needsUrl && !form.fetchUrl.trim() ? "請填寫下載網址" : null)}
              disabled={!(formError || urlError || (needsUrl && !form.fetchUrl.trim()))}
              multiline
              maw={280}
            >
              <Button
                onClick={() => save.mutate()}
                loading={save.isPending}
                disabled={Boolean(formError || urlError) || (needsUrl && !form.fetchUrl.trim()) || (Boolean(existing) && !dirty)}
              >
                {existing ? "儲存變更" : "建立排程"}
              </Button>
            </Tooltip>
          </Group>
          {save.isError && !serverError && (
            <Text fz="xs" c="red">
              {errorMessage(save.error)}
            </Text>
          )}
        </Stack>
      )}
    </SectionCard>
  );
}

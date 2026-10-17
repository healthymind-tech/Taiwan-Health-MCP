import { Alert, Anchor, Badge, Box, Button, Checkbox, Group, Progress, SimpleGrid, Stack, Text, Tooltip } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconArchive,
  IconBox,
  IconDatabase,
  IconDownload,
  IconExternalLink,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { notify } from "@/components/notify";
import { RelativeTime } from "@/components/RelativeTime";
import { SectionCard } from "@/components/SectionCard";
import { JobStatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { durationBetween, fmtBytes, fmtDuration, fmtNumber, shortId } from "@/lib/format";
import { useStartJob } from "@/lib/jobs";
import { ACTIVE_STATUSES } from "@/lib/meta";
import { qk } from "@/lib/queryKeys";

/** Row shape from adminBackup.listBackups(). */
interface BackupItem {
  job_id: string;
  status: string;
  progress_current: number;
  progress_total: number;
  current_step: string;
  selection: Partial<Selection>;
  result: {
    filename?: string;
    archive_bytes?: number;
    source_object_count?: number;
  };
  created_at: string;
  finished_at: string;
  error: string;
}

interface Selection {
  settings: boolean;
  database: boolean;
  object_storage: boolean;
}

const COMPONENTS: { key: keyof Selection; label: string; description: string; icon: ReactNode }[] = [
  {
    key: "settings",
    label: "系統設定",
    description: "所有可攜設定、模型端點（含 API 金鑰明文）與 passkey 公鑰。體積很小。",
    icon: <IconSettings size={18} />,
  },
  {
    key: "database",
    label: "資料庫",
    description: "完整 PostgreSQL dump（pg_dump custom 格式），包含所有匯入的術語、藥品資料與工作紀錄。可能數 GB。",
    icon: <IconDatabase size={18} />,
  },
  {
    key: "object_storage",
    label: "物件儲存",
    description: "MinIO 中的上傳來源檔與藥品資產（仿單 PDF、外觀圖）。不含先前的備份檔。",
    icon: <IconBox size={18} />,
  },
];

function stepLabel(step: string): string {
  if (!step) return "";
  const m = /^backing_up_objects_(\d+)_of_(\d+)$/.exec(step);
  if (m) return `打包物件 ${fmtNumber(Number(m[1]))} / ${fmtNumber(Number(m[2]))}`;
  const map: Record<string, string> = {
    queued: "排隊中",
    manifest_written: "已寫入 manifest",
    settings_exported: "已匯出設定",
    database_exported: "已匯出資料庫",
    completed: "完成",
  };
  return map[step] ?? step;
}

export function BackupsSection() {
  const qc = useQueryClient();
  const startJob = useStartJob();
  const [selection, setSelection] = useState<Selection>({ settings: true, database: true, object_storage: true });
  const q = useQuery({
    queryKey: qk.backups,
    queryFn: () => api.get<{ backups: BackupItem[] }>("/admin/api/backups"),
    refetchInterval: (query) => (query.state.data?.backups.some((b) => ACTIVE_STATUSES.has(b.status)) ? 3_000 : false),
  });

  const backups = q.data?.backups ?? [];
  const active = backups.find((b) => ACTIVE_STATUSES.has(b.status)) ?? null;
  const nothingSelected = !selection.settings && !selection.database && !selection.object_storage;

  const create = () => {
    startJob.mutate(
      { job_type: "system_backup", module_key: "admin", job_options: { selection } },
      {
        onSuccess: (r) => {
          void qc.invalidateQueries({ queryKey: qk.backups });
          const id = r.job?.job_id;
          notify.success(
            <>
              備份工作已排入佇列，完成後可在下方列表下載。
              {id && (
                <>
                  {" "}
                  <Anchor component={Link} to={`/jobs/${id}`} fz="sm">
                    查看工作
                  </Anchor>
                </>
              )}
            </>,
            "已開始備份",
          );
        },
        onError: (err) => notify.error(err, "無法建立備份"),
      },
    );
  };

  const columns: Column<BackupItem>[] = [
    {
      key: "created",
      header: "建立時間",
      primary: true,
      sortValue: (b) => b.created_at,
      render: (b) => (
        <Stack gap={0}>
          <RelativeTime value={b.created_at} fz="sm" fw={500} />
          <Text fz="xs" c="dimmed" ff="monospace">
            {shortId(b.job_id)}
          </Text>
        </Stack>
      ),
    },
    {
      key: "status",
      header: "狀態",
      render: (b) =>
        b.error ? (
          <Tooltip label={b.error} multiline w={320}>
            <span>
              <JobStatusBadge status={b.status} />
            </span>
          </Tooltip>
        ) : (
          <JobStatusBadge status={b.status} />
        ),
    },
    {
      key: "components",
      header: "內容",
      render: (b) => (
        <Group gap={4} wrap="wrap" justify="flex-start">
          {COMPONENTS.filter((c) => (c.key === "settings" ? b.selection.settings !== false : Boolean(b.selection[c.key]))).map((c) => (
            <Badge key={c.key} size="sm" variant="light" color="gray" tt="none" fw={500}>
              {c.label}
            </Badge>
          ))}
        </Group>
      ),
    },
    {
      key: "size",
      header: "大小",
      align: "right",
      nowrap: true,
      sortValue: (b) => b.result.archive_bytes ?? -1,
      render: (b) =>
        b.result.archive_bytes !== undefined ? (
          <Text fz="sm" className="tabular">
            {fmtBytes(b.result.archive_bytes)}
          </Text>
        ) : (
          <Text fz="sm" c="dimmed">
            —
          </Text>
        ),
    },
    {
      key: "duration",
      header: "耗時",
      hideOnMobile: true,
      nowrap: true,
      render: (b) => <Text fz="sm">{fmtDuration(durationBetween(b.created_at, b.finished_at || null))}</Text>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (b) => (
        <Group gap={6} justify="flex-end" wrap="nowrap">
          <Tooltip label="工作詳情與紀錄">
            <Button component={Link} to={`/jobs/${b.job_id}`} size="compact-sm" variant="subtle" color="gray" px={6} aria-label="工作詳情">
              <IconExternalLink size={14} />
            </Button>
          </Tooltip>
          {b.status === "success" ? (
            <Button
              component="a"
              href={`/admin/api/backups/${b.job_id}/download`}
              download={b.result.filename}
              size="compact-sm"
              variant="light"
              leftSection={<IconDownload size={14} />}
            >
              下載
            </Button>
          ) : (
            <Tooltip label={ACTIVE_STATUSES.has(b.status) ? "備份完成後才能下載" : "這次備份沒有成功，沒有可下載的檔案"}>
              <Button size="compact-sm" variant="light" leftSection={<IconDownload size={14} />} disabled>
                下載
              </Button>
            </Tooltip>
          )}
        </Group>
      ),
    },
  ];

  return (
    <SectionCard
      title="系統備份"
      description="把設定、資料庫與物件儲存打包成一個 ZIP，存放在 MinIO 的 system-backups/ 之下，完成後可從這裡下載。"
      icon={<IconArchive size={18} />}
    >
      <Stack gap="lg">
        <Alert color="red" variant="light" icon={<IconShieldLock size={20} />} title="備份檔含有機密與可能與病患相關的資料">
          <Text fz="sm">
            備份包含 API 金鑰明文、資料庫中所有資料（可能含病患相關資料）與上傳檔案。請只下載到受管控、加密的儲存位置，
            依院內資安規範保管與銷毀，切勿以電子郵件或聊天工具傳送。
          </Text>
        </Alert>

        <Stack gap="sm">
          <Text fw={600} fz="sm">
            備份內容
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
            {COMPONENTS.map((c) => (
              <Checkbox.Card
                key={c.key}
                radius="md"
                p="md"
                checked={selection[c.key]}
                onClick={() => setSelection((s) => ({ ...s, [c.key]: !s[c.key] }))}
                disabled={Boolean(active)}
              >
                <Group wrap="nowrap" align="flex-start" gap="sm">
                  <Checkbox.Indicator mt={2} />
                  <Box>
                    <Group gap={6}>
                      {c.icon}
                      <Text fw={600} fz="sm">
                        {c.label}
                      </Text>
                    </Group>
                    <Text fz="xs" c="dimmed" mt={4}>
                      {c.description}
                    </Text>
                  </Box>
                </Group>
              </Checkbox.Card>
            ))}
          </SimpleGrid>
          <Group justify="space-between" gap="sm" wrap="wrap">
            <Text fz="xs" c={nothingSelected ? "red" : "dimmed"}>
              {nothingSelected ? "請至少選擇一項。" : "資料庫備份期間系統仍可使用；一次只能執行一個備份。"}
            </Text>
            <Tooltip
              label={active ? "已有備份正在進行，請等它完成" : "請至少選擇一項備份內容"}
              disabled={!active && !nothingSelected}
            >
              <Button leftSection={<IconArchive size={16} />} onClick={create} loading={startJob.isPending} disabled={Boolean(active) || nothingSelected}>
                建立備份
              </Button>
            </Tooltip>
          </Group>
        </Stack>

        {active && (
          <Box p="md" style={{ border: "1px solid var(--mantine-color-blue-light-color)", borderRadius: "var(--mantine-radius-md)", background: "var(--mantine-color-blue-light)" }}>
            <Group justify="space-between" gap="sm" wrap="wrap" mb="xs">
              <Group gap="sm">
                <JobStatusBadge status={active.status} />
                <Text fz="sm" fw={600}>
                  {stepLabel(active.current_step) || "準備中"}
                </Text>
              </Group>
              <Anchor component={Link} to={`/jobs/${active.job_id}`} fz="sm">
                查看工作紀錄
              </Anchor>
            </Group>
            <Progress
              value={active.progress_total > 0 ? (active.progress_current / active.progress_total) * 100 : 0}
              animated
              striped
              size="md"
              radius="xl"
            />
            <Text fz="xs" c="dimmed" mt={6}>
              {active.progress_total > 0 ? `${fmtNumber(active.progress_current)} / ${fmtNumber(active.progress_total)} 個項目` : "等待 worker 領取…"}
              {" · "}開始於 <RelativeTime value={active.created_at} span fz="xs" />
            </Text>
          </Box>
        )}

        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <Box mx="-lg" mb="-lg" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
            <DataTable
              columns={columns}
              rows={backups}
              rowKey={(b) => b.job_id}
              loading={q.isPending}
              pageSize={10}
              minWidth={760}
              empty={<EmptyState compact icon={<IconArchive size={20} />} title="尚無備份" description="選擇備份內容後按「建立備份」。" />}
            />
          </Box>
        )}
        <Text fz="xs" c="dimmed">
          列表顯示最近 50 次備份。備份檔會一直保留在 MinIO，目前無法從介面刪除；請定期由 MinIO 清理 system-backups/。
        </Text>
      </Stack>
    </SectionCard>
  );
}

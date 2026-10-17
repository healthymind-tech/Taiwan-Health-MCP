import { Alert, Badge, Box, Button, Card, Group, SimpleGrid, Stack, Text, ThemeIcon, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconFileZip, IconHistory, IconPlayerPause } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { SectionCard } from "@/components/SectionCard";
import { UploadDropzone } from "@/components/UploadDropzone";
import { CopyText } from "@/components/CopyText";
import { RelativeTime } from "@/components/RelativeTime";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import { api, qs, uploadFile } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import type { CatalogEntry, UploadedFile } from "@/lib/types";
import { REQUIRED_ROLES, ROLE_COPY, useInvalidateModule } from "./moduleData";
import { VersionHistoryModal } from "./VersionHistoryModal";

interface UploadResponse {
  duplicate: boolean;
  message?: string;
  uploaded_file: UploadedFile;
}

export interface SourceReadiness {
  ready: boolean;
  missing: CatalogEntry[];
  /** Roles with uploads but none active — the import still picks the newest upload. */
  inactiveOnly: CatalogEntry[];
}

export function sourceReadiness(moduleKey: string, entries: CatalogEntry[]): SourceReadiness {
  const required = new Set(REQUIRED_ROLES[moduleKey] ?? entries.map((e) => e.source_role));
  const missing: CatalogEntry[] = [];
  const inactiveOnly: CatalogEntry[] = [];
  for (const e of entries) {
    if (!required.has(e.source_role)) continue;
    if (e.active_source) continue;
    if (e.recent_uploads.length > 0) inactiveOnly.push(e);
    else missing.push(e);
  }
  return { ready: missing.length === 0, missing, inactiveOnly };
}

export function roleLabel(e: Pick<CatalogEntry, "source_role" | "label">): string {
  return ROLE_COPY[e.source_role]?.label ?? e.label;
}

function ValidationBadge({ status, error }: { status: string; error?: string }) {
  const s = (status || "").toLowerCase();
  const ok = ["accepted", "valid", "ok", "passed"].includes(s);
  const bad = ["rejected", "invalid", "failed"].includes(s);
  const color = ok ? "teal" : bad ? "red" : "gray";
  const label = ok ? "格式檢查通過" : bad ? "格式檢查失敗" : status || "未檢查";
  const badge = (
    <Badge size="sm" color={color} variant="light">
      {label}
    </Badge>
  );
  return error ? <Tooltip label={error} multiline maw={320}>{badge}</Tooltip> : badge;
}

function ActiveFile({ file }: { file: UploadedFile }) {
  return (
    <Stack gap={6}>
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <ThemeIcon variant="light" size={30} radius="md">
          <IconFileZip size={16} />
        </ThemeIcon>
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Text fz="sm" fw={600} style={{ wordBreak: "break-all" }}>
            {file.original_filename}
          </Text>
          <Text fz="xs" c="dimmed">
            {fmtBytes(file.size_bytes)} · {file.uploaded_by || "—"} 上傳於 <RelativeTime value={file.uploaded_at} fz="xs" />
          </Text>
        </Box>
      </Group>
      <Group gap="xs" wrap="wrap">
        <ValidationBadge status={file.validation_status} error={file.validation_error} />
        <Text fz="xs" c="dimmed">
          SHA-256
        </Text>
        <CopyText value={file.sha256} display={file.sha256 ? `${file.sha256.slice(0, 12)}…` : ""} mono />
      </Group>
    </Stack>
  );
}

function RoleCard({
  entry,
  moduleKey,
  required,
  maxUploadMb,
  busyReason,
  onHistory,
}: {
  entry: CatalogEntry;
  moduleKey: string;
  required: boolean;
  maxUploadMb: number;
  busyReason: string | null;
  onHistory: () => void;
}) {
  const invalidate = useInvalidateModule(moduleKey);
  const copy = ROLE_COPY[entry.source_role];
  const active = entry.active_source;

  const deactivate = useMutation({
    mutationFn: (id: string) => api.post("/admin/api/module-sources/deactivate", { uploaded_file_id: id }),
    onSuccess: () => notify.success("已停用此來源檔"),
    onError: (e) => notify.error(e, "停用失敗"),
    onSettled: invalidate,
  });

  const upload = async (file: File, onProgress: (l: number, t: number) => void, signal: AbortSignal) => {
    const res = await uploadFile<UploadResponse>(
      "/admin/api/uploads" +
        qs({ module_key: moduleKey, source_role: entry.source_role, filename: file.name, auto_activate: true }),
      file,
      (p) => onProgress(p.loaded, p.total),
      signal,
    );
    invalidate();
    if (res.duplicate) {
      notify.info(`伺服器已有內容相同的檔案（${res.uploaded_file.original_filename}），沿用既有版本，未重複儲存。`, "重複上傳");
    } else {
      notify.success(`${file.name} 已上傳並設為使用中。下一步：執行匯入。`, "上傳完成");
    }
  };

  return (
    <Card padding="md" withBorder>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" gap="xs" wrap="wrap">
          <Box style={{ minWidth: 0, flex: "1 1 200px" }}>
            <Group gap={6} wrap="wrap">
              <Text fw={650} fz="sm">
                {roleLabel(entry)}
              </Text>
              {required ? (
                <Badge size="xs" color="brand" variant="light">
                  必要
                </Badge>
              ) : (
                <Badge size="xs" color="gray" variant="light">
                  選用
                </Badge>
              )}
              {entry.multi_source && (
                <Badge size="xs" color="gray" variant="outline">
                  可多檔
                </Badge>
              )}
            </Group>
            <Text fz="xs" c="dimmed" mt={2}>
              {copy?.description ?? entry.description}
            </Text>
            <Text fz="xs" c="dimmed" ff="monospace" mt={2}>
              {entry.source_role} · {entry.accepted_extensions.join(" / ")}
            </Text>
          </Box>
          <Group gap={6} wrap="wrap">
            <Button size="xs" variant="default" leftSection={<IconHistory size={14} />} onClick={onHistory}>
              版本紀錄{entry.recent_uploads.length > 0 ? `（${entry.recent_uploads.length}）` : ""}
            </Button>
            {active && (
              <Tooltip label={busyReason ?? "停用後此角色不再標示為使用中檔案"} multiline maw={260}>
                <Button
                  size="xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconPlayerPause size={14} />}
                  loading={deactivate.isPending}
                  disabled={Boolean(busyReason)}
                  onClick={() =>
                    confirmAction({
                      title: "停用來源檔？",
                      message: (
                        <>
                          <Text span ff="monospace">{active.original_filename}</Text> 將不再是「{roleLabel(entry)}」的使用中檔案。
                          檔案本身與已匯入的資料都會保留，之後可在版本紀錄中重新啟用。
                        </>
                      ),
                      confirmLabel: "停用",
                      onConfirm: () => deactivate.mutateAsync(active.uploaded_file_id),
                    })
                  }
                >
                  停用
                </Button>
              </Tooltip>
            )}
          </Group>
        </Group>

        {active ? (
          <Box
            p="sm"
            style={{
              borderRadius: "var(--mantine-radius-md)",
              background: "var(--mantine-color-default-hover)",
            }}
          >
            <Group gap={6} mb={6}>
              <IconCircleCheck size={14} color="var(--mantine-color-teal-6)" />
              <Text fz="xs" fw={600} c="teal">
                使用中的檔案
              </Text>
            </Group>
            <ActiveFile file={active} />
          </Box>
        ) : entry.recent_uploads.length > 0 ? (
          <Alert color="amber" p="xs" icon={<IconAlertTriangle size={16} />}>
            <Text fz="xs">已有 {entry.recent_uploads.length} 個上傳版本，但沒有任何一個是「使用中」。請在版本紀錄中啟用其中一個。</Text>
          </Alert>
        ) : (
          <Alert color={required ? "amber" : "gray"} p="xs" icon={<IconAlertTriangle size={16} />}>
            <Text fz="xs">{required ? "尚未上傳。匯入需要這個檔案。" : "尚未上傳（選用）。"}</Text>
          </Alert>
        )}

        <Tooltip label={busyReason} disabled={!busyReason} multiline maw={280}>
          <Box>
            <UploadDropzone
              compact
              disabled={Boolean(busyReason)}
              extensions={entry.accepted_extensions}
              maxSizeMb={maxUploadMb}
              title={active ? "上傳新版本（會取代使用中的檔案）" : "拖曳檔案到這裡，或點擊選擇"}
              onUpload={upload}
            />
          </Box>
        </Tooltip>
      </Stack>
    </Card>
  );
}

export function SourcesSection({
  moduleKey,
  entries,
  maxUploadMb,
  hasData,
  busyReason,
  minioDetail,
}: {
  moduleKey: string;
  entries: CatalogEntry[];
  maxUploadMb: number;
  hasData: boolean;
  busyReason: string | null;
  minioDetail: string | null;
}) {
  const [historyRole, setHistoryRole] = useState<string | null>(null);
  const required = new Set(REQUIRED_ROLES[moduleKey] ?? entries.map((e) => e.source_role));
  const readiness = sourceReadiness(moduleKey, entries);

  return (
    <SectionCard
      title="① 來源檔"
      icon={<IconFileZip size={18} />}
      description={`上傳此模組的原始發布檔。新上傳的檔案會自動設為「使用中」，匯入時使用。單檔上限 ${maxUploadMb} MB。`}
      actions={
        readiness.ready ? (
          <Badge color="teal" variant="light" leftSection={<IconCircleCheck size={12} />}>
            來源齊全，可匯入
          </Badge>
        ) : (
          <Badge color="amber" variant="light">
            缺 {readiness.missing.length} 個必要檔案
          </Badge>
        )
      }
    >
      <Stack gap="md">
        {minioDetail && (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} title="物件儲存無法使用">
            <Text fz="sm">MinIO 尚未就緒（{minioDetail}），上傳會失敗。請到「系統」頁檢查物件儲存設定。</Text>
          </Alert>
        )}
        <SimpleGrid cols={{ base: 1, md: entries.length > 1 ? 2 : 1, xl: entries.length > 2 ? 3 : entries.length }}>
          {entries.map((e) => (
            <RoleCard
              key={e.source_role}
              entry={e}
              moduleKey={moduleKey}
              required={required.has(e.source_role)}
              maxUploadMb={maxUploadMb}
              busyReason={busyReason}
              onHistory={() => setHistoryRole(e.source_role)}
            />
          ))}
        </SimpleGrid>
      </Stack>
      <VersionHistoryModal
        moduleKey={moduleKey}
        role={historyRole}
        roleLabel={historyRole ? roleLabel(entries.find((e) => e.source_role === historyRole) ?? { source_role: historyRole, label: historyRole }) : ""}
        hasData={hasData}
        busyReason={busyReason}
        onClose={() => setHistoryRole(null)}
      />
    </SectionCard>
  );
}

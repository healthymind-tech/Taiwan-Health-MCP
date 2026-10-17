// Drug index CSV (36_2.csv) uploads: preview-before-upload, per-file import
// status (cumulative imports), import / retry / delete.

import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Modal,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCheck,
  IconDots,
  IconFileSpreadsheet,
  IconPlayerPlay,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { SectionCard } from "@/components/SectionCard";
import { UploadDropzone } from "@/components/UploadDropzone";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import { api, qs, uploadFile } from "@/lib/api";
import { fmtBytes, fmtDateTime, fmtRelative, shortId } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import type { CatalogEntry, UploadedFile } from "@/lib/types";
import { readCsvPreview, type CsvPreview } from "./csvPreview";
import { DRUG_MODULE_KEY, DRUG_SOURCE_ROLE } from "./drugMeta";

type ImportStatus = "pending" | "importing" | "imported" | "failed";

const IMPORT_STATUS: Record<ImportStatus, { label: string; color: string }> = {
  pending: { label: "尚未匯入", color: "gray" },
  importing: { label: "匯入中", color: "blue" },
  imported: { label: "已匯入", color: "teal" },
  failed: { label: "匯入失敗", color: "red" },
};

function importStatus(f: UploadedFile): ImportStatus {
  return f.import_status ?? (f.imported ? "imported" : "pending");
}

interface PendingPreview {
  file: File;
  preview: CsvPreview | null;
  previewError: string | null;
  resolve: () => void;
  reject: (e: Error) => void;
  onProgress: (loaded: number, total: number) => void;
  signal: AbortSignal;
}

export function IndexUploads({
  entry,
  maxUploadMb,
  drugJobActive,
  onImport,
}: {
  entry: CatalogEntry | undefined;
  maxUploadMb: number;
  drugJobActive: boolean;
  onImport: (file: UploadedFile) => void;
}) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<PendingPreview | null>(null);
  const files = entry?.recent_uploads ?? [];
  const counts = files.reduce<Record<ImportStatus, number>>(
    (acc, f) => {
      acc[importStatus(f)] += 1;
      return acc;
    },
    { pending: 0, importing: 0, imported: 0, failed: 0 },
  );

  const del = useMutation({
    mutationFn: (id: string) => api.post("/admin/api/module-sources/delete", { uploaded_file_id: id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.modules });
      notify.success("已刪除上傳檔案");
    },
    onError: (e) => notify.error(e, "刪除失敗"),
  });

  // UploadDropzone awaits this promise: it resolves only after the operator
  // confirms the preview and the bytes finish uploading.
  const handleUpload = (file: File, onProgress: (l: number, t: number) => void, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const base = { file, resolve, reject, onProgress, signal };
      readCsvPreview(file)
        .then((preview) => setPending({ ...base, preview, previewError: null }))
        .catch((e: unknown) => setPending({ ...base, preview: null, previewError: e instanceof Error ? e.message : String(e) }));
    });

  const columns: Column<UploadedFile>[] = [
    {
      key: "file",
      header: "檔案",
      primary: true,
      render: (f) => (
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <IconFileSpreadsheet size={20} style={{ flexShrink: 0, opacity: 0.6 }} />
          <Box style={{ minWidth: 0 }}>
            <Text fz="sm" fw={600} style={{ wordBreak: "break-all" }}>
              {f.original_filename}
            </Text>
            <Text fz="xs" c="dimmed">
              {fmtBytes(f.size_bytes)} · {f.uploaded_by || "—"} 上傳於 {fmtRelative(f.uploaded_at)}
            </Text>
          </Box>
        </Group>
      ),
      sortValue: (f) => f.original_filename,
    },
    {
      key: "status",
      header: "匯入狀態",
      nowrap: true,
      render: (f) => {
        const s = IMPORT_STATUS[importStatus(f)];
        return (
          <Stack gap={2} align="flex-start">
            <Badge color={s.color} variant="light">
              {s.label}
            </Badge>
            {importStatus(f) === "importing" && f.import_current_step && (
              <Text fz={11} c="dimmed" maw={220} truncate="end">
                {f.import_current_step}
              </Text>
            )}
          </Stack>
        );
      },
      sortValue: (f) => importStatus(f),
    },
    {
      key: "when",
      header: "匯入時間",
      hideOnMobile: true,
      render: (f) =>
        f.imported_at ? (
          <Tooltip label={fmtDateTime(f.imported_at)}>
            <Text fz="sm">{fmtRelative(f.imported_at)}</Text>
          </Tooltip>
        ) : (
          <Text fz="sm" c="dimmed">
            —
          </Text>
        ),
      sortValue: (f) => f.imported_at || "",
    },
    {
      key: "job",
      header: "最近工作",
      hideOnMobile: true,
      render: (f) =>
        f.import_job_id ? (
          <Stack gap={2}>
            <Anchor component={Link} to={`/jobs/${f.import_job_id}`} fz="sm" ff="monospace" onClick={(e) => e.stopPropagation()}>
              {shortId(f.import_job_id)}
            </Anchor>
            {f.import_error && (
              <Tooltip label={f.import_error} multiline maw={360}>
                <Text fz={11} c="red" maw={220} truncate="end">
                  {f.import_error}
                </Text>
              </Tooltip>
            )}
          </Stack>
        ) : (
          <Text fz="sm" c="dimmed">
            —
          </Text>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (f) => {
        const st = importStatus(f);
        const canImport = st === "pending" || st === "failed";
        const canDelete = st === "pending" || st === "failed";
        const disabledReason = drugJobActive ? "已有藥品工作在執行中，請等它完成或先停止" : null;
        return (
          <Group gap={6} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
            {canImport && (
              <Tooltip label={disabledReason ?? (st === "failed" ? "以這個檔案重新匯入" : "把這個 CSV 合併進許可證索引")} disabled={false}>
                <Button
                  size="xs"
                  variant={st === "failed" ? "light" : "filled"}
                  leftSection={st === "failed" ? <IconRefresh size={14} /> : <IconPlayerPlay size={14} />}
                  disabled={Boolean(disabledReason)}
                  onClick={() => onImport(f)}
                >
                  {st === "failed" ? "重試匯入" : "匯入"}
                </Button>
              </Tooltip>
            )}
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" aria-label="更多動作">
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {f.import_job_id && (
                  <Menu.Item component={Link} to={`/jobs/${f.import_job_id}`}>
                    查看匯入工作
                  </Menu.Item>
                )}
                <Tooltip label="已匯入的檔案為累加資料，無法單獨移除" disabled={canDelete} position="left">
                  <Box>
                    <Menu.Item
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      disabled={!canDelete}
                      onClick={() =>
                        confirmAction({
                          title: "刪除上傳檔案？",
                          message: f.original_filename,
                          consequences: ["檔案會從物件儲存與上傳紀錄中移除", "尚未匯入，因此不影響任何藥品資料"],
                          confirmLabel: "刪除",
                          danger: true,
                          onConfirm: () => del.mutateAsync(f.uploaded_file_id),
                        })
                      }
                    >
                      刪除檔案
                    </Menu.Item>
                  </Box>
                </Tooltip>
              </Menu.Dropdown>
            </Menu>
          </Group>
        );
      },
    },
  ];

  return (
    <SectionCard
      title="藥品許可證索引 CSV"
      icon={<IconFileSpreadsheet size={18} />}
      description="上傳食藥署「全部藥品許可證資料集」（36_2.csv）。每次匯入都是累加：新增或更新許可證，不會刪除既有資料。"
      actions={
        <Group gap={6} wrap="wrap">
          {(["imported", "importing", "pending", "failed"] as ImportStatus[]).map((s) =>
            counts[s] > 0 ? (
              <Badge key={s} color={IMPORT_STATUS[s].color} variant="light">
                {IMPORT_STATUS[s].label} {counts[s]}
              </Badge>
            ) : null,
          )}
        </Group>
      }
    >
      <Stack gap="md">
        {!entry ? (
          <Alert color="amber" variant="light" icon={<IconAlertTriangle size={18} />}>
            後端未提供藥品索引的上傳設定（source role {DRUG_SOURCE_ROLE}）。
          </Alert>
        ) : (
          <UploadDropzone
            onUpload={handleUpload}
            extensions={entry.accepted_extensions}
            maxSizeMb={maxUploadMb}
            compact
            title="拖曳 36_2.csv 到這裡，或點擊選擇檔案"
            hint={`上傳前會先預覽前 20 列並檢查欄位 · 上限 ${maxUploadMb} MB`}
          />
        )}

        {files.length === 0 ? (
          <EmptyState compact icon={<IconFileSpreadsheet size={22} />} title="尚未上傳任何索引檔" description="上傳 CSV 後，按「匯入」即可建立或更新許可證清單。" />
        ) : (
          <Box mx="-lg" mb="-lg">
            <DataTable columns={columns} rows={files} rowKey={(f) => f.uploaded_file_id} pageSize={10} minWidth={760} />
          </Box>
        )}
      </Stack>

      <CsvPreviewModal
        pending={pending}
        expected={entry?.expected_columns ?? null}
        onCancel={() => {
          pending?.reject(new Error("已取消上傳"));
          setPending(null);
        }}
        onConfirm={async () => {
          if (!pending) return;
          const p = pending;
          setPending(null);
          try {
            const res = await uploadFile<{ duplicate?: boolean } | null>(
              "/admin/api/uploads" +
                qs({ module_key: DRUG_MODULE_KEY, source_role: entry?.source_role ?? DRUG_SOURCE_ROLE, filename: p.file.name, auto_activate: false }),
              p.file,
              (prog) => p.onProgress(prog.loaded, prog.total),
              p.signal,
            );
            if (res?.duplicate) notify.info("這個檔案先前已上傳過，已沿用既有紀錄。", "重複檔案");
            else notify.success("上傳完成。按「匯入」即可把它合併進許可證索引。", "CSV 已上傳");
            void qc.invalidateQueries({ queryKey: qk.modules });
            p.resolve();
          } catch (e) {
            p.reject(e instanceof Error ? e : new Error(String(e)));
          }
        }}
      />
    </SectionCard>
  );
}

function CsvPreviewModal({
  pending,
  expected,
  onCancel,
  onConfirm,
}: {
  pending: PendingPreview | null;
  expected: { required: string[]; suggested: string[] } | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isMobile = useIsMobile();
  const preview = pending?.preview ?? null;
  const headers = preview?.headers ?? [];
  const headerSet = new Set(headers);
  const missingRequired = (expected?.required ?? []).filter((c) => !headerSet.has(c));
  const missingSuggested = (expected?.suggested ?? []).filter((c) => !headerSet.has(c));
  const blocked = Boolean(preview) && (missingRequired.length > 0 || headers.length === 0);

  return (
    <Modal
      opened={pending !== null}
      onClose={onCancel}
      size="xl"
      fullScreen={isMobile}
      title={
        <Text fw={650} fz="lg">
          上傳前預覽
        </Text>
      }
    >
      {pending && (
        <Stack gap="md">
          <Group gap="xs" wrap="wrap">
            <Text fz="sm" fw={600} style={{ wordBreak: "break-all" }}>
              {pending.file.name}
            </Text>
            <Badge variant="light" color="gray">
              {fmtBytes(pending.file.size)}
            </Badge>
            {preview?.hadBom && (
              <Badge variant="light" color="gray">
                UTF-8 BOM
              </Badge>
            )}
          </Group>

          {pending.previewError && (
            <Alert color="amber" variant="light" icon={<IconAlertTriangle size={18} />} title="無法預覽">
              {pending.previewError}。仍可直接上傳，伺服器會再驗證一次。
            </Alert>
          )}

          {preview?.encodingSuspect && (
            <Alert color="amber" variant="light" icon={<IconAlertTriangle size={18} />} title="編碼可能不是 UTF-8">
              檔案中有無法解碼的字元，可能是 Big5 編碼。伺服器只接受 UTF-8 CSV，請先轉檔再上傳。
            </Alert>
          )}

          {preview && expected && (
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <ColumnCheck title="必要欄位" columns={expected.required} present={headerSet} severity="red" />
              <ColumnCheck title="建議欄位" columns={expected.suggested} present={headerSet} severity="amber" />
            </SimpleGrid>
          )}

          {blocked && (
            <Alert color="red" variant="light" icon={<IconX size={18} />} title="缺少必要欄位，無法上傳">
              {headers.length === 0 ? "找不到標題列。" : `缺少：${missingRequired.join("、")}。`}請確認是食藥署 36_2.csv 原始檔。
            </Alert>
          )}
          {!blocked && missingSuggested.length > 0 && preview && (
            <Text fz="xs" c="dimmed">
              缺少 {missingSuggested.length} 個建議欄位，對應的資料會留空，但仍可匯入。
            </Text>
          )}

          {preview && headers.length > 0 && (
            <Stack gap={6}>
              <Text fz="xs" c="dimmed">
                前 {preview.rows.length} 列（共讀取 {fmtBytes(preview.bytesRead)}
                {preview.truncated ? "，檔案其餘部分不在預覽中" : ""}）· {headers.length} 個欄位
              </Text>
              <ScrollArea h={isMobile ? 360 : 320} type="auto" offsetScrollbars style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}>
                <Table striped withColumnBorders fz="xs" stickyHeader miw={Math.max(600, headers.length * 120)}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ width: 40 }}>#</Table.Th>
                      {headers.map((h, i) => (
                        <Table.Th key={i} style={{ whiteSpace: "nowrap", color: expected?.required.includes(h) ? "var(--mantine-color-brand-filled)" : undefined }}>
                          {h || <Text span c="dimmed">（空白）</Text>}
                        </Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {preview.rows.map((r, ri) => (
                      <Table.Tr key={ri}>
                        <Table.Td c="dimmed">{ri + 1}</Table.Td>
                        {headers.map((_, ci) => (
                          <Table.Td key={ci} style={{ maxWidth: 260, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {r[ci] ?? ""}
                          </Table.Td>
                        ))}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
              {preview.rows.length === 0 && (
                <Text fz="xs" c="red">
                  只有標題列，沒有資料列 — 伺服器會拒絕空檔。
                </Text>
              )}
            </Stack>
          )}

          <Group justify="space-between" gap="sm" wrap="wrap">
            <Text fz="xs" c="dimmed">
              上傳後不會自動匯入；確認無誤再按「匯入」。
            </Text>
            <Group gap="sm">
              <Button variant="default" onClick={onCancel}>
                取消
              </Button>
              <Button
                leftSection={<IconCheck size={16} />}
                disabled={blocked}
                onClick={onConfirm}
              >
                確認上傳
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function ColumnCheck({ title, columns, present, severity }: { title: string; columns: string[]; present: Set<string>; severity: "red" | "amber" }) {
  const missing = columns.filter((c) => !present.has(c));
  const ok = missing.length === 0;
  return (
    <Box p="sm" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}>
      <Group gap={6} mb={6}>
        {ok ? <IconCheck size={16} color="var(--mantine-color-teal-filled)" /> : <IconAlertTriangle size={16} color={`var(--mantine-color-${severity}-filled)`} />}
        <Text fz="sm" fw={600}>
          {title}
        </Text>
        <Text fz="xs" c="dimmed">
          {columns.length - missing.length} / {columns.length}
        </Text>
      </Group>
      <Group gap={4} wrap="wrap">
        {columns.map((c) => (
          <Badge key={c} size="xs" variant={present.has(c) ? "light" : "outline"} color={present.has(c) ? "teal" : severity} style={{ textTransform: "none" }}>
            {c}
          </Badge>
        ))}
      </Group>
    </Box>
  );
}

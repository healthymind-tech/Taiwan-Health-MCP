import { Badge, Button, Group, Modal, Stack, Text, Tooltip } from "@mantine/core";
import { IconCircleCheck, IconPlayerPause, IconTrash } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { CopyText } from "@/components/CopyText";
import { RelativeTime } from "@/components/RelativeTime";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import { api } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import type { SourceVersion } from "@/lib/types";
import { useInvalidateModule, useModuleVersions } from "./moduleData";

/** Version history for one source role: activate / deactivate / delete. */
export function VersionHistoryModal({
  moduleKey,
  role,
  roleLabel,
  busyReason,
  onClose,
}: {
  moduleKey: string;
  role: string | null;
  roleLabel: string;
  /** Unused since source deletion no longer depends on imported data. */
  hasData?: boolean;
  busyReason: string | null;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const q = useModuleVersions(moduleKey, role !== null);
  const invalidate = useInvalidateModule(moduleKey);

  const action = useMutation({
    mutationFn: ({ kind, id }: { kind: "activate" | "deactivate" | "delete"; id: string }) =>
      api.post(`/admin/api/module-sources/${kind}`, { uploaded_file_id: id }),
    onSettled: invalidate,
  });

  const run = async (kind: "activate" | "deactivate" | "delete", v: SourceVersion) => {
    try {
      await action.mutateAsync({ kind, id: v.uploaded_file_id });
      notify.success(
        kind === "activate" ? `${v.original_filename} 已設為使用中` : kind === "deactivate" ? "已停用" : `${v.original_filename} 已刪除`,
      );
    } catch (e) {
      notify.error(e, kind === "delete" ? "刪除失敗" : "操作失敗");
      throw e;
    }
  };

  const rows = (q.data?.versions ?? []).filter((v) => v.source_role === role);
  const pendingId = action.isPending ? action.variables?.id : null;

  const columns: Column<SourceVersion>[] = [
    {
      key: "file",
      header: "檔案",
      primary: true,
      render: (v) => (
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <Text fz="sm" fw={600} style={{ wordBreak: "break-all" }}>
              {v.original_filename || "—"}
            </Text>
            {v.version_num !== null && (
              <Badge size="xs" variant="outline" color="gray">
                v{v.version_num}
              </Badge>
            )}
            {v.is_active && (
              <Badge size="xs" color="teal" leftSection={<IconCircleCheck size={10} />}>
                使用中
              </Badge>
            )}
          </Group>
          <CopyText value={v.sha256} display={v.sha256 ? `sha256 ${v.sha256.slice(0, 12)}…` : ""} mono />
        </Stack>
      ),
    },
    { key: "size", header: "大小", render: (v) => fmtBytes(v.size_bytes), nowrap: true, align: "right" },
    {
      key: "uploaded",
      header: "上傳",
      render: (v) => (
        <Stack gap={0}>
          <RelativeTime value={v.uploaded_at} fz="sm" />
          <Text fz="xs" c="dimmed">
            {v.uploaded_by || "—"}
          </Text>
        </Stack>
      ),
      sortValue: (v) => v.uploaded_at ?? "",
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (v) => {
        // Deleting a source never touches imported data; the backend only refuses
        // while an import job for the module is in flight (busyReason covers that).
        const deleteBlocked = false;
        const busy = pendingId === v.uploaded_file_id;
        return (
          <Group gap={4} justify="flex-end" wrap="wrap" onClick={(e) => e.stopPropagation()}>
            {v.is_active ? (
              <Button
                size="compact-xs"
                variant="default"
                leftSection={<IconPlayerPause size={12} />}
                disabled={Boolean(busyReason) || busy}
                onClick={() =>
                  confirmAction({
                    title: "停用此版本？",
                    message: "檔案保留，只是不再標示為使用中。已匯入的資料不受影響。",
                    confirmLabel: "停用",
                    onConfirm: () => run("deactivate", v),
                  })
                }
              >
                停用
              </Button>
            ) : (
              <Button
                size="compact-xs"
                variant="light"
                disabled={Boolean(busyReason) || busy}
                onClick={() =>
                  confirmAction({
                    title: "改用此版本？",
                    message: (
                      <>
                        <Text span ff="monospace">{v.original_filename}</Text> 會成為「{roleLabel}」的使用中檔案，
                        取代目前的版本。已匯入的資料不會改變，需再執行一次匯入才會生效。
                      </>
                    ),
                    confirmLabel: "設為使用中",
                    onConfirm: () => run("activate", v),
                  })
                }
              >
                設為使用中
              </Button>
            )}
            <Tooltip
              label={
                busyReason ??
                (deleteBlocked ? "" : v.is_active ? "刪除使用中的檔案：已匯入資料保留，但下次匯入前需重新上傳" : "永久刪除此檔案")
              }
              multiline
              maw={300}
            >
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                leftSection={<IconTrash size={12} />}
                disabled={deleteBlocked || Boolean(busyReason) || busy}
                onClick={() =>
                  confirmAction({
                    title: "刪除來源檔？",
                    danger: true,
                    consequences: [
                      `刪除 ${v.original_filename}（${fmtBytes(v.size_bytes)}）`,
                      ...(v.is_active
                        ? [`這是「${roleLabel}」目前使用中的檔案；已匯入的資料不受影響，但重新匯入前必須再上傳此類檔案`]
                        : []),
                      "同時移除物件儲存中的檔案，無法復原",
                      "過去的工作紀錄會保留，但不再連結到此檔案",
                    ],
                    confirmLabel: "永久刪除",
                    onConfirm: () => run("delete", v),
                  })
                }
              >
                刪除
              </Button>
            </Tooltip>
          </Group>
        );
      },
    },
  ];

  return (
    <Modal
      opened={role !== null}
      onClose={onClose}
      title={
        <Text fw={650} fz="lg">
          版本紀錄 · {roleLabel}
        </Text>
      }
      size="xl"
      fullScreen={isMobile}
    >
      <Stack gap="sm">
        <Text fz="sm" c="dimmed">
          每次上傳都會保留一個版本。「設為使用中」只切換下次匯入要用的檔案，不會立即改動已匯入的資料。
        </Text>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(v) => v.module_source_id}
            loading={q.isPending}
            minWidth={640}
            pageSize={10}
            empty={<EmptyState compact title="還沒有任何版本" description="在來源檔卡片中上傳第一個檔案。" />}
          />
        )}
      </Stack>
    </Modal>
  );
}

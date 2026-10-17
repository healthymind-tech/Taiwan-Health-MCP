import { Alert, Badge, Box, Button, Divider, Group, Skeleton, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconTool, IconTrash } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Fragment } from "react";
import { SectionCard } from "@/components/SectionCard";
import { ErrorState } from "@/components/EmptyState";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import { api } from "@/lib/api";
import { fmtBytes, fmtNumber } from "@/lib/format";
import { CLEAR_SCOPE_META, jobTypeLabel, type ClearScope, type ModuleMeta } from "@/lib/meta";
import type { JobSummary } from "@/lib/types";
import { useClearModule, useClearPreview, useInvalidateModule, type ClearPreview } from "./moduleData";

// ── Maintenance mode ─────────────────────────────────────────────────────────
export function MaintenanceSection({ meta, enabled }: { meta: ModuleMeta; enabled: boolean }) {
  // Modules whose MCP tools are gated by the flag (node-server mcp.ts GROUP_MAINTENANCE_MODULE); rxnorm has none.
  const hasTools = meta.key !== "rxnorm";
  const invalidate = useInvalidateModule(meta.key);
  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      api.post<{ ok: boolean; enabled: boolean }>("/admin/api/module-maintenance", { module_key: meta.key, enabled: next }),
    onSettled: invalidate,
  });

  const apply = async (next: boolean) => {
    try {
      await toggle.mutateAsync(next);
      if (next) notify.warn(hasTools ? `${meta.shortLabel} 的 MCP 工具將回應「維護中」（約 5 秒內生效）。` : `${meta.shortLabel} 已標示為維護中。`, "維護模式已開啟");
      else notify.success(hasTools ? `${meta.shortLabel} 的 MCP 工具已恢復服務。` : `${meta.shortLabel} 已取消維護中標示。`, "維護模式已關閉");
    } catch (e) {
      notify.error(e, "切換維護模式失敗");
      throw e;
    }
  };

  if (!meta.maintenance) return null;

  return (
    <SectionCard
      title="維護模式"
      icon={<IconTool size={18} />}
      description={
        hasTools
          ? "暫停此模組的 MCP 工具對外服務：呼叫會立即回傳 MODULE_MAINTENANCE 錯誤，主控台與總覽以「維護中」顯示。適合在手動清除、大幅更換版本或排查資料問題時使用。"
          : "標記此模組正在維護，主控台與總覽會以「維護中」顯示。"
      }
      actions={
        enabled ? (
          <Badge color="amber" variant="filled">
            維護中
          </Badge>
        ) : (
          <Badge color="teal" variant="light">
            未標示維護
          </Badge>
        )
      }
    >
      <Stack gap="sm">
        <Alert color="amber" variant="light" p="sm" icon={<IconAlertTriangle size={16} />}>
          <Text fz="sm">
            {hasTools ? (
              <>
                開啟後，此模組的 MCP 工具（/mcp、/tools/*、後台 Playground）會立即回傳錯誤碼{" "}
                <Text span ff="monospace">MODULE_MAINTENANCE</Text>（「模組維護中，請稍後再試」），約 5 秒內生效；工具仍留在 tools/list 中，用戶端不需重新載入工具清單。
              </>
            ) : (
              <>此模組沒有自己的 MCP 工具，維護旗標只在主控台標示，不影響任何工具回應。</>
            )}
          </Text>
        </Alert>
        <Switch
          size="md"
          color="amber"
          checked={enabled}
          disabled={toggle.isPending}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            if (next) {
              confirmAction({
                title: `讓 ${meta.shortLabel} 進入維護模式？`,
                consequences: [
                  "主控台與總覽會將此模組標示為「維護中」",
                  hasTools
                    ? "此模組的 MCP 工具呼叫會回傳 MODULE_MAINTENANCE 錯誤，直到關閉維護模式"
                    : "此模組沒有自己的 MCP 工具，不影響任何工具回應",
                  "資料、向量與來源檔都不會被修改；匯入、預覽與排程仍可正常操作",
                ],
                confirmLabel: "開啟維護模式",
                onConfirm: () => apply(true),
              });
            } else {
              void apply(false).catch(() => undefined);
            }
          }}
          label={enabled ? "維護模式：開啟" : "維護模式：關閉"}
          description={enabled ? (hasTools ? "關閉後 MCP 工具恢復服務。" : "關閉後移除維護中標示。") : "目前未標示維護中。"}
        />
      </Stack>
    </SectionCard>
  );
}

// ── Danger zone (scoped clear) ───────────────────────────────────────────────
function scopeCounts(scope: ClearScope, p: ClearPreview): string[] {
  const data = `${fmtNumber(p.data_rows)} 筆匯入資料`;
  const emb = `${fmtNumber(p.embedding_rows)} 筆向量`;
  const src = `${fmtNumber(p.source_files)} 個來源檔（${fmtBytes(p.source_bytes)}）`;
  switch (scope) {
    case "embeddings":
      return [emb];
    case "data":
      return p.embedding_rows > 0 ? [data, emb] : [data];
    case "sources":
      return [src];
    case "all":
      return [data, ...(p.embedding_rows > 0 ? [emb] : []), src];
  }
}

function scopeEmpty(scope: ClearScope, p: ClearPreview): boolean {
  switch (scope) {
    case "embeddings":
      return p.embedding_rows === 0;
    case "data":
      return p.data_rows === 0 && p.embedding_rows === 0;
    case "sources":
      return p.source_files === 0;
    case "all":
      return p.data_rows === 0 && p.embedding_rows === 0 && p.source_files === 0;
  }
}

export function DangerZone({
  meta,
  activeJob,
  extraConsequences,
}: {
  meta: ModuleMeta;
  /** Any active job for the module — the backend refuses with 409 while one exists. */
  activeJob: JobSummary | null;
  extraConsequences?: Partial<Record<ClearScope, string[]>>;
}) {
  const q = useClearPreview(meta.key, meta.clearScopes.length > 0);
  const clear = useClearModule(meta.key);

  if (meta.clearScopes.length === 0) return null;

  const run = (scope: ClearScope, p: ClearPreview) => {
    const m = CLEAR_SCOPE_META[scope];
    confirmAction({
      title: `${meta.shortLabel}：${m.label}`,
      danger: true,
      typeToConfirm: meta.key,
      message: m.description,
      consequences: [
        ...scopeCounts(scope, p).map((s) => `永久刪除 ${s}`),
        ...(scope === "data" || scope === "all" ? ["此模組的 MCP 工具會因為沒有資料而下架，直到重新匯入"] : []),
        ...(scope === "embeddings" ? ["語意搜尋暫時退回關鍵字搜尋"] : []),
        ...(extraConsequences?.[scope] ?? []),
        "此操作會寫入稽核紀錄，無法復原",
      ],
      confirmLabel: m.label,
      onConfirm: async () => {
        try {
          const res = await clear.mutateAsync(scope);
          notify.success(
            `${m.label}完成${res.objects_removed ? `，已移除 ${fmtNumber(res.objects_removed)} 個儲存物件` : ""}。`,
            "清除完成",
          );
        } catch (e) {
          notify.error(e, "清除失敗");
          throw e;
        }
      },
    });
  };

  return (
    <SectionCard
      title="危險操作"
      icon={<IconAlertTriangle size={18} />}
      description="依階段分別清除，互不影響：只清向量會保留資料；只刪來源檔會保留已匯入的資料。每個動作都需要輸入模組代碼確認。"
      style={{ borderColor: "var(--mantine-color-red-light-color)" }}
    >
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Stack>
          <Skeleton h={52} />
          <Skeleton h={52} />
        </Stack>
      ) : (
        <Stack gap={0}>
          {activeJob && (
            <Alert color="amber" icon={<IconAlertTriangle size={16} />} p="sm" mb="md">
              <Text fz="sm">{jobTypeLabel(activeJob.job_type)}進行中。請等它完成，或到工作頁停止後再清除。</Text>
            </Alert>
          )}
          {meta.clearScopes
            .filter((s) => q.data.scopes.includes(s))
            .map((scope, i) => {
              const m = CLEAR_SCOPE_META[scope];
              const empty = scopeEmpty(scope, q.data);
              const reason = activeJob ? "有工作進行中" : empty ? "沒有可清除的內容" : null;
              return (
                <Fragment key={scope}>
                  {i > 0 && <Divider my="sm" />}
                  <Group justify="space-between" align="center" gap="sm" wrap="wrap">
                    <Box style={{ flex: "1 1 280px", minWidth: 0 }}>
                      <Group gap={6} wrap="wrap">
                        <Text fw={600} fz="sm">
                          {m.label}
                        </Text>
                        {m.destructive === "high" && (
                          <Badge size="xs" color="red" variant="light">
                            影響服務
                          </Badge>
                        )}
                      </Group>
                      <Text fz="xs" c="dimmed" mt={2}>
                        {m.description}
                      </Text>
                      <Text fz="xs" mt={4}>
                        將刪除：{scopeCounts(scope, q.data).join("、")}
                      </Text>
                    </Box>
                    <Tooltip label={reason} disabled={!reason}>
                      <Button
                        color="red"
                        variant={m.destructive === "high" ? "filled" : "light"}
                        leftSection={<IconTrash size={16} />}
                        disabled={Boolean(reason)}
                        loading={clear.isPending && clear.variables === scope}
                        onClick={() => run(scope, q.data)}
                      >
                        {m.label}
                      </Button>
                    </Tooltip>
                  </Group>
                </Fragment>
              );
            })}
        </Stack>
      )}
    </SectionCard>
  );
}

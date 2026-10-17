import { Alert, Badge, Box, Button, Group, Loader, Modal, Paper, Select, Stack, Text, TextInput, ThemeIcon } from "@mantine/core";
import { IconAlertTriangle, IconArrowUp, IconInfoCircle, IconStar, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { fmtNumber } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import type { IgRef } from "./igTypes";
import {
  igRemovalKeys,
  refLabel,
  removalCode,
  removalErrorText,
  titledLabel,
  type IgRemovalImpact,
  type IgRemovalResult,
} from "./igRemoval";

const enc = (r: IgRef) => `${encodeURIComponent(r.package_id)}/${encodeURIComponent(r.version)}`;

/**
 * Delete one IG after showing what it breaks. Packages other IGs depend on
 * cannot be removed with the primary action; "強制刪除" needs the package id
 * typed in. The default IG needs a replacement default (or force).
 */
export function RemoveIgModal({
  target,
  onClose,
  onRemoved,
}: {
  target: IgRef | null;
  onClose: () => void;
  onRemoved: (r: IgRemovalResult, target: IgRef) => void;
}) {
  const isMobile = useIsMobile();
  const [newDefault, setNewDefault] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const key = target ? refLabel(target) : "";
  useEffect(() => {
    setNewDefault(null);
    setConfirm("");
  }, [key]);

  const impact = useQuery({
    queryKey: igRemovalKeys.impact(target),
    queryFn: () => api.get<IgRemovalImpact>(`/admin/api/igs/${enc(target!)}/removal-impact`),
    enabled: target !== null,
    staleTime: 0,
  });

  const del = useMutation({
    mutationFn: ({ force }: { force: boolean }) => {
      const sp = new URLSearchParams();
      if (force) sp.set("force", "true");
      if (newDefault) sp.set("new_default", newDefault);
      const q = sp.toString();
      return api.del<IgRemovalResult>(`/admin/api/igs/${enc(target!)}${q ? `?${q}` : ""}`);
    },
    onSuccess: (r) => {
      onRemoved(r, target!);
    },
    onError: (e) => {
      // The installed set changed under us → show the fresh impact.
      if (removalCode(e)) void impact.refetch();
    },
  });

  const p = impact.data;
  const hasDependents = Boolean(p && p.dependents.length > 0);
  const needsDefault = Boolean(p && p.removes_default && p.default_candidates.length > 0);
  const defaultChosen = !needsDefault || newDefault !== null;
  const primaryEnabled = Boolean(p) && !hasDependents && defaultChosen;
  const showForce = Boolean(p) && (hasDependents || (needsDefault && !newDefault));
  const forceReady = Boolean(p) && confirm.trim() === p?.target.package_id;
  const busy = del.isPending;

  return (
    <Modal
      opened={target !== null}
      onClose={() => !busy && onClose()}
      title={<Text fw={650} style={{ wordBreak: "break-word" }}>{`移除 ${target ? refLabel(target) : ""}？`}</Text>}
      size="lg"
      centered
      fullScreen={isMobile}
    >
      {impact.isPending ? (
        <Group gap="xs">
          <Loader size="sm" />
          <Text fz="sm">分析影響範圍…</Text>
        </Group>
      ) : impact.isError ? (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          {removalErrorText(impact.error)}
        </Alert>
      ) : p ? (
        <Stack gap="md">
          <Text fz="sm">
            會刪除 <b>{p.target.title}</b> 的 {fmtNumber(p.target.counts.artifacts)} 個構件、{fmtNumber(p.target.counts.codesystems)} 個
            CodeSystem、{fmtNumber(p.target.counts.concepts)} 個概念，並移除物件儲存中封存的 package.tgz。之後可再從 Registry 或上傳重新匯入。
          </Text>

          {!hasDependents && !p.removes_default && (
            <Alert color="teal" variant="light" icon={<IconInfoCircle size={18} />}>
              沒有其他已安裝的 IG 依賴它，移除不會影響其他 IG。
            </Alert>
          )}

          {hasDependents && (
            <Impact tone="red" icon={<IconAlertTriangle size={14} />} title={`${p.dependents.length} 個已安裝的 IG 依賴它，已停用一般移除`}>
              <Text fz="xs" c="dimmed">
                移除後，這些 IG 的資源驗證（fhir_validate_resource / bundle）、ValueSet 展開與代碼查詢會找不到此套件的
                StructureDefinition、CodeSystem 與 ValueSet，結果會失敗或不完整，直到重新安裝它。
              </Text>
              {p.dependents.map((d) => (
                <Item
                  key={refLabel(d)}
                  tone="red"
                  label={titledLabel(d)}
                  badges={
                    <>
                      <Badge size="xs" variant="light" color={d.direct ? "red" : "amber"}>
                        {d.direct ? "直接相依" : "間接相依"}
                      </Badge>
                      {d.is_default && (
                        <Badge size="xs" color="brand" leftSection={<IconStar size={9} />}>
                          預設 IG
                        </Badge>
                      )}
                    </>
                  }
                  detail={d.direct ? `宣告相依 ${refLabel(d.via)}` : `經由 ${refLabel(d.via)} 間接需要此套件`}
                />
              ))}
            </Impact>
          )}

          {p.removes_default && (
            <Impact tone="amber" icon={<IconStar size={14} />} title="這是目前的預設 IG">
              {p.default_candidates.length > 0 ? (
                <>
                  <Text fz="xs" c="dimmed">
                    未指定 IG 的 MCP 工具會使用預設 IG。請選擇移除後要改用的預設 IG。
                  </Text>
                  <Select
                    label="新的預設 IG"
                    placeholder="選擇一個已安裝的 IG"
                    data={p.default_candidates.map((c) => ({ value: refLabel(c), label: titledLabel(c) }))}
                    value={newDefault}
                    onChange={setNewDefault}
                    searchable
                    clearable
                    comboboxProps={{ withinPortal: true }}
                    disabled={busy}
                  />
                </>
              ) : (
                <Text fz="xs" c="dimmed">
                  沒有其他已安裝的 IG 可以接手；移除後將沒有預設 IG，需要預設 IG 的 MCP 工具會失敗，直到你安裝新的 IG。
                </Text>
              )}
            </Impact>
          )}

          {p.orphaned.length > 0 && (
            <Impact tone="gray" icon={<IconInfoCircle size={14} />} title="移除後會變成未使用的相依">
              <Text fz="xs" c="dimmed">
                這些相依套件只被此 IG 使用；移除後會保留，可以在「清理未使用的相依」一併移除。
              </Text>
              {p.orphaned.map((o) => (
                <Item key={refLabel(o)} tone="gray" label={titledLabel(o)} />
              ))}
            </Impact>
          )}

          {del.isError && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} title="移除失敗">
              {removalErrorText(del.error)}
            </Alert>
          )}

          <Group justify="flex-end" gap="xs">
            <Button variant="subtle" color="gray" onClick={onClose} disabled={busy} data-autofocus>
              取消
            </Button>
            <Button
              color="red"
              leftSection={<IconTrash size={16} />}
              onClick={() => del.mutate({ force: false })}
              loading={busy && !del.variables?.force}
              disabled={!primaryEnabled || busy}
            >
              移除 IG
            </Button>
          </Group>

          {showForce && (
            <Paper withBorder p="sm" radius="md" style={{ borderColor: "var(--mantine-color-red-filled)" }}>
              <Stack gap="xs">
                <Text fz="sm" fw={650} c="red">
                  強制刪除
                </Text>
                <Text fz="xs" c="dimmed">
                  {hasDependents
                    ? "略過相依檢查直接移除；上方列出的 IG 會失去這個套件。操作者與受影響的 IG 會記錄在稽核紀錄中。"
                    : "不指定新的預設 IG 直接移除；移除後將沒有預設 IG。操作會記錄在稽核紀錄中。"}
                </Text>
                <TextInput
                  label={
                    <>
                      輸入套件 ID <b style={{ wordBreak: "break-all" }}>{p.target.package_id}</b> 以確認
                    </>
                  }
                  value={confirm}
                  onChange={(e) => setConfirm(e.currentTarget.value)}
                  placeholder={p.target.package_id}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && forceReady && !busy) del.mutate({ force: true });
                  }}
                />
                <Group justify="flex-end">
                  <Button
                    color="red"
                    variant="filled"
                    leftSection={<IconAlertTriangle size={16} />}
                    onClick={() => del.mutate({ force: true })}
                    loading={busy && Boolean(del.variables?.force)}
                    disabled={!forceReady || busy}
                  >
                    強制刪除
                  </Button>
                </Group>
              </Stack>
            </Paper>
          )}
        </Stack>
      ) : null}
    </Modal>
  );
}

const TONE_BORDER: Record<"red" | "amber" | "gray", string> = {
  red: "color-mix(in srgb, var(--mantine-color-red-5) 55%, var(--mantine-color-default-border))",
  amber: "color-mix(in srgb, var(--mantine-color-amber-5) 55%, var(--mantine-color-default-border))",
  gray: "var(--mantine-color-default-border)",
};
const TONE_BG: Record<"red" | "amber" | "gray", string> = {
  red: "color-mix(in srgb, var(--mantine-color-red-5) 6%, transparent)",
  amber: "color-mix(in srgb, var(--mantine-color-amber-5) 6%, transparent)",
  gray: "transparent",
};

export function Impact({ tone, icon, title, children }: { tone: "red" | "amber" | "gray"; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Box p="sm" style={{ borderRadius: "var(--mantine-radius-md)", border: `1px solid ${TONE_BORDER[tone]}`, background: TONE_BG[tone] }}>
      <Group gap={6} mb={6} wrap="nowrap" align="flex-start">
        <ThemeIcon size={22} radius="xl" variant="light" color={tone} style={{ flexShrink: 0 }}>
          {icon}
        </ThemeIcon>
        <Text fz="sm" fw={700}>
          {title}
        </Text>
      </Group>
      <Stack gap={6} pl={10} ml={10} style={{ borderLeft: "2px dashed var(--mantine-color-default-border)" }}>
        {children}
      </Stack>
    </Box>
  );
}

function Item({ tone, label, detail, badges }: { tone: "red" | "amber" | "gray"; label: string; detail?: string; badges?: ReactNode }) {
  const color = tone === "red" ? "var(--mantine-color-red-6)" : tone === "amber" ? "var(--mantine-color-amber-7)" : "var(--mantine-color-dimmed)";
  return (
    <Group gap={8} wrap="nowrap" align="flex-start">
      <IconArrowUp size={12} style={{ marginTop: 4, flexShrink: 0, color }} aria-hidden />
      <Box style={{ minWidth: 0 }}>
        <Group gap={6} wrap="wrap">
          <Text fz="sm" fw={600} style={{ wordBreak: "break-word" }}>
            {label}
          </Text>
          {badges}
        </Group>
        {detail && (
          <Text fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
            {detail}
          </Text>
        )}
      </Box>
    </Group>
  );
}

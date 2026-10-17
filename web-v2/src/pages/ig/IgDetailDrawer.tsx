import { Alert, Badge, Box, Button, Drawer, Group, List, Stack, Tabs, Text, ThemeIcon, Tooltip } from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconBox,
  IconCloudDownload,
  IconCircleCheck,
  IconCircleDashed,
  IconFileDescription,
  IconStar,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DataTable } from "@/components/DataTable";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { KeyValue } from "@/components/KeyValue";
import { CopyText } from "@/components/CopyText";
import { RelativeTime } from "@/components/RelativeTime";
import { PageSkeleton } from "@/components/QueryBoundary";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { fmtNumber } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import type { IgDetail, IgRef } from "./igTypes";
import { IgArtifactBrowser } from "./IgArtifactBrowser";
import { IgCodeSystemTree } from "@/pages/terminology/explorer/IgCodeSystemTree";
import { OriginBadge } from "./igOriginBadge";

function DepRow({ dep, installed }: { dep: IgRef & { resolved_version?: string }; installed: boolean }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <ThemeIcon size={20} radius="xl" variant="light" color={installed ? "teal" : "amber"}>
        {installed ? <IconCircleCheck size={12} /> : <IconCircleDashed size={12} />}
      </ThemeIcon>
      <Box style={{ minWidth: 0 }}>
        <Text fz="sm" ff="monospace" style={{ wordBreak: "break-all" }}>
          {dep.package_id}@{dep.version}
        </Text>
        <Text fz="xs" c={installed ? "dimmed" : "amber"}>
          {installed ? "已安裝" : "未安裝（術語驗證可能缺代碼）"}
          {dep.resolved_version && `（宣告的 ${dep.version} 從未發佈，實際使用 ${dep.resolved_version}）`}
        </Text>
      </Box>
    </Group>
  );
}

export function IgDetailDrawer({
  target,
  onClose,
  onSetDefault,
  onRemove,
  settingDefault,
  removeBlock,
  onOpenDeps,
  closeOnEscape = true,
}: {
  target: IgRef | null;
  onClose: () => void;
  onSetDefault: (ig: IgRef) => void;
  onRemove: (ig: IgDetail) => void;
  settingDefault: boolean;
  removeBlock: string | null;
  /** Open the missing-dependency dialog for this IG. */
  onOpenDeps: (ig: IgDetail) => void;
  /** False while a dialog opened from the drawer is on top, so Esc closes only that dialog. */
  closeOnEscape?: boolean;
}) {
  const isMobile = useIsMobile();
  const q = useQuery({
    queryKey: qk.igDetail(target?.package_id ?? "", target?.version ?? ""),
    queryFn: () => api.get<IgDetail>(`/admin/api/igs/${encodeURIComponent(target!.package_id)}/${encodeURIComponent(target!.version)}`),
    enabled: target !== null,
  });
  const d = q.data;

  return (
    <Drawer
      opened={target !== null}
      onClose={onClose}
      closeOnEscape={closeOnEscape}
      position="right"
      size={isMobile ? "100%" : "xl"}
      title={
        <Group gap="xs" wrap="wrap">
          <Text fw={650} fz="lg" style={{ wordBreak: "break-word" }}>
            {d?.title ?? target?.package_id}
          </Text>
          {d?.is_default && (
            <Badge color="brand" leftSection={<IconStar size={11} />}>
              預設
            </Badge>
          )}
        </Group>
      }
    >
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isPending || !d ? (
        <PageSkeleton rows={3} />
      ) : (
        <Stack gap="md">
          <Group gap="xs" wrap="wrap">
            <Tooltip label={d.is_default ? "已是預設 IG" : "未指定 IG 的 MCP 工具會使用預設 IG"} multiline maw={260}>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconStar size={14} />}
                disabled={d.is_default}
                loading={settingDefault}
                onClick={() => onSetDefault(d)}
              >
                設為預設
              </Button>
            </Tooltip>
            {d.deps_missing.length > 0 && (
              <Tooltip label="下載或上傳缺少的相依，或重新匯入此 IG" multiline maw={260}>
                <Button size="xs" variant="light" color="amber" leftSection={<IconCloudDownload size={14} />} onClick={() => onOpenDeps(d)}>
                  補齊相依（{d.deps_missing.length}）
                </Button>
              </Tooltip>
            )}
            <Tooltip label={removeBlock} disabled={!removeBlock}>
              <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} disabled={Boolean(removeBlock)} onClick={() => onRemove(d)}>
                移除此 IG
              </Button>
            </Tooltip>
          </Group>

          <Tabs defaultValue="overview" keepMounted={false}>
            <Tabs.List mb="md">
              <Tabs.Tab value="overview" leftSection={<IconFileDescription size={14} />}>
                概要
              </Tabs.Tab>
              <Tabs.Tab value="artifacts" leftSection={<IconBox size={14} />}>
                構件（{fmtNumber(d.counts.artifacts)}）
              </Tabs.Tab>
              <Tabs.Tab value="cs">CodeSystem（{fmtNumber(d.codesystems.length)}）</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="overview">
              <Stack gap="lg">
                <KeyValue
                  cols={2}
                  items={[
                    { label: "Package ID", value: <CopyText value={d.package_id} mono /> },
                    { label: "版本", value: <Text fz="sm" ff="monospace">{d.version}</Text> },
                    { label: "FHIR 版本", value: d.fhir_version },
                    { label: "狀態", value: d.status },
                    { label: "Canonical", value: d.canonical ? <CopyText value={d.canonical} mono /> : null, full: true },
                    { label: "匯入時間", value: <RelativeTime value={d.imported_at} fz="sm" /> },
                    {
                      label: "安裝方式",
                      value: d.install_origin ? (
                        <Stack gap={2}>
                          <OriginBadge origin={d.install_origin} />
                          {d.install_origin === "dependency" && (
                            <Text fz="xs" c="dimmed" style={{ wordBreak: "break-word" }}>
                              {d.installed_for
                                ? `由 ${d.installed_for.title && d.installed_for.title !== d.installed_for.package_id ? `${d.installed_for.title}（${d.installed_for.package_id}@${d.installed_for.version}）` : `${d.installed_for.package_id}@${d.installed_for.version}`} 帶入${d.installed_for.installed ? "" : "（該 IG 已移除）"}`
                                : d.dependents.length
                                  ? `被 ${d.dependents.map((x) => `${x.package_id}@${x.version}`).join("、")} 依賴`
                                  : "帶入它的 IG 不明"}
                            </Text>
                          )}
                        </Stack>
                      ) : null,
                    },
                    {
                      label: "內容",
                      value: `${fmtNumber(d.counts.artifacts)} 構件 · ${fmtNumber(d.counts.codesystems)} CodeSystem · ${fmtNumber(d.counts.concepts)} 概念`,
                    },
                  ]}
                />

                <Stack gap="xs">
                  <Text fw={600} fz="sm">
                    相依套件（{d.dependencies.length}）
                  </Text>
                  {d.dependencies.length === 0 ? (
                    <Text fz="sm" c="dimmed">
                      沒有宣告相依套件。
                    </Text>
                  ) : (
                    <Stack gap="xs">
                      {d.dependencies.map((dep) => (
                        <DepRow key={`${dep.package_id}@${dep.version}`} dep={dep} installed={dep.installed} />
                      ))}
                    </Stack>
                  )}
                  {d.deps_missing.length > 0 && (
                    <Alert color="amber" p="sm" icon={<IconAlertTriangle size={16} />} title={`遞移相依中有 ${d.deps_missing.length} 個未安裝`}>
                      <List size="xs" spacing={2}>
                        {d.deps_missing.map((m) => (
                          <List.Item key={`${m.package_id}@${m.version}`}>
                            <Text span ff="monospace" fz="xs">
                              {m.package_id}@{m.version}
                            </Text>
                          </List.Item>
                        ))}
                      </List>
                      <Text fz="xs" mt={6}>
                        可從 Registry 下載補齊；若 Registry 無法提供，請上傳該套件的 package.tgz。
                      </Text>
                      <Button
                        mt="xs"
                        size="xs"
                        variant="default"
                        leftSection={<IconCloudDownload size={14} />}
                        rightSection={<IconArrowRight size={12} />}
                        onClick={() => onOpenDeps(d)}
                      >
                        下載或上傳缺少的相依
                      </Button>
                    </Alert>
                  )}
                </Stack>

                <Stack gap="xs">
                  <Text fw={600} fz="sm">
                    被哪些 IG 依賴（{d.dependents.length}）
                  </Text>
                  {d.dependents.length === 0 ? (
                    <Text fz="sm" c="dimmed">
                      沒有其他已安裝的 IG 依賴它。
                    </Text>
                  ) : (
                    d.dependents.map((x) => (
                      <Text key={`${x.package_id}@${x.version}`} fz="sm" ff="monospace" style={{ wordBreak: "break-all" }}>
                        {x.package_id}@{x.version}
                      </Text>
                    ))
                  )}
                </Stack>

                <Stack gap="xs">
                  <Text fw={600} fz="sm">
                    引用的外部代碼系統（{d.external_systems.length}）
                  </Text>
                  <Text fz="xs" c="dimmed">
                    ValueSet 引用、但不屬於此 IG 自己 CodeSystem 的系統。驗證這些代碼需要對應模組（SNOMED CT、LOINC、RxNorm…）已匯入。
                  </Text>
                  {d.external_systems.length === 0 ? (
                    <Text fz="sm" c="dimmed">
                      無
                    </Text>
                  ) : (
                    <Stack gap={2}>
                      {d.external_systems.map((u) => (
                        <CopyText key={u} value={u} mono />
                      ))}
                    </Stack>
                  )}
                </Stack>
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="artifacts">
              <IgArtifactBrowser packageId={d.package_id} />
            </Tabs.Panel>

            <Tabs.Panel value="cs">
              <CodeSystemTab d={d} />
            </Tabs.Panel>
          </Tabs>
        </Stack>
      )}
    </Drawer>
  );
}

/** CodeSystem list; a row opens its concept hierarchy in place. */
function CodeSystemTab({ d }: { d: IgDetail }) {
  const [open, setOpen] = useState<string | null>(null);
  if (open) {
    const cs = d.codesystems.find((c) => c.cs_id === open);
    return (
      <Stack gap="sm">
        <Group gap="xs">
          <Button size="xs" variant="subtle" leftSection={<IconArrowLeft size={14} />} onClick={() => setOpen(null)}>
            返回 CodeSystem 列表
          </Button>
          <Text fw={650} fz="sm">
            {cs?.name ?? open}
          </Text>
        </Group>
        <IgCodeSystemTree packageId={d.package_id} artifactKey={`CodeSystem/${open}`} version={d.version} />
      </Stack>
    );
  }
  return (
    <Box style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)", overflow: "hidden" }}>
      <DataTable
        columns={[
          { key: "name", header: "名稱", primary: true, render: (c) => <Text fz="sm" fw={600}>{c.name}</Text>, sortValue: (c) => c.name },
          { key: "id", header: "ID", render: (c) => <Text fz="xs" ff="monospace" style={{ wordBreak: "break-all" }}>{c.cs_id}</Text> },
          { key: "n", header: "概念數", align: "right", render: (c) => fmtNumber(c.concept_count), sortValue: (c) => c.concept_count },
        ]}
        rows={d.codesystems}
        rowKey={(c) => c.cs_id}
        onRowClick={(c) => setOpen(c.cs_id)}
        pageSize={20}
        minWidth={480}
        empty={<EmptyState compact title="此 IG 沒有自己的 CodeSystem" />}
      />
    </Box>
  );
}

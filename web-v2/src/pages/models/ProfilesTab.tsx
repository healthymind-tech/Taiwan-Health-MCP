import { ActionIcon, Avatar, Badge, Box, Button, Card, Group, Menu, SegmentedControl, SimpleGrid, Skeleton, Stack, Text, Tooltip } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { IconCopy, IconDots, IconPencil, IconPlus, IconStack2, IconTrash } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { notify } from "@/components/notify";
import { SectionCard } from "@/components/SectionCard";
import { api } from "@/lib/api";
import { llmErrorText } from "./llmErrors";
import type { LlmProfileKind } from "@/lib/types";
import { llmKeys, providerAccent, STRATEGY_META, useAccounts, useRoutes, type Route } from "./llmApi";
import { DeleteProfileModal } from "./DeleteProfileModal";
import { ProfileBuilder } from "./ProfileBuilder";
import { useProviders } from "./profileModel";
import classes from "./models.module.css";

const KIND_LABEL: Record<LlmProfileKind, string> = { analysis: "分析 LLM", embedding: "Embedding" };

export function ProfilesTab() {
  const routes = useRoutes();
  const accounts = useAccounts();
  const providers = useProviders();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | LlmProfileKind>("all");
  const [editing, setEditing] = useState<Route | null>(null);
  const [newKind, setNewKind] = useState<LlmProfileKind>("analysis");
  const [opened, setOpened] = useState(false);

  const all = routes.data?.routes ?? [];
  const roles = routes.data?.roles ?? { analysis: null, embedding: null };
  const list = all.filter((r) => filter === "all" || r.kind === filter);
  const parentsOf = useMemo(() => {
    const out = new Map<number, string[]>();
    for (const r of all) for (const m of r.members) if (m.member_type === "route" && m.child_route_id !== null) out.set(m.child_route_id, [...(out.get(m.child_route_id) ?? []), r.name]);
    return out;
  }, [all]);

  const open = (r: Route | null, kind: LlmProfileKind = "analysis") => {
    setEditing(r);
    setNewKind(kind);
    setOpened(true);
  };

  const duplicate = async (r: Route) => {
    try {
      let name = `${r.name}（副本）`;
      for (let i = 2; all.some((x) => x.name === name); i += 1) name = `${r.name}（副本 ${i}）`;
      await api.post("/admin/api/llm/routes", {
        name,
        kind: r.kind,
        strategy: r.strategy,
        description: r.description,
        members: r.members.map(({ id: _id, ...m }) => m),
      });
      notify.success(`已複製為「${name}」`);
      await qc.invalidateQueries({ queryKey: llmKeys.routes });
    } catch (err) {
      notify.error(llmErrorText(err), "複製失敗");
    }
  };

  const [deleting, setDeleting] = useState<Route | null>(null);
  const remove = (r: Route) => setDeleting(r);

  return (
    <>
      <SectionCard
        title="Profiles"
        description="Profile 是一組模型的組合：可以只有一個模型，也可以用備援、輪詢或加權負載平衡把多個模型（甚至其他 Profile）組起來，像積木一樣疊。"
        icon={<IconStack2 size={18} />}
        actions={
          <Group gap="xs" wrap="wrap">
            <SegmentedControl
              size="xs"
              value={filter}
              onChange={(v) => setFilter(v as typeof filter)}
              data={[
                { value: "all", label: "全部" },
                { value: "analysis", label: "分析 LLM" },
                { value: "embedding", label: "Embedding" },
              ]}
            />
            <Menu position="bottom-end">
              <Menu.Target>
                <Button leftSection={<IconPlus size={16} />}>新增 Profile</Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => open(null, "analysis")}>分析 LLM Profile</Menu.Item>
                <Menu.Item onClick={() => open(null, "embedding")}>Embedding Profile</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        }
      >
        {routes.isPending ? (
          <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>
            {[0, 1].map((i) => (
              <Skeleton key={i} h={170} radius="md" />
            ))}
          </SimpleGrid>
        ) : routes.isError ? (
          <ErrorState error={routes.error} onRetry={() => void routes.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<IconStack2 size={28} />}
            title="還沒有 Profile"
            description="建立一個 Profile，把 Provider 帳號裡的模型組合起來，再到「總覽」指定給角色使用。"
            action={
              <Button leftSection={<IconPlus size={16} />} onClick={() => open(null, filter === "embedding" ? "embedding" : "analysis")}>
                建立 Profile
              </Button>
            }
          />
        ) : (
          <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">
            {list.map((r, i) => {
              const bound = (["analysis", "embedding"] as const).filter((k) => roles[k] === r.id);
              const parents = parentsOf.get(r.id) ?? [];
              return (
                <Card key={r.id} className={classes.profileCard} style={{ animationDelay: `${i * 40}ms` }} onClick={() => open(r)} data-bound={bound.length > 0 || undefined}>
                  <Stack gap="sm">
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <Box style={{ minWidth: 0 }}>
                        <Text fw={650} truncate="end">
                          {r.name}
                        </Text>
                        <Group gap={6} mt={4}>
                          <Badge size="xs" variant="light" color={r.kind === "embedding" ? "indigo" : "brand"} tt="none">
                            {KIND_LABEL[r.kind]}
                          </Badge>
                          <Badge size="xs" variant="outline" color="gray" tt="none">
                            {STRATEGY_META[r.strategy].label}
                          </Badge>
                          {bound.map((k) => (
                            <Badge key={k} size="xs" variant="filled" color="teal" tt="none">
                              {KIND_LABEL[k]}使用中
                            </Badge>
                          ))}
                          {r.stale && (
                            <Tooltip label="裡面有與系統 Embedding 模型不一致的端點（例如切換模型之後的舊設定）。仍可修改名稱與說明，但不能指定給 Embedding 角色。" multiline maw={280} withArrow>
                              <Badge size="xs" variant="light" color="amber" tt="none">
                                與系統模型不一致
                              </Badge>
                            </Tooltip>
                          )}
                        </Group>
                      </Box>
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                          <ActionIcon variant="subtle" color="gray" onClick={(e) => e.stopPropagation()} aria-label="Profile 動作">
                            <IconDots size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
                          <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => open(r)}>
                            編輯
                          </Menu.Item>
                          <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => void duplicate(r)}>
                            複製
                          </Menu.Item>
                          <Menu.Divider />
                          <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => remove(r)}>
                            刪除
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    </Group>
                    {r.description && (
                      <Text fz="xs" c="dimmed" lineClamp={2}>
                        {r.description}
                      </Text>
                    )}
                    <Box className={classes.chain}>
                      {r.members.map((m, idx) => {
                        const acc = m.provider_id !== null ? accounts.data?.accounts.find((a) => a.id === m.provider_id) : undefined;
                        const child = m.child_route_id !== null ? all.find((x) => x.id === m.child_route_id) : undefined;
                        return (
                          <Group key={m.id} gap={6} wrap="nowrap" className={classes.chainItem} data-disabled={!m.enabled || undefined}>
                            <Text fz={10} c="dimmed" w={14} ta="right" className="tabular">
                              {idx + 1}
                            </Text>
                            {m.member_type === "model" ? (
                              <Avatar size={18} radius="sm" color={providerAccent(acc?.provider ?? "?")} variant="light">
                                {(acc?.provider ?? "?").slice(0, 1).toUpperCase()}
                              </Avatar>
                            ) : (
                              <IconStack2 size={16} />
                            )}
                            <Text fz="xs" ff={m.member_type === "model" ? "monospace" : undefined} truncate="end" style={{ flex: 1 }}>
                              {m.member_type === "model" ? m.model : child?.name}
                            </Text>
                            <Text fz={10} c="dimmed" truncate="end" maw={110}>
                              {m.member_type === "model" ? acc?.name : "Profile"}
                            </Text>
                          </Group>
                        );
                      })}
                    </Box>
                    {parents.length > 0 && (
                      <Tooltip label={parents.join("、")}>
                        <Text fz={11} c="dimmed">
                          被 {parents.length} 個 Profile 引用
                        </Text>
                      </Tooltip>
                    )}
                  </Stack>
                </Card>
              );
            })}
          </SimpleGrid>
        )}
      </SectionCard>
      <DeleteProfileModal route={deleting} onClose={() => setDeleting(null)} />
      <ProfileBuilder
        opened={opened}
        onClose={() => setOpened(false)}
        route={editing}
        kind={newKind}
        routes={all}
        accounts={accounts.data?.accounts ?? []}
        specs={providers.data ?? []}
        cooling={routes.data?.cooling ?? {}}
        boundRoles={editing ? (["analysis", "embedding"] as const).filter((k) => roles[k] === editing.id) : []}
      />
    </>
  );
}

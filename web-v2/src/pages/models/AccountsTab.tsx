import { ActionIcon, Badge, Box, Button, Card, Group, Menu, SimpleGrid, Skeleton, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconCircleCheck, IconCircleX, IconDots, IconKey, IconPencil, IconPlugConnected, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { confirmAction } from "@/components/confirm";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { notify } from "@/components/notify";
import { RelativeTime } from "@/components/RelativeTime";
import { SectionCard } from "@/components/SectionCard";
import { api } from "@/lib/api";
import { llmErrorText, llmText, type CodeParams } from "./llmErrors";
import { AccountWizard } from "./AccountWizard";
import { llmKeys, specFor, useAccounts, useRoutes, type ProviderAccount } from "./llmApi";
import { useProviders } from "./profileModel";
import { ProviderAvatar } from "./ProviderAvatar";
import classes from "./models.module.css";

export function AccountsTab() {
  const accounts = useAccounts();
  const routes = useRoutes();
  const providers = useProviders();
  const [editing, setEditing] = useState<ProviderAccount | null>(null);
  const [opened, setOpened] = useState(false);

  const usage = (id: number) => (routes.data?.routes ?? []).filter((r) => r.members.some((m) => m.provider_id === id));
  const list = accounts.data?.accounts ?? [];

  return (
    <>
      <SectionCard
        title="Provider 帳號"
        description="先在這裡接上供應商帳號（金鑰與連線），再到「Profiles」組合要用的模型。同一家可以有多個帳號，例如三個 OpenAI 帳號。"
        icon={<IconKey size={18} />}
        actions={
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => {
              setEditing(null);
              setOpened(true);
            }}
          >
            新增 Provider 帳號
          </Button>
        }
      >
        {accounts.isPending ? (
          <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} h={150} radius="md" />
            ))}
          </SimpleGrid>
        ) : accounts.isError ? (
          <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            title="還沒有任何 Provider 帳號"
            description="從 OpenAI、Gemini、SiliconFlow、自架的 Ollama／vLLM 等 23 家中挑一家，貼上金鑰並測試。"
            action={
              <Button leftSection={<IconPlus size={16} />} onClick={() => setOpened(true)}>
                新增第一個帳號
              </Button>
            }
          />
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="md">
            {list.map((a, i) => (
              <AccountCard
                key={a.id}
                account={a}
                label={specFor(providers.data, a.provider)?.label ?? a.provider}
                keyRequired={Boolean(specFor(providers.data, a.provider)?.keyRequired)}
                usedBy={usage(a.id).map((r) => r.name)}
                index={i}
                onEdit={() => {
                  setEditing(a);
                  setOpened(true);
                }}
              />
            ))}
          </SimpleGrid>
        )}
      </SectionCard>
      <AccountWizard opened={opened} onClose={() => setOpened(false)} existing={editing} accounts={list} />
    </>
  );
}

function AccountCard({
  account: a,
  label,
  keyRequired,
  usedBy,
  index,
  onEdit,
}: {
  account: ProviderAccount;
  label: string;
  keyRequired: boolean;
  usedBy: string[];
  index: number;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string; code?: string; params?: CodeParams; models: string[] }>("/admin/api/llm/accounts/test", { id: a.id, provider: a.provider, base_url: a.base_url, params: a.params }),
    onSuccess: (r) => {
      if (r.ok) notify.success(`「${a.name}」連線正常，${r.models.length} 個模型`);
      else notify.error(llmText(r), `「${a.name}」測試失敗`);
      void qc.invalidateQueries({ queryKey: llmKeys.accounts });
    },
    onError: (e) => notify.error(llmErrorText(e), "測試失敗"),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch(`/admin/api/llm/accounts/${a.id}`, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["llm"] }),
    onError: (e) => notify.error(llmErrorText(e), "無法變更"),
  });
  const remove = () =>
    confirmAction({
      title: `刪除帳號「${a.name}」？`,
      message: usedBy.length ? "這個帳號仍在使用中，目前無法刪除。" : "連線設定與金鑰會被永久刪除。",
      consequences: usedBy.length ? [`仍被 ${usedBy.map((n) => `「${n}」`).join("")} 使用；請先從這些 Profile 移除它的模型，再刪除帳號。`] : undefined,
      danger: true,
      confirmLabel: "刪除",
      // In use: the server refuses, so do not offer the button at all.
      confirmDisabled: usedBy.length > 0,
      typeToConfirm: usedBy.length ? undefined : a.name,
      onConfirm: async () => {
        try {
          await api.del(`/admin/api/llm/accounts/${a.id}`);
          notify.success(`已刪除「${a.name}」`);
          await qc.invalidateQueries({ queryKey: ["llm"] });
        } catch (err) {
          notify.error(llmErrorText(err), "刪除失敗");
          throw err;
        }
      },
    });

  const lt = a.last_test;
  return (
    <Card className={classes.accountCard} style={{ animationDelay: `${index * 40}ms`, opacity: a.enabled ? 1 : 0.6 }} data-disabled={!a.enabled || undefined}>
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <ProviderAvatar provider={a.provider} label={label} size={40} />
            <Box style={{ minWidth: 0 }}>
              <Text fw={650} truncate="end">
                {a.name}
              </Text>
              <Text fz="xs" c="dimmed" truncate="end">
                {label}
              </Text>
            </Box>
          </Group>
          <Group gap={4} wrap="nowrap">
            <Tooltip label={a.enabled ? "停用帳號" : "啟用帳號"}>
              <Switch size="sm" checked={a.enabled} onChange={(e) => toggle.mutate(e.currentTarget.checked)} aria-label="啟用" />
            </Tooltip>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" aria-label="帳號動作">
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconPlugConnected size={14} />} onClick={() => test.mutate()}>
                  測試連線
                </Menu.Item>
                <Menu.Item leftSection={<IconPencil size={14} />} onClick={onEdit}>
                  編輯
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={remove}>
                  刪除
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
        <Text fz="xs" ff="monospace" c="dimmed" truncate="end" title={a.base_url}>
          {a.base_url}
        </Text>
        <Group gap={6} wrap="wrap">
          {a.oauth ? (
            <>
              <Tooltip label={`由 ${a.oauth.connected_by} 登入`}>
                <Badge size="sm" variant="light" color={a.oauth.status === "ok" ? "teal" : "red"} tt="none">
                  {a.oauth.status === "ok" ? a.oauth.email || "已登入" : "需重新登入"}
                </Badge>
              </Tooltip>
              {a.params.allow_role_use !== true && (
                <Tooltip label="只能手動測試，不會被分析工作使用。可在編輯中開啟。">
                  <Badge size="sm" variant="outline" color="amber" tt="none">
                    未允許角色使用
                  </Badge>
                </Tooltip>
              )}
            </>
          ) : a.has_api_key ? (
            <Badge size="sm" variant="light" color="teal" tt="none" leftSection={<IconKey size={11} />}>
              金鑰已設定
            </Badge>
          ) : (
            <Badge size="sm" variant="light" color={keyRequired ? "red" : "gray"} tt="none">
              {keyRequired ? "缺少金鑰" : "無金鑰"}
            </Badge>
          )}
          {typeof a.params.rpm === "number" && (
            <Badge size="sm" variant="light" color="gray" tt="none">
              {a.params.rpm.toLocaleString()} RPM
            </Badge>
          )}
          {usedBy.length > 0 ? (
            <Tooltip label={usedBy.join("、")}>
              <Badge size="sm" variant="light" color="indigo" tt="none">
                用於 {usedBy.length} 個 Profile
              </Badge>
            </Tooltip>
          ) : (
            <Badge size="sm" variant="outline" color="gray" tt="none">
              尚未使用
            </Badge>
          )}
        </Group>
        <Group gap={6} className={classes.testLine}>
          {test.isPending ? (
            <Text fz="xs" c="dimmed">
              測試中…
            </Text>
          ) : lt ? (
            <>
              {lt.ok ? <IconCircleCheck size={14} color="var(--mantine-color-teal-6)" /> : <IconCircleX size={14} color="var(--mantine-color-red-6)" />}
              <Text fz="xs" c={lt.ok ? "dimmed" : "red"} lineClamp={1} style={{ flex: 1 }}>
                {lt.ok ? `連線正常${typeof lt.model_count === "number" ? `・${lt.model_count} 個模型` : ""}` : llmText(lt, "失敗")}
              </Text>
              {lt.at && <RelativeTime value={lt.at} fz="xs" c="dimmed" />}
            </>
          ) : (
            <Button size="compact-xs" variant="subtle" leftSection={<IconPlugConnected size={12} />} onClick={() => test.mutate()}>
              尚未測試，立即測試
            </Button>
          )}
        </Group>
        {test.isError && (
          <Text fz="xs" c="red">
            {llmErrorText(test.error)}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

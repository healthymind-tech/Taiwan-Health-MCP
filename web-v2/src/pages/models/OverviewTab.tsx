import { Accordion, Anchor, Badge, Box, Button, Group, Menu, Progress, SimpleGrid, Skeleton, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconBrain, IconCheck, IconChevronDown, IconCpu, IconFingerprint, IconKey, IconRoute, IconSettings, IconStack2, IconVectorTriangle } from "@tabler/icons-react";
import { useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import { notify } from "@/components/notify";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { api } from "@/lib/api";
import { llmErrorText } from "./llmErrors";
import { fmtNumber, fmtPercent } from "@/lib/format";
import { qk } from "@/lib/queryKeys";
import type { LlmProfileKind, LlmProfileStats } from "@/lib/types";
import { SettingsGroupForm } from "../integrations/SettingsGroupForm";
import { useSettings } from "../integrations/settingsModel";
import { EmbeddingSwitchModal } from "./EmbeddingSwitch";
import { flattenRoute, llmKeys, STRATEGY_META, useAccounts, useEmbeddingIdentity, useRoutes, type FlatLeaf, type ProviderAccount, type Route } from "./llmApi";
import { useProviders } from "./profileModel";
import { ProviderAvatar } from "./ProviderAvatar";
import { SystemMap } from "./SystemMap";
import classes from "./overview.module.css";

const ROLE_META: Record<LlmProfileKind, { title: string; description: string; icon: typeof IconBrain; color: string; tone: string }> = {
  analysis: { title: "分析 LLM", description: "從藥品仿單 OCR 結果萃取結構化資料", icon: IconBrain, color: "var(--mantine-color-brand-5)", tone: "brand" },
  embedding: { title: "Embedding", description: "語意搜尋與各模組的向量工作", icon: IconVectorTriangle, color: "var(--mantine-color-indigo-5)", tone: "indigo" },
};

/** Model endpoints at a glance: health numbers, the whole routing map, and each role's request order. */
export function OverviewTab() {
  const routes = useRoutes();
  const accounts = useAccounts();
  const providers = useProviders();
  const labels = useMemo(() => Object.fromEntries((providers.data ?? []).map((s) => [s.id, s.label])), [providers.data]);

  if (routes.isPending || accounts.isPending) {
    return (
      <Stack gap="lg">
        <SimpleGrid cols={{ base: 2, md: 4 }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} h={96} radius="md" />
          ))}
        </SimpleGrid>
        <Skeleton h={420} radius="md" />
      </Stack>
    );
  }

  const all = routes.data?.routes ?? [];
  const roles = routes.data?.roles ?? { analysis: null, embedding: null };
  const cooling = routes.data?.cooling ?? {};
  const stats = routes.data?.stats ?? {};
  const accs = accounts.data?.accounts ?? [];
  const routeMap = new Map(all.map((r) => [r.id, r]));
  const accMap = new Map(accs.map((a) => [a.id, a]));
  const leavesOf = (role: LlmProfileKind) => (roles[role] && routeMap.get(roles[role]!) ? flattenRoute(routeMap.get(roles[role]!)!, routeMap, accMap) : []);
  const allLeaves = [...leavesOf("analysis"), ...leavesOf("embedding")];
  const usable = allLeaves.filter((l) => !l.skipped);
  const coolingCount = usable.filter((l) => cooling[String(l.member.id)]).length;
  const failingAccounts = accs.filter((a) => a.enabled && ((a.last_test && !a.last_test.ok) || (a.oauth && a.oauth.status !== "ok"))).length;
  const day = leavesOf("analysis").map((l) => stats[String(l.member.id)]?.window24h).filter(Boolean) as LlmProfileStats["window24h"][];
  const calls = day.reduce((s, w) => s + w.calls, 0);
  const failures = day.reduce((s, w) => s + w.failures, 0);

  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatCard
          label="Provider 帳號"
          value={fmtNumber(accs.length)}
          hint={failingAccounts ? `${failingAccounts} 個測試失敗或需重新登入` : `${accs.filter((a) => a.enabled).length} 個啟用中`}
          icon={<IconKey size={18} />}
          color={failingAccounts ? "red" : "brand"}
        />
        <StatCard label="Profiles" value={fmtNumber(all.length)} hint={`${(["analysis", "embedding"] as const).filter((r) => roles[r]).length} / 2 個角色已指定`} icon={<IconStack2 size={18} />} color="indigo" />
        <StatCard
          label="可用模型"
          value={fmtNumber(usable.length)}
          hint={coolingCount ? `${coolingCount} 個冷卻中` : "全部正常"}
          icon={<IconCpu size={18} />}
          color={coolingCount ? "amber" : "teal"}
        />
        <StatCard
          label="分析呼叫（24 小時）"
          value={fmtNumber(calls)}
          hint={calls ? `失敗率 ${fmtPercent(failures, calls, 1)}` : "尚無呼叫"}
          icon={<IconRoute size={18} />}
          color={calls && failures / calls > 0.2 ? "red" : "brand"}
          progress={calls ? Math.round((1 - failures / calls) * 100) : undefined}
        />
      </SimpleGrid>

      <SectionCard title="路由全景" description="請求從角色出發，經過指定的 Profile，落到哪個帳號的哪個模型。滑過或點選角色可只看它的路徑。" icon={<IconRoute size={18} />}>
        <SystemMap routes={all} roles={roles} accounts={accs} labels={labels} cooling={cooling} />
      </SectionCard>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        {(["analysis", "embedding"] as const).map((role) => (
          <RoleCard key={role} role={role} routes={all} boundId={roles[role]} leaves={leavesOf(role)} stats={stats} cooling={cooling} labels={labels} accounts={accs} />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

function RoleCard({
  role,
  routes,
  boundId,
  leaves,
  stats,
  cooling,
  labels,
}: {
  role: LlmProfileKind;
  routes: Route[];
  boundId: number | null;
  leaves: FlatLeaf[];
  stats: Record<string, LlmProfileStats>;
  cooling: Record<string, number>;
  labels: Record<string, string>;
  accounts: ProviderAccount[];
}) {
  const meta = ROLE_META[role];
  const qc = useQueryClient();
  const settings = useSettings();
  const [, setParams] = useSearchParams();
  const group = settings.data?.groups.find((g) => g.group === role);
  const bound = routes.find((r) => r.id === boundId);
  const options = routes.filter((r) => r.kind === role);

  const bind = useMutation({
    mutationFn: (routeId: number) => api.put("/admin/api/llm/roles", { role, route_id: routeId }),
    onSuccess: async () => {
      notify.success(`${meta.title} 已改用新的 Profile，新請求立即套用`);
      await qc.invalidateQueries({ queryKey: llmKeys.routes });
      void qc.invalidateQueries({ queryKey: qk.services });
      if (role === "embedding") void qc.invalidateQueries({ queryKey: qk.embedding });
    },
    onError: (e) => notify.error(llmErrorText(e), "無法切換"),
  });

  return (
    <Box className={classes.roleCard} style={{ "--accent": meta.color } as CSSProperties}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
        <Group gap="sm" wrap="nowrap">
          <Box className={classes.roleIcon}>
            <meta.icon size={20} />
          </Box>
          <Box>
            <Text fw={700}>{meta.title}</Text>
            <Text fz="xs" c="dimmed">
              {meta.description}
            </Text>
          </Box>
        </Group>
      </Group>

      <Menu position="bottom-start" width="target" withinPortal>
        <Menu.Target>
          <UnstyledButton className={classes.picker} disabled={bind.isPending} aria-label={`${meta.title} 使用的 Profile`}>
            <Group gap="sm" wrap="nowrap" justify="space-between">
              <Box style={{ minWidth: 0 }}>
                <Text fz={10} c="dimmed" fw={700} tt="uppercase">
                  使用中的 Profile
                </Text>
                <Text fw={650} truncate="end">
                  {bound?.name ?? "（未指定）"}
                </Text>
                {bound && (
                  <Text fz="xs" c="dimmed">
                    {STRATEGY_META[bound.strategy].label}・{leaves.filter((l) => !l.skipped).length} 個可用模型
                  </Text>
                )}
              </Box>
              <IconChevronDown size={18} />
            </Group>
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          {options.length === 0 && <Menu.Label>尚無 {meta.title} Profile</Menu.Label>}
          {options.map((r) => (
            <Menu.Item key={r.id} onClick={() => r.id !== boundId && bind.mutate(r.id)} rightSection={r.id === boundId ? <IconCheck size={14} /> : undefined}>
              <Text fz="sm" fw={600}>
                {r.name}
              </Text>
              <Text fz="xs" c="dimmed">
                {STRATEGY_META[r.strategy].label}・{r.members.length} 個成員
              </Text>
            </Menu.Item>
          ))}
          <Menu.Divider />
          <Menu.Item leftSection={<IconStack2 size={14} />} onClick={() => setParams({ tab: "profiles" })}>
            管理 Profiles…
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      {!bound ? (
        <Box className={classes.warn}>
          <IconAlertTriangle size={16} />
          <Text fz="sm">{role === "embedding" ? "未指定：語意搜尋會退回純關鍵字比對。" : "未指定：藥品仿單分析無法執行。"}</Text>
        </Box>
      ) : (
        <Box>
          <Group justify="space-between" mb={6}>
            <Text fz="xs" fw={700} c="dimmed">
              請求順序
            </Text>
            {role === "analysis" && (
              <Text fz={10.5} c="dimmed">
                24 小時呼叫／失敗
              </Text>
            )}
          </Group>
          <Stack gap={6}>
            {leaves.map((l) => {
              const w = stats[String(l.member.id)]?.window24h;
              const cool = cooling[String(l.member.id)];
              return (
                <Box key={l.member.id} className={classes.orderRow} data-skipped={l.skipped ? true : undefined}>
                  <Text className={classes.rank}>{l.rank || "–"}</Text>
                  <ProviderAvatar provider={l.account?.provider ?? "?"} label={l.account ? labels[l.account.provider] : undefined} size={26} />
                  <Box style={{ minWidth: 0, flex: 1 }}>
                    <Group gap={6} wrap="nowrap">
                      <Text fz="xs" fw={650} ff="monospace" truncate="end">
                        {l.member.model}
                      </Text>
                      {cool && (
                        <Badge size="xs" color="amber" variant="light">
                          冷卻
                        </Badge>
                      )}
                      {l.skipped && (
                        <Badge size="xs" color="gray" variant="light">
                          略過
                        </Badge>
                      )}
                    </Group>
                    <Text fz={10.5} c="dimmed" truncate="end">
                      {l.account?.name ?? "（帳號已刪除）"}
                      {l.via.length > 0 && `・經由 ${l.via.join(" › ")}`}
                    </Text>
                    {!l.skipped && (
                      <Progress value={l.share * 100} size={3} mt={4} color={meta.tone} radius="xl" className={classes.shareBar} />
                    )}
                  </Box>
                  <Tooltip label={l.share > 0 ? "請求先送這裡的機率" : "前面的模型失敗時才會用到"}>
                    <Text fz="xs" fw={700} c={l.share > 0 ? meta.tone : "dimmed"} className={classes.share}>
                      {l.skipped ? "—" : l.share > 0 ? `${Math.round(l.share * 100)}%` : "備援"}
                    </Text>
                  </Tooltip>
                  {role === "analysis" && (
                    <Text fz={10.5} c={w && w.calls && w.failures / w.calls > 0.2 ? "red" : "dimmed"} className={classes.calls}>
                      {w && w.calls ? `${fmtNumber(w.calls)}／${fmtNumber(w.failures)}` : "—"}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Stack>
        </Box>
      )}

      {role === "embedding" && <EmbeddingIdentityPanel />}

      {group && (
        <Accordion variant="contained" radius="md" chevronPosition="right">
          <Accordion.Item value="settings">
            <Accordion.Control icon={<IconSettings size={16} />}>
              <Text fz="sm" fw={600}>
                角色共用設定
              </Text>
              <Text fz="xs" c="dimmed">
                {role === "embedding" ? "逾時、批次大小、並行請求數" : "最大重試次數"}
              </Text>
            </Accordion.Control>
            <Accordion.Panel>
              <SettingsGroupForm group={group} cols={role === "embedding" ? 2 : 1} />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
      {!bound && options.length === 0 && (
        <Button variant="light" size="xs" leftSection={<IconStack2 size={14} />} onClick={() => setParams({ tab: "profiles" })}>
          建立 {meta.title} Profile
        </Button>
      )}
      <Anchor component="button" type="button" fz="xs" onClick={() => setParams({ tab: "profiles" })} style={{ alignSelf: "flex-start" }}>
        編輯 Profile 內容 →
      </Anchor>
    </Box>
  );
}

/** The system's embedding fingerprint: which model every vector comes from, and the switch entry point. */
function EmbeddingIdentityPanel() {
  const q = useEmbeddingIdentity();
  const [open, setOpen] = useState(false);
  const id = q.data?.identity;
  const total = (q.data?.counts ?? []).reduce((s, c) => s + c.count, 0);
  return (
    <Box className={classes.identity}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Box className={classes.fingerprint} data-switching={id?.state === "switching" || undefined}>
            <IconFingerprint size={20} />
          </Box>
          <Box style={{ minWidth: 0 }}>
            <Text fz={10} fw={700} c="dimmed" tt="uppercase">
              系統 Embedding 指紋
            </Text>
            {q.isPending ? (
              <Text fz="sm" c="dimmed">
                讀取中…
              </Text>
            ) : id ? (
              <>
                <Text fz="sm" fw={650} ff="monospace" truncate="end">
                  {id.model}
                </Text>
                <Text fz="xs" c="dimmed">
                  {id.dimensions} 維・{id.account_name || id.provider}・第 {id.version} 版
                </Text>
              </>
            ) : (
              <Text fz="xs" c="dimmed">
                尚未建立。下次儲存或指定 Embedding Profile 時，會以實際產生向量的模型自動建立。
              </Text>
            )}
          </Box>
        </Group>
        <Button size="xs" variant="light" color="red" onClick={() => setOpen(true)} leftSection={<IconFingerprint size={14} />}>
          切換模型…
        </Button>
      </Group>
      {id?.state === "switching" && (
        <Text fz="xs" c="amber.7" mt="xs">
          切換進行中：Embedding 端點暫時關閉，語意搜尋改為關鍵字比對。
        </Text>
      )}
      <Group gap={6} mt="sm" wrap="wrap">
        {(q.data?.counts ?? []).map((c) => (
          <Badge key={c.table} size="sm" variant={c.count ? "light" : "outline"} color={c.count ? "indigo" : "gray"} tt="none">
            {c.label} {fmtNumber(c.count)}
          </Badge>
        ))}
      </Group>
      <Text fz={11} c="dimmed" mt={6}>
        共 {fmtNumber(total)} 筆向量都來自這個模型。新加入的 Embedding 模型會用 {q.data?.probe_count ?? 6} 句固定文字比對，相似度須 ≥ {q.data?.min_similarity ?? 0.95} 才視為同一模型。
      </Text>
      <EmbeddingSwitchModal opened={open} onClose={() => setOpen(false)} payload={q.data} />
    </Box>
  );
}

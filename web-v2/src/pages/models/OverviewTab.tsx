import { Accordion, Alert, Anchor, Badge, Box, Button, Group, Menu, Progress, SimpleGrid, Skeleton, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconBrain, IconCheck, IconChevronDown, IconCpu, IconFingerprint, IconKey, IconRoute, IconSettings, IconStack2, IconVectorTriangle } from "@tabler/icons-react";
import { useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import { notify } from "@/components/notify";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { api } from "@/lib/api";
import { codeText, GUIDE_CODES, llmErrorInfo, llmErrorText, type LlmErrorInfo } from "./llmErrors";
import { EmbeddingGuide } from "./EmbeddingGuide";
import { fmtNumber, fmtPercent } from "@/lib/format";
import { qk } from "@/lib/queryKeys";
import type { LlmProfileKind, LlmProfileStats } from "@/lib/types";
import { SettingsGroupForm } from "../integrations/SettingsGroupForm";
import { useSettings } from "../integrations/settingsModel";
import { EmbeddingSwitchModal } from "./EmbeddingSwitch";
import {
  embeddingHealthKey,
  embeddingKeys,
  flattenRoute,
  llmKeys,
  STRATEGY_META,
  useAccounts,
  useEmbeddingHealth,
  useEmbeddingIdentity,
  useRoutes,
  type EmbeddingHealth,
  type FlatLeaf,
  type ProviderAccount,
  type Route,
} from "./llmApi";
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
  const [guide, setGuide] = useState<LlmErrorInfo | null>(null);
  const health = useEmbeddingHealth(role === "embedding" && Boolean(bound));
  const healthBy = new Map((health.data?.members ?? []).map((m) => [m.member_id, m]));

  const bind = useMutation({
    mutationFn: (routeId: number) => api.put("/admin/api/llm/roles", { role, route_id: routeId }),
    onSuccess: async () => {
      notify.success(`${meta.title} 已改用新的 Profile，新請求立即套用`);
      await qc.invalidateQueries({ queryKey: llmKeys.routes });
      void qc.invalidateQueries({ queryKey: qk.services });
      if (role === "embedding") void qc.invalidateQueries({ queryKey: qk.embedding });
    },
    onError: (e) => {
      const info = llmErrorInfo(e);
      // Binding a profile of another embedding model is a model change: explain and offer the switch.
      if (info.code && GUIDE_CODES.has(info.code)) setGuide(info);
      else notify.error(info.text, "無法切換");
      // A refused binding may still have established the identity (first check).
      void qc.invalidateQueries({ queryKey: ["llm", "embedding"] });
    },
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
                      {!l.skipped && healthBy.get(l.member.id)?.ok === false && (
                        <Tooltip label={codeText(healthBy.get(l.member.id)!.issue?.code, healthBy.get(l.member.id)!.issue?.params) ?? "探測失敗"} multiline maw={320}>
                          <Badge size="xs" color="red" variant="light">
                            失敗
                          </Badge>
                        </Tooltip>
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

      {role === "embedding" && bound && health.data?.degraded && <EmbeddingHealthAlert health={health.data} />}
      {role === "embedding" && <EmbeddingIdentityPanel />}
      <EmbeddingGuide info={guide} onClose={() => setGuide(null)} />

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

/**
 * "Member X fails (model not found) — requests go to Y": visible on the
 * overview so a broken endpoint is noticed before anyone edits the profile.
 */
function EmbeddingHealthAlert({ health }: { health: EmbeddingHealth }) {
  const qc = useQueryClient();
  const [, setParams] = useSearchParams();
  const recheck = useMutation({
    mutationFn: () => api.post<EmbeddingHealth>("/admin/api/llm/embedding/health", { fresh: true }),
    onSuccess: (h) => qc.setQueryData(embeddingHealthKey, h),
    onError: (e) => notify.error(llmErrorText(e), "重新檢查失敗"),
  });
  const failing = health.members.filter((m) => !m.ok);
  return (
    <Alert
      color={health.down ? "red" : "amber"}
      icon={<IconAlertTriangle size={18} />}
      title={health.down ? "Embedding 全部成員都失敗：語意搜尋已退回關鍵字比對" : `Embedding 路由降級：${failing.length} 個成員失敗，正由「${health.answering}」備援`}
    >
      <Stack gap={6}>
        {failing.map((m) => (
          <Box key={m.member_id}>
            <Text fz="xs" fw={650} ff="monospace" style={{ wordBreak: "break-all" }}>
              {m.name}
            </Text>
            <Text fz="xs">{codeText(m.issue?.code, m.issue?.params) ?? "探測失敗。"}</Text>
          </Box>
        ))}
        <Text fz="xs" c="dimmed">
          修正方式：到 Profiles 把這個成員改成伺服器實際提供的同一個模型，或先停用／移除它。若伺服器已換成不同的模型，請用下方「切換模型…」重建向量——直接改 Profile 會被拒絕。
        </Text>
        <Group gap="xs">
          <Button size="compact-xs" variant="light" onClick={() => setParams({ tab: "profiles" })}>
            前往 Profiles
          </Button>
          <Button size="compact-xs" variant="subtle" color="gray" loading={recheck.isPending} onClick={() => recheck.mutate()}>
            重新檢查
          </Button>
          <Text fz={10.5} c="dimmed">
            檢查於 {new Date(health.checked_at).toLocaleTimeString("zh-TW", { hour12: false })}
          </Text>
        </Group>
      </Stack>
    </Alert>
  );
}

/** The system's embedding fingerprint: which model every vector comes from, and the switch entry point. */
function EmbeddingIdentityPanel() {
  const q = useEmbeddingIdentity();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [guide, setGuide] = useState<LlmErrorInfo | null>(null);
  const establish = useMutation({
    mutationFn: () => api.post<{ ok: boolean; created: boolean; identity: { model: string; dimensions: number } | null }>("/admin/api/llm/embedding/establish", {}),
    onSuccess: (r) => {
      if (r.identity) notify.success(`已確認現有向量來自 ${r.identity.model}（${r.identity.dimensions} 維），並建立系統指紋`);
      else notify.info("目前沒有可用的 Embedding 端點；系統尚無向量，之後儲存時會自動建立。");
      void qc.invalidateQueries({ queryKey: embeddingKeys.identity });
    },
    onError: (e) => {
      const info = llmErrorInfo(e);
      if (info.code && GUIDE_CODES.has(info.code)) setGuide(info);
      else notify.error(info.text, "無法建立指紋");
    },
  });
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
                尚未建立。系統會請各端點重新產生幾筆既有向量來比對，以確認它們是哪個模型產生的（下次儲存 Embedding Profile 時也會自動進行）。
              </Text>
            )}
          </Box>
        </Group>
        <Button size="xs" variant="light" color="red" onClick={() => setOpen(true)} leftSection={<IconFingerprint size={14} />} style={{ flexShrink: 0 }}>
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
        {id ? `共 ${fmtNumber(total)} 筆向量都來自這個模型。` : `共 ${fmtNumber(total)} 筆向量，來源模型尚未確認。`}新加入的 Embedding 模型會用 {q.data?.probe_count ?? 6} 句固定文字比對，相似度須 ≥ {q.data?.min_similarity ?? 0.95} 才視為同一模型。
      </Text>
      {!q.isPending && !id && total > 0 && (
        <Button size="xs" variant="light" mt="xs" leftSection={<IconFingerprint size={14} />} loading={establish.isPending} onClick={() => establish.mutate()}>
          確認現有向量的模型並建立指紋
        </Button>
      )}
      <EmbeddingSwitchModal opened={open} onClose={() => setOpen(false)} payload={q.data} />
      <EmbeddingGuide info={guide} onClose={() => setGuide(null)} />
    </Box>
  );
}

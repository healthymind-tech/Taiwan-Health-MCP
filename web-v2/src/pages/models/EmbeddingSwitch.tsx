import { Alert, Badge, Box, Button, Group, Modal, NumberInput, Progress, Select, SimpleGrid, Stack, Text, TextInput, ThemeIcon, Timeline } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconArrowRight, IconCheck, IconFingerprint, IconPlugOff, IconRefresh, IconTrash, IconVectorTriangle } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "@/lib/api";
import { fmtNumber } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { embeddingKeys, llmKeys, specFor, useAccountModels, useAccounts, type EmbeddingIdentityPayload, type FingerprintResult } from "./llmApi";
import { MONO_INPUT } from "./fields";
import { llmErrorText, llmText } from "./llmErrors";
import { useProviders } from "./profileModel";
import { ProviderAvatar } from "./ProviderAvatar";
import classes from "./overview.module.css";

interface SwitchResult {
  ok: boolean;
  steps: { key: string; label: string; ok: boolean; detail: string }[];
  jobs: string[];
  profile: { id: number; name: string };
}

/**
 * Dropdowns in this full-screen (phone) modal: a `fixed` dropdown never adds to
 * the page's scroll width. With the default `absolute` strategy the first frame
 * is placed from a stale position, overflows to the right, widens the mobile
 * layout viewport, and the resulting reflow closes it again — an endless loop
 * that made the select impossible to tap.
 */
const COMBOBOX_PROPS = { strategy: "fixed", position: "bottom-start", middlewares: { flip: true, shift: true } } as const;

const PLANNED_STEPS = [
  { icon: IconPlugOff, label: "關閉所有 Embedding 端點", detail: "語意搜尋暫時改為關鍵字比對，不再寫入舊模型的向量。" },
  { icon: IconRefresh, label: "停止向量工作", detail: "取消排隊與進行中的向量工作，等它們完全停止。" },
  { icon: IconTrash, label: "清除舊向量", detail: "清空所有模組的向量表。" },
  { icon: IconFingerprint, label: "設定新的系統 Embedding 模型", detail: "以新模型重新建立系統指紋，Embedding 角色改用新模型。" },
  { icon: IconVectorTriangle, label: "重新開放並重建索引", detail: "為每個有資料的模組排入向量重建工作。" },
];

/**
 * Change the system's embedding model. With vectors present this is a full
 * re-index, so it states the cost, requires typing REINDEX, and narrates the
 * server's steps.
 */
export function EmbeddingSwitchModal({ opened, onClose, payload }: { opened: boolean; onClose: () => void; payload: EmbeddingIdentityPayload | undefined }) {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const providers = useProviders();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [dims, setDims] = useState<number | "">(payload?.identity?.dimensions ?? 1024);
  const [check, setCheck] = useState<FingerprintResult | null>(null);
  const [confirm, setConfirm] = useState("");
  const [result, setResult] = useState<SwitchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setAccountId(null);
    setModel("");
    setDims(payload?.identity?.dimensions ?? 1024);
    setCheck(null);
    setConfirm("");
    setResult(null);
    setError(null);
  }, [opened, payload?.identity?.dimensions]);

  const embedAccounts = (accounts.data?.accounts ?? []).filter((a) => a.enabled && specFor(providers.data, a.provider)?.roles.includes("embedding"));
  const acc = embedAccounts.find((a) => String(a.id) === accountId);
  const models = useAccountModels(acc?.id ?? null, "embedding", Boolean(acc));
  const total = (payload?.counts ?? []).reduce((s, c) => s + c.count, 0);
  const hasVectors = total > 0;

  const doCheck = useMutation({
    mutationFn: () => api.post<FingerprintResult>("/admin/api/llm/embedding/check", { provider_id: acc?.id, model, params: { dimensions: dims } }),
    onMutate: () => {
      setCheck(null);
      setError(null);
    },
    onSuccess: setCheck,
    onError: (e) => setError(llmErrorText(e)),
  });

  const doSwitch = useMutation({
    mutationFn: () => api.post<SwitchResult>("/admin/api/llm/embedding/switch", { provider_id: acc?.id, model, params: { dimensions: dims }, confirm }),
    onSuccess: async (r) => {
      setResult(r);
      await qc.invalidateQueries({ queryKey: ["llm"] });
      await qc.invalidateQueries({ queryKey: embeddingKeys.identity });
      void qc.invalidateQueries({ queryKey: llmKeys.routes });
    },
    onError: (e) => setError(llmErrorText(e)),
  });

  const same = check?.ok && !check.anchor_missing;
  const canSwitch = Boolean(acc && model.trim() && check && !check.unreachable && !check.incompatible && !same && (!hasVectors || confirm === "REINDEX"));

  return (
    <Modal opened={opened} onClose={doSwitch.isPending ? () => undefined : onClose} title="切換系統 Embedding 模型" size="lg" fullScreen={isMobile} closeOnClickOutside={!doSwitch.isPending}>
      {result ? (
        <Stack gap="md">
          <Group gap="sm">
            <ThemeIcon size={40} radius="xl" color="teal" className={classes.popIn}>
              <IconCheck size={22} />
            </ThemeIcon>
            <Box>
              <Text fw={700}>已切換為 {model}</Text>
              <Text fz="sm" c="dimmed">
                Embedding 角色改用「{result.profile.name}」。{result.jobs.length ? `重建工作已排入 ${result.jobs.length} 個模組。` : ""}
              </Text>
            </Box>
          </Group>
          <Timeline active={result.steps.length} bulletSize={22} lineWidth={2}>
            {result.steps.map((s, i) => (
              <Timeline.Item key={s.key} bullet={<IconCheck size={12} />} title={s.label} className={classes.stepIn} style={{ animationDelay: `${i * 140}ms` }}>
                <Text fz="xs" c="dimmed">
                  {s.detail}
                </Text>
              </Timeline.Item>
            ))}
          </Timeline>
          <Group justify="flex-end">
            <Button component={Link} to="/jobs" variant="light">
              查看重建進度
            </Button>
            <Button onClick={onClose}>完成</Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          {payload?.identity && (
            <Group gap="xs" wrap="nowrap" className={classes.fromTo}>
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text fz={10} fw={700} c="dimmed">
                  目前
                </Text>
                <Text fz="sm" fw={650} ff="monospace" truncate="end">
                  {payload.identity.model}
                </Text>
                <Text fz={11} c="dimmed">
                  {payload.identity.dimensions} 維・{fmtNumber(total)} 筆向量
                </Text>
              </Box>
              <IconArrowRight size={20} />
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text fz={10} fw={700} c="dimmed">
                  新模型
                </Text>
                <Text fz="sm" fw={650} ff="monospace" truncate="end">
                  {model || "—"}
                </Text>
                <Text fz={11} c="dimmed">
                  {acc?.name ?? "選擇下方帳號與模型"}
                </Text>
              </Box>
            </Group>
          )}

          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label="Provider 帳號"
              placeholder="選擇支援 Embedding 的帳號"
              data={embedAccounts.map((a) => ({ value: String(a.id), label: `${a.name}（${specFor(providers.data, a.provider)?.label ?? a.provider}）` }))}
              value={accountId}
              onChange={(v) => {
                setAccountId(v);
                setModel("");
                setCheck(null);
              }}
              leftSection={acc ? <ProviderAvatar provider={acc.provider} size={20} /> : undefined}
              comboboxProps={COMBOBOX_PROPS}
              allowDeselect={false}
            />
            <NumberInput label="向量維度" min={1} max={16384} allowDecimal={false} value={dims} onChange={(v) => {
              setDims(v === "" ? "" : Number(v));
              setCheck(null);
            }} />
          </SimpleGrid>
          {acc && (
            <Select
              label="模型"
              searchable
              placeholder={models.isFetching ? "讀取模型清單…" : "選擇或輸入模型"}
              data={models.data?.models ?? []}
              value={model || null}
              onChange={(v) => {
                setModel(v ?? "");
                setCheck(null);
              }}
              nothingFoundMessage={models.data?.ok === false ? llmText(models.data) : "沒有符合的模型"}
              comboboxProps={COMBOBOX_PROPS}
            />
          )}
          {acc && models.data?.ok === false && (
            <TextInput label="模型（手動輸入）" styles={MONO_INPUT} value={model} onChange={(e) => {
              setModel(e.currentTarget.value);
              setCheck(null);
            }} />
          )}

          <Button variant="light" leftSection={<IconFingerprint size={16} />} onClick={() => doCheck.mutate()} loading={doCheck.isPending} disabled={!acc || !model.trim() || dims === ""}>
            比對指紋
          </Button>

          {check && (
            <Box className={classes.checkResult} data-same={same || undefined}>
              <Group gap="sm" wrap="nowrap">
                <ThemeIcon radius="xl" color={same ? "teal" : check.anchor_missing ? "blue" : "amber"} variant="light">
                  <IconFingerprint size={16} />
                </ThemeIcon>
                <Box style={{ flex: 1 }}>
                  <Text fz="sm" fw={650}>
                    {check.unreachable
                      ? "端點沒有回應"
                      : check.incompatible
                        ? "端點不支援 Embedding"
                      : same
                        ? "與系統是同一個模型，不需要切換"
                        : check.anchor_missing
                          ? "系統尚未建立指紋"
                          : check.code === "embedding_dims_mismatch" || check.code === "embedding_dims_returned"
                            ? "向量維度與系統不同"
                            : "不同的模型"}
                  </Text>
                  <Text fz="xs" c="dimmed">
                    {same
                      ? "直接把它加進 Embedding Profile 當備援即可，向量不必重建。"
                      : check.min_similarity !== null
                        ? `與系統向量的相似度只有 ${check.min_similarity.toFixed(3)}（需 ≥ ${payload?.min_similarity ?? 0.95}）。`
                        : llmText(check)}
                  </Text>
                </Box>
                {check.min_similarity !== null && (
                  <Box w={90}>
                    <Text fz={10} c="dimmed" ta="right">
                      相似度
                    </Text>
                    <Progress value={Math.max(0, check.min_similarity) * 100} color={same ? "teal" : "amber"} size="sm" radius="xl" />
                  </Box>
                )}
              </Group>
            </Box>
          )}

          {check && !same && !check.unreachable && !check.incompatible && (
            <>
              {hasVectors ? (
                <Alert color="red" icon={<IconAlertTriangle size={18} />} title={`會刪除並重建全部 ${fmtNumber(total)} 筆向量`}>
                  <Stack gap="xs">
                    <Group gap={6} wrap="wrap">
                      {(payload?.counts ?? []).filter((c) => c.count > 0).map((c) => (
                        <Badge key={c.table} variant="light" color="red" tt="none">
                          {c.label} {fmtNumber(c.count)}
                        </Badge>
                      ))}
                    </Group>
                    <Text fz="xs">重建期間語意搜尋的結果會逐步變完整（SNOMED 可能需要數小時）。依序執行：</Text>
                    <Stack gap={4}>
                      {PLANNED_STEPS.map((s, i) => (
                        <Group key={i} gap={8} wrap="nowrap">
                          <ThemeIcon size={20} radius="xl" variant="light" color="red">
                            <s.icon size={12} />
                          </ThemeIcon>
                          <Text fz="xs">
                            <b>{s.label}</b>：{s.detail}
                          </Text>
                        </Group>
                      ))}
                    </Stack>
                    <TextInput label="輸入 REINDEX 確認" value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} placeholder="REINDEX" styles={MONO_INPUT} />
                  </Stack>
                </Alert>
              ) : (
                <Alert color="blue" title="系統目前沒有任何向量">
                  可以直接切換，不需要重建。新模型會成為系統的 Embedding 指紋。
                </Alert>
              )}
            </>
          )}

          {error && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} withCloseButton onClose={() => setError(null)}>
              <Text fz="sm" style={{ wordBreak: "break-word" }}>
                {error}
              </Text>
            </Alert>
          )}

          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={onClose} disabled={doSwitch.isPending}>
              取消
            </Button>
            <Button color="red" onClick={() => doSwitch.mutate()} loading={doSwitch.isPending} disabled={!canSwitch}>
              {hasVectors ? "刪除向量並切換" : "切換"}
            </Button>
          </Group>
          {doSwitch.isPending && (
            <Text fz="xs" c="dimmed" ta="right">
              正在執行：關閉端點、停止工作、清除向量…（可能需要一兩分鐘）
            </Text>
          )}
        </Stack>
      )}
    </Modal>
  );
}

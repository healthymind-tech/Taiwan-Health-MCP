import { Alert, Badge, Box, Button, Group, Modal, NumberInput, Progress, Select, SimpleGrid, Stack, Switch, Text, TextInput, ThemeIcon, Timeline } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconArrowRight, IconCheck, IconFingerprint, IconPlugOff, IconRefresh, IconRuler2, IconTrash, IconVectorTriangle } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "@/lib/api";
import { fmtNumber } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { embeddingKeys, llmKeys, specFor, useAccountModels, useAccounts, type EmbeddingIdentityPayload, type SwitchPrecheck } from "./llmApi";
import { MONO_INPUT } from "./fields";
import { EmbeddingIssueFixes, LlmErrorAlert } from "./ErrorDetails";
import { codeText, llmErrorInfo, llmText, reindexEstimate, type LlmErrorInfo } from "./llmErrors";
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
  { icon: IconTrash, label: "清除舊向量", detail: "清空所有模組的向量表；維度不同時一併調整向量欄位。" },
  { icon: IconFingerprint, label: "設定新的系統 Embedding 模型", detail: "以新模型重新建立系統指紋，Embedding 角色改用新模型。" },
  { icon: IconVectorTriangle, label: "重新開放並重建索引", detail: "為每個有資料的模組排入向量重建工作。" },
];

/** What the switch dialog opens with (from a refused profile edit / role binding). */
export interface SwitchPrefill {
  provider_id: number | null;
  model: string;
  params: Record<string, unknown>;
}

const truthy = (v: unknown): boolean => v === true || ["1", "true", "yes", "on"].includes(String(v ?? "").toLowerCase());

/**
 * Change the system's embedding model. With vectors present this is a full
 * re-index, so a pre-check (no side effects) must pass first — model served,
 * vectors of the configured size, not the same model — then it states the
 * cost, requires typing REINDEX, and narrates the server's steps.
 */
export function EmbeddingSwitchModal({
  opened,
  onClose,
  payload,
  prefill,
  onSwitched,
}: {
  opened: boolean;
  onClose: () => void;
  payload: EmbeddingIdentityPayload | undefined;
  prefill?: SwitchPrefill | null;
  onSwitched?: () => void;
}) {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const providers = useProviders();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [dims, setDims] = useState<number | "">(payload?.identity?.dimensions ?? 1024);
  const [sendDims, setSendDims] = useState(false);
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const [check, setCheck] = useState<SwitchPrecheck | null>(null);
  const [confirm, setConfirm] = useState("");
  const [result, setResult] = useState<SwitchResult | null>(null);
  const [error, setError] = useState<LlmErrorInfo | null>(null);

  useEffect(() => {
    if (!opened) return;
    const pre = prefill ?? null;
    const { dimensions, send_dimensions, ...rest } = pre?.params ?? {};
    setAccountId(pre?.provider_id ? String(pre.provider_id) : null);
    setModel(pre?.model ?? "");
    setDims(typeof dimensions === "number" ? dimensions : (payload?.identity?.dimensions ?? 1024));
    setSendDims(truthy(send_dimensions));
    setExtra(rest);
    setCheck(null);
    setConfirm("");
    setResult(null);
    setError(null);
  }, [opened, prefill, payload?.identity?.dimensions]);

  const embedAccounts = (accounts.data?.accounts ?? []).filter((a) => a.enabled && specFor(providers.data, a.provider)?.roles.includes("embedding"));
  const acc = embedAccounts.find((a) => String(a.id) === accountId);
  const models = useAccountModels(acc?.id ?? null, "embedding", Boolean(acc));
  const total = (payload?.counts ?? []).reduce((s, c) => s + c.count, 0);
  const hasVectors = total > 0;
  const params = { ...extra, dimensions: dims, ...(sendDims ? { send_dimensions: true } : {}) };
  const reset = () => {
    setCheck(null);
    setError(null);
  };

  const doCheck = useMutation({
    mutationFn: () => api.post<SwitchPrecheck>("/admin/api/llm/embedding/precheck", { provider_id: acc?.id, model, params }),
    onMutate: reset,
    onSuccess: setCheck,
    onError: (e) => setError(llmErrorInfo(e)),
  });

  const doSwitch = useMutation({
    mutationFn: () => api.post<SwitchResult>("/admin/api/llm/embedding/switch", { provider_id: acc?.id, model, params, confirm }),
    onSuccess: async (r) => {
      setResult(r);
      onSwitched?.();
      await qc.invalidateQueries({ queryKey: ["llm"] });
      await qc.invalidateQueries({ queryKey: embeddingKeys.identity });
      void qc.invalidateQueries({ queryKey: llmKeys.routes });
    },
    onError: (e) => setError(llmErrorInfo(e)),
  });

  const same = Boolean(check?.same_model);
  const canSwitch = Boolean(acc && model.trim() && check?.ok && (!hasVectors || confirm === "REINDEX"));
  const est = reindexEstimate(check?.summary as Record<string, unknown> | undefined);

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
          {(payload?.identity || hasVectors) && (
            <Group gap="xs" wrap="nowrap" className={classes.fromTo}>
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text fz={10} fw={700} c="dimmed">
                  目前
                </Text>
                <Text fz="sm" fw={650} ff="monospace" truncate="end">
                  {payload?.identity?.model ?? "（未建立指紋）"}
                </Text>
                <Text fz={11} c="dimmed">
                  {payload?.identity ? `${payload.identity.dimensions} 維・` : ""}
                  {fmtNumber(total)} 筆向量
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
                reset();
              }}
              leftSection={acc ? <ProviderAvatar provider={acc.provider} size={20} /> : undefined}
              comboboxProps={COMBOBOX_PROPS}
              allowDeselect={false}
            />
            <NumberInput label="向量維度" description="新模型實際回傳的維度；與現在不同時，向量欄位會一併調整。" min={1} max={16384} allowDecimal={false} value={dims} onChange={(v) => {
              setDims(v === "" ? "" : Number(v));
              reset();
            }} />
          </SimpleGrid>
          <Switch
            size="sm"
            label="送出維度參數（dimensions）"
            description="只有支援 Matryoshka 的模型（例如 Qwen3-Embedding）能截短維度；vLLM 另需以 --hf-overrides '{&quot;is_matryoshka&quot;: true}' 啟動。關閉時伺服器回傳模型原生維度。"
            checked={sendDims}
            onChange={(e) => {
              setSendDims(e.currentTarget.checked);
              reset();
            }}
          />
          {acc && (
            <Select
              label="模型"
              searchable
              placeholder={models.isFetching ? "讀取模型清單…" : "選擇或輸入模型"}
              data={models.data?.models ?? []}
              value={model || null}
              onChange={(v) => {
                setModel(v ?? "");
                reset();
              }}
              nothingFoundMessage={models.data?.ok === false ? llmText(models.data) : "沒有符合的模型"}
              comboboxProps={COMBOBOX_PROPS}
            />
          )}
          {acc && models.data?.ok === false && (
            <TextInput label="模型（手動輸入）" styles={MONO_INPUT} value={model} onChange={(e) => {
              setModel(e.currentTarget.value);
              reset();
            }} />
          )}

          <Button variant="light" leftSection={<IconFingerprint size={16} />} onClick={() => doCheck.mutate()} loading={doCheck.isPending} disabled={!acc || !model.trim() || dims === ""}>
            預先檢查（不會變更任何東西）
          </Button>

          {check && (
            <Box className={classes.checkResult} data-same={check.ok || undefined}>
              <Group gap="sm" wrap="nowrap" align="flex-start">
                <ThemeIcon radius="xl" color={check.ok ? "teal" : same ? "blue" : "amber"} variant="light">
                  {check.ok ? <IconCheck size={16} /> : <IconAlertTriangle size={16} />}
                </ThemeIcon>
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text fz="sm" fw={650}>
                    {check.ok ? `新模型可用：回傳 ${check.returned_dims} 維向量` : same ? "與系統是同一個模型，不需要切換" : "還不能切換"}
                  </Text>
                  {check.ok ? (
                    <Stack gap={2}>
                      <Text fz="xs" c="dimmed">
                        回應 {check.latency_ms ?? "—"} ms
                        {check.similarity !== null ? `・與現有向量相似度 ${check.similarity.toFixed(3)}（確定是不同模型）` : ""}
                      </Text>
                      {check.alter_columns && (
                        <Group gap={4} wrap="nowrap">
                          <IconRuler2 size={13} />
                          <Text fz="xs">
                            向量欄位會由 {check.column_dims ?? "?"} 維改為 {check.returned_dims} 維（在清除舊向量的同一個交易內）。
                          </Text>
                        </Group>
                      )}
                      {check.warnings.map((w) => (
                        <Text key={w.code} fz="xs" c="amber.8">
                          {codeText(w.code, w.params)}
                        </Text>
                      ))}
                    </Stack>
                  ) : (
                    check.blocking && (
                      <>
                        <Text fz="xs" style={{ wordBreak: "break-word" }}>
                          {same ? "直接把它加進 Embedding Profile 當備援即可，向量不必重建。" : llmText(check.blocking)}
                        </Text>
                        <EmbeddingIssueFixes
                          code={check.blocking.code}
                          params={check.blocking.params}
                          onPickModel={(m) => {
                            setModel(m);
                            reset();
                          }}
                          onSetDims={(d) => {
                            setDims(d);
                            setSendDims(false);
                            reset();
                          }}
                          onSendDims={(on) => {
                            setSendDims(on);
                            reset();
                          }}
                        />
                      </>
                    )
                  )}
                </Box>
                {check.similarity !== null && (
                  <Box w={90}>
                    <Text fz={10} c="dimmed" ta="right">
                      相似度
                    </Text>
                    <Progress value={Math.max(0, check.similarity) * 100} color={same ? "teal" : "amber"} size="sm" radius="xl" />
                  </Box>
                )}
              </Group>
            </Box>
          )}

          {check?.ok && (
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
                    <Text fz="xs">重建期間語意搜尋的結果會逐步變完整{est ? `，預估${est}（共用 GPU 時更久）` : "（SNOMED 可能需要數小時）"}。依序執行：</Text>
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

          {error && <LlmErrorAlert info={error} onClose={() => setError(null)} />}

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

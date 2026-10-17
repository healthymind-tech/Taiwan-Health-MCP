import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Drawer,
  Group,
  Loader,
  NumberInput,
  PasswordInput,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Stepper,
  Switch,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
  IconLock,
  IconPlugConnected,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { confirmAction, confirmIsOpen } from "@/components/confirm";
import { notify } from "@/components/notify";
import { api } from "@/lib/api";
import { useIsMobile } from "@/lib/hooks";
import type { LlmProfileKind } from "@/lib/types";
import { BaseUrlField, isHttpUrl, MONO_INPUT } from "./fields";
import { llmErrorText, llmText, type CodeParams } from "./llmErrors";
import { llmKeys, type ProviderAccount } from "./llmApi";
import { CATEGORY_LABEL, useProviders, type ProviderSpec } from "./profileModel";
import { ChatgptSignIn, ChatgptTerms, RoleUseSwitch } from "./ChatgptConnect";
import { ProviderAvatar } from "./ProviderAvatar";
import classes from "./models.module.css";

interface Draft {
  id?: number;
  provider: string;
  name: string;
  base_url: string;
  api_key: string;
  enabled: boolean;
  rpm: number | "";
  tpm: number | "";
  base_model: string;
  /** Subscription accounts: may analysis profiles use it? */
  allow_role_use: boolean;
}

interface TestResult {
  ok: boolean;
  message?: string;
  code?: string;
  params?: CodeParams;
  models: string[];
  models_ok: boolean;
  models_message: string;
  models_code?: string;
  models_params?: CodeParams;
  call: { ok: boolean; message: string; code?: string; params?: CodeParams } | null;
}

/** The listing half of a test result, in the operator's language. */
function modelsText(r: TestResult): string {
  return llmText({ code: r.models_code, params: r.models_params, message: r.models_message });
}

const ROLE_LABEL: Record<LlmProfileKind, string> = { analysis: "分析 LLM", embedding: "Embedding" };

function toDraft(a: ProviderAccount | null): Draft {
  return {
    id: a?.id,
    provider: a?.provider ?? "",
    name: a?.name ?? "",
    base_url: a?.base_url ?? "",
    api_key: "",
    enabled: a?.enabled ?? true,
    rpm: typeof a?.params.rpm === "number" ? a.params.rpm : "",
    tpm: typeof a?.params.tpm === "number" ? a.params.tpm : "",
    base_model: typeof a?.params.base_model === "string" ? a.params.base_model : "",
    allow_role_use: a?.params.allow_role_use === true,
  };
}

function payload(d: Draft, spec: ProviderSpec | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (d.rpm !== "") params.rpm = d.rpm;
  if (d.tpm !== "") params.tpm = d.tpm;
  if (d.base_model.trim()) params.base_model = d.base_model.trim();
  if (spec?.auth) params.allow_role_use = d.allow_role_use;
  const body: Record<string, unknown> = {
    name: d.name.trim(),
    provider: d.provider,
    base_url: spec?.baseUrl.fixed ? spec.baseUrl.default : d.base_url.trim(),
    enabled: d.enabled,
    params,
  };
  if (d.api_key.trim()) body.api_key = d.api_key.trim();
  return body;
}

/** Add / edit a provider account: pick a provider → connect → test and see its models. */
export function AccountWizard({
  opened,
  onClose,
  existing,
  accounts,
}: {
  opened: boolean;
  onClose: () => void;
  existing: ProviderAccount | null;
  accounts: ProviderAccount[];
}) {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const providers = useProviders();
  const [step, setStep] = useState(0);
  const [d, setD] = useState<Draft>(toDraft(existing));
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [role, setRole] = useState<LlmProfileKind>("analysis");
  const [modelFilter, setModelFilter] = useState("");
  const [probeModel, setProbeModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<boolean[]>([]);
  /** Draft the last test ran against: a result is only kept for the account it tested. */
  const [testedDraft, setTestedDraft] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setD(toDraft(existing));
    setStep(existing ? 1 : 0);
    setSearch("");
    setResult(null);
    setError(null);
    setProbeModel("");
    setModelFilter("");
    setAccepted([]);
    setTestedDraft(null);
  }, [opened, existing]);

  // A rejected save is about the values that were sent: any edit makes it stale.
  useEffect(() => setError(null), [d]);

  const spec = providers.data?.find((s) => s.id === d.provider);
  useEffect(() => {
    if (spec && !spec.roles.includes(role)) setRole(spec.roles[0]);
  }, [spec, role]);

  const pick = (s: ProviderSpec) => {
    const sameType = accounts.filter((a) => a.provider === s.id).length;
    setD((cur) => ({
      ...cur,
      provider: s.id,
      base_url: s.baseUrl.default ?? "",
      name: cur.name || (sameType ? `${s.label} ${sameType + 1}` : s.label),
    }));
    setResult(null);
    setStep(1);
  };

  const test = useMutation({
    mutationFn: (accountId?: number) =>
      api.post<TestResult>("/admin/api/llm/accounts/test", { ...payload(d, spec), id: accountId ?? d.id, kind: role, model: probeModel.trim() || undefined }),
    onMutate: () => {
      setResult(null);
      setError(null);
    },
    onSuccess: (r) => {
      setResult(r);
      setTestedDraft(JSON.stringify(payload(d, spec)));
      if (d.id) void qc.invalidateQueries({ queryKey: llmKeys.accounts });
    },
    onError: (e) => {
      const text = llmErrorText(e);
      setResult({ ok: false, message: text, models: [], models_ok: false, models_message: text, call: null });
    },
  });

  const save = useMutation({
    mutationFn: () => {
      const body = payload(d, spec);
      if (d.id) return api.patch<{ account: ProviderAccount }>(`/admin/api/llm/accounts/${d.id}`, body);
      // Keep the wizard's test with the new account (only when it tested exactly these settings).
      const lastTest =
        result && testedDraft === JSON.stringify(body)
          ? { ok: result.ok, message: result.message ?? result.models_message, model_count: result.models.length }
          : undefined;
      return api.post<{ account: ProviderAccount }>("/admin/api/llm/accounts", { ...body, last_test: lastTest });
    },
    onSuccess: async (r) => {
      notify.success(d.id ? `已更新「${r.account.name}」` : `已新增 Provider 帳號「${r.account.name}」`);
      await qc.invalidateQueries({ queryKey: ["llm"] });
      onClose();
    },
    onError: (e) => setError(llmErrorText(e)),
  });

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (providers.data ?? []).filter(
      (s) => !q || s.label.toLowerCase().includes(q) || s.id.includes(q) || s.description.toLowerCase().includes(q),
    );
    return (["cloud", "asia", "selfhost", "subscription"] as const).map((cat) => ({ cat, items: list.filter((s) => s.category === cat) })).filter((g) => g.items.length);
  }, [providers.data, search]);

  const keyRequired = Boolean(spec?.keyRequired);
  const hasStoredKey = Boolean(existing?.has_api_key);
  const nameTaken = accounts.some((a) => a.id !== d.id && a.name.trim() === d.name.trim());
  const isOauth = Boolean(spec?.auth);
  const termsAccepted = isOauth && (spec?.warnings ?? []).every((_, i) => accepted[i]);
  const urlValid = Boolean(spec?.baseUrl.fixed) || isHttpUrl(d.base_url);
  const step1Valid = isOauth
    ? Boolean(spec) && d.name.trim() !== "" && !nameTaken && (Boolean(existing) || termsAccepted)
    : Boolean(spec) && d.name.trim() !== "" && !nameTaken && urlValid && (!keyRequired || hasStoredKey || d.api_key.trim() !== "");
  const [nameTouched, setNameTouched] = useState(false);
  useEffect(() => {
    if (opened) setNameTouched(false);
  }, [opened]);
  const nameError = nameTaken ? "已有同名的帳號" : nameTouched && d.name.trim() === "" ? "請輸入帳號名稱" : undefined;
  const filteredModels = (result?.models ?? []).filter((m) => !modelFilter || m.toLowerCase().includes(modelFilter.toLowerCase()));

  const requestClose = () => {
    // Esc reaches every open overlay: the confirm below handles its own.
    if (save.isPending || confirmIsOpen()) return;
    const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(existing));
    if (!dirty) return onClose();
    confirmAction({ title: "放棄未儲存的設定？", confirmLabel: "放棄", danger: true, onConfirm: onClose });
  };

  return (
    <Drawer
      opened={opened}
      onClose={requestClose}
      position="right"
      size={isMobile ? "100%" : 720}
      padding={0}
      withCloseButton={false}
      styles={{ content: { display: "flex", flexDirection: "column" }, body: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 } }}
    >
      <Group justify="space-between" px="lg" py="md" wrap="nowrap" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          {spec && <ProviderAvatar provider={spec.id} label={spec.label} />}
          <Box style={{ minWidth: 0 }}>
            <Title order={3} lineClamp={1}>
              {existing ? `編輯：${existing.name}` : "新增 Provider 帳號"}
            </Title>
            <Text fz="xs" c="dimmed">
              一個帳號 = 一組連線與金鑰；同一家供應商可以有多個帳號。模型在 Profile 裡挑選。
            </Text>
          </Box>
        </Group>
        <ActionIcon variant="subtle" color="gray" onClick={requestClose} aria-label="關閉">
          <IconX size={18} />
        </ActionIcon>
      </Group>

      <Box px="lg" pt="md">
        <Stepper
          active={step}
          onStepClick={(s) => (s === 0 && existing ? null : s <= 1 || step1Valid ? setStep(s) : null)}
          size={isMobile ? "xs" : "sm"}
          allowNextStepsSelect={false}
          classNames={isMobile ? { root: classes.compactStepper } : undefined}
        >
          {/* Phones: labels only, on one line (descriptions would wrap the stepper into two rows). */}
          <Stepper.Step label={isMobile ? "供應商" : "選擇供應商"} description={isMobile ? undefined : spec?.label} allowStepSelect={!existing} />
          <Stepper.Step label={isMobile ? "連線" : "連線設定"} description={isMobile ? undefined : d.name || undefined} />
          <Stepper.Step label={isOauth ? (isMobile ? "登入" : "登入與模型") : isMobile ? "測試" : "測試與模型"} description={isMobile ? undefined : result ? (result.ok ? "通過" : "失敗") : undefined} />
        </Stepper>
      </Box>

      <ScrollArea style={{ flex: 1 }} type="auto">
        <Box p="lg">
          {step === 0 && (
            <Stack gap="md">
              <TextInput
                leftSection={<IconSearch size={16} />}
                placeholder="搜尋供應商（OpenAI、Gemini、Ollama、SiliconFlow…）"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                autoFocus
              />
              {providers.isPending && <Loader size="sm" />}
              {grouped.map((g) => (
                <Stack key={g.cat} gap="xs">
                  <Text fz="xs" fw={700} c="dimmed" tt="uppercase">
                    {CATEGORY_LABEL[g.cat]}
                  </Text>
                  <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
                    {g.items.map((s) => (
                      <UnstyledButton key={s.id} onClick={() => pick(s)} className={classes.providerTile} data-selected={d.provider === s.id || undefined}>
                        <Group gap="sm" wrap="nowrap" align="flex-start">
                          <ProviderAvatar provider={s.id} label={s.label} size={38} />
                          <Box style={{ minWidth: 0 }}>
                            <Group gap={6}>
                              <Text fw={650} fz="sm">
                                {s.label}
                              </Text>
                              {accounts.some((a) => a.provider === s.id) && (
                                <Badge size="xs" variant="light" color="gray">
                                  已有 {accounts.filter((a) => a.provider === s.id).length}
                                </Badge>
                              )}
                            </Group>
                            <Text fz="xs" c="dimmed" lineClamp={2} mt={2}>
                              {s.description}
                            </Text>
                            <Group gap={4} mt={6}>
                              {s.roles.map((r) => (
                                <Badge key={r} size="xs" variant="outline" color={r === "analysis" ? "brand" : "indigo"} tt="none">
                                  {ROLE_LABEL[r]}
                                </Badge>
                              ))}
                            </Group>
                          </Box>
                        </Group>
                      </UnstyledButton>
                    ))}
                  </SimpleGrid>
                </Stack>
              ))}
            </Stack>
          )}

          {step === 1 && spec && isOauth && (
            <Stack gap="md">
              <TextInput
                label="帳號名稱"
                withAsterisk
                description="自己辨識用，例如「ChatGPT Pro（王醫師）」。必須唯一。"
                value={d.name}
                onChange={(e) => setD({ ...d, name: e.currentTarget.value })}
                error={nameError}
                onBlur={() => setNameTouched(true)}
                maxLength={120}
              />
              {!existing && <ChatgptTerms spec={spec} accepted={accepted} onChange={setAccepted} />}
              <RoleUseSwitch value={d.allow_role_use} onChange={(v) => setD({ ...d, allow_role_use: v })} />
              {existing && (
                <Switch label="啟用" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
              )}
            </Stack>
          )}

          {step === 1 && spec && !isOauth && (
            <Stack gap="md">
              <TextInput
                label="帳號名稱"
                withAsterisk
                description="自己辨識用，例如「OpenAI 團隊 A」「OpenAI 個人」「GPU-02 Ollama」。必須唯一。"
                value={d.name}
                onChange={(e) => setD({ ...d, name: e.currentTarget.value })}
                error={nameError}
                onBlur={() => setNameTouched(true)}
                maxLength={120}
              />
              <BaseUrlField spec={spec} value={d.base_url} onChange={(v) => setD({ ...d, base_url: v })} />
              <PasswordInput
                label="API 金鑰"
                withAsterisk={keyRequired && !hasStoredKey}
                value={d.api_key}
                onChange={(e) => setD({ ...d, api_key: e.currentTarget.value })}
                autoComplete="new-password"
                leftSection={hasStoredKey ? <IconLock size={14} /> : undefined}
                placeholder={hasStoredKey ? "已設定 — 留空則保留" : keyRequired ? "必填" : "選填"}
                description={spec.keyHelp}
              />
              {spec.id === "anthropic" && (
                <Alert color="blue" icon={<IconInfoCircle size={18} />} p="sm" title="Claude 訂閱（Pro／Max）不能直接登入使用">
                  <Text fz="xs">
                    Anthropic 明文禁止第三方應用程式使用 Claude.ai 登入或訂閱憑證，且已在伺服器端封鎖。Max 與 Team 方案每月附 API credits：到 claude.ai 的帳單頁連結
                    Console 組織即可領取，產生的是一般 API 金鑰，貼在上方即可，並適用商業條款。
                  </Text>
                </Alert>
              )}
              {spec.params.some((p) => p.key === "base_model") && (
                <TextInput
                  label="部署的基礎模型（選填）"
                  description="例如 gpt-6-luna。部署名稱看不出模型時，系統靠它決定可用參數。"
                  value={d.base_model}
                  onChange={(e) => setD({ ...d, base_model: e.currentTarget.value })}
                />
              )}
              <SimpleGrid cols={{ base: 1, xs: 2 }}>
                <NumberInput
                  label="RPM 上限（帳號）"
                  description="整個帳號每分鐘請求數，所有模型共用。留空不限制。"
                  placeholder="不限制"
                  min={1}
                  allowDecimal={false}
                  thousandSeparator=","
                  value={d.rpm}
                  onChange={(v) => setD({ ...d, rpm: v === "" ? "" : Number(v) })}
                />
                <NumberInput
                  label="TPM 上限（帳號）"
                  description="整個帳號每分鐘 token 數。留空不限制。"
                  placeholder="不限制"
                  min={1}
                  allowDecimal={false}
                  thousandSeparator=","
                  value={d.tpm}
                  onChange={(v) => setD({ ...d, tpm: v === "" ? "" : Number(v) })}
                />
              </SimpleGrid>
              <Switch label="啟用" description="停用後，所有 Profile 都會略過這個帳號的模型。" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
              <Anchor href={spec.docsUrl} target="_blank" rel="noreferrer" fz="xs">
                {spec.label} 官方文件 <IconExternalLink size={11} style={{ verticalAlign: "-1px" }} />
              </Anchor>
            </Stack>
          )}

          {step === 2 && spec && isOauth && (
            <Stack gap="md">
              <ChatgptSignIn
                name={d.name}
                existing={existing}
                allowRoleUse={d.allow_role_use}
                acknowledged={Boolean(existing) || termsAccepted}
                onConnected={(id) => {
                  setD((cur) => ({ ...cur, id }));
                  // List the account's models right away (id passed explicitly: state is not re-rendered yet).
                  test.mutate(id);
                }}
              />
              {test.isPending && (
                <Group gap="sm">
                  <Loader size="xs" />
                  <Text fz="sm">讀取可用模型…</Text>
                </Group>
              )}
              {result?.models_ok && (
                <Stack gap={6}>
                  <Text fz="sm" fw={650}>
                    可用模型 {result.models.length} 個
                  </Text>
                  <Box className={classes.modelCloud}>
                    {result.models.map((m, i) => (
                      <Badge key={m} variant="light" color="gray" tt="none" ff="monospace" className={classes.modelChip} style={{ animationDelay: `${Math.min(i, 40) * 18}ms` }}>
                        {m}
                      </Badge>
                    ))}
                  </Box>
                </Stack>
              )}
              {result && !result.models_ok && (
                <Alert color="red" p="sm">
                  {modelsText(result)}
                </Alert>
              )}
            </Stack>
          )}

          {step === 2 && spec && !isOauth && (
            <Stack gap="md">
              <Group justify="space-between" wrap="wrap" gap="sm">
                {spec.roles.length > 1 ? (
                  <SegmentedControl size="xs" value={role} onChange={(v) => setRole(v as LlmProfileKind)} data={spec.roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
                ) : (
                  <Badge variant="light">{ROLE_LABEL[spec.roles[0]]}</Badge>
                )}
                <Button leftSection={<IconPlugConnected size={16} />} onClick={() => test.mutate(undefined)} loading={test.isPending} disabled={!step1Valid}>
                  {spec.canListModels ? "測試並列出模型" : "測試連線"}
                </Button>
              </Group>
              {!spec.canListModels && (
                <TextInput
                  label="用哪個模型測試"
                  description="此供應商無法列出模型，請輸入一個模型名稱做實際呼叫。"
                  placeholder={spec.modelExamples?.[role]?.[0]}
                  value={probeModel}
                  onChange={(e) => setProbeModel(e.currentTarget.value)}
                  styles={MONO_INPUT}
                />
              )}

              {test.isPending && (
                <Card className={classes.testing}>
                  <Group gap="sm">
                    <Loader size="sm" />
                    <Text fz="sm">正在連線 {spec.label}…</Text>
                  </Group>
                </Card>
              )}

              {result && (
                <Card className={classes.resultCard} data-ok={result.ok || undefined}>
                  <Group gap="sm" wrap="nowrap" align="flex-start">
                    <ThemeIcon size={36} radius="xl" color={result.ok ? "teal" : "red"} className={result.ok ? classes.popIn : undefined}>
                      {result.ok ? <IconCheck size={20} /> : <IconAlertTriangle size={18} />}
                    </ThemeIcon>
                    <Box style={{ minWidth: 0 }}>
                      <Text fw={650}>{result.ok ? "連線成功" : "連線失敗"}</Text>
                      <Text fz="sm" c="dimmed" style={{ wordBreak: "break-word" }}>
                        {result.models_ok ? `可用模型 ${result.models.length} 個（${ROLE_LABEL[role]}）。` : modelsText(result)}
                        {result.call && ` 實際呼叫：${llmText(result.call)}`}
                      </Text>
                    </Box>
                  </Group>
                </Card>
              )}

              {result?.models_ok && result.models.length > 0 && (
                <Stack gap="xs">
                  <TextInput size="xs" leftSection={<IconSearch size={14} />} placeholder="篩選模型" value={modelFilter} onChange={(e) => setModelFilter(e.currentTarget.value)} />
                  <Box className={classes.modelCloud}>
                    {filteredModels.map((m, i) => (
                      <Badge key={m} variant="light" color="gray" tt="none" ff="monospace" className={classes.modelChip} style={{ animationDelay: `${Math.min(i, 40) * 18}ms` }}>
                        {m}
                      </Badge>
                    ))}
                  </Box>
                  <Text fz="xs" c="dimmed">
                    模型在建立 Profile 時從這裡挑選；儲存帳號後即可使用。
                  </Text>
                </Stack>
              )}
            </Stack>
          )}

          {error && (
            <Alert color="red" mt="md" icon={<IconAlertTriangle size={18} />} title="伺服器拒絕儲存">
              {error}
            </Alert>
          )}
        </Box>
      </ScrollArea>

      <Group justify="space-between" px="lg" py="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
        <Button variant="subtle" color="gray" onClick={() => (step > (existing ? 1 : 0) ? setStep(step - 1) : requestClose())}>
          {step > (existing ? 1 : 0) ? "上一步" : "取消"}
        </Button>
        <Group gap="xs">
          {step === 1 && (
            <Button variant={isOauth && !existing ? "filled" : "default"} onClick={() => setStep(2)} disabled={!step1Valid}>
              {isOauth ? (existing ? "下一步：重新登入" : "下一步：登入") : "下一步：測試"}
            </Button>
          )}
          {isOauth && !existing && step === 2 && d.id && (
            <Button onClick={onClose}>完成</Button>
          )}
          {step >= 1 && (!isOauth || existing) && (
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!step1Valid}>
              {existing ? "儲存變更" : "建立帳號"}
            </Button>
          )}
        </Group>
      </Group>
    </Drawer>
  );
}

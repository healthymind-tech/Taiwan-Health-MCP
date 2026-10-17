import { Alert, Badge, Box, Button, Group, List, Paper, SegmentedControl, Stack, Stepper, Text, Tooltip } from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconDeviceFloppy,
  IconLock,
  IconPlugConnected,
  IconServer2,
  IconShieldLock,
} from "@tabler/icons-react";
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { confirmAction } from "@/components/confirm";
import { KeyValue } from "@/components/KeyValue";
import { notify } from "@/components/notify";
import { PageHeader } from "@/components/PageHeader";
import { PageSkeleton, QueryBoundary } from "@/components/QueryBoundary";
import { SectionCard } from "@/components/SectionCard";
import { ApiError, errorMessage } from "@/lib/api";
import { useIsMobile } from "@/lib/hooks";
import type { FhirServer } from "@/lib/types";
import { ConnectionResult } from "./ConnectionResult";
import { fhirApi, useFhirServer, useFhirServers, useInvalidateFhir } from "./fhirApi";
import {
  AUTH_PROFILE_LABEL,
  AUTH_TYPE_LABEL,
  backendErrorField,
  emptyForm,
  formFingerprint,
  formToPayload,
  isWriteOp,
  serverTitle,
  serverToForm,
  STEP_FIELDS,
  stepHasErrors,
  validateForm,
  type CapabilitySummary,
  type ConnectionTestResult,
  type FieldErrors,
  type FormState,
} from "./fhirModel";
import { EnvBadge, OperationBadges } from "./FhirBadges";
import { AuthSection, BasicSection, PermissionsSection, type FormContext } from "./ServerFormSections";
import { useUnsavedGuard } from "./useUnsavedGuard";

const STEPS = [
  { label: "基本資訊", description: "名稱與連線" },
  { label: "認證", description: "OAuth2 / 憑證" },
  { label: "權限", description: "資源與操作" },
  { label: "測試與儲存", description: "驗證後儲存" },
];

export default function FhirServerEditPage() {
  const { serverId } = useParams();
  const [sp] = useSearchParams();
  const fromId = serverId ? null : sp.get("from");
  const sourceQ = useFhirServer(serverId ?? fromId ?? undefined);
  const listQ = useFhirServers();

  const header = (
    <PageHeader
      title={serverId ? "編輯 FHIR 伺服器" : "新增 FHIR 伺服器"}
      icon={<IconServer2 size={24} />}
      breadcrumbs={[
        { label: "FHIR 伺服器", to: "/fhir-servers" },
        ...(serverId && sourceQ.data ? [{ label: serverTitle(sourceQ.data), to: `/fhir-servers/${serverId}` }] : []),
        { label: serverId ? "編輯" : "新增" },
      ]}
      description={
        serverId
          ? "修改連線、認證與權限設定。Secret 與私鑰為唯寫欄位：留空即保留原值。"
          : "依步驟設定外部 FHIR R4 伺服器的連線、認證與 MCP 可使用的權限，最後先測試連線再儲存。"
      }
    />
  );

  if (!serverId && !fromId) {
    return (
      <>
        {header}
        <Editor key="new" server={null} initial={emptyForm()} initialCapability={null} takenKeys={listQ.data ?? []} />
      </>
    );
  }
  return (
    <>
      {header}
      <QueryBoundary query={sourceQ} skeleton={<PageSkeleton rows={5} />}>
        {(src) => {
          if (serverId) {
            return <Editor key={src.fhir_server_id} server={src} initial={serverToForm(src)} initialCapability={src.capability_summary} takenKeys={listQ.data ?? []} />;
          }
          // Duplicate: copy settings but never secrets or the default flag.
          const f = serverToForm(src);
          const copy: FormState = { ...f, server_key: `${src.server_key}-copy`.slice(0, 64), name: `${src.name} (copy)`, display_name: f.display_name ? `${f.display_name}（複製）` : "", is_default: false };
          return (
            <>
              {src.auth_type !== "none" && (
                <Alert color="blue" icon={<IconLock size={18} />} mb="md">
                  已複製「{serverTitle(src)}」的設定。基於安全，client secret 與私鑰不會被複製，請在「認證」步驟重新輸入或產生。
                </Alert>
              )}
              <Editor key={`dup-${src.fhir_server_id}`} server={null} initial={copy} initialCapability={src.capability_summary} takenKeys={listQ.data ?? []} />
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}

function Editor({
  server,
  initial,
  initialCapability,
  takenKeys,
}: {
  server: FhirServer | null;
  initial: FormState;
  initialCapability: CapabilitySummary | null;
  takenKeys: FhirServer[];
}) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const invalidate = useInvalidateFhir();
  const editing = Boolean(server);

  const [form, setForm] = useState<FormState>(initial);
  const [baseline, setBaseline] = useState(() => formFingerprint(initial));
  const [mode, setMode] = useState<"guided" | "single">(editing ? "single" : "guided");
  const [active, setActive] = useState(0);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set(editing ? [0, 1, 2] : []));
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [capability, setCapability] = useState<CapabilitySummary | null>(
    initialCapability && (initialCapability.supported_resources?.length ?? 0) > 0 ? initialCapability : null,
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = formFingerprint(form) !== baseline;
  useUnsavedGuard(dirty && !saving);

  const set = (patch: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    setServerErrors((e) => {
      const keys = Object.keys(patch);
      if (!keys.some((k) => k in e)) return e;
      const n = { ...e };
      for (const k of keys) delete n[k];
      return n;
    });
    // Any edit invalidates a previous test result.
    setTestResult(null);
    setTestError(null);
  };

  const taken = useMemo(
    () => new Set(takenKeys.filter((s) => s.fhir_server_id !== server?.fhir_server_id).map((s) => s.server_key.toLowerCase())),
    [takenKeys, server],
  );

  const allErrors: FieldErrors = useMemo(() => {
    const e = validateForm(form, {
      secretConfigured: Boolean(server?.client_secret_configured),
      privateKeyConfigured: Boolean(server?.client_private_key_configured),
      editing,
    });
    if (!e.server_key && taken.has(form.server_key.trim().toLowerCase())) e.server_key = "已有伺服器使用這個 server_key";
    return { ...e, ...serverErrors };
  }, [form, server, editing, taken, serverErrors]);

  // Only show errors for steps the user has tried to leave (or after a save attempt).
  const visibleErrors: FieldErrors = useMemo(() => {
    const out: FieldErrors = {};
    revealed.forEach((step) => {
      for (const k of STEP_FIELDS[step] ?? []) if (allErrors[k]) out[k] = allErrors[k];
    });
    for (const [k, v] of Object.entries(serverErrors)) out[k] = v;
    return out;
  }, [revealed, allErrors, serverErrors]);

  const firstErrorStep = [0, 1, 2].find((s) => stepHasErrors(s, allErrors));
  const hasErrors = firstErrorStep !== undefined;

  const ctx: FormContext = {
    serverId: server?.fhir_server_id ?? null,
    secretConfigured: Boolean(server?.client_secret_configured),
    privateKeyConfigured: Boolean(server?.client_private_key_configured),
    publicJwkConfigured: Boolean(server?.client_public_jwk_configured),
    capability,
    setCapability: (c) => setCapability(c),
    takenKeys: taken,
  };

  const revealAll = () => setRevealed(new Set([0, 1, 2]));

  const goNext = () => {
    setRevealed((r) => new Set([...r, active]));
    if (active < 3 && stepHasErrors(active, allErrors)) {
      notify.warn("請先修正標示紅字的欄位。");
      return;
    }
    setActive((a) => Math.min(3, a + 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const applyBackendError = (err: unknown): void => {
    const text = err instanceof ApiError ? `${err.message} ${err.detail ?? ""}` : errorMessage(err);
    const field = backendErrorField(text);
    if (field) {
      const msg = /duplicate key|unique/i.test(text) ? "已有伺服器使用這個 server_key" : err instanceof ApiError ? err.message : text;
      setServerErrors((e) => ({ ...e, [field]: msg }));
      const step = STEP_FIELDS.findIndex((fs) => fs.includes(field));
      if (step >= 0 && mode === "guided") setActive(step);
    }
  };

  const acNew = form.auth_type === "oauth2_authorization_code" && !editing;

  const runTest = async () => {
    revealAll();
    if (hasErrors) {
      notify.warn("設定還有錯誤，請先修正後再測試。");
      if (mode === "guided" && firstErrorStep !== undefined) setActive(firstErrorStep);
      return;
    }
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const r = await fhirApi.test({ ...formToPayload(form), ...(server ? { fhir_server_id: server.fhir_server_id } : {}) });
      setTestResult(r);
      if ((r.capability_summary?.supported_resources?.length ?? 0) > 0) setCapability(r.capability_summary);
    } catch (e) {
      setTestError(errorMessage(e));
      applyBackendError(e);
    } finally {
      setTesting(false);
    }
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const payload = formToPayload(form);
      const saved = server ? await fhirApi.update(server.fhir_server_id, payload) : await fhirApi.create(payload);
      setBaseline(formFingerprint(form));
      await invalidate();
      notify.success(server ? `已更新「${serverTitle(saved)}」` : `已新增「${serverTitle(saved)}」`);
      if (!server && saved.auth_type === "oauth2_authorization_code") {
        notify.info("下一步：在伺服器詳情頁的「OAuth」區塊按「前往授權」完成登入。", "需要授權");
      }
      navigate(`/fhir-servers/${saved.fhir_server_id}`, { replace: !server });
    } catch (e) {
      notify.error(e, "儲存失敗");
      applyBackendError(e);
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    revealAll();
    if (hasErrors) {
      notify.warn("設定還有錯誤，請先修正標示紅字的欄位。");
      if (mode === "guided" && firstErrorStep !== undefined) setActive(firstErrorStep);
      return;
    }
    const newWrites = form.allowed_operations.filter((o) => isWriteOp(o) && (!server || !initial.allowed_operations.includes(o)));
    const warnings: ReactNode[] = [];
    if (newWrites.length) {
      warnings.push(
        <Text key="w" fz="sm" span>
          將開放寫入操作 <b>{newWrites.join(", ")}</b>：LLM 可透過 crud_fhir_server 修改這台伺服器上的臨床資料
        </Text>,
      );
      if (form.allowed_resource_types.length === 0) warnings.push("未限制資源類型：寫入操作適用於所有資源類型");
      if (form.environment === "production") warnings.push("這是標示為「正式環境」的伺服器");
    }
    if (testResult && !testResult.ok) warnings.push("最近一次連線測試失敗");
    if (!form.verify_tls) warnings.push("已關閉 TLS 憑證驗證");
    if (warnings.length === 0) {
      void doSave().catch(() => undefined);
      return;
    }
    confirmAction({
      title: server ? "確認儲存變更？" : "確認新增伺服器？",
      message: "請確認以下事項：",
      consequences: warnings,
      confirmLabel: server ? "儲存" : "新增",
      danger: newWrites.length > 0,
      onConfirm: doSave,
    });
  };

  const cancel = () => {
    const to = server ? `/fhir-servers/${server.fhir_server_id}` : "/fhir-servers";
    // The unsaved-changes blocker asks for confirmation when dirty.
    navigate(to);
  };

  const sections = [
    <BasicSection key="b" form={form} set={set} errors={visibleErrors} ctx={ctx} />,
    <AuthSection key="a" form={form} set={set} errors={visibleErrors} ctx={ctx} />,
    <PermissionsSection key="p" form={form} set={set} errors={visibleErrors} ctx={ctx} />,
  ];

  const testPanel = (
    <TestPanel
      form={form}
      acNew={acNew}
      testing={testing}
      result={testResult}
      error={testError}
      onTest={() => void runTest()}
      hasErrors={hasErrors}
      showSummary={mode === "guided"}
    />
  );

  return (
    <Stack gap="lg" pb={8}>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Group gap="xs">
          {dirty ? (
            <Badge color="amber" variant="light">
              有未儲存的變更
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              {editing ? "尚無變更" : "新伺服器"}
            </Badge>
          )}
        </Group>
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(v) => setMode(v as "guided" | "single")}
          data={[
            { value: "guided", label: "引導式步驟" },
            { value: "single", label: "單頁編輯" },
          ]}
        />
      </Group>

      {mode === "guided" ? (
        <>
          <Paper p={{ base: "sm", sm: "lg" }} radius="lg" withBorder>
            <Stepper
              active={active}
              onStepClick={(s) => {
                if (s <= active) setActive(s);
                else {
                  // Allow jumping forward only across valid steps.
                  setRevealed((r) => new Set([...r, ...Array.from({ length: s }, (_, i) => i)]));
                  const blocking = [0, 1, 2].find((i) => i < s && stepHasErrors(i, allErrors));
                  if (blocking !== undefined) {
                    setActive(blocking);
                    notify.warn("請先修正標示紅字的欄位。");
                  } else setActive(s);
                }
              }}
              size="sm"
              iconSize={isMobile ? 28 : 34}
              allowNextStepsSelect
            >
              {STEPS.map((s, i) => (
                <Stepper.Step
                  key={s.label}
                  label={isMobile ? undefined : s.label}
                  description={isMobile ? undefined : s.description}
                  color={revealed.has(i) && i < 3 && stepHasErrors(i, allErrors) ? "red" : undefined}
                />
              ))}
            </Stepper>
            {isMobile && (
              <Text fz="sm" fw={600} mt="sm" ta="center">
                步驟 {active + 1} / 4：{STEPS[active].label}
              </Text>
            )}
          </Paper>
          <SectionCard title={STEPS[active].label}>{active < 3 ? sections[active] : testPanel}</SectionCard>
        </>
      ) : (
        <>
          <SectionCard title="基本資訊" description="識別、Base URL 與連線選項">
            {sections[0]}
          </SectionCard>
          <SectionCard title="認證" icon={<IconShieldLock size={18} />} description="OAuth2 與用戶端憑證">
            {sections[1]}
          </SectionCard>
          <SectionCard title="權限" description="MCP 工具可存取的資源類型與操作">
            {sections[2]}
          </SectionCard>
          <SectionCard title="連線測試" icon={<IconPlugConnected size={18} />} description="以目前表單內容測試，不會儲存">
            {testPanel}
          </SectionCard>
        </>
      )}

      <Paper
        withBorder
        radius="lg"
        p="sm"
        style={{ position: "sticky", bottom: 8, zIndex: 5, background: "var(--mantine-color-body)", boxShadow: "var(--mantine-shadow-md)" }}
      >
        <Group justify="space-between" gap="xs" wrap="wrap">
          <Button variant="default" onClick={cancel} disabled={saving}>
            取消
          </Button>
          <Group gap="xs" wrap="wrap" justify="flex-end">
            {mode === "guided" && active > 0 && (
              <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={() => setActive((a) => a - 1)} disabled={saving}>
                上一步
              </Button>
            )}
            {mode === "guided" && active < 3 ? (
              <Button rightSection={<IconArrowRight size={16} />} onClick={goNext}>
                下一步
              </Button>
            ) : (
              <>
                {mode === "single" && (
                  <Tooltip label={acNew ? "Authorization Code 需先儲存並授權才能測試" : "以目前內容測試連線（不儲存）"}>
                    <Button variant="light" leftSection={<IconPlugConnected size={16} />} onClick={() => void runTest()} loading={testing} disabled={acNew}>
                      測試連線
                    </Button>
                  </Tooltip>
                )}
                <Button leftSection={<IconDeviceFloppy size={16} />} onClick={save} loading={saving} disabled={editing && !dirty}>
                  {editing ? "儲存變更" : "新增伺服器"}
                </Button>
              </>
            )}
          </Group>
        </Group>
      </Paper>
    </Stack>
  );
}

function TestPanel({
  form,
  acNew,
  testing,
  result,
  error,
  onTest,
  hasErrors,
  showSummary,
}: {
  form: FormState;
  acNew: boolean;
  testing: boolean;
  result: ConnectionTestResult | null;
  error: string | null;
  onTest: () => void;
  hasErrors: boolean;
  showSummary: boolean;
}) {
  const writes = form.allowed_operations.filter(isWriteOp);
  return (
    <Stack gap="lg">
      {showSummary && (
        <>
          <KeyValue
            items={[
              { label: "名稱", value: `${form.display_name || form.name}（${form.server_key || "—"}）` },
              { label: "環境", value: <EnvBadge env={form.environment} /> },
              { label: "Base URL", value: <Text ff="monospace" fz="sm" style={{ wordBreak: "break-all" }}>{form.base_url}</Text>, full: true },
              {
                label: "認證",
                value: `${AUTH_TYPE_LABEL[form.auth_type]}${form.auth_type !== "none" && form.auth_profile !== "none" ? ` · ${AUTH_PROFILE_LABEL[form.auth_profile]}` : ""}`,
              },
              { label: "狀態", value: `${form.enabled ? "啟用" : "停用"}${form.is_default ? " · 預設伺服器" : ""}` },
              { label: "允許的操作", value: <OperationBadges ops={form.allowed_operations} />, full: true },
              {
                label: "允許的資源類型",
                value: form.allowed_resource_types.length ? `${form.allowed_resource_types.length} 種：${form.allowed_resource_types.slice(0, 8).join(", ")}${form.allowed_resource_types.length > 8 ? " …" : ""}` : "不限（所有資源類型）",
                full: true,
              },
            ]}
          />
          {writes.length > 0 && (
            <Alert color="amber" icon={<IconAlertTriangle size={18} />} p="sm">
              此伺服器將開放寫入：{writes.join(", ")}。
            </Alert>
          )}
        </>
      )}

      <Stack gap="xs">
        <Text fz="sm" c="dimmed">
          連線測試會依序執行：授權 metadata 探索 → 取得權杖 → 讀取 FHIR CapabilityStatement（或測試路徑），只讀、不會儲存設定。
        </Text>
        {acNew ? (
          <Alert color="blue" icon={<IconShieldLock size={18} />} p="sm">
            Authorization Code 需要管理員先登入授權，因此新伺服器無法在儲存前測試。請先儲存，再到詳情頁按「前往授權」，授權後即可探測。
          </Alert>
        ) : (
          showSummary && (
            <Box>
              <Tooltip label="請先修正前面步驟的錯誤" disabled={!hasErrors}>
                <Button variant="light" leftSection={<IconPlugConnected size={16} />} onClick={onTest} loading={testing} disabled={hasErrors}>
                  執行連線測試
                </Button>
              </Tooltip>
            </Box>
          )
        )}
      </Stack>

      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="測試請求失敗">
          <Text fz="sm" style={{ wordBreak: "break-word" }}>
            {error}
          </Text>
        </Alert>
      )}
      {result && <ConnectionResult result={result} />}
      {!result && !error && !acNew && (
        <List size="sm" c="dimmed" spacing={2}>
          <List.Item>測試成功後，「權限」步驟的資源類型會改用伺服器回報的 CapabilityStatement。</List.Item>
          <List.Item>測試失敗也能儲存，但 MCP 工具呼叫時很可能同樣失敗。</List.Item>
        </List>
      )}
    </Stack>
  );
}

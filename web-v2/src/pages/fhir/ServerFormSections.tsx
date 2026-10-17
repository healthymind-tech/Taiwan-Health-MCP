import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Collapse,
  Divider,
  Group,
  MultiSelect,
  NumberInput,
  PasswordInput,
  Radio,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconDownload,
  IconInfoCircle,
  IconKey,
  IconLock,
  IconRadar,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { CopyText } from "@/components/CopyText";
import { JsonView } from "@/components/JsonView";
import { notify } from "@/components/notify";
import { errorMessage } from "@/lib/api";
import type { FhirAuthProfile, FhirAuthType, FhirOperation, FhirTokenAuthMethod } from "@/lib/types";
import { downloadJson, fhirApi } from "./fhirApi";
import {
  ASYM_ALGS,
  AUTH_PROFILE_LABEL,
  COMMON_RESOURCE_TYPES,
  DEFAULT_RESOURCE_TYPES,
  ENVIRONMENTS,
  formToPayload,
  HMAC_ALGS,
  IUA_JWT_TOKEN_TYPE,
  isWriteOp,
  jwksUrl,
  OP_HELP,
  OP_LABEL,
  READ_OPS,
  TOKEN_METHOD_LABEL,
  WRITE_OPS,
  type CapabilitySummary,
  type DiscoverResult,
  type FieldErrors,
  type FormState,
  type GeneratedKey,
} from "./fhirModel";
import { KeyValueEditor } from "./KeyValueEditor";

export interface SectionProps {
  form: FormState;
  set: (patch: Partial<FormState>) => void;
  errors: FieldErrors;
}

export interface FormContext {
  serverId: string | null;
  secretConfigured: boolean;
  privateKeyConfigured: boolean;
  publicJwkConfigured: boolean;
  capability: CapabilitySummary | null;
  setCapability: (c: CapabilitySummary) => void;
  /** Other servers' keys (lower-case) for duplicate detection on create. */
  takenKeys: Set<string>;
}

function SubHeading({ icon, title, description }: { icon?: ReactNode; title: ReactNode; description?: ReactNode }) {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start">
      {icon && (
        <ThemeIcon variant="light" size={28} radius="md">
          {icon}
        </ThemeIcon>
      )}
      <Box style={{ minWidth: 0 }}>
        <Title order={4}>{title}</Title>
        {description && (
          <Text fz="sm" c="dimmed">
            {description}
          </Text>
        )}
      </Box>
    </Group>
  );
}

function Advanced({ label, children, defaultOpen = false }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Box>
      <UnstyledButton onClick={() => setOpen((o) => !o)} py={4}>
        <Group gap={6}>
          {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
          <Text fz="sm" fw={600} c="dimmed">
            {label}
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse in={open}>
        <Stack gap="md" pt="sm">
          {children}
        </Stack>
      </Collapse>
    </Box>
  );
}

// ── Step 1: basics ────────────────────────────────────────────────────────────
export function BasicSection({ form, set, errors, ctx }: SectionProps & { ctx: FormContext }) {
  const [probing, setProbing] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);
  const [smart, setSmart] = useState<DiscoverResult | null>(null);

  const keyTaken = !ctx.serverId && ctx.takenKeys.has(form.server_key.trim().toLowerCase());
  const baseOk = !errors.base_url && Boolean(form.base_url.trim());

  /** Fetch [base]/metadata unauthenticated + try SMART discovery, without saving. */
  const autoDiscover = async () => {
    setProbing(true);
    setCapError(null);
    setSmart(null);
    const base = formToPayload(form);
    const draft: Record<string, unknown> = {
      ...base,
      server_key: form.server_key.trim() || "draft-discovery",
      name: form.name.trim() || "draft",
      auth_type: "none",
      test_path: "",
      allowed_resource_types: [],
    };
    const [cap, sm] = await Promise.allSettled([
      fhirApi.test(draft),
      fhirApi.discover({ auth_profile: "smart", base_url: base.base_url, verify_tls: form.verify_tls, timeout_seconds: form.timeout_seconds }),
    ]);
    if (cap.status === "fulfilled") {
      const types = cap.value.capability_summary?.supported_resources ?? [];
      if (cap.value.ok && types.length > 0) ctx.setCapability(cap.value.capability_summary);
      else if (cap.value.ok) setCapError("伺服器有回應 /metadata，但 CapabilityStatement 沒有列出任何資源類型。");
      else setCapError(cap.value.probe?.message || "無法讀取 /metadata");
    } else setCapError(errorMessage(cap.reason));
    if (sm.status === "fulfilled" && sm.value.ok) setSmart(sm.value);
    setProbing(false);
  };

  const applySmart = (authType: FhirAuthType) => {
    if (!smart) return;
    set({
      auth_type: authType,
      auth_profile: "smart",
      use_metadata: true,
      metadata_url: smart.metadata_url ?? "",
      token_endpoint: smart.token_endpoint ?? "",
      authorization_endpoint: smart.authorization_endpoint ?? "",
      ...(authType === "oauth2_client_credentials" && form.token_auth_method !== "client_secret_jwt"
        ? { token_auth_method: "private_key_jwt" as FhirTokenAuthMethod, jwt_signing_alg: form.jwt_signing_alg || "RS384" }
        : {}),
    });
    notify.info(`已套用 SMART 設定（${authType === "oauth2_client_credentials" ? "Backend Services" : "App Launch"}），請到「認證」步驟補上 client_id 等資訊。`);
  };

  const cap = ctx.capability;
  const softwareName = cap?.software && typeof cap.software.name === "string" ? cap.software.name : "";
  const softwareVer = cap?.software && typeof cap.software.version === "string" ? cap.software.version : "";
  const grants = smart?.grant_types_supported ?? [];

  return (
    <Stack gap="lg">
      <SubHeading title="識別" description="server_key 是 MCP 工具呼叫時使用的識別碼（例如 crud_fhir_server 的 server_key 參數）。" />
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <TextInput
          label="server_key"
          withAsterisk
          placeholder="例如 hapi-test"
          value={form.server_key}
          onChange={(e) => set({ server_key: e.currentTarget.value.toLowerCase().replace(/\s+/g, "-") })}
          error={errors.server_key ?? (keyTaken ? "已有伺服器使用這個 server_key" : undefined)}
          description="2–64 字元：英數字、點、底線、連字號；會自動轉小寫"
          ff="monospace"
          autoComplete="off"
        />
        <TextInput
          label="名稱"
          withAsterisk
          placeholder="例如 HAPI 測試伺服器"
          value={form.name}
          onChange={(e) => set({ name: e.currentTarget.value })}
          error={errors.name}
          description="內部名稱，也可用來查找伺服器"
        />
        <TextInput
          label="顯示名稱"
          placeholder="選填，例如 台大醫院 FHIR（測試）"
          value={form.display_name}
          onChange={(e) => set({ display_name: e.currentTarget.value })}
          description="顯示在後台與 MCP 清單中；空白時使用名稱"
        />
        <Select
          label="環境"
          placeholder="未標示"
          data={ENVIRONMENTS.map((e) => ({ value: e.value, label: e.label }))}
          value={form.environment || null}
          onChange={(v) => set({ environment: v ?? "" })}
          clearable
          description="正式環境會以紅色標示，提醒操作時特別小心"
          allowDeselect
        />
      </SimpleGrid>
      {form.environment === "production" && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} p="sm">
          這是<b>正式環境</b>的臨床資料伺服器。建議只開放讀取操作，除非確定需要讓 LLM 寫入資料。
        </Alert>
      )}
      <TagsInput
        label="標籤"
        placeholder="輸入後按 Enter"
        value={form.tags}
        onChange={(v) => set({ tags: v })}
        clearable
        description="用於搜尋與分類，例如 醫院名稱、專案代號"
      />
      <Textarea
        label="說明"
        placeholder="選填：用途、聯絡窗口、注意事項…"
        value={form.description}
        onChange={(e) => set({ description: e.currentTarget.value })}
        autosize
        minRows={2}
        maxRows={6}
      />

      <Divider />
      <SubHeading title="連線" description="FHIR R4 伺服器的 Base URL，所有請求都會以它為前綴。" />
      <Stack gap={6}>
        <Group gap="sm" align="flex-start" wrap="wrap">
          <TextInput
            label="Base URL"
            withAsterisk
            placeholder="https://fhir.example.org/fhir"
            value={form.base_url}
            onChange={(e) => set({ base_url: e.currentTarget.value.trim() })}
            error={errors.base_url}
            ff="monospace"
            style={{ flex: "1 1 320px", minWidth: 0 }}
            autoComplete="off"
            inputMode="url"
          />
          <Tooltip label={baseOk ? "讀取 [base]/metadata 與 SMART 設定，不會儲存任何東西" : "請先填寫有效的 Base URL"}>
            <Button
              mt={{ base: 0, xs: 25 }}
              variant="light"
              leftSection={<IconRadar size={16} />}
              onClick={() => void autoDiscover()}
              loading={probing}
              disabled={!baseOk}
            >
              從 metadata 自動探索
            </Button>
          </Tooltip>
        </Group>
        {capError && (
          <Alert color="amber" icon={<IconAlertTriangle size={16} />} p="xs">
            <Text fz="sm">無法取得 CapabilityStatement：{capError}</Text>
            <Text fz="xs" c="dimmed">
              若伺服器的 /metadata 也需要權杖，可先完成認證設定，在「測試與儲存」步驟執行連線測試後再選擇資源類型。
            </Text>
          </Alert>
        )}
        {cap && (cap.supported_resources?.length ?? 0) > 0 && (
          <Alert color="teal" icon={<IconShieldCheck size={16} />} p="xs">
            <Text fz="sm">
              偵測到 FHIR {cap.fhirVersion || "?"}
              {softwareName ? ` · ${softwareName}${softwareVer ? ` ${softwareVer}` : ""}` : ""}，支援 {cap.supported_resources?.length} 種資源類型。
              「權限」步驟的資源類型清單會使用這份能力聲明。
            </Text>
          </Alert>
        )}
        {smart && (
          <Alert color="blue" icon={<IconInfoCircle size={16} />} p="xs" title="找到 SMART on FHIR 設定">
            <Stack gap={6}>
              <Text fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
                {smart.metadata_url}
              </Text>
              {smart.token_endpoint && <Text fz="xs">token：<Text span ff="monospace" fz="xs">{smart.token_endpoint}</Text></Text>}
              {smart.authorization_endpoint && (
                <Text fz="xs">authorize：<Text span ff="monospace" fz="xs">{smart.authorization_endpoint}</Text></Text>
              )}
              <Group gap="xs" wrap="wrap">
                <Button size="xs" variant="light" onClick={() => applySmart("oauth2_client_credentials")} disabled={grants.length > 0 && !grants.includes("client_credentials")}>
                  套用：Backend Services（client credentials）
                </Button>
                <Button size="xs" variant="light" onClick={() => applySmart("oauth2_authorization_code")} disabled={!smart.authorization_endpoint}>
                  套用：App Launch（authorization code）
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <TextInput
          label="測試路徑"
          placeholder="留空 = metadata"
          value={form.test_path}
          onChange={(e) => set({ test_path: e.currentTarget.value })}
          error={errors.test_path}
          description="連線測試與探測時呼叫的相對路徑，例如 Patient?_count=1；留空則讀取 CapabilityStatement"
          ff="monospace"
        />
        <NumberInput
          label="逾時（秒）"
          min={1}
          max={120}
          clampBehavior="strict"
          allowDecimal={false}
          value={form.timeout_seconds}
          onChange={(v) => set({ timeout_seconds: typeof v === "number" ? v : Number(v) || 0 })}
          error={errors.timeout_seconds}
          description="單一請求的等待上限，1–120 秒"
        />
      </SimpleGrid>
      <Stack gap="sm">
        <Switch
          checked={form.verify_tls}
          onChange={(e) => set({ verify_tls: e.currentTarget.checked })}
          label="驗證 TLS 憑證"
          description={form.verify_tls ? "建議保持開啟" : "已關閉：連線可能遭中間人攔截，只應用於使用自簽憑證的測試環境"}
          color={form.verify_tls ? undefined : "amber"}
        />
        <Switch
          checked={form.enabled}
          onChange={(e) => set({ enabled: e.currentTarget.checked, ...(e.currentTarget.checked ? {} : { is_default: false }) })}
          label="啟用"
          description="停用後 MCP 工具看不到也無法使用此伺服器"
        />
        <Switch
          checked={form.is_default}
          disabled={!form.enabled}
          onChange={(e) => set({ is_default: e.currentTarget.checked })}
          label="設為預設伺服器"
          description="MCP 工具未指定 server_key 時使用；會取消其他伺服器的預設"
          error={errors.is_default}
        />
      </Stack>
      <Advanced label="進階：FHIR 請求自訂標頭" defaultOpen={form.resource_headers.length > 0}>
        <KeyValueEditor
          label="資源請求標頭"
          description="附加在每個 FHIR API 請求上（例如租戶代碼）。Authorization 由系統自動處理，不可在此設定。"
          rows={form.resource_headers}
          onChange={(rows) => set({ resource_headers: rows })}
          error={errors.resource_headers}
          keyPlaceholder="標頭名稱，例如 X-Tenant-Id"
          valuePlaceholder="值"
          addLabel="新增標頭"
        />
      </Advanced>
    </Stack>
  );
}

// ── Step 2: authentication ────────────────────────────────────────────────────
const AUTH_TYPE_CARDS: { value: FhirAuthType; title: string; desc: string }[] = [
  { value: "none", title: "無認證", desc: "公開或內網伺服器，不附加權杖" },
  { value: "oauth2_client_credentials", title: "Client Credentials", desc: "系統對系統：以 client 身分自動取得權杖" },
  { value: "oauth2_authorization_code", title: "Authorization Code", desc: "需由管理員登入授權一次，之後自動更新權杖" },
];

export function AuthSection({ form, set, errors, ctx }: SectionProps & { ctx: FormContext }) {
  const [discovering, setDiscovering] = useState(false);
  const [disc, setDisc] = useState<DiscoverResult | null>(null);
  const [discError, setDiscError] = useState<string | null>(null);
  const [replaceSecret, setReplaceSecret] = useState(!ctx.secretConfigured);
  const [replaceKey, setReplaceKey] = useState(!ctx.privateKeyConfigured);
  const [keyAlg, setKeyAlg] = useState<string>(form.jwt_signing_alg && ASYM_ALGS.includes(form.jwt_signing_alg) ? form.jwt_signing_alg : "RS384");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GeneratedKey | null>(null);
  const [pastePem, setPastePem] = useState(false);

  const oauth = form.auth_type !== "none";
  const cc = form.auth_type === "oauth2_client_credentials";
  const ac = form.auth_type === "oauth2_authorization_code";
  const smartCc = cc && form.auth_profile === "smart";
  const pkJwt = cc && form.token_auth_method === "private_key_jwt";
  const secretJwt = cc && form.token_auth_method === "client_secret_jwt";
  const needsSecret = (cc && !pkJwt) || ac;

  const setAuthType = (t: FhirAuthType) => {
    const patch: Partial<FormState> = { auth_type: t };
    if (t === "oauth2_client_credentials" && form.auth_profile === "smart" && !["private_key_jwt", "client_secret_jwt"].includes(form.token_auth_method)) {
      patch.token_auth_method = "private_key_jwt";
    }
    set(patch);
  };
  const setProfile = (p: FhirAuthProfile) => {
    const patch: Partial<FormState> = { auth_profile: p };
    if (p === "smart") patch.requested_token_type = "";
    if (p === "iua" && cc && !form.requested_token_type) patch.requested_token_type = IUA_JWT_TOKEN_TYPE;
    if (p === "smart" && cc && !["private_key_jwt", "client_secret_jwt"].includes(form.token_auth_method)) {
      patch.token_auth_method = "private_key_jwt";
      patch.jwt_signing_alg = form.jwt_signing_alg && ASYM_ALGS.includes(form.jwt_signing_alg) ? form.jwt_signing_alg : "RS384";
    }
    set(patch);
  };
  const setMethod = (m: FhirTokenAuthMethod) => {
    let alg = form.jwt_signing_alg;
    if (m === "private_key_jwt" && !ASYM_ALGS.includes(alg)) alg = "RS384";
    if (m === "client_secret_jwt" && !HMAC_ALGS.includes(alg)) alg = "HS384";
    if (m === "client_secret_basic" || m === "client_secret_post") alg = "";
    set({ token_auth_method: m, jwt_signing_alg: alg });
  };

  const discover = async () => {
    setDiscovering(true);
    setDiscError(null);
    setDisc(null);
    try {
      const r = await fhirApi.discover({
        auth_profile: form.auth_profile,
        base_url: form.base_url.trim(),
        metadata_url: form.metadata_url.trim(),
        auth_server_url: form.auth_server_url.trim(),
        verify_tls: form.verify_tls,
        timeout_seconds: form.timeout_seconds,
        metadata_headers_json: Object.fromEntries(form.metadata_headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value])),
      });
      if (r.ok) setDisc(r);
      else setDiscError(r.error ?? "探索失敗");
    } catch (e) {
      setDiscError(errorMessage(e));
    } finally {
      setDiscovering(false);
    }
  };

  const applyDiscovered = () => {
    if (!disc) return;
    set({
      token_endpoint: disc.token_endpoint || form.token_endpoint,
      ...(ac ? { authorization_endpoint: disc.authorization_endpoint || form.authorization_endpoint } : {}),
      metadata_url: form.metadata_url || disc.metadata_url || "",
    });
    notify.success("已套用探索到的端點");
  };

  const generateKey = async () => {
    setGenerating(true);
    try {
      const r = await fhirApi.generateKey(keyAlg);
      setGenerated(r);
      setReplaceKey(true);
      setPastePem(false);
      set({ client_private_key: r.private_key_pem, jwt_signing_alg: r.alg, jwt_kid: r.kid });
      notify.success("已產生新的金鑰對。私鑰會在儲存時加密保存；請把公開金鑰註冊到授權伺服器。", "金鑰已產生");
    } catch (e) {
      notify.error(e, "產生金鑰失敗");
    } finally {
      setGenerating(false);
    }
  };

  const methodOptions = (Object.keys(TOKEN_METHOD_LABEL) as FhirTokenAuthMethod[]).map((m) => ({
    value: m,
    label: TOKEN_METHOD_LABEL[m],
    disabled: smartCc && (m === "client_secret_basic" || m === "client_secret_post"),
  }));
  const supported = disc?.token_endpoint_auth_methods_supported ?? [];

  return (
    <Stack gap="lg">
      <SubHeading title="認證方式" description="系統如何向這台 FHIR 伺服器證明身分。" />
      <Radio.Group value={form.auth_type} onChange={(v) => setAuthType(v as FhirAuthType)} aria-label="認證方式">
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
          {AUTH_TYPE_CARDS.map((c) => (
            <Radio.Card key={c.value} value={c.value} radius="md" p="md">
              <Group gap="sm" wrap="nowrap" align="flex-start">
                <Radio.Indicator mt={2} />
                <Box>
                  <Text fw={600} fz="sm">
                    {c.title}
                  </Text>
                  <Text fz="xs" c="dimmed" mt={2}>
                    {c.desc}
                  </Text>
                </Box>
              </Group>
            </Radio.Card>
          ))}
        </SimpleGrid>
      </Radio.Group>

      {!oauth && (
        <Alert color="gray" icon={<IconInfoCircle size={18} />} p="sm">
          請求不會附加任何權杖。若伺服器需要 API key 之類的標頭，可在「基本資訊 → 進階：FHIR 請求自訂標頭」設定。
        </Alert>
      )}

      {oauth && (
        <>
          <Stack gap={6}>
            <Text fz="sm" fw={500}>
              設定檔
            </Text>
            <SegmentedControl
              value={form.auth_profile}
              onChange={(v) => setProfile(v as FhirAuthProfile)}
              data={(["none", "iua", "smart"] as FhirAuthProfile[]).map((p) => ({ value: p, label: AUTH_PROFILE_LABEL[p] }))}
              fullWidth
            />
            <Text fz="xs" c="dimmed">
              {form.auth_profile === "smart"
                ? cc
                  ? "SMART Backend Services：使用簽章 JWT 向授權伺服器認證（private_key_jwt 或 client_secret_jwt）。"
                  : "SMART App Launch：metadata 預設從 [base]/.well-known/smart-configuration 探索。"
                : form.auth_profile === "iua"
                  ? "IHE IUA：權杖類型預設為 JWT（urn:ietf:params:oauth:token-type:jwt）。"
                  : "一般 OAuth2：metadata 從 [授權伺服器]/.well-known/oauth-authorization-server 探索。"}
            </Text>
          </Stack>

          <Divider />
          <SubHeading title="端點" description="可直接填寫，或提供 Metadata URL / 授權伺服器 URL 讓系統自動探索。" />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <TextInput
              label="授權伺服器 URL"
              placeholder="https://auth.example.org"
              value={form.auth_server_url}
              onChange={(e) => set({ auth_server_url: e.currentTarget.value.trim() })}
              error={errors.auth_server_url}
              ff="monospace"
              description="未填 token endpoint 時會使用 [此 URL]/token"
            />
            <TextInput
              label="Metadata URL"
              placeholder={form.auth_profile === "smart" ? "留空 = [base]/.well-known/smart-configuration" : "https://auth.example.org/.well-known/…"}
              value={form.metadata_url}
              onChange={(e) => set({ metadata_url: e.currentTarget.value.trim() })}
              error={errors.metadata_url}
              ff="monospace"
            />
          </SimpleGrid>
          <Group gap="sm" wrap="wrap">
            <Button variant="light" leftSection={<IconRadar size={16} />} onClick={() => void discover()} loading={discovering}>
              探索授權 metadata
            </Button>
            <Switch
              checked={form.use_metadata}
              onChange={(e) => set({ use_metadata: e.currentTarget.checked })}
              label="執行時使用 metadata 探索端點"
            />
          </Group>
          {discError && (
            <Alert color="amber" icon={<IconAlertTriangle size={16} />} p="xs">
              <Text fz="sm" style={{ wordBreak: "break-word" }}>
                {discError}
              </Text>
              <Text fz="xs" c="dimmed">
                可改為手動填寫下方端點。
              </Text>
            </Alert>
          )}
          {disc && <DiscoveredPanel disc={disc} onApply={applyDiscovered} />}
          <SimpleGrid cols={{ base: 1, sm: ac ? 2 : 1 }} spacing="md">
            <TextInput
              label="Token endpoint"
              placeholder="https://auth.example.org/oauth2/token"
              value={form.token_endpoint}
              onChange={(e) => set({ token_endpoint: e.currentTarget.value.trim() })}
              error={errors.token_endpoint}
              ff="monospace"
            />
            {ac && (
              <TextInput
                label="Authorization endpoint"
                placeholder="https://auth.example.org/oauth2/authorize"
                value={form.authorization_endpoint}
                onChange={(e) => set({ authorization_endpoint: e.currentTarget.value.trim() })}
                error={errors.authorization_endpoint}
                ff="monospace"
              />
            )}
          </SimpleGrid>

          <Divider />
          <SubHeading title="Client 憑證" icon={<IconLock size={16} />} description="Secret 與私鑰以 pgcrypto 加密保存，之後不會再顯示。" />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <TextInput
              label="client_id"
              withAsterisk
              value={form.client_id}
              onChange={(e) => set({ client_id: e.currentTarget.value })}
              error={errors.client_id}
              ff="monospace"
              autoComplete="off"
            />
            {cc ? (
              <Select
                label="Token 端點認證方式"
                data={methodOptions}
                value={form.token_auth_method}
                onChange={(v) => v && setMethod(v as FhirTokenAuthMethod)}
                allowDeselect={false}
                error={errors.token_auth_method}
                description={
                  supported.length > 0
                    ? `授權伺服器宣告支援：${supported.join(", ")}`
                    : smartCc
                      ? "SMART Backend Services 只能使用 JWT 類型的方式"
                      : undefined
                }
              />
            ) : (
              <TextInput label="Token 端點認證方式" value="client_secret_basic" readOnly description="Authorization Code 固定使用 HTTP Basic（搭配 PKCE）" />
            )}
          </SimpleGrid>

          {needsSecret && (
            <SecretField
              configured={ctx.secretConfigured}
              replacing={replaceSecret}
              onReplace={(v) => {
                setReplaceSecret(v);
                if (!v) set({ client_secret: "" });
              }}
              value={form.client_secret}
              onChange={(v) => set({ client_secret: v })}
              error={errors.client_secret}
              optional={ac && form.auth_profile !== "iua"}
              warning={
                ac && ctx.serverId && ctx.secretConfigured && !form.client_secret.trim()
                  ? "目前後端在更新 Authorization Code 伺服器時，若未重新輸入 client secret，已儲存的值會被清除。若此用戶端需要 secret，請在此重新輸入。"
                  : undefined
              }
            />
          )}

          {(pkJwt || secretJwt) && (
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
              <Select
                label="JWT 簽章演算法"
                data={pkJwt ? ASYM_ALGS : HMAC_ALGS}
                value={form.jwt_signing_alg || (pkJwt ? "RS384" : "HS384")}
                onChange={(v) => v && set({ jwt_signing_alg: v })}
                allowDeselect={false}
                error={errors.jwt_signing_alg}
                disabled={pkJwt && Boolean(generated)}
                description={pkJwt && generated ? "由產生的金鑰決定" : undefined}
              />
              <TextInput
                label="Key ID（kid）"
                placeholder={pkJwt ? "留空 = 依公開金鑰自動計算" : "選填"}
                value={form.jwt_kid}
                onChange={(e) => set({ jwt_kid: e.currentTarget.value })}
                ff="monospace"
              />
            </SimpleGrid>
          )}

          {pkJwt && (
            <Card padding="md" withBorder>
              <Stack gap="sm">
                <Group gap="xs" justify="space-between" wrap="wrap">
                  <Group gap="xs">
                    <IconKey size={18} />
                    <Text fw={600} fz="sm">
                      用戶端私鑰（private_key_jwt）
                    </Text>
                  </Group>
                  {ctx.privateKeyConfigured && !form.client_private_key && <Badge color="teal" variant="light">已設定</Badge>}
                  {form.client_private_key && <Badge color="blue" variant="light">將於儲存時更新</Badge>}
                </Group>
                {ctx.privateKeyConfigured && !replaceKey ? (
                  <Group gap="sm" wrap="wrap">
                    <Text fz="sm" c="dimmed">
                      已有加密保存的私鑰。
                    </Text>
                    <Button size="xs" variant="default" onClick={() => setReplaceKey(true)}>
                      更換私鑰
                    </Button>
                  </Group>
                ) : (
                  <>
                    <Group gap="sm" align="flex-end" wrap="wrap">
                      <Select
                        label="金鑰演算法"
                        data={ASYM_ALGS}
                        value={keyAlg}
                        onChange={(v) => v && setKeyAlg(v)}
                        allowDeselect={false}
                        w={140}
                      />
                      <Button leftSection={<IconKey size={16} />} onClick={() => void generateKey()} loading={generating}>
                        產生金鑰
                      </Button>
                      <Button variant="subtle" onClick={() => setPastePem((p) => !p)}>
                        {pastePem ? "改用產生金鑰" : "改為貼上既有私鑰"}
                      </Button>
                      {ctx.privateKeyConfigured && (
                        <Button
                          variant="subtle"
                          color="gray"
                          onClick={() => {
                            setReplaceKey(false);
                            setGenerated(null);
                            set({ client_private_key: "" });
                          }}
                        >
                          保留原私鑰
                        </Button>
                      )}
                    </Group>
                    {pastePem && (
                      <Textarea
                        label="私鑰 PEM"
                        placeholder={"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}
                        value={generated ? "" : form.client_private_key}
                        onChange={(e) => {
                          setGenerated(null);
                          set({ client_private_key: e.currentTarget.value });
                        }}
                        autosize
                        minRows={4}
                        maxRows={10}
                        ff="monospace"
                        fz="xs"
                        spellCheck={false}
                      />
                    )}
                    {errors.client_private_key && (
                      <Text fz="xs" c="red">
                        {errors.client_private_key}
                      </Text>
                    )}
                  </>
                )}
                {generated && (
                  <Stack gap={6}>
                    <Text fz="sm">
                      公開金鑰（JWKS）— 請註冊到授權伺服器，或讓授權伺服器讀取下方的 JWKS 網址：
                    </Text>
                    <JsonView value={generated.jwks} maxHeight={200} />
                    <Group gap="xs">
                      <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} onClick={() => downloadJson(`jwks-${form.server_key || "fhir"}.json`, generated.jwks)}>
                        下載 JWKS
                      </Button>
                    </Group>
                  </Stack>
                )}
                <Divider />
                <Stack gap={4}>
                  <Text fz="sm" fw={500}>
                    公開 JWKS 網址
                  </Text>
                  {ctx.serverId ? (
                    <>
                      <CopyText value={jwksUrl(ctx.serverId)} mono />
                      <Text fz="xs" c="dimmed">
                        {ctx.publicJwkConfigured ? "授權伺服器可從此網址取得目前的公開金鑰。" : "儲存私鑰後，此網址才會提供公開金鑰。"}
                        若更換私鑰，儲存後此網址會立即提供新的公開金鑰。
                      </Text>
                    </>
                  ) : (
                    <Text fz="xs" c="dimmed">
                      儲存伺服器後會產生固定網址：{window.location.origin}/fhir-client/&lt;伺服器 ID&gt;/jwks.json
                    </Text>
                  )}
                </Stack>
              </Stack>
            </Card>
          )}

          <Divider />
          <SubHeading title="權杖請求參數" />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <TextInput
              label="scope"
              placeholder={form.auth_profile === "smart" ? (cc ? "system/*.read" : "launch openid fhirUser patient/*.read") : "選填"}
              value={form.scope}
              onChange={(e) => set({ scope: e.currentTarget.value })}
              description={disc?.scopes_supported?.length ? `支援：${disc.scopes_supported.slice(0, 8).join(" ")}${disc.scopes_supported.length > 8 ? " …" : ""}` : "以空白分隔多個 scope"}
              ff="monospace"
            />
            <TextInput
              label="resource / audience"
              placeholder="選填，例如 FHIR Base URL"
              value={form.resource}
              onChange={(e) => set({ resource: e.currentTarget.value })}
              description="部分授權伺服器要求指定權杖的使用對象"
              ff="monospace"
            />
            {form.auth_profile !== "smart" && (
              <TextInput
                label="requested_token_type"
                placeholder={form.auth_profile === "iua" ? IUA_JWT_TOKEN_TYPE : "選填"}
                value={form.requested_token_type}
                onChange={(e) => set({ requested_token_type: e.currentTarget.value })}
                ff="monospace"
              />
            )}
            {cc && (
              <Select
                label="預設權杖策略"
                data={[
                  { value: "", label: "自動（每次重新取得）" },
                  { value: "fresh", label: "fresh — 每次請求都取得新權杖" },
                  { value: "cached", label: "cached — 重複使用到期前的權杖" },
                ]}
                value={form.default_token_strategy}
                onChange={(v) => set({ default_token_strategy: v ?? "" })}
                allowDeselect={false}
                description="MCP 呼叫未指定 token_strategy 時使用"
              />
            )}
          </SimpleGrid>

          <Advanced label="進階：metadata / token 請求自訂標頭" defaultOpen={form.metadata_headers.length > 0 || form.token_headers.length > 0}>
            <KeyValueEditor
              label="Metadata 請求標頭"
              description="讀取授權 metadata 時附加"
              rows={form.metadata_headers}
              onChange={(rows) => set({ metadata_headers: rows })}
              error={errors.metadata_headers}
              keyPlaceholder="標頭名稱"
              addLabel="新增標頭"
            />
            <KeyValueEditor
              label="Token 請求標頭"
              description="呼叫 token endpoint 時附加"
              rows={form.token_headers}
              onChange={(rows) => set({ token_headers: rows })}
              error={errors.token_headers}
              keyPlaceholder="標頭名稱"
              addLabel="新增標頭"
            />
          </Advanced>

          {ac && (
            <Alert color="blue" icon={<IconInfoCircle size={18} />} p="sm">
              Authorization Code 需先儲存伺服器，再到詳情頁按「授權」登入一次；完成後系統會保存並自動更新權杖。
              授權伺服器需允許的 redirect URI：
              <Box mt={4}>
                <CopyText value={`${window.location.origin}/fhir-oauth/callback`} mono />
              </Box>
            </Alert>
          )}
        </>
      )}
    </Stack>
  );
}

function SecretField({
  configured,
  replacing,
  onReplace,
  value,
  onChange,
  error,
  optional,
  warning,
}: {
  warning?: string;
  configured: boolean;
  replacing: boolean;
  onReplace: (v: boolean) => void;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  optional?: boolean;
}) {
  if (configured && !replacing && !error) {
    return (
      <Stack gap={4}>
        {warning && (
          <Alert color="amber" icon={<IconAlertTriangle size={16} />} p="xs" mb={4}>
            <Text fz="xs">{warning}</Text>
          </Alert>
        )}
        <Text fz="sm" fw={500}>
          client_secret
        </Text>
        <Group gap="sm">
          <Badge color="teal" variant="light" leftSection={<IconLock size={12} />}>
            已設定
          </Badge>
          <Button size="xs" variant="default" onClick={() => onReplace(true)}>
            更換
          </Button>
        </Group>
      </Stack>
    );
  }
  return (
    <Group gap="sm" align="flex-start" wrap="nowrap">
      <PasswordInput
        label="client_secret"
        withAsterisk={!optional}
        placeholder={configured ? "輸入新的 secret" : optional ? "選填（機密用戶端才需要）" : ""}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        error={error}
        autoComplete="new-password"
        style={{ flex: 1, minWidth: 0 }}
        description={configured ? "已有加密保存的值；留空則保留原值" : "只會加密保存，之後不再顯示"}
      />
      {configured && (
        <Button mt={25} variant="subtle" color="gray" onClick={() => onReplace(false)}>
          取消更換
        </Button>
      )}
    </Group>
  );
}

function DiscoveredPanel({ disc, onApply }: { disc: DiscoverResult; onApply: () => void }) {
  const rows: [string, string | undefined][] = [
    ["issuer", disc.issuer],
    ["token_endpoint", disc.token_endpoint],
    ["authorization_endpoint", disc.authorization_endpoint],
    ["jwks_uri", disc.jwks_uri],
  ];
  const lists: [string, string[] | undefined][] = [
    ["grant_types", disc.grant_types_supported],
    ["auth methods", disc.token_endpoint_auth_methods_supported],
    ["PKCE", disc.code_challenge_methods_supported],
    ["SMART capabilities", disc.smart_capabilities],
  ];
  return (
    <Alert color="teal" icon={<IconShieldCheck size={18} />} p="sm" title="探索成功">
      <Stack gap={6}>
        <Text fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
          {disc.metadata_url}
        </Text>
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <Text key={k} fz="xs" style={{ wordBreak: "break-all" }}>
              <Text span c="dimmed" fz="xs">
                {k}：
              </Text>
              <Text span ff="monospace" fz="xs">
                {v}
              </Text>
            </Text>
          ))}
        {lists
          .filter(([, v]) => v && v.length > 0)
          .map(([k, v]) => (
            <Group key={k} gap={4} wrap="wrap">
              <Text fz="xs" c="dimmed">
                {k}：
              </Text>
              {(v ?? []).slice(0, 12).map((x) => (
                <Badge key={x} size="xs" variant="default" style={{ textTransform: "none" }}>
                  {x}
                </Badge>
              ))}
            </Group>
          ))}
        <Box>
          <Button size="xs" onClick={onApply} disabled={!disc.token_endpoint && !disc.authorization_endpoint}>
            套用端點
          </Button>
        </Box>
      </Stack>
    </Alert>
  );
}

// ── Step 3: permissions ───────────────────────────────────────────────────────
export function PermissionsSection({ form, set, errors, ctx }: SectionProps & { ctx: FormContext }) {
  const capTypes = (ctx.capability?.supported_resources ?? []).map((r) => r.type);
  const capSet = new Set(capTypes);
  const options = Array.from(new Set([...(capTypes.length ? capTypes : COMMON_RESOURCE_TYPES), ...form.allowed_resource_types])).sort();
  const unsupported = capTypes.length ? form.allowed_resource_types.filter((t) => !capSet.has(t)) : [];
  const writeSelected = form.allowed_operations.filter((o) => isWriteOp(o));
  const toggleOp = (op: FhirOperation, on: boolean) =>
    set({ allowed_operations: on ? [...form.allowed_operations, op] : form.allowed_operations.filter((o) => o !== op) });

  return (
    <Stack gap="lg">
      <SubHeading
        title="允許的資源類型"
        description={
          capTypes.length
            ? `選項來自伺服器的 CapabilityStatement（${capTypes.length} 種）。`
            : "尚未取得伺服器的 CapabilityStatement，以下為常見 FHIR R4 資源類型；可直接輸入其他類型。"
        }
      />
      <MultiSelect
        data={options}
        value={form.allowed_resource_types}
        onChange={(v) => set({ allowed_resource_types: v })}
        searchable
        clearable
        placeholder={form.allowed_resource_types.length ? "搜尋或選擇…" : "未選擇 = 允許所有資源類型"}
        nothingFoundMessage="找不到符合的資源類型"
        error={errors.allowed_resource_types}
        maxDropdownHeight={280}
        hidePickedOptions
        aria-label="允許的資源類型"
      />
      <Group gap="xs" wrap="wrap">
        {capTypes.length > 0 && (
          <Button size="xs" variant="default" onClick={() => set({ allowed_resource_types: [...capTypes] })}>
            全選伺服器支援的 {capTypes.length} 種
          </Button>
        )}
        <Button size="xs" variant="default" onClick={() => set({ allowed_resource_types: [...DEFAULT_RESOURCE_TYPES] })}>
          套用預設清單（{DEFAULT_RESOURCE_TYPES.length} 種）
        </Button>
        <Button size="xs" variant="subtle" color="gray" onClick={() => set({ allowed_resource_types: [] })} disabled={form.allowed_resource_types.length === 0}>
          清除
        </Button>
      </Group>
      {form.allowed_resource_types.length === 0 && (
        <Alert color="amber" icon={<IconAlertTriangle size={18} />} p="sm">
          未選擇任何類型時，MCP 工具可以存取這台伺服器上的<b>所有資源類型</b>
          {writeSelected.length > 0 ? "，並可對它們執行寫入操作" : ""}。
        </Alert>
      )}
      {unsupported.length > 0 && (
        <Text fz="xs" c="amber">
          伺服器的 CapabilityStatement 未列出：{unsupported.join(", ")}（呼叫時可能會失敗）
        </Text>
      )}

      <Divider />
      <SubHeading title="允許的操作" description="crud_fhir_server 只能執行這裡勾選的操作。寫入操作另外要求 LLM 傳入 confirm_write=true。" />
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Stack gap="xs">
          <Text fz="sm" fw={600}>
            讀取
          </Text>
          {READ_OPS.map((op) => (
            <Checkbox
              key={op}
              checked={form.allowed_operations.includes(op)}
              onChange={(e) => toggleOp(op, e.currentTarget.checked)}
              label={OP_LABEL[op]}
              description={OP_HELP[op]}
            />
          ))}
        </Stack>
        <Stack
          gap="xs"
          p="sm"
          style={{
            border: "1px solid var(--mantine-color-amber-outline, var(--mantine-color-yellow-outline))",
            borderRadius: "var(--mantine-radius-md)",
            background: writeSelected.length ? "var(--mantine-color-amber-light)" : undefined,
          }}
        >
          <Group gap={6}>
            <IconAlertTriangle size={16} color="var(--mantine-color-amber-filled)" />
            <Text fz="sm" fw={600}>
              寫入（會修改外部臨床資料）
            </Text>
          </Group>
          {WRITE_OPS.map((op) => (
            <Checkbox
              key={op}
              color="amber"
              checked={form.allowed_operations.includes(op)}
              onChange={(e) => toggleOp(op, e.currentTarget.checked)}
              label={OP_LABEL[op]}
              description={OP_HELP[op]}
            />
          ))}
        </Stack>
      </SimpleGrid>
      {errors.allowed_operations && (
        <Text fz="sm" c="red">
          {errors.allowed_operations}
        </Text>
      )}
      {writeSelected.length > 0 && (
        <Alert color="amber" icon={<IconAlertTriangle size={18} />} p="sm" title="已開放寫入">
          LLM 可透過 crud_fhir_server 對這台伺服器執行 {writeSelected.join(" / ")}。
          {form.environment === "production" ? "這是正式環境，請再次確認確有需要。" : "請確認這是預期的設定。"}
        </Alert>
      )}
    </Stack>
  );
}


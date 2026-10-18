import { Alert, Anchor, Badge, Button, Group, Menu, Stack, Tabs, Text } from "@mantine/core";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconCopy,
  IconEdit,
  IconInfoCircle,
  IconListDetails,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlugConnected,
  IconServer2,
  IconShieldLock,
  IconStar,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { CopyText } from "@/components/CopyText";
import { EmptyState } from "@/components/EmptyState";
import { KeyValue } from "@/components/KeyValue";
import { PageHeader } from "@/components/PageHeader";
import { PageSkeleton, QueryBoundary } from "@/components/QueryBoundary";
import { RelativeTime } from "@/components/RelativeTime";
import { SectionCard } from "@/components/SectionCard";
import { ApiError } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import type { FhirServer } from "@/lib/types";
import { ConnectionResult } from "./ConnectionResult";
import { CapabilityPanel, OAuthPanel } from "./DetailPanels";
import { useFhirServer } from "./fhirApi";
import { AUTH_PROFILE_LABEL, AUTH_TYPE_LABEL, isWriteOp, jwksUrl, serverTitle, type ConnectionTestResult } from "./fhirModel";
import { DefaultBadge, EnabledBadge, EnvBadge, hasWriteOps, OperationBadges, ProbeStatus } from "./FhirBadges";
import { RequestConsole } from "./RequestConsole";
import { patchWouldDropSecret, useServerActions } from "./useServerActions";

const TABS = ["overview", "capability", "oauth", "console"] as const;
type Tab = (typeof TABS)[number];

export default function FhirServerDetailPage() {
  const { serverId = "" } = useParams();
  const q = useFhirServer(serverId);

  if (q.isError && q.error instanceof ApiError && q.error.status === 404) {
    return (
      <>
        <PageHeader title="找不到伺服器" breadcrumbs={[{ label: "FHIR 伺服器", to: "/fhir-servers" }, { label: serverId }]} />
        <SectionCard>
          <EmptyState
            icon={<IconServer2 size={28} />}
            title="這台 FHIR 伺服器不存在"
            description="可能已被刪除，或網址中的 ID 有誤。"
            action={
              <Button component={Link} to="/fhir-servers">
                回到伺服器清單
              </Button>
            }
          />
        </SectionCard>
      </>
    );
  }

  return (
    <QueryBoundary query={q} skeleton={<PageSkeleton rows={5} />}>
      {(server) => <Detail server={server} />}
    </QueryBoundary>
  );
}

function Detail({ server: s }: { server: FhirServer }) {
  const navigate = useNavigate();
  const actions = useServerActions();
  const [params, setParams] = useSearchParams();
  const [probeResult, setProbeResult] = useState<ConnectionTestResult | null>(null);
  const oauth = s.auth_type !== "none";
  const raw = params.get("tab") as Tab | null;
  const tab: Tab = raw && TABS.includes(raw) && (raw !== "oauth" || oauth) ? raw : "overview";
  const setTab = (t: string | null) => {
    const next = new URLSearchParams(params);
    if (!t || t === "overview") next.delete("tab");
    else next.set("tab", t);
    setParams(next, { replace: true });
  };
  const busy = actions.pending[s.fhir_server_id];
  const probing = busy === "probe";

  const probe = async () => {
    const r = await actions.probe(s);
    if (r) setProbeResult(r);
  };

  const lockedToggle = patchWouldDropSecret(s);
  const oauthBlocked = oauth && (s.oauth_status?.status === "not_authorized" || s.oauth_status?.status === "expired");

  return (
    <>
      <PageHeader
        title={serverTitle(s)}
        icon={<IconServer2 size={24} />}
        breadcrumbs={[{ label: "FHIR 伺服器", to: "/fhir-servers" }, { label: serverTitle(s) }]}
        badge={
          <Group gap={6}>
            {s.is_default && <DefaultBadge />}
            <EnvBadge env={s.environment} />
            <EnabledBadge enabled={s.enabled} />
          </Group>
        }
        description={
          <Stack gap={2} component="span">
            <Text span fz="sm" ff="monospace">
              {s.server_key}
            </Text>
            {s.description && (
              <Text span fz="sm" c="dimmed">
                {s.description}
              </Text>
            )}
          </Stack>
        }
        actions={
          <>
            <Button variant="light" leftSection={<IconPlugConnected size={16} />} onClick={() => void probe()} loading={probing} disabled={Boolean(busy) && !probing}>
              探測連線
            </Button>
            <Button leftSection={<IconEdit size={16} />} component={Link} to={`/fhir-servers/${s.fhir_server_id}/edit`}>
              編輯
            </Button>
            <Menu position="bottom-end" shadow="md" width={220}>
              <Menu.Target>
                <Button variant="default" rightSection={<IconChevronDown size={16} />} loading={Boolean(busy) && !probing}>
                  更多
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconStar size={16} />} disabled={s.is_default || !s.enabled} onClick={() => actions.setDefault(s)}>
                  {s.is_default ? "已是預設伺服器" : s.enabled ? "設為預設" : "設為預設（需先啟用）"}
                </Menu.Item>
                {lockedToggle ? (
                  <Menu.Item leftSection={s.enabled ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />} onClick={() => navigate(`/fhir-servers/${s.fhir_server_id}/edit`)}>
                    {s.enabled ? "停用（於編輯頁）" : "啟用（於編輯頁）"}
                  </Menu.Item>
                ) : (
                  <Menu.Item leftSection={s.enabled ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />} onClick={() => actions.toggleEnabled(s)}>
                    {s.enabled ? "停用" : "啟用"}
                  </Menu.Item>
                )}
                <Menu.Item leftSection={<IconCopy size={16} />} onClick={() => navigate(`/fhir-servers/new?from=${encodeURIComponent(s.fhir_server_id)}`)}>
                  複製為新伺服器
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => actions.remove(s, () => navigate("/fhir-servers", { replace: true }))}>
                  刪除…
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>
        }
      />

      {!s.enabled && (
        <Alert color="gray" icon={<IconInfoCircle size={18} />} mb="lg">
          此伺服器已停用：MCP 工具看不到也無法使用它。設定與權杖仍保留，可隨時重新啟用。
        </Alert>
      )}
      {s.enabled && oauthBlocked && (
        <Alert color="amber" icon={<IconAlertTriangle size={18} />} mb="lg">
          OAuth 尚未授權或權杖已過期，MCP 工具呼叫會失敗。{" "}
          <Anchor component="button" type="button" fw={600} fz="sm" onClick={() => setTab("oauth")}>
            前往 OAuth 設定
          </Anchor>
        </Alert>
      )}

      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="lg" style={{ flexWrap: "nowrap", overflowX: "auto", overflowY: "hidden" }}>
          <Tabs.Tab value="overview" leftSection={<IconInfoCircle size={16} />}>
            總覽
          </Tabs.Tab>
          <Tabs.Tab value="capability" leftSection={<IconListDetails size={16} />}>
            能力聲明
          </Tabs.Tab>
          {oauth && (
            <Tabs.Tab
              value="oauth"
              leftSection={<IconShieldLock size={16} />}
              rightSection={oauthBlocked ? <Badge size="xs" color="amber" circle>!</Badge> : undefined}
            >
              OAuth
            </Tabs.Tab>
          )}
          <Tabs.Tab value="console" leftSection={<IconTerminal2 size={16} />}>
            請求主控台
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview">
          <Overview server={s} probeResult={probeResult} onProbe={() => void probe()} probing={probing} />
        </Tabs.Panel>
        <Tabs.Panel value="capability">
          <SectionCard title="CapabilityStatement" description="伺服器宣告支援的 FHIR 版本、資源類型與互動">
            <CapabilityPanel server={s} onProbe={() => void probe()} probing={probing} />
          </SectionCard>
        </Tabs.Panel>
        {oauth && (
          <Tabs.Panel value="oauth">
            <SectionCard title="OAuth2 授權" icon={<IconShieldLock size={18} />}>
              <OAuthPanel server={s} />
            </SectionCard>
          </Tabs.Panel>
        )}
        <Tabs.Panel value="console">
          <SectionCard title="請求主控台" icon={<IconTerminal2 size={18} />}>
            <RequestConsole server={s} />
          </SectionCard>
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function headerList(h: Record<string, unknown> | null | undefined) {
  const entries = Object.entries(h ?? {});
  if (entries.length === 0) return null;
  return (
    <Stack gap={2}>
      {entries.map(([k, v]) => (
        <Text key={k} fz="xs" ff="monospace" style={{ wordBreak: "break-all" }}>
          {k}: {String(v)}
        </Text>
      ))}
    </Stack>
  );
}

function Overview({
  server: s,
  probeResult,
  onProbe,
  probing,
}: {
  server: FhirServer;
  probeResult: ConnectionTestResult | null;
  onProbe: () => void;
  probing: boolean;
}) {
  const oauth = s.auth_type !== "none";
  const cc = s.auth_type === "oauth2_client_credentials";
  const pk = cc && s.token_auth_method === "private_key_jwt";
  const writes = (s.allowed_operations ?? []).filter(isWriteOp);
  return (
    <Stack gap="lg">
      <SectionCard
        title="連線狀態"
        icon={<IconPlugConnected size={18} />}
        description="探測會執行完整連線流程並更新能力聲明；結果也會寫入探測紀錄。"
        actions={
          <Button size="xs" variant="light" onClick={onProbe} loading={probing}>
            立即探測
          </Button>
        }
      >
        <Stack gap="md">
          <Group gap="lg" wrap="wrap" align="flex-start">
            <ProbeStatus server={s} withTime={false} />
            <Text fz="sm" c="dimmed">
              最近探測：{s.last_probe_at ? <>{fmtDateTime(s.last_probe_at, true)}（<RelativeTime value={s.last_probe_at} />）</> : "從未"}
            </Text>
          </Group>
          {s.last_probe_error && !probeResult && (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} p="xs">
              <Text fz="sm" style={{ wordBreak: "break-word" }}>
                {s.last_probe_error_zh ?? s.last_probe_error}
              </Text>
              {s.last_probe_error_hint_zh && <Text fz="sm">{s.last_probe_error_hint_zh}</Text>}
              {s.last_probe_error_zh && (
                <Text fz="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-word" }}>
                  技術細節：{s.last_probe_error}
                </Text>
              )}
            </Alert>
          )}
          {probeResult && <ConnectionResult result={probeResult} />}
        </Stack>
      </SectionCard>

      <SectionCard title="MCP 權限" description="crud_fhir_server 對這台伺服器可以做的事">
        <Stack gap="md">
          <KeyValue
            items={[
              { label: "允許的操作", value: <OperationBadges ops={s.allowed_operations ?? []} />, full: true },
              {
                label: "允許的資源類型",
                full: true,
                value: (s.allowed_resource_types ?? []).length ? (
                  <Group gap={4} wrap="wrap">
                    {s.allowed_resource_types.map((t) => (
                      <Badge key={t} size="sm" variant="default" radius="sm" style={{ textTransform: "none" }}>
                        {t}
                      </Badge>
                    ))}
                  </Group>
                ) : (
                  <Text fz="sm" c="amber">不限（所有資源類型）</Text>
                ),
              },
            ]}
          />
          {writes.length > 0 && (
            <Alert color="amber" icon={<IconAlertTriangle size={18} />} p="sm">
              已開放寫入（{writes.join(", ")}）。LLM 傳入 confirm_write=true 時即可修改此伺服器上的臨床資料。
            </Alert>
          )}
        </Stack>
      </SectionCard>

      <SectionCard title="連線設定">
        <KeyValue
          items={[
            { label: "Base URL", value: <CopyText value={s.base_url} mono />, full: true },
            { label: "server_key", value: <CopyText value={s.server_key} mono /> },
            { label: "名稱", value: s.name },
            { label: "標籤", value: (s.tags ?? []).length ? <Group gap={4}>{s.tags.map((t) => <Badge key={t} size="sm" variant="light" color="gray" style={{ textTransform: "none" }}>{t}</Badge>)}</Group> : null },
            { label: "測試路徑", value: s.test_path ? <Text ff="monospace" fz="sm">{s.test_path}</Text> : "metadata（預設）" },
            { label: "逾時", value: `${s.timeout_seconds} 秒` },
            {
              label: "TLS 憑證驗證",
              value: s.verify_tls ? "開啟" : (
                <Text fz="sm" c="amber">
                  已關閉
                </Text>
              ),
            },
            { label: "資源請求標頭", value: headerList(s.resource_headers_json), full: true, hidden: !Object.keys(s.resource_headers_json ?? {}).length },
            { label: "伺服器 ID", value: <CopyText value={s.fhir_server_id} mono /> },
          ]}
        />
      </SectionCard>

      <SectionCard title="認證設定" icon={<IconShieldLock size={18} />}>
        <KeyValue
          items={[
            { label: "認證方式", value: AUTH_TYPE_LABEL[s.auth_type] ?? s.auth_type },
            { label: "設定檔", value: AUTH_PROFILE_LABEL[s.auth_profile] ?? s.auth_profile, hidden: !oauth },
            { label: "client_id", value: s.client_id ? <CopyText value={s.client_id} mono /> : null, hidden: !oauth },
            {
              label: "client_secret",
              value: s.client_secret_configured ? <Badge color="teal" variant="light">已設定（加密保存）</Badge> : "未設定",
              hidden: !oauth || pk,
            },
            { label: "Token 端點認證", value: s.token_auth_method, hidden: !cc },
            { label: "JWT 演算法 / kid", value: [s.jwt_signing_alg, s.jwt_kid].filter(Boolean).join(" · ") || null, hidden: !cc || !s.jwt_signing_alg },
            {
              label: "私鑰",
              value: s.client_private_key_configured ? <Badge color="teal" variant="light">已設定（加密保存）</Badge> : <Text fz="sm" c="red">未設定</Text>,
              hidden: !pk,
            },
            { label: "公開 JWKS 網址", value: <CopyText value={jwksUrl(s.fhir_server_id)} mono />, full: true, hidden: !pk },
            { label: "授權伺服器 URL", value: s.auth_server_url ? <CopyText value={s.auth_server_url} mono /> : null, hidden: !oauth },
            { label: "Metadata URL", value: s.metadata_url ? <CopyText value={s.metadata_url} mono /> : null, hidden: !oauth },
            { label: "Token endpoint", value: s.token_endpoint ? <CopyText value={s.token_endpoint} mono /> : null, hidden: !oauth },
            {
              label: "Authorization endpoint",
              value: s.authorization_endpoint ? <CopyText value={s.authorization_endpoint} mono /> : null,
              hidden: s.auth_type !== "oauth2_authorization_code",
            },
            { label: "使用 metadata 探索", value: s.use_metadata ? "是" : "否", hidden: !oauth },
            { label: "scope", value: s.scope ? <Text ff="monospace" fz="sm">{s.scope}</Text> : null, hidden: !oauth },
            { label: "resource / audience", value: s.resource || null, hidden: !oauth },
            { label: "requested_token_type", value: s.requested_token_type || null, hidden: !oauth || !s.requested_token_type },
            { label: "預設權杖策略", value: s.default_token_strategy || "自動", hidden: !cc },
            { label: "Metadata 請求標頭", value: headerList(s.metadata_headers_json), full: true, hidden: !Object.keys(s.metadata_headers_json ?? {}).length },
            { label: "Token 請求標頭", value: headerList(s.token_headers_json), full: true, hidden: !Object.keys(s.token_headers_json ?? {}).length },
          ]}
        />
        {!oauth && (
          <Text fz="sm" c="dimmed" mt="sm">
            此伺服器不使用 OAuth2，請求不會附加權杖。
          </Text>
        )}
      </SectionCard>

      <SectionCard title="紀錄">
        <KeyValue
          cols={3}
          items={[
            { label: "建立者", value: s.created_by || null },
            { label: "建立時間", value: s.created_at ? fmtDateTime(s.created_at) : null },
            { label: "最後更新", value: s.updated_at ? <RelativeTime value={s.updated_at} /> : null },
          ]}
        />
        {hasWriteOps(s) && s.environment === "production" && (
          <Text fz="xs" c="dimmed" mt="sm">
            提示：正式環境且開放寫入的伺服器，建議定期檢視授權範圍。
          </Text>
        )}
      </SectionCard>
    </Stack>
  );
}

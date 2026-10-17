import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Button,
  Group,
  Menu,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconDotsVertical,
  IconDownload,
  IconEdit,
  IconFileImport,
  IconPlugConnected,
  IconPlus,
  IconSearch,
  IconServer2,
  IconStar,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { confirmAction } from "@/components/confirm";
import { CopyText } from "@/components/CopyText";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { notify } from "@/components/notify";
import { PageHeader } from "@/components/PageHeader";
import { QueryBoundary } from "@/components/QueryBoundary";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { useDebounced } from "@/lib/hooks";
import type { FhirServer } from "@/lib/types";
import { downloadJson, fhirApi, useFhirServers, useInvalidateFhir } from "./fhirApi";
import { ENVIRONMENTS, serverTitle } from "./fhirModel";
import { AuthSummary, DefaultBadge, EnvBadge, hasWriteOps, OperationBadges, ProbeStatus } from "./FhirBadges";
import { ImportModal } from "./ImportModal";
import { patchWouldDropSecret, useServerActions } from "./useServerActions";

/** Surface the OAuth Authorization Code callback result (?oauth=success|error). */
function useOAuthCallbackNotice(): { kind: "success" | "error"; server?: string; reason?: string } | null {
  const [params, setParams] = useSearchParams();
  const [notice, setNotice] = useState<{ kind: "success" | "error"; server?: string; reason?: string } | null>(null);
  const handled = useRef(false);
  useEffect(() => {
    const oauth = params.get("oauth");
    if (!oauth || handled.current) return;
    handled.current = true;
    if (oauth === "success") {
      const server = params.get("server") ?? undefined;
      setNotice({ kind: "success", server });
      notify.success(server ? `「${server}」已完成 OAuth2 授權，權杖已安全儲存。` : "OAuth2 授權完成。", "授權成功");
    } else {
      const reason = params.get("reason") ?? "未知原因";
      setNotice({ kind: "error", reason });
      notify.error(reason, "OAuth2 授權失敗");
    }
    const next = new URLSearchParams(params);
    next.delete("oauth");
    next.delete("server");
    next.delete("reason");
    setParams(next, { replace: true });
  }, [params, setParams]);
  return notice;
}

export default function FhirServersPage() {
  const q = useFhirServers();
  const navigate = useNavigate();
  const notice = useOAuthCallbackNotice();
  const [dismissed, setDismissed] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [probingAll, setProbingAll] = useState<{ done: number; total: number } | null>(null);
  const invalidate = useInvalidateFhir();

  const exportAll = () =>
    confirmAction({
      title: "匯出全部 FHIR 伺服器設定？",
      message: "會下載一個 JSON 檔，可用於備份或搬移到另一套安裝。",
      consequences: [
        <Text key="a" fz="sm" span>
          檔案包含<b>解密後的 client secret 與私鑰</b>，等同伺服器的登入憑證
        </Text>,
        "請存放在安全位置，切勿寄送、上傳到共用空間或提交到版本庫",
      ],
      confirmLabel: "我了解，下載",
      onConfirm: async () => {
        setExporting(true);
        try {
          const r = await fhirApi.exportAll();
          downloadJson(`fhir-servers-${new Date().toISOString().slice(0, 10)}.json`, {
            format: "taiwan-health-mcp-fhir-servers",
            version: 1,
            exported_at: new Date().toISOString(),
            servers: r.servers ?? [],
          });
          notify.success(`已匯出 ${r.servers?.length ?? 0} 台伺服器設定`);
        } catch (e) {
          notify.error(e, "匯出失敗");
          throw e;
        } finally {
          setExporting(false);
        }
      },
    });

  const probeAll = async (servers: FhirServer[]) => {
    const targets = servers.filter((s) => s.enabled);
    if (targets.length === 0) {
      notify.info("沒有啟用中的伺服器可探測。");
      return;
    }
    setProbingAll({ done: 0, total: targets.length });
    let ok = 0;
    let fail = 0;
    const queue = [...targets];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          const r = await fhirApi.probe(s.fhir_server_id);
          if (r.ok) ok++;
          else fail++;
        } catch {
          fail++;
        }
        setProbingAll((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setProbingAll(null);
    await invalidate();
    if (fail) notify.warn(`${ok} 台正常，${fail} 台失敗。失敗原因請看各列的探測狀態。`, "探測完成");
    else notify.success(`${ok} 台伺服器皆連線正常`, "探測完成");
  };

  return (
    <>
      <PageHeader
        title="FHIR 伺服器"
        icon={<IconServer2 size={24} />}
        description="管理 MCP 工具可連線的外部 FHIR R4 伺服器。crud_fhir_server 能對允許寫入的伺服器建立、修改或刪除臨床資料，請謹慎設定權限。"
        actions={
          <>
            <Button variant="default" leftSection={<IconFileImport size={16} />} onClick={() => setImportOpen(true)}>
              匯入
            </Button>
            <Tooltip label="下載含機密資料的 JSON 備份">
              <Button
                variant="default"
                leftSection={<IconDownload size={16} />}
                onClick={exportAll}
                loading={exporting}
                disabled={!q.data || q.data.length === 0}
              >
                匯出
              </Button>
            </Tooltip>
            <Button
              variant="light"
              leftSection={<IconPlugConnected size={16} />}
              loading={Boolean(probingAll)}
              disabled={!q.data || q.data.length === 0}
              onClick={() => q.data && void probeAll(q.data)}
            >
              探測全部
            </Button>
            <Button leftSection={<IconPlus size={16} />} component={Link} to="/fhir-servers/new">
              新增伺服器
            </Button>
          </>
        }
      />

      {notice && !dismissed && (
        <Alert
          mb="lg"
          color={notice.kind === "success" ? "teal" : "red"}
          icon={notice.kind === "success" ? <IconCheck size={18} /> : <IconX size={18} />}
          title={notice.kind === "success" ? "OAuth2 授權完成" : "OAuth2 授權失敗"}
          withCloseButton
          onClose={() => setDismissed(true)}
        >
          {notice.kind === "success" ? (
            <Text fz="sm">
              {notice.server ? (
                <>
                  伺服器 <Anchor component={Link} to={`/fhir-servers/${encodeURIComponent(notice.server)}`} ff="monospace">{notice.server}</Anchor> 已取得使用者授權，MCP 工具現在可以代表此帳號存取資料。
                </>
              ) : (
                "已取得使用者授權。"
              )}
            </Text>
          ) : (
            <Text fz="sm" style={{ wordBreak: "break-word" }}>
              授權伺服器回報：{notice.reason}。請確認 redirect URI、client_id 與 scope 設定後，從伺服器詳情頁重新授權。
            </Text>
          )}
        </Alert>
      )}

      {probingAll && (
        <Alert mb="lg" color="blue" icon={<IconPlugConnected size={18} />}>
          正在探測啟用中的伺服器…（{probingAll.done} / {probingAll.total}）
        </Alert>
      )}

      <QueryBoundary query={q}>
        {(servers) =>
          servers.length === 0 ? (
            <SectionCard>
              <EmptyState
                icon={<IconServer2 size={28} />}
                title="尚未設定任何 FHIR 伺服器"
                description="新增外部 FHIR R4 伺服器後，LLM 就能透過 list_fhir_servers / crud_fhir_server 工具查詢（以及在允許時寫入）臨床資料。"
                action={
                  <Group justify="center" gap="sm">
                    <Button leftSection={<IconPlus size={16} />} onClick={() => navigate("/fhir-servers/new")}>
                      新增伺服器
                    </Button>
                    <Button variant="default" leftSection={<IconFileImport size={16} />} onClick={() => setImportOpen(true)}>
                      從檔案匯入
                    </Button>
                  </Group>
                }
              />
            </SectionCard>
          ) : (
            <ServerList servers={servers} />
          )
        }
      </QueryBoundary>

      <ImportModal opened={importOpen} onClose={() => setImportOpen(false)} servers={q.data ?? []} />
    </>
  );
}

function ServerList({ servers }: { servers: FhirServer[] }) {
  const navigate = useNavigate();
  const actions = useServerActions();
  const [search, setSearch] = useState("");
  const [env, setEnv] = useState<string | null>(null);
  const [enabled, setEnabled] = useState("all");
  const dq = useDebounced(search, 200).trim().toLowerCase();

  const filtered = useMemo(
    () =>
      servers.filter((s) => {
        if (env && (s.environment || "__none") !== env) return false;
        if (enabled === "on" && !s.enabled) return false;
        if (enabled === "off" && s.enabled) return false;
        if (!dq) return true;
        return [s.server_key, s.name, s.display_name, s.base_url, s.description, ...(s.tags ?? [])].some((v) =>
          String(v ?? "").toLowerCase().includes(dq),
        );
      }),
    [servers, env, enabled, dq],
  );

  const stats = useMemo(
    () => ({
      total: servers.length,
      enabled: servers.filter((s) => s.enabled).length,
      healthy: servers.filter((s) => s.enabled && s.last_probe_status === "ok").length,
      failing: servers.filter((s) => s.enabled && s.last_probe_status === "error").length,
      writable: servers.filter((s) => s.enabled && hasWriteOps(s)).length,
    }),
    [servers],
  );

  const envOptions = [
    ...ENVIRONMENTS.filter((e) => servers.some((s) => s.environment === e.value)).map((e) => ({ value: e.value, label: e.label })),
    ...(servers.some((s) => !s.environment) ? [{ value: "__none", label: "未標示" }] : []),
  ];

  const columns: Column<FhirServer>[] = [
    {
      key: "name",
      header: "伺服器",
      primary: true,
      sortValue: (s) => serverTitle(s),
      render: (s) => (
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <Text fw={600} fz="sm">
              {serverTitle(s)}
            </Text>
            {s.is_default && <DefaultBadge />}
          </Group>
          <Text fz="xs" c="dimmed" ff="monospace">
            {s.server_key}
          </Text>
        </Stack>
      ),
    },
    { key: "env", header: "環境", sortValue: (s) => s.environment || "~", render: (s) => <EnvBadge env={s.environment} /> },
    {
      key: "url",
      header: "Base URL",
      hideOnMobile: false,
      render: (s) => (
        <Box maw={280} onClick={(e) => e.stopPropagation()}>
          <CopyText value={s.base_url} mono truncate />
        </Box>
      ),
    },
    { key: "auth", header: "認證", sortValue: (s) => s.auth_type, render: (s) => <AuthSummary server={s} /> },
    {
      key: "probe",
      header: "最近探測",
      sortValue: (s) => s.last_probe_at ?? "",
      render: (s) => <ProbeStatus server={s} />,
    },
    {
      key: "ops",
      header: "允許的操作",
      render: (s) => <OperationBadges ops={s.allowed_operations ?? []} />,
    },
    {
      key: "enabled",
      header: "啟用",
      align: "center",
      sortValue: (s) => (s.enabled ? 1 : 0),
      render: (s) => {
        const locked = patchWouldDropSecret(s);
        const sw = (
          <Switch
            checked={s.enabled}
            disabled={Boolean(actions.pending[s.fhir_server_id]) || locked}
            onChange={() => actions.toggleEnabled(s)}
            aria-label={s.enabled ? "停用" : "啟用"}
            onClick={(e) => e.stopPropagation()}
          />
        );
        return (
          <Box onClick={(e) => e.stopPropagation()} style={{ display: "inline-block" }}>
            {locked ? <Tooltip label="授權碼模式的伺服器請到「編輯」頁切換（需一併重新輸入 client secret）">{<span>{sw}</span>}</Tooltip> : sw}
          </Box>
        );
      },
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: 56,
      render: (s) => (
        <Box onClick={(e) => e.stopPropagation()}>
          <RowMenu server={s} actions={actions} />
        </Box>
      ),
    },
  ];

  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
        <StatCard label="伺服器" value={stats.total} hint={`${stats.enabled} 台啟用中`} icon={<IconServer2 size={18} />} />
        <StatCard label="連線正常" value={stats.healthy} hint="最近一次探測成功" color="teal" icon={<IconCheck size={18} />} />
        <StatCard
          label="連線失敗"
          value={stats.failing}
          hint={stats.failing ? "請查看探測錯誤" : "目前沒有"}
          color={stats.failing ? "red" : "gray"}
          icon={<IconX size={18} />}
        />
        <StatCard
          label="允許寫入"
          value={stats.writable}
          hint="啟用且開放 create/update/patch/delete"
          color={stats.writable ? "amber" : "gray"}
          icon={<IconAlertTriangle size={18} />}
        />
      </SimpleGrid>

      <SectionCard flush>
        <Group p="md" gap="sm" wrap="wrap" align="flex-end">
          <TextInput
            placeholder="搜尋名稱、server_key、網址、標籤…"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            style={{ flex: "1 1 240px" }}
            aria-label="搜尋"
          />
          <Select
            placeholder="所有環境"
            data={envOptions}
            value={env}
            onChange={setEnv}
            clearable
            w={{ base: "100%", xs: 160 }}
            aria-label="環境"
            disabled={envOptions.length === 0}
          />
          <SegmentedControl
            value={enabled}
            onChange={setEnabled}
            data={[
              { value: "all", label: "全部" },
              { value: "on", label: "啟用" },
              { value: "off", label: "停用" },
            ]}
          />
        </Group>
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(s) => s.fhir_server_id}
          onRowClick={(s) => navigate(`/fhir-servers/${s.fhir_server_id}`)}
          minWidth={1080}
          pageSize={20}
          empty={
            <EmptyState
              compact
              icon={<IconSearch size={20} />}
              title="沒有符合條件的伺服器"
              description="請調整搜尋文字或篩選條件。"
              action={
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() => {
                    setSearch("");
                    setEnv(null);
                    setEnabled("all");
                  }}
                >
                  清除篩選
                </Button>
              }
            />
          }
        />
      </SectionCard>
    </Stack>
  );
}

function RowMenu({ server: s, actions }: { server: FhirServer; actions: ReturnType<typeof useServerActions> }) {
  const navigate = useNavigate();
  const busy = actions.pending[s.fhir_server_id];
  return (
    <Menu position="bottom-end" withinPortal shadow="md" width={200}>
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" aria-label="更多動作" loading={Boolean(busy)}>
          <IconDotsVertical size={18} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconPlugConnected size={16} />} onClick={() => void actions.probe(s)}>
          立即探測
        </Menu.Item>
        <Menu.Item leftSection={<IconEdit size={16} />} onClick={() => navigate(`/fhir-servers/${s.fhir_server_id}/edit`)}>
          編輯
        </Menu.Item>
        <Menu.Item leftSection={<IconCopy size={16} />} onClick={() => navigate(`/fhir-servers/new?from=${encodeURIComponent(s.fhir_server_id)}`)}>
          複製為新伺服器
        </Menu.Item>
        <Menu.Item
          leftSection={<IconStar size={16} />}
          disabled={s.is_default || !s.enabled}
          onClick={() => actions.setDefault(s)}
        >
          {s.is_default ? "已是預設" : s.enabled ? "設為預設" : "設為預設（需先啟用）"}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => actions.remove(s)}>
          刪除…
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

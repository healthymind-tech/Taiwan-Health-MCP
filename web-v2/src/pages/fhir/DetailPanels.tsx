import { Alert, Badge, Box, Button, Group, SimpleGrid, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconExternalLink, IconKey, IconPlugConnected, IconRefresh, IconSearch, IconTrash } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { confirmAction } from "@/components/confirm";
import { CopyText } from "@/components/CopyText";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { HealthBadge } from "@/components/StatusBadge";
import { KeyValue } from "@/components/KeyValue";
import { notify } from "@/components/notify";
import { RelativeTime } from "@/components/RelativeTime";
import { fmtDateTime } from "@/lib/format";
import type { FhirCapabilityResource, FhirServer } from "@/lib/types";
import { fhirApi, useInvalidateFhir } from "./fhirApi";
import { isWriteOp, OAUTH_STATUS_META } from "./fhirModel";

const WRITE_INTERACTIONS = new Set(["create", "update", "patch", "delete", "conditional-create", "conditional-update", "conditional-patch", "conditional-delete"]);

// ── OAuth ─────────────────────────────────────────────────────────────────────
export function OAuthPanel({ server }: { server: FhirServer }) {
  const invalidate = useInvalidateFhir();
  const [busy, setBusy] = useState<string | null>(null);
  const st = server.oauth_status;
  const status = st?.status ?? "not_authorized";
  const meta = OAUTH_STATUS_META[status] ?? { label: status, state: "unknown" as const };
  const cc = server.auth_type === "oauth2_client_credentials";

  const authorize = async () => {
    setBusy("authorize");
    try {
      const r = await fhirApi.authorize(server.fhir_server_id);
      if (r.authorization_uri) {
        notify.info("正在前往授權伺服器登入頁…");
        window.location.assign(r.authorization_uri);
        return;
      }
      notify.success("已取得 Client Credentials 存取權杖。", "授權成功");
      await invalidate();
    } catch (e) {
      notify.error(e, "授權失敗");
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    try {
      await fhirApi.refresh(server.fhir_server_id);
      notify.success("已使用 refresh token 換發新的存取權杖。");
      await invalidate();
    } catch (e) {
      notify.error(e, "更新權杖失敗");
    } finally {
      setBusy(null);
    }
  };

  const clear = () =>
    confirmAction({
      title: "清除已儲存的 OAuth 權杖？",
      message: "會刪除此伺服器的存取權杖與 refresh token。",
      consequences: [
        cc ? "下次呼叫時系統會自動重新以 client credentials 取得權杖" : "MCP 工具將無法存取此伺服器，直到管理員重新「前往授權」並登入",
        "可用於撤銷授權、或在更換 client 設定後強制重新授權",
      ],
      confirmLabel: "清除權杖",
      danger: !cc,
      onConfirm: async () => {
        setBusy("clear");
        try {
          await fhirApi.clearCache(server.fhir_server_id);
          notify.success("已清除 OAuth 權杖。");
          await invalidate();
        } catch (e) {
          notify.error(e, "清除失敗");
          throw e;
        } finally {
          setBusy(null);
        }
      },
    });

  const canRefresh = Boolean(st?.has_refresh) && status !== "not_authorized";

  return (
    <Stack gap="md">
      <Group gap="sm" wrap="wrap">
        <HealthBadge state={meta.state} label={meta.label} size="md" />
        <Text fz="sm" c="dimmed">
          {cc ? "Client Credentials：系統以 client 身分自動取得權杖" : "Authorization Code：需管理員登入授權一次，之後自動以 refresh token 更新"}
        </Text>
      </Group>
      {status === "expired" && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} p="sm">
          存取權杖已過期且無法自動更新。{cc ? "請按「取得權杖」重新取得。" : "請按「前往授權」重新登入。"}
        </Alert>
      )}
      {status === "not_authorized" && !cc && (
        <Alert color="amber" icon={<IconAlertTriangle size={18} />} p="sm">
          尚未授權：MCP 工具目前無法存取這台伺服器。按「前往授權」會轉到授權伺服器的登入頁，完成後自動返回此後台。
        </Alert>
      )}
      {status === "pending" && (
        <Alert color="blue" p="sm">
          授權流程已開始但尚未完成。若已關閉登入頁，可再次按「前往授權」。
        </Alert>
      )}
      <KeyValue
        cols={2}
        items={[
          {
            label: "存取權杖到期",
            value: st?.access_expires_at ? (
              <Group gap={6}>
                <Text fz="sm">{fmtDateTime(st.access_expires_at, true)}</Text>
                <RelativeTime value={st.access_expires_at} fz="xs" c="dimmed" />
              </Group>
            ) : null,
          },
          {
            label: "Refresh token",
            value: st?.has_refresh ? (st.refresh_expires_at ? `有，到期 ${fmtDateTime(st.refresh_expires_at, true)}` : "有（無到期時間）") : "無",
          },
          { label: "授與的 scope", value: st?.scope ? <Text ff="monospace" fz="sm">{st.scope}</Text> : null, full: true },
        ]}
      />
      <Group gap="xs" wrap="wrap">
        <Tooltip label={!server.enabled ? "伺服器已停用" : cc ? "立即向 token endpoint 取得並保存權杖" : "前往授權伺服器登入（同一分頁），完成後自動返回"}>
          <Button
            leftSection={cc ? <IconKey size={16} /> : <IconExternalLink size={16} />}
            onClick={() => void authorize()}
            loading={busy === "authorize"}
            disabled={Boolean(busy) && busy !== "authorize"}
          >
            {cc ? "取得權杖" : status === "authorized" ? "重新授權" : "前往授權"}
          </Button>
        </Tooltip>
        <Tooltip label={canRefresh ? "以 refresh token 換發新的存取權杖" : "沒有可用的 refresh token"}>
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            onClick={() => void refresh()}
            loading={busy === "refresh"}
            disabled={!canRefresh || (Boolean(busy) && busy !== "refresh")}
          >
            更新權杖
          </Button>
        </Tooltip>
        <Button
          variant="subtle"
          color="red"
          leftSection={<IconTrash size={16} />}
          onClick={clear}
          loading={busy === "clear"}
          disabled={(Boolean(busy) && busy !== "clear") || status === "not_authorized"}
        >
          清除權杖
        </Button>
      </Group>
      {!cc && (
        <Box>
          <Text fz="xs" c="dimmed">
            授權伺服器需允許的 redirect URI
          </Text>
          <CopyText value={`${window.location.origin}/fhir-oauth/callback`} mono />
        </Box>
      )}
    </Stack>
  );
}

// ── Capability statement ──────────────────────────────────────────────────────
export function CapabilityPanel({ server, onProbe, probing }: { server: FhirServer; onProbe: () => void; probing: boolean }) {
  const cap = server.capability_summary ?? {};
  const resources = cap.supported_resources ?? [];
  const [q, setQ] = useState("");
  const allowed = new Set(server.allowed_resource_types ?? []);
  const unrestricted = allowed.size === 0;
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? resources.filter((r) => r.type.toLowerCase().includes(s) || (r.interactions ?? []).some((i) => i.includes(s))) : resources;
  }, [resources, q]);

  if (!cap.fhirVersion && resources.length === 0) {
    return (
      <EmptyState
        compact
        icon={<IconPlugConnected size={20} />}
        title="尚未取得能力聲明"
        description={
          server.test_path
            ? "此伺服器設定了測試路徑，探測時不會讀取 /metadata。可在「請求主控台」以 GET metadata 查看。"
            : "執行一次連線探測後，這裡會顯示伺服器的 FHIR 版本與支援的資源。"
        }
        action={
          <Button size="xs" variant="light" leftSection={<IconPlugConnected size={14} />} onClick={onProbe} loading={probing}>
            立即探測
          </Button>
        }
      />
    );
  }

  const sw = cap.software ?? {};
  const impl = cap.implementation ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

  const columns: Column<FhirCapabilityResource>[] = [
    {
      key: "type",
      header: "資源類型",
      primary: true,
      sortValue: (r) => r.type,
      render: (r) => (
        <Group gap={6} wrap="nowrap">
          <Text fz="sm" fw={600} ff="monospace">
            {r.type}
          </Text>
          {!unrestricted && allowed.has(r.type) && (
            <Tooltip label="MCP 工具允許存取此類型">
              <IconCircleCheck size={16} color="var(--mantine-color-teal-filled)" />
            </Tooltip>
          )}
        </Group>
      ),
    },
    {
      key: "interactions",
      header: "支援的互動",
      render: (r) =>
        (r.interactions ?? []).length ? (
          <Group gap={4} wrap="wrap">
            {(r.interactions ?? []).map((i) => (
              <Badge key={i} size="xs" radius="sm" variant="light" color={WRITE_INTERACTIONS.has(i) || isWriteOp(i) ? "amber" : "gray"} style={{ textTransform: "none" }}>
                {i}
              </Badge>
            ))}
          </Group>
        ) : (
          <Text fz="xs" c="dimmed">
            未宣告
          </Text>
        ),
    },
    {
      key: "profile",
      header: "Profile",
      hideOnMobile: true,
      render: (r) => (r.profile ? <Text fz="xs" ff="monospace" style={{ wordBreak: "break-all" }}>{r.profile}</Text> : <Text fz="xs" c="dimmed">—</Text>),
    },
  ];

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
        <KeyValue cols={1} items={[{ label: "FHIR 版本", value: cap.fhirVersion ? <Badge variant="light">{cap.fhirVersion}</Badge> : null }]} />
        <KeyValue cols={1} items={[{ label: "軟體", value: [str(sw.name), str(sw.version)].filter(Boolean).join(" ") || null }]} />
        <KeyValue cols={1} items={[{ label: "實作", value: str(impl.description) || str(impl.url) || null }]} />
      </SimpleGrid>
      <Text fz="xs" c="dimmed">
        資料來自最近一次成功的探測 · {resources.length} 種資源類型
        {unrestricted ? " · 此伺服器未限制資源類型（MCP 可存取全部）" : ` · 打勾者為 MCP 允許的 ${allowed.size} 種`}
      </Text>
      <TextInput
        placeholder="搜尋資源類型或互動（例如 Observation、create）"
        leftSection={<IconSearch size={16} />}
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        aria-label="搜尋資源類型"
      />
      <Box mx={{ base: -8, sm: 0 }}>
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.type}
          pageSize={25}
          minWidth={640}
          empty={<EmptyState compact title="沒有符合的資源類型" />}
        />
      </Box>
    </Stack>
  );
}

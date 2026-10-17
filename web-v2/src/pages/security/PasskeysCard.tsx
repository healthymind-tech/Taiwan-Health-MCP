import { ActionIcon, Alert, Badge, Box, Button, Group, Modal, Stack, Text, TextInput, ThemeIcon, Tooltip } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  browserSupportsWebAuthn,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import { IconAlertTriangle, IconDeviceMobile, IconFingerprint, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { confirmAction } from "@/components/confirm";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { notify } from "@/components/notify";
import { RelativeTime } from "@/components/RelativeTime";
import { SectionCard } from "@/components/SectionCard";
import { api, errorMessage } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";

interface Credential {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** Best-effort default label from the user agent ("Mac 上的 Chrome"). */
function guessLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "此裝置";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${os} 上的 ${browser}` : os;
}

/** Is `host` the RP ID or a subdomain of it? (Browser rule for which RP IDs a page may use.) */
function hostMatchesRp(host: string, rpId: string): boolean {
  return host === rpId || host.endsWith(`.${rpId}`);
}

function describeWebAuthnError(err: unknown, rpId: string | null): { level: "info" | "error"; message: string } {
  const host = window.location.hostname;
  if (err instanceof WebAuthnError) {
    switch (err.code) {
      case "ERROR_CEREMONY_ABORTED":
        return { level: "info", message: "已取消註冊。" };
      case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
        return { level: "error", message: "這個驗證器已經註冊過了。每個裝置／安全金鑰只需註冊一次。" };
      case "ERROR_INVALID_DOMAIN":
        return { level: "error", message: `目前網址（${host}）不是安全來源。Passkey 需要 HTTPS（localhost 除外）。` };
      case "ERROR_INVALID_RP_ID":
        return {
          level: "error",
          message: `伺服器設定的 RP ID「${rpId ?? "?"}」與目前網域「${host}」不符。請以 WEBAUTHN_RP_ID 設定的網域開啟主控台，或請管理者修正 .env 中的 WEBAUTHN_RP_ID。`,
        };
      default:
        break;
    }
  }
  if (err instanceof Error && err.name === "NotAllowedError") {
    return { level: "info", message: "註冊已取消或逾時。請再試一次，並在系統提示出現時完成驗證（指紋、臉部或 PIN）。" };
  }
  return { level: "error", message: errorMessage(err) };
}

export function PasskeysCard() {
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const supported = browserSupportsWebAuthn();
  const secure = window.isSecureContext;
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [regError, setRegError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: qk.passkeys,
    queryFn: () => api.get<{ credentials: Credential[] }>("/admin/api/passkeys"),
  });
  const creds = q.data?.credentials ?? [];

  const register = useMutation({
    mutationFn: async (name: string) => {
      const options = await api.post<PublicKeyCredentialCreationOptionsJSON>("/admin/api/passkeys/register/options");
      const rpId = options.rp.id ?? null;
      if (rpId && !hostMatchesRp(window.location.hostname, rpId)) {
        throw Object.assign(new Error(), { rpMismatch: rpId });
      }
      try {
        const response = await startRegistration({ optionsJSON: options });
        return await api.post<{ ok: boolean }>("/admin/api/passkeys/register/verify", { response, label: name.trim() || null });
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { rpId });
      }
    },
    onSuccess: async () => {
      setOpen(false);
      setRegError(null);
      notify.success("下次登入時可以直接使用這把 passkey。", "Passkey 已註冊");
      await qc.invalidateQueries({ queryKey: qk.passkeys });
    },
    onError: (err) => {
      const e = err as Error & { rpMismatch?: string; rpId?: string | null };
      if (e.rpMismatch) {
        setRegError(
          `此系統的 passkey 綁定在「${e.rpMismatch}」，但你目前是從「${window.location.hostname}」開啟。請改用 https://${e.rpMismatch} 開啟主控台再註冊，否則註冊出來的 passkey 也無法登入。`,
        );
        return;
      }
      const d = describeWebAuthnError(err, e.rpId ?? null);
      if (d.level === "info") {
        setRegError(null);
        notify.info(d.message);
      } else setRegError(d.message);
    },
  });

  const remove = (c: Credential) => {
    const last = creds.length === 1;
    confirmAction({
      title: `移除 passkey「${c.label || "未命名"}」？`,
      consequences: [
        "這個裝置／安全金鑰將無法再用來登入此主控台。",
        last ? "這是最後一把 passkey：移除後只能用密碼登入。" : `移除後還剩 ${creds.length - 1} 把 passkey。`,
        "裝置上的 passkey 不會被刪除，請到裝置的密碼管理員手動清除。",
      ],
      confirmLabel: "移除",
      danger: true,
      onConfirm: async () => {
        try {
          await api.del(`/admin/api/passkeys/${encodeURIComponent(c.id)}`);
          notify.success("已移除 passkey");
          await qc.invalidateQueries({ queryKey: qk.passkeys });
        } catch (err) {
          notify.error(err, "移除失敗");
          throw err;
        }
      },
    });
  };

  const blocked = !supported || !secure;
  const columns: Column<Credential>[] = [
    {
      key: "label",
      header: "名稱",
      primary: true,
      sortValue: (c) => c.label ?? "",
      render: (c) => (
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon variant="light" size={30} radius="md">
            <IconFingerprint size={16} />
          </ThemeIcon>
          <Box style={{ minWidth: 0 }}>
            <Text fz="sm" fw={600} truncate="end">
              {c.label || "未命名"}
            </Text>
            <Text fz="xs" c="dimmed" ff="monospace" truncate="end" maw={220}>
              {c.id.slice(0, 16)}…
            </Text>
          </Box>
        </Group>
      ),
    },
    {
      key: "created",
      header: "註冊時間",
      sortValue: (c) => c.created_at,
      render: (c) => <Text fz="sm">{fmtDateTime(c.created_at)}</Text>,
    },
    {
      key: "used",
      header: "最後使用",
      sortValue: (c) => c.last_used_at ?? "",
      render: (c) =>
        c.last_used_at ? (
          <RelativeTime value={c.last_used_at} fz="sm" />
        ) : (
          <Badge variant="light" color="gray" size="sm">
            從未使用
          </Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (c) => (
        <Tooltip label="移除">
          <ActionIcon variant="subtle" color="red" onClick={() => remove(c)} aria-label="移除 passkey">
            <IconTrash size={16} />
          </ActionIcon>
        </Tooltip>
      ),
    },
  ];

  return (
    <SectionCard
      title="Passkey"
      description="用指紋、臉部辨識、裝置 PIN 或實體安全金鑰登入，不需輸入密碼，也不會被釣魚網站盜用。"
      icon={<IconFingerprint size={18} />}
      actions={
        <Tooltip label={!secure ? "需要 HTTPS 連線" : "此瀏覽器不支援 passkey"} disabled={!blocked}>
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => {
              setLabel(guessLabel());
              setRegError(null);
              setOpen(true);
            }}
            disabled={blocked}
          >
            註冊新的 passkey
          </Button>
        </Tooltip>
      }
      flush
    >
      <Stack gap={0}>
        {(!supported || !secure) && (
          <Box p="md">
            <Alert color="amber" icon={<IconAlertTriangle size={18} />} title={!secure ? "需要 HTTPS 才能使用 passkey" : "此瀏覽器不支援 passkey"}>
              {!secure
                ? `目前是透過不安全的連線（${window.location.protocol}//${window.location.host}）開啟。瀏覽器只允許在 HTTPS（或 localhost）上使用 passkey，請改用設定好的 HTTPS 網域開啟主控台。`
                : "請改用新版的 Chrome、Edge、Safari 或 Firefox。"}
            </Alert>
          </Box>
        )}
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={creds}
            rowKey={(c) => c.id}
            loading={q.isPending}
            minWidth={560}
            empty={
              <EmptyState
                compact
                icon={<IconDeviceMobile size={20} />}
                title="尚未註冊任何 passkey"
                description="註冊後即可免密碼登入。建議至少註冊兩把（例如筆電與手機），避免其中一個裝置遺失時無法登入。"
              />
            }
          />
        )}
        <Text fz="xs" c="dimmed" p="md">
          Passkey 綁定在伺服器設定的網域（WEBAUTHN_RP_ID）。從其他網域或 IP 開啟主控台時無法註冊或使用。目前不支援重新命名，如需更改名稱請移除後重新註冊。
        </Text>
      </Stack>

      <Modal opened={open} onClose={() => !register.isPending && setOpen(false)} title="註冊新的 passkey" fullScreen={isMobile} centered>
        <Stack gap="md">
          <Text fz="sm" c="dimmed">
            按下「開始註冊」後，瀏覽器會請你選擇儲存位置（此裝置、手機或安全金鑰）並完成驗證。
          </Text>
          <TextInput
            label="名稱"
            description="方便日後辨識，例如「辦公室筆電」或「YubiKey 5」。"
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            maxLength={80}
            data-autofocus
          />
          {regError && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} p="sm">
              <Text fz="sm" style={{ wordBreak: "break-word" }}>
                {regError}
              </Text>
            </Alert>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setOpen(false)} disabled={register.isPending}>
              取消
            </Button>
            <Button leftSection={<IconFingerprint size={16} />} onClick={() => register.mutate(label)} loading={register.isPending}>
              開始註冊
            </Button>
          </Group>
        </Stack>
      </Modal>
    </SectionCard>
  );
}

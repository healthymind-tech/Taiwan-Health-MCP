import { Text } from "@mantine/core";
import { useState } from "react";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import type { FhirServer } from "@/lib/types";
import { fhirApi, useInvalidateFhir } from "./fhirApi";
import { serverTitle } from "./fhirModel";
import { hasWriteOps } from "./FhirBadges";

/**
 * True when a PATCH would silently drop the stored client secret: the backend only
 * preserves the secret on update for Client Credentials servers
 * (adminFhirServers.ts updateFhirServer → keepSecret).
 */
export function patchWouldDropSecret(s: FhirServer): boolean {
  return s.auth_type === "oauth2_authorization_code" && s.client_secret_configured;
}

/** Shared row/detail actions with per-server pending tracking. */
export function useServerActions() {
  const invalidate = useInvalidateFhir();
  const [pending, setPending] = useState<Record<string, string>>({});
  const mark = (id: string, action: string | null) =>
    setPending((p) => {
      const n = { ...p };
      if (action) n[id] = action;
      else delete n[id];
      return n;
    });

  const run = async <T,>(id: string, action: string, fn: () => Promise<T>): Promise<T> => {
    mark(id, action);
    try {
      return await fn();
    } finally {
      mark(id, null);
    }
  };

  const probe = async (s: FhirServer) => {
    try {
      const r = await run(s.fhir_server_id, "probe", () => fhirApi.probe(s.fhir_server_id));
      if (r.ok) notify.success(`${serverTitle(s)}：連線正常（${r.probe.latency_ms} ms）`, "探測完成");
      else notify.error(r.probe.message || "連線失敗", `${serverTitle(s)} 探測失敗`);
      return r;
    } catch (e) {
      notify.error(e, "探測失敗");
      return null;
    } finally {
      await invalidate();
    }
  };

  const setDefault = (s: FhirServer) => {
    if (!s.enabled) {
      notify.warn("請先啟用此伺服器，才能設為預設。");
      return;
    }
    confirmAction({
      title: `將「${serverTitle(s)}」設為預設伺服器？`,
      message: "MCP 工具（例如 crud_fhir_server）未指定 server_key 時，會改為連到這台伺服器。",
      consequences: [
        "原本的預設伺服器會被取消預設",
        ...(hasWriteOps(s) ? [<Text key="w" fz="sm" span>此伺服器允許 <b>寫入操作</b>，LLM 在 confirm_write=true 時可直接修改其資料</Text>] : []),
      ],
      confirmLabel: "設為預設",
      onConfirm: async () => {
        try {
          await run(s.fhir_server_id, "default", () => fhirApi.setDefault(s.fhir_server_id));
          notify.success(`已將「${serverTitle(s)}」設為預設伺服器`);
          await invalidate();
        } catch (e) {
          notify.error(e, "設定預設失敗");
          throw e;
        }
      },
    });
  };

  const toggleEnabled = (s: FhirServer) => {
    const doIt = async () => {
      const body: Record<string, unknown> = { enabled: !s.enabled };
      if (s.enabled && s.is_default) body.is_default = false;
      try {
        await run(s.fhir_server_id, "toggle", () => fhirApi.update(s.fhir_server_id, body));
        notify.success(s.enabled ? `已停用「${serverTitle(s)}」` : `已啟用「${serverTitle(s)}」`);
        await invalidate();
      } catch (e) {
        notify.error(e, s.enabled ? "停用失敗" : "啟用失敗");
        throw e;
      }
    };
    if (!s.enabled) {
      if (hasWriteOps(s)) {
        confirmAction({
          title: `啟用「${serverTitle(s)}」？`,
          message: "啟用後 MCP 工具即可使用這台伺服器。",
          consequences: [`此伺服器允許寫入操作（${s.allowed_operations.filter((o) => ["create", "update", "patch", "delete"].includes(o)).join(", ")}），LLM 在 confirm_write=true 時可修改外部臨床資料`],
          confirmLabel: "啟用",
          onConfirm: doIt,
        });
      } else void doIt().catch(() => undefined);
      return;
    }
    confirmAction({
      title: `停用「${serverTitle(s)}」？`,
      message: "設定會保留，之後可隨時重新啟用。",
      consequences: [
        "MCP 工具（list_fhir_servers / crud_fhir_server）將看不到也無法使用此伺服器",
        ...(s.is_default ? ["這是目前的預設伺服器：停用後將沒有預設伺服器，未指定 server_key 的呼叫會失敗"] : []),
      ],
      confirmLabel: "停用",
      danger: s.is_default,
      onConfirm: doIt,
    });
  };

  const remove = (s: FhirServer, after?: () => void) => {
    confirmAction({
      title: `刪除 FHIR 伺服器「${serverTitle(s)}」？`,
      message: "此動作無法復原。若之後還需要，請先使用「匯出」備份設定。",
      danger: true,
      typeToConfirm: s.server_key,
      consequences: [
        "設定、已加密的 client secret / 私鑰與 OAuth 權杖將一併刪除",
        "MCP 工具將無法再使用此伺服器",
        ...(s.is_default ? ["這是目前的預設伺服器：刪除後將沒有預設伺服器"] : []),
        ...(s.token_auth_method === "private_key_jwt" && s.auth_type === "oauth2_client_credentials"
          ? ["此伺服器的公開 JWKS 網址將失效，已向授權伺服器註冊的金鑰會無法驗證"]
          : []),
      ],
      confirmLabel: "永久刪除",
      onConfirm: async () => {
        try {
          await run(s.fhir_server_id, "delete", () => fhirApi.remove(s.fhir_server_id));
          notify.success(`已刪除「${serverTitle(s)}」`);
          after?.();
          await invalidate();
        } catch (e) {
          notify.error(e, "刪除失敗");
          throw e;
        }
      },
    });
  };

  return { pending, probe, setDefault, toggleEnabled, remove, invalidate };
}

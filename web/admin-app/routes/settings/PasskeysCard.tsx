// Passkeys (WebAuthn) management card on the Settings page.
//
// Lets the logged-in admin register the passkey of the current device
// (Touch ID / Face ID / security key) and remove existing ones. Registration
// runs the WebAuthn attestation ceremony via @simplewebauthn/browser against the
// backend routes in adminApp.ts. Only works over HTTPS on the RP domain (or
// localhost) — the button is disabled when the browser lacks WebAuthn support.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  startRegistration,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { api } from "../../lib/api";
import { toast } from "../../components/toast";

interface PasskeySummary {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

// Exported so a settings import — which can restore passkeys — can refresh this
// list without duplicating the key.
export const qkPasskeys = ["passkeys"] as const;

function defaultLabel(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iPhone|iPad|iPod/.test(ua)) return "iPhone / iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  return "This device";
}

function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function PasskeysCard(): JSX.Element {
  const qc = useQueryClient();
  const supported = useMemo(() => browserSupportsWebAuthn(), []);
  const [label, setLabel] = useState("");

  const list = useQuery({
    queryKey: qkPasskeys,
    queryFn: () => api.get<{ credentials: PasskeySummary[] }>("/admin/api/passkeys"),
    staleTime: 30_000,
  });

  const register = useMutation({
    mutationFn: async () => {
      // 1. Ask the server for attestation options (also sets the challenge cookie).
      const options = await api.post<PublicKeyCredentialCreationOptionsJSON>(
        "/admin/api/passkeys/register/options",
      );
      // 2. Run the browser ceremony (prompts Touch ID / Face ID / security key).
      const response = await startRegistration({ optionsJSON: options });
      // 3. Verify + persist on the server.
      await api.post("/admin/api/passkeys/register/verify", {
        response,
        label: label.trim() || defaultLabel(),
      });
    },
    onSuccess: () => {
      setLabel("");
      void qc.invalidateQueries({ queryKey: qkPasskeys });
      toast.success("Passkey registered");
    },
    onError: (err) => {
      // NotAllowedError = user dismissed / timed out — keep it quiet-ish.
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg.includes("NotAllowed") ? "Passkey registration cancelled" : `Registration failed: ${msg}`);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/admin/api/passkeys/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkPasskeys });
      toast.success("Passkey removed");
    },
    onError: (err) => toast.error(String(err)),
  });

  const credentials = list.data?.credentials ?? [];

  return (
    <div className="module-card">
      <div className="module-card__head">
        <div>
          <h3 className="subhead" style={{ margin: 0 }}>Passkeys</h3>
          <div className="muted small">
            Sign in with Touch ID, Face ID, or a security key — in addition to your password.
          </div>
        </div>
        <div className="head-actions">
          <input
            type="text"
            placeholder={defaultLabel()}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Passkey name"
            style={{ minWidth: "10rem" }}
          />
          <button
            type="button"
            className="btn"
            disabled={!supported || register.isPending}
            onClick={() => register.mutate()}
          >
            {register.isPending ? "Waiting…" : "Register this device"}
          </button>
        </div>
      </div>

      {!supported && (
        <div className="muted small">
          This browser does not support passkeys. Use a passkey-capable browser over HTTPS.
        </div>
      )}

      {list.isPending ? (
        <div className="muted small">Loading passkeys…</div>
      ) : credentials.length === 0 ? (
        <div className="muted small">No passkeys registered yet.</div>
      ) : (
        <ul className="passkey-list">
          {credentials.map((c) => (
            <li key={c.id} className="passkey-row">
              <div>
                <div>{c.label || "Passkey"}</div>
                <div className="muted small">
                  Added {fmt(c.created_at)} · Last used {fmt(c.last_used_at)}
                </div>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(c.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

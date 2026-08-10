"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import "@/admin-app/login.css";

export default function AdminLogin(): JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeySupported, setPasskeySupported] = useState(false);

  // Feature-detect on the client only (avoids SSR/hydration mismatch).
  useEffect(() => {
    setPasskeySupported(browserSupportsWebAuthn());
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/admin/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (r.ok && data.ok) {
        window.location.href = "/admin";
      } else {
        setError(data.error || "Invalid username or password.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPasskey(): Promise<void> {
    setPasskeyBusy(true);
    setError(null);
    try {
      const optRes = await fetch("/admin/api/passkeys/login/options", { method: "POST" });
      if (!optRes.ok) throw new Error("Could not start passkey sign-in.");
      const optionsJSON = (await optRes.json()) as PublicKeyCredentialRequestOptionsJSON;
      const assertion = await startAuthentication({ optionsJSON });
      const verifyRes = await fetch("/admin/api/passkeys/login/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(assertion),
      });
      const data = (await verifyRes.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (verifyRes.ok && data.ok) {
        window.location.href = "/admin";
      } else {
        setError(data.error || "Passkey sign-in failed.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // User dismissal is not an error worth shouting about.
      if (!msg.includes("NotAllowed")) setError(msg || "Passkey sign-in failed.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="login-logo" src="/admin/logo-h.png" alt="HealthyMind Tech" />
        <h1>Taiwan Health MCP — Admin</h1>
        <p className="login-sub">Sign in to continue</p>
        {error && <div className="login-error">{error}</div>}
        <label>
          <span>Username</span>
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {passkeySupported && (
          <button
            type="button"
            className="login-passkey"
            disabled={passkeyBusy}
            onClick={() => void signInWithPasskey()}
          >
            {passkeyBusy ? "Waiting for passkey…" : "Sign in with a passkey"}
          </button>
        )}
      </form>
    </div>
  );
}

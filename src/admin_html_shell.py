"""
Admin console — auth/session helpers, CSS, page frame HTML, and shared JS utilities.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import html
import json
from typing import Any

SESSION_COOKIE_NAME = "tw_health_admin_session"


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _escape(text: str) -> str:
    return html.escape(text, quote=True)


def verify_admin_password(password: str, stored_hash: str) -> bool:
    """Verify an admin password against a supported stored-hash format.

    Supported formats:
    - ``sha256$<hex_digest>``
    - ``pbkdf2_sha256$<iterations>$<salt>$<hex_digest>``
    """
    if not stored_hash:
        return False
    if stored_hash.startswith("sha256$"):
        expected = stored_hash.split("$", 1)[1].strip().lower()
        actual = hashlib.sha256(password.encode("utf-8")).hexdigest().lower()
        return hmac.compare_digest(actual, expected)
    if stored_hash.startswith("pbkdf2_sha256$"):
        parts = stored_hash.split("$", 3)
        if len(parts) != 4:
            return False
        _, iterations_text, salt, expected = parts
        try:
            iterations = int(iterations_text)
        except ValueError:
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt.encode("utf-8"),
            iterations,
        ).hex()
        return hmac.compare_digest(actual.lower(), expected.strip().lower())
    return False


def build_admin_session_token(
    username: str,
    secret: str,
    *,
    now: datetime | None = None,
    ttl_minutes: int = 240,
) -> str:
    """Build a signed admin session token."""
    now = now or datetime.now(timezone.utc)
    payload = {
        "u": username,
        "exp": int((now + timedelta(minutes=ttl_minutes)).timestamp()),
    }
    encoded = _b64url_encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    signature = hmac.new(
        secret.encode("utf-8"),
        encoded.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{encoded}.{signature}"


def parse_admin_session_token(
    token: str | None,
    secret: str,
    *,
    now: datetime | None = None,
) -> str | None:
    """Return the authenticated admin username if the token is valid."""
    if not token or "." not in token:
        return None
    encoded, signature = token.rsplit(".", 1)
    expected = hmac.new(
        secret.encode("utf-8"),
        encoded.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(_b64url_decode(encoded).decode("utf-8"))
    except Exception:
        return None
    exp = payload.get("exp")
    username = payload.get("u")
    if not isinstance(exp, int) or not isinstance(username, str):
        return None
    now = now or datetime.now(timezone.utc)
    if now.timestamp() >= exp:
        return None
    return username


def build_admin_session_cookie(token: str, *, max_age_seconds: int) -> str:
    """Return a Set-Cookie header value for the admin session."""
    return (
        f"{SESSION_COOKIE_NAME}={token}; Path=/admin; Max-Age={max_age_seconds}; "
        "HttpOnly; SameSite=Lax"
    )


def clear_admin_session_cookie() -> str:
    """Return a Set-Cookie header value that removes the admin session."""
    return f"{SESSION_COOKIE_NAME}=; Path=/admin; Max-Age=0; " "HttpOnly; SameSite=Lax"


@dataclass(frozen=True)
class AdminOverviewPayload:
    generated_at: str
    app: dict[str, Any]
    infrastructure: dict[str, Any]
    modules: dict[str, Any]
    services: dict[str, Any]
    jobs: dict[str, Any]
    workers: list[dict[str, Any]]
    summary: dict[str, Any]
    fhir_servers: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(
            {
                "generated_at": self.generated_at,
                "app": self.app,
                "infrastructure": self.infrastructure,
                "modules": self.modules,
                "services": self.services,
                "jobs": self.jobs,
                "workers": self.workers,
                "summary": self.summary,
                "fhir_servers": self.fhir_servers,
            },
            ensure_ascii=False,
        )


def brand_css() -> str:
    return """\
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #ffffff;
      --panel: #ffffff;
      --panel-soft: #f6f8fb;
      --line: #e5e7eb;
      --line-soft: #eef2f7;
      --text: #1a1a1a;
      --muted: #5b6470;
      --brand: #0066cc;
      --brand-soft: #e8f0fe;
      --ok-bg: #dcfce7;
      --ok-fg: #166534;
      --warn-bg: #fff8e6;
      --warn-fg: #9a6700;
      --bad-bg: #fee2e2;
      --bad-fg: #b91c1c;
      --shadow: 0 10px 28px rgba(15, 23, 42, 0.06);
      color-scheme: light;
    }
    /* Dark theme — set via <html data-theme="dark"> by the boot script. Override
       only, so light rendering and the legacy console are untouched. */
    [data-theme="dark"] {
      --bg: #0d1117;
      --panel: #161b22;
      --panel-soft: #1b212c;
      --line: #2b333f;
      --line-soft: #232a35;
      --text: #e6e9ef;
      --muted: #9aa4b2;
      --brand: #4d9fff;
      --brand-soft: #18283f;
      --ok-bg: #14331f;
      --ok-fg: #5fd58a;
      --warn-bg: #38300f;
      --warn-fg: #e9c264;
      --bad-bg: #3a1c1c;
      --bad-fg: #ff8f8f;
      --shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
      color-scheme: dark;
    }
    html { height: 100%; }
    body {
      min-height: 100%;
      font-family: system-ui, -apple-system, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top right, rgba(0, 102, 204, 0.08), transparent 28%),
        linear-gradient(180deg, #f9fbfe 0%, #ffffff 22%);
      line-height: 1.65;
    }
    [data-theme="dark"] body {
      background:
        radial-gradient(circle at top right, rgba(77, 159, 255, 0.10), transparent 30%),
        linear-gradient(180deg, #0d1117 0%, #0b0e14 60%);
    }
    [data-theme="dark"] .topbar { background: rgba(22, 27, 34, 0.9); }
    [data-theme="dark"] .login-card { background: linear-gradient(180deg, var(--panel) 0%, var(--panel-soft) 100%); }
    [data-theme="dark"] .field input { background: var(--panel-soft); }
    [data-theme="dark"] .error-box { background: var(--bad-bg); border-color: var(--bad-fg); color: var(--bad-fg); }
    a { color: var(--brand); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .topbar {
      position: sticky; top: 0; z-index: 20;
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,0.92);
      backdrop-filter: blur(10px);
    }
    .topbar-inner, .wrap {
      max-width: 1180px;
      margin: 0 auto;
      padding: 0 24px;
    }
    .topbar-inner {
      min-height: 68px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      flex-wrap: wrap;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .brand img { height: 36px; display: block; }
    .brand-copy { min-width: 0; }
    .brand-copy .kicker {
      display: block;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--brand);
    }
    .brand-copy h1 {
      font-size: 1.1rem;
      line-height: 1.2;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .topbar-nav {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 0.9rem;
    }
    .pill, .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 5px 11px;
      font-size: 0.78rem;
      font-weight: 600;
      border: 1px solid var(--line);
      background: var(--panel-soft);
      color: var(--muted);
      white-space: nowrap;
    }
    .status-pill.ok { background: var(--ok-bg); color: var(--ok-fg); border-color: #bbf7d0; }
    .status-pill.warn { background: var(--warn-bg); color: var(--warn-fg); border-color: #fde68a; }
    .status-pill.bad { background: var(--bad-bg); color: var(--bad-fg); border-color: #fecaca; }
    .shell { padding: 34px 0 48px; }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
      margin-bottom: 22px;
      flex-wrap: wrap;
    }
    .hero h2 {
      font-size: 2rem;
      line-height: 1.15;
      margin-bottom: 10px;
    }
    .hero p {
      max-width: 760px;
      color: var(--muted);
      font-size: 1rem;
    }
    .hero-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn, button.btn {
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 9px 14px;
      background: var(--panel);
      color: var(--text);
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      box-shadow: none;
    }
    .btn:hover, button.btn:hover { border-color: var(--brand); text-decoration: none; }
    .btn.primary, button.btn.primary {
      background: var(--brand);
      color: #fff;
      border-color: var(--brand);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 18px;
    }
    .card {
      grid-column: span 12;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
      padding: 18px 18px 16px;
    }
    .card.span-4 { grid-column: span 4; }
    .card.span-5 { grid-column: span 5; }
    .card.span-6 { grid-column: span 6; }
    .card.span-7 { grid-column: span 7; }
    .card.span-8 { grid-column: span 8; }
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 12px;
    }
    .card-head h3 {
      font-size: 0.98rem;
      font-weight: 700;
    }
    .card-head p {
      font-size: 0.82rem;
      color: var(--muted);
      margin-top: 3px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .metric {
      border: 1px solid var(--line-soft);
      border-radius: 12px;
      background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
      padding: 13px 14px;
      min-width: 0;
    }
    .metric .label {
      display: block;
      font-size: 0.76rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .metric .value {
      font-size: 1.35rem;
      font-weight: 700;
      line-height: 1.1;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .metric .meta {
      margin-top: 7px;
      font-size: 0.82rem;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th, td {
      border-bottom: 1px solid var(--line-soft);
      padding: 10px 6px;
      text-align: left;
      vertical-align: top;
    }
    th {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      font-weight: 700;
    }
    tr:last-child td { border-bottom: none; }
    .muted { color: var(--muted); }
    .small { font-size: 0.82rem; }
    .notice {
      border: 1px solid #c7ddff;
      background: #f5f9ff;
      color: #1d4f91;
      border-radius: 12px;
      padding: 14px 15px;
      font-size: 0.9rem;
    }
    .login-shell {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px;
    }
    .login-card {
      width: min(480px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: var(--shadow);
      padding: 24px 22px 22px;
    }
    .login-card .brand { margin-bottom: 18px; }
    .login-card h2 {
      font-size: 1.55rem;
      line-height: 1.15;
      margin-bottom: 8px;
    }
    .login-card p {
      color: var(--muted);
      font-size: 0.95rem;
      margin-bottom: 18px;
    }
    .field { margin-bottom: 14px; }
    .field label {
      display: block;
      font-size: 0.84rem;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .field input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 0.95rem;
      background: #fff;
    }
    .field input:focus {
      outline: none;
      border-color: var(--brand);
      box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.12);
    }
    .error-box {
      margin-bottom: 14px;
      border: 1px solid #fecaca;
      background: #fff1f2;
      color: var(--bad-fg);
      border-radius: 12px;
      padding: 12px 13px;
      font-size: 0.9rem;
    }
    .footnote {
      margin-top: 16px;
      font-size: 0.83rem;
      color: var(--muted);
    }
    @media (max-width: 980px) {
      .card.span-4, .card.span-5, .card.span-6, .card.span-7, .card.span-8 { grid-column: span 12; }
    }
    @media (max-width: 640px) {
      .topbar-inner, .wrap { padding: 0 16px; }
      .hero h2 { font-size: 1.55rem; }
      .metric-grid { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 480px) {
      .metric-grid { grid-template-columns: 1fr; }
    }
"""


def extra_css() -> str:
    """All additional CSS beyond brand_css."""
    return """\
    /* ── Drop zone ── */
    .drop-zone {
      border: 2px dashed var(--line);
      border-radius: 12px;
      padding: 22px 14px;
      text-align: center;
      cursor: pointer;
      background: #fafcff;
      color: var(--muted);
      font-size: 0.88rem;
      position: relative;
      transition: border-color 0.15s, background 0.15s;
      user-select: none;
    }
    .drop-zone:hover, .drop-zone.drag-over {
      border-color: var(--brand);
      background: #edf4ff;
      color: var(--brand);
    }
    .drop-zone input[type=file] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
      width: 100%;
      height: 100%;
    }
    .drop-zone-icon { font-size: 1.4rem; margin-bottom: 5px; }
    .drop-zone-hint { font-size: 0.8rem; line-height: 1.4; }
    .drop-zone-filename {
      display: none;
      font-weight: 600;
      color: var(--text);
      margin-top: 6px;
      font-size: 0.86rem;
      word-break: break-all;
    }
    .drop-zone-filename.visible { display: block; }
    .drop-zone.dz-locked {
      background: #f1f5f9;
      border-color: #cbd5e1;
      cursor: not-allowed;
      opacity: 0.68;
    }
    .drop-zone.dz-locked:hover, .drop-zone.dz-locked.drag-over {
      border-color: #cbd5e1;
      background: #f1f5f9;
      color: var(--muted);
    }
    .drop-zone.dz-locked input[type=file] { pointer-events: none; cursor: not-allowed; }
    /* ── Per-module import row ── */
    .import-module-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 0.9fr);
      gap: 20px;
      align-items: start;
      padding: 22px 0;
      border-bottom: 1px solid var(--line-soft);
    }
    .import-module-row:last-child { border-bottom: none; }
    .import-module-row > * { min-width: 0; }
    .import-row-meta .role-badge {
      display: inline-block;
      background: var(--brand-soft);
      color: var(--brand);
      border-radius: 6px;
      padding: 2px 7px;
      font-size: 0.74rem;
      font-weight: 700;
      margin-top: 5px;
    }
    .import-upload-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .import-upload-actions label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.84rem;
      color: var(--muted);
      cursor: pointer;
    }
    .upload-status-line {
      font-size: 0.82rem;
      margin-top: 7px;
      min-height: 1.1em;
      word-break: break-all;
      overflow-wrap: break-word;
    }
    .import-run-col { display: flex; flex-direction: column; gap: 10px; }
    /* ── Drug pipeline phase cards ── */
    .pipeline-phases {
      display: flex;
      flex-direction: column;
      gap: 0;
      margin-bottom: 24px;
    }
    .pipeline-phase-card {
      border: 1px solid var(--line-soft);
      border-radius: 12px;
      padding: 18px 20px;
      background: var(--surface);
      position: relative;
    }
    .pipeline-phase-card.phase-done { border-color: #bbf7d0; background: #f0fdf4; }
    .pipeline-phase-card.phase-running { border-color: #bfdbfe; background: #eff6ff; }
    .pipeline-phase-card.phase-error { border-color: #fecaca; background: #fef2f2; }
    .pipeline-phase-header {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 12px;
    }
    .phase-number {
      width: 30px; height: 30px;
      border-radius: 50%;
      background: var(--brand);
      color: #fff;
      font-size: 0.85rem;
      font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .phase-title { font-weight: 700; font-size: 0.97rem; }
    .phase-subtitle { font-size: 0.80rem; color: var(--muted); margin-top: 1px; }
    .pipeline-phase-metrics {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .pipeline-phase-metrics .metric { min-width: 90px; }
    .pipeline-phase-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .pipeline-connector {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px 0;
      color: var(--muted);
      font-size: 1.2rem;
    }
    /* ── Embedding module cards ── */
    .embed-module-card {
      border: 1px solid var(--line-soft);
      border-radius: 12px;
      padding: 16px;
      background: var(--surface);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .embed-module-card.embed-done { border-color: #bbf7d0; background: #f0fdf4; }
    .embed-module-card.embed-stale { border-color: #fed7aa; background: #fff7ed; }
    .embed-module-card.embed-partial { border-color: #fef08a; background: #fefce8; }
    .embed-module-card.embed-empty { border-color: var(--line-soft); }
    .embed-module-card.embed-running { border-color: #bfdbfe; background: #eff6ff; }
    .embed-progress-bar {
      height: 6px;
      border-radius: 4px;
      background: var(--line-soft);
      overflow: hidden;
    }
    .embed-progress-fill {
      height: 100%;
      border-radius: 4px;
      background: #22c55e;
      transition: width 0.3s ease;
    }
    .embed-progress-fill.partial { background: #eab308; }
    .ollama-config-card {
      border: 1px solid var(--line-soft);
      border-radius: 10px;
      padding: 14px 18px;
      display: flex;
      align-items: center;
      gap: 18px;
      flex-wrap: wrap;
      background: var(--surface);
    }
    .ollama-config-card.ollama-ok { border-color: #bbf7d0; background: #f0fdf4; }
    .ollama-config-card.ollama-warn { border-color: #fef08a; background: #fefce8; }
    .ollama-config-card.ollama-err { border-color: #fecaca; background: #fef2f2; }
    /* ── Confirm/warning overlay ── */
    .confirm-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 300;
      background: rgba(15, 23, 42, 0.5);
      backdrop-filter: blur(3px);
      align-items: center;
      justify-content: center;
    }
    .confirm-overlay.open { display: flex; }
    .confirm-modal {
      background: var(--surface);
      border-radius: 14px;
      border: 1px solid var(--line-soft);
      padding: 28px 32px;
      max-width: 480px;
      width: 92%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.18);
    }
    .confirm-modal h3 { margin: 0 0 10px; font-size: 1.05rem; }
    .confirm-modal p { color: var(--muted); font-size: 0.9rem; margin: 0 0 20px; line-height: 1.5; }
    .confirm-modal .confirm-actions { display: flex; gap: 10px; justify-content: flex-end; }
    /* ── Job detail overlay modal ── */
    .job-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 200;
      background: rgba(15, 23, 42, 0.42);
      backdrop-filter: blur(3px);
      padding: 24px 20px;
      overflow-y: auto;
    }
    .job-overlay.open { display: block; }
    .job-modal {
      width: min(880px, 100%);
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 28px 70px rgba(15, 23, 42, 0.22);
      padding: 26px 24px 24px;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 16px;
    }
    .modal-header-left h3 { font-size: 1.05rem; font-weight: 700; margin-bottom: 4px; }
    .modal-header-right { display: flex; gap: 8px; align-items: center; flex-shrink: 0; flex-wrap: wrap; }
    .modal-close {
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      cursor: pointer;
      font-size: 1rem;
      padding: 5px 12px;
      color: var(--muted);
      font-weight: 600;
    }
    .modal-close:hover { border-color: #fca5a5; color: var(--bad-fg); }
    .modal-tabs {
      display: flex;
      gap: 2px;
      border-bottom: 1px solid var(--line-soft);
      margin-bottom: 18px;
    }
    .modal-tab-btn {
      appearance: none;
      border: none;
      border-bottom: 2px solid transparent;
      background: none;
      cursor: pointer;
      font-size: 0.88rem;
      font-weight: 700;
      color: var(--muted);
      padding: 9px 16px;
      margin-bottom: -1px;
    }
    .modal-tab-btn:hover { color: var(--text); }
    .modal-tab-btn.active { color: var(--brand); border-bottom-color: var(--brand); }
    .modal-tab-panel { display: none; }
    .modal-tab-panel.active { display: block; }
    /* ── CLI-style log terminal ── */
    .log-list {
      max-height: 480px;
      overflow-y: auto;
      background: #0f1117;
      border-radius: 10px;
      padding: 14px 16px;
      font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
      font-size: 0.8rem;
      line-height: 1.65;
      color: #c9d1d9;
    }
    .log-line {
      display: flex;
      gap: 0;
      white-space: pre;
    }
    .log-line + .log-line { margin-top: 1px; }
    .ll-time { color: #6e7681; flex-shrink: 0; }
    .ll-level-info  { color: #58a6ff; font-weight: 700; flex-shrink: 0; }
    .ll-level-warn  { color: #d29922; font-weight: 700; flex-shrink: 0; }
    .ll-level-error { color: #f85149; font-weight: 700; flex-shrink: 0; }
    .ll-msg { color: #e6edf3; white-space: pre-wrap; word-break: break-all; }
    .ll-payload {
      display: block;
      color: #8b949e;
      white-space: pre-wrap;
      word-break: break-all;
      padding-left: 22ch;
    }
    .log-load-older {
      text-align: center;
      color: #6e7681;
      font-size: 0.75rem;
      padding: 6px 0 10px;
      cursor: pointer;
      user-select: none;
      border-bottom: 1px solid #21262d;
      margin-bottom: 6px;
    }
    .log-load-older:hover { color: #58a6ff; }
    .log-load-older.loading { color: #58a6ff; cursor: default; animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .step-list { display: flex; flex-direction: column; gap: 0; border: 1px solid var(--line-soft); border-radius: 10px; }
    .step-row {
      display: grid;
      grid-template-columns: 1fr auto 9rem;
      gap: 14px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--line-soft);
      align-items: start;
      font-size: 0.87rem;
    }
    .step-row:last-child { border-bottom: none; }
    @media (max-width: 760px) {
      .import-module-row { grid-template-columns: 1fr; }
      .log-entry { grid-template-columns: 1fr; gap: 3px; }
      .step-row { grid-template-columns: 1fr; }
    }
    .table-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .mini-btn {
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 10px;
      background: #fff;
      color: var(--text);
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
    }
    .mini-btn:hover { border-color: var(--brand); }
    .mini-btn[disabled] {
      cursor: default; opacity: 0.5; color: var(--muted);
      background: #f8fafc;
    }
    .mini-btn[disabled]:hover { border-color: var(--line); }
    .list-stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .source-item {
      border: 1px solid var(--line-soft);
      border-radius: 10px;
      background: #fbfdff;
      padding: 10px 11px;
    }
    .source-item.active { border-color: #86efac; background: #f0fdf4; }
    .source-item-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      margin-bottom: 3px;
    }
    .source-item strong {
      display: block;
      font-size: 0.87rem;
      word-break: break-all;
      overflow-wrap: break-word;
    }
    /* compact active-source status line in the import meta column */
    .src-status { margin-top: 10px; font-size: 0.84rem; font-weight: 700; }
    .src-status.ok { color: #166534; }
    .src-status.warn { color: #9a6700; }
    /* capped, scrollable unified Sources list (prevents page stretch) */
    .sources-scroll {
      max-height: 280px; overflow-y: auto; margin-top: 8px;
      padding-right: 3px;
    }
    .source-item .meta {
      font-size: 0.8rem;
      color: var(--muted);
      word-break: break-word;
    }
    .detail-tr { display: none; }
    .detail-tr.open { display: table-row; background: var(--panel-soft); }
    .detail-panel { padding: 14px 10px 10px; }
    .stages-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 5px;
      margin-bottom: 14px;
    }
    .stage-cell {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px solid var(--line-soft);
      background: #fff;
      font-size: 0.78rem;
    }
    .asset-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .asset-pill {
      display: inline-flex; align-items: center; gap: 5px;
      border: 1px solid var(--line); border-radius: 8px;
      padding: 5px 10px; font-size: 0.8rem; cursor: pointer;
      background: var(--panel); white-space: nowrap; text-decoration: none; color: var(--text);
    }
    .asset-pill:hover { border-color: var(--brand); }
    .pdf-preview-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.65); z-index: 2000;
      align-items: center; justify-content: center;
    }
    .pdf-preview-overlay.open { display: flex; }
    .pdf-preview-frame {
      background: white; border-radius: 14px;
      width: min(92vw, 1000px); height: 88vh;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 24px 80px rgba(0,0,0,0.4);
    }
    .pdf-preview-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-bottom: 1px solid var(--line);
      font-weight: 600; font-size: 0.9rem; gap: 12px; flex-shrink: 0;
    }
    .doc-preview-body { flex: 1; display: flex; min-height: 0; }
    .doc-preview-rendered {
      flex: 1; overflow: auto; padding: 20px 26px;
      background: #ffffff; color: #1e293b; font-size: 0.88rem; line-height: 1.6;
    }
    /* JSON colorized viewer */
    .doc-preview-rendered.json-view { background: #0f172a; padding: 0; }
    .doc-preview-rendered.json-view pre {
      margin: 0; padding: 18px 20px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.82rem; line-height: 1.55; color: #e2e8f0; white-space: pre; tab-size: 2;
    }
    .doc-preview-rendered.json-view .j-key  { color: #7dd3fc; }
    .doc-preview-rendered.json-view .j-str  { color: #86efac; }
    .doc-preview-rendered.json-view .j-num  { color: #fca5a5; }
    .doc-preview-rendered.json-view .j-bool { color: #fcd34d; }
    .doc-preview-rendered.json-view .j-null { color: #c4b5fd; font-style: italic; }
    /* plain text viewer */
    .doc-preview-rendered.text-view pre {
      margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.82rem; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
    }
    /* Markdown rendered viewer */
    .markdown-view h1, .markdown-view h2, .markdown-view h3,
    .markdown-view h4, .markdown-view h5, .markdown-view h6 {
      margin: 1.1em 0 0.5em; line-height: 1.25; font-weight: 700;
    }
    .markdown-view h1 { font-size: 1.5rem; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
    .markdown-view h2 { font-size: 1.25rem; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
    .markdown-view h3 { font-size: 1.1rem; }
    .markdown-view p { margin: 0.6em 0; }
    .markdown-view ul, .markdown-view ol { margin: 0.6em 0; padding-left: 1.6em; }
    .markdown-view li { margin: 0.2em 0; }
    .markdown-view code {
      background: #f1f5f9; border-radius: 4px; padding: 1px 5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em;
    }
    .markdown-view pre.md-code {
      background: #0f172a; color: #e2e8f0; border-radius: 8px;
      padding: 14px 16px; overflow: auto; margin: 0.8em 0;
    }
    .markdown-view pre.md-code code { background: none; padding: 0; color: inherit; font-size: 0.82rem; }
    .markdown-view blockquote {
      border-left: 3px solid var(--brand); margin: 0.7em 0; padding: 2px 14px;
      color: var(--muted); background: #f8fafc;
    }
    .markdown-view hr { border: none; border-top: 1px solid var(--line); margin: 1.2em 0; }
    .markdown-view a { color: var(--brand); }
    .markdown-view table.md-table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
    .markdown-view table.md-table th, .markdown-view table.md-table td {
      border: 1px solid var(--line); padding: 6px 10px; text-align: left; font-size: 0.85rem;
    }
    .markdown-view table.md-table th { background: #f1f5f9; font-weight: 600; }
    .markdown-view img.md-img {
      max-width: 100%; height: auto; display: block;
      margin: 0.8em 0; border: 1px solid var(--line); border-radius: 6px;
    }
    /* standalone image viewer */
    .doc-preview-rendered.image-view {
      display: flex; align-items: center; justify-content: center;
      background: #0f172a; padding: 20px;
    }
    .doc-preview-rendered.image-view img {
      max-width: 100%; max-height: 100%; object-fit: contain;
      border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,0.4);
    }
    /* Documents browser modal: file list (left) + preview (right) */
    .docs-modal-frame {
      background: white; border-radius: 14px;
      width: min(95vw, 1200px); height: 88vh;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 24px 80px rgba(0,0,0,0.4);
    }
    .docs-modal-body { flex: 1; display: flex; min-height: 0; }
    .docs-modal-list {
      width: 290px; flex-shrink: 0; overflow: auto;
      border-right: 1px solid var(--line); background: #f8fafc;
      padding: 8px;
    }
    .docs-list-item {
      display: flex; align-items: center; gap: 10px; width: 100%;
      text-align: left; padding: 9px 10px; border: 1px solid transparent;
      border-radius: 8px; background: none; cursor: pointer; margin-bottom: 2px;
      font-family: inherit; color: var(--text);
    }
    .docs-list-item:hover:not([disabled]) { background: #eef2f7; }
    .docs-list-item.active { background: #e0ecff; border-color: var(--brand); }
    .docs-list-item[disabled] { cursor: default; opacity: 0.55; }
    .docs-list-icon { font-size: 1.1rem; flex-shrink: 0; }
    .docs-list-meta { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
    .docs-list-name { font-size: 0.82rem; font-weight: 600; word-break: break-all; line-height: 1.3; }
    .docs-modal-preview { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .docs-modal-preview-bar {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line);
      flex-shrink: 0; font-size: 0.85rem; font-weight: 600;
    }
    #docsModalDocTitle { word-break: break-all; }
    .drug-filter-bar {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; margin: 10px 0 14px; flex-wrap: wrap;
    }
    .drug-filter-left { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .drug-filter-right { display: flex; align-items: center; gap: 8px; }
    .drug-search-input {
      border: 1px solid var(--line); border-radius: 8px;
      padding: 7px 12px; font-size: 0.88rem; width: 240px;
      background: var(--panel); color: var(--text);
    }
    .drug-search-input:focus { outline: none; border-color: var(--brand); }
    .drug-filter-label { display: flex; align-items: center; gap: 5px; font-size: 0.87rem; cursor: pointer; white-space: nowrap; }
    .drug-pagination-bar {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 10px 0 4px; flex-wrap: wrap;
    }
    .pagination-btns { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
    .page-btn {
      min-width: 32px; height: 32px; border: 1px solid var(--line); border-radius: 6px;
      background: var(--panel); color: var(--text); font-size: 0.83rem; font-weight: 600;
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0 6px;
    }
    .page-btn:hover:not(:disabled) { border-color: var(--brand); }
    .page-btn.active { background: var(--brand); color: #fff; border-color: var(--brand); }
    .page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    select.drug-per-page {
      border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px;
      font-size: 0.87rem; background: var(--panel); color: var(--text); cursor: pointer;
    }
    .upload-note { margin-bottom: 14px; }
    .admin-tabs {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 18px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.86);
      box-shadow: var(--shadow);
    }
    .tab-btn {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 999px;
      padding: 10px 14px;
      background: transparent;
      color: var(--muted);
      font-size: 0.92rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease;
    }
    .tab-btn:hover { background: var(--panel-soft); color: var(--text); }
    .tab-btn.active { background: var(--brand-soft); color: var(--brand); border-color: #c7ddff; }
    .tab-panel.hidden { display: none; }
    .tab-panel + .tab-panel { margin-top: 0; }
    /* ── Toast notifications ── */
    .toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 300;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .toast {
      background: var(--panel);
      border: 1px solid var(--line);
      border-left: 4px solid var(--brand);
      border-radius: 12px;
      padding: 12px 16px;
      box-shadow: 0 8px 24px rgba(15,23,42,0.12);
      font-size: 0.9rem;
      min-width: 260px;
      max-width: 380px;
      pointer-events: auto;
      animation: toastIn 0.2s ease;
    }
    .toast.toast-error { border-left-color: #b91c1c; color: #b91c1c; }
    .toast.toast-warn { border-left-color: #9a6700; color: #9a6700; }
    .toast.toast-ok { border-left-color: #166534; color: #166534; }
    .toast.toast-out { animation: toastOut 0.3s ease forwards; }
    @keyframes toastIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
    @keyframes toastOut { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(8px); } }
    /* ── Tab panel fade-in ── */
    @keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
    .tab-panel:not(.hidden) { animation: fadeIn 0.18s ease; }
    /* ── Button loading state ── */
    .btn.loading, button.btn.loading { pointer-events: none; opacity: 0.7; }
    /* ── Table row hover ── */
    tbody tr:hover { background: var(--panel-soft); }
    /* ── Mini progress bar in job table ── */
    .job-progress-bar {
      height: 6px;
      background: var(--line-soft);
      border-radius: 3px;
      overflow: hidden;
      min-width: 80px;
    }
    .job-progress-bar-fill {
      height: 100%;
      background: var(--brand);
      border-radius: 3px;
      transition: width 0.3s;
    }
    /* ── Code tag ── */
    code {
      font-family: ui-monospace, monospace;
      font-size: 0.87em;
      background: var(--panel-soft);
      padding: 1px 5px;
      border-radius: 4px;
    }
    /* ── Module sub-tabs ── */
    .module-subtab-bar {
      display: flex; gap: 6px; flex-wrap: wrap;
      margin-bottom: 20px; padding: 6px;
      border: 1px solid var(--line); border-radius: 12px;
      background: rgba(255,255,255,0.7);
    }
    .ds-tab-btn {
      appearance: none; border: 1px solid transparent;
      border-radius: 8px; padding: 8px 14px;
      background: transparent; color: var(--muted);
      font-size: 0.87rem; font-weight: 600; cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .ds-tab-btn:hover { background: var(--panel-soft); color: var(--text); }
    .ds-tab-btn.active { background: var(--brand-soft); color: var(--brand); border-color: #c7ddff; }
    .ds-tab-panel { display: none; }
    .ds-tab-panel.active { display: block; animation: fadeIn 0.15s ease; }
"""


def build_admin_login_html(*, error_message: str = "") -> str:
    """Build the admin login page HTML."""
    error_html = (
        f'<div class="error-box">{_escape(error_message)}</div>'
        if error_message
        else ""
    )
    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <meta name="color-scheme" content="light dark">
  <title>Admin Login – Taiwan Health MCP</title>
  <script>
    // Apply theme before paint (no flash). Shares the SPA's localStorage key
    // and falls back to the OS preference.
    (function () {{
      try {{
        var t = localStorage.getItem("admin-theme");
        if (t !== "light" && t !== "dark") {{
          t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        }}
        document.documentElement.dataset.theme = t;
      }} catch (e) {{
        document.documentElement.dataset.theme = "light";
      }}
    }})();
  </script>
  <style>
{brand_css()}
  </style>
</head>
<body>
  <div class="login-shell">
    <div class="login-card">
      <div class="brand">
        <img src="/logo-h.png" alt="HealthyMind Tech">
        <div class="brand-copy">
          <span class="kicker">Operations</span>
          <h1>Admin Console</h1>
        </div>
      </div>
      <h2>Sign in to manage the system</h2>
      <p>Use the protected operator account to access runtime status, module readiness, and future import controls.</p>
      {error_html}
      <form method="post" action="/admin/login">
        <div class="field">
          <label for="username">Username</label>
          <input id="username" name="username" type="text" autocomplete="username" required>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <button class="btn primary" type="submit">Sign In</button>
      </form>
      <div class="footnote">
        This admin surface is separate from the public MCP endpoint and is intended for operational use only.
      </div>
    </div>
  </div>
</body>
</html>
"""


def page_top_html(username: str, additional_css: str = "") -> str:
    """DOCTYPE through opening main/wrap div, includes brand + extra CSS."""
    extra_block = f"\n{additional_css}" if additional_css.strip() else ""
    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <title>Admin Console – Taiwan Health MCP</title>
  <style>
{brand_css()}
{extra_css()}{extra_block}
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <img src="/logo-h.png" alt="HealthyMind Tech">
        <div class="brand-copy">
          <span class="kicker">Operations</span>
          <h1>Admin Console</h1>
        </div>
      </div>
      <div class="topbar-nav">
        <span class="ws-indicator" title="Live updates status">
          <span id="wsStatusDot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;vertical-align:middle;transition:background 0.3s;"></span>
          <span id="wsStatusLabel" style="font-size:0.75rem;color:var(--muted);margin-left:4px;">Connecting…</span>
        </span>
        <span class="pill">Signed in as <strong>{_escape(username)}</strong></span>
        <a href="/">Home</a>
        <a href="/status">Status</a>
        <form method="post" action="/admin/logout" style="display:inline">
          <button class="btn" type="submit">Sign Out</button>
        </form>
      </div>
    </div>
  </header>

  <main class="shell">
    <div class="wrap">
      <section class="hero">
        <div>
          <h2>Operational overview</h2>
          <p>System status, services, modules, and task queue — all in one place.</p>
        </div>
        <div class="hero-actions">
          <a class="btn" href="/status">Open public status tester</a>
          <button class="btn primary" type="button" onclick="loadOverview()">Refresh overview</button>
        </div>
      </section>
"""


def tab_bar_html() -> str:
    """The 4-tab admin-tabs navigation bar."""
    return """\
      <div class="admin-tabs" role="tablist" aria-label="Admin navigation">
        <button id="tabBtn-overview" class="tab-btn active" type="button" onclick="showAdminTab('overview')">Overview</button>
        <button id="tabBtn-services" class="tab-btn" type="button" onclick="showAdminTab('services')">Services</button>
        <button id="tabBtn-tasks" class="tab-btn" type="button" onclick="showAdminTab('tasks')">Tasks</button>
        <button id="tabBtn-modules" class="tab-btn" type="button" onclick="showAdminTab('modules')">Modules</button>
        <button id="tabBtn-settings" class="tab-btn" type="button" onclick="showAdminTab('settings')">Settings</button>
      </div>
"""


def page_bottom_html() -> str:
    """Closes wrap/main, adds toast container. Modals follow this."""
    return """\
    </div>
    <div id="toastContainer" class="toast-container"></div>
  </main>
"""


def job_modal_html() -> str:
    """The job detail overlay modal (id=jobOverlay)."""
    return """\
  <!-- Job detail overlay modal -->
  <div id="jobOverlay" class="job-overlay" onclick="handleOverlayClick(event)">
    <div class="job-modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <div class="modal-header-left">
          <h3 id="modalJobTitle">Job Details</h3>
          <div id="modalJobMeta" class="muted small"></div>
        </div>
        <div class="modal-header-right">
          <span id="modalJobStatus" class="status-pill">—</span>
          <div id="modalJobActions" class="table-actions"></div>
          <button class="modal-close" type="button" onclick="closeJobModal()">✕ Close</button>
        </div>
      </div>
      <div id="modalJobProgress" style="margin-bottom:14px;display:none;">
        <div style="height:6px;background:var(--line-soft);border-radius:4px;overflow:hidden;">
          <div id="modalProgressBar" style="height:100%;background:var(--brand);border-radius:4px;transition:width 0.3s;width:0%"></div>
        </div>
        <div id="modalProgressLabel" class="muted small" style="margin-top:5px;"></div>
      </div>
      <div class="modal-tabs">
        <button class="modal-tab-btn active" type="button" onclick="showModalTab('details')">Details</button>
        <button class="modal-tab-btn" type="button" onclick="showModalTab('steps')">Steps</button>
        <button class="modal-tab-btn" type="button" onclick="showModalTab('logs')">
          Logs <span id="modalLogRefreshDot" style="display:none;color:var(--brand);">&#9679;</span>
        </button>
      </div>
      <div id="modalTabDetails" class="modal-tab-panel active">
        <div id="modalJobMetrics" class="metric-grid"></div>
      </div>
      <div id="modalTabSteps" class="modal-tab-panel">
        <div id="modalStepList" class="step-list">
          <div class="muted small" style="padding:12px;">Loading steps…</div>
        </div>
      </div>
      <div id="modalTabLogs" class="modal-tab-panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <span class="muted small">Most recent messages (newest last)</span>
          <button class="mini-btn" type="button" onclick="refreshModalLogs()">Refresh</button>
        </div>
        <div id="modalLogList" class="log-list">
          <span style="color:#6e7681;">Loading…</span>
        </div>
      </div>
    </div>
  </div>
"""


def shared_js_init(max_upload_mb: int) -> str:
    """JS constants and global state variables."""
    return f"""\
    const MAX_UPLOAD_MB = {max_upload_mb};
    const ADMIN_TABS = ['overview', 'services', 'tasks', 'modules', 'settings'];
    let sourceCatalog = [];
    let selectedJobId = '';
    let selectedJobStatus = '';
    let activeAdminTab = 'overview';
    let jobLogRefreshTimer = null;
    let overviewRefreshTimer = null;
    let logOldestId = null;
    let logHasMore = false;
    let logLoading = false;
    let logTabLoaded = false;
    const loadedTabs = new Set();
    const JOB_LOG_REFRESH_MS = 5000;
    const OVERVIEW_REFRESH_MS = 300000;
    let activeJobTypes = new Set();
    let _embedRefreshTimer = null;
    const EMBED_JOB_TYPES_SET = new Set([
      'icd_embed', 'loinc_embed', 'health_supplements_embed',
      'food_nutrition_embed', 'guideline_embed', 'snomed_embed',
    ]);
    let lastCompletedJobByType = {{}};
    const rowPendingFiles = new Map();
    let _ws = null;
    let _wsReconnectDelay = 1000;
    let _wsPingTimer = null;
    let _wsConnected = false;
"""


def utility_js() -> str:
    """Pure JS utility functions."""
    return """\
    // Global 401 handler: when the admin session expires, any /admin/api/ call
    // returns 401. Redirect to the login page instead of silently failing the
    // request (otherwise the console just shows stale data / broken actions).
    (function () {
      if (window.__adminFetchWrapped) return;
      window.__adminFetchWrapped = true;
      const _origFetch = window.fetch.bind(window);
      let _redirecting = false;
      window.fetch = async function (input, init) {
        const resp = await _origFetch(input, init);
        try {
          const url = (typeof input === 'string') ? input : ((input && input.url) || '');
          if (resp.status === 401 && url.indexOf('/admin/api/') !== -1 && !_redirecting) {
            _redirecting = true;
            window.location.href = '/admin/login';
          }
        } catch (e) { /* never let the guard break a real request */ }
        return resp;
      };
    })();

    function esc(v) {
      return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function showToast(message, tone = 'info') {
      const container = document.getElementById('toastContainer');
      if (!container) return;
      const toast = document.createElement('div');
      toast.className = 'toast' + (tone === 'error' ? ' toast-error' : tone === 'warn' ? ' toast-warn' : tone === 'ok' ? ' toast-ok' : '');
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => {
        toast.classList.add('toast-out');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
      }, 4000);
    }

    function setBtnLoading(btn, loading, loadingText = 'Loading…') {
      if (!btn) return;
      if (loading) {
        btn._prevText = btn.textContent;
        btn.textContent = loadingText;
        btn.classList.add('loading');
      } else {
        btn.textContent = btn._prevText || btn.textContent;
        btn.classList.remove('loading');
      }
    }

    function formatRelativeTime(isoString) {
      if (!isoString) return '—';
      const then = new Date(isoString);
      if (Number.isNaN(then.getTime())) return String(isoString).replace('T', ' ');
      const diffSec = Math.floor((Date.now() - then.getTime()) / 1000);
      if (diffSec < 5) return 'just now';
      if (diffSec < 60) return `${diffSec} sec ago`;
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hrs ago`;
      return `${Math.floor(diffSec / 86400)} days ago`;
    }

    function pillClass(status) {
      if (status === 'ok' || status === true) return 'status-pill ok';
      if (status === 'warn' || status === 'degraded' || status === 'disabled' || status === 'unknown') return 'status-pill warn';
      return 'status-pill bad';
    }

    function yn(v) { return v ? 'Yes' : 'No'; }

    function formatLatency(value) {
      if (value === null || value === undefined || value === '') return '—';
      return `${value} ms`;
    }

    function formatTimestamp(value) {
      if (!value) return '—';
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        return String(value).replace('T', ' ').replace('+00:00', ' UTC');
      }
      return parsed.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    }

    function metric(label, value, meta) {
      return `<div class="metric"><span class="label">${esc(label)}</span><div class="value">${esc(String(value))}</div><div class="meta">${esc(meta || '')}</div></div>`;
    }

    function setHtml(id, html) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    }

    function setNoticeState(notice, text, tone = 'info') {
      if (!notice) return;
      notice.className = 'notice upload-note';
      if (tone === 'error') {
        notice.style.borderColor = '#fecaca';
        notice.style.background = '#fff1f2';
        notice.style.color = '#b91c1c';
      } else if (tone === 'warn') {
        notice.style.borderColor = '#fde68a';
        notice.style.background = '#fff8e6';
        notice.style.color = '#9a6700';
      } else if (tone === 'ok') {
        notice.style.borderColor = '#bbf7d0';
        notice.style.background = '#f0fdf4';
        notice.style.color = '#166534';
      } else {
        notice.style.borderColor = '#c7ddff';
        notice.style.background = '#f5f9ff';
        notice.style.color = '#1d4f91';
      }
      notice.textContent = text;
    }

    function visibleNotice(preferredId) {
      return document.getElementById(preferredId) || document.getElementById('taskNotice');
    }

    function showModalTab(tabId) {
      activeModalTab = tabId;
      ['details', 'steps', 'logs'].forEach(t => {
        const panel = document.getElementById(`modalTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
        const btn = document.querySelector(`.modal-tab-btn[onclick="showModalTab('${t}')"]`);
        if (panel) panel.classList.toggle('active', t === tabId);
        if (btn) btn.classList.toggle('active', t === tabId);
      });
      if (tabId === 'logs' && !logTabLoaded && selectedJobId) {
        loadModalLogs();
      }
    }

    async function computeFileSha256(file) {
      const buffer = await file.arrayBuffer();
      const hashBuf = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function buildPageRange(current, total) {
      if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
      const pages = [1];
      if (current > 3) pages.push('…');
      for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
      if (current < total - 2) pages.push('…');
      pages.push(total);
      return pages;
    }

    function updateLogRefreshStatus() {
      const dot = document.getElementById('modalLogRefreshDot');
      if (!dot) return;
      const live = selectedJobId && ['running', 'queued', 'paused'].includes(selectedJobStatus);
      dot.style.display = live ? 'inline' : 'none';
    }

    function scheduleSelectedJobRefresh() {
      if (jobLogRefreshTimer) {
        clearInterval(jobLogRefreshTimer);
        jobLogRefreshTimer = null;
      }
      updateLogRefreshStatus();
      if (_wsConnected) return;
      const overlay = document.getElementById('jobOverlay');
      const isOpen = overlay && overlay.classList.contains('open');
      if (isOpen && selectedJobId && ['running', 'queued', 'paused'].includes(selectedJobStatus)) {
        jobLogRefreshTimer = setInterval(() => {
          loadJobDetail(selectedJobId, { quiet: true });
        }, JOB_LOG_REFRESH_MS);
      }
    }
"""


def websocket_js() -> str:
    """WebSocket client and event dispatcher."""
    return """\
    function wsConnect() {
      if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      _ws = new WebSocket(`${proto}//${location.host}/admin/ws`);

      _ws.onopen = () => {
        _wsConnected = true;
        _wsReconnectDelay = 1000;
        updateWsIndicator(true);
        _wsPingTimer = setInterval(() => {
          if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send('ping');
        }, 20000);
      };

      _ws.onclose = _ws.onerror = () => {
        _wsConnected = false;
        updateWsIndicator(false);
        clearInterval(_wsPingTimer);
        _wsPingTimer = null;
        _ws = null;
        setTimeout(wsConnect, _wsReconnectDelay);
        _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, 30000);
      };

      _ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch(e) { return; }
        wsDispatch(msg.type, msg.data || {});
      };
    }

    function updateWsIndicator(connected) {
      const dot = document.getElementById('wsStatusDot');
      const label = document.getElementById('wsStatusLabel');
      if (dot) {
        dot.style.background = connected ? '#22c55e' : '#ef4444';
        dot.title = connected ? 'Live updates connected' : 'Reconnecting…';
      }
      if (label) label.textContent = connected ? 'Live' : 'Reconnecting…';
    }

    function wsDispatch(type, data) {
      if (type === 'pong') return;
      if (type === 'job_status_changed') { wsOnJobStatusChanged(data); return; }
      if (type === 'job_log_line') { wsOnJobLogLine(data); return; }
      if (type === 'job_step_updated') { wsOnJobStepUpdated(data); return; }
      if (type === 'worker_heartbeat') { wsOnWorkerHeartbeat(data); return; }
    }

    function wsOnJobStatusChanged(data) {
      const {job_id, job_type, module_key, status, current_step,
             progress_current, progress_total, updated_at} = data;

      // ── 1. Update ALL matching job rows (Tasks tab + module sub-tab task section)
      const rows = document.querySelectorAll(`tr[data-job-id="${job_id}"]`);
      if (rows.length > 0) {
        rows.forEach(row => wsUpdateJobRow(row, data));
      } else if (loadedTabs.has('tasks')) {
        // New job not yet rendered in Tasks tab — trigger a full reload
        loadJobs();
      }

      // ── 2. Update open job modal if it's for this job
      if (job_id === selectedJobId) {
        wsUpdateModal(data);
      }

      // ── 3. Maintain activeJobTypes + lastCompletedJobByType
      const active = ['queued', 'running', 'paused'];
      if (active.includes(status)) {
        activeJobTypes.add(job_type);
      } else {
        activeJobTypes.delete(job_type);
        if (status === 'completed' || status === 'success') {
          if (!lastCompletedJobByType[job_type] || updated_at > lastCompletedJobByType[job_type]) {
            lastCompletedJobByType[job_type] = updated_at;
          }
        }
      }

      // ── 4. Update _allJobs in-memory + refresh module task section
      //    (wsUpdateJobInAllJobs is defined in modules_js, available at call-time)
      if (typeof wsUpdateJobInAllJobs === 'function') {
        wsUpdateJobInAllJobs(data);
      }

      // ── 5. Re-render module import section (run-button state changes)
      if (loadedTabs.has('modules') && sourceCatalog.length) {
        const dsKey = JOB_TYPE_TO_DS_KEY[job_type];
        if (dsKey && loadedModuleSubTabs.has(dsKey)) {
          refreshModuleImportSection(dsKey);
        }
      }

      wsUpdateOverviewJobCounts();

      // ── 6. Refresh Drug Pipeline on drug job changes
      const DRUG_JOB_TYPES = new Set(['drug_index_import', 'drug_enrichment', 'drug_analysis']);
      if (DRUG_JOB_TYPES.has(job_type) && loadedModuleSubTabs.has('drug')) {
        if (activeAdminTab === 'modules' && activeModuleSubTab === 'drug') {
          loadDrugPipeline();
        } else {
          loadDrugPipelineStatus();
        }
      }

      // ── 7. Refresh embed section on embed job changes
      //    Update in-memory cache or invalidate + refetch, avoiding unnecessary API calls.
      //    wsUpdateEmbedFromJob is defined in modules_js.
      if (EMBED_JOB_TYPES_SET.has(job_type)) {
        _syncEmbedRefreshTimer();
        if (typeof wsUpdateEmbedFromJob === 'function') {
          wsUpdateEmbedFromJob(job_type, status, progress_current || 0, progress_total || 0);
        }
      }

      // ── 8. Refresh embed section when a data-loading job FINISHES. Importing
      //    (icd/loinc/snomed/guideline) or syncing (health_supplements/food_nutrition)
      //    changes the source row counts, so the embed "total" goes from 0 → N.
      //    These jobs are not in EMBED_JOB_TYPES_SET, so without this the embed
      //    card stays stale ("No source data") and even its Refresh button
      //    reuses the cached status. Invalidate the cache so the next render
      //    (or open) refetches.
      const SYNC_JOB_TYPES = new Set([
        'health_supplements_sync', 'food_nutrition_sync',
        'icd_import', 'loinc_import', 'snomed_import', 'guideline_seed',
      ]);
      if (SYNC_JOB_TYPES.has(job_type) && !active.includes(status)) {
        if (typeof _embeddingStatus !== 'undefined') _embeddingStatus = null;
        const dsKey = JOB_TYPE_TO_DS_KEY[job_type];
        if (dsKey && loadedModuleSubTabs.has(dsKey)
            && activeAdminTab === 'modules' && activeModuleSubTab === dsKey
            && typeof loadModuleEmbed === 'function') {
          loadModuleEmbed(dsKey, true);
        }
      }
    }

    function wsUpdateJobRow(row, data) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 4) return;
      const fakeJob = {
        status: data.status, control_state: 'idle',
        job_id: data.job_id, job_type: data.job_type,
        module_key: data.module_key,
        progress_current: data.progress_current,
        progress_total: data.progress_total,
        current_step: data.current_step,
        created_at: '',
      };
      cells[2].innerHTML = jobStatusBadge(fakeJob);
      const pc = data.progress_current || 0;
      const pt = data.progress_total || 0;
      if (pt > 0) {
        const pct = Math.min(100, Math.round(pc / pt * 100));
        cells[3].innerHTML = `<div class="job-progress-bar"><div class="job-progress-bar-fill" style="width:${pct}%"></div></div><div class="muted small">${pc} / ${pt}</div><div class="muted small">${esc(data.current_step || '')}</div>`;
      } else {
        cells[3].innerHTML = `<span class="muted small">—</span><div class="muted small">${esc(data.current_step || '')}</div>`;
      }
      cells[5].innerHTML = renderJobActionButtons(fakeJob);
    }

    function wsUpdateModal(data) {
      const {status, progress_current, progress_total, current_step} = data;
      selectedJobStatus = status;
      updateLogRefreshStatus();

      const statusTone = status === 'success' ? 'ok'
        : (['running','queued','paused'].includes(status) ? 'degraded' : 'bad');
      const statusEl = document.getElementById('modalJobStatus');
      if (statusEl) {
        const prev = statusEl.textContent || '';
        const ctrlSuffix = prev.includes(' / ') ? prev.slice(prev.indexOf(' / ')) : '';
        statusEl.className = pillClass(statusTone);
        statusEl.textContent = status + ctrlSuffix;
      }

      const pc = progress_current || 0;
      const pt = progress_total || 0;
      const progBox = document.getElementById('modalJobProgress');
      if (progBox) {
        if (pt > 0) {
          const pct = Math.min(100, Math.round(pc / pt * 100));
          const bar = document.getElementById('modalProgressBar');
          const lbl = document.getElementById('modalProgressLabel');
          if (bar) bar.style.width = pct + '%';
          if (lbl) lbl.textContent = `${pc} / ${pt} — ${current_step || ''}`;
          progBox.style.display = 'block';
        } else if (current_step) {
          const lbl = document.getElementById('modalProgressLabel');
          if (lbl) lbl.textContent = current_step;
        }
      }

      const terminal = ['completed', 'success', 'partial_success',
                        'retryable_failed', 'permanent_failed', 'stopped', 'cancelled'];
      if (terminal.includes(status)) {
        loadJobDetail(selectedJobId);
      } else {
        scheduleSelectedJobRefresh();
      }
    }

    function wsUpdateOverviewJobCounts() {
      // Lightweight: keep existing values, full reload driven by interval
    }

    function wsOnJobLogLine(data) {
      if (!selectedJobId || data.job_id !== selectedJobId) return;
      if (!logTabLoaded) return;
      const container = document.getElementById('modalLogList');
      if (!container) return;
      const logEntry = {
        job_log_id: data.job_log_id || 0,
        level: data.level || 'info',
        message: data.message || '',
        payload: data.payload || {},
        created_at: data.timestamp || '',
      };
      if (!container.querySelector('.log-line')) container.innerHTML = '';
      container.insertAdjacentHTML('beforeend', renderLogLine(logEntry));
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
      if (atBottom) container.scrollTop = container.scrollHeight;
    }

    function wsOnJobStepUpdated(data) {
      if (!selectedJobId || data.job_id !== selectedJobId) return;
      const stepDiv = document.querySelector(`div[data-step-key="${CSS.escape(data.step_key)}"]`);
      if (!stepDiv) {
        loadJobDetail(selectedJobId, { silent: true });
        return;
      }
      const statusCell = stepDiv.querySelector('.step-status-cell');
      if (statusCell) {
        const fakeStep = { status: data.status };
        statusCell.innerHTML = jobStatusBadge(fakeStep);
      }
      const progressCell = stepDiv.querySelector('.step-progress-cell');
      if (progressCell && data.progress_total > 0) {
        progressCell.textContent = `${data.progress_current} / ${data.progress_total}`;
      }
    }

    function wsOnWorkerHeartbeat(data) {
      const row = document.querySelector(`tr[data-worker="${CSS.escape(data.worker_name)}"]`);
      if (!row) return;
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        cells[1].textContent = data.status || '';
        cells[2].textContent = formatRelativeTime(data.last_heartbeat_at);
        cells[2].module.ts = data.last_heartbeat_at || '';
      }
    }

    wsConnect();
"""


def tab_switcher_js() -> str:
    """showAdminTab, loadTabData, _syncEmbedRefreshTimer, interval ticks, ESC handler."""
    return """\
    function _syncEmbedRefreshTimer() {
      const anyRunning = [...activeJobTypes].some(t => EMBED_JOB_TYPES_SET.has(t));
      if (anyRunning && !_embedRefreshTimer) {
        // Poll every 5 s while any embed job is active.
        // The primary real-time path is wsUpdateEmbedFromJob() which fires on every
        // WS job_status_changed event.  This timer is a fallback that also invalidates
        // the embedding status cache for sub-tabs that are NOT currently visible, so
        // that switching to them shows fresh data.
        _embedRefreshTimer = setInterval(() => {
          if (!loadedTabs.has('modules')) return;

          // Find which embed jobs are currently running
          const runningEmbedKeys = [...activeJobTypes]
            .filter(t => EMBED_JOB_TYPES_SET.has(t))
            .map(t => t.replace('_embed', ''));

          for (const dsKey of runningEmbedKeys) {
            if (!loadedModuleSubTabs.has(dsKey)) continue;
            if (['ig'].includes(dsKey)) continue; // no embed

            if (activeAdminTab === 'modules' && activeModuleSubTab === dsKey) {
              // Visible — do a live API refresh to get accurate counts
              loadModuleEmbed(dsKey);
            } else {
              // Not visible — just invalidate the cache so it re-fetches when user visits
              if (typeof _embeddingStatus !== 'undefined') _embeddingStatus = null;
            }
          }
        }, 5000);
      } else if (!anyRunning && _embedRefreshTimer) {
        clearInterval(_embedRefreshTimer);
        _embedRefreshTimer = null;
      }
    }

    async function showAdminTab(tabId, forceReload = false) {
      activeAdminTab = tabId;
      ADMIN_TABS.forEach(name => {
        const panel = document.getElementById(`tab-${name}`);
        const button = document.getElementById(`tabBtn-${name}`);
        const active = name === tabId;
        if (panel) panel.classList.toggle('hidden', !active);
        if (button) button.classList.toggle('active', active);
      });
      if (forceReload || !loadedTabs.has(tabId)) {
        await loadTabData(tabId);
        loadedTabs.add(tabId);
      }
      if (overviewRefreshTimer) {
        clearInterval(overviewRefreshTimer);
        overviewRefreshTimer = null;
      }
      if (tabId === 'overview') {
        overviewRefreshTimer = setInterval(() => {
          if (activeAdminTab === 'overview') loadOverview();
        }, OVERVIEW_REFRESH_MS);
      }
      scheduleSelectedJobRefresh();
    }

    async function loadTabData(tabId) {
      if (tabId === 'overview') { await loadOverview(); return; }
      if (tabId === 'services') { await Promise.all([loadOverview(), loadServiceProbes()]); return; }
      if (tabId === 'tasks') { await Promise.all([loadOverview(), loadJobs()]); return; }
      if (tabId === 'modules') { await loadModulesTab(); }
      if (tabId === 'settings') { await loadSettings(); }
    }

    // Tick all relative timestamps every 5 seconds
    setInterval(() => {
      document.querySelectorAll('[data-ts]').forEach(el => {
        const ts = el.module.ts;
        if (ts) el.textContent = formatRelativeTime(ts);
      });
    }, 5000);

    // Escape key closes any open modal/overlay
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const jobOverlay = document.getElementById('jobOverlay');
        if (jobOverlay && jobOverlay.classList.contains('open')) { closeJobModal(); return; }
        const warnOverlay = document.getElementById('enrichmentWarnOverlay');
        if (warnOverlay && warnOverlay.classList.contains('open')) {
          warnOverlay.classList.remove('open'); return;
        }
        const pdfOverlay = document.getElementById('pdfPreviewOverlay');
        if (pdfOverlay && pdfOverlay.classList.contains('open')) { closePdfPreview(); return; }
        const schedOverlay = document.getElementById('scheduleModal');
        if (schedOverlay && schedOverlay.classList.contains('open')) { closeScheduleModal(); return; }
      }
    });
"""


def job_modal_js() -> str:
    """All job modal JS functions."""
    return """\
    let activeModalTab = 'details';

    async function openJobLogs(jobId) { await openJobModal(jobId); }

    async function refreshSelectedJobLogs() {
      if (selectedJobId) await loadJobDetail(selectedJobId);
    }

    async function openJobModal(jobId) {
      selectedJobId = jobId;
      const overlay = document.getElementById('jobOverlay');
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
      showModalTab('details');
      setHtml('modalJobMetrics', '');
      setHtml('modalStepList', '<div class="muted small" style="padding:12px;">Loading…</div>');
      setHtml('modalLogList', '<span style="color:#6e7681;">Click the Logs tab to load log entries.</span>');
      document.getElementById('modalJobTitle').textContent = 'Loading…';
      document.getElementById('modalJobMeta').textContent = '';
      document.getElementById('modalJobStatus').className = 'status-pill';
      document.getElementById('modalJobStatus').textContent = '…';
      document.getElementById('modalJobActions').innerHTML = '';
      await loadJobDetail(jobId);
    }

    function closeJobModal() {
      const overlay = document.getElementById('jobOverlay');
      overlay.classList.remove('open');
      document.body.style.overflow = '';
      if (jobLogRefreshTimer) { clearInterval(jobLogRefreshTimer); jobLogRefreshTimer = null; }
    }

    function handleOverlayClick(event) {
      if (event.target === document.getElementById('jobOverlay')) closeJobModal();
    }

    async function refreshModalLogs() {
      if (selectedJobId) await loadModalLogs();
    }

    async function loadModalLogs() {
      if (!selectedJobId) return;
      const container = document.getElementById('modalLogList');
      if (!container) return;

      logOldestId = null;
      logHasMore = false;
      logLoading = false;
      logTabLoaded = false;
      container.innerHTML = '<span style="color:#6e7681;">Loading…</span>';

      try {
        const res = await fetch(
          `/admin/api/jobs/${encodeURIComponent(selectedJobId)}/logs?limit=50`,
          { credentials: 'same-origin' }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const logs = data.logs || [];

        logOldestId = logs.length > 0 ? logs[0].job_log_id : null;
        logHasMore = logs.length >= 50;
        logTabLoaded = true;

        const sentinelHtml = logHasMore
          ? `<div id="logLoadOlderSentinel" class="log-load-older" onclick="loadOlderLogs()">↑ Scroll up or click to load older entries</div>`
          : '';
        container.innerHTML = sentinelHtml + (
          logs.length > 0
            ? logs.map(renderLogLine).join('')
            : '<span style="color:#6e7681;">No log records.</span>'
        );
        container.scrollTop = container.scrollHeight;

        if (!container._paginationListenerAttached) {
          container._paginationListenerAttached = true;
          container.addEventListener('scroll', () => {
            if (container.scrollTop < 80 && logHasMore && !logLoading) loadOlderLogs();
          });
        }
      } catch (err) {
        logTabLoaded = false;
        if (container) container.innerHTML =
          `<span style="color:#b91c1c;">Failed to load logs: ${esc(err.message)}</span>`;
      }
    }

    function renderLogLine(log) {
      const lvl = (log.level || 'info').toLowerCase();
      const lvlClass = lvl === 'error' ? 'll-level-error' : lvl === 'warn' ? 'll-level-warn' : 'll-level-info';
      const ts = log.created_at
        ? new Date(log.created_at).toLocaleTimeString(undefined, { hour12: false })
        : '        ';
      const lvlPad = lvl.toUpperCase().padEnd(5);
      let html = `<div class="log-line"><span class="ll-time">${esc(ts)}  </span><span class="${lvlClass}">${esc(lvlPad)}  </span><span class="ll-msg">${esc(log.message || '')}</span></div>`;
      if (log.payload && Object.keys(log.payload).length) {
        const pairs = Object.entries(log.payload)
          .map(([k, v]) => `${esc(k)}=${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}`)
          .join('  ');
        html += `<span class="ll-payload">${pairs}</span>`;
      }
      return html;
    }

    async function loadOlderLogs() {
      if (!logOldestId || !selectedJobId || logLoading || !logHasMore) return;
      logLoading = true;
      const container = document.getElementById('modalLogList');
      const sentinel = document.getElementById('logLoadOlderSentinel');
      if (sentinel) sentinel.classList.add('loading');
      try {
        const res = await fetch(
          `/admin/api/jobs/${encodeURIComponent(selectedJobId)}/logs?before_id=${logOldestId}&limit=50`,
          { credentials: 'same-origin' }
        );
        if (!res.ok) return;
        const data = await res.json();
        const olderLogs = data.logs || [];
        if (olderLogs.length === 0) {
          logHasMore = false;
          if (sentinel) sentinel.remove();
          return;
        }
        logOldestId = olderLogs[0].job_log_id;
        logHasMore = olderLogs.length >= 50;

        const prevScrollHeight = container.scrollHeight;
        const newHtml = olderLogs.map(renderLogLine).join('');
        if (sentinel) {
          sentinel.insertAdjacentHTML('afterend', newHtml);
          if (!logHasMore) sentinel.remove();
          else sentinel.classList.remove('loading');
        }
        container.scrollTop += container.scrollHeight - prevScrollHeight;
      } catch (_) {
        if (sentinel) sentinel.classList.remove('loading');
      } finally {
        logLoading = false;
      }
    }

    async function loadJobDetail(jobId, options = {}) {
      selectedJobId = jobId;
      try {
        const [jobResponse, stepsResponse] = await Promise.all([
          fetch(`/admin/api/jobs/${encodeURIComponent(jobId)}`, { credentials: 'same-origin' }),
          fetch(`/admin/api/jobs/${encodeURIComponent(jobId)}/steps`, { credentials: 'same-origin' }),
        ]);
        if (!jobResponse.ok) throw new Error(`Job HTTP ${jobResponse.status}`);
        const jobPayload = await jobResponse.json();
        const stepsPayload = stepsResponse.ok ? await stepsResponse.json() : { steps: [] };
        const job = jobPayload.job || {};
        const steps = stepsPayload.steps || [];
        selectedJobStatus = job.status || '';
        logTabLoaded = false; logOldestId = null; logHasMore = false; logLoading = false;
        if (activeModalTab === 'logs') loadModalLogs();

        const statusTone = job.status === 'success' ? 'ok'
          : (['running','queued','paused'].includes(job.status) ? 'degraded' : 'bad');
        document.getElementById('modalJobTitle').textContent =
          `${job.job_type || 'Job'} · ${(job.job_id || '').slice(0,8)}…`;
        document.getElementById('modalJobMeta').textContent =
          `${job.module_key || ''}  ·  created ${formatTimestamp(job.created_at)}`;
        const statusEl = document.getElementById('modalJobStatus');
        statusEl.className = pillClass(statusTone);
        statusEl.textContent = job.status + (job.control_state && job.control_state !== 'idle' ? ' / ' + job.control_state : '');

        const actions = job.available_actions || [];
        setHtml('modalJobActions', actions.map(action => `
          <button class="mini-btn" type="button" onclick="controlJobFromModal('${esc(job.job_id)}','${esc(action)}')">${esc(action)}</button>
        `).join(''));

        const progBox = document.getElementById('modalJobProgress');
        const progTotal = job.progress_total || 0;
        if (progTotal > 0) {
          const pct = Math.min(100, Math.round((job.progress_current || 0) / progTotal * 100));
          document.getElementById('modalProgressBar').style.width = pct + '%';
          document.getElementById('modalProgressLabel').textContent =
            `${job.progress_current || 0} / ${progTotal} — ${esc(job.current_step || '')}`;
          progBox.style.display = 'block';
        } else {
          progBox.style.display = 'none';
        }

        setHtml('modalJobMetrics', [
          metric('Job ID', job.job_id || '—', job.job_type || ''),
          metric('Module', job.module_key || '—', 'by ' + (job.requested_by || '—')),
          metric('Worker', job.worker_name || '—', job.started_at ? 'started ' + formatTimestamp(job.started_at) : 'not started'),
          metric('Finished', job.finished_at ? formatTimestamp(job.finished_at) : '—', job.last_error_code || ''),
          metric('Error', job.last_error_message || '—', ''),
          metric('Step', job.current_step || '—', ''),
        ].join(''));

        const stepRows = steps.map(step => `
          <div class="step-row" data-step-key="${esc(step.step_key || '')}">
            <div>
              <strong>${esc(step.step_key || '')}</strong>
              <div class="muted small">${formatTimestamp(step.started_at)}</div>
            </div>
            <div class="step-status-cell">${jobStatusBadge(step)}</div>
            <div class="step-progress-cell muted small" style="text-align:right;">
              ${step.progress_current || 0} / ${step.progress_total || 0}
            </div>
          </div>
        `).join('');
        setHtml('modalStepList', stepRows || '<div class="muted small" style="padding:12px;">No step records.</div>');
        scheduleSelectedJobRefresh();
      } catch (error) {
        selectedJobStatus = '';
        document.getElementById('modalJobTitle').textContent = 'Load failed';
        document.getElementById('modalJobStatus').className = 'status-pill bad';
        document.getElementById('modalJobStatus').textContent = 'error';
        setHtml('modalJobMetrics', `<div class="muted small">Failed: ${esc(error.message)}</div>`);
        scheduleSelectedJobRefresh();
      }
    }

    async function controlJobFromModal(jobId, action) {
      const btn = event?.currentTarget;
      setBtnLoading(btn, true);
      try {
        const response = await fetch(`/admin/api/jobs/${encodeURIComponent(jobId)}/${encodeURIComponent(action)}`, {
          method: 'POST', credentials: 'same-origin',
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        const restartJob = payload.restart_job;
        await loadJobs();
        if (restartJob) {
          await openJobModal(restartJob.job_id);
        } else {
          await loadJobDetail(jobId);
        }
        showToast(`Action "${action}" applied.`, 'ok');
      } catch (error) {
        showToast(`Control action failed: ${error.message}`, 'error');
      } finally {
        setBtnLoading(btn, false);
      }
    }
"""

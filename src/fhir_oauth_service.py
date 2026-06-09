"""OAuth2 Authorization Code (+ PKCE) flow for external FHIR servers.

The client_credentials flow in ``fhir_server_service`` represents this MCP
server's own identity and is fetched per call. Authorization Code is different:
a human logs in at the external authorization server through the browser, and the
resulting access + refresh token pair represents an end-user delegation that is
stored (encrypted) and refreshed over time.

This module owns that flow end to end:
  * ``begin_authorization``  — generate PKCE + state, persist pending state,
                               return the authorize URL the browser is sent to.
  * ``complete_authorization`` — validate the callback ``state``, exchange the
                               code (+ verifier) for tokens, store them.
  * ``get_valid_user_access_token`` — return a usable access token, lazily
                               refreshing (single-flight) when expired.
  * ``clear_oauth_state``    — wipe all stored tokens/state for a server.
  * ``get_oauth_status`` / ``attach_oauth_status`` — surface readiness to the UI.
  * ``sweep_expiring_tokens`` — proactive background renewal (admin-worker).

PKCE is mandatory (S256). Tokens are encrypted with pgp_sym_encrypt under the
same key as ``client_secret_ciphertext``.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx

import fhir_server_service as fss
from database import PoolLike

# PKCE / state.
CODE_VERIFIER_BYTES = 64  # → 86-char base64url verifier (within RFC 7636 43–128)
CODE_CHALLENGE_METHOD = "S256"  # S256 only; SMART forbids `plain`, IUA requires PKCE
PENDING_STATE_TTL_SECONDS = 600  # 10 min to complete the interactive browser login

# Token lifecycle.
ACCESS_REFRESH_SKEW_SECONDS = fss.TOKEN_CACHE_SKEW_SECONDS  # refresh this early
# Proactively rotate the refresh token when it is within this window of expiry.
REFRESH_TOKEN_RENEW_SKEW_SECONDS = 86_400  # 1 day


class OAuthError(ValueError):
    """Base class — a ValueError so callers' `except ValueError` surfaces the text."""


class OAuthNotAuthorizedError(OAuthError):
    """The server has no usable stored grant; an operator must click Authorize."""


class OAuthRefreshFailedError(OAuthError):
    """The refresh token was rejected; re-authorization is required."""


# ── PKCE helpers ──────────────────────────────────────────────────────────────


def generate_pkce_pair() -> tuple[str, str]:
    """Return ``(code_verifier, code_challenge)`` using the S256 method."""
    verifier = (
        base64.urlsafe_b64encode(secrets.token_bytes(CODE_VERIFIER_BYTES))
        .rstrip(b"=")
        .decode("ascii")
    )
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def generate_state_nonce() -> str:
    return secrets.token_urlsafe(32)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── discovery / endpoint resolution ─────────────────────────────────────────────


async def _discover(server: dict[str, Any]) -> dict[str, Any]:
    if server.get("use_metadata") and (
        server.get("metadata_url") or server.get("auth_server_url")
    ):
        try:
            return await fss._fetch_metadata(server)
        except Exception:
            return {}
    return {}


def _resolve_authorization_endpoint(
    server: dict[str, Any], metadata: dict[str, Any]
) -> str:
    return str(
        server.get("authorization_endpoint")
        or metadata.get("authorization_endpoint")
        or ""
    )


def _resolve_token_endpoint(server: dict[str, Any], metadata: dict[str, Any]) -> str:
    return str(
        server.get("token_endpoint")
        or metadata.get("token_endpoint")
        or fss._derive_token_endpoint(server.get("auth_server_url") or "", "")
    )


def _scope_for_authorize(server: dict[str, Any]) -> str:
    """Build the requested scope. SMART needs ``offline_access`` for a refresh token."""
    scopes = [s for s in str(server.get("scope") or "").split() if s]
    if (
        server.get("auth_profile") == fss.AUTH_PROFILE_SMART
        and "offline_access" not in scopes
    ):
        scopes.append("offline_access")
    return " ".join(scopes)


# ── token endpoint POST (exchange / refresh) ────────────────────────────────────


async def _post_token(
    server: dict[str, Any], token_endpoint: str, form: dict[str, str]
) -> dict[str, Any]:
    """POST an OAuth2 token request and return the parsed JSON payload.

    Applies the server's client authentication via the shared
    ``fhir_server_service.apply_client_auth`` (Basic for confidential clients,
    client_id-in-body for public clients).
    """
    headers = {"Accept": "application/json"}
    headers.update(
        fss._parse_headers(server.get("token_headers_json"), allow_authorization=False)
    )
    basic_auth = fss.apply_client_auth(server, form, token_endpoint)
    async with httpx.AsyncClient(
        timeout=float(server["timeout_seconds"]),
        verify=bool(server["verify_tls"]),
    ) as client:
        response = await client.post(
            token_endpoint, data=form, headers=headers, auth=basic_auth
        )
    if response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(
            f"Token endpoint returned HTTP {response.status_code}: "
            f"{response.text[:500]}"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError("Token endpoint returned non-JSON response") from exc
    if not isinstance(payload, dict) or not payload.get("access_token"):
        raise RuntimeError("Token response is missing access_token")
    return payload


def _expiry_from(payload: dict[str, Any], key: str) -> datetime | None:
    raw = payload.get(key)
    if raw in (None, ""):
        return None
    try:
        seconds = int(raw)
    except (TypeError, ValueError):
        return None
    # A non-positive lifetime means "no expiry / not applicable" rather than
    # "expires now" — Keycloak, for example, returns refresh_expires_in: 0 for
    # client_credentials and for non-expiring offline refresh tokens.
    if seconds <= 0:
        return None
    return _now() + timedelta(seconds=max(1, seconds - ACCESS_REFRESH_SKEW_SECONDS))


# ── persistence helpers ─────────────────────────────────────────────────────────

_TOKEN_ROW_SELECT = """
    SELECT fhir_server_id, admin_user, state_nonce, code_verifier, redirect_uri,
           requested_scope, pending_created_at,
           (access_token_ciphertext IS NOT NULL) AS has_access,
           (refresh_token_ciphertext IS NOT NULL) AS has_refresh,
           CASE WHEN access_token_ciphertext IS NULL THEN NULL
                ELSE pgp_sym_decrypt(access_token_ciphertext, $2) END AS access_token,
           CASE WHEN refresh_token_ciphertext IS NULL THEN NULL
                ELSE pgp_sym_decrypt(refresh_token_ciphertext, $2) END AS refresh_token,
           token_type, granted_scope,
           access_token_expires_at, refresh_token_expires_at, obtained_at
    FROM admin.fhir_server_oauth_tokens
"""


async def _load_active_token_row(
    conn, fhir_server_id: str, secret_key: str
) -> Any | None:
    """Return the active (token-bearing) row for a server, or None."""
    return await conn.fetchrow(
        _TOKEN_ROW_SELECT
        + """
        WHERE fhir_server_id = $1::uuid AND access_token_ciphertext IS NOT NULL
        ORDER BY obtained_at DESC NULLS LAST
        LIMIT 1
        """,
        fhir_server_id,
        secret_key,
    )


async def _store_tokens(
    conn,
    fhir_server_id: str,
    admin_user: str,
    payload: dict[str, Any],
    *,
    secret_key: str,
    fallback_scope: str = "",
    keep_refresh_if_absent: bool = False,
    current_refresh: str | None = None,
) -> None:
    """Encrypt and persist a token response, clearing pending PKCE state.

    When the refresh response omits ``refresh_token`` and
    ``keep_refresh_if_absent`` is set, the current refresh token is retained
    (some servers do not rotate refresh tokens on every use).
    """
    access_token = str(payload["access_token"])
    refresh_token = payload.get("refresh_token")
    if not refresh_token and keep_refresh_if_absent:
        refresh_token = current_refresh
    token_type = str(payload.get("token_type") or "Bearer")
    granted_scope = str(payload.get("scope") or fallback_scope or "")
    access_expires = _expiry_from(payload, "expires_in")
    refresh_expires = _expiry_from(payload, "refresh_expires_in")

    await conn.execute(
        """
        INSERT INTO admin.fhir_server_oauth_tokens AS t (
            fhir_server_id, admin_user,
            access_token_ciphertext, refresh_token_ciphertext,
            token_type, granted_scope,
            access_token_expires_at, refresh_token_expires_at,
            obtained_at, updated_at,
            state_nonce, code_verifier, redirect_uri, pending_created_at
        )
        VALUES (
            $1::uuid, $2,
            pgp_sym_encrypt($3, $9),
            CASE WHEN $4::text IS NULL OR $4 = '' THEN NULL
                 ELSE pgp_sym_encrypt($4, $9) END,
            $5, $6, $7, $8, NOW(), NOW(),
            NULL, NULL, NULL, NULL
        )
        ON CONFLICT (fhir_server_id, admin_user) DO UPDATE SET
            access_token_ciphertext = pgp_sym_encrypt($3, $9),
            refresh_token_ciphertext = CASE
                WHEN $4::text IS NULL OR $4 = '' THEN NULL
                ELSE pgp_sym_encrypt($4, $9) END,
            token_type = $5,
            granted_scope = $6,
            access_token_expires_at = $7,
            refresh_token_expires_at = $8,
            obtained_at = NOW(),
            updated_at = NOW(),
            state_nonce = NULL,
            code_verifier = NULL,
            redirect_uri = NULL,
            pending_created_at = NULL
        """,
        fhir_server_id,
        admin_user,
        access_token,
        refresh_token or "",
        token_type,
        granted_scope,
        access_expires,
        refresh_expires,
        secret_key,
    )


# ── public API ───────────────────────────────────────────────────────────────


async def _acquire_and_store_client_credentials(
    conn,
    server: dict[str, Any],
    *,
    admin_user: str,
    secret_key: str,
) -> str:
    """Run the client_credentials grant and persist the resulting token.

    Reused by the explicit Authorize action and by the auto-refresh path (a
    client_credentials grant has no refresh token, so renewal re-authenticates).
    """
    metadata = await _discover(server)
    token_endpoint = _resolve_token_endpoint(server, metadata)
    if not token_endpoint:
        raise OAuthError("Could not resolve the token endpoint")
    form = fss._token_request_form(server)
    try:
        payload = await _post_token(server, token_endpoint, form)
    except RuntimeError as exc:
        raise OAuthError(f"Token request failed: {exc}") from exc
    await _store_tokens(
        conn,
        str(server["fhir_server_id"]),
        admin_user,
        payload,
        secret_key=secret_key,
        fallback_scope=server.get("scope") or "",
    )
    return str(payload["access_token"])


async def authorize_client_credentials(
    pool: PoolLike,
    identifier: str,
    *,
    admin_user: str,
    secret_key: str,
) -> dict[str, Any]:
    """Fetch and store a client_credentials token (the CC "Authorize" action)."""
    await fss.ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        row = await fss._fetch_server_row(conn, identifier, secret_key=secret_key)
        if not row:
            raise ValueError("FHIR server not found")
        server = fss._server_private(row)
        if server.get("auth_type") != fss.AUTH_OAUTH2_CC:
            raise ValueError("Server is not configured for OAuth2 Client Credentials")
        await _acquire_and_store_client_credentials(
            conn, server, admin_user=admin_user, secret_key=secret_key
        )
    fss._TOKEN_CACHE.pop(str(server["fhir_server_id"]), None)
    return {
        "ok": True,
        "server_key": server["server_key"],
        "oauth_status": await get_oauth_status(pool, server["fhir_server_id"]),
    }


async def start_authorization(
    pool: PoolLike,
    identifier: str,
    *,
    admin_user: str,
    redirect_uri: str,
    secret_key: str,
) -> dict[str, Any]:
    """Dispatch the Authorize action by auth type.

    Client Credentials → fetch+store a token now and return
    ``{"authorized": True, "oauth_status": {...}}``. Authorization Code → return
    ``{"authorization_uri": ...}`` for the browser to follow.
    """
    await fss.ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        row = await fss._fetch_server_row(conn, identifier)
        if not row:
            raise ValueError("FHIR server not found")
        auth_type = row["auth_type"]
    if auth_type == fss.AUTH_OAUTH2_CC:
        result = await authorize_client_credentials(
            pool, identifier, admin_user=admin_user, secret_key=secret_key
        )
        result["authorized"] = True
        return result
    if auth_type == fss.AUTH_OAUTH2_AC:
        return await begin_authorization(
            pool,
            identifier,
            admin_user=admin_user,
            redirect_uri=redirect_uri,
            secret_key=secret_key,
        )
    raise ValueError("Server does not use OAuth2; nothing to authorize")


async def begin_authorization(
    pool: PoolLike,
    identifier: str,
    *,
    admin_user: str,
    redirect_uri: str,
    secret_key: str,
) -> dict[str, Any]:
    """Start the Authorization Code flow: persist pending PKCE state, return the URL.

    Returns ``{"authorization_uri": str, "state": str}``. Raises ``ValueError`` for
    bad config (not auth-code, missing endpoints).
    """
    await fss.ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        row = await fss._fetch_server_row(conn, identifier, secret_key=secret_key)
        if not row:
            raise ValueError("FHIR server not found")
        server = fss._server_private(row)
        if server.get("auth_type") != fss.AUTH_OAUTH2_AC:
            raise ValueError("Server is not configured for OAuth2 Authorization Code")

        metadata = await _discover(server)
        authorization_endpoint = _resolve_authorization_endpoint(server, metadata)
        if not authorization_endpoint:
            raise ValueError(
                "Could not resolve the authorization endpoint — set "
                "authorization_endpoint or enable metadata discovery"
            )
        if not _resolve_token_endpoint(server, metadata):
            raise ValueError("Could not resolve the token endpoint")

        verifier, challenge = generate_pkce_pair()
        state = generate_state_nonce()
        scope = _scope_for_authorize(server)
        fhir_server_id = server["fhir_server_id"]

        # Upsert the pending state; leave any existing active tokens untouched so a
        # re-auth attempt does not wipe a working grant until the callback succeeds.
        await conn.execute(
            """
            INSERT INTO admin.fhir_server_oauth_tokens (
                fhir_server_id, admin_user,
                state_nonce, code_verifier, redirect_uri,
                requested_scope, pending_created_at, updated_at
            )
            VALUES ($1::uuid, $2, $3, $4, $5, $6, NOW(), NOW())
            ON CONFLICT (fhir_server_id, admin_user) DO UPDATE SET
                state_nonce = $3,
                code_verifier = $4,
                redirect_uri = $5,
                requested_scope = $6,
                pending_created_at = NOW(),
                updated_at = NOW()
            """,
            fhir_server_id,
            admin_user,
            state,
            verifier,
            redirect_uri,
            scope,
        )

    params = {
        "response_type": "code",
        "client_id": server.get("client_id") or "",
        "redirect_uri": redirect_uri,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": CODE_CHALLENGE_METHOD,
        # Force a fresh interactive login (OIDC standard). Without this an active
        # SSO session at the authorization server would silently re-issue a code
        # and skip the login screen — surprising right after "Clear cache".
        "prompt": "login",
    }
    if scope:
        params["scope"] = scope
    # SMART names the FHIR audience `aud`; IUA / plain OAuth2 do not use it.
    if server.get("auth_profile") == fss.AUTH_PROFILE_SMART:
        params["aud"] = server.get("base_url") or ""
    authorization_uri = f"{authorization_endpoint}?{urlencode(params)}"
    return {"authorization_uri": authorization_uri, "state": state}


async def complete_authorization(
    pool: PoolLike,
    *,
    code: str,
    state: str,
    secret_key: str,
) -> dict[str, Any]:
    """Validate the callback state, exchange the code for tokens, store them.

    Returns ``{"ok": True, "server_key": str}``. Raises ``ValueError`` on an
    invalid/expired state or a failed exchange.
    """
    if not code or not state:
        raise ValueError("Missing authorization code or state")
    await fss.ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        pending = await conn.fetchrow(
            """
            SELECT fhir_server_id, admin_user, code_verifier, redirect_uri,
                   requested_scope, pending_created_at
            FROM admin.fhir_server_oauth_tokens
            WHERE state_nonce = $1
            """,
            state,
        )
        if not pending:
            raise ValueError("Invalid or expired authorization state")
        created = pending["pending_created_at"]
        if created is None or created < _now() - timedelta(
            seconds=PENDING_STATE_TTL_SECONDS
        ):
            await conn.execute(
                """
                UPDATE admin.fhir_server_oauth_tokens
                SET state_nonce = NULL, code_verifier = NULL,
                    pending_created_at = NULL, updated_at = NOW()
                WHERE state_nonce = $1
                """,
                state,
            )
            raise ValueError("Authorization state has expired — please retry")

        fhir_server_id = str(pending["fhir_server_id"])
        row = await fss._fetch_server_row(
            conn, fhir_server_id, secret_key=secret_key
        )
        if not row:
            raise ValueError("FHIR server not found")
        server = fss._server_private(row)

        metadata = await _discover(server)
        token_endpoint = _resolve_token_endpoint(server, metadata)
        if not token_endpoint:
            raise ValueError("Could not resolve the token endpoint")

        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": pending["redirect_uri"] or "",
            "code_verifier": pending["code_verifier"] or "",
        }
        try:
            payload = await _post_token(server, token_endpoint, form)
        except RuntimeError as exc:
            raise ValueError(f"Token exchange failed: {exc}") from exc

        await _store_tokens(
            conn,
            fhir_server_id,
            pending["admin_user"],
            payload,
            secret_key=secret_key,
            fallback_scope=pending["requested_scope"] or "",
        )

    fss._TOKEN_CACHE.pop(fhir_server_id, None)
    return {"ok": True, "server_key": server["server_key"]}


async def _refresh_access_token(
    conn,
    server: dict[str, Any],
    token_row: Any,
    *,
    secret_key: str,
) -> str:
    """Exchange the stored refresh token for a new access token; persist and return it.

    On a rejected refresh token, clears the stored grant and raises
    ``OAuthRefreshFailedError``.
    """
    refresh_token = token_row["refresh_token"]
    if not refresh_token:
        # A client_credentials grant has no refresh token — renew by simply
        # re-running the grant (the server's own credentials still apply).
        if server.get("auth_type") == fss.AUTH_OAUTH2_CC:
            return await _acquire_and_store_client_credentials(
                conn,
                server,
                admin_user=token_row["admin_user"],
                secret_key=secret_key,
            )
        raise OAuthNotAuthorizedError(
            "Access token expired and no refresh token is stored — re-authorize "
            "the server in the admin console"
        )
    metadata = await _discover(server)
    token_endpoint = _resolve_token_endpoint(server, metadata)
    if not token_endpoint:
        raise OAuthRefreshFailedError("Could not resolve the token endpoint")
    form = {"grant_type": "refresh_token", "refresh_token": refresh_token}
    granted_scope = token_row["granted_scope"] or ""
    if granted_scope:
        form["scope"] = granted_scope
    fhir_server_id = str(server["fhir_server_id"])
    try:
        payload = await _post_token(server, token_endpoint, form)
    except RuntimeError as exc:
        # Refresh rejected (expired/revoked) — clear the grant so the UI shows
        # "not authorized" and the operator re-authorizes.
        await conn.execute(
            """
            UPDATE admin.fhir_server_oauth_tokens
            SET access_token_ciphertext = NULL,
                refresh_token_ciphertext = NULL,
                access_token_expires_at = NULL,
                refresh_token_expires_at = NULL,
                updated_at = NOW()
            WHERE fhir_server_id = $1::uuid
            """,
            fhir_server_id,
        )
        fss._TOKEN_CACHE.pop(fhir_server_id, None)
        raise OAuthRefreshFailedError(
            f"Refresh token rejected ({exc}) — re-authorize the server"
        ) from exc

    await _store_tokens(
        conn,
        fhir_server_id,
        token_row["admin_user"],
        payload,
        secret_key=secret_key,
        fallback_scope=granted_scope,
        keep_refresh_if_absent=True,
        current_refresh=refresh_token,
    )
    return str(payload["access_token"])


def _needs_refresh(token_row: Any) -> bool:
    """True when the access token is expired/near-expiry or the refresh token is
    near expiry (proactive rotation)."""
    now = _now()
    access_exp = token_row["access_token_expires_at"]
    if access_exp is None or access_exp <= now + timedelta(
        seconds=ACCESS_REFRESH_SKEW_SECONDS
    ):
        return True
    refresh_exp = token_row["refresh_token_expires_at"]
    if refresh_exp is not None and refresh_exp <= now + timedelta(
        seconds=REFRESH_TOKEN_RENEW_SKEW_SECONDS
    ):
        return True
    return False


async def get_valid_user_access_token(
    pool: PoolLike,
    server: dict[str, Any],
    *,
    secret_key: str,
) -> str:
    """Return a usable access token for an auth-code server, refreshing if needed.

    Single-flight per server so concurrent callers perform at most one refresh.
    Raises ``OAuthNotAuthorizedError`` when no grant exists and
    ``OAuthRefreshFailedError`` when the refresh token is rejected.
    """
    fhir_server_id = str(server["fhir_server_id"])
    async with pool.acquire() as conn:
        row = await _load_active_token_row(conn, fhir_server_id, secret_key)
    if not row:
        raise OAuthNotAuthorizedError(
            "Server not authorized — click Authorize in the admin console to "
            "complete the OAuth2 login"
        )
    if not _needs_refresh(row):
        return str(row["access_token"])

    # Refresh under the shared single-flight lock; re-read inside to coalesce.
    async with fss._token_lock(f"ac:{fhir_server_id}"):
        async with pool.acquire() as conn:
            row = await _load_active_token_row(conn, fhir_server_id, secret_key)
            if not row:
                raise OAuthNotAuthorizedError(
                    "Server not authorized — click Authorize in the admin console"
                )
            if not _needs_refresh(row):
                return str(row["access_token"])
            return await _refresh_access_token(
                conn, server, row, secret_key=secret_key
            )


async def refresh_token_now(
    pool: PoolLike,
    identifier: str,
    *,
    secret_key: str,
) -> dict[str, Any]:
    """Force a refresh-token exchange now (the manual "Refresh token" action).

    Requires a stored refresh token. Raises ``OAuthError`` when none exists and
    ``OAuthRefreshFailedError`` when the authorization server rejects it.
    """
    await fss.ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        row = await fss._fetch_server_row(conn, identifier, secret_key=secret_key)
        if not row:
            raise ValueError("FHIR server not found")
        server = fss._server_private(row)
    fhir_server_id = str(server["fhir_server_id"])
    async with fss._token_lock(f"ac:{fhir_server_id}"):
        async with pool.acquire() as conn:
            token_row = await _load_active_token_row(conn, fhir_server_id, secret_key)
            if not token_row:
                raise OAuthNotAuthorizedError(
                    "Server not authorized — nothing to refresh"
                )
            if not token_row["refresh_token"]:
                raise OAuthError("No refresh token is stored for this server")
            await _refresh_access_token(conn, server, token_row, secret_key=secret_key)
    return {"ok": True, "oauth_status": await get_oauth_status(pool, fhir_server_id)}


async def clear_oauth_state(
    pool: PoolLike,
    identifier: str,
    *,
    admin_user: str | None = None,
) -> dict[str, Any]:
    """Delete all stored tokens + pending PKCE state for a server (clear cache)."""
    await fss.ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        row = await fss._fetch_server_row(conn, identifier)
        if not row:
            raise ValueError("FHIR server not found")
        fhir_server_id = str(row["fhir_server_id"])
        await conn.execute(
            "DELETE FROM admin.fhir_server_oauth_tokens WHERE fhir_server_id = $1::uuid",
            fhir_server_id,
        )
    fss._TOKEN_CACHE.pop(fhir_server_id, None)
    return {"cleared": True, "fhir_server_id": fhir_server_id}


def _status_from_row(row: Any) -> dict[str, Any]:
    now = _now()
    has_access = bool(row["has_access"]) if row else False
    has_refresh = bool(row["has_refresh"]) if row else False
    access_exp = row["access_token_expires_at"] if row else None
    refresh_exp = row["refresh_token_expires_at"] if row else None
    pending = bool(row and row["state_nonce"])
    pending_fresh = (
        pending
        and row["pending_created_at"] is not None
        and row["pending_created_at"]
        >= now - timedelta(seconds=PENDING_STATE_TTL_SECONDS)
    )

    if has_access:
        refreshable = has_refresh and (refresh_exp is None or refresh_exp > now)
        if refreshable or access_exp is None or access_exp > now:
            status = "authorized"
        else:
            status = "expired"
    elif pending_fresh:
        status = "pending"
    else:
        status = "not_authorized"

    return {
        "status": status,
        "access_expires_at": access_exp.isoformat() if access_exp else None,
        "refresh_expires_at": refresh_exp.isoformat() if refresh_exp else None,
        "has_refresh": has_refresh,
        "scope": (row["granted_scope"] if row else "") or "",
    }


async def get_oauth_status(
    pool: PoolLike,
    server_id: str,
    *,
    secret_key: str = "",
) -> dict[str, Any]:
    """Return the authorization status for one server (for the card/form badge)."""
    await fss.ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT state_nonce, pending_created_at,
                   (access_token_ciphertext IS NOT NULL) AS has_access,
                   (refresh_token_ciphertext IS NOT NULL) AS has_refresh,
                   token_type, granted_scope,
                   access_token_expires_at, refresh_token_expires_at
            FROM admin.fhir_server_oauth_tokens
            WHERE fhir_server_id = $1::uuid
            ORDER BY obtained_at DESC NULLS LAST
            LIMIT 1
            """,
            str(server_id),
        )
    return _status_from_row(row)


async def attach_oauth_status(
    pool: PoolLike,
    servers: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Enrich each OAuth2 server dict (CC or auth-code) with an ``oauth_status``."""
    for server in servers:
        if server.get("auth_type") in fss.OAUTH2_AUTH_TYPES:
            try:
                server["oauth_status"] = await get_oauth_status(
                    pool, server["fhir_server_id"]
                )
            except Exception:
                server["oauth_status"] = {
                    "status": "not_authorized",
                    "access_expires_at": None,
                    "refresh_expires_at": None,
                    "has_refresh": False,
                    "scope": "",
                }
    return servers


async def sweep_expiring_tokens(
    pool: PoolLike,
    *,
    secret_key: str,
) -> int:
    """Proactively refresh stored tokens that are near expiry (background worker).

    Returns the number of servers whose token was refreshed. Per-server errors are
    swallowed (a dead grant simply flips the UI to "expired").
    """
    await fss.ensure_fhir_server_schema(pool)
    now = _now()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT fhir_server_id
            FROM admin.fhir_server_oauth_tokens
            WHERE access_token_ciphertext IS NOT NULL
              AND (
                access_token_expires_at IS NULL
                OR access_token_expires_at <= $1
                OR (refresh_token_expires_at IS NOT NULL
                    AND refresh_token_expires_at <= $2)
              )
            """,
            now + timedelta(seconds=ACCESS_REFRESH_SKEW_SECONDS),
            now + timedelta(seconds=REFRESH_TOKEN_RENEW_SKEW_SECONDS),
        )
    refreshed = 0
    for row in rows:
        fhir_server_id = str(row["fhir_server_id"])
        try:
            async with pool.acquire() as conn:
                server_row = await fss._fetch_server_row(
                    conn, fhir_server_id, secret_key=secret_key
                )
            if not server_row:
                continue
            server = fss._server_private(server_row)
            if server.get("auth_type") not in fss.OAUTH2_AUTH_TYPES:
                continue
            await get_valid_user_access_token(pool, server, secret_key=secret_key)
            refreshed += 1
        except Exception:
            continue
    return refreshed

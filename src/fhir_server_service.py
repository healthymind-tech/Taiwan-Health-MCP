"""Admin-managed external FHIR Server registry and client.

The existing FHIR tools generate local FHIR resources from Taiwan modules.
This module is different: it lets admins register external FHIR servers, then
lets MCP tools list and call those servers through controlled FHIR REST paths.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import time
import uuid
from datetime import datetime
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse

import asyncpg
import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from database import PoolLike

AUTH_NONE = "none"
AUTH_OAUTH2_CC = "oauth2_client_credentials"

# OAuth2 authorization profile — mutually exclusive. Only meaningful when
# auth_type == oauth2_client_credentials; otherwise forced to "none".
AUTH_PROFILE_NONE = "none"
AUTH_PROFILE_IUA = "iua"
AUTH_PROFILE_SMART = "smart"
AUTH_PROFILES = {AUTH_PROFILE_NONE, AUTH_PROFILE_IUA, AUTH_PROFILE_SMART}

# How the client authenticates to the OAuth2 token endpoint (OIDC names).
TOKEN_AUTH_BASIC = "client_secret_basic"
TOKEN_AUTH_POST = "client_secret_post"
TOKEN_AUTH_SECRET_JWT = "client_secret_jwt"
TOKEN_AUTH_PRIVATE_KEY_JWT = "private_key_jwt"
TOKEN_AUTH_METHODS = {
    TOKEN_AUTH_BASIC,
    TOKEN_AUTH_POST,
    TOKEN_AUTH_SECRET_JWT,
    TOKEN_AUTH_PRIVATE_KEY_JWT,
}
TOKEN_AUTH_JWT_METHODS = {TOKEN_AUTH_SECRET_JWT, TOKEN_AUTH_PRIVATE_KEY_JWT}

# RFC 7521/7523 client assertion (used by client_secret_jwt + private_key_jwt).
CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
# SMART Backend Services requires the assertion to expire within 5 minutes.
CLIENT_ASSERTION_LIFETIME_SECONDS = 300
# HMAC algorithms for client_secret_jwt; asymmetric for private_key_jwt.
HMAC_SIGNING_ALGS = {"HS256", "HS384", "HS512"}
ASYMMETRIC_SIGNING_ALGS = {
    "RS256",
    "RS384",
    "RS512",
    "ES256",
    "ES384",
    "ES512",
    "PS256",
    "PS384",
    "PS512",
}
DEFAULT_SECRET_JWT_ALG = "HS384"
DEFAULT_PRIVATE_KEY_JWT_ALG = "RS384"

READ_OPERATIONS = {"metadata", "read", "search"}
WRITE_OPERATIONS = {"create", "update", "patch", "delete"}
ALLOWED_OPERATIONS = READ_OPERATIONS | WRITE_OPERATIONS
DEFAULT_OPERATIONS = ["metadata", "read", "search"]
DEFAULT_RESOURCE_TYPES = [
    "Patient",
    "Observation",
    "Condition",
    "Medication",
    "MedicationRequest",
    "MedicationAdministration",
    "AllergyIntolerance",
    "DiagnosticReport",
    "DocumentReference",
    "Encounter",
    "Practitioner",
    "Organization",
]
IUA_JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt"

SERVER_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$")
RESOURCE_TYPE_RE = re.compile(r"^[A-Z][A-Za-z0-9]{0,63}$")
RESOURCE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$")

MAX_RESPONSE_CHARS = 300_000
TOKEN_CACHE_SKEW_SECONDS = 60

# Per-call OAuth2 token strategy (client_credentials). The token represents this
# MCP server's client identity (not an end user), so it is the same for everyone;
# the strategy controls whether each FHIR call re-authenticates or reuses a token.
#   fresh  — fetch a brand-new token for this call; never read/write the shared
#            cache (full re-auth every call; isolated across concurrent users).
#   cached — use the shared per-server cache; single-flight fetch on miss/expiry.
#   auto   — follow the server's admin-set default (falls back to global fresh).
TOKEN_STRATEGY_FRESH = "fresh"
TOKEN_STRATEGY_CACHED = "cached"
TOKEN_STRATEGY_AUTO = "auto"
TOKEN_STRATEGIES = {TOKEN_STRATEGY_FRESH, TOKEN_STRATEGY_CACHED, TOKEN_STRATEGY_AUTO}
# A server's admin default may only be a concrete strategy, never "auto".
TOKEN_STRATEGY_DEFAULTS = {TOKEN_STRATEGY_FRESH, TOKEN_STRATEGY_CACHED}
DEFAULT_TOKEN_STRATEGY = TOKEN_STRATEGY_FRESH

# Shared token cache + per-server single-flight locks (used only by 'cached').
_TOKEN_CACHE: dict[str, tuple[float, str]] = {}
_TOKEN_LOCKS: dict[str, asyncio.Lock] = {}


def _token_lock(cache_key: str) -> asyncio.Lock:
    """Return the per-server lock, lazily created. Safe in single-threaded asyncio
    (no await between get and setdefault)."""
    lock = _TOKEN_LOCKS.get(cache_key)
    if lock is None:
        lock = _TOKEN_LOCKS.setdefault(cache_key, asyncio.Lock())
    return lock


def resolve_token_strategy(requested: str | None, server_default: str | None) -> str:
    """Resolve the effective strategy: explicit per-call request wins; otherwise
    the server's admin default; otherwise the global default (fresh)."""
    req = (requested or TOKEN_STRATEGY_AUTO).strip().lower()
    if req in TOKEN_STRATEGY_DEFAULTS:
        return req
    sd = (server_default or "").strip().lower()
    if sd in TOKEN_STRATEGY_DEFAULTS:
        return sd
    return DEFAULT_TOKEN_STRATEGY


def fhir_server_secret_key(fallback: str = "") -> str:
    """Return the symmetric pgcrypto key used for client secrets."""
    return os.getenv("FHIR_SERVER_SECRET_KEY", "").strip() or fallback


# ── private_key_jwt key material ──────────────────────────────────────────────
# We are the OAuth *client*: each server connection owns one signing keypair.
# The private key is stored encrypted (pgcrypto); the public half is published
# as a JWK so the OAuth Server can verify our client assertions.

_RSA_ALGS = {"RS256", "RS384", "RS512", "PS256", "PS384", "PS512"}
_EC_CURVES = {
    "ES256": ec.SECP256R1,
    "ES384": ec.SECP384R1,
    "ES512": ec.SECP521R1,
}
DEFAULT_RSA_KEY_BITS = 2048


def generate_keypair(alg: str, *, rsa_bits: int = DEFAULT_RSA_KEY_BITS) -> str:
    """Generate a signing keypair for ``alg`` and return the PKCS#8 PEM private key."""
    alg = (alg or "").upper()
    if alg in _RSA_ALGS:
        key: Any = rsa.generate_private_key(public_exponent=65537, key_size=rsa_bits)
    elif alg in _EC_CURVES:
        key = ec.generate_private_key(_EC_CURVES[alg]())
    else:
        raise ValueError(
            "Unsupported algorithm for key generation: must be one of "
            + ", ".join(sorted(ASYMMETRIC_SIGNING_ALGS))
        )
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return pem.decode("ascii")


def jwk_thumbprint(jwk: dict[str, Any]) -> str:
    """RFC 7638 JWK thumbprint (base64url SHA-256 of the canonical members)."""
    kty = jwk.get("kty")
    if kty == "RSA":
        members = ("e", "kty", "n")
    elif kty == "EC":
        members = ("crv", "kty", "x", "y")
    elif kty == "oct":
        members = ("k", "kty")
    else:
        raise ValueError(f"Cannot compute thumbprint for kty={kty!r}")
    canonical = {name: jwk[name] for name in members}
    data = json.dumps(canonical, separators=(",", ":"), sort_keys=True).encode("utf-8")
    digest = hashlib.sha256(data).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def derive_public_jwk(
    private_pem: str, alg: str, *, kid: str | None = None
) -> tuple[dict[str, Any], str]:
    """Return ``(public_jwk, kid)`` for a PEM private key and signing alg.

    The JWK carries ``use``/``alg``/``kid`` so the OAuth Server can pick the
    right key. ``kid`` defaults to the RFC 7638 thumbprint when not supplied.
    """
    alg = (alg or "").upper()
    key = serialization.load_pem_private_key(private_pem.encode("utf-8"), password=None)
    public_key = key.public_key()
    if alg in _RSA_ALGS:
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(public_key))
    elif alg in _EC_CURVES:
        jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(public_key))
    else:
        raise ValueError(f"Unsupported algorithm for JWK export: {alg!r}")
    # PyJWT may emit a "key_ops" array; SMART servers expect "use": "sig".
    jwk.pop("key_ops", None)
    jwk["use"] = "sig"
    jwk["alg"] = alg
    jwk["kid"] = kid or jwk_thumbprint(jwk)
    return jwk, jwk["kid"]


def generate_client_key(alg: str) -> dict[str, Any]:
    """Generate a keypair and return material for the admin UI (private key
    shown once; public JWK persisted on save)."""
    alg = (alg or DEFAULT_PRIVATE_KEY_JWT_ALG).upper()
    if alg not in ASYMMETRIC_SIGNING_ALGS:
        raise ValueError(
            "alg must be one of: " + ", ".join(sorted(ASYMMETRIC_SIGNING_ALGS))
        )
    private_pem = generate_keypair(alg)
    public_jwk, kid = derive_public_jwk(private_pem, alg)
    return {
        "private_key_pem": private_pem,
        "public_jwk": public_jwk,
        "jwks": {"keys": [public_jwk]},
        "kid": kid,
        "alg": alg,
    }


def _public_jwks_from_json(public_jwk_json: str | None) -> dict[str, Any] | None:
    """Wrap a stored public-JWK JSON string into a ``{"keys": [...]}`` set."""
    if not public_jwk_json:
        return None
    try:
        jwk = json.loads(public_jwk_json)
    except (TypeError, ValueError):
        return None
    if not isinstance(jwk, dict) or not jwk:
        return None
    return {"keys": [jwk]}


def _coerce_uuid(value: Any) -> str | None:
    """Return a canonical UUID string if `value` is a valid UUID, else None.
    Used to honour an imported ``fhir_server_id`` without trusting its format."""
    text = _clean_text(value)
    if not text:
        return None
    try:
        return str(uuid.UUID(text))
    except (ValueError, AttributeError, TypeError):
        return None


def _resolve_public_jwk(
    token_auth_method: str,
    private_key: str | None,
    alg: str | None,
    jwt_kid: str | None,
) -> tuple[str | None, str | None]:
    """Compute the stored public-JWK JSON and effective kid for a server.

    Returns ``(public_jwk_json_or_None, kid_or_None)``. Only private_key_jwt with
    an available private key produces a JWK; other methods clear it.
    """
    if token_auth_method != TOKEN_AUTH_PRIVATE_KEY_JWT or not private_key:
        return None, (jwt_kid or None)
    jwk, kid = derive_public_jwk(
        private_key, alg or DEFAULT_PRIVATE_KEY_JWT_ALG, kid=(jwt_kid or None)
    )
    return json.dumps(jwk, ensure_ascii=False), kid


async def ensure_fhir_server_schema(pool: PoolLike) -> None:
    """Create/upgrade admin tables for external FHIR Server configuration."""
    async with pool.acquire() as conn:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS admin.fhir_servers (
                fhir_server_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                server_key TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT,
                base_url TEXT NOT NULL,
                test_path TEXT,
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                is_default BOOLEAN NOT NULL DEFAULT FALSE,

                auth_type TEXT NOT NULL DEFAULT 'none'
                    CHECK (auth_type IN ('none', 'oauth2_client_credentials')),
                auth_profile TEXT NOT NULL DEFAULT 'none'
                    CHECK (auth_profile IN ('none', 'iua', 'smart')),
                auth_server_url TEXT,
                metadata_url TEXT,
                token_endpoint TEXT,
                use_metadata BOOLEAN NOT NULL DEFAULT TRUE,
                client_id TEXT,
                client_secret_ciphertext BYTEA,
                token_auth_method TEXT NOT NULL DEFAULT 'client_secret_basic'
                    CHECK (token_auth_method IN (
                        'client_secret_basic', 'client_secret_post',
                        'client_secret_jwt', 'private_key_jwt'
                    )),
                client_private_key_ciphertext BYTEA,
                jwt_signing_alg TEXT,
                jwt_kid TEXT,
                client_public_jwk_json TEXT,
                default_token_strategy TEXT,
                scope TEXT,
                resource TEXT,
                requested_token_type TEXT,
                metadata_headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                token_headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                resource_headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                verify_tls BOOLEAN NOT NULL DEFAULT TRUE,
                timeout_seconds INTEGER NOT NULL DEFAULT 30,

                allowed_resource_types JSONB NOT NULL DEFAULT '[]'::jsonb,
                allowed_operations JSONB NOT NULL DEFAULT '["metadata","read","search"]'::jsonb,

                last_probe_status TEXT,
                last_probe_at TIMESTAMPTZ,
                last_probe_error TEXT,
                capability_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,

                created_by TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """)
        # Idempotent upgrade for databases created before auth_profile replaced
        # the enable_iua boolean. Backfills the new enum from the old column.
        await conn.execute("""
            ALTER TABLE admin.fhir_servers
                ADD COLUMN IF NOT EXISTS auth_profile TEXT NOT NULL DEFAULT 'none'
            """)
        # Idempotent upgrade for the token-endpoint client authentication method
        # (client_secret_jwt / private_key_jwt support).
        await conn.execute("""
            ALTER TABLE admin.fhir_servers
                ADD COLUMN IF NOT EXISTS token_auth_method TEXT
                    NOT NULL DEFAULT 'client_secret_basic'
            """)
        await conn.execute("""
            ALTER TABLE admin.fhir_servers
                ADD COLUMN IF NOT EXISTS client_private_key_ciphertext BYTEA
            """)
        await conn.execute("""
            ALTER TABLE admin.fhir_servers
                ADD COLUMN IF NOT EXISTS jwt_signing_alg TEXT
            """)
        await conn.execute("""
            ALTER TABLE admin.fhir_servers
                ADD COLUMN IF NOT EXISTS jwt_kid TEXT
            """)
        # Public JWK (plaintext — it is the public half of the private_key_jwt
        # signing key) served at the per-server JWKS endpoint so an OAuth Server
        # can fetch our key without us exposing the encrypted private key.
        await conn.execute("""
            ALTER TABLE admin.fhir_servers
                ADD COLUMN IF NOT EXISTS client_public_jwk_json TEXT
            """)
        # Optional probe/test path appended to base_url for the connection workflow.
        await conn.execute("""
            ALTER TABLE admin.fhir_servers
                ADD COLUMN IF NOT EXISTS test_path TEXT
            """)
        # Admin default OAuth token strategy (fresh / cached); per-call can override.
        await conn.execute("""
            ALTER TABLE admin.fhir_servers
                ADD COLUMN IF NOT EXISTS default_token_strategy TEXT
            """)
        # Custom headers attached to the authorization metadata discovery request
        # (.well-known/openid-configuration / smart-configuration / oauth-authorization-server).
        await conn.execute("""
            ALTER TABLE admin.fhir_servers
                ADD COLUMN IF NOT EXISTS metadata_headers_json JSONB
                    NOT NULL DEFAULT '{}'::jsonb
            """)
        await conn.execute("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'admin'
                      AND table_name = 'fhir_servers'
                      AND column_name = 'enable_iua'
                ) THEN
                    UPDATE admin.fhir_servers
                        SET auth_profile = 'iua'
                        WHERE enable_iua = TRUE AND auth_profile = 'none';
                    ALTER TABLE admin.fhir_servers DROP COLUMN enable_iua;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.constraint_column_usage
                    WHERE table_schema = 'admin'
                      AND table_name = 'fhir_servers'
                      AND constraint_name = 'fhir_servers_auth_profile_chk'
                ) THEN
                    ALTER TABLE admin.fhir_servers
                        ADD CONSTRAINT fhir_servers_auth_profile_chk
                        CHECK (auth_profile IN ('none', 'iua', 'smart'));
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.constraint_column_usage
                    WHERE table_schema = 'admin'
                      AND table_name = 'fhir_servers'
                      AND constraint_name = 'fhir_servers_token_auth_method_chk'
                ) THEN
                    ALTER TABLE admin.fhir_servers
                        ADD CONSTRAINT fhir_servers_token_auth_method_chk
                        CHECK (token_auth_method IN (
                            'client_secret_basic', 'client_secret_post',
                            'client_secret_jwt', 'private_key_jwt'
                        ));
                END IF;
            END $$;
            """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_admin_fhir_servers_enabled
                ON admin.fhir_servers (enabled, server_key)
            """)
        await conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_fhir_servers_single_default
                ON admin.fhir_servers (is_default)
                WHERE is_default = TRUE
            """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS admin.fhir_server_probe_history (
                fhir_server_probe_history_id BIGSERIAL PRIMARY KEY,
                fhir_server_id UUID REFERENCES admin.fhir_servers (fhir_server_id)
                    ON DELETE CASCADE,
                status TEXT NOT NULL,
                endpoint TEXT,
                latency_ms INTEGER,
                message TEXT,
                details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_admin_fhir_server_probe_history_server_ts
                ON admin.fhir_server_probe_history (fhir_server_id, checked_at DESC)
            """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS admin.fhir_server_operation_logs (
                fhir_server_operation_log_id BIGSERIAL PRIMARY KEY,
                fhir_server_id UUID REFERENCES admin.fhir_servers (fhir_server_id)
                    ON DELETE SET NULL,
                server_key TEXT,
                operation TEXT NOT NULL,
                resource_type TEXT,
                resource_id TEXT,
                status_code INTEGER,
                duration_ms INTEGER,
                success BOOLEAN NOT NULL DEFAULT FALSE,
                error_message TEXT,
                caller TEXT NOT NULL DEFAULT 'mcp',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_admin_fhir_server_operation_logs_server_ts
                ON admin.fhir_server_operation_logs (fhir_server_id, created_at DESC)
            """)


def _json_value(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, str):
        if not value:
            return default
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return default
    return value


def _to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _row_get(
    row: asyncpg.Record | dict[str, Any], key: str, default: Any = None
) -> Any:
    if isinstance(row, dict):
        return row.get(key, default)
    try:
        return row[key]
    except (KeyError, IndexError):
        return default


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _bool_value(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _parse_headers(value: Any, *, allow_authorization: bool = False) -> dict[str, str]:
    raw = _json_value(value, {})
    if raw in ("", None):
        return {}
    if not isinstance(raw, dict):
        raise ValueError("headers must be a JSON object")
    headers: dict[str, str] = {}
    for key, val in raw.items():
        k = str(key).strip()
        if not k:
            continue
        if k.lower() == "authorization" and not allow_authorization:
            raise ValueError("custom headers cannot set Authorization")
        headers[k] = str(val)
    return headers


def _parse_str_list(value: Any, default: list[str]) -> list[str]:
    raw = _json_value(value, None)
    if raw in (None, ""):
        return list(default)
    if isinstance(raw, str):
        raw = [part.strip() for part in raw.split(",") if part.strip()]
    if not isinstance(raw, list):
        raise ValueError("value must be an array of strings")
    result: list[str] = []
    for item in raw:
        text = str(item).strip()
        if text and text not in result:
            result.append(text)
    return result


def _validate_base_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base_url must be an absolute HTTP(S) URL")
    if parsed.query or parsed.fragment:
        raise ValueError("base_url cannot include query string or fragment")
    return value.rstrip("/")


def _validate_optional_url(value: str, label: str) -> str:
    if not value:
        return ""
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{label} must be an absolute HTTP(S) URL")
    if parsed.fragment:
        raise ValueError(f"{label} cannot include a fragment")
    return value


def _derive_metadata_url(
    auth_server_url: str,
    metadata_url: str,
    auth_profile: str = AUTH_PROFILE_NONE,
) -> str:
    if metadata_url:
        return metadata_url
    if not auth_server_url:
        return ""
    base = auth_server_url.rstrip("/")
    # SMART Backend Services advertises via .well-known/smart-configuration;
    # IUA / plain OAuth2 use the RFC 8414 authorization-server metadata.
    well_known = (
        ".well-known/smart-configuration"
        if auth_profile == AUTH_PROFILE_SMART
        else ".well-known/oauth-authorization-server"
    )
    return f"{base}/{well_known}"


def _derive_token_endpoint(auth_server_url: str, token_endpoint: str) -> str:
    if token_endpoint:
        return token_endpoint
    if not auth_server_url:
        return ""
    base = auth_server_url.rstrip("/")
    return f"{base}/token"


def _normalize_query(query: Any) -> dict[str, str]:
    if query in (None, ""):
        return {}
    raw = _json_value(query, query)
    if isinstance(raw, str):
        return {k: v for k, v in parse_qsl(raw.lstrip("?"), keep_blank_values=True)}
    if not isinstance(raw, dict):
        raise ValueError("query must be a JSON object or query string")
    result: dict[str, str] = {}
    for key, value in raw.items():
        if value is None:
            continue
        result[str(key)] = str(value)
    return result


def _normalize_json_body(value: Any, label: str) -> Any:
    if value in (None, ""):
        return None
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{label} must be valid JSON") from exc
    return value


def _validate_resource_type(resource_type: str) -> str:
    value = _clean_text(resource_type)
    if not RESOURCE_TYPE_RE.fullmatch(value):
        raise ValueError("resource_type must be a valid FHIR ResourceType")
    return value


def _validate_resource_id(resource_id: str) -> str:
    value = _clean_text(resource_id)
    if not RESOURCE_ID_RE.fullmatch(value):
        raise ValueError("resource_id must be a valid FHIR logical id")
    return value


def _validate_server_payload(
    payload: dict[str, Any],
    *,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    merged = dict(existing or {})
    merged.update({k: v for k, v in payload.items() if v is not None})

    server_key = _clean_text(merged.get("server_key")).lower()
    if not SERVER_KEY_RE.fullmatch(server_key):
        raise ValueError(
            "server_key must be 2-64 chars: letters, numbers, dot, underscore, or hyphen"
        )

    name = _clean_text(merged.get("name"))
    if not name:
        raise ValueError("name is required")
    base_url = _validate_base_url(_clean_text(merged.get("base_url")))

    auth_type = _clean_text(merged.get("auth_type") or AUTH_NONE)
    if auth_type not in {AUTH_NONE, AUTH_OAUTH2_CC}:
        raise ValueError("auth_type must be none or oauth2_client_credentials")

    allowed_operations = _parse_str_list(
        merged.get("allowed_operations"),
        DEFAULT_OPERATIONS,
    )
    invalid_ops = sorted(set(allowed_operations) - ALLOWED_OPERATIONS)
    if invalid_ops:
        raise ValueError(f"Unsupported operations: {', '.join(invalid_ops)}")
    if not allowed_operations:
        allowed_operations = list(DEFAULT_OPERATIONS)

    allowed_resource_types = _parse_str_list(
        merged.get("allowed_resource_types"),
        DEFAULT_RESOURCE_TYPES,
    )
    for resource_type in allowed_resource_types:
        _validate_resource_type(resource_type)

    raw_profile = merged.get("auth_profile")
    if raw_profile in (None, ""):
        # Legacy payloads (old exports/imports) only carry enable_iua.
        auth_profile = (
            AUTH_PROFILE_IUA
            if _bool_value(merged.get("enable_iua"), False)
            else AUTH_PROFILE_NONE
        )
    else:
        auth_profile = _clean_text(raw_profile).lower()
    if auth_profile not in AUTH_PROFILES:
        raise ValueError("auth_profile must be one of: none, iua, smart")
    auth_server_url = _validate_optional_url(
        _clean_text(merged.get("auth_server_url")),
        "auth_server_url",
    )
    metadata_url = _validate_optional_url(
        _clean_text(merged.get("metadata_url")),
        "metadata_url",
    )
    token_endpoint = _validate_optional_url(
        _clean_text(merged.get("token_endpoint")),
        "token_endpoint",
    )

    client_id = _clean_text(merged.get("client_id"))
    client_secret = _clean_text(payload.get("client_secret"))
    secret_configured = bool(merged.get("client_secret_configured"))
    client_private_key = _clean_text(payload.get("client_private_key"))
    private_key_configured = bool(merged.get("client_private_key_configured"))

    token_auth_method = _clean_text(
        merged.get("token_auth_method") or TOKEN_AUTH_BASIC
    ).lower()
    if token_auth_method not in TOKEN_AUTH_METHODS:
        raise ValueError(
            "token_auth_method must be one of: " + ", ".join(sorted(TOKEN_AUTH_METHODS))
        )
    jwt_signing_alg = _clean_text(merged.get("jwt_signing_alg")).upper()
    jwt_kid = _clean_text(merged.get("jwt_kid"))

    # SMART Backend Services always authenticates with a signed client assertion
    # (private_key_jwt by default, or client_secret_jwt) — never Basic/POST.
    if (
        auth_type == AUTH_OAUTH2_CC
        and auth_profile == AUTH_PROFILE_SMART
        and token_auth_method not in TOKEN_AUTH_JWT_METHODS
    ):
        token_auth_method = TOKEN_AUTH_PRIVATE_KEY_JWT

    if auth_type == AUTH_OAUTH2_CC:
        if not client_id:
            raise ValueError("client_id is required for OAuth2 Client Credentials")
        if not (token_endpoint or metadata_url or auth_server_url):
            raise ValueError(
                "Provide token_endpoint, metadata_url, or auth_server_url for OAuth2"
            )
        if token_auth_method == TOKEN_AUTH_PRIVATE_KEY_JWT:
            if not client_private_key and not private_key_configured:
                raise ValueError(
                    "client_private_key (PEM) is required for private_key_jwt"
                )
            if not jwt_signing_alg:
                jwt_signing_alg = DEFAULT_PRIVATE_KEY_JWT_ALG
            if jwt_signing_alg not in ASYMMETRIC_SIGNING_ALGS:
                raise ValueError(
                    "jwt_signing_alg for private_key_jwt must be one of: "
                    + ", ".join(sorted(ASYMMETRIC_SIGNING_ALGS))
                )
        else:
            # basic / post / client_secret_jwt all rely on the shared secret.
            if not client_secret and not secret_configured:
                raise ValueError(f"client_secret is required for {token_auth_method}")
            client_private_key = ""
            if token_auth_method == TOKEN_AUTH_SECRET_JWT:
                if not jwt_signing_alg:
                    jwt_signing_alg = DEFAULT_SECRET_JWT_ALG
                if jwt_signing_alg not in HMAC_SIGNING_ALGS:
                    raise ValueError(
                        "jwt_signing_alg for client_secret_jwt must be one of: "
                        + ", ".join(sorted(HMAC_SIGNING_ALGS))
                    )
            else:
                # basic / post do not sign a client assertion.
                jwt_signing_alg = ""
                jwt_kid = ""
    else:
        auth_profile = AUTH_PROFILE_NONE
        auth_server_url = ""
        metadata_url = ""
        token_endpoint = ""
        client_id = ""
        token_auth_method = TOKEN_AUTH_BASIC
        client_private_key = ""
        jwt_signing_alg = ""
        jwt_kid = ""

    requested_token_type = _clean_text(merged.get("requested_token_type"))
    if (
        auth_type == AUTH_OAUTH2_CC
        and auth_profile == AUTH_PROFILE_IUA
        and not requested_token_type
    ):
        requested_token_type = IUA_JWT_TOKEN_TYPE
    if auth_profile == AUTH_PROFILE_SMART:
        # SMART Backend Services uses plain client_credentials, not RFC 8693
        # token exchange — never send requested_token_type.
        requested_token_type = ""

    timeout_seconds = int(merged.get("timeout_seconds") or 30)
    timeout_seconds = max(1, min(timeout_seconds, 120))
    enabled = _bool_value(merged.get("enabled"), True)
    is_default = _bool_value(merged.get("is_default"), False)
    if is_default and not enabled:
        raise ValueError("default FHIR server must be enabled")

    # Optional path appended to base_url during probe / test workflows to verify
    # real data access (e.g. "metadata" or "Patient?_count=1"). Relative only.
    test_path = _clean_text(merged.get("test_path"))
    if test_path and "://" in test_path:
        raise ValueError(
            "test_path must be a path relative to the base URL, not an absolute URL"
        )

    # Admin default token strategy (per-server). Blank = global default (fresh).
    default_token_strategy = _clean_text(merged.get("default_token_strategy")).lower()
    if default_token_strategy and default_token_strategy not in TOKEN_STRATEGY_DEFAULTS:
        raise ValueError(
            "default_token_strategy must be one of: "
            + ", ".join(sorted(TOKEN_STRATEGY_DEFAULTS))
        )

    return {
        "server_key": server_key,
        "name": name,
        "description": _clean_text(merged.get("description")),
        "base_url": base_url,
        "test_path": test_path or None,
        "default_token_strategy": default_token_strategy or None,
        "enabled": enabled,
        "is_default": is_default,
        "auth_type": auth_type,
        "auth_profile": auth_profile,
        "auth_server_url": auth_server_url or None,
        "metadata_url": metadata_url or None,
        "token_endpoint": token_endpoint or None,
        "use_metadata": _bool_value(merged.get("use_metadata"), True),
        "client_id": client_id or None,
        "client_secret": client_secret or None,
        "token_auth_method": token_auth_method,
        "client_private_key": client_private_key or None,
        "jwt_signing_alg": jwt_signing_alg or None,
        "jwt_kid": jwt_kid or None,
        "scope": _clean_text(merged.get("scope")) or None,
        "resource": _clean_text(merged.get("resource")) or None,
        "requested_token_type": requested_token_type or None,
        "metadata_headers_json": _parse_headers(merged.get("metadata_headers_json")),
        "token_headers_json": _parse_headers(merged.get("token_headers_json")),
        "resource_headers_json": _parse_headers(merged.get("resource_headers_json")),
        "verify_tls": _bool_value(merged.get("verify_tls"), True),
        "timeout_seconds": timeout_seconds,
        "allowed_resource_types": allowed_resource_types,
        "allowed_operations": allowed_operations,
    }


def _server_public(row: asyncpg.Record | dict[str, Any]) -> dict[str, Any]:
    allowed_resource_types = _json_value(_row_get(row, "allowed_resource_types"), [])
    allowed_operations = _json_value(
        _row_get(row, "allowed_operations"), DEFAULT_OPERATIONS
    )
    capability_summary = _json_value(_row_get(row, "capability_summary_json"), {})
    return {
        "fhir_server_id": str(row["fhir_server_id"]),
        "server_key": row["server_key"],
        "name": row["name"],
        "description": _row_get(row, "description") or "",
        "base_url": row["base_url"],
        "test_path": _row_get(row, "test_path") or "",
        "default_token_strategy": _row_get(row, "default_token_strategy") or "",
        "enabled": bool(row["enabled"]),
        "is_default": bool(row["is_default"]),
        "auth_type": row["auth_type"],
        "auth_profile": _row_get(row, "auth_profile") or AUTH_PROFILE_NONE,
        "auth_server_url": _row_get(row, "auth_server_url") or "",
        "metadata_url": _row_get(row, "metadata_url") or "",
        "token_endpoint": _row_get(row, "token_endpoint") or "",
        "use_metadata": bool(row["use_metadata"]),
        "client_id": _row_get(row, "client_id") or "",
        "client_secret_configured": bool(_row_get(row, "client_secret_configured")),
        "token_auth_method": _row_get(row, "token_auth_method") or TOKEN_AUTH_BASIC,
        "client_private_key_configured": bool(
            _row_get(row, "client_private_key_configured")
        ),
        "jwt_signing_alg": _row_get(row, "jwt_signing_alg") or "",
        "jwt_kid": _row_get(row, "jwt_kid") or "",
        "client_public_jwk_configured": bool(_row_get(row, "client_public_jwk_json")),
        "scope": _row_get(row, "scope") or "",
        "resource": _row_get(row, "resource") or "",
        "requested_token_type": _row_get(row, "requested_token_type") or "",
        "metadata_headers_json": _json_value(
            _row_get(row, "metadata_headers_json"), {}
        ),
        "token_headers_json": _json_value(_row_get(row, "token_headers_json"), {}),
        "resource_headers_json": _json_value(
            _row_get(row, "resource_headers_json"), {}
        ),
        "verify_tls": bool(row["verify_tls"]),
        "timeout_seconds": int(row["timeout_seconds"]),
        "allowed_resource_types": allowed_resource_types,
        "allowed_operations": allowed_operations,
        "last_probe_status": _row_get(row, "last_probe_status") or "",
        "last_probe_at": _to_iso(_row_get(row, "last_probe_at")),
        "last_probe_error": _row_get(row, "last_probe_error") or "",
        "capability_summary": capability_summary,
        "created_by": _row_get(row, "created_by") or "",
        "created_at": _to_iso(_row_get(row, "created_at")),
        "updated_at": _to_iso(_row_get(row, "updated_at")),
    }


def server_mcp_summary(server: dict[str, Any]) -> dict[str, Any]:
    """Return only the FHIR server fields that an LLM needs to choose/call it.

    Includes non-sensitive auth metadata (whether auth is required, the profile
    and token method, the default token strategy), the configured probe/test path,
    and the last stored probe result. Secrets (client_secret, private key, JWK)
    are never included — this only ever reads ``_server_public`` output.
    """
    capability = server.get("capability_summary") or {}
    supported_resources = capability.get("supported_resources") or []
    auth_type = server.get("auth_type") or AUTH_NONE
    is_oauth = auth_type == AUTH_OAUTH2_CC
    auth: dict[str, Any] = {
        "required": auth_type != AUTH_NONE,
        "type": auth_type,
        "profile": server.get("auth_profile") or AUTH_PROFILE_NONE,
    }
    if is_oauth:
        auth["token_auth_method"] = server.get("token_auth_method") or TOKEN_AUTH_BASIC
        auth["token_strategy_default"] = resolve_token_strategy(
            TOKEN_STRATEGY_AUTO, server.get("default_token_strategy")
        )
        auth["uses_metadata"] = bool(server.get("use_metadata"))
        auth["scopes"] = server.get("scope") or ""
    last_status = server.get("last_probe_status") or ""
    return {
        "server_key": server["server_key"],
        "name": server["name"],
        "description": server.get("description") or "",
        "base_url": server["base_url"],
        "enabled": bool(server["enabled"]),
        "default": bool(server["is_default"]),
        "allowed_resource_types": server.get("allowed_resource_types") or [],
        "allowed_operations": server.get("allowed_operations") or DEFAULT_OPERATIONS,
        "fhir_version": capability.get("fhirVersion") or "",
        "supported_resources": [
            item.get("type")
            for item in supported_resources
            if isinstance(item, dict) and item.get("type")
        ],
        "auth": auth,
        "test_path": server.get("test_path") or "",
        "probe": {
            "status": last_status or "unknown",
            "ok": last_status == "ok",
            "checked_at": server.get("last_probe_at") or None,
            "error": (server.get("last_probe_error") or "")[:300],
        },
    }


def _server_private(row: asyncpg.Record | dict[str, Any]) -> dict[str, Any]:
    data = _server_public(row)
    data["client_secret"] = _row_get(row, "client_secret") or ""
    data["client_private_key"] = _row_get(row, "client_private_key") or ""
    return data


async def _admin_audit(
    conn: asyncpg.Connection,
    *,
    admin_user: str,
    action: str,
    target_id: str,
    payload: dict[str, Any],
) -> None:
    redacted = dict(payload)
    redacted.pop("client_secret", None)
    redacted.pop("client_private_key", None)
    await conn.execute(
        """
        INSERT INTO admin.admin_audit_log
            (admin_user, action, target_type, target_id, payload_json)
        VALUES ($1, $2, 'fhir_server', $3, $4::jsonb)
        """,
        admin_user,
        action,
        target_id,
        json.dumps(redacted, ensure_ascii=False),
    )


async def _fetch_server_row(
    conn: asyncpg.Connection,
    identifier: str,
    *,
    secret_key: str | None = None,
    include_disabled: bool = True,
) -> asyncpg.Record | None:
    disabled_sql = "" if include_disabled else "AND enabled = TRUE"
    if identifier.strip().lower() == "default":
        if secret_key:
            return await conn.fetchrow(
                f"""
                SELECT *,
                       (client_secret_ciphertext IS NOT NULL) AS client_secret_configured,
                       (client_private_key_ciphertext IS NOT NULL)
                           AS client_private_key_configured,
                       CASE
                         WHEN client_secret_ciphertext IS NULL THEN NULL
                         ELSE pgp_sym_decrypt(client_secret_ciphertext, $1)
                       END AS client_secret,
                       CASE
                         WHEN client_private_key_ciphertext IS NULL THEN NULL
                         ELSE pgp_sym_decrypt(client_private_key_ciphertext, $1)
                       END AS client_private_key
                FROM admin.fhir_servers
                WHERE is_default = TRUE
                  {disabled_sql}
                LIMIT 1
                """,
                secret_key,
            )
        return await conn.fetchrow(f"""
            SELECT *,
                   (client_secret_ciphertext IS NOT NULL) AS client_secret_configured,
                   (client_private_key_ciphertext IS NOT NULL)
                       AS client_private_key_configured
            FROM admin.fhir_servers
            WHERE is_default = TRUE
              {disabled_sql}
            LIMIT 1
            """)
    if secret_key:
        return await conn.fetchrow(
            f"""
            SELECT *,
                   (client_secret_ciphertext IS NOT NULL) AS client_secret_configured,
                   (client_private_key_ciphertext IS NOT NULL)
                       AS client_private_key_configured,
                   CASE
                     WHEN client_secret_ciphertext IS NULL THEN NULL
                     ELSE pgp_sym_decrypt(client_secret_ciphertext, $2)
                   END AS client_secret,
                   CASE
                     WHEN client_private_key_ciphertext IS NULL THEN NULL
                     ELSE pgp_sym_decrypt(client_private_key_ciphertext, $2)
                   END AS client_private_key
            FROM admin.fhir_servers
            WHERE (fhir_server_id::text = $1 OR server_key = lower($1) OR lower(name) = lower($1))
              {disabled_sql}
            """,
            identifier,
            secret_key,
        )
    return await conn.fetchrow(
        f"""
        SELECT *,
               (client_secret_ciphertext IS NOT NULL) AS client_secret_configured,
               (client_private_key_ciphertext IS NOT NULL)
                   AS client_private_key_configured
        FROM admin.fhir_servers
        WHERE (fhir_server_id::text = $1 OR server_key = lower($1) OR lower(name) = lower($1))
          {disabled_sql}
        """,
        identifier,
    )


async def list_fhir_servers(
    pool: PoolLike,
    *,
    include_disabled: bool = False,
) -> list[dict[str, Any]]:
    await ensure_fhir_server_schema(pool)
    where = "" if include_disabled else "WHERE enabled = TRUE"
    async with pool.acquire() as conn:
        rows = await conn.fetch(f"""
            SELECT *,
                   (client_secret_ciphertext IS NOT NULL) AS client_secret_configured,
                   (client_private_key_ciphertext IS NOT NULL)
                       AS client_private_key_configured
            FROM admin.fhir_servers
            {where}
            ORDER BY is_default DESC, server_key ASC
            """)
    return [_server_public(row) for row in rows]


async def get_fhir_server(
    pool: PoolLike,
    identifier: str,
) -> dict[str, Any] | None:
    await ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        row = await _fetch_server_row(conn, identifier)
    return _server_public(row) if row else None


async def export_fhir_servers(
    pool: PoolLike,
    *,
    secret_key: str,
    include_disabled: bool = True,
) -> list[dict[str, Any]]:
    """Like ``list_fhir_servers`` but includes the decrypted ``client_secret`` and
    ``client_private_key`` for each server — used by the admin export so a config
    can be moved/restored in full."""
    await ensure_fhir_server_schema(pool)
    where = "" if include_disabled else "WHERE enabled = TRUE"
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT *,
                   (client_secret_ciphertext IS NOT NULL) AS client_secret_configured,
                   (client_private_key_ciphertext IS NOT NULL)
                       AS client_private_key_configured,
                   CASE
                       WHEN client_secret_ciphertext IS NULL THEN NULL
                       ELSE pgp_sym_decrypt(client_secret_ciphertext, $1)
                   END AS client_secret,
                   CASE
                       WHEN client_private_key_ciphertext IS NULL THEN NULL
                       ELSE pgp_sym_decrypt(client_private_key_ciphertext, $1)
                   END AS client_private_key
            FROM admin.fhir_servers
            {where}
            ORDER BY is_default DESC, server_key ASC
            """,
            secret_key,
        )
    return [_server_private(row) for row in rows]


async def get_fhir_server_jwks(pool: PoolLike, server_id: str) -> dict[str, Any] | None:
    """Return the published ``{"keys": [...]}`` JWK set for a server, or None.

    Only servers authenticating with private_key_jwt and holding a stored public
    JWK publish a key set. Exposes the public key only — never the private key.
    """
    await ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT client_public_jwk_json, token_auth_method
            FROM admin.fhir_servers
            WHERE fhir_server_id::text = $1
            """,
            server_id,
        )
    if not row:
        return None
    if (_row_get(row, "token_auth_method") or "") != TOKEN_AUTH_PRIVATE_KEY_JWT:
        return None
    return _public_jwks_from_json(_row_get(row, "client_public_jwk_json"))


async def create_fhir_server(
    pool: PoolLike,
    payload: dict[str, Any],
    *,
    admin_user: str,
    secret_key: str,
) -> dict[str, Any]:
    await ensure_fhir_server_schema(pool)
    data = _validate_server_payload(payload)
    # Derive the public JWK + kid from the supplied private key (private_key_jwt).
    public_jwk_json, data["jwt_kid"] = _resolve_public_jwk(
        data["token_auth_method"],
        data["client_private_key"],
        data["jwt_signing_alg"],
        data["jwt_kid"],
    )
    # Optional: reuse a specific id (from an imported config) so the published
    # JWKS URL (/fhir-client/{id}/jwks.json) survives an export→re-import cycle.
    # Invalid/colliding ids fall back to a fresh generated id.
    import_id = _coerce_uuid(payload.get("fhir_server_id"))
    async with pool.acquire() as conn:
        async with conn.transaction():
            if import_id is not None:
                clash = await conn.fetchval(
                    "SELECT 1 FROM admin.fhir_servers WHERE fhir_server_id = $1::uuid",
                    import_id,
                )
                if clash:
                    import_id = None  # id already in use → let the DB generate one
            if data["is_default"]:
                await conn.execute("UPDATE admin.fhir_servers SET is_default = FALSE")
            row = await conn.fetchrow(
                """
                INSERT INTO admin.fhir_servers (
                    fhir_server_id,
                    server_key, name, description, base_url, enabled, is_default,
                    auth_type, auth_profile, auth_server_url, metadata_url,
                    token_endpoint, use_metadata, client_id, client_secret_ciphertext,
                    token_auth_method, client_private_key_ciphertext,
                    jwt_signing_alg, jwt_kid, client_public_jwk_json,
                    scope, resource, requested_token_type, token_headers_json,
                    resource_headers_json, verify_tls, timeout_seconds,
                    allowed_resource_types, allowed_operations, created_by, test_path,
                    default_token_strategy, metadata_headers_json
                )
                VALUES (
                    COALESCE($34::uuid, gen_random_uuid()),
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10,
                    $11, $12, $13,
                    CASE WHEN $14::text IS NULL OR $14 = ''
                         THEN NULL
                         ELSE pgp_sym_encrypt($14, $15)
                    END,
                    $16,
                    CASE WHEN $17::text IS NULL OR $17 = ''
                         THEN NULL
                         ELSE pgp_sym_encrypt($17, $15)
                    END,
                    $18, $19, $30,
                    $20, $21, $22, $23::jsonb,
                    $24::jsonb, $25, $26,
                    $27::jsonb, $28::jsonb, $29, $31, $32, $33::jsonb
                )
                RETURNING *, (client_secret_ciphertext IS NOT NULL) AS client_secret_configured
                """,
                data["server_key"],
                data["name"],
                data["description"],
                data["base_url"],
                data["enabled"],
                data["is_default"],
                data["auth_type"],
                data["auth_profile"],
                data["auth_server_url"],
                data["metadata_url"],
                data["token_endpoint"],
                data["use_metadata"],
                data["client_id"],
                data["client_secret"],
                secret_key,
                data["token_auth_method"],
                data["client_private_key"],
                data["jwt_signing_alg"],
                data["jwt_kid"],
                data["scope"],
                data["resource"],
                data["requested_token_type"],
                json.dumps(data["token_headers_json"], ensure_ascii=False),
                json.dumps(data["resource_headers_json"], ensure_ascii=False),
                data["verify_tls"],
                data["timeout_seconds"],
                json.dumps(data["allowed_resource_types"], ensure_ascii=False),
                json.dumps(data["allowed_operations"], ensure_ascii=False),
                admin_user,
                public_jwk_json,
                data["test_path"],
                data["default_token_strategy"],
                json.dumps(data["metadata_headers_json"], ensure_ascii=False),
                import_id,
            )
            await _admin_audit(
                conn,
                admin_user=admin_user,
                action="create_fhir_server",
                target_id=str(row["fhir_server_id"]),
                payload=data,
            )
    return _server_public(row)


async def update_fhir_server(
    pool: PoolLike,
    identifier: str,
    payload: dict[str, Any],
    *,
    admin_user: str,
    secret_key: str,
) -> dict[str, Any]:
    await ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        # Decrypt the existing private key too, so the published public JWK can be
        # (re)derived even when the admin edits without re-entering the key.
        existing_row = await _fetch_server_row(conn, identifier, secret_key=secret_key)
        if not existing_row:
            raise ValueError("FHIR server not found")
        existing = _server_public(existing_row)
        data = _validate_server_payload(payload, existing=existing)
        new_secret = _clean_text(payload.get("client_secret"))
        keep_secret = not new_secret and data["auth_type"] == AUTH_OAUTH2_CC
        new_private_key = _clean_text(payload.get("client_private_key"))
        # Preserve the stored private key only while it is still the active auth
        # method and no replacement was supplied; otherwise let it be cleared.
        keep_private_key = (
            not new_private_key
            and data["auth_type"] == AUTH_OAUTH2_CC
            and data["token_auth_method"] == TOKEN_AUTH_PRIVATE_KEY_JWT
        )
        # Effective private key for public-JWK derivation: the replacement if
        # supplied, else the kept stored key. Backfills the public JWK for
        # servers created before JWKS publishing existed.
        effective_private_key = new_private_key or (
            _row_get(existing_row, "client_private_key") if keep_private_key else ""
        )
        public_jwk_json, data["jwt_kid"] = _resolve_public_jwk(
            data["token_auth_method"],
            effective_private_key,
            data["jwt_signing_alg"],
            data["jwt_kid"],
        )
        async with conn.transaction():
            if data["is_default"]:
                await conn.execute(
                    "UPDATE admin.fhir_servers SET is_default = FALSE WHERE fhir_server_id <> $1",
                    existing["fhir_server_id"],
                )
            row = await conn.fetchrow(
                """
                UPDATE admin.fhir_servers
                SET server_key = $2,
                    name = $3,
                    description = $4,
                    base_url = $5,
                    enabled = $6,
                    is_default = $7,
                    auth_type = $8,
                    auth_profile = $9,
                    auth_server_url = $10,
                    metadata_url = $11,
                    token_endpoint = $12,
                    use_metadata = $13,
                    client_id = $14,
                    client_secret_ciphertext = CASE
                        WHEN $15::boolean THEN client_secret_ciphertext
                        WHEN $16::text IS NULL OR $16 = '' THEN NULL
                        ELSE pgp_sym_encrypt($16, $17)
                    END,
                    token_auth_method = $18,
                    client_private_key_ciphertext = CASE
                        WHEN $19::boolean THEN client_private_key_ciphertext
                        WHEN $20::text IS NULL OR $20 = '' THEN NULL
                        ELSE pgp_sym_encrypt($20, $17)
                    END,
                    jwt_signing_alg = $21,
                    jwt_kid = $22,
                    scope = $23,
                    resource = $24,
                    requested_token_type = $25,
                    token_headers_json = $26::jsonb,
                    resource_headers_json = $27::jsonb,
                    verify_tls = $28,
                    timeout_seconds = $29,
                    allowed_resource_types = $30::jsonb,
                    allowed_operations = $31::jsonb,
                    client_public_jwk_json = $32,
                    test_path = $33,
                    default_token_strategy = $34,
                    metadata_headers_json = $35::jsonb,
                    updated_at = NOW()
                WHERE fhir_server_id = $1
                RETURNING *, (client_secret_ciphertext IS NOT NULL) AS client_secret_configured
                """,
                existing["fhir_server_id"],
                data["server_key"],
                data["name"],
                data["description"],
                data["base_url"],
                data["enabled"],
                data["is_default"],
                data["auth_type"],
                data["auth_profile"],
                data["auth_server_url"],
                data["metadata_url"],
                data["token_endpoint"],
                data["use_metadata"],
                data["client_id"],
                keep_secret,
                data["client_secret"],
                secret_key,
                data["token_auth_method"],
                keep_private_key,
                data["client_private_key"],
                data["jwt_signing_alg"],
                data["jwt_kid"],
                data["scope"],
                data["resource"],
                data["requested_token_type"],
                json.dumps(data["token_headers_json"], ensure_ascii=False),
                json.dumps(data["resource_headers_json"], ensure_ascii=False),
                data["verify_tls"],
                data["timeout_seconds"],
                json.dumps(data["allowed_resource_types"], ensure_ascii=False),
                json.dumps(data["allowed_operations"], ensure_ascii=False),
                public_jwk_json,
                data["test_path"],
                data["default_token_strategy"],
                json.dumps(data["metadata_headers_json"], ensure_ascii=False),
            )
            _TOKEN_CACHE.pop(str(row["fhir_server_id"]), None)
            await _admin_audit(
                conn,
                admin_user=admin_user,
                action="update_fhir_server",
                target_id=str(row["fhir_server_id"]),
                payload=data,
            )
    return _server_public(row)


async def delete_fhir_server(
    pool: PoolLike,
    identifier: str,
    *,
    admin_user: str,
) -> dict[str, Any]:
    await ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        async with conn.transaction():
            existing = await _fetch_server_row(conn, identifier)
            if not existing:
                raise ValueError("FHIR server not found")
            row = await conn.fetchrow(
                """
                DELETE FROM admin.fhir_servers
                WHERE fhir_server_id = $1
                RETURNING *, (client_secret_ciphertext IS NOT NULL) AS client_secret_configured
                """,
                existing["fhir_server_id"],
            )
            await _admin_audit(
                conn,
                admin_user=admin_user,
                action="delete_fhir_server",
                target_id=str(row["fhir_server_id"]),
                payload={"server_key": row["server_key"], "name": row["name"]},
            )
    _TOKEN_CACHE.pop(str(row["fhir_server_id"]), None)
    return _server_public(row)


async def set_default_fhir_server(
    pool: PoolLike,
    identifier: str,
    *,
    admin_user: str,
) -> dict[str, Any]:
    await ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        async with conn.transaction():
            existing = await _fetch_server_row(conn, identifier)
            if not existing:
                raise ValueError("FHIR server not found")
            if not bool(existing["enabled"]):
                raise ValueError("default FHIR server must be enabled")
            await conn.execute("UPDATE admin.fhir_servers SET is_default = FALSE")
            row = await conn.fetchrow(
                """
                UPDATE admin.fhir_servers
                SET is_default = TRUE, updated_at = NOW()
                WHERE fhir_server_id = $1
                RETURNING *, (client_secret_ciphertext IS NOT NULL) AS client_secret_configured
                """,
                existing["fhir_server_id"],
            )
            await _admin_audit(
                conn,
                admin_user=admin_user,
                action="set_default_fhir_server",
                target_id=str(row["fhir_server_id"]),
                payload={"server_key": row["server_key"]},
            )
    return _server_public(row)


async def _fetch_metadata(server: dict[str, Any]) -> dict[str, Any]:
    metadata_url = _derive_metadata_url(
        server.get("auth_server_url") or "",
        server.get("metadata_url") or "",
        server.get("auth_profile") or AUTH_PROFILE_NONE,
    )
    if not metadata_url.strip("/"):
        return {}
    headers = {"Accept": "application/json"}
    headers.update(
        _parse_headers(server.get("metadata_headers_json"), allow_authorization=False)
    )
    async with httpx.AsyncClient(
        timeout=float(server["timeout_seconds"]),
        verify=bool(server["verify_tls"]),
    ) as client:
        response = await client.get(metadata_url, headers=headers)
    if response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(
            f"Authorization metadata returned HTTP {response.status_code}: {response.text[:500]}"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError("Authorization metadata returned non-JSON response") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Authorization metadata JSON must be an object")
    return payload


def _metadata_str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        text = str(item).strip()
        if text and text not in result:
            result.append(text)
    return result


async def discover_fhir_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    """Fetch the OAuth2/SMART discovery document for a draft config and return the
    advertised scopes and client-auth methods, for the admin form's scope picker.

    Raises ``ValueError`` when no metadata URL can be derived (so the caller can
    fall back to manual entry); ``RuntimeError`` on fetch/parse failures.
    """
    auth_profile = _clean_text(payload.get("auth_profile") or AUTH_PROFILE_NONE).lower()
    if auth_profile not in AUTH_PROFILES:
        auth_profile = AUTH_PROFILE_NONE
    server = {
        "auth_server_url": _validate_optional_url(
            _clean_text(payload.get("auth_server_url")), "auth_server_url"
        ),
        "metadata_url": _validate_optional_url(
            _clean_text(payload.get("metadata_url")), "metadata_url"
        ),
        "auth_profile": auth_profile,
        "verify_tls": _bool_value(payload.get("verify_tls"), True),
        "timeout_seconds": max(1, min(int(payload.get("timeout_seconds") or 30), 120)),
    }
    metadata_url = _derive_metadata_url(
        server["auth_server_url"], server["metadata_url"], auth_profile
    )
    if not metadata_url.strip("/"):
        raise ValueError("Provide a metadata URL or auth server URL first")

    metadata = await _fetch_metadata(server)
    return {
        "metadata_url": metadata_url,
        "scopes_supported": _metadata_str_list(metadata.get("scopes_supported")),
        "token_endpoint_auth_methods_supported": _metadata_str_list(
            metadata.get("token_endpoint_auth_methods_supported")
        ),
        "grant_types_supported": _metadata_str_list(
            metadata.get("grant_types_supported")
        ),
        "token_endpoint": str(metadata.get("token_endpoint") or ""),
    }


def _token_request_form(server: dict[str, Any]) -> dict[str, str]:
    """Build the OAuth2 client-credentials token-request form, framed by profile.

    SMART Backend Services names the FHIR audience ``aud`` and does not use RFC
    8693 token exchange; IUA / plain OAuth2 use the RFC 8707 ``resource``
    indicator and may request a specific ``requested_token_type``.
    """
    auth_profile = server.get("auth_profile") or AUTH_PROFILE_NONE
    form: dict[str, str] = {"grant_type": "client_credentials"}
    if server.get("scope"):
        form["scope"] = server["scope"]
    if server.get("resource"):
        if auth_profile == AUTH_PROFILE_SMART:
            form["aud"] = server["resource"]
        else:
            form["resource"] = server["resource"]
    if auth_profile != AUTH_PROFILE_SMART and server.get("requested_token_type"):
        form["requested_token_type"] = server["requested_token_type"]
    return form


def _build_client_assertion(server: dict[str, Any], token_endpoint: str) -> str:
    """Build a signed client-assertion JWT for client_secret_jwt / private_key_jwt.

    Per RFC 7523 and SMART Backend Services: iss/sub are the client_id, the
    audience is the token endpoint, and the assertion is short-lived with a
    unique jti.
    """
    client_id = server.get("client_id") or ""
    if not client_id:
        raise RuntimeError("client_id is required to build a client assertion")
    method = server.get("token_auth_method") or TOKEN_AUTH_BASIC
    now = int(time.time())
    claims = {
        "iss": client_id,
        "sub": client_id,
        "aud": token_endpoint,
        "jti": secrets.token_urlsafe(24),
        "iat": now,
        "exp": now + CLIENT_ASSERTION_LIFETIME_SECONDS,
    }
    headers = {"typ": "JWT"}
    if server.get("jwt_kid"):
        headers["kid"] = server["jwt_kid"]

    if method == TOKEN_AUTH_PRIVATE_KEY_JWT:
        private_key = server.get("client_private_key") or ""
        if not private_key:
            raise RuntimeError("private key is required for private_key_jwt")
        alg = server.get("jwt_signing_alg") or DEFAULT_PRIVATE_KEY_JWT_ALG
        try:
            return jwt.encode(claims, private_key, algorithm=alg, headers=headers)
        except Exception as exc:  # invalid/unsupported PEM, bad alg, etc.
            raise RuntimeError(
                f"Failed to sign private_key_jwt assertion: {exc}"
            ) from exc

    # client_secret_jwt — HMAC with the shared secret.
    secret = server.get("client_secret") or ""
    if not secret:
        raise RuntimeError("client_secret is required for client_secret_jwt")
    alg = server.get("jwt_signing_alg") or DEFAULT_SECRET_JWT_ALG
    return jwt.encode(claims, secret, algorithm=alg, headers=headers)


async def _fetch_token(
    server: dict[str, Any], metadata: dict[str, Any] | None = None
) -> tuple[str, int]:
    """Perform the client_credentials token request. Returns (access_token, ttl).

    Pure network call — no caching. Callers decide whether to store the result.
    """
    metadata = metadata or {}
    if (
        not metadata
        and server.get("use_metadata")
        and (server.get("metadata_url") or server.get("auth_server_url"))
    ):
        metadata = await _fetch_metadata(server)

    token_endpoint = (
        server.get("token_endpoint")
        or metadata.get("token_endpoint")
        or _derive_token_endpoint(server.get("auth_server_url") or "", "")
    )
    if not token_endpoint:
        raise RuntimeError("OAuth2 token endpoint is not configured")

    headers = {"Accept": "application/json"}
    headers.update(
        _parse_headers(server.get("token_headers_json"), allow_authorization=False)
    )
    form = _token_request_form(server)

    # Apply the configured token-endpoint client authentication method.
    method = server.get("token_auth_method") or TOKEN_AUTH_BASIC
    basic_auth: httpx.BasicAuth | None = None
    if method in TOKEN_AUTH_JWT_METHODS:
        # RFC 7521: the assertion identifies the client, but many servers still
        # require client_id in the body (it must match the assertion iss/sub).
        if server.get("client_id"):
            form["client_id"] = server["client_id"]
        form["client_assertion_type"] = CLIENT_ASSERTION_TYPE
        form["client_assertion"] = _build_client_assertion(server, token_endpoint)
    elif method == TOKEN_AUTH_POST:
        form["client_id"] = server.get("client_id") or ""
        form["client_secret"] = server.get("client_secret") or ""
    else:  # client_secret_basic
        basic_auth = httpx.BasicAuth(
            server.get("client_id") or "", server.get("client_secret") or ""
        )

    async with httpx.AsyncClient(
        timeout=float(server["timeout_seconds"]),
        verify=bool(server["verify_tls"]),
    ) as client:
        response = await client.post(
            token_endpoint,
            data=form,
            headers=headers,
            auth=basic_auth,
        )
    if response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(
            f"Token endpoint returned HTTP {response.status_code}: {response.text[:500]}"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError("Token endpoint returned non-JSON response") from exc
    if not isinstance(payload, dict) or not payload.get("access_token"):
        raise RuntimeError("Token response is missing access_token")
    token_type = str(payload.get("token_type") or "Bearer")
    if token_type.lower() != "bearer":
        raise RuntimeError(
            f"Token response token_type is {token_type!r}; expected Bearer"
        )
    access_token = str(payload["access_token"])
    expires_in = int(payload.get("expires_in") or 300)
    ttl = max(30, expires_in - TOKEN_CACHE_SKEW_SECONDS)
    return access_token, ttl


async def _access_token(
    server: dict[str, Any],
    *,
    metadata: dict[str, Any] | None = None,
    strategy: str = DEFAULT_TOKEN_STRATEGY,
) -> str:
    """Return an access token per the resolved strategy.

    ``cached`` shares one token per server across all callers (single-flight on a
    cold/expired cache); ``fresh`` fetches an isolated token that is never cached,
    so concurrent users never affect one another's tokens.
    """
    if server["auth_type"] != AUTH_OAUTH2_CC:
        return ""

    if strategy != TOKEN_STRATEGY_CACHED:
        # fresh — independent token, never read or written to the shared cache.
        token, _ttl = await _fetch_token(server, metadata)
        return token

    cache_key = str(server["fhir_server_id"])
    cached = _TOKEN_CACHE.get(cache_key)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    # Single-flight: only one coroutine fetches; the rest reuse the filled cache.
    async with _token_lock(cache_key):
        cached = _TOKEN_CACHE.get(cache_key)
        if cached and cached[0] > time.monotonic():
            return cached[1]
        token, ttl = await _fetch_token(server, metadata)
        _TOKEN_CACHE[cache_key] = (time.monotonic() + ttl, token)
        return token


def _fhir_url(server: dict[str, Any], path: str) -> str:
    return f"{server['base_url'].rstrip('/')}/{path.lstrip('/')}"


def _operation_to_request(
    operation: str,
    *,
    resource_type: str,
    resource_id: str,
    query: Any,
    resource: Any,
    patch: Any,
) -> tuple[str, str, dict[str, str], Any, str]:
    op = operation.strip().lower()
    if op not in ALLOWED_OPERATIONS:
        raise ValueError(
            f"operation must be one of: {', '.join(sorted(ALLOWED_OPERATIONS))}"
        )

    query_params = _normalize_query(query)
    body = None
    content_type = "application/fhir+json"

    if op == "metadata":
        return "GET", "metadata", {}, None, content_type

    rt = _validate_resource_type(resource_type)

    if op == "read":
        rid = _validate_resource_id(resource_id)
        return "GET", f"{rt}/{rid}", {}, None, content_type
    if op == "search":
        query_params.setdefault("_count", "50")
        return "GET", rt, query_params, None, content_type
    if op == "create":
        body = _normalize_json_body(resource, "resource_json")
        if body is None:
            raise ValueError("resource_json is required for create")
        return "POST", rt, {}, body, content_type
    if op == "update":
        rid = _validate_resource_id(resource_id)
        body = _normalize_json_body(resource, "resource_json")
        if body is None:
            raise ValueError("resource_json is required for update")
        return "PUT", f"{rt}/{rid}", {}, body, content_type
    if op == "patch":
        rid = _validate_resource_id(resource_id)
        body = _normalize_json_body(patch, "patch_json")
        if body is None:
            raise ValueError("patch_json is required for patch")
        if isinstance(body, list):
            content_type = "application/json-patch+json"
        return "PATCH", f"{rt}/{rid}", {}, body, content_type
    if op == "delete":
        rid = _validate_resource_id(resource_id)
        return "DELETE", f"{rt}/{rid}", {}, None, content_type

    raise ValueError(f"Unsupported operation: {operation}")


def _capability_summary(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    rest = payload.get("rest")
    resources: list[dict[str, Any]] = []
    if isinstance(rest, list):
        for rest_item in rest:
            if not isinstance(rest_item, dict):
                continue
            for res in rest_item.get("resource") or []:
                if not isinstance(res, dict) or not res.get("type"):
                    continue
                interactions = [
                    str(i.get("code"))
                    for i in (res.get("interaction") or [])
                    if isinstance(i, dict) and i.get("code")
                ]
                resources.append(
                    {
                        "type": str(res["type"]),
                        "profile": res.get("profile") or "",
                        "interactions": interactions,
                    }
                )
    resources = sorted(resources, key=lambda item: item["type"])
    return {
        "resourceType": payload.get("resourceType") or "",
        "fhirVersion": payload.get("fhirVersion") or "",
        "software": payload.get("software") or {},
        "implementation": payload.get("implementation") or {},
        "supported_resource_count": len(resources),
        "supported_resources": resources,
    }


def _http_error_explanation(status_code: int) -> str | None:
    if status_code == 401:
        return (
            "401 Unauthorized: token may be expired, invalid, scoped to the wrong "
            "audience/resource, or rejected by server policy."
        )
    if status_code == 403:
        return (
            "403 Forbidden: token is valid but not authorized for this FHIR operation."
        )
    return None


async def _call_fhir(
    server: dict[str, Any],
    *,
    operation: str,
    resource_type: str = "",
    resource_id: str = "",
    query: Any = None,
    resource: Any = None,
    patch: Any = None,
    token_strategy: str = DEFAULT_TOKEN_STRATEGY,
    token: str | None = None,
) -> dict[str, Any]:
    method, path, query_params, body, content_type = _operation_to_request(
        operation,
        resource_type=resource_type,
        resource_id=resource_id,
        query=query,
        resource=resource,
        patch=patch,
    )
    url = _fhir_url(server, path)
    headers = {
        "Accept": "application/fhir+json, application/json",
    }
    resource_headers = _parse_headers(
        server.get("resource_headers_json"),
        allow_authorization=False,
    )
    headers.update(resource_headers)
    if body is not None:
        headers["Content-Type"] = content_type
    # A pre-acquired token (passed by the connection workflow) is reused as-is to
    # avoid a redundant metadata+token round-trip; otherwise fetch per strategy.
    if token is None:
        token = await _access_token(server, strategy=token_strategy)
    if token:
        headers["Authorization"] = f"Bearer {token}"

    start = time.monotonic()
    async with httpx.AsyncClient(
        timeout=float(server["timeout_seconds"]),
        verify=bool(server["verify_tls"]),
    ) as client:
        response = await client.request(
            method,
            url,
            params=query_params or None,
            headers=headers,
            content=json.dumps(body, ensure_ascii=False) if body is not None else None,
        )
    duration_ms = int((time.monotonic() - start) * 1000)
    raw_text = response.text
    truncated = len(raw_text) > MAX_RESPONSE_CHARS
    parsed_json: Any = None
    if not truncated:
        try:
            parsed_json = response.json()
        except ValueError:
            parsed_json = None
    result = {
        "ok": 200 <= response.status_code < 300,
        "operation": operation,
        "method": method,
        "url": str(response.url),
        "status_code": response.status_code,
        "reason": response.reason_phrase,
        "duration_ms": duration_ms,
        "content_type": response.headers.get("content-type", ""),
        "truncated": truncated,
        "explanation": _http_error_explanation(response.status_code),
    }
    if parsed_json is not None:
        result["json"] = parsed_json
    else:
        result["text"] = raw_text[:MAX_RESPONSE_CHARS]
    return result


async def _probe_test_path(
    server: dict[str, Any],
    test_path: str,
    *,
    token_strategy: str = TOKEN_STRATEGY_FRESH,
    token: str | None = None,
) -> dict[str, Any]:
    """GET ``base_url`` + ``test_path`` with the acquired token, for probe/test.

    Bypasses the per-tool allowed_operations gate — this is an admin connectivity
    check, not an MCP tool call. Defaults to a fresh token (full re-auth). A
    pre-acquired ``token`` is reused as-is to avoid a redundant token round-trip.
    """
    url = _fhir_url(server, test_path)
    headers = {"Accept": "application/fhir+json, application/json"}
    headers.update(
        _parse_headers(server.get("resource_headers_json"), allow_authorization=False)
    )
    if token is None:
        token = await _access_token(server, strategy=token_strategy)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    start = time.monotonic()
    async with httpx.AsyncClient(
        timeout=float(server["timeout_seconds"]),
        verify=bool(server["verify_tls"]),
    ) as client:
        response = await client.get(url, headers=headers)
    return {
        "ok": 200 <= response.status_code < 300,
        "url": str(response.url),
        "status_code": response.status_code,
        "reason": response.reason_phrase,
        "duration_ms": int((time.monotonic() - start) * 1000),
        "explanation": _http_error_explanation(response.status_code),
    }


def _workflow_step(
    name: str,
    status: str,
    *,
    duration_ms: int | None = None,
    message: str = "",
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": name,
        "status": status,
        "message": message,
    }
    if duration_ms is not None:
        payload["duration_ms"] = duration_ms
    if details:
        payload["details"] = details
    return payload


async def _run_connection_workflow(server: dict[str, Any]) -> dict[str, Any]:
    """Test metadata discovery, token acquisition, and FHIR /metadata."""
    started = time.monotonic()
    steps: list[dict[str, Any]] = []
    metadata_payload: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    access_token: str | None = None

    try:
        if server["auth_type"] == AUTH_OAUTH2_CC:
            if server.get("use_metadata") and (
                server.get("metadata_url") or server.get("auth_server_url")
            ):
                step_started = time.monotonic()
                try:
                    metadata_payload = await _fetch_metadata(server)
                    grant_types = metadata_payload.get("grant_types_supported")
                    steps.append(
                        _workflow_step(
                            "oauth_metadata",
                            "ok",
                            duration_ms=int((time.monotonic() - step_started) * 1000),
                            message="Authorization metadata discovered",
                            details={
                                "token_endpoint_present": bool(
                                    metadata_payload.get("token_endpoint")
                                ),
                                "client_credentials_supported": (
                                    "client_credentials" in grant_types
                                    if isinstance(grant_types, list)
                                    else None
                                ),
                            },
                        )
                    )
                except Exception as exc:
                    steps.append(
                        _workflow_step(
                            "oauth_metadata",
                            "error",
                            duration_ms=int((time.monotonic() - step_started) * 1000),
                            message=str(exc),
                        )
                    )
                    raise
            else:
                steps.append(
                    _workflow_step(
                        "oauth_metadata",
                        "skipped",
                        message="Metadata discovery disabled or not configured",
                    )
                )

            step_started = time.monotonic()
            try:
                # Acquire once and reuse for the reachability probe below, so the
                # whole test is metadata → token → resource (no duplicate round).
                access_token = await _access_token(
                    server,
                    metadata=metadata_payload,
                    strategy=TOKEN_STRATEGY_FRESH,
                )
                steps.append(
                    _workflow_step(
                        "oauth_token",
                        "ok",
                        duration_ms=int((time.monotonic() - step_started) * 1000),
                        message="Client Credentials access token acquired",
                        details={
                            "auth_method": server.get("token_auth_method")
                            or TOKEN_AUTH_BASIC,
                            "auth_profile": server.get("auth_profile")
                            or AUTH_PROFILE_NONE,
                        },
                    )
                )
            except Exception as exc:
                steps.append(
                    _workflow_step(
                        "oauth_token",
                        "error",
                        duration_ms=int((time.monotonic() - step_started) * 1000),
                        message=str(exc),
                    )
                )
                raise
        else:
            steps.append(
                _workflow_step(
                    "oauth",
                    "skipped",
                    message="OAuth2 is disabled for this server",
                )
            )

        # FHIR reachability check. A configured test_path *replaces* the default
        # CapabilityStatement (/metadata) probe — only that one request is sent.
        test_path = (server.get("test_path") or "").strip()
        step_started = time.monotonic()
        if test_path:
            result = await _probe_test_path(
                server,
                test_path,
                token_strategy=TOKEN_STRATEGY_FRESH,
                token=access_token,
            )
            ok = bool(result["ok"])
            steps.append(
                _workflow_step(
                    "fhir_test_path",
                    "ok" if ok else "error",
                    duration_ms=int((time.monotonic() - step_started) * 1000),
                    message=(
                        f"Test path reachable (HTTP {result['status_code']})"
                        if ok
                        else f"Test path HTTP {result['status_code']}"
                    ),
                    details={
                        "path": test_path,
                        "url": result["url"],
                        "status_code": result["status_code"],
                        "reason": result.get("reason"),
                        "explanation": result.get("explanation"),
                    },
                )
            )
            capability_summary: dict[str, Any] = {}
        else:
            result = await _call_fhir(
                server,
                operation="metadata",
                token_strategy=TOKEN_STRATEGY_FRESH,
                token=access_token,
            )
            ok = bool(result["ok"])
            steps.append(
                _workflow_step(
                    "fhir_metadata",
                    "ok" if ok else "error",
                    duration_ms=int((time.monotonic() - step_started) * 1000),
                    message=(
                        "FHIR CapabilityStatement reachable"
                        if ok
                        else f"FHIR metadata HTTP {result['status_code']}"
                    ),
                    details={
                        "status_code": result["status_code"],
                        "reason": result.get("reason"),
                        "explanation": result.get("explanation"),
                    },
                )
            )
            capability_summary = _capability_summary(result.get("json"))

        return {
            "ok": ok,
            "probe": {
                "status": "ok" if ok else "error",
                "message": (
                    "Full connection workflow succeeded"
                    if ok
                    else f"FHIR {'test path' if test_path else 'metadata'} HTTP {result['status_code']}"
                ),
                "latency_ms": int((time.monotonic() - started) * 1000),
                "details": {"steps": steps},
            },
            "capability_summary": capability_summary,
            "raw_result": None if ok else result,
        }
    except Exception as exc:
        return {
            "ok": False,
            "probe": {
                "status": "error",
                "message": str(exc),
                "latency_ms": int((time.monotonic() - started) * 1000),
                "details": {"steps": steps, "error": str(exc)},
            },
            "capability_summary": {},
            "raw_result": result or {"ok": False, "error": str(exc)},
        }


async def probe_fhir_server(
    pool: PoolLike,
    identifier: str,
    *,
    secret_key: str,
) -> dict[str, Any]:
    await ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        row = await _fetch_server_row(conn, identifier, secret_key=secret_key)
    if not row:
        raise ValueError("FHIR server not found")
    server = _server_private(row)

    result = await _run_connection_workflow(server)
    status = str(result["probe"]["status"])
    message = str(result["probe"]["message"])
    latency_ms = int(result["probe"]["latency_ms"])
    details = result["probe"].get("details") or {}
    summary = result.get("capability_summary") or {}
    error = "" if result["ok"] else message

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE admin.fhir_servers
                SET last_probe_status = $2,
                    last_probe_at = NOW(),
                    last_probe_error = $3,
                    capability_summary_json = $4::jsonb,
                    updated_at = NOW()
                WHERE fhir_server_id = $1
                """,
                server["fhir_server_id"],
                status,
                error,
                json.dumps(summary, ensure_ascii=False),
            )
            await conn.execute(
                """
                INSERT INTO admin.fhir_server_probe_history
                    (fhir_server_id, status, endpoint, latency_ms, message, details_json)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                """,
                server["fhir_server_id"],
                status,
                server["base_url"],
                latency_ms,
                message,
                json.dumps(details, ensure_ascii=False),
            )
            refreshed = await _fetch_server_row(conn, server["fhir_server_id"])

    result.update(
        {
            "ok": status == "ok",
            "server": _server_public(refreshed),
        }
    )
    return {
        **result,
        "probe": {
            "status": status,
            "message": message,
            "latency_ms": latency_ms,
            "details": details,
        },
        "capability_summary": summary,
    }


async def test_fhir_server_config(
    pool: PoolLike,
    payload: dict[str, Any],
    *,
    secret_key: str,
) -> dict[str, Any]:
    """Test a draft Add/Edit form without saving it."""
    await ensure_fhir_server_schema(pool)
    existing_identifier = _clean_text(
        payload.get("fhir_server_id")
        or payload.get("existing_id")
        or payload.get("server_id")
    )
    existing_public: dict[str, Any] | None = None
    existing_secret = ""
    existing_private_key = ""
    if existing_identifier:
        async with pool.acquire() as conn:
            row = await _fetch_server_row(
                conn,
                existing_identifier,
                secret_key=secret_key,
            )
        if not row:
            raise ValueError("FHIR server not found")
        existing_public = _server_public(row)
        private = _server_private(row)
        existing_secret = private.get("client_secret") or ""
        existing_private_key = private.get("client_private_key") or ""

    data = _validate_server_payload(payload, existing=existing_public)
    client_secret = data.get("client_secret") or existing_secret
    client_private_key = data.get("client_private_key") or existing_private_key
    server = {
        "fhir_server_id": f"draft:{time.monotonic_ns()}",
        "server_key": data["server_key"],
        "name": data["name"],
        "description": data["description"],
        "base_url": data["base_url"],
        "test_path": data["test_path"] or "",
        "default_token_strategy": data["default_token_strategy"] or "",
        "enabled": data["enabled"],
        "is_default": data["is_default"],
        "auth_type": data["auth_type"],
        "auth_profile": data["auth_profile"],
        "auth_server_url": data["auth_server_url"] or "",
        "metadata_url": data["metadata_url"] or "",
        "token_endpoint": data["token_endpoint"] or "",
        "use_metadata": data["use_metadata"],
        "client_id": data["client_id"] or "",
        "client_secret": client_secret or "",
        "client_secret_configured": bool(client_secret),
        "token_auth_method": data["token_auth_method"],
        "client_private_key": client_private_key or "",
        "client_private_key_configured": bool(client_private_key),
        "jwt_signing_alg": data["jwt_signing_alg"] or "",
        "jwt_kid": data["jwt_kid"] or "",
        "scope": data["scope"] or "",
        "resource": data["resource"] or "",
        "requested_token_type": data["requested_token_type"] or "",
        "metadata_headers_json": data["metadata_headers_json"],
        "token_headers_json": data["token_headers_json"],
        "resource_headers_json": data["resource_headers_json"],
        "verify_tls": data["verify_tls"],
        "timeout_seconds": data["timeout_seconds"],
        "allowed_resource_types": data["allowed_resource_types"],
        "allowed_operations": data["allowed_operations"],
        "last_probe_status": "",
        "last_probe_at": None,
        "last_probe_error": "",
        "capability_summary_json": {},
        "created_by": "",
        "created_at": None,
        "updated_at": None,
    }
    try:
        result = await _run_connection_workflow(server)
        result["server_preview"] = _server_public(server)
        return result
    finally:
        _TOKEN_CACHE.pop(str(server["fhir_server_id"]), None)


async def perform_fhir_crud(
    pool: PoolLike,
    *,
    server_key: str,
    operation: str,
    resource_type: str = "",
    resource_id: str = "",
    query: Any = None,
    resource: Any = None,
    patch: Any = None,
    confirm_write: bool = False,
    secret_key: str,
    caller: str = "mcp",
    token_strategy: str = TOKEN_STRATEGY_AUTO,
) -> dict[str, Any]:
    await ensure_fhir_server_schema(pool)
    async with pool.acquire() as conn:
        row = await _fetch_server_row(
            conn,
            server_key,
            secret_key=secret_key,
            include_disabled=False,
        )
    if not row:
        raise ValueError("FHIR server not found or disabled")
    server = _server_private(row)
    # Resolve the effective token strategy: per-call request > server admin
    # default > global fresh. Each call is isolated, so concurrent users with
    # different strategies never interfere.
    effective_strategy = resolve_token_strategy(
        token_strategy, server.get("default_token_strategy")
    )

    op = operation.strip().lower()
    allowed_operations = set(server.get("allowed_operations") or DEFAULT_OPERATIONS)
    if op not in allowed_operations:
        raise ValueError(
            f"Operation '{op}' is not allowed for server '{server['server_key']}'"
        )
    if op in WRITE_OPERATIONS and not confirm_write:
        raise ValueError("Write operations require confirm_write=true")
    if op != "metadata":
        rt = _validate_resource_type(resource_type)
        allowed_types = set(server.get("allowed_resource_types") or [])
        if allowed_types and rt not in allowed_types:
            raise ValueError(
                f"Resource type '{rt}' is not allowed for server '{server['server_key']}'"
            )

    status_code = None
    success = False
    error = None
    duration_ms = None
    start = time.monotonic()
    try:
        result = await _call_fhir(
            server,
            operation=op,
            resource_type=resource_type,
            resource_id=resource_id,
            query=query,
            resource=resource,
            patch=patch,
            token_strategy=effective_strategy,
        )
        result["token_strategy"] = effective_strategy
        status_code = int(result["status_code"])
        duration_ms = int(result["duration_ms"])
        success = bool(result["ok"])
        return result
    except Exception as exc:
        error = str(exc)
        duration_ms = int((time.monotonic() - start) * 1000)
        raise
    finally:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO admin.fhir_server_operation_logs
                    (fhir_server_id, server_key, operation, resource_type,
                     resource_id, status_code, duration_ms, success,
                     error_message, caller)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                """,
                server["fhir_server_id"],
                server["server_key"],
                op,
                resource_type or None,
                resource_id or None,
                status_code,
                duration_ms,
                success,
                error,
                caller,
            )

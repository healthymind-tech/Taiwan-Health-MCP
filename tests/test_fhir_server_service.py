import json
import jwt
import pytest

from src import fhir_server_service as svc


def test_validate_oauth_payload_requires_secret() -> None:
    with pytest.raises(ValueError, match="client_secret"):
        svc._validate_server_payload(
            {
                "server_key": "hospital-a",
                "name": "Hospital A",
                "base_url": "https://fhir.example.test/fhir",
                "auth_type": "oauth2_client_credentials",
                "client_id": "client-a",
                "token_endpoint": "https://auth.example.test/token",
            }
        )


def _oauth_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "server_key": "hospital-a",
        "name": "Hospital A",
        "base_url": "https://fhir.example.test/fhir",
        "auth_type": "oauth2_client_credentials",
        "client_id": "client-a",
        "client_secret": "secret",
        "auth_server_url": "https://auth.example.test",
    }
    payload.update(overrides)
    return payload


def test_validate_iua_defaults_requested_token_type() -> None:
    data = svc._validate_server_payload(_oauth_payload(auth_profile="iua"))

    assert data["requested_token_type"] == svc.IUA_JWT_TOKEN_TYPE
    assert data["auth_profile"] == "iua"


def test_validate_legacy_enable_iua_maps_to_profile() -> None:
    data = svc._validate_server_payload(_oauth_payload(enable_iua=True))

    assert data["auth_profile"] == "iua"
    assert data["requested_token_type"] == svc.IUA_JWT_TOKEN_TYPE


def test_validate_smart_clears_requested_token_type() -> None:
    data = svc._validate_server_payload(
        _oauth_payload(
            auth_profile="smart",
            token_auth_method="client_secret_jwt",
            requested_token_type="urn:ietf:params:oauth:token-type:jwt",
        )
    )

    assert data["auth_profile"] == "smart"
    assert data["requested_token_type"] is None


def test_validate_rejects_unknown_profile() -> None:
    with pytest.raises(ValueError, match="auth_profile"):
        svc._validate_server_payload(_oauth_payload(auth_profile="bogus"))


def test_validate_non_oauth_forces_profile_none() -> None:
    data = svc._validate_server_payload(
        {
            "server_key": "open-server",
            "name": "Open",
            "base_url": "https://fhir.example.test/fhir",
            "auth_type": "none",
            "auth_profile": "iua",
        }
    )

    assert data["auth_profile"] == "none"


def test_smart_token_form_uses_aud_and_omits_token_type() -> None:
    form = svc._token_request_form(
        {
            "auth_profile": "smart",
            "scope": "system/*.rs",
            "resource": "https://fhir.example.test/fhir",
            "requested_token_type": "urn:ietf:params:oauth:token-type:jwt",
        }
    )

    assert form["aud"] == "https://fhir.example.test/fhir"
    assert "resource" not in form
    assert "requested_token_type" not in form
    assert form["scope"] == "system/*.rs"


def test_iua_token_form_uses_resource_and_token_type() -> None:
    form = svc._token_request_form(
        {
            "auth_profile": "iua",
            "resource": "https://fhir.example.test/fhir",
            "requested_token_type": svc.IUA_JWT_TOKEN_TYPE,
        }
    )

    assert form["resource"] == "https://fhir.example.test/fhir"
    assert "aud" not in form
    assert form["requested_token_type"] == svc.IUA_JWT_TOKEN_TYPE


def test_validate_private_key_jwt_requires_key() -> None:
    with pytest.raises(ValueError, match="client_private_key"):
        svc._validate_server_payload(
            {
                "server_key": "hospital-a",
                "name": "Hospital A",
                "base_url": "https://fhir.example.test/fhir",
                "auth_type": "oauth2_client_credentials",
                "auth_profile": "smart",
                "token_auth_method": "private_key_jwt",
                "client_id": "client-a",
                "token_endpoint": "https://auth.example.test/token",
            }
        )


def test_validate_private_key_jwt_defaults_alg() -> None:
    data = svc._validate_server_payload(
        _oauth_payload(
            auth_profile="smart",
            token_auth_method="private_key_jwt",
            client_private_key="-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
        )
    )

    assert data["token_auth_method"] == "private_key_jwt"
    assert data["jwt_signing_alg"] == svc.DEFAULT_PRIVATE_KEY_JWT_ALG


def test_validate_client_secret_jwt_rejects_asymmetric_alg() -> None:
    with pytest.raises(ValueError, match="jwt_signing_alg"):
        svc._validate_server_payload(
            _oauth_payload(
                auth_profile="smart",
                token_auth_method="client_secret_jwt",
                jwt_signing_alg="RS384",
            )
        )


def test_smart_profile_coerces_basic_to_private_key_jwt() -> None:
    data = svc._validate_server_payload(
        _oauth_payload(
            auth_profile="smart",
            token_auth_method="client_secret_basic",
            client_private_key="-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
        )
    )

    assert data["token_auth_method"] == "private_key_jwt"
    assert data["jwt_signing_alg"] == svc.DEFAULT_PRIVATE_KEY_JWT_ALG


def test_smart_profile_keeps_client_secret_jwt_choice() -> None:
    data = svc._validate_server_payload(
        _oauth_payload(
            auth_profile="smart",
            token_auth_method="client_secret_jwt",
        )
    )

    assert data["token_auth_method"] == "client_secret_jwt"


def test_validate_rejects_unknown_token_auth_method() -> None:
    with pytest.raises(ValueError, match="token_auth_method"):
        svc._validate_server_payload(
            _oauth_payload(token_auth_method="mutual_tls")
        )


def test_client_secret_jwt_assertion_has_expected_claims() -> None:
    server = {
        "client_id": "client-a",
        "client_secret": "supersecret",
        "token_auth_method": "client_secret_jwt",
        "jwt_signing_alg": "HS384",
    }
    token = svc._build_client_assertion(server, "https://auth.example.test/token")
    decoded = jwt.decode(
        token,
        "supersecret",
        algorithms=["HS384"],
        audience="https://auth.example.test/token",
    )
    assert decoded["iss"] == "client-a"
    assert decoded["sub"] == "client-a"
    assert decoded["aud"] == "https://auth.example.test/token"
    assert decoded["jti"]
    assert decoded["exp"] > decoded["iat"]


def test_access_token_form_carries_client_assertion(monkeypatch) -> None:
    server = {
        "auth_profile": "smart",
        "token_auth_method": "private_key_jwt",
        "client_id": "client-a",
        "resource": "https://fhir.example.test/fhir",
        "scope": "system/*.rs",
    }
    monkeypatch.setattr(
        svc, "_build_client_assertion", lambda srv, ep: "SIGNED.JWT.VALUE"
    )
    form = svc._token_request_form(server)
    method = server["token_auth_method"]
    # Mirror the branch _access_token applies after building the base form.
    if method in svc.TOKEN_AUTH_JWT_METHODS:
        form["client_assertion_type"] = svc.CLIENT_ASSERTION_TYPE
        form["client_assertion"] = svc._build_client_assertion(server, "https://t")
    assert form["aud"] == "https://fhir.example.test/fhir"
    assert form["client_assertion_type"] == svc.CLIENT_ASSERTION_TYPE
    assert form["client_assertion"] == "SIGNED.JWT.VALUE"


def test_derive_metadata_url_diverges_by_profile() -> None:
    base = "https://auth.example.test"
    assert svc._derive_metadata_url(base, "", "smart").endswith(
        "/.well-known/smart-configuration"
    )
    assert svc._derive_metadata_url(base, "", "iua").endswith(
        "/.well-known/oauth-authorization-server"
    )
    # An explicit metadata_url always wins, regardless of profile.
    assert (
        svc._derive_metadata_url(base, "https://meta.example.test/x", "smart")
        == "https://meta.example.test/x"
    )


def test_operation_to_request_rejects_unsafe_resource_id() -> None:
    with pytest.raises(ValueError, match="resource_id"):
        svc._operation_to_request(
            "read",
            resource_type="Patient",
            resource_id="../metadata",
            query=None,
            resource=None,
            patch=None,
        )


def test_operation_to_request_search_parses_json_query() -> None:
    method, path, query, body, content_type = svc._operation_to_request(
        "search",
        resource_type="Observation",
        resource_id="",
        query='{"patient":"123","code":"789-8"}',
        resource=None,
        patch=None,
    )

    assert method == "GET"
    assert path == "Observation"
    assert query == {"patient": "123", "code": "789-8", "_count": "50"}
    assert body is None
    assert content_type == "application/fhir+json"


def test_server_public_never_exposes_secret() -> None:
    public = svc._server_public(
        {
            "fhir_server_id": "00000000-0000-0000-0000-000000000001",
            "server_key": "hospital-a",
            "name": "Hospital A",
            "description": "",
            "base_url": "https://fhir.example.test/fhir",
            "enabled": True,
            "is_default": False,
            "auth_type": "oauth2_client_credentials",
            "auth_profile": "none",
            "auth_server_url": "",
            "metadata_url": "",
            "token_endpoint": "https://auth.example.test/token",
            "use_metadata": True,
            "client_id": "client-a",
            "client_secret": "secret",
            "client_secret_configured": True,
            "scope": "",
            "resource": "",
            "requested_token_type": "",
            "token_headers_json": {},
            "resource_headers_json": {},
            "verify_tls": True,
            "timeout_seconds": 30,
            "allowed_resource_types": ["Patient"],
            "allowed_operations": ["metadata", "read"],
            "last_probe_status": "",
            "last_probe_at": None,
            "last_probe_error": "",
            "capability_summary_json": {},
            "created_by": "admin",
            "created_at": None,
            "updated_at": None,
        }
    )

    assert public["client_secret_configured"] is True
    assert "client_secret" not in public


def test_mcp_summary_omits_auth_and_probe_details() -> None:
    summary = svc.server_mcp_summary(
        {
            "server_key": "hospital-a",
            "name": "Hospital A",
            "description": "Primary FHIR server",
            "base_url": "https://fhir.example.test/fhir",
            "enabled": True,
            "is_default": True,
            "auth_type": "oauth2_client_credentials",
            "auth_profile": "iua",
            "token_endpoint": "https://auth.example.test/token",
            "last_probe_status": "ok",
            "allowed_resource_types": ["Patient", "Observation"],
            "allowed_operations": ["metadata", "read", "search"],
            "capability_summary": {
                "fhirVersion": "4.0.1",
                "supported_resources": [
                    {"type": "Patient", "interactions": ["read", "search-type"]},
                    {"type": "Observation", "interactions": ["read"]},
                ],
            },
        }
    )

    assert summary["server_key"] == "hospital-a"
    assert summary["default"] is True
    assert summary["fhir_version"] == "4.0.1"
    assert summary["supported_resources"] == ["Patient", "Observation"]
    assert "auth_type" not in summary
    assert "auth_profile" not in summary
    assert "token_endpoint" not in summary
    assert "last_probe_status" not in summary


# ── private_key_jwt key generation / JWKS publishing ──────────────────────────

@pytest.mark.parametrize("alg", ["RS256", "RS384", "ES256", "ES384", "ES512", "PS384"])
def test_generate_client_key_signs_and_verifies(alg: str) -> None:
    material = svc.generate_client_key(alg)
    pem = material["private_key_pem"]
    public_jwk = material["public_jwk"]
    kid = material["kid"]

    # The published JWK carries the SMART-expected metadata.
    assert public_jwk["use"] == "sig"
    assert public_jwk["alg"] == alg
    assert public_jwk["kid"] == kid
    assert material["jwks"] == {"keys": [public_jwk]}

    # A token signed by the private key verifies against the published public JWK.
    token = jwt.encode(
        {"iss": "c", "sub": "c", "aud": "t"},
        pem,
        algorithm=alg,
        headers={"kid": kid},
    )
    key = jwt.PyJWK.from_dict(public_jwk).key
    decoded = jwt.decode(token, key, algorithms=[alg], audience="t")
    assert decoded["iss"] == "c"


def test_kid_is_stable_rfc7638_thumbprint() -> None:
    pem = svc.generate_keypair("RS384")
    jwk_a, kid_a = svc.derive_public_jwk(pem, "RS384")
    jwk_b, kid_b = svc.derive_public_jwk(pem, "RS384")
    assert kid_a == kid_b == svc.jwk_thumbprint(jwk_a)
    assert kid_a == svc.jwk_thumbprint(jwk_b)


def test_derive_public_jwk_honours_explicit_kid() -> None:
    pem = svc.generate_keypair("ES256")
    jwk, kid = svc.derive_public_jwk(pem, "ES256", kid="my-key-1")
    assert kid == "my-key-1"
    assert jwk["kid"] == "my-key-1"


def test_generate_client_key_rejects_symmetric_alg() -> None:
    with pytest.raises(ValueError, match="alg must be one of"):
        svc.generate_client_key("HS256")


def test_resolve_public_jwk_only_for_private_key_jwt() -> None:
    pem = svc.generate_keypair("RS384")
    # private_key_jwt → derives a JWK + thumbprint kid
    jwk_json, kid = svc._resolve_public_jwk("private_key_jwt", pem, "RS384", None)
    assert jwk_json is not None
    assert kid
    # other methods → no JWK published, kid preserved
    assert svc._resolve_public_jwk("client_secret_jwt", pem, "HS384", "k") == (None, "k")
    assert svc._resolve_public_jwk("client_secret_basic", "", "", None) == (None, None)
    # private_key_jwt but no key available → nothing to publish
    assert svc._resolve_public_jwk("private_key_jwt", "", "RS384", "k") == (None, "k")


def test_public_jwks_from_json_wraps_or_ignores() -> None:
    pem = svc.generate_keypair("RS384")
    jwk_json, _ = svc._resolve_public_jwk("private_key_jwt", pem, "RS384", None)
    wrapped = svc._public_jwks_from_json(jwk_json)
    assert wrapped is not None
    assert wrapped["keys"][0]["kty"] == "RSA"
    # Empty / malformed inputs publish nothing rather than raising.
    assert svc._public_jwks_from_json(None) is None
    assert svc._public_jwks_from_json("") is None
    assert svc._public_jwks_from_json("not-json") is None
    assert svc._public_jwks_from_json("{}") is None


# ── probe/test path ───────────────────────────────────────────────────────────

def test_validate_accepts_relative_test_path() -> None:
    data = svc._validate_server_payload(_oauth_payload(test_path="Patient?_count=1"))
    assert data["test_path"] == "Patient?_count=1"


def test_validate_rejects_absolute_test_path() -> None:
    with pytest.raises(ValueError, match="relative to the base URL"):
        svc._validate_server_payload(
            _oauth_payload(test_path="https://evil.example/Patient")
        )


def test_validate_blank_test_path_is_none() -> None:
    data = svc._validate_server_payload(_oauth_payload())
    assert data["test_path"] is None


# ── token strategy (fresh / cached / auto) ────────────────────────────────────

def test_resolve_token_strategy_precedence() -> None:
    # Explicit per-call request wins.
    assert svc.resolve_token_strategy("fresh", "cached") == "fresh"
    assert svc.resolve_token_strategy("cached", "fresh") == "cached"
    # auto / blank / invalid → server default.
    assert svc.resolve_token_strategy("auto", "cached") == "cached"
    assert svc.resolve_token_strategy("", "cached") == "cached"
    assert svc.resolve_token_strategy("bogus", "cached") == "cached"
    # No server default → global default (fresh).
    assert svc.resolve_token_strategy("auto", None) == "fresh"
    assert svc.resolve_token_strategy("auto", "") == "fresh"
    assert svc.resolve_token_strategy("auto", "bogus") == "fresh"


def _oauth_server(server_id: str = "srv-1") -> dict[str, object]:
    return {
        "fhir_server_id": server_id,
        "auth_type": svc.AUTH_OAUTH2_CC,
        "timeout_seconds": 30,
        "verify_tls": True,
    }


def test_fresh_strategy_never_touches_cache(monkeypatch) -> None:
    import asyncio

    svc._TOKEN_CACHE.clear()
    calls = {"n": 0}

    async def fake_fetch(server, metadata=None):
        calls["n"] += 1
        return f"tok-{calls['n']}", 300

    monkeypatch.setattr(svc, "_fetch_token", fake_fetch)
    server = _oauth_server()

    async def run():
        t1 = await svc._access_token(server, strategy="fresh")
        t2 = await svc._access_token(server, strategy="fresh")
        return t1, t2

    t1, t2 = asyncio.run(run())
    # Every fresh call fetches a new token; nothing is cached.
    assert t1 == "tok-1" and t2 == "tok-2"
    assert calls["n"] == 2
    assert "srv-1" not in svc._TOKEN_CACHE


def test_cached_strategy_reuses_and_single_flights(monkeypatch) -> None:
    import asyncio

    svc._TOKEN_CACHE.clear()
    svc._TOKEN_LOCKS.clear()
    calls = {"n": 0}

    async def fake_fetch(server, metadata=None):
        calls["n"] += 1
        await asyncio.sleep(0.01)  # widen the race window
        return "shared-token", 300

    monkeypatch.setattr(svc, "_fetch_token", fake_fetch)
    server = _oauth_server("srv-2")

    async def run():
        # 5 concurrent cached calls on a cold cache → single-flight = 1 fetch.
        results = await asyncio.gather(
            *[svc._access_token(server, strategy="cached") for _ in range(5)]
        )
        # A subsequent call reuses the cached token (still 1 fetch total).
        again = await svc._access_token(server, strategy="cached")
        return results, again

    results, again = asyncio.run(run())
    assert results == ["shared-token"] * 5
    assert again == "shared-token"
    assert calls["n"] == 1
    assert "srv-2" in svc._TOKEN_CACHE


def test_non_oauth_returns_empty_token() -> None:
    import asyncio

    server = {"fhir_server_id": "x", "auth_type": svc.AUTH_NONE}
    assert asyncio.run(svc._access_token(server, strategy="cached")) == ""


def test_validate_rejects_bad_default_token_strategy() -> None:
    with pytest.raises(ValueError, match="default_token_strategy"):
        svc._validate_server_payload(_oauth_payload(default_token_strategy="sometimes"))


def test_validate_accepts_default_token_strategy() -> None:
    data = svc._validate_server_payload(_oauth_payload(default_token_strategy="cached"))
    assert data["default_token_strategy"] == "cached"
    blank = svc._validate_server_payload(_oauth_payload())
    assert blank["default_token_strategy"] is None


# ── server_mcp_summary enrichment (LLM-visible status) ────────────────────────

def _public_server(**overrides):
    base = {
        "server_key": "hospital-a",
        "name": "Hospital A",
        "description": "",
        "base_url": "https://fhir.example.test/fhir",
        "enabled": True,
        "is_default": True,
        "auth_type": svc.AUTH_OAUTH2_CC,
        "auth_profile": "smart",
        "token_auth_method": "private_key_jwt",
        "default_token_strategy": "",
        "use_metadata": True,
        "scope": "system/*.rs",
        "test_path": "Patient?_count=1",
        "client_id": "client-a",
        "client_secret_configured": True,
        "client_private_key_configured": True,
        "last_probe_status": "ok",
        "last_probe_at": "2026-06-06T00:00:00+00:00",
        "last_probe_error": "",
        "capability_summary": {"fhirVersion": "4.0.1", "supported_resources": [{"type": "Patient"}]},
        "allowed_resource_types": ["Patient"],
        "allowed_operations": ["metadata", "read", "search"],
    }
    base.update(overrides)
    return base


def test_mcp_summary_exposes_auth_test_path_probe() -> None:
    out = svc.server_mcp_summary(_public_server())
    assert out["auth"]["required"] is True
    assert out["auth"]["profile"] == "smart"
    assert out["auth"]["token_auth_method"] == "private_key_jwt"
    assert out["auth"]["token_strategy_default"] == "fresh"  # blank default -> fresh
    assert out["auth"]["scopes"] == "system/*.rs"
    assert out["test_path"] == "Patient?_count=1"
    assert out["probe"] == {
        "status": "ok",
        "ok": True,
        "checked_at": "2026-06-06T00:00:00+00:00",
        "error": "",
    }
    assert out["fhir_version"] == "4.0.1"
    assert out["supported_resources"] == ["Patient"]


def test_mcp_summary_never_leaks_secrets() -> None:
    out = svc.server_mcp_summary(
        _public_server(client_secret="SUPER", client_private_key="PEM")
    )
    flat = json.dumps(out)
    for forbidden in ("SUPER", "PEM", "client_secret", "client_private_key", "client_id", "token_endpoint"):
        assert forbidden not in flat


def test_mcp_summary_no_auth_server_omits_oauth_fields() -> None:
    out = svc.server_mcp_summary(_public_server(auth_type=svc.AUTH_NONE, auth_profile="none"))
    assert out["auth"]["required"] is False
    assert "token_auth_method" not in out["auth"]
    assert out["probe"]["status"] in {"ok", "unknown", "error"}


def test_mcp_summary_default_strategy_carries_through() -> None:
    out = svc.server_mcp_summary(_public_server(default_token_strategy="cached"))
    assert out["auth"]["token_strategy_default"] == "cached"


# ── metadata discovery custom headers ─────────────────────────────────────────

def test_validate_parses_metadata_headers() -> None:
    data = svc._validate_server_payload(
        _oauth_payload(metadata_headers_json={"X-Api-Key": "abc"})
    )
    assert data["metadata_headers_json"] == {"X-Api-Key": "abc"}


def test_validate_metadata_headers_reject_authorization() -> None:
    # Authorization is reserved for the auth flow and cannot be set by hand.
    with pytest.raises(ValueError, match="Authorization"):
        svc._validate_server_payload(
            _oauth_payload(metadata_headers_json={"Authorization": "Bearer x"})
        )


def test_fetch_metadata_applies_custom_headers(monkeypatch) -> None:
    import asyncio

    captured: dict[str, dict[str, str]] = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"token_endpoint": "https://auth.example.test/token"}

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None):
            captured["headers"] = headers or {}
            return _Resp()

    monkeypatch.setattr(svc.httpx, "AsyncClient", _FakeClient)
    server = {
        "auth_server_url": "https://auth.example.test",
        "metadata_url": "https://auth.example.test/.well-known/openid-configuration",
        "auth_profile": "smart",
        "timeout_seconds": 30,
        "verify_tls": True,
        "metadata_headers_json": {"X-Api-Key": "abc"},
    }
    payload = asyncio.run(svc._fetch_metadata(server))
    assert payload["token_endpoint"] == "https://auth.example.test/token"
    assert captured["headers"]["X-Api-Key"] == "abc"
    assert captured["headers"]["Accept"] == "application/json"


def test_coerce_uuid_accepts_valid_and_rejects_junk() -> None:
    # A valid UUID round-trips to canonical form; anything else → None, so an
    # imported config can preserve its id without trusting the input format.
    valid = "123E4567-E89B-12D3-A456-426614174000"
    assert svc._coerce_uuid(valid) == "123e4567-e89b-12d3-a456-426614174000"
    assert svc._coerce_uuid("") is None
    assert svc._coerce_uuid(None) is None
    assert svc._coerce_uuid("not-a-uuid") is None
    assert svc._coerce_uuid("12345") is None

import hashlib
import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from admin_console import (
    AdminOverviewPayload,
    build_admin_session_token,
    parse_admin_session_token,
    verify_admin_password,
)
from admin_schedule import ScheduleConfig
import server


def _sha256_hash(password: str) -> str:
    return f"sha256${hashlib.sha256(password.encode('utf-8')).hexdigest()}"


def _dummy_overview() -> AdminOverviewPayload:
    return AdminOverviewPayload(
        generated_at="2026-05-29T12:00:00+00:00",
        app={
            "transport": "streamable-http",
            "mcp_path": "/mcp",
            "admin_enabled": True,
            "admin_ready": True,
            "admin_username": "admin",
            "uptime": "1m 0s",
        },
        infrastructure={
            "database": {"status": "ok", "detail": "PostgreSQL reachable"},
            "redis": {"status": "ok", "detail": "Redis reachable"},
            "minio": {"status": "degraded", "detail": "MinIO disabled by configuration"},
            "mcp": {"status": "ok", "detail": "ready"},
        },
        modules={
            "drug": {"ready": True, "row_count": 1200, "threshold": 1000},
            "icd": {"ready": False, "row_count": 0, "threshold": 10000},
        },
        services={
            "drug": {"initialized": True, "module_ready": True},
            "icd": {"initialized": False, "module_ready": False},
        },
        jobs={
            "queued": 1,
            "running": 0,
            "success": 2,
            "failed": 0,
            "paused": 0,
            "stopped": 0,
        },
        workers=[
            {
                "worker_name": "admin-worker",
                "process_id": 123,
                "status": "idle",
                "current_job_id": "",
                "last_heartbeat_at": "2026-05-29T12:00:00+00:00",
                "stale": False,
                "details": {"phase": 2},
            }
        ],
        summary={
            "overall_status": "degraded",
            "modules_ready": 1,
            "modules_total": 2,
            "services_initialized": 1,
            "services_total": 2,
            "infrastructure_healthy": 3,
            "infrastructure_total": 4,
        },
    )


def _dummy_service_probes() -> dict[str, object]:
    return {
        "generated_at": "2026-05-29T12:01:00+00:00",
        "services": [
            {
                "service_key": "embedding_model",
                "label": "Embedding Model",
                "category": "ml",
                "description": "Semantic-search embedding endpoint.",
                "status": "ok",
                "endpoint": "http://ollama.local/api/version",
                "latency_ms": 42,
                "message": "Embedding endpoint reachable for model qwen3-embedding:0.6b.",
                "details": {"model": "qwen3-embedding:0.6b"},
                "checked_at": "2026-05-29T12:01:00+00:00",
            },
            {
                "service_key": "ocr_server",
                "label": "OCR Server",
                "category": "ml",
                "description": "Vision/OCR backend for drug insert PDFs.",
                "status": "error",
                "endpoint": "http://ocr.local/health",
                "latency_ms": None,
                "message": "OCR server probe failed: timeout",
                "details": {"error_type": "ConnectTimeout"},
                "checked_at": "2026-05-29T12:01:00+00:00",
            },
        ],
        "history": [
            {
                "service_key": "embedding_model",
                "label": "Embedding Model",
                "category": "ml",
                "description": "Semantic-search embedding endpoint.",
                "status": "ok",
                "endpoint": "http://ollama.local/api/version",
                "latency_ms": 41,
                "message": "Embedding endpoint reachable for model qwen3-embedding:0.6b.",
                "details": {"model": "qwen3-embedding:0.6b"},
                "checked_at": "2026-05-29T12:00:30+00:00",
            }
        ],
        "summary": {
            "total": 7,
            "ok": 1,
            "degraded": 5,
            "error": 1,
            "last_checked_at": "2026-05-29T12:01:00+00:00",
        },
    }


@pytest.fixture
def admin_config(monkeypatch):
    monkeypatch.setattr(server.config, "admin_enabled", True)
    monkeypatch.setattr(server.config, "admin_username", "admin")
    monkeypatch.setattr(server.config, "admin_password_hash", _sha256_hash("secret"))
    monkeypatch.setattr(server.config, "admin_session_secret", "unit-test-secret")
    monkeypatch.setattr(server.config, "admin_session_ttl_minutes", 30)
    monkeypatch.setattr(server.config, "admin_max_upload_mb", 16)


@pytest.mark.asyncio
async def test_admin_requires_login(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload", AsyncMock())
    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/admin", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/admin/login"


@pytest.mark.asyncio
async def test_admin_login_and_overview_api(admin_config, monkeypatch):
    monkeypatch.setattr(
        server,
        "_build_admin_overview_payload",
        AsyncMock(return_value=_dummy_overview()),
    )
    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303
        assert login.headers["location"] == "/admin"
        assert "set-cookie" in login.headers

        api_response = await client.get("/admin/api/overview")
        assert api_response.status_code == 200
        payload = api_response.json()
        assert payload["app"]["admin_enabled"] is True
        assert payload["modules"]["drug"]["ready"] is True
        assert payload["jobs"]["queued"] == 1
        assert payload["workers"][0]["worker_name"] == "admin-worker"


@pytest.mark.asyncio
async def test_admin_spa_serving(admin_config, monkeypatch):
    """/admin and its client-side routes serve the SPA shell, hashed assets are
    served from dist/, and missing static files 404."""

    def fake_load_spa_file(rel):
        if rel == "index.html":
            return (b'<div id="root"></div>', "text/html; charset=utf-8")
        if rel == "assets/app.js":
            return (b"console.log(1)", "application/javascript")
        return None

    monkeypatch.setattr(server, "_load_spa_file", fake_load_spa_file)

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        # Root and a client-side route both return the SPA shell.
        for path in ("/admin", "/admin/modules"):
            resp = await client.get(path)
            assert resp.status_code == 200
            assert 'id="root"' in resp.text

        # Hashed asset is served from dist/.
        asset = await client.get("/admin/assets/app.js")
        assert asset.status_code == 200
        assert asset.content == b"console.log(1)"

        # Unknown static file (has an extension) 404s rather than serving HTML.
        missing = await client.get("/admin/assets/missing.js")
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_admin_jobs_endpoints(admin_config, monkeypatch):
    monkeypatch.setattr(
        server,
        "_build_admin_overview_payload",
        AsyncMock(return_value=_dummy_overview()),
    )
    monkeypatch.setattr(
        server,
        "list_admin_jobs",
        AsyncMock(return_value=[{"job_id": "job-1", "job_type": "noop", "status": "queued"}]),
    )
    monkeypatch.setattr(
        server,
        "list_worker_heartbeats",
        AsyncMock(return_value=[{"worker_name": "admin-worker", "stale": False}]),
    )
    monkeypatch.setattr(
        server,
        "create_admin_job",
        AsyncMock(return_value={"job_id": "job-2", "job_type": "noop", "status": "queued"}),
    )
    monkeypatch.setattr(
        server,
        "get_admin_job",
        AsyncMock(
            return_value={
                "job_id": "job-1",
                "job_type": "noop",
                "status": "paused",
                "control_state": "paused",
                "available_actions": ["resume", "stop", "restart"],
            }
        ),
    )
    monkeypatch.setattr(
        server,
        "list_job_steps",
        AsyncMock(
            return_value=[
                {
                    "job_step_id": 1,
                    "step_key": "noop",
                    "status": "paused",
                    "progress_current": 2,
                    "progress_total": 5,
                }
            ]
        ),
    )
    monkeypatch.setattr(
        server,
        "list_job_logs",
        AsyncMock(
            return_value=[
                {
                    "job_log_id": 1,
                    "level": "info",
                    "message": "checkpoint reached",
                    "created_at": "2026-05-29T12:00:00+00:00",
                }
            ]
        ),
    )
    monkeypatch.setattr(
        server,
        "request_job_control",
        AsyncMock(
            return_value={
                "job": {
                    "job_id": "job-1",
                    "job_type": "noop",
                    "status": "queued",
                    "control_state": "resume_requested",
                    "available_actions": [],
                },
                "control_request": {
                    "control_request_id": 9,
                    "action": "resume",
                    "result_status": "applied",
                    "result_message": "Paused job re-queued for resume.",
                },
                "restart_job": None,
            }
        ),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        jobs_response = await client.get("/admin/api/jobs")
        assert jobs_response.status_code == 200
        assert jobs_response.json()["jobs"][0]["job_type"] == "noop"

        workers_response = await client.get("/admin/api/workers")
        assert workers_response.status_code == 200
        assert workers_response.json()["workers"][0]["worker_name"] == "admin-worker"

        create_response = await client.post(
            "/admin/api/jobs",
            json={"module_key": "admin", "job_type": "noop", "job_options": {"note": "test"}},
        )
        assert create_response.status_code == 201
        assert create_response.json()["job"]["job_id"] == "job-2"

        detail_response = await client.get("/admin/api/jobs/00000000-0000-0000-0000-000000000001")
        assert detail_response.status_code == 200
        assert detail_response.json()["job"]["status"] == "paused"

        steps_response = await client.get("/admin/api/jobs/00000000-0000-0000-0000-000000000001/steps")
        assert steps_response.status_code == 200
        assert steps_response.json()["steps"][0]["step_key"] == "noop"

        logs_response = await client.get("/admin/api/jobs/00000000-0000-0000-0000-000000000001/logs")
        assert logs_response.status_code == 200
        assert logs_response.json()["logs"][0]["message"] == "checkpoint reached"

        control_response = await client.post("/admin/api/jobs/00000000-0000-0000-0000-000000000001/resume")
        assert control_response.status_code == 200
        assert control_response.json()["control_request"]["action"] == "resume"


@pytest.mark.asyncio
async def test_admin_service_probe_endpoints(admin_config, monkeypatch):
    monkeypatch.setattr(
        server,
        "_build_admin_overview_payload",
        AsyncMock(return_value=_dummy_overview()),
    )
    monkeypatch.setattr(
        server,
        "list_service_probes",
        AsyncMock(return_value=_dummy_service_probes()),
    )
    monkeypatch.setattr(
        server,
        "run_service_probes",
        AsyncMock(return_value=_dummy_service_probes()),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        cached_response = await client.get("/admin/api/services")
        assert cached_response.status_code == 200
        cached_payload = cached_response.json()
        assert cached_payload["services"][0]["service_key"] == "embedding_model"
        assert cached_payload["summary"]["error"] == 1

        probe_response = await client.post(
            "/admin/api/services/probe",
            json={"service_keys": ["embedding_model", "ocr_server"]},
        )
        assert probe_response.status_code == 200
        probe_payload = probe_response.json()
        assert probe_payload["services"][1]["service_key"] == "ocr_server"


@pytest.mark.asyncio
async def test_admin_service_probe_validation_returns_400(admin_config, monkeypatch):
    monkeypatch.setattr(
        server,
        "_build_admin_overview_payload",
        AsyncMock(return_value=_dummy_overview()),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        response = await client.post(
            "/admin/api/services/probe",
            json={"service_keys": "embedding_model"},
        )
        assert response.status_code == 400
        assert "service_keys must be an array" in response.json()["error"]


@pytest.mark.asyncio
async def test_admin_module_source_endpoints(admin_config, monkeypatch):
    monkeypatch.setattr(
        server,
        "_build_admin_overview_payload",
        AsyncMock(return_value=_dummy_overview()),
    )
    monkeypatch.setattr(
        server,
        "list_source_catalog",
        AsyncMock(
            return_value=[
                {
                    "module_key": "drug",
                    "source_role": "drug_index_csv",
                    "label": "Drug index CSV",
                    "description": "36_2.csv",
                    "accepted_extensions": [".csv"],
                    "active_source": None,
                    "recent_uploads": [],
                }
            ]
        ),
    )
    monkeypatch.setattr(
        server,
        "create_uploaded_source",
        AsyncMock(
            return_value={
                "duplicate": False,
                "uploaded_file": {
                    "uploaded_file_id": "upload-1",
                    "original_filename": "36_2.csv",
                    "sha256": "abc123",
                    "is_active": True,
                },
            }
        ),
    )
    monkeypatch.setattr(
        server,
        "activate_source",
        AsyncMock(
            return_value={
                "module_source_id": "ds-1",
                "module_key": "drug",
                "source_role": "drug_index_csv",
                "uploaded_file_id": "upload-1",
                "is_active": True,
                "activated_at": "2026-05-29T12:00:00+00:00",
            }
        ),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        modules_response = await client.get("/admin/api/modules")
        assert modules_response.status_code == 200
        modules_payload = modules_response.json()
        assert modules_payload["modules"][0]["module_key"] == "drug"
        assert modules_payload["upload_limits"]["max_upload_mb"] == 16

        upload_response = await client.post(
            "/admin/api/uploads?module_key=drug&source_role=drug_index_csv&filename=36_2.csv&auto_activate=true",
            content=b"license,data\n1,test\n",
            headers={"content-type": "text/csv"},
        )
        assert upload_response.status_code == 201
        assert upload_response.json()["uploaded_file"]["uploaded_file_id"] == "upload-1"

        activate_response = await client.post(
            "/admin/api/module-sources/activate",
            json={"uploaded_file_id": "upload-1"},
        )
        assert activate_response.status_code == 200
        assert activate_response.json()["module_source"]["module_key"] == "drug"


@pytest.mark.asyncio
async def test_admin_maintenance_toggle(admin_config, monkeypatch):
    import admin_maintenance

    set_mock = AsyncMock(return_value=True)
    broadcast_mock = AsyncMock()
    monkeypatch.setattr(admin_maintenance, "set_enabled", set_mock)
    monkeypatch.setattr(server, "ws_broadcast", broadcast_mock)
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        resp = await client.post(
            "/admin/api/module-maintenance",
            json={"module_key": "icd", "enabled": True},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"ok": True, "module_key": "icd", "enabled": True}
        set_mock.assert_awaited_once()
        broadcast_mock.assert_awaited_once_with(
            "maintenance_changed", {"module_key": "icd", "enabled": True}
        )


@pytest.mark.asyncio
async def test_admin_clear_requires_maintenance(admin_config, monkeypatch):
    import admin_maintenance

    monkeypatch.setattr(admin_maintenance, "is_enabled", AsyncMock(return_value=False))
    clear_mock = AsyncMock()
    monkeypatch.setattr(server, "clear_icd_module", clear_mock)
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        # Maintenance OFF → clear is refused (409) and never runs.
        resp = await client.post("/admin/api/modules/icd/clear", json={})
        assert resp.status_code == 409
        clear_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_admin_clear_runs_when_maintaining(admin_config, monkeypatch):
    import admin_maintenance

    monkeypatch.setattr(admin_maintenance, "is_enabled", AsyncMock(return_value=True))
    monkeypatch.setattr(
        server,
        "clear_icd_module",
        AsyncMock(
            return_value={
                "module_key": "icd",
                "diagnoses_truncated": 10,
                "procedures_truncated": 5,
                "files_deleted": 3,
            }
        ),
    )
    broadcast_mock = AsyncMock()
    monkeypatch.setattr(server, "ws_broadcast", broadcast_mock)
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        resp = await client.post("/admin/api/modules/icd/clear", json={})
        assert resp.status_code == 200
        assert resp.json()["cleared"]["files_deleted"] == 3
        broadcast_mock.assert_awaited_once_with("module_cleared", {"module_key": "icd"})


@pytest.mark.asyncio
async def test_admin_loinc_clear_runs_when_maintaining(admin_config, monkeypatch):
    import admin_maintenance

    monkeypatch.setattr(admin_maintenance, "is_enabled", AsyncMock(return_value=True))
    clear_mock = AsyncMock(
        return_value={
            "module_key": "loinc",
            "concepts_truncated": 20,
            "reference_ranges_truncated": 4,
            "embeddings_truncated": 8,
            "files_deleted": 3,
        }
    )
    monkeypatch.setattr(server, "clear_loinc_module", clear_mock)
    broadcast_mock = AsyncMock()
    monkeypatch.setattr(server, "ws_broadcast", broadcast_mock)
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        resp = await client.post("/admin/api/modules/loinc/clear", json={})
        assert resp.status_code == 200
        assert resp.json()["cleared"]["embeddings_truncated"] == 8
        clear_mock.assert_awaited_once()
        broadcast_mock.assert_awaited_once_with("module_cleared", {"module_key": "loinc"})


@pytest.mark.asyncio
async def test_admin_drug_clear_runs_when_maintaining(admin_config, monkeypatch):
    import admin_maintenance

    monkeypatch.setattr(admin_maintenance, "is_enabled", AsyncMock(return_value=True))
    clear_mock = AsyncMock(
        return_value={
            "module_key": "drug",
            "licenses_truncated": 35,
            "assets_truncated": 37,
            "files_deleted": 2,
            "asset_objects_deleted": 37,
        }
    )
    monkeypatch.setattr(server, "clear_drug_module", clear_mock)
    broadcast_mock = AsyncMock()
    monkeypatch.setattr(server, "ws_broadcast", broadcast_mock)
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        resp = await client.post("/admin/api/modules/drug/clear", json={})
        assert resp.status_code == 200
        assert resp.json()["cleared"]["licenses_truncated"] == 35
        clear_mock.assert_awaited_once()
        broadcast_mock.assert_awaited_once_with("module_cleared", {"module_key": "drug"})


@pytest.mark.asyncio
async def test_icd_tool_returns_maintenance_response(monkeypatch):
    # When ICD is in maintenance, the tool short-circuits to a maintenance
    # response without touching the service.
    monkeypatch.setattr(server, "_icd_maintenance_active", AsyncMock(return_value=True))
    icd_mock = MagicMock()
    icd_mock.search_codes = AsyncMock(return_value="should-not-be-called")
    monkeypatch.setattr(server, "icd_service", icd_mock)

    result = await server.search_medical_codes("diabetes")
    payload = json.loads(result)
    assert payload["status"] == "maintenance"
    icd_mock.search_codes.assert_not_awaited()


@pytest.mark.asyncio
async def test_loinc_tool_returns_maintenance_response(monkeypatch):
    monkeypatch.setattr(server, "_loinc_maintenance_active", AsyncMock(return_value=True))
    lab_mock = MagicMock()
    lab_mock.search_loinc_code = AsyncMock(return_value="should-not-be-called")
    monkeypatch.setattr(server, "lab_service", lab_mock)

    result = await server.search_loinc(mode="code", keyword="glucose")
    payload = json.loads(result)
    assert payload["status"] == "maintenance"
    lab_mock.search_loinc_code.assert_not_awaited()


@pytest.mark.asyncio
async def test_drug_tool_returns_maintenance_response(monkeypatch):
    monkeypatch.setattr(server, "_drug_maintenance_active", AsyncMock(return_value=True))
    drug_mock = MagicMock()
    drug_mock.search_by_name = AsyncMock(return_value="should-not-be-called")
    monkeypatch.setattr(server, "drug_service", drug_mock)

    result = await server.search_drug(mode="drug_name", keyword="acetaminophen")
    payload = json.loads(result)
    assert payload["status"] == "maintenance"
    drug_mock.search_by_name.assert_not_awaited()


@pytest.mark.asyncio
async def test_admin_drug_status_endpoint(admin_config, monkeypatch):
    monkeypatch.setattr(
        server,
        "_build_admin_overview_payload",
        AsyncMock(return_value=_dummy_overview()),
    )
    monkeypatch.setattr(
        server,
        "get_drug_admin_status",
        AsyncMock(
            return_value={
                "summary": {
                    "total_licenses": 12,
                    "active_licenses": 11,
                    "queue_counts": {"pending": 2, "success": 8, "partial_success": 1, "retryable_failed": 1},
                    "state_counts": {
                        "electronic_failed": 1,
                        "insert_failed": 0,
                        "label_failed": 0,
                        "shape_failed": 0,
                        "storage_failed": 0,
                        "ocr_failed": 1,
                        "analysis_failed": 0,
                        "normalize_failed": 0,
                        "electronic_pending": 2,
                        "ocr_pending": 3,
                        "analysis_pending": 3,
                    },
                },
                "licenses": [
                    {
                        "license_id": "D-001",
                        "name_zh": "測試藥品",
                        "queue_status": "retryable_failed",
                        "statuses": {"analysis_status": "pending"},
                    }
                ],
                "recent_events": [
                    {
                        "license_id": "D-001",
                        "stage": "electronic_insert_scrape",
                        "status": "retryable_failed",
                        "created_at": "2026-05-29T12:00:00+00:00",
                    }
                ],
            }
        ),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        response = await client.get("/admin/api/drug/status?limit=10&failed_only=true")
        assert response.status_code == 200
        payload = response.json()
        assert payload["summary"]["total_licenses"] == 12
        assert payload["licenses"][0]["license_id"] == "D-001"
        assert payload["recent_events"][0]["stage"] == "electronic_insert_scrape"


@pytest.mark.asyncio
async def test_admin_drug_details_endpoint(admin_config, monkeypatch):
    drug_mock = MagicMock()
    drug_mock.get_drug_details = AsyncMock(
        return_value=json.dumps(
            {
                "license_id": "D-001",
                "record": {"drug": {"chinese_name": "測試藥品"}},
                "availability": {"analysis_status": "success"},
                "documents_summary": {"insert_pdf_count": 1, "label_pdf_count": 0},
            },
            ensure_ascii=False,
        )
    )
    monkeypatch.setattr(server, "drug_service", drug_mock)

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        response = await client.get("/admin/api/drug/details?license_id=D-001")
        assert response.status_code == 200
        assert response.json()["record"]["drug"]["chinese_name"] == "測試藥品"
        drug_mock.get_drug_details.assert_awaited_once_with(
            "D-001",
            include_cancelled=True,
        )


@pytest.mark.asyncio
async def test_admin_duplicate_upload_reuses_existing_source(admin_config, monkeypatch):
    monkeypatch.setattr(
        server,
        "_build_admin_overview_payload",
        AsyncMock(return_value=_dummy_overview()),
    )
    monkeypatch.setattr(
        server,
        "create_uploaded_source",
        AsyncMock(
            return_value={
                "duplicate": True,
                "uploaded_file": {
                    "uploaded_file_id": "upload-existing",
                    "original_filename": "36_2.csv",
                    "sha256": "same-hash",
                    "is_active": True,
                },
            }
        ),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        response = await client.post(
            "/admin/api/uploads?module_key=drug&source_role=drug_index_csv&filename=36_2.csv&auto_activate=true",
            content=b"duplicate",
            headers={"content-type": "text/csv"},
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["duplicate"] is True
        assert "Duplicate upload skipped" in payload["message"]
        assert payload["uploaded_file"]["uploaded_file_id"] == "upload-existing"
        assert payload["uploaded_file"]["is_active"] is True


@pytest.mark.asyncio
async def test_admin_create_simple_loader_job(admin_config, monkeypatch):
    monkeypatch.setattr(
        server,
        "_build_admin_overview_payload",
        AsyncMock(return_value=_dummy_overview()),
    )
    monkeypatch.setattr(
        server,
        "create_admin_job",
        AsyncMock(
            return_value={
                "job_id": "job-health-supplements",
                "job_type": "health_supplements_sync",
                "module_key": "health_supplements",
                "status": "queued",
                "control_state": "idle",
                "available_actions": ["pause", "stop", "restart"],
            }
        ),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        create_response = await client.post(
            "/admin/api/jobs",
            json={"module_key": "health_supplements", "job_type": "health_supplements_sync"},
        )
        assert create_response.status_code == 201
        assert create_response.json()["job"]["job_type"] == "health_supplements_sync"


@pytest.mark.asyncio
async def test_admin_create_heavy_loader_job(admin_config, monkeypatch):
    monkeypatch.setattr(
        server,
        "_build_admin_overview_payload",
        AsyncMock(return_value=_dummy_overview()),
    )
    monkeypatch.setattr(
        server,
        "create_admin_job",
        AsyncMock(
            return_value={
                "job_id": "job-icd",
                "job_type": "icd_import",
                "module_key": "icd",
                "status": "queued",
                "control_state": "idle",
                "available_actions": ["pause", "stop", "restart"],
            }
        ),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        create_response = await client.post(
            "/admin/api/jobs",
            json={"module_key": "icd", "job_type": "icd_import"},
        )
        assert create_response.status_code == 201
        assert create_response.json()["job"]["job_type"] == "icd_import"


@pytest.mark.asyncio
async def test_admin_create_drug_jobs(admin_config, monkeypatch):
    monkeypatch.setattr(
        server,
        "_build_admin_overview_payload",
        AsyncMock(return_value=_dummy_overview()),
    )
    monkeypatch.setattr(
        server,
        "create_admin_job",
        AsyncMock(
            side_effect=[
                {
                    "job_id": "job-drug-index",
                    "job_type": "drug_index_import",
                    "module_key": "drug",
                    "status": "queued",
                    "control_state": "idle",
                    "available_actions": ["pause", "stop", "restart"],
                },
                {
                    "job_id": "job-drug-enrich",
                    "job_type": "drug_enrichment",
                    "module_key": "drug",
                    "status": "queued",
                    "control_state": "idle",
                    "available_actions": ["pause", "stop", "restart"],
                },
                {
                    "job_id": "job-drug-analysis",
                    "job_type": "drug_analysis",
                    "module_key": "drug",
                    "status": "queued",
                    "control_state": "idle",
                    "available_actions": ["pause", "stop", "restart"],
                },
            ]
        ),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        index_response = await client.post(
            "/admin/api/jobs",
            json={"module_key": "drug", "job_type": "drug_index_import"},
        )
        enrich_response = await client.post(
            "/admin/api/jobs",
            json={
                "module_key": "drug",
                "job_type": "drug_enrichment",
                "job_options": {"license_ids": ["D-001"], "retry_failed": True},
            },
        )
        analysis_response = await client.post(
            "/admin/api/jobs",
            json={
                "module_key": "drug",
                "job_type": "drug_analysis",
                "job_options": {"license_ids": ["D-001"], "retry_stage": "analysis"},
            },
        )

        assert index_response.status_code == 201
        assert index_response.json()["job"]["job_type"] == "drug_index_import"
        assert enrich_response.status_code == 201
        assert enrich_response.json()["job"]["job_type"] == "drug_enrichment"
        assert analysis_response.status_code == 201
        assert analysis_response.json()["job"]["job_type"] == "drug_analysis"


@pytest.mark.asyncio
async def test_admin_create_job_validation_returns_400(admin_config, monkeypatch):
    monkeypatch.setattr(
        server,
        "_build_admin_overview_payload",
        AsyncMock(return_value=_dummy_overview()),
    )
    monkeypatch.setattr(
        server,
        "create_admin_job",
        AsyncMock(side_effect=ValueError("Missing active uploaded source(s) for icd: icd10cm")),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post(
            "/admin/login",
            data={"username": "admin", "password": "secret"},
            follow_redirects=False,
        )
        assert login.status_code == 303

        create_response = await client.post(
            "/admin/api/jobs",
            json={"module_key": "icd", "job_type": "icd_import"},
        )
        assert create_response.status_code == 400
        assert "Missing active uploaded source" in create_response.json()["error"]


def test_verify_admin_password_sha256():
    assert verify_admin_password("secret", _sha256_hash("secret")) is True
    assert verify_admin_password("wrong", _sha256_hash("secret")) is False


def test_admin_session_token_round_trip():
    token = build_admin_session_token("admin", "session-secret", ttl_minutes=5)
    assert parse_admin_session_token(token, "session-secret") == "admin"
    assert parse_admin_session_token(token, "wrong-secret") is None


# ---------------------------------------------------------------------------
# Version history API  (GET /admin/api/modules/{key}/versions)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_version_history_returns_versions(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(
        server,
        "list_source_versions",
        AsyncMock(return_value=[
            {
                "module_source_id": "ds-uuid-1",
                "module_key": "icd",
                "source_role": "icd10cm",
                "role_label": "ICD-10-CM 2025 ZIP",
                "is_active": True,
                "version_num": 2,
                "uploaded_file_id": "file-uuid-1",
                "original_filename": "icd10cm-table-index-2025.zip",
                "size_bytes": 20_000_000,
                "sha256": "abc123",
                "uploaded_by": "admin",
                "uploaded_at": "2026-05-01T10:00:00+00:00",
                "activated_at": "2026-05-01T10:05:00+00:00",
                "validation_status": "accepted",
            },
            {
                "module_source_id": "ds-uuid-0",
                "module_key": "icd",
                "source_role": "icd10cm",
                "role_label": "ICD-10-CM 2025 ZIP",
                "is_active": False,
                "version_num": 1,
                "uploaded_file_id": "file-uuid-0",
                "original_filename": "icd10cm-table-index-2024.zip",
                "size_bytes": 18_000_000,
                "sha256": "def456",
                "uploaded_by": "admin",
                "uploaded_at": "2025-11-01T08:00:00+00:00",
                "activated_at": "2025-11-01T08:10:00+00:00",
                "validation_status": "accepted",
            },
        ]),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        login = await client.post("/admin/login",
                                  data={"username": "admin", "password": "secret"},
                                  follow_redirects=False)
        assert login.status_code == 303

        response = await client.get("/admin/api/modules/icd/versions")
        assert response.status_code == 200
        payload = response.json()
        assert payload["module_key"] == "icd"
        versions = payload["versions"]
        assert len(versions) == 2
        assert versions[0]["version_num"] == 2
        assert versions[0]["is_active"] is True
        assert versions[1]["version_num"] == 1
        assert versions[1]["is_active"] is False


@pytest.mark.asyncio
async def test_version_history_returns_empty_list(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(server, "list_source_versions", AsyncMock(return_value=[]))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.get("/admin/api/modules/loinc/versions")
        assert response.status_code == 200
        assert response.json() == {"module_key": "loinc", "versions": []}


# ---------------------------------------------------------------------------
# Schedule CRUD API  (GET/POST/DELETE /admin/api/modules/{key}/schedule)
# ---------------------------------------------------------------------------

def _make_schedule_config(**kwargs) -> ScheduleConfig:
    defaults = dict(
        schedule_id="sched-00000000-0000-0000-0000-000000000001",
        module_key="icd",
        source_role="icd10cm",
        fetch_url="https://www.cms.gov/icd10cm.zip",
        frequency="weekly",
        day_of_week=0,
        day_of_month=None,
        hour_utc=2,
        minute_utc=0,
        is_enabled=True,
        last_run_at=None,
        next_run_at="2026-06-08T02:00:00+00:00",
        last_run_status=None,
        last_run_job_id=None,
        last_error=None,
        created_by="admin",
        created_at="2026-05-31T12:00:00+00:00",
        updated_at="2026-05-31T12:00:00+00:00",
    )
    defaults.update(kwargs)
    return ScheduleConfig(**defaults)


@pytest.mark.asyncio
async def test_schedule_get_returns_null_when_not_configured(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(server, "get_schedule", AsyncMock(return_value=None))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.get("/admin/api/modules/icd/schedule")
        assert response.status_code == 200
        assert response.json() == {"schedule": None}


@pytest.mark.asyncio
async def test_schedule_get_returns_existing_schedule(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    sched = _make_schedule_config()
    monkeypatch.setattr(server, "get_schedule", AsyncMock(return_value=sched))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.get("/admin/api/modules/icd/schedule")
        assert response.status_code == 200
        payload = response.json()["schedule"]
        assert payload["module_key"] == "icd"
        assert payload["frequency"] == "weekly"
        assert payload["fetch_url"] == "https://www.cms.gov/icd10cm.zip"
        assert payload["is_enabled"] is True


@pytest.mark.asyncio
async def test_schedule_create_url_fetch_module(admin_config, monkeypatch):
    """POST creates a weekly schedule with URL for an ICD-type (URL-fetch) module."""
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    created = _make_schedule_config(day_of_week=1, hour_utc=3, minute_utc=15)
    monkeypatch.setattr(server, "upsert_schedule", AsyncMock(return_value=created))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.post(
            "/admin/api/modules/icd/schedule",
            json={
                "frequency": "weekly",
                "day_of_week": 1,
                "hour_utc": 3,
                "minute_utc": 15,
                "fetch_url": "https://www.cms.gov/icd10cm.zip",
                "source_role": "icd10cm",
                "is_enabled": True,
            },
        )
        assert response.status_code == 200
        sched_data = response.json()["schedule"]
        assert sched_data["frequency"] == "weekly"


@pytest.mark.asyncio
async def test_schedule_create_api_sync_module_no_url_required(admin_config, monkeypatch):
    """POST for health_supplements (api-sync) does not require fetch_url."""
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    created = _make_schedule_config(
        module_key="health_supplements", source_role=None,
        fetch_url="https://data.fda.gov.tw/data/opendata/export/19/json",
    )
    monkeypatch.setattr(server, "upsert_schedule", AsyncMock(return_value=created))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.post(
            "/admin/api/modules/health_supplements/schedule",
            json={
                "frequency": "weekly",
                "day_of_week": 0,
                "hour_utc": 2,
                "minute_utc": 30,
                "is_enabled": True,
                # No fetch_url — should be allowed for api-sync modules
            },
        )
        assert response.status_code == 200


@pytest.mark.asyncio
async def test_schedule_post_invalid_frequency_returns_400(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.post(
            "/admin/api/modules/icd/schedule",
            json={"frequency": "yearly", "hour_utc": 2, "minute_utc": 0,
                  "fetch_url": "https://example.com/a.zip", "source_role": "icd10cm"},
        )
        assert response.status_code == 400
        assert "frequency" in response.json()["error"].lower()


@pytest.mark.asyncio
async def test_schedule_post_missing_url_for_url_fetch_returns_400(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.post(
            "/admin/api/modules/icd/schedule",
            json={"frequency": "weekly", "day_of_week": 0,
                  "hour_utc": 2, "minute_utc": 0,
                  "source_role": "icd10cm",
                  # fetch_url missing → should fail for URL-fetch module
                  },
        )
        assert response.status_code == 400
        assert "fetch_url" in response.json()["error"]


@pytest.mark.asyncio
async def test_schedule_post_http_url_returns_400(admin_config, monkeypatch):
    """Non-HTTPS URL is rejected to prevent SSRF."""
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.post(
            "/admin/api/modules/icd/schedule",
            json={"frequency": "weekly", "day_of_week": 0,
                  "hour_utc": 2, "minute_utc": 0,
                  "fetch_url": "http://insecure.example.com/data.zip",
                  "source_role": "icd10cm"},
        )
        assert response.status_code == 400
        assert "HTTPS" in response.json()["error"]


@pytest.mark.asyncio
async def test_schedule_post_weekly_missing_day_of_week_returns_400(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.post(
            "/admin/api/modules/icd/schedule",
            json={"frequency": "weekly",  # day_of_week missing
                  "hour_utc": 2, "minute_utc": 0,
                  "fetch_url": "https://example.com/a.zip",
                  "source_role": "icd10cm"},
        )
        assert response.status_code == 400
        assert "day_of_week" in response.json()["error"]


@pytest.mark.asyncio
async def test_schedule_post_monthly_missing_day_of_month_returns_400(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.post(
            "/admin/api/modules/icd/schedule",
            json={"frequency": "monthly",  # day_of_month missing
                  "hour_utc": 2, "minute_utc": 0,
                  "fetch_url": "https://example.com/a.zip",
                  "source_role": "icd10cm"},
        )
        assert response.status_code == 400
        assert "day_of_month" in response.json()["error"]


@pytest.mark.asyncio
async def test_schedule_post_unsupported_module_returns_400(admin_config, monkeypatch):
    """LOINC and SNOMED do not support scheduling (require licensed download)."""
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        for ds_key in ("loinc", "snomed", "guideline"):
            response = await client.post(
                f"/admin/api/modules/{ds_key}/schedule",
                json={"frequency": "weekly", "day_of_week": 0,
                      "hour_utc": 2, "minute_utc": 0},
            )
            assert response.status_code == 400, f"Expected 400 for {ds_key}"


@pytest.mark.asyncio
async def test_schedule_delete(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(server, "delete_schedule", AsyncMock(return_value=True))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.delete("/admin/api/modules/icd/schedule")
        assert response.status_code == 200
        assert response.json()["deleted"] is True


@pytest.mark.asyncio
async def test_schedule_trigger_fires_schedule(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    sched = _make_schedule_config(
        module_key="health_supplements",
        source_role=None,
        fetch_url="https://data.fda.gov.tw/data/opendata/export/19/json",
    )
    monkeypatch.setattr(server, "get_schedule", AsyncMock(return_value=sched))
    monkeypatch.setattr(server, "fire_schedule", AsyncMock(
        return_value={"job_id": "job-fired", "status": "success", "error": None}
    ))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())
    # Patch asyncio.create_task so it runs the coroutine synchronously in test
    import asyncio
    monkeypatch.setattr(asyncio, "create_task", lambda coro: asyncio.ensure_future(coro))

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.post("/admin/api/modules/health_supplements/schedule/trigger")
        assert response.status_code == 200
        payload = response.json()
        assert payload["triggered"] is True
        assert payload["module_key"] == "health_supplements"


@pytest.mark.asyncio
async def test_schedule_trigger_no_schedule_returns_404(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(server, "get_schedule", AsyncMock(return_value=None))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.post("/admin/api/modules/icd/schedule/trigger")
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# Preview API  (GET /admin/api/modules/{key}/preview)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_preview_icd_tree_root(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(
        server,
        "dispatch_preview",
        AsyncMock(return_value={
            "type": "tree_root",
            "total_cm": 95001,
            "total_pcs": 78020,
            "nodes": [
                {"code": "A00", "name_en": "Cholera", "name_zh": "",
                 "child_count": 3, "is_leaf": False},
            ],
        }),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.get("/admin/api/modules/icd/preview?node=root")
        assert response.status_code == 200
        payload = response.json()
        assert payload["type"] == "tree_root"
        assert payload["total_cm"] == 95001
        assert payload["nodes"][0]["code"] == "A00"


@pytest.mark.asyncio
async def test_preview_loinc_paginated_table(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(
        server,
        "dispatch_preview",
        AsyncMock(return_value={
            "type": "table",
            "total": 87000,
            "total_all": 87000,
            "page": 1,
            "per_page": 20,
            "pages": 4350,
            "classes": ["CHEM", "HEM/BC"],
            "rows": [
                {"loinc_num": "2951-2", "long_common_name": "Sodium [Moles/volume] in Serum or Plasma",
                 "shortname": "Sodium SerPl-sCnc", "class": "CHEM",
                 "status": "ACTIVE", "name_zh": "鈉", "common_name_zh": ""},
            ],
        }),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.get("/admin/api/modules/loinc/preview?page=1&status=ACTIVE")
        assert response.status_code == 200
        payload = response.json()
        assert payload["type"] == "table"
        assert payload["rows"][0]["loinc_num"] == "2951-2"


@pytest.mark.asyncio
async def test_preview_empty_module_returns_empty_type(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(
        server,
        "dispatch_preview",
        AsyncMock(return_value={
            "type": "empty",
            "message": "SNOMED CT module not loaded. Run the import first.",
            "total": 0,
        }),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.get("/admin/api/modules/snomed/preview")
        assert response.status_code == 200
        payload = response.json()
        assert payload["type"] == "empty"
        assert "not loaded" in payload["message"]


@pytest.mark.asyncio
async def test_preview_unsupported_module_returns_400(admin_config, monkeypatch):
    """Module keys not in PREVIEW_SUPPORTED_MODULES get a 400."""
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        # 'rxnorm' and 'umls' are not in PREVIEW_SUPPORTED_MODULES
        for ds in ("rxnorm", "umls", "admin"):
            response = await client.get(f"/admin/api/modules/{ds}/preview")
            assert response.status_code == 400, f"Expected 400 for module '{ds}'"


@pytest.mark.asyncio
async def test_preview_guideline_detail(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(
        server,
        "dispatch_preview",
        AsyncMock(return_value={
            "type": "detail",
            "guideline": {
                "id": 1,
                "icd_code": "E11",
                "disease_name_zh": "第二型糖尿病",
                "disease_name_en": "Type 2 Diabetes Mellitus",
                "guideline_title": "台灣糖尿病診治指引 2023",
                "guideline_source": "中華民國糖尿病學會",
                "publication_year": 2023,
                "guideline_summary": "HbA1c target < 7%.",
            },
            "diagnostic_recommendations": [
                {"step_order": 1, "recommendation_type": "lab",
                 "description": "Fasting plasma glucose", "evidence_level": "A"},
            ],
            "medication_recommendations": [],
            "test_recommendations": [],
            "treatment_goals": [],
        }),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.get("/admin/api/modules/guideline/preview?id=1")
        assert response.status_code == 200
        payload = response.json()
        assert payload["type"] == "detail"
        assert payload["guideline"]["icd_code"] == "E11"
        assert len(payload["diagnostic_recommendations"]) == 1


@pytest.mark.asyncio
async def test_preview_drug_quality_stats(admin_config, monkeypatch):
    monkeypatch.setattr(server, "_build_admin_overview_payload",
                        AsyncMock(return_value=_dummy_overview()))
    monkeypatch.setattr(
        server,
        "dispatch_preview",
        AsyncMock(return_value={
            "type": "drug",
            "stats": {
                "total_licenses": 12000,
                "quality": {
                    "index_only": 5000,
                    "ei_partial": 2000,
                    "ei_complete": 4500,
                    "pdf_ocr": 500,
                },
            },
            "total": 12000,
            "page": 1,
            "per_page": 50,
            "pages": 240,
            "rows": [
                {
                    "license_id": "衛署藥製字第001234號",
                    "chinese_name": "測試藥品",
                    "english_name": "Test Drug",
                    "drug_category": "西藥",
                    "is_active": True,
                    "quality_confidence": "ei_complete",
                    "primary_insert_source": "electronic_insert",
                },
            ],
        }),
    )
    monkeypatch.setattr(server.database, "get_pool", lambda: object())

    app = server.build_http_app()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post("/admin/login",
                          data={"username": "admin", "password": "secret"},
                          follow_redirects=False)
        response = await client.get("/admin/api/modules/drug/preview?page=1&quality=ei_complete")
        assert response.status_code == 200
        payload = response.json()
        assert payload["type"] == "drug"
        assert payload["stats"]["total_licenses"] == 12000
        assert payload["stats"]["quality"]["pdf_ocr"] == 500
        assert payload["rows"][0]["quality_confidence"] == "ei_complete"

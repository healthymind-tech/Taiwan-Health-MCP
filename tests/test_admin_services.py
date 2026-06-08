from admin_services import SERVICE_PROBE_ORDER, serialize_service_probes


def test_serialize_service_probes_fills_placeholders_and_counts_statuses():
    payload = serialize_service_probes(
        current_rows=[
            {
                "service_key": "database",
                "status": "ok",
                "endpoint": "postgresql://database",
                "latency_ms": 12,
                "message": "SELECT 1 succeeded.",
                "details_json": {"query": "SELECT 1"},
                "checked_at": "2026-05-29T12:00:00+00:00",
            },
            {
                "service_key": "ocr_server",
                "status": "error",
                "endpoint": "http://ocr.local/health",
                "latency_ms": None,
                "message": "timeout",
                "details_json": {"error_type": "ConnectTimeout"},
                "checked_at": "2026-05-29T12:01:00+00:00",
            },
        ],
        history_rows=[
            {
                "service_key": "database",
                "status": "ok",
                "endpoint": "postgresql://database",
                "latency_ms": 11,
                "message": "SELECT 1 succeeded.",
                "details_json": {"query": "SELECT 1"},
                "checked_at": "2026-05-29T11:59:00+00:00",
            }
        ],
    )

    assert [row["service_key"] for row in payload["services"]] == SERVICE_PROBE_ORDER
    assert payload["services"][0]["label"] == "PostgreSQL"
    assert payload["services"][1]["message"] == "No cached probe result yet."
    assert payload["services"][4]["status"] == "error"
    assert payload["history"][0]["service_key"] == "database"
    assert payload["summary"]["total"] == len(SERVICE_PROBE_ORDER)
    assert payload["summary"]["ok"] == 1
    assert payload["summary"]["error"] == 1
    assert payload["summary"]["degraded"] == len(SERVICE_PROBE_ORDER) - 2
    assert payload["summary"]["last_checked_at"] == "2026-05-29T12:01:00+00:00"

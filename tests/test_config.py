"""Tests for AppConfig."""

import os
import pytest

# Ensure src/ is on the path
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


def test_config_from_env_defaults(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@localhost/db")
    monkeypatch.delenv("MCP_TRANSPORT", raising=False)
    monkeypatch.delenv("MCP_PORT", raising=False)
    monkeypatch.delenv("REDIS_URL", raising=False)

    from config import AppConfig
    cfg = AppConfig.from_env()

    assert cfg.transport == "stdio"
    assert cfg.port == 8000
    assert cfg.redis_url == "redis://localhost:6379/0"
    assert cfg.log_level == "INFO"


def test_config_http_transport(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@localhost/db")
    monkeypatch.setenv("MCP_TRANSPORT", "streamable-http")
    monkeypatch.setenv("MCP_PORT", "9000")
    monkeypatch.setenv("MCP_HOST", "127.0.0.1")

    from config import AppConfig
    cfg = AppConfig.from_env()

    assert cfg.transport == "streamable-http"
    assert cfg.port == 9000
    assert cfg.host == "127.0.0.1"


def test_config_invalid_transport_falls_back_to_stdio(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@localhost/db")
    monkeypatch.setenv("MCP_TRANSPORT", "websocket")  # invalid

    from config import AppConfig
    cfg = AppConfig.from_env()
    assert cfg.transport == "stdio"


def test_config_missing_database_url_raises(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)

    from config import AppConfig
    with pytest.raises(ValueError, match="DATABASE_URL"):
        AppConfig.from_env()


def test_get_run_kwargs_stdio(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x:y@localhost/db")
    monkeypatch.setenv("MCP_TRANSPORT", "stdio")

    from config import AppConfig
    cfg = AppConfig.from_env()
    assert cfg.get_run_kwargs() == {"transport": "stdio"}


def test_get_run_kwargs_http(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x:y@localhost/db")
    monkeypatch.setenv("MCP_TRANSPORT", "streamable-http")

    from config import AppConfig
    cfg = AppConfig.from_env()
    kwargs = cfg.get_run_kwargs()
    assert kwargs["transport"] == "streamable-http"

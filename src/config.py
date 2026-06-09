"""
MCP Server configuration.
Supports three transport modes: stdio, streamable-http, sse.
"""

import os
from dataclasses import dataclass, field
from typing import Literal

from dotenv import load_dotenv

load_dotenv()

TransportType = Literal["stdio", "streamable-http", "sse"]


@dataclass
class AppConfig:
    # MCP transport
    transport: TransportType
    host: str
    port: int
    path: str

    # Database
    database_url: str

    # Redis
    redis_url: str

    # App
    log_level: str
    admin_enabled: bool
    admin_username: str
    admin_password_hash: str
    admin_session_secret: str
    admin_session_ttl_minutes: int
    admin_max_upload_mb: int
    # Public origin (scheme://host) of this deployment, used to build the OAuth2
    # Authorization Code redirect_uri. Must be pre-registered at the external
    # authorization server. Blank → derive from the request Host header.
    public_base_url: str

    @classmethod
    def from_env(cls) -> "AppConfig":
        """Build an ``AppConfig`` from environment variables.

        Returns:
            A fully populated ``AppConfig`` instance.

        Raises:
            ValueError: If ``DATABASE_URL`` is not set.
        """
        transport = os.getenv("MCP_TRANSPORT", "stdio").lower()
        if transport not in ("stdio", "sse", "streamable-http"):
            transport = "stdio"

        database_url = os.getenv("DATABASE_URL", "")
        if not database_url:
            raise ValueError("DATABASE_URL environment variable is required")

        return cls(
            transport=transport,
            host=os.getenv("MCP_HOST", "0.0.0.0"),
            port=int(os.getenv("MCP_PORT", "8000")),
            path=os.getenv("MCP_PATH", "/mcp"),
            database_url=database_url,
            redis_url=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
            log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
            admin_enabled=os.getenv("ADMIN_ENABLED", "false").lower() == "true",
            admin_username=os.getenv("ADMIN_USERNAME", "").strip(),
            admin_password_hash=os.getenv("ADMIN_PASSWORD_HASH", "").strip(),
            admin_session_secret=os.getenv("ADMIN_SESSION_SECRET", "").strip(),
            admin_session_ttl_minutes=int(
                os.getenv("ADMIN_SESSION_TTL_MINUTES", "240")
            ),
            admin_max_upload_mb=int(os.getenv("ADMIN_MAX_UPLOAD_MB", "512")),
            public_base_url=os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/"),
        )

    @property
    def admin_ready(self) -> bool:
        return (
            self.admin_enabled
            and bool(self.admin_username)
            and bool(self.admin_password_hash)
            and bool(self.admin_session_secret)
        )

    def get_run_kwargs(self) -> dict:
        """Return the keyword arguments to pass to ``mcp.run()``.

        Returns:
            A dict containing at minimum ``{"transport": ...}``.
        """
        if self.transport == "stdio":
            return {"transport": "stdio"}
        return {"transport": self.transport}

    def __str__(self) -> str:
        """Return a human-readable summary of the active transport configuration."""
        if self.transport == "stdio":
            return f"Transport: {self.transport}"
        if self.transport == "streamable-http":
            return (
                f"Transport: {self.transport} | "
                f"http://{self.host}:{self.port}{self.path}"
            )
        return f"Transport: {self.transport} | http://{self.host}:{self.port}/sse"

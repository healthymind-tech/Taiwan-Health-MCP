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
            return f"Transport: {self.transport} | http://{self.host}:{self.port}{self.path}"
        return f"Transport: {self.transport} | http://{self.host}:{self.port}/sse"

"""
MCP Server 配置管理模組

此模組提供統一的配置管理，支援三種傳輸模式：
- stdio: 標準輸入輸出（Claude Desktop）
- streamable-http: Streamable HTTP（生產部署）
- sse: Server-Sent Events（向後相容）
"""

import os
from dataclasses import dataclass
from typing import Literal

TransportType = Literal["stdio", "http", "sse"]


@dataclass
class MCPConfig:
    """MCP Server 配置類別

    Attributes:
        transport: 傳輸模式 (stdio/http/sse)
        host: 監聽主機
        port: 監聽埠號
        path: HTTP 端點路徑
    """

    transport: TransportType
    host: str
    port: int
    path: str

    @classmethod
    def from_env(cls) -> "MCPConfig":
        """從環境變數讀取配置

        環境變數:
            MCP_TRANSPORT: 傳輸模式 (預設: stdio)
            MCP_HOST: 監聽主機 (預設: 0.0.0.0)
            MCP_PORT: 監聽埠號 (預設: 8000)
            MCP_PATH: HTTP 端點路徑 (預設: /mcp)

        Returns:
            MCPConfig 實例
        """
        transport = os.getenv("MCP_TRANSPORT", "stdio").lower()

        # 驗證 transport 類型
        valid_transports = ("stdio", "sse", "streamable-http")
        if transport not in valid_transports:
            transport = "stdio"

        return cls(
            transport=transport,
            host=os.getenv("MCP_HOST", "0.0.0.0"),
            port=int(os.getenv("MCP_PORT", "8000")),
            path=os.getenv("MCP_PATH", "/mcp"),
        )

    def get_run_kwargs(self) -> dict:
        """取得 mcp.run() 參數

        Returns:
            可直接傳給 mcp.run(**kwargs) 的字典
        """
        if self.transport == "stdio":
            return {"transport": "stdio"}
        else:  # streamable-http 或 sse
            return {"transport": self.transport}

    def __str__(self) -> str:
        """格式化輸出配置資訊"""
        if self.transport == "stdio":
            return f"Transport: {self.transport}"
        elif self.transport == "streamable-http":
            return f"Transport: {self.transport} | http://{self.host}:{self.port}{self.path}"
        else:  # sse
            return f"Transport: {self.transport} | http://{self.host}:{self.port}/sse"

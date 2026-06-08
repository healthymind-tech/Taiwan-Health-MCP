"""
MinIO object storage abstraction for drug assets.

The database stores stable MinIO locators (`bucket`, `object_key`, `minio_uri`).
Presigned URLs are generated at runtime and are never persisted.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import timedelta
import io
import os
from time import perf_counter
from typing import Any

from utils import log_error, log_info, log_warning


@dataclass
class MinioConfig:
    endpoint: str
    access_key: str
    secret_key: str
    bucket: str
    secure: bool
    presign_ttl_seconds: int

    @classmethod
    def from_env(cls) -> "MinioConfig":
        return cls(
            endpoint=os.getenv("MINIO_ENDPOINT", "").strip(),
            access_key=os.getenv("MINIO_ACCESS_KEY", "").strip(),
            secret_key=os.getenv("MINIO_SECRET_KEY", "").strip(),
            bucket=os.getenv("MINIO_BUCKET", "").strip(),
            secure=os.getenv("MINIO_SECURE", "false").lower() == "true",
            presign_ttl_seconds=int(os.getenv("MINIO_PRESIGN_TTL_SECONDS", "3600")),
        )

    @classmethod
    def from_values(cls, v: dict) -> "MinioConfig":
        """Build from a DB settings dict (admin_settings 'minio' group)."""
        return cls(
            endpoint=str(v.get("endpoint", "") or "").strip(),
            access_key=str(v.get("access_key", "") or "").strip(),
            secret_key=str(v.get("secret_key", "") or "").strip(),
            bucket=str(v.get("bucket", "") or "").strip(),
            secure=bool(v.get("secure", False)),
            presign_ttl_seconds=int(v.get("presign_ttl", 3600) or 3600),
        )

    @property
    def enabled(self) -> bool:
        return all([self.endpoint, self.access_key, self.secret_key, self.bucket])


class MinioService:
    def __init__(self, config: MinioConfig | None = None):
        self.config = config or MinioConfig.from_env()
        self._client = None
        self._init_error: str | None = None

    @property
    def enabled(self) -> bool:
        return self.config.enabled and self._client is not None

    @property
    def init_error(self) -> str | None:
        return self._init_error

    async def initialize(self) -> None:
        if not self.config.enabled:
            log_info("MinIO disabled — missing configuration")
            return
        try:
            from minio import Minio
        except ImportError as exc:
            self._init_error = str(exc)
            log_error("MinIO client dependency missing", error=str(exc))
            return

        try:
            client = Minio(
                self.config.endpoint,
                access_key=self.config.access_key,
                secret_key=self.config.secret_key,
                secure=self.config.secure,
            )
            bucket = self.config.bucket
            exists = await asyncio.to_thread(client.bucket_exists, bucket)
            if not exists:
                await asyncio.to_thread(client.make_bucket, bucket)
            self._client = client
            self._init_error = None
            log_info("MinIO ready", bucket=bucket, endpoint=self.config.endpoint)
        except Exception as exc:
            self._init_error = str(exc)
            self._client = None
            log_error("MinIO initialization failed", error=str(exc))

    async def upload_bytes(
        self,
        *,
        object_key: str,
        data: bytes,
        content_type: str,
    ) -> dict[str, Any]:
        if not self.enabled or self._client is None:
            raise RuntimeError(self._init_error or "MinIO service is not initialized")

        result = await asyncio.to_thread(
            self._client.put_object,
            self.config.bucket,
            object_key,
            io.BytesIO(data),
            len(data),
            content_type=content_type,
        )
        return {
            "bucket": self.config.bucket,
            "object_key": object_key,
            "minio_uri": f"minio://{self.config.bucket}/{object_key}",
            "etag": getattr(result, "etag", ""),
            "version_id": getattr(result, "version_id", "") or "",
        }

    def build_locator(self, object_key: str) -> dict[str, str]:
        if not self.config.bucket:
            return {"bucket": "", "object_key": object_key, "minio_uri": ""}
        return {
            "bucket": self.config.bucket,
            "object_key": object_key,
            "minio_uri": f"minio://{self.config.bucket}/{object_key}",
        }

    async def presign_get(self, object_key: str) -> str | None:
        if not self.enabled or self._client is None:
            return None
        try:
            return await asyncio.to_thread(
                self._client.presigned_get_object,
                self.config.bucket,
                object_key,
                expires=timedelta(seconds=self.config.presign_ttl_seconds),
            )
        except Exception as exc:
            log_warning("MinIO presign failed", object_key=object_key, error=str(exc))
            return None

    async def download_bytes(self, object_key: str) -> bytes:
        if not self.enabled or self._client is None:
            raise RuntimeError(self._init_error or "MinIO service is not initialized")
        response = await asyncio.to_thread(
            self._client.get_object,
            self.config.bucket,
            object_key,
        )
        try:
            return await asyncio.to_thread(response.read)
        finally:
            await asyncio.to_thread(response.close)
            await asyncio.to_thread(response.release_conn)

    async def remove_object(self, object_key: str) -> None:
        if not self.enabled or self._client is None:
            return
        try:
            await asyncio.to_thread(
                self._client.remove_object,
                self.config.bucket,
                object_key,
            )
        except Exception as exc:
            log_warning("MinIO remove failed", object_key=object_key, error=str(exc))

    async def probe_readiness(self) -> dict[str, Any]:
        """Return a lightweight readiness probe payload for admin diagnostics."""
        endpoint = self.config.endpoint
        if not self.config.enabled:
            return {
                "status": "degraded",
                "endpoint": endpoint,
                "latency_ms": None,
                "message": "MinIO disabled by configuration.",
                "details": {
                    "bucket": self.config.bucket,
                    "state": "disabled",
                },
            }
        if self._client is None:
            return {
                "status": "error",
                "endpoint": endpoint,
                "latency_ms": None,
                "message": self._init_error or "MinIO client is not initialized.",
                "details": {
                    "bucket": self.config.bucket,
                    "state": "init_failed",
                },
            }
        started = perf_counter()
        exists = await asyncio.to_thread(self._client.bucket_exists, self.config.bucket)
        latency_ms = max(int((perf_counter() - started) * 1000), 0)
        return {
            "status": "ok" if exists else "error",
            "endpoint": endpoint,
            "latency_ms": latency_ms,
            "message": (
                f"Bucket {self.config.bucket} is reachable."
                if exists
                else f"Bucket {self.config.bucket} does not exist."
            ),
            "details": {
                "bucket": self.config.bucket,
                "secure": self.config.secure,
            },
        }

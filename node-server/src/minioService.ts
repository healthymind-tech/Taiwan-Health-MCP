/**
 * MinIO health/probe service.
 *
 * Faithful port of the init/probe surface of `src/minio_service.py`
 * (`MinioConfig.from_values` + `MinioService.initialize` + `enabled`/
 * `init_error`). Only what the admin `storage` block and service probes need:
 * connect with the DB-stored "minio" settings group, ensure the bucket exists,
 * and expose `enabled` / `bucket` / `initError`. Presigned downloads / uploads
 * stay with the L3/drug-asset port.
 *
 * Parity notes:
 *  - `config.enabled` = all of [endpoint, accessKey, secretKey, bucket] truthy.
 *  - service `enabled` = config.enabled AND a connected client (bucketExists OK).
 *  - The `minio` npm Client wants `endPoint` host + numeric `port` separately,
 *    whereas the Python client parses a single "host:port" string — so we split
 *    the configured endpoint on ":".
 */

import { Client as MinioClient } from "minio";
import * as adminSettings from "./admin/adminSettings.js";
import { logError, logInfo, logWarning } from "./logger.js";

interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  secure: boolean;
  presignTtlSeconds: number;
}

/** Mirror `MinioConfig.from_values` (DB "minio" settings group). */
function configFromValues(v: Record<string, string | number | boolean>): MinioConfig {
  return {
    endpoint: String((v.endpoint ?? "") || "").trim(),
    accessKey: String((v.access_key ?? "") || "").trim(),
    secretKey: String((v.secret_key ?? "") || "").trim(),
    bucket: String((v.bucket ?? "") || "").trim(),
    secure: Boolean(v.secure ?? false),
    presignTtlSeconds: Number(v.presign_ttl || 3600) || 3600,
  };
}

/** Mirror `MinioConfig.enabled`. */
function configEnabled_(c: MinioConfig): boolean {
  return Boolean(c.endpoint && c.accessKey && c.secretKey && c.bucket);
}

let _config: MinioConfig | null = null;
let _client: MinioClient | null = null;
let _initError: string | null = null;

/** Service-level `enabled`: config complete AND a live client. */
export function enabled(): boolean {
  return _config !== null && configEnabled_(_config) && _client !== null;
}

export function bucket(): string {
  return _config?.bucket ?? "";
}

/**
 * Upload bytes to the configured bucket. Mirrors `MinioService.upload_bytes`:
 * returns the locator dict ({bucket, object_key, minio_uri, etag, version_id}).
 * Throws when the service is not enabled (→ RuntimeError-equivalent upstream).
 */
export async function uploadBytes(opts: {
  objectKey: string;
  data: Buffer;
  contentType: string;
}): Promise<{ bucket: string; object_key: string; minio_uri: string; etag: string; version_id: string }> {
  if (!enabled() || _client === null || _config === null) {
    throw new Error(_initError ?? "MinIO service is not initialized");
  }
  const result = await _client.putObject(_config.bucket, opts.objectKey, opts.data, opts.data.length, {
    "Content-Type": opts.contentType,
  });
  return {
    bucket: _config.bucket,
    object_key: opts.objectKey,
    minio_uri: `minio://${_config.bucket}/${opts.objectKey}`,
    etag: result?.etag ?? "",
    version_id: result?.versionId ?? "",
  };
}

/** Remove an object; best-effort, never throws. Mirrors `MinioService.remove_object`. */
export async function removeObject(objectKey: string): Promise<void> {
  if (!enabled() || _client === null || _config === null) return;
  try {
    await _client.removeObject(_config.bucket, objectKey);
  } catch (exc) {
    logWarning("MinIO remove failed", { object_key: objectKey, error: String((exc as Error).message) });
  }
}

/** Config-level enabled (all creds present) regardless of client connectivity. */
export function configEnabled(): boolean {
  return _config !== null && configEnabled_(_config);
}

export function initError(): string | null {
  return _initError;
}

/** True once `initialize()` has run (mirrors `minio_service is not None`). */
export function initialized(): boolean {
  return _config !== null;
}

/**
 * Faithful port of `MinioService.initialize`: read the "minio" settings group,
 * connect, and ensure the bucket exists. Fail-open — errors are recorded in
 * `_initError` and leave the service disabled, never throwing.
 */
export async function initialize(): Promise<void> {
  let values: Record<string, string | number | boolean>;
  try {
    values = await adminSettings.getGroup("minio");
  } catch (exc) {
    _config = configFromValues({});
    _initError = String((exc as Error).message);
    logError("MinIO initialization failed", { error: _initError });
    return;
  }
  _config = configFromValues(values);
  if (!configEnabled_(_config)) {
    logInfo("MinIO disabled — missing configuration");
    return;
  }
  try {
    const [host, portStr] = _config.endpoint.split(":");
    const port = portStr ? Number.parseInt(portStr, 10) : _config.secure ? 443 : 80;
    const client = new MinioClient({
      endPoint: host,
      port,
      useSSL: _config.secure,
      accessKey: _config.accessKey,
      secretKey: _config.secretKey,
    });
    const exists = await client.bucketExists(_config.bucket);
    if (!exists) await client.makeBucket(_config.bucket);
    _client = client;
    _initError = null;
    logInfo("MinIO ready", { bucket: _config.bucket, endpoint: _config.endpoint });
  } catch (exc) {
    _initError = String((exc as Error).message);
    _client = null;
    logError("MinIO initialization failed", { error: _initError });
  }
}

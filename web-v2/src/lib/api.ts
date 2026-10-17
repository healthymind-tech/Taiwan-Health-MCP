/**
 * Thin fetch wrapper for /admin/api/*.
 *
 * The backend issues an HttpOnly SameSite=Lax session cookie scoped to /admin;
 * the SPA never sees the token. A 401 anywhere means the session ended, so we
 * route to the login page (remembering where the user was).
 */

import { notifyDbUnavailable } from "./dbHealth";

export class ApiError extends Error {
  status: number;
  detail?: string;
  body?: unknown;
  constructor(message: string, status: number, detail?: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.body = body;
  }
  override toString(): string {
    return this.detail ? `${this.message}: ${this.detail}` : this.message;
  }
}

/** Human-readable message for any thrown value (toasts, inline errors). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.detail ? `${err.message}（${err.detail}）` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

type Init = Omit<RequestInit, "body"> & { json?: unknown; rawBody?: BodyInit; skipAuthRedirect?: boolean };

export async function request<T>(path: string, init: Init = {}): Promise<T> {
  const { json, rawBody, headers, skipAuthRedirect, ...rest } = init;
  const h = new Headers(headers);
  let body: BodyInit | undefined;
  if (json !== undefined) {
    h.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  } else if (rawBody !== undefined) {
    body = rawBody;
  }
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", headers: h, body, ...rest });
  } catch {
    throw new ApiError("無法連線到伺服器，請檢查網路", 0);
  }

  if (res.status === 401 && !skipAuthRedirect) {
    onUnauthorized?.();
    throw new ApiError("登入已過期，請重新登入", 401);
  }

  const ct = res.headers.get("content-type") ?? "";
  const payload: unknown = ct.includes("application/json") ? await res.json().catch(() => null) : await res.text().catch(() => null);
  const obj = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;

  if (res.status === 503 && obj.error === "database_unavailable") notifyDbUnavailable();

  if (!res.ok) {
    const msg = (typeof obj.error === "string" && obj.error) || (typeof obj.message === "string" && obj.message) || `請求失敗（HTTP ${res.status}）`;
    const detail = typeof obj.detail === "string" ? obj.detail : undefined;
    throw new ApiError(msg, res.status, detail, payload);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, init?: Init) => request<T>(path, { ...init, method: "GET" }),
  post: <T>(path: string, json?: unknown, init?: Init) => request<T>(path, { ...init, method: "POST", json: json ?? {} }),
  patch: <T>(path: string, json?: unknown) => request<T>(path, { method: "PATCH", json: json ?? {} }),
  put: <T>(path: string, json?: unknown) => request<T>(path, { method: "PUT", json: json ?? {} }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/** Build a query string, dropping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

/**
 * Upload a raw file body with progress (XHR — fetch has no upload progress).
 * The backend reads the body as application/octet-stream; metadata goes in the query.
 */
export function uploadFile<T>(
  path: string,
  file: Blob,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.({ loaded: e.loaded, total: e.total });
    };
    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = xhr.responseText;
      }
      if (xhr.status === 401) {
        onUnauthorized?.();
        reject(new ApiError("登入已過期，請重新登入", 401));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload as T);
      else {
        const obj = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
        const msg =
          xhr.status === 413
            ? `檔案超過上傳上限${obj.max_upload_mb ? `（${obj.max_upload_mb} MB）` : ""}`
            : (typeof obj.error === "string" && obj.error) || `上傳失敗（HTTP ${xhr.status}）`;
        reject(new ApiError(msg, xhr.status, typeof obj.detail === "string" ? obj.detail : undefined, payload));
      }
    };
    xhr.onerror = () => reject(new ApiError("上傳時網路中斷", 0));
    xhr.onabort = () => reject(new ApiError("已取消上傳", 0));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

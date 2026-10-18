/**
 * Thin fetch wrapper for /admin/api/*.
 *
 * The backend issues an HttpOnly SameSite=Lax session cookie scoped to /admin;
 * the SPA never sees the token. A 401 anywhere means the session ended, so we
 * route to the login page (remembering where the user was).
 */

import { notifyDbUnavailable } from "./dbHealth";

/**
 * A failed admin API call.
 *
 * The backend (node-server/src/admin/adminErrorCodes.ts) explains every error
 * body with a stable `code`, a zh-TW `message_zh` and a next step `hint_zh`.
 * `message` is the zh text when present (else the server's `error`),
 * `rawMessage` the server's original `error` (English; for field matching),
 * `detail` the raw technical cause — shown only under 「技術細節」.
 */
export class ApiError extends Error {
  status: number;
  detail?: string;
  body?: unknown;
  code?: string;
  hint?: string;
  rawMessage: string;
  constructor(message: string, status: number, detail?: string, body?: unknown) {
    const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const zh = typeof obj.message_zh === "string" && obj.message_zh ? obj.message_zh : undefined;
    super(zh ?? message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.body = body;
    this.rawMessage = message;
    this.code = typeof obj.code === "string" ? obj.code : undefined;
    this.hint = typeof obj.hint_zh === "string" && obj.hint_zh ? obj.hint_zh : undefined;
  }
  /** True when the server explained the error (zh message), so the raw detail is only technical context. */
  get explained(): boolean {
    return this.message !== this.rawMessage || this.hint !== undefined;
  }
  override toString(): string {
    return this.detail ? `${this.message}: ${this.detail}` : this.message;
  }
}

/** The parts of an error for rich rendering: what happened, what to do, raw technical text. */
export interface ErrorParts {
  message: string;
  hint?: string;
  detail?: string;
}

export function errorParts(err: unknown): ErrorParts {
  if (err instanceof ApiError) {
    if (err.explained) return { message: err.message, hint: err.hint, detail: err.detail ?? (err.rawMessage !== err.message ? err.rawMessage : undefined) };
    return { message: err.detail ? `${err.message}（${err.detail}）` : err.message };
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

/** Human-readable message for any thrown value (toasts, inline errors): what happened + what to do. */
export function errorMessage(err: unknown): string {
  const p = errorParts(err);
  return p.hint ? `${p.message} ${p.hint}` : p.message;
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
    throw new ApiError(msg, res.status, detail, typeof payload === "object" && payload ? payload : gatewayExplanation(res.status) ?? payload);
  }
  return payload as T;
}

/**
 * A non-JSON error page means the request never reached the app (nginx answered):
 * explain the common gateway statuses instead of "HTTP 502".
 */
function gatewayExplanation(status: number): Record<string, string> | null {
  if (status === 502 || status === 504)
    return {
      code: "BACKEND_UNAVAILABLE",
      message_zh: status === 504 ? "後端服務沒有在時限內回應（HTTP 504）。" : "後端服務目前沒有回應（HTTP 502）。",
      hint_zh: "app 容器可能正在重新啟動或已停止；請稍候數十秒再試，若持續發生請檢查 app 容器狀態與日誌。",
    };
  if (status === 503) return { code: "SERVICE_UNAVAILABLE", message_zh: "服務暫時無法使用（HTTP 503）。", hint_zh: "請稍候再試。" };
  if (status === 413) return { code: "PAYLOAD_TOO_LARGE", message_zh: "送出的內容太大，被伺服器拒絕（HTTP 413）。", hint_zh: "請確認檔案是否正確；大型檔案請用上傳功能，或調高 nginx 的 client_max_body_size。" };
  return null;
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
        const body =
          xhr.status === 413
            ? { ...obj, code: "UPLOAD_TOO_LARGE", message_zh: `${msg}。`, hint_zh: obj.hint_zh ?? "請確認檔案是否正確；大型官方檔案可調高 ADMIN_MAX_UPLOAD_MB（.env）後重啟 app。" }
            : typeof payload === "object" && payload
              ? payload
              : (gatewayExplanation(xhr.status) ?? payload);
        reject(new ApiError(msg, xhr.status, typeof obj.detail === "string" ? obj.detail : undefined, body));
      }
    };
    xhr.onerror = () => reject(new ApiError("上傳時網路中斷", 0));
    xhr.onabort = () => reject(new ApiError("已取消上傳", 0));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

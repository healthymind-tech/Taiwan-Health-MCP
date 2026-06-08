// Thin fetch wrapper for the /admin/api/* surface.
//
// Auth: the Python server issues an HttpOnly SameSite=Lax session cookie
// (tw_health_admin_session). The SPA never touches the token — the browser
// attaches the cookie automatically because the SPA is served same-origin.
// On 401 we bounce to the server-rendered login page.

import { notifyDbUnavailable } from "./dbHealth";

export class ApiError extends Error {
  status: number;
  detail?: string;
  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

const LOGIN_PATH = "/admin/login";

function redirectToLogin(): void {
  // Full navigation so the server can re-issue / clear the session cookie.
  window.location.href = LOGIN_PATH;
}

type ApiInit = Omit<RequestInit, "body"> & {
  json?: unknown;
  form?: Record<string, string>;
  // Raw body (e.g. multipart FormData for uploads). The browser sets the
  // Content-Type header itself, so do not set it manually.
  rawBody?: BodyInit;
};

async function request<T>(path: string, init: ApiInit = {}): Promise<T> {
  const { json, form, rawBody, headers, ...rest } = init;

  const finalHeaders = new Headers(headers);
  let body: BodyInit | undefined;

  if (json !== undefined) {
    finalHeaders.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    finalHeaders.set("Content-Type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(form).toString();
  } else if (rawBody !== undefined) {
    body = rawBody;
  }

  const res = await fetch(path, {
    credentials: "same-origin",
    headers: finalHeaders,
    body,
    ...rest,
  });

  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError("Authentication required", 401);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await res.json().catch(() => null)
    : null;

  // A gated database surfaces as 503 {error: "database_unavailable"} — signal the
  // DbHealthGate so it shows the recovery overlay immediately (still throws below).
  if (res.status === 503 && payload?.error === "database_unavailable") {
    notifyDbUnavailable();
  }

  if (!res.ok) {
    const message =
      (payload && (payload.error as string)) || `Request failed (${res.status})`;
    throw new ApiError(message, res.status, payload?.detail);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, json?: unknown) => request<T>(path, { method: "POST", json }),
  patch: <T>(path: string, json?: unknown) => request<T>(path, { method: "PATCH", json }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  postForm: <T>(path: string, form: Record<string, string>) =>
    request<T>(path, { method: "POST", form }),
  // Multipart (file uploads) — caller supplies a ready FormData.
  upload: <T>(path: string, formData: FormData) =>
    request<T>(path, { method: "POST", rawBody: formData }),
};

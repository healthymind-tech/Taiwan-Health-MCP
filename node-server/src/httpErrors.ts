/**
 * Final Express error handler.
 *
 * Without it Express's default handler prints `err.stack` to stderr and echoes
 * it in an HTML response. For a malformed JSON body that stack starts with
 * V8's JSON.parse message, which quotes a slice of the request body — for the
 * grounding tools that body is a clinical record (`source_text`), which must
 * never reach the logs (MCP_GROUNDING_SPEC §6.7). Body-parser failures are
 * therefore answered with a fixed JSON error and logged without any message
 * (only route + error type). Other errors are logged with name, route and a
 * clipped message (they come from code, not from request bodies).
 */
import type { ErrorRequestHandler } from "express";
import { logError, logWarning } from "./logger.js";

/** HTTP status of a body-parser / raw-body error (string `type`, e.g. entity.parse.failed, and a 4xx status), else 0. */
function bodyErrorStatus(err: unknown): number {
  if (!err || typeof err !== "object") return 0;
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 0;
  return typeof e.type === "string" && status >= 400 && status < 500 ? status : 0;
}

export const finalErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = bodyErrorStatus(err);
  if (status) {
    const type = String((err as { type: string }).type);
    logWarning("request body rejected", { route: req.path, type });
    const tooLarge = type === "entity.too.large";
    res.status(status).json({
      error: tooLarge ? "payload_too_large" : "invalid_request_body",
      // Admin console: say what happened and what to do (additive fields; MCP clients keep the bare code).
      ...(req.path.startsWith("/admin/")
        ? tooLarge
          ? { code: "PAYLOAD_TOO_LARGE", message_zh: "送出的內容超過 4 MB 上限。", hint_zh: "大型檔案請改用上傳功能（來源檔案 / IG 上傳）。" }
          : { code: "INVALID_JSON", message_zh: "送出的內容不是有效的 JSON。", hint_zh: "請檢查檔案或輸入是否完整（括號、逗號、引號），再重新送出。" }
        : {}),
    });
    return;
  }
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message.slice(0, 300) : "";
  logError("unhandled request error", { route: req.path, error: name, message });
  res.status(500).json({
    error: "internal_error",
    ...(req.path.startsWith("/admin/")
      ? { code: "INTERNAL_ERROR", message_zh: "伺服器發生未預期的錯誤。", hint_zh: "請稍後再試；若持續發生，請查看 app 容器日誌（docker compose logs app）。" }
      : {}),
  });
};

/**
 * ChatGPT plan usage via OpenAI's official "Sign in with ChatGPT" (preview) for
 * open-source / self-hosted apps.
 * Docs: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 *
 * - POST https://api.openai.com/v1/responses with the account's access token;
 *   `store:false` and `stream:true` are mandatory; success only on
 *   `response.completed`.
 * - Preview limits: no temperature / top_p / max_output_tokens; a system-role
 *   input item is not accepted, so system text goes in `instructions`.
 * - Never ChatGPT's backend-api endpoints (explicitly not sanctioned).
 */

import type { LlmProfile } from "../admin/llmProfiles.js";
import { detectTruncation, getJson, pStr, stripJsonFence } from "./common.js";
import { ProviderHttpError, ProviderReplyError, type CallContext, type ChatRequest, type ChatResult, type ProviderAdapter } from "./types.js";

const ROOT = "https://api.openai.com/v1";

async function token(p: LlmProfile): Promise<string> {
  if (!p.account_id) throw new Error("ChatGPT accounts need a signed-in provider account.");
  // Imported lazily: the OAuth module sits in admin/ and imports the routing layer.
  const { getChatgptAccessToken } = await import("../admin/chatgptOAuth.js");
  return getChatgptAccessToken(p.account_id);
}

export function buildResponsesBody(p: LlmProfile, req: ChatRequest): Record<string, unknown> {
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const body: Record<string, unknown> = {
    model: p.model,
    input: req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    store: false,
    stream: true,
  };
  if (system) body.instructions = system;
  if (req.json) body.text = { format: { type: "json_object" } };
  const effort = pStr(p.params, "reasoning_effort");
  if (effort) body.reasoning = { effort };
  return body;
}

interface SseOutcome {
  text: string;
  reasoningChars: number;
  status: "completed" | "incomplete" | "failed" | "none";
  usage: Record<string, unknown>;
  detail: string;
}

/** Read an SSE body (event/data lines) into the final text, usage and outcome. */
export function parseResponsesStream(raw: string): SseOutcome {
  const out: SseOutcome = { text: "", reasoningChars: 0, status: "none", usage: {}, detail: "" };
  let finalText = "";
  // SSE allows CRLF, LF or a bare CR as the line terminator.
  for (const block of raw.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(evt.type ?? "");
    const response = (evt.response ?? {}) as Record<string, unknown>;
    if (type === "response.output_text.delta") out.text += String(evt.delta ?? "");
    else if (type.startsWith("response.reasoning") && type.endsWith(".delta")) out.reasoningChars += String(evt.delta ?? "").length;
    else if (type === "response.completed" || type === "response.incomplete") {
      out.status = type === "response.completed" ? "completed" : "incomplete";
      out.usage = (response.usage ?? {}) as Record<string, unknown>;
      out.detail = String(((response.incomplete_details ?? {}) as Record<string, unknown>).reason ?? "");
      // Fall back to the assembled output when no deltas were streamed.
      for (const item of (response.output ?? []) as Record<string, unknown>[]) {
        for (const c of (item.content ?? []) as Record<string, unknown>[]) if (c.type === "output_text") finalText += String(c.text ?? "");
      }
    } else if (type === "response.failed" || type === "error") {
      out.status = "failed";
      const e = (response.error ?? evt.error ?? evt) as Record<string, unknown>;
      out.detail = `${String(e.code ?? "")} ${String(e.message ?? "")}`.trim();
    }
  }
  if (!out.text && finalText) out.text = finalText;
  return out;
}

async function chat(p: LlmProfile, req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
  const body = buildResponsesBody(p, req);
  const dropped: string[] = [];
  let res: Response | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r = await ctx.fetch(`${ROOT}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(p)}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      res = r;
      break;
    }
    const text = await r.text();
    let err: Record<string, unknown> = {};
    try {
      err = ((JSON.parse(text) as Record<string, unknown>).error ?? {}) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    const param = String(err.param ?? "").split(".")[0];
    if (err.code === "subscription_sharing_unsupported_capability" && param && param in body && param !== "model" && param !== "input") {
      if (param === "instructions") {
        // Fold the system text into the first user turn instead.
        const input = body.input as { role: string; content: string }[];
        if (input[0]) input[0] = { ...input[0], content: `${String(body.instructions)}\n\n${input[0].content}` };
      }
      delete body[param];
      dropped.push(param);
      continue;
    }
    throw new ProviderHttpError(r.status, text, `${ROOT}/responses`);
  }
  if (!res) throw new Error("ChatGPT kept rejecting request parameters.");
  const outcome = parseResponsesStream(await res.text());
  if (outcome.status === "failed") throw new ProviderReplyError(`ChatGPT response failed: ${outcome.detail}`);
  if (outcome.status === "none") throw new ProviderReplyError("ChatGPT stream ended without response.completed.");
  const usage = outcome.usage;
  const details = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
  const content = req.json ? stripJsonFence(outcome.text) : outcome.text;
  return {
    content,
    finishReason: outcome.status === "incomplete" ? outcome.detail || "incomplete" : "stop",
    truncated:
      outcome.status === "incomplete" ||
      detectTruncation({ provider: "ChatGPT", content, finishReason: "stop", cutReasons: [], reasoningChars: outcome.reasoningChars }),
    usage: {
      promptTokens: Number(usage.input_tokens) || 0,
      completionTokens: Number(usage.output_tokens) || 0,
      reasoningTokens: details.reasoning_tokens === undefined ? null : Number(details.reasoning_tokens) || 0,
    },
    reasoningChars: outcome.reasoningChars,
    droppedParams: dropped,
  };
}

async function listModels(p: LlmProfile, _role: "analysis" | "embedding", ctx: CallContext): Promise<string[]> {
  const j = await getJson(ctx, `${ROOT}/models`, { authorization: `Bearer ${await token(p)}` });
  const models = (j.models ?? j.data ?? []) as Record<string, unknown>[];
  return models
    .filter((m) => m.visibility === undefined || m.visibility === "list")
    .map((m) => String(m.slug ?? m.id ?? ""))
    .filter(Boolean)
    .sort();
}

export const chatgpt: ProviderAdapter = {
  spec: {
    id: "chatgpt",
    label: "ChatGPT 訂閱（Sign in with ChatGPT）",
    category: "subscription",
    description:
      "用 ChatGPT Plus／Pro 帳號登入，以方案額度呼叫模型（OpenAI 官方預覽功能，僅限開源／自架應用）。不需要 API 金鑰，用量算在該帳號的方案內。",
    roles: ["analysis"],
    baseUrl: { default: ROOT, fixed: true },
    keyRequired: false,
    auth: "oauth_chatgpt",
    keyHelp: "以 ChatGPT 帳號登入取得授權，不使用 API 金鑰。",
    modelExamples: { analysis: ["gpt-6-luna", "gpt-6.1-sol"] },
    canListModels: true,
    docsUrl: "https://developers.openai.com/siwc/token-sharing-open-source",
    warnings: [
      "適用 ChatGPT 消費者條款：除非在 ChatGPT「資料控制」關閉，對話可能被用於訓練模型；沒有 BAA。不得處理可識別個人的病患資料。",
      "這是 OpenAI 的預覽功能，可能隨時變更或停止；不支援 temperature、輸出上限等參數。",
      "用量算在該 ChatGPT 帳號的方案額度內（Plus 有 5 小時與每週上限），額度用完時請求會失敗。",
      "一個登入只屬於登入的那位管理員，不可多人共用帳號。部署成對外的商業服務需先取得 OpenAI 合作夥伴核准。",
    ],
    params: [
      {
        key: "reasoning_effort",
        type: "select",
        label: "推理強度",
        help: "推理模型思考的深度。預覽期間端點不接受時會自動略過。",
        roles: ["analysis"],
        group: "reasoning",
        options: [
          { value: "low", label: "low" },
          { value: "medium", label: "medium" },
          { value: "high", label: "high" },
        ],
        placeholder: "模型預設",
      },
    ],
  },
  // The preview rejects max_output_tokens: re-sending with a "bigger budget"
  // would repeat the identical request and burn plan quota.
  ignoresMaxTokens: true,
  chat,
  listModels,
};

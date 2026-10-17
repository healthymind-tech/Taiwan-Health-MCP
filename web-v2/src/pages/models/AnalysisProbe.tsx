import { Alert, Anchor, Badge, Box, Group, Progress, SimpleGrid, Stack, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { fmtNumber } from "@/lib/format";
import { llmText } from "./llmErrors";

/** Shape returned by POST /admin/api/llm/models/test for kind=analysis (adminSettings.ts testAnalysis). */
export interface ProbeResult {
  ok: boolean;
  message?: string;
  code?: string;
  params?: Record<string, unknown>;
  details?: Record<string, unknown>;
  models?: string[];
}

interface Residency {
  loaded?: boolean;
  model_size_bytes?: number;
  vram_bytes?: number;
  gpu_ratio?: number | null;
  context_length?: number | null;
}

/** One-click remedies the drawer can apply to its draft. */
export type ProbeFix = { kind: "num_ctx"; value: number } | { kind: "reasoning_off" };

const SUGGESTED_NUM_CTX = 32768;

function num(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
}

function seconds(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
}

function gb(bytes: number | undefined): string {
  return bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : "—";
}

/** The backend speaks English; show the operator Chinese for the known cases. */
function localizeMessage(r: ProbeResult): string {
  const d = r.details ?? {};
  const msg = r.message ?? "";
  if (d.timed_out) {
    return `在 ${Math.round((num(d.timeout_ms) ?? 0) / 1000)} 秒內沒有回應（測試上限）。端點連得上，但生成太慢或模型仍在載入。`;
  }
  if (r.ok) return `收到回覆，總耗時 ${seconds(num(d.latency_ms))}。`;
  if (msg.startsWith("The model used all")) return `模型用完 ${fmtNumber(num(d.max_tokens) ?? 0)} 個輸出 token 仍未作答（多半花在思考上）。`;
  if (msg.startsWith("The endpoint replied with an empty")) return "端點回傳了空白內容。";
  if (msg.startsWith("Base URL and model are required")) return "需要 Base URL 與模型。";
  if (msg.startsWith("Analysis test failed: ")) return `測試失敗：${msg.slice("Analysis test failed: ".length)}`;
  return llmText(r, msg);
}

interface Finding {
  key: string;
  text: ReactNode;
  fix?: { label: string; fix: ProbeFix };
}

function findings(d: Record<string, unknown>, numCtx: number | "", canFixContext: boolean, canFixThinking: boolean): Finding[] {
  const res = (d.residency ?? null) as Residency | null;
  const codes = new Set<string>(Array.isArray(d.warnings) ? (d.warnings as string[]) : []);
  // A timed-out probe still reports residency; derive the GPU hints from it.
  if (res?.gpu_ratio != null && res.gpu_ratio < 0.99) codes.add("partial_gpu");
  if ((res?.context_length ?? 0) >= 131_072 && numCtx === "") codes.add("large_context");
  const ctxFix =
    canFixContext && (numCtx === "" || numCtx > SUGGESTED_NUM_CTX)
      ? { label: `將上下文長度設為 ${fmtNumber(SUGGESTED_NUM_CTX)}`, fix: { kind: "num_ctx", value: SUGGESTED_NUM_CTX } as ProbeFix }
      : undefined;

  const out: Finding[] = [];
  const loadMs = num(d.load_ms);
  if (loadMs !== null && loadMs >= 5000) {
    out.push({
      key: "cold",
      text: (
        <>
          本次包含 <b>{seconds(loadMs)}</b> 的模型載入時間（模型剛載入或因設定變更而重新載入）。再測一次可看到常駐後的實際速度。
        </>
      ),
    });
  }
  if (codes.has("partial_gpu") && res) {
    out.push({
      key: "partial_gpu",
      text: (
        <>
          模型只有 <b>{Math.round((res.gpu_ratio ?? 0) * 100)}%</b> 放在 GPU（{gb(res.vram_bytes)} / {gb(res.model_size_bytes)}），其餘在 CPU
          記憶體，生成會非常慢。可縮小上下文長度、改用較小的模型，或避免同一張卡同時跑其他模型（例如 Embedding）。
        </>
      ),
      fix: ctxFix,
    });
  }
  if (codes.has("large_context") && res?.context_length) {
    out.push({
      key: "large_context",
      text: (
        <>
          伺服器以 <b>{fmtNumber(res.context_length)}</b> 的上下文長度載入模型（未指定 num_ctx 時 Ollama 可能使用模型上限），KV 快取會佔用大量顯存。藥品仿單通常
          32k 就足夠。
        </>
      ),
      fix: codes.has("partial_gpu") ? undefined : ctxFix,
    });
  }
  if (codes.has("slow_generation")) {
    out.push({
      key: "slow",
      text: (
        <>
          生成速度只有 <b>{num(d.tokens_per_sec)} token/秒</b>。一份仿單通常要輸出數千個 token，每份可能需要數十分鐘。
        </>
      ),
    });
  }
  if (codes.has("thinking_used")) {
    const n = num(d.reasoning_tokens) ?? num(d.reasoning_chars) ?? 0;
    out.push({
      key: "thinking",
      text: (
        <>
          模型在回答前先「思考」了（{fmtNumber(n)} {num(d.reasoning_tokens) !== null ? "token" : "字元"}）。結構化萃取通常不需要思考，關閉可大幅縮短時間與輸出預算。
        </>
      ),
      fix: canFixThinking ? { label: "關閉思考", fix: { kind: "reasoning_off" } } : undefined,
    });
  }
  if (codes.has("budget_exhausted")) {
    out.push({ key: "budget", text: <>測試用的 {fmtNumber(num(d.max_tokens) ?? 0)} 個輸出 token 被用完才停止。</> });
  }
  if (codes.has("json_invalid")) {
    out.push({ key: "json", text: <>回覆不是合法的 JSON，實際萃取時可能解析失敗。</> });
  }
  if (codes.has("params_dropped") && Array.isArray(d.params_dropped)) {
    out.push({
      key: "dropped",
      text: (
        <>
          端點不接受下列參數，已自動略過（實際工作也會如此）：<code>{(d.params_dropped as string[]).join("、")}</code>
        </>
      ),
    });
  }
  return out;
}

function Metric({ label, value, hint, color }: { label: string; value: ReactNode; hint?: string; color?: string }) {
  const body = (
    <Box>
      <Text fz={10} c="dimmed" fw={600}>
        {label}
      </Text>
      <Text fz="sm" fw={600} c={color} className="tabular">
        {value}
      </Text>
    </Box>
  );
  return hint ? <Tooltip label={hint} multiline maw={260}>{body}</Tooltip> : body;
}

/** Analysis-endpoint probe result: verdict, timing breakdown, GPU residency and actionable warnings. */
export function AnalysisProbe({
  result,
  numCtx = "",
  canFixContext = false,
  canFixThinking = false,
  compact = false,
  onFix,
  onClose,
}: {
  result: ProbeResult;
  numCtx?: number | "";
  canFixContext?: boolean;
  canFixThinking?: boolean;
  compact?: boolean;
  onFix?: (fix: ProbeFix) => void;
  onClose?: () => void;
}) {
  const d = result.details ?? {};
  const res = (d.residency ?? null) as Residency | null;
  const list = findings(d, numCtx, canFixContext, canFixThinking);
  const color = !result.ok ? "red" : list.length ? "amber" : "teal";
  const tps = num(d.tokens_per_sec);
  const thinking = num(d.reasoning_tokens) ?? num(d.reasoning_chars);

  return (
    <Alert
      color={color}
      p={compact ? "xs" : "md"}
      icon={result.ok ? list.length ? <IconAlertTriangle size={18} /> : <IconCheck size={18} /> : <IconX size={18} />}
      title={compact ? undefined : result.ok ? (list.length ? "可以連線，但有需要注意的地方" : "連線測試成功") : "連線測試失敗"}
      withCloseButton={Boolean(onClose)}
      onClose={onClose}
    >
      <Stack gap="sm">
        <Text fz={compact ? "xs" : "sm"} style={{ wordBreak: "break-word" }}>
          {localizeMessage(result)}
        </Text>

        {!compact && (num(d.latency_ms) !== null || res) && (
          <SimpleGrid cols={{ base: 2, xs: 4 }} spacing="xs" verticalSpacing="xs">
            <Metric label="總耗時" value={seconds(num(d.latency_ms))} />
            {num(d.load_ms) !== null && <Metric label="載入模型" value={seconds(num(d.load_ms))} hint="模型尚未在記憶體時的載入時間" />}
            {num(d.prompt_eval_ms) !== null && <Metric label="讀入提示" value={seconds(num(d.prompt_eval_ms))} hint="處理輸入（prompt）的時間" />}
            {tps !== null && (
              <Metric
                label="生成速度"
                value={`${tps} tok/s`}
                color={(num(d.output_tokens) ?? 0) < 20 ? undefined : tps < 5 ? "red" : tps < 15 ? "amber.7" : undefined}
                hint={(num(d.output_tokens) ?? 0) < 20 ? "輸出 token 太少，僅供參考" : "輸出 token ÷ 生成時間"}
              />
            )}
            {num(d.output_tokens) !== null && <Metric label="輸出 token" value={fmtNumber(num(d.output_tokens) ?? 0)} />}
            {thinking !== null && thinking > 0 && (
              <Metric label="思考" value={`${fmtNumber(thinking)} ${num(d.reasoning_tokens) !== null ? "tok" : "字"}`} color="amber.7" />
            )}
            {res?.context_length ? <Metric label="上下文長度" value={fmtNumber(res.context_length)} /> : null}
            {typeof d.json_ok === "boolean" && <Metric label="JSON 格式" value={d.json_ok ? "正確" : "不正確"} color={d.json_ok ? "teal" : "red"} />}
          </SimpleGrid>
        )}

        {!compact && res?.gpu_ratio != null && (
          <Box>
            <Group justify="space-between" mb={4}>
              <Text fz="xs" c="dimmed">
                GPU 載入比例
              </Text>
              <Text fz="xs" fw={600} className="tabular">
                {Math.round(res.gpu_ratio * 100)}%（{gb(res.vram_bytes)} / {gb(res.model_size_bytes)}）
              </Text>
            </Group>
            <Progress value={res.gpu_ratio * 100} color={res.gpu_ratio < 0.99 ? "amber" : "teal"} size="sm" radius="xl" />
          </Box>
        )}

        {list.length > 0 && (
          <Stack gap={6}>
            {list.map((f) => (
              <Box key={f.key}>
                <Text fz="xs" lh={1.55}>
                  {f.text}
                </Text>
                {f.fix && onFix && (
                  <Anchor component="button" type="button" fz="xs" fw={600} onClick={() => onFix(f.fix!.fix)}>
                    {f.fix.label}
                  </Anchor>
                )}
              </Box>
            ))}
          </Stack>
        )}

        {!compact && typeof d.sample === "string" && d.sample && (
          <Badge variant="light" color="gray" tt="none" maw="100%" styles={{ label: { overflow: "hidden", textOverflow: "ellipsis" } }}>
            回覆：{d.sample}
          </Badge>
        )}
      </Stack>
    </Alert>
  );
}

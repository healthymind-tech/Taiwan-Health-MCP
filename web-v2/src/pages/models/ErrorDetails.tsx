import { Alert, Anchor, Badge, Box, Button, Code, Collapse, Group, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { VLLM_MATRYOSHKA_FLAG, type CodeParams, type LlmErrorInfo } from "./llmErrors";

const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** Raw server text behind a translated message — collapsed, for whoever has to debug it. */
export function TechDetails({ detail, code }: { detail?: string; code?: string }) {
  const [open, setOpen] = useState(false);
  if (!detail && !code) return null;
  return (
    <Box mt={6}>
      <Anchor component="button" type="button" fz="xs" c="dimmed" onClick={() => setOpen((o) => !o)}>
        {open ? "隱藏技術細節" : "技術細節"}
      </Anchor>
      <Collapse in={open}>
        <Code block mt={4} fz={11} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto" }}>
          {[code ? `code: ${code}` : "", detail ?? ""].filter(Boolean).join("\n")}
        </Code>
      </Collapse>
    </Box>
  );
}

/** A translated LLM-admin error with its next step, plus the raw detail on demand. */
export function LlmErrorAlert({ info, title, onClose, children, mx, mb }: { info: LlmErrorInfo; title?: string; onClose?: () => void; children?: ReactNode; mx?: string; mb?: string }) {
  return (
    <Alert color="red" icon={<IconAlertTriangle size={18} />} title={title} withCloseButton={Boolean(onClose)} onClose={onClose} mx={mx} mb={mb}>
      <Text fz="sm" style={{ wordBreak: "break-word" }}>
        {info.text}
      </Text>
      {children}
      <TechDetails detail={info.detail} code={info.code} />
    </Alert>
  );
}

/** One-click remedies for an endpoint issue (model missing, size not supported). */
export function EmbeddingIssueFixes({
  code,
  params,
  onPickModel,
  onSetDims,
  onSendDims,
}: {
  code?: string;
  params?: CodeParams;
  onPickModel?: (model: string) => void;
  onSetDims?: (dims: number) => void;
  onSendDims?: (on: boolean) => void;
}) {
  const p = params ?? {};
  if (code === "embedding_model_not_found" && onPickModel && Array.isArray(p.available) && p.available.length) {
    return (
      <Group gap={6} mt={6} wrap="wrap">
        <Text fz="xs" c="dimmed">
          改用：
        </Text>
        {(p.available as string[]).map((m) => (
          <Badge key={m} component="button" type="button" variant="light" tt="none" ff="monospace" style={{ cursor: "pointer" }} onClick={() => onPickModel(m)}>
            {m}
          </Badge>
        ))}
      </Group>
    );
  }
  if (code === "embedding_dims_unsupported") {
    const returned = p.returned === null || p.returned === undefined ? null : Number(p.returned);
    return (
      <Stack gap={6} mt={6}>
        <Group gap={6} wrap="wrap">
          {onSetDims && returned !== null && (
            <Button size="compact-xs" variant="light" onClick={() => onSetDims(returned)}>
              改為 {returned} 維（原生）
            </Button>
          )}
          {onSendDims && p.matryoshka === true && p.send_dimensions !== true && (
            <Button size="compact-xs" variant="light" color="gray" onClick={() => onSendDims(true)}>
              開啟「送出維度參數」，保留 {s(p.configured)} 維
            </Button>
          )}
          {onSendDims && p.send_dimensions === true && (
            <Button size="compact-xs" variant="light" color="gray" onClick={() => onSendDims(false)}>
              關閉「送出維度參數」
            </Button>
          )}
        </Group>
        {p.matryoshka === true && p.self_hosted === true && (
          <Text fz={11} c="dimmed">
            vLLM 預設不接受 dimensions；要截短維度，須在 vLLM 啟動參數加上 <code>{VLLM_MATRYOSHKA_FLAG}</code> 並重啟。
          </Text>
        )}
      </Stack>
    );
  }
  return null;
}


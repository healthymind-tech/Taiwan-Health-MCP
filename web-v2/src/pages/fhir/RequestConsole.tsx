import {
  Alert,
  Autocomplete,
  Badge,
  Box,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  TagsInput,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { IconAlertTriangle, IconBraces, IconSend, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { confirmAction } from "@/components/confirm";
import { CopyText } from "@/components/CopyText";
import { JsonView } from "@/components/JsonView";
import { errorMessage } from "@/lib/api";
import type { FhirServer } from "@/lib/types";
import { fhirApi } from "./fhirApi";
import { rowsToHeaders, type HeaderRow, type TestRequestResult } from "./fhirModel";
import { KeyValueEditor } from "./KeyValueEditor";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const WRITE_METHODS: Method[] = ["POST", "PUT", "PATCH", "DELETE"];
const BODY_METHODS: Method[] = ["POST", "PUT", "PATCH"];

function statusColor(code: number | undefined): string {
  if (!code) return "gray";
  if (code < 300) return "teal";
  if (code < 400) return "blue";
  if (code < 500) return "amber";
  return "red";
}

function bodyTemplate(method: Method, path: string): string {
  const type = path.replace(/^\/+/, "").split(/[/?]/)[0] || "Patient";
  if (method === "PATCH") return JSON.stringify([{ op: "replace", path: "/active", value: true }], null, 2);
  const id = path.replace(/^\/+/, "").split("/")[1]?.split("?")[0];
  return JSON.stringify({ resourceType: type, ...(method === "PUT" && id ? { id } : {}) }, null, 2);
}

/** Ad-hoc request console against a saved server (POST /fhir-servers/test-request). */
export function RequestConsole({ server }: { server: FhirServer }) {
  const [method, setMethod] = useState<Method>("GET");
  const [path, setPath] = useState("metadata");
  const [query, setQuery] = useState<HeaderRow[]>([]);
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [body, setBody] = useState("");
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [expected, setExpected] = useState<string[]>([]);
  const [timeout, setTimeoutSec] = useState<number | string>("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestRequestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const types = useMemo(
    () => (server.capability_summary?.supported_resources ?? []).map((r) => r.type),
    [server.capability_summary],
  );
  const pathOptions = useMemo(() => {
    const base = ["metadata", ...types, ...(types.length ? [] : server.allowed_resource_types ?? [])];
    return Array.from(new Set(base)).slice(0, 200);
  }, [types, server.allowed_resource_types]);

  const isWrite = WRITE_METHODS.includes(method);
  const hasBody = BODY_METHODS.includes(method);
  const pathError = path.includes("://") ? "請填相對於 Base URL 的路徑" : null;
  const badExpected = expected.filter((x) => !/^[1-5]\d\d$/.test(x));

  const parseBody = (): { ok: true; value: unknown } | { ok: false } => {
    if (!hasBody || !body.trim()) return { ok: true, value: null };
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch (e) {
      setBodyError(`JSON 格式錯誤：${e instanceof Error ? e.message : String(e)}`);
      return { ok: false };
    }
  };

  const send = async () => {
    setSending(true);
    setError(null);
    setResult(null);
    const parsed = parseBody();
    if (!parsed.ok) {
      setSending(false);
      return;
    }
    try {
      const r = await fhirApi.testRequest({
        fhir_server_id: server.fhir_server_id,
        test: {
          method,
          path: path.trim() || "metadata",
          query: rowsToHeaders(query),
          headers: rowsToHeaders(headers),
          body: parsed.value,
          expected_statuses: expected.map((x) => Number(x)),
          ...(timeout !== "" ? { timeout_seconds: Number(timeout) } : {}),
        },
      });
      setResult(r);
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    } finally {
      setSending(false);
    }
  };

  const submit = () => {
    if (pathError || badExpected.length) return;
    if (hasBody && body.trim()) {
      try {
        JSON.parse(body);
      } catch (e) {
        setBodyError(`JSON 格式錯誤：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    if (!isWrite) {
      void send().catch(() => undefined);
      return;
    }
    const target = `${server.base_url.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    confirmAction({
      title: `對外部伺服器送出 ${method} 請求？`,
      message: (
        <Text fz="sm" component="div">
          <Text span ff="monospace" fw={700}>
            {method}
          </Text>{" "}
          <Text span ff="monospace" style={{ wordBreak: "break-all" }}>
            {target}
          </Text>
        </Text>
      ),
      danger: true,
      typeToConfirm: method === "DELETE" ? server.server_key : undefined,
      consequences: [
        method === "DELETE" ? "會真的從這台 FHIR 伺服器刪除資源" : "會真的在這台 FHIR 伺服器建立或修改臨床資料",
        "此主控台以管理員身分直接送出請求，不受此伺服器「允許的操作 / 資源類型」限制",
        ...(server.environment === "production" ? ["這是標示為「正式環境」的伺服器"] : []),
      ],
      confirmLabel: `送出 ${method}`,
      // Close the dialog either way; errors render inline below the form.
      onConfirm: () => send().catch(() => undefined),
    });
  };

  return (
    <Stack gap="md">
      <Text fz="sm" c="dimmed">
        以此伺服器已儲存的認證設定送出單一請求，用於除錯與驗證。GET 只讀；POST / PUT / PATCH / DELETE 會真的修改外部資料，送出前需再確認。
      </Text>
      <SegmentedControl
        value={method}
        onChange={(v) => {
          setMethod(v as Method);
          setResult(null);
          setBodyError(null);
        }}
        data={(["GET", "POST", "PUT", "PATCH", "DELETE"] as Method[]).map((m) => ({
          value: m,
          label: (
            <Text span fz="sm" fw={600} ff="monospace" c={WRITE_METHODS.includes(m) ? (m === "DELETE" ? "red" : "amber") : undefined}>
              {m}
            </Text>
          ),
        }))}
        fullWidth
        color={isWrite ? (method === "DELETE" ? "red" : "amber") : undefined}
      />
      <Autocomplete
        label="路徑"
        description={
          <Text span fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
            相對於 {server.base_url}，例如 Patient/123、Observation?patient=123
          </Text>
        }
        data={pathOptions}
        value={path}
        onChange={(v) => {
          setPath(v);
          setResult(null);
        }}
        error={pathError}
        ff="monospace"
        placeholder="metadata"
        limit={30}
        maxDropdownHeight={260}
      />
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <KeyValueEditor label="查詢參數" rows={query} onChange={setQuery} keyPlaceholder="參數，例如 _count" valuePlaceholder="值" addLabel="新增參數" allowRaw={false} />
        <KeyValueEditor
          label="額外標頭"
          description="Authorization 由系統依認證設定自動附加"
          rows={headers}
          onChange={setHeaders}
          keyPlaceholder="標頭名稱"
          addLabel="新增標頭"
          allowRaw={false}
        />
      </SimpleGrid>
      {hasBody && (
        <Stack gap={6}>
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Text fz="sm" fw={500}>
              請求內容（JSON）
            </Text>
            <Group gap={4}>
              <Button size="xs" variant="subtle" leftSection={<IconBraces size={14} />} onClick={() => setBody(bodyTemplate(method, path))}>
                插入範本
              </Button>
              <Button
                size="xs"
                variant="subtle"
                disabled={!body.trim()}
                onClick={() => {
                  try {
                    setBody(JSON.stringify(JSON.parse(body), null, 2));
                    setBodyError(null);
                  } catch (e) {
                    setBodyError(`JSON 格式錯誤：${e instanceof Error ? e.message : String(e)}`);
                  }
                }}
              >
                格式化
              </Button>
            </Group>
          </Group>
          <Textarea
            value={body}
            onChange={(e) => {
              setBody(e.currentTarget.value);
              setBodyError(null);
            }}
            autosize
            minRows={6}
            maxRows={20}
            ff="monospace"
            fz="xs"
            spellCheck={false}
            error={bodyError}
            placeholder={method === "PATCH" ? "JSON Patch 陣列，或 FHIRPath Patch Parameters 資源" : '{"resourceType": "Patient", …}'}
            aria-label="請求內容"
          />
          {method === "PATCH" && (
            <Text fz="xs" c="dimmed">
              Content-Type 預設為 application/fhir+json；送出 JSON Patch 陣列時請在額外標頭加上 Content-Type: application/json-patch+json。
            </Text>
          )}
        </Stack>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <TagsInput
          label="預期狀態碼"
          description="留空 = 任何 2xx 視為成功"
          placeholder="例如 200、201、404"
          value={expected}
          onChange={setExpected}
          error={badExpected.length ? `不是有效的 HTTP 狀態碼：${badExpected.join(", ")}` : undefined}
          splitChars={[",", " "]}
        />
        <NumberInput
          label="逾時（秒）"
          description={`留空 = 使用伺服器設定（${server.timeout_seconds} 秒）`}
          min={1}
          max={120}
          allowDecimal={false}
          value={timeout}
          onChange={setTimeoutSec}
          clampBehavior="strict"
        />
      </SimpleGrid>
      {isWrite && (
        <Alert color={method === "DELETE" ? "red" : "amber"} icon={<IconAlertTriangle size={18} />} p="sm">
          {method} 會修改外部伺服器的資料，送出前會再次確認{method === "DELETE" ? "（需輸入 server_key）" : ""}。
        </Alert>
      )}
      <Group justify="flex-end">
        <Button
          leftSection={<IconSend size={16} />}
          onClick={submit}
          loading={sending}
          disabled={Boolean(pathError) || badExpected.length > 0}
          color={isWrite ? (method === "DELETE" ? "red" : "amber") : undefined}
        >
          送出 {method}
        </Button>
      </Group>

      {error && (
        <Alert color="red" icon={<IconX size={18} />} title="請求失敗">
          <Text fz="sm" style={{ wordBreak: "break-word" }}>
            {error}
          </Text>
        </Alert>
      )}
      {result && <RequestResult result={result} />}
    </Stack>
  );
}

function RequestResult({ result }: { result: TestRequestResult }) {
  if (result.error && result.status_code === undefined) {
    return (
      <Alert color="red" icon={<IconX size={18} />} title="無法送出請求">
        <Text fz="sm" style={{ wordBreak: "break-word" }}>
          {result.error}
        </Text>
      </Alert>
    );
  }
  const preview = result.body_preview ?? "";
  let parsed: unknown = undefined;
  try {
    parsed = preview ? JSON.parse(preview) : undefined;
  } catch {
    parsed = undefined;
  }
  const truncated = preview.length >= 2000;
  return (
    <Stack gap="sm">
      <Group gap="sm" wrap="wrap">
        <Badge size="lg" color={statusColor(result.status_code)} variant="filled" radius="sm">
          {result.status_code} {result.reason}
        </Badge>
        <Badge size="lg" color={result.ok ? "teal" : "red"} variant="light" radius="sm">
          {result.ok ? "符合預期" : "不符預期"}
        </Badge>
        {typeof result.duration_ms === "number" && (
          <Text fz="sm" c="dimmed">
            {result.duration_ms} ms
          </Text>
        )}
      </Group>
      {result.url && (
        <Box>
          <Text fz="xs" c="dimmed">
            {result.method} 實際網址
          </Text>
          <CopyText value={result.url} mono />
        </Box>
      )}
      {result.explanation && (
        <Alert color="amber" icon={<IconAlertTriangle size={16} />} p="xs">
          <Text fz="sm">{result.explanation}</Text>
        </Alert>
      )}
      <Group justify="space-between" wrap="wrap">
        <Text fz="sm" fw={600}>
          回應內容
        </Text>
        {truncated && (
          <Tooltip label="後端只回傳回應內容的前 2000 個字元">
            <Badge color="gray" variant="light">
              已截斷（前 2000 字元）
            </Badge>
          </Tooltip>
        )}
      </Group>
      {preview ? <JsonView value={parsed !== undefined ? parsed : preview} maxHeight={480} /> : <Text fz="sm" c="dimmed">（無內容）</Text>}
    </Stack>
  );
}

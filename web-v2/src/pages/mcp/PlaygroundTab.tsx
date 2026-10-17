import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Chip,
  CopyButton,
  Group,
  JsonInput,
  Kbd,
  List,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconBraces,
  IconCheck,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconCopy,
  IconForms,
  IconHistory,
  IconListDetails,
  IconPencil,
  IconPlayerPlay,
  IconTerminal2,
  IconTool,
  IconTrash,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { confirmAction } from "@/components/confirm";
import { EmptyState } from "@/components/EmptyState";
import { notify } from "@/components/notify";
import { QueryBoundary } from "@/components/QueryBoundary";
import { RelativeTime } from "@/components/RelativeTime";
import { ApiError, errorMessage } from "@/lib/api";
import { fmtNumber } from "@/lib/format";
import { JsonTree } from "./JsonTree";
import { clearHistory, loadHistory, pushHistory, type HistoryEntry } from "./history";
import { invokeMcpTool, useMcpCatalog, useMcpOverview } from "./mcpApi";
import { gateModulePage, groupMeta, inMaintenance, maintenanceExplain, maintenancePage, toolStatusView } from "./mcpMeta";
import type { CatalogPayload, CatalogTool, InvokeResponse } from "./mcpTypes";
import { SchemaForm } from "./SchemaForm";
import classes from "./mcp.module.css";
import { buildArgs, curlFor, formModel, initForm, type FieldModel, type FormState } from "./schema";

const WRITE_OPS = new Set(["create", "update", "patch", "delete"]);

function isConfirmedWrite(tool: string, args: Record<string, unknown>): boolean {
  return tool === "crud_fhir_server" && WRITE_OPS.has(String(args.operation ?? "")) && args.confirm_write === true;
}

function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

interface RunState {
  at: number;
  args: Record<string, unknown>;
  response?: InvokeResponse;
  failure?: { message: string; status: number };
}

function ResultPanel({ run, running, baseUrl, bearer, tool }: { run: RunState | null; running: boolean; baseUrl: string; bearer: boolean; tool: string }) {
  const [view, setView] = useState<"tree" | "raw">("tree");
  const [treeVersion, setTreeVersion] = useState(0);
  const [depth, setDepth] = useState(3);
  if (!run) {
    return (
      <EmptyState
        compact
        icon={<IconPlayerPlay size={22} />}
        title="尚未執行"
        description={
          <>
            填好參數後按「執行」（或 <Kbd size="xs">Ctrl</Kbd> + <Kbd size="xs">Enter</Kbd>）。結果、耗時與 HTTP 狀態會顯示在這裡。
          </>
        }
      />
    );
  }
  const r = run.response;
  const body: unknown = r ? (r.ok ? r.result : { error: r.error, detail: r.detail, issues: r.issues }) : { error: run.failure?.message };
  const curl = curlFor(baseUrl, tool, run.args, bearer);
  const status = r?.http_status ?? run.failure?.status ?? 0;
  const toolOk = Boolean(r?.ok && r.tool_ok);
  return (
    <Stack gap="sm">
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Group gap={6} wrap="wrap">
          {r?.ok ? (
            toolOk ? (
              <Badge color="teal" leftSection={<IconCircleCheck size={13} />}>
                成功
              </Badge>
            ) : (
              <Tooltip label="呼叫成功，但工具回傳 ok:false 或 error 欄位">
                <Badge color="amber" leftSection={<IconAlertTriangle size={13} />}>
                  工具回報錯誤
                </Badge>
              </Tooltip>
            )
          ) : (
            <Badge color="red" leftSection={<IconCircleX size={13} />}>
              呼叫失敗
            </Badge>
          )}
          <Badge variant="outline" color={status >= 200 && status < 300 ? "teal" : "red"} ff="monospace">
            HTTP {status || "—"}
          </Badge>
          {r && (
            <Badge variant="outline" color="gray" leftSection={<IconClock size={12} />} className="tabular" tt="none">
              {fmtNumber(r.elapsed_ms)} ms
            </Badge>
          )}
          {running && (
            <Badge color="blue" variant="dot">
              執行中…
            </Badge>
          )}
        </Group>
        <Group gap={4}>
          <SegmentedControl
            size="xs"
            value={view}
            onChange={(v) => setView(v as "tree" | "raw")}
            data={[
              { value: "tree", label: "樹狀" },
              { value: "raw", label: "原始" },
            ]}
          />
          {view === "tree" && (
            <>
              <Tooltip label="全部展開">
                <ActionIcon
                  aria-label="全部展開"
                  onClick={() => {
                    setDepth(99);
                    setTreeVersion((x) => x + 1);
                  }}
                >
                  <IconListDetails size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="全部收合">
                <ActionIcon
                  aria-label="全部收合"
                  onClick={() => {
                    setDepth(1);
                    setTreeVersion((x) => x + 1);
                  }}
                >
                  <IconArrowBackUp size={16} />
                </ActionIcon>
              </Tooltip>
            </>
          )}
          <CopyButton value={pretty(body)} timeout={1500}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? "已複製" : "複製結果 JSON"}>
                <ActionIcon aria-label="複製結果" onClick={copy} color={copied ? "teal" : "gray"}>
                  {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
          <CopyButton value={curl} timeout={1500}>
            {({ copied, copy }) => (
              <Button size="compact-xs" variant={copied ? "filled" : "default"} color={copied ? "teal" : undefined} leftSection={copied ? <IconCheck size={12} /> : <IconTerminal2 size={12} />} onClick={copy}>
                {copied ? "已複製" : "複製為 curl"}
              </Button>
            )}
          </CopyButton>
        </Group>
      </Group>

      {!r?.ok && (
        <Alert color="red" icon={<IconCircleX size={18} />} title={r?.error ?? run.failure?.message ?? "呼叫失敗"} p="sm">
          {r?.detail && !r.issues && (
            <Text fz="xs" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {r.detail}
            </Text>
          )}
          {r?.issues && (
            <List size="xs" spacing={2}>
              {r.issues.map((i, idx) => (
                <List.Item key={idx}>
                  <code>{i.path.join(".") || "(root)"}</code>：{i.message}
                </List.Item>
              ))}
            </List>
          )}
        </Alert>
      )}

      {view === "tree" ? (
        <ScrollArea.Autosize mah="calc(100dvh - 300px)" type="auto">
          <JsonTree value={body} expandDepth={depth} version={treeVersion} />
        </ScrollArea.Autosize>
      ) : (
        <JsonInput value={pretty(body)} readOnly autosize minRows={6} maxRows={22} styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)", fontSize: 12 } }} aria-label="結果 JSON" />
      )}
      <Text fz="xs" c="dimmed">
        與公開端點 <code>POST {r?.public_path ?? `/tools/${tool}`}</code> 走相同的驗證與處理程序。
      </Text>
    </Stack>
  );
}

function HistoryList({ entries, onLoad, onClear, tools }: { entries: HistoryEntry[]; onLoad: (e: HistoryEntry) => void; onClear: () => void; tools: Map<string, CatalogTool> }) {
  return (
    <Card padding="md">
      <Group justify="space-between" mb="xs">
        <Group gap={6}>
          <IconHistory size={16} />
          <Text fw={650} fz="sm">
            執行紀錄
          </Text>
          <Text fz="xs" c="dimmed">
            （僅存在此瀏覽器）
          </Text>
        </Group>
        {entries.length > 0 && (
          <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconTrash size={12} />} onClick={onClear}>
            清除
          </Button>
        )}
      </Group>
      {entries.length === 0 ? (
        <Text fz="xs" c="dimmed">
          尚無紀錄。
        </Text>
      ) : (
        <ScrollArea.Autosize mah={260} type="auto" scrollbars="y">
          <Stack gap={2}>
            {entries.map((e) => (
              <Group
                key={e.id}
                gap="xs"
                wrap="nowrap"
                className="row-hover"
                px={6}
                py={4}
                style={{ borderRadius: 6, cursor: "pointer" }}
                onClick={() => onLoad(e)}
                role="button"
                tabIndex={0}
                aria-label={`載入 ${e.tool} 的紀錄`}
                onKeyDown={(k) => {
                  if (k.key === "Enter") onLoad(e);
                }}
              >
                <ThemeIcon size={18} radius="xl" variant="light" color={e.httpStatus === 200 ? (e.toolOk ? "teal" : "amber") : "red"}>
                  {e.httpStatus === 200 && e.toolOk ? <IconCheck size={11} /> : <IconAlertTriangle size={11} />}
                </ThemeIcon>
                <Box style={{ minWidth: 0, flex: 1 }}>
                  <Text fz="xs" ff="monospace" truncate="end">
                    {e.tool}
                  </Text>
                  <Text fz={11} c="dimmed" truncate="end">
                    {tools.get(e.tool)?.title ?? ""}
                    {e.presetLabel ? ` · ${e.presetLabel}` : ""}
                  </Text>
                </Box>
                <Box ta="right" style={{ flexShrink: 0 }}>
                  <Text fz={11} c="dimmed" className="tabular">
                    {fmtNumber(e.elapsedMs)} ms
                  </Text>
                  <RelativeTime value={new Date(e.at).toISOString()} fz={11} c="dimmed" />
                </Box>
              </Group>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      )}
    </Card>
  );
}

function Playground({ data, toolName, setToolName }: { data: CatalogPayload; toolName: string | null; setToolName: (n: string) => void }) {
  const overviewQ = useMcpOverview();
  const toolsByName = useMemo(() => new Map(data.tools.map((t) => [t.name, t])), [data.tools]);
  const tool = (toolName && toolsByName.get(toolName)) || data.tools.find((t) => t.enabled) || data.tools[0];
  // Keyed on the name: a catalog refetch yields new objects for the same tool and must not reset the form.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fields: FieldModel[] = useMemo(() => formModel(tool.input_schema), [tool.name]);

  const [presetId, setPresetId] = useState<string | null>(tool.examples[0]?.id ?? null);
  /** Last preset loaded — 還原範例 returns to it even after edits. */
  const [basePresetId, setBasePresetId] = useState<string | null>(tool.examples[0]?.id ?? null);
  const [form, setForm] = useState<FormState>(() => initForm(fields, tool.examples[0]?.args ?? {}));
  const [mode, setMode] = useState<"form" | "raw">("form");
  const [raw, setRaw] = useState<string>("");
  const [rawError, setRawError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunState | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  /** Arguments to load once the next tool switch resets the form (history entries). */
  const pendingArgs = useRef<Record<string, unknown> | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // Reset everything when the tool changes.
  useEffect(() => {
    const first = tool.examples[0];
    const pending = pendingArgs.current;
    pendingArgs.current = null;
    const args = pending ?? first?.args ?? {};
    const st = initForm(fields, args);
    setPresetId(pending ? null : (first?.id ?? null));
    setBasePresetId(first?.id ?? null);
    setForm(st);
    setRaw(pretty(buildArgs(fields, st).args));
    setMode("form");
    setRawError(null);
    setErrors({});
    setRun(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool.name]);

  const loadArgs = useCallback(
    (args: Record<string, unknown>, id: string | null) => {
      setPresetId(id);
      if (id) setBasePresetId(id);
      const st = initForm(fields, args);
      setForm(st);
      setRaw(pretty(buildArgs(fields, st).args));
      setRawError(null);
      setErrors({});
    },
    [fields],
  );

  const currentArgs = (): { args: Record<string, unknown> | null; problem: string | null } => {
    if (mode === "raw") {
      try {
        const v: unknown = JSON.parse(raw || "{}");
        if (!v || typeof v !== "object" || Array.isArray(v)) return { args: null, problem: "參數必須是 JSON 物件" };
        return { args: v as Record<string, unknown>, problem: null };
      } catch (e) {
        return { args: null, problem: `JSON 格式錯誤：${(e as Error).message}` };
      }
    }
    const built = buildArgs(fields, form);
    setErrors(built.errors);
    const n = Object.keys(built.errors).length;
    return n ? { args: null, problem: `${n} 個欄位有誤：${Object.keys(built.errors).join("、")}` } : { args: built.args, problem: null };
  };

  const switchMode = (next: "form" | "raw") => {
    if (next === mode) return;
    if (next === "raw") {
      const built = buildArgs(fields, form);
      setRaw(pretty(built.args));
      setRawError(null);
      setMode("raw");
      return;
    }
    try {
      const v: unknown = JSON.parse(raw || "{}");
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("參數必須是 JSON 物件");
      const args = v as Record<string, unknown>;
      const st = initForm(fields, args);
      // Fields the raw JSON leaves out stay omitted (raw is the source of truth here).
      for (const f of fields) if (!f.required && !(f.name in args) && st[f.name]) st[f.name] = { ...st[f.name], included: false };
      setForm(st);
      setRawError(null);
      setMode("form");
    } catch (e) {
      setRawError((e as Error).message);
    }
  };

  const execute = async (args: Record<string, unknown>, confirmWrite: boolean) => {
    setRunning(true);
    const at = Date.now();
    try {
      const response = await invokeMcpTool(tool.name, args, confirmWrite);
      setRun({ at, args, response });
      setHistory(
        pushHistory({
          tool: tool.name,
          presetLabel: tool.examples.find((e) => e.id === presetId)?.label ?? null,
          args,
          at,
          httpStatus: response.http_status,
          toolOk: response.ok && response.tool_ok,
          elapsedMs: response.elapsed_ms,
        }),
      );
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const msg =
        status === 429
          ? "執行太頻繁，請稍候再試（每分鐘上限 60 次）"
          : status === 409
            ? "此工具目前未啟用"
            : status === 428
              ? "寫入操作需要確認"
              : errorMessage(e);
      setRun({ at, args, failure: { message: msg, status } });
    } finally {
      setRunning(false);
      // When the result column is below the form (narrow screens) or scrolled away, bring it into view.
      const el = resultRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.top > window.innerHeight * 0.6 || r.bottom < 80) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  };

  const onRun = () => {
    if (!tool.enabled || inMaintenance(tool) || running) return;
    const { args, problem } = currentArgs();
    if (!args) {
      notify.warn(problem ?? "參數有誤", "無法執行");
      return;
    }
    if (isConfirmedWrite(tool.name, args)) {
      confirmAction({
        title: "確認寫入外部 FHIR 伺服器",
        danger: true,
        message: (
          <>
            即將對 <b>{String(args.server_key)}</b> 執行 <b>{String(args.operation)}</b>
            {args.resource_type ? ` ${String(args.resource_type)}` : ""}
            {args.resource_id ? `/${String(args.resource_id)}` : ""}。
          </>
        ),
        consequences: ["這會實際修改外部伺服器上的資料，無法從這裡復原。", "伺服器的允許清單仍會再檢查一次。"],
        typeToConfirm: String(args.server_key),
        confirmLabel: "確認寫入",
        onConfirm: () => execute(args, true),
      });
      return;
    }
    void execute(args, false);
  };

  // Ctrl/Cmd + Enter runs.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        onRun();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const meta = groupMeta(tool.group);
  const Icon = meta.icon;
  const status = toolStatusView(tool);
  const modulePage = gateModulePage(tool.gate);
  const maint = inMaintenance(tool);
  const preset = tool.examples.find((e) => e.id === presetId);
  const basePreset = tool.examples.find((e) => e.id === basePresetId);
  const baseUrl = overviewQ.data?.base_url ?? window.location.origin;
  const bearer = overviewQ.data?.auth.mode === "bearer";
  const formArgsForWriteCheck = mode === "raw" ? null : buildArgs(fields, form).args;
  const writeArmed = formArgsForWriteCheck ? isConfirmedWrite(tool.name, formArgsForWriteCheck) : false;

  const selectData = data.groups.map((g) => ({
    group: groupMeta(g.key).label,
    items: data.tools
      .filter((t) => t.group === g.key)
      .map((t) => ({ value: t.name, label: `${t.name}${!t.enabled ? "（未啟用）" : inMaintenance(t) ? "（維護中）" : ""}` })),
  }));

  return (
    <Box
      style={{
        display: "grid",
        gap: "var(--mantine-spacing-lg)",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 480px), 1fr))",
        alignItems: "start",
      }}
    >
      <Stack gap="md" style={{ minWidth: 0 }}>
        <Card padding="md">
          <Stack gap="sm">
            <Select
              label="工具"
              data={selectData}
              value={tool.name}
              onChange={(v) => v && setToolName(v)}
              searchable
              nothingFoundMessage="找不到工具"
              maxDropdownHeight={360}
              leftSection={<Icon size={16} color={`var(--mantine-color-${meta.color}-6)`} />}
              styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
              aria-label="選擇工具"
            />
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <ThemeIcon variant="light" color={meta.color} size={36} radius="md">
                <Icon size={20} />
              </ThemeIcon>
              <Box style={{ minWidth: 0 }}>
                <Group gap={6} wrap="wrap">
                  <Title order={3}>{tool.title}</Title>
                  <Badge size="sm" color={status.color} variant={tool.enabled ? "light" : "outline"}>
                    {status.label}
                  </Badge>
                  {maint && (
                    <Badge size="sm" color="amber" variant="filled" leftSection={<IconTool size={11} />}>
                      維護中
                    </Badge>
                  )}
                  <Badge size="sm" variant="outline" color="gray" ff="monospace" tt="none">
                    v{tool.version}
                  </Badge>
                  {tool.write_capable && (
                    <Badge size="sm" color="red" leftSection={<IconPencil size={11} />}>
                      可寫入
                    </Badge>
                  )}
                </Group>
                <Text fz="xs" c="dimmed" mt={4} style={{ whiteSpace: "pre-wrap" }} lineClamp={4}>
                  {tool.description}
                </Text>
              </Box>
            </Group>
            {tool.enabled && maint && (
              <Alert color="amber" icon={<IconTool size={18} />} p="sm" title="模組維護中，無法執行" data-testid="mcp-maintenance-alert">
                <Text fz="xs">
                  {maintenanceExplain(tool)}{" "}
                  {maintenancePage(tool) && (
                    <Anchor component={Link} to={maintenancePage(tool)!} fz="xs">
                      前往模組關閉維護模式
                    </Anchor>
                  )}
                </Text>
              </Alert>
            )}
            {!tool.enabled && (
              <Alert color="amber" icon={<IconAlertTriangle size={18} />} p="sm" title="此工具目前未啟用，無法執行">
                <Text fz="xs">
                  {status.explain}{" "}
                  {modulePage && (
                    <Anchor component={Link} to={modulePage} fz="xs">
                      前往匯入資料
                    </Anchor>
                  )}
                </Text>
              </Alert>
            )}
          </Stack>
        </Card>

        <Card padding="md">
          <Stack gap="sm">
            {tool.examples.length > 0 && (
              <Box>
                <Text fz="xs" fw={600} c="dimmed" mb={6}>
                  範例
                </Text>
                <Chip.Group
                  value={presetId ?? ""}
                  onChange={(v) => {
                    const ex = tool.examples.find((e) => e.id === v);
                    if (ex) loadArgs(ex.args, ex.id);
                  }}
                >
                  <Group gap={6}>
                    {tool.examples.map((ex) => (
                      <Chip key={ex.id} value={ex.id} size="xs" variant="light">
                        {ex.label}
                      </Chip>
                    ))}
                  </Group>
                </Chip.Group>
                {preset?.description && (
                  <Text fz="xs" c="dimmed" mt={6}>
                    {preset.description}
                  </Text>
                )}
                {!preset && (
                  <Text fz="xs" c="dimmed" mt={6}>
                    已自訂參數
                  </Text>
                )}
              </Box>
            )}
            <Group justify="space-between" gap="xs">
              <SegmentedControl
                size="xs"
                value={mode}
                onChange={(v) => switchMode(v as "form" | "raw")}
                data={[
                  { value: "form", label: (<Group gap={4} wrap="nowrap"><IconForms size={14} />表單</Group>) },
                  { value: "raw", label: (<Group gap={4} wrap="nowrap"><IconBraces size={14} />原始 JSON</Group>) },
                ]}
                aria-label="編輯模式"
              />
              {basePreset && (
                <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconArrowBackUp size={12} />} onClick={() => { setMode("form"); loadArgs(basePreset.args, basePreset.id); }}>
                  還原範例
                </Button>
              )}
            </Group>
            {rawError && (
              <Alert color="red" p="xs" icon={<IconCircleX size={16} />}>
                <Text fz="xs">無法切回表單：{rawError}</Text>
              </Alert>
            )}
            {mode === "form" ? (
              <SchemaForm
                fields={fields}
                state={form}
                errors={errors}
                onChange={(name, s) => {
                  setForm((prev) => ({ ...prev, [name]: s }));
                  setPresetId(null);
                }}
              />
            ) : (
              <JsonInput
                value={raw}
                onChange={(v) => {
                  setRaw(v);
                  setPresetId(null);
                }}
                autosize
                minRows={8}
                maxRows={32}
                formatOnBlur
                validationError="JSON 格式錯誤"
                aria-label="原始 JSON 參數"
                styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)", fontSize: 12 } }}
              />
            )}
            {writeArmed && (
              <Alert color="red" icon={<IconAlertTriangle size={18} />} p="sm" title="此呼叫會寫入外部 FHIR 伺服器">
                <Text fz="xs">operation 為寫入且 confirm_write=true；執行前會再要求確認。</Text>
              </Alert>
            )}
            <Group justify="space-between" gap="xs" wrap="wrap">
              <Text fz="xs" c="dimmed">
                <Kbd size="xs">Ctrl</Kbd> + <Kbd size="xs">Enter</Kbd> 執行
              </Text>
              <Tooltip label={!tool.enabled ? "工具未啟用" : maint ? "模組維護中，暫停執行" : "以管理員身分呼叫（每分鐘上限 60 次）"}>
                <Button
                  leftSection={<IconPlayerPlay size={16} />}
                  onClick={onRun}
                  loading={running}
                  disabled={!tool.enabled || maint}
                  color={writeArmed ? "red" : undefined}
                  data-testid="mcp-run"
                >
                  {writeArmed ? "確認後寫入" : "執行"}
                </Button>
              </Tooltip>
            </Group>
          </Stack>
        </Card>
        <HistoryList
          entries={history}
          tools={toolsByName}
          onClear={() => setHistory(clearHistory())}
          onLoad={(e) => {
            if (e.argsOmitted) {
              notify.info("此筆紀錄的參數太大未保存，已載入預設範例");
              if (e.tool !== tool.name) setToolName(e.tool);
              return;
            }
            if (e.tool !== tool.name) {
              pendingArgs.current = e.args;
              setToolName(e.tool);
              return;
            }
            setMode("form");
            loadArgs(e.args, null);
          }}
        />
      </Stack>

      <Box style={{ minWidth: 0, alignSelf: "stretch" }} ref={resultRef}>
        <Card padding="md" className={classes.sticky}>
          <Text fw={650} fz="sm" mb="sm">
            結果
          </Text>
          <ResultPanel run={run} running={running} baseUrl={baseUrl} bearer={bearer} tool={tool.name} />
        </Card>
      </Box>
    </Box>
  );
}

export function PlaygroundTab({ toolName, setToolName }: { toolName: string | null; setToolName: (n: string) => void }) {
  const q = useMcpCatalog();
  return <QueryBoundary query={q}>{(data) => <Playground data={data} toolName={toolName} setToolName={setToolName} />}</QueryBoundary>;
}

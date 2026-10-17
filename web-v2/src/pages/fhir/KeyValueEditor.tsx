import { ActionIcon, Box, Button, Group, SegmentedControl, Stack, Text, Textarea, TextInput, Tooltip } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { newRowId, type HeaderRow } from "./fhirModel";

export interface KeyValueEditorProps {
  label: ReactNode;
  description?: ReactNode;
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  error?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  /** Allow switching to a raw JSON object editor. */
  allowRaw?: boolean;
  disabled?: boolean;
}

function rowsToJson(rows: HeaderRow[]): string {
  const obj: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) obj[r.key.trim()] = r.value;
  return Object.keys(obj).length ? JSON.stringify(obj, null, 2) : "{}";
}

function parseJsonRows(text: string): HeaderRow[] {
  const t = text.trim();
  if (!t) return [];
  const parsed: unknown = JSON.parse(t);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("必須是 JSON 物件，例如 {\"X-Tenant\": \"abc\"}");
  return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
    id: newRowId(),
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

/** Key/value list editor with an optional raw-JSON mode. */
export function KeyValueEditor({
  label,
  description,
  rows,
  onChange,
  error,
  keyPlaceholder = "名稱",
  valuePlaceholder = "值",
  addLabel = "新增一列",
  allowRaw = true,
  disabled,
}: KeyValueEditorProps) {
  const [mode, setMode] = useState<"table" | "raw">("table");
  const [raw, setRaw] = useState("");
  const [rawError, setRawError] = useState<string | null>(null);

  const switchMode = (next: string) => {
    if (next === "raw") {
      setRaw(rowsToJson(rows));
      setRawError(null);
      setMode("raw");
      return;
    }
    try {
      onChange(parseJsonRows(raw));
      setRawError(null);
      setMode("table");
    } catch (e) {
      setRawError(e instanceof Error ? `JSON 格式錯誤：${e.message}` : "JSON 格式錯誤");
    }
  };

  const update = (id: string, patch: Partial<HeaderRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <Stack gap={6}>
      <Group justify="space-between" align="flex-end" gap="xs" wrap="wrap">
        <Box style={{ minWidth: 0, flex: "1 1 200px" }}>
          <Text fz="sm" fw={500}>
            {label}
          </Text>
          {description && (
            <Text fz="xs" c="dimmed">
              {description}
            </Text>
          )}
        </Box>
        {allowRaw && (
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={switchMode}
            disabled={disabled}
            data={[
              { value: "table", label: "表格" },
              { value: "raw", label: "JSON" },
            ]}
          />
        )}
      </Group>

      {mode === "raw" ? (
        <Textarea
          value={raw}
          onChange={(e) => {
            setRaw(e.currentTarget.value);
            setRawError(null);
          }}
          onBlur={() => {
            try {
              onChange(parseJsonRows(raw));
            } catch (e) {
              setRawError(e instanceof Error ? `JSON 格式錯誤：${e.message}` : "JSON 格式錯誤");
            }
          }}
          autosize
          minRows={3}
          maxRows={12}
          ff="monospace"
          fz="xs"
          error={rawError ?? error}
          disabled={disabled}
          spellCheck={false}
        />
      ) : (
        <Stack gap={6}>
          {rows.length === 0 && (
            <Text fz="xs" c="dimmed">
              尚未設定
            </Text>
          )}
          {rows.map((r) => (
            <Group key={r.id} gap={6} wrap="nowrap" align="flex-start">
              <TextInput
                placeholder={keyPlaceholder}
                value={r.key}
                onChange={(e) => update(r.id, { key: e.currentTarget.value })}
                style={{ flex: "1 1 40%", minWidth: 0 }}
                ff="monospace"
                size="sm"
                disabled={disabled}
                aria-label={keyPlaceholder}
              />
              <TextInput
                placeholder={valuePlaceholder}
                value={r.value}
                onChange={(e) => update(r.id, { value: e.currentTarget.value })}
                style={{ flex: "1 1 60%", minWidth: 0 }}
                ff="monospace"
                size="sm"
                disabled={disabled}
                aria-label={valuePlaceholder}
              />
              <Tooltip label="移除">
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size={36}
                  onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
                  disabled={disabled}
                  aria-label="移除"
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}
          {error && (
            <Text fz="xs" c="red">
              {error}
            </Text>
          )}
          <Box>
            <Button
              variant="subtle"
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={() => onChange([...rows, { id: newRowId(), key: "", value: "" }])}
              disabled={disabled}
            >
              {addLabel}
            </Button>
          </Box>
        </Stack>
      )}
    </Stack>
  );
}

import { Badge, Box, Group, JsonInput, NumberInput, Select, Stack, Switch, TagsInput, Text, Textarea, TextInput, Tooltip } from "@mantine/core";
import { memo } from "react";
import classes from "./mcp.module.css";
import { typeLabel, type FieldModel, type FieldState, type FormState } from "./schema";

function jsonError(text: string | undefined): string | null {
  if (!text || !text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function FieldEditor({ f, st, onChange, error }: { f: FieldModel; st: FieldState; onChange: (s: FieldState) => void; error?: string }) {
  const disabled = !st.included && !f.required;
  const set = (patch: Partial<FieldState>) => onChange({ ...st, ...patch });
  const id = `mcp-field-${f.name}`;
  switch (f.kind) {
    case "boolean":
      return (
        <Switch
          id={id}
          checked={Boolean(st.value)}
          onChange={(e) => set({ value: e.currentTarget.checked })}
          disabled={disabled}
          label={Boolean(st.value) ? "true" : "false"}
          aria-label={f.name}
        />
      );
    case "enum":
      return (
        <Select
          id={id}
          data={f.enumValues ?? []}
          value={typeof st.value === "string" ? st.value : null}
          onChange={(v) => v !== null && set({ value: v })}
          disabled={disabled}
          aria-label={f.name}
          error={error}
        />
      );
    case "integer":
    case "number":
      return (
        <NumberInput
          id={id}
          value={typeof st.value === "number" || typeof st.value === "string" ? (st.value as number | string) : ""}
          onChange={(v) => set({ value: v === "" ? "" : typeof v === "number" ? v : Number(v) })}
          min={f.min}
          max={f.max}
          allowDecimal={f.kind === "number"}
          disabled={disabled}
          aria-label={f.name}
          error={error}
          description={f.min !== undefined || f.max !== undefined ? `範圍 ${f.min ?? "−∞"} – ${f.max ?? "∞"}` : undefined}
          inputWrapperOrder={["label", "input", "description", "error"]}
        />
      );
    case "string-array":
      return (
        <TagsInput
          id={id}
          value={Array.isArray(st.value) ? (st.value as unknown[]).map(String) : []}
          onChange={(v) => set({ value: v })}
          disabled={disabled}
          placeholder="輸入後按 Enter 新增"
          aria-label={f.name}
          error={error}
          clearable
        />
      );
    case "text":
      return (
        <Textarea
          id={id}
          value={typeof st.value === "string" ? st.value : ""}
          onChange={(e) => set({ value: e.currentTarget.value })}
          autosize
          minRows={3}
          maxRows={14}
          disabled={disabled}
          aria-label={f.name}
          error={error}
          styles={{ input: { fontSize: 13 } }}
        />
      );
    case "json":
    case "json-string": {
      const err = error ?? jsonError(st.text) ?? undefined;
      return (
        <JsonInput
          id={id}
          value={st.text ?? ""}
          onChange={(v) => set({ text: v })}
          autosize
          minRows={4}
          maxRows={18}
          formatOnBlur
          validationError="JSON 格式錯誤"
          disabled={disabled}
          aria-label={f.name}
          error={err}
          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)", fontSize: 12 } }}
        />
      );
    }
    case "object":
      return (
        <Stack gap="xs" pl="sm" style={{ borderLeft: "2px solid var(--mantine-color-default-border)" }}>
          {(f.children ?? []).map((c) => (
            <FieldRow
              key={c.name}
              f={c}
              st={st.children?.[c.name] ?? { included: false, value: "" }}
              onChange={(cs) => onChange({ ...st, children: { ...(st.children ?? {}), [c.name]: cs } })}
            />
          ))}
        </Stack>
      );
    default:
      return (
        <TextInput
          id={id}
          value={typeof st.value === "string" ? st.value : st.value === null || st.value === undefined ? "" : String(st.value)}
          onChange={(e) => set({ value: e.currentTarget.value })}
          disabled={disabled}
          aria-label={f.name}
          error={error}
        />
      );
  }
}

const FieldRow = memo(function FieldRow({ f, st, onChange, error }: { f: FieldModel; st: FieldState; onChange: (s: FieldState) => void; error?: string }) {
  const omitted = !st.included && !f.required;
  return (
    <Box className={classes.fieldRow} data-omitted={omitted || undefined}>
      <Group justify="space-between" gap="xs" mb={6} wrap="nowrap" align="flex-start">
        <Box style={{ minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <Text component="label" htmlFor={`mcp-field-${f.name}`} fz="sm" fw={600} ff="monospace" style={{ wordBreak: "break-all" }}>
              {f.name}
            </Text>
            {f.required ? (
              <Badge size="xs" color="red" variant="light">
                必填
              </Badge>
            ) : (
              <Badge size="xs" color="gray" variant="outline">
                選填
              </Badge>
            )}
            <Text fz="xs" c="dimmed" ff="monospace">
              {typeLabel(f)}
              {f.nullable ? " | null" : ""}
            </Text>
          </Group>
          {f.description && (
            <Text fz="xs" c="dimmed" mt={2} lineClamp={3}>
              {f.description}
            </Text>
          )}
        </Box>
        {!f.required && (
          <Tooltip label={omitted ? `未送出（使用預設值 ${JSON.stringify(f.default ?? null)}）` : "送出此欄位；關閉則省略"}>
            <Switch
              size="xs"
              checked={st.included}
              onChange={(e) => onChange({ ...st, included: e.currentTarget.checked })}
              label="送出"
              aria-label={`送出 ${f.name}`}
              styles={{ label: { fontSize: 12, paddingLeft: 6, whiteSpace: "nowrap" }, root: { flexShrink: 0 } }}
            />
          </Tooltip>
        )}
      </Group>
      {omitted ? (
        <Text fz="xs" c="dimmed">
          省略 — 由伺服器使用預設值 <code>{JSON.stringify(f.default ?? null)}</code>
        </Text>
      ) : (
        <FieldEditor f={f} st={st} onChange={onChange} error={error} />
      )}
    </Box>
  );
});

export function SchemaForm({
  fields,
  state,
  onChange,
  errors,
}: {
  fields: FieldModel[];
  state: FormState;
  onChange: (name: string, s: FieldState) => void;
  errors: Record<string, string>;
}) {
  if (fields.length === 0) {
    return (
      <Text fz="sm" c="dimmed">
        此工具沒有參數，直接執行即可。
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {fields.map((f) => (
        <FieldRow key={f.name} f={f} st={state[f.name] ?? { included: false, value: "" }} onChange={(s) => onChange(f.name, s)} error={errors[f.name]} />
      ))}
    </Stack>
  );
}

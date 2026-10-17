import { ActionIcon, Badge, Box, Group, NumberInput, SegmentedControl, Select, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { IconArrowBackUp, IconLock } from "@tabler/icons-react";
import { useState } from "react";
import type { KnobValue, ParamSpec, ProviderSpec } from "./profileModel";

/** Monospace for the typed value only — the label and description keep the UI font. */
export const MONO_INPUT = { input: { fontFamily: "var(--mantine-font-family-monospace)" } } as const;

/** Same rule the server applies (llmRouting.ts isValidHttpUrl): an absolute http(s) URL with a host. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}

/** Base URL: read-only when the provider fixes it; region presets as chips when it has options. */
export function BaseUrlField({ spec, value, onChange, error }: { spec: ProviderSpec; value: string; onChange: (v: string) => void; error?: string }) {
  // Validate once the operator has left the field (not on every keystroke).
  const [touched, setTouched] = useState(false);
  if (spec.baseUrl.fixed) {
    return (
      <Box>
        <Text fz="sm" fw={500}>
          Base URL
        </Text>
        <Group gap={6} mt={4}>
          <IconLock size={14} color="var(--mantine-color-dimmed)" />
          <Text fz="sm" ff="monospace" c="dimmed">
            {spec.baseUrl.default}
          </Text>
        </Group>
        <Text fz="xs" c="dimmed" mt={2}>
          {spec.label} 只能使用官方端點。
        </Text>
      </Box>
    );
  }
  const options = spec.baseUrl.options ?? [];
  const def = spec.baseUrl.default;
  return (
    <Stack gap={4}>
      <TextInput
        label="Base URL"
        withAsterisk
        styles={MONO_INPUT}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        onBlur={() => setTouched(true)}
        error={
          error ??
          (touched && value.trim() === ""
            ? "請輸入 Base URL"
            : touched && !isHttpUrl(value)
              ? "請輸入完整網址，以 http:// 或 https:// 開頭（例如 https://api.example.com/v1）"
              : undefined)
        }
        placeholder={spec.baseUrl.placeholder ?? def ?? "https://…"}
        description={spec.baseUrl.help}
        rightSection={
          def && value.trim() !== def && !options.length ? (
            <Tooltip label="套用預設網址">
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => onChange(def)} aria-label="套用預設網址">
                <IconArrowBackUp size={14} />
              </ActionIcon>
            </Tooltip>
          ) : undefined
        }
      />
      {options.length > 0 && (
        <Group gap={6}>
          {options.map((o) => {
            const active = value.trim().replace(/\/+$/, "") === o.value.replace(/\/+$/, "");
            return (
              <Badge
                key={o.value}
                component="button"
                type="button"
                variant={active ? "filled" : "light"}
                color={active ? "brand" : "gray"}
                tt="none"
                style={{ cursor: "pointer" }}
                onClick={() => onChange(o.value)}
              >
                {o.label}
              </Badge>
            );
          })}
        </Group>
      )}
    </Stack>
  );
}

/** One provider knob, rendered from its ParamSpec. Empty = unset (provider default). */
export function KnobField({ spec, value, onChange, error }: { spec: ParamSpec; value: KnobValue | undefined; onChange: (v: KnobValue | "") => void; error?: string }) {
  const description = spec.help;
  if (spec.type === "select") {
    return (
      <Select
        label={spec.label}
        description={description}
        data={spec.options ?? []}
        value={value === undefined ? null : String(value)}
        onChange={(v) => onChange(v ?? "")}
        placeholder={spec.placeholder ?? "預設"}
        clearable
        error={error}
      />
    );
  }
  if (spec.type === "boolean") {
    const cur = value === true || value === "true" ? "on" : value === false || value === "false" ? "off" : "";
    return (
      <Stack gap={4}>
        <Text fz="sm" fw={500}>
          {spec.label}
        </Text>
        {description && (
          <Text fz="xs" c="dimmed" lh={1.4}>
            {description}
          </Text>
        )}
        <SegmentedControl
          size="xs"
          value={cur}
          onChange={(v) => onChange(v === "on" ? true : v === "off" ? false : "")}
          data={[
            { value: "", label: "預設" },
            { value: "on", label: "開啟" },
            { value: "off", label: "關閉" },
          ]}
        />
        {error && (
          <Text fz="xs" c="red">
            {error}
          </Text>
        )}
      </Stack>
    );
  }
  if (spec.type === "text") {
    return (
      <TextInput
        label={spec.label}
        description={description}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.currentTarget.value.trim() ? e.currentTarget.value : "")}
        placeholder={spec.placeholder}
        error={error}
      />
    );
  }
  return (
    <NumberInput
      label={spec.label}
      description={description}
      value={typeof value === "number" ? value : value === undefined ? "" : Number(value)}
      onChange={(v) => onChange(v === "" ? "" : Number(v))}
      min={spec.min}
      max={spec.max}
      step={spec.step ?? (spec.type === "integer" ? 1 : 0.1)}
      allowDecimal={spec.type !== "integer"}
      decimalScale={spec.type === "integer" ? 0 : 3}
      thousandSeparator={spec.type === "integer" && (spec.max ?? 0) >= 10_000 ? "," : undefined}
      placeholder={spec.placeholder ?? "預設"}
      error={error}
    />
  );
}


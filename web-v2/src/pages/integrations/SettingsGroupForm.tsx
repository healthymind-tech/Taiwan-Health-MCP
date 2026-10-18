import {
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Box,
  Button,
  Group,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconCheck,
  IconDeviceFloppy,
  IconLock,
  IconPlugConnected,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { notify } from "@/components/notify";
import { api, ApiError, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import type { SettingsField, SettingsGroup } from "@/lib/types";
import {
  changedKeys,
  fieldFromError,
  fieldHelp,
  fieldLabel,
  groupLabel,
  initialDraft,
  isVisible,
  payloadFor,
  secretIsSet,
  validateDraft,
  type ActionResult,
  type DraftValues,
  type FieldValue,
} from "./settingsModel";

export interface SettingsGroupFormProps {
  group: SettingsGroup;
  /** Field keys rendered as a SegmentedControl instead of a Select (short option lists). */
  segmented?: Record<string, Record<string, string>>;
  /** Columns on wide screens. */
  cols?: number;
  /** Extra content rendered under the action bar (e.g. contextual notes). */
  footer?: ReactNode;
}

/**
 * Schema-driven form for one settings group: one control per field type,
 * `show_if` visibility, provider defaults, model lookup, test + save with dirty tracking.
 */
export function SettingsGroupForm({ group, segmented, cols = 2, footer }: SettingsGroupFormProps) {
  const qc = useQueryClient();
  // Key on the *values*, not object identity: a background refetch (window focus)
  // returns a new object with identical values and must not wipe in-progress edits.
  const initialKey = JSON.stringify(initialDraft(group));
  const initial = useMemo<DraftValues>(() => JSON.parse(initialKey) as DraftValues, [initialKey]);
  const [draft, setDraft] = useState<DraftValues>(initial);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<(ActionResult & { withUnsaved: boolean }) | null>(null);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [modelMsg, setModelMsg] = useState<Record<string, { ok: boolean; text: string }>>({});

  // Re-seed the draft when fresh server values arrive (after save / refetch).
  useEffect(() => {
    setDraft(initial);
    setServerErrors({});
  }, [initial]);

  const dirtyKeys = changedKeys(group, initial, draft);
  const dirty = dirtyKeys.length > 0;
  const clientErrors = validateDraft(group, draft);
  const errors = { ...clientErrors, ...serverErrors };
  const hasErrors = Object.keys(clientErrors).length > 0;
  const readonly = group.readonly;

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const setValue = (key: string, value: FieldValue) => {
    setServerErrors((e) => {
      if (!(key in e)) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
    setDraft((d) => {
      const next = { ...d, [key]: value };
      // Provider switch: swap any field still holding the old provider's default.
      if (group.provider_field && key === group.provider_field) {
        const oldProvider = String(d[key] ?? "");
        const newProvider = String(value);
        for (const f of group.fields) {
          if (!f.provider_defaults) continue;
          const cur = String(d[f.key] ?? "");
          const oldDefault = f.provider_defaults[oldProvider];
          if (cur === "" || cur === oldDefault) {
            const nd = f.provider_defaults[newProvider];
            if (nd !== undefined) next[f.key] = nd;
          }
        }
      }
      return next;
    });
  };

  const save = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; connection?: ActionResult }>(`/admin/api/settings/${group.group}`, { values: payloadFor(group, draft, dirtyKeys) }),
    onSuccess: async (r) => {
      setFormError(null);
      notify.success(`已儲存「${groupLabel(group)}」，服務會立即套用新設定`);
      // The backend tries the saved endpoint once; a failure does not undo the save.
      if (r.connection && !r.connection.ok) {
        setTestResult({ ...r.connection, withUnsaved: false });
        notify.warn(
          `${r.connection.message_zh ?? r.connection.message ?? "連線測試失敗"}${r.connection.hint_zh ? ` ${r.connection.hint_zh}` : ""}`,
          "已儲存，但目前連不上這個服務",
        );
      }
      await qc.invalidateQueries({ queryKey: qk.settings });
      void qc.invalidateQueries({ queryKey: qk.services });
      void qc.invalidateQueries({ queryKey: qk.overview });
    },
    onError: (err) => {
      const raw = err instanceof ApiError ? (err.detail ?? err.rawMessage) : errorMessage(err);
      const key = fieldFromError(group.group, raw);
      if (key) setServerErrors({ [key]: err instanceof ApiError && err.explained ? errorMessage(err) : raw.replace(`${group.group}.${key}: `, "") });
      setFormError(errorMessage(err));
      notify.error(err, "儲存失敗");
    },
  });

  const test = useMutation({
    mutationFn: () => api.post<ActionResult>(`/admin/api/settings/${group.group}/test`, { values: payloadFor(group, draft) }),
    onSuccess: (r) => setTestResult({ ...r, withUnsaved: dirty }),
    onError: (err) => setTestResult({ ok: false, message: errorMessage(err), withUnsaved: dirty }),
  });

  const fetchModels = useMutation({
    mutationFn: (key: string) =>
      api
        .post<ActionResult>(`/admin/api/settings/${group.group}/models`, { values: payloadFor(group, draft) })
        .then((r) => ({ key, r })),
    onSuccess: ({ key, r }) => {
      setModels((m) => ({ ...m, [key]: r.models ?? [] }));
      setModelMsg((m) => ({ ...m, [key]: { ok: r.ok, text: r.message ?? (r.ok ? `找到 ${r.models?.length ?? 0} 個模型` : "無法取得模型清單") } }));
    },
    onError: (err, key) => setModelMsg((m) => ({ ...m, [key]: { ok: false, text: errorMessage(err) } })),
  });

  const visibleFields = group.fields.filter((f) => isVisible(f, draft));
  const provider = group.provider_field ? String(draft[group.provider_field] ?? "") : "";

  const renderField = (f: SettingsField) => {
    const label = fieldLabel(group.group, f);
    const help = fieldHelp(group.group, f);
    const err = errors[f.key];
    const providerDefault = f.provider_defaults && provider ? f.provider_defaults[provider] : undefined;
    const description = (
      <>
        {help}
        {providerDefault !== undefined && String(draft[f.key]) !== providerDefault && (
          <>
            {help ? " " : ""}
            {provider} 預設值：
            <Text span ff="monospace" fz="xs">
              {providerDefault}
            </Text>
          </>
        )}
      </>
    );
    const common = {
      label,
      description: help || providerDefault !== undefined ? description : undefined,
      error: err,
      disabled: readonly,
    };
    const v = draft[f.key];

    if (f.type === "bool") {
      return (
        <Box key={f.key} pt={4}>
          <Switch
            label={label}
            description={help || undefined}
            checked={v === true}
            onChange={(e) => setValue(f.key, e.currentTarget.checked)}
            disabled={readonly}
            error={err}
          />
        </Box>
      );
    }
    if (f.options && f.options.length > 0) {
      const seg = segmented?.[f.key];
      if (seg) {
        return (
          <Stack key={f.key} gap={4}>
            <Text fz="sm" fw={500}>
              {label}
            </Text>
            <SegmentedControl
              fullWidth
              value={String(v)}
              onChange={(val) => setValue(f.key, val)}
              data={f.options.map((o) => ({ value: o, label: seg[o] ?? o }))}
              disabled={readonly}
            />
            {help && (
              <Text fz="xs" c="dimmed">
                {help}
              </Text>
            )}
            {err && (
              <Text fz="xs" c="red">
                {err}
              </Text>
            )}
          </Stack>
        );
      }
      const data = f.options.includes(String(v)) || String(v) === "" ? f.options : [...f.options, String(v)];
      return (
        <Select
          key={f.key}
          {...common}
          data={data}
          value={String(v)}
          onChange={(val) => val !== null && setValue(f.key, val)}
          allowDeselect={false}
          checkIconPosition="right"
        />
      );
    }
    if (f.type === "int" || f.type === "float") {
      return (
        <NumberInput
          key={f.key}
          {...common}
          value={typeof v === "number" ? v : v === "" ? "" : Number(v)}
          onChange={(val) => setValue(f.key, val === "" ? "" : Number(val))}
          allowDecimal={f.type === "float"}
          decimalScale={f.type === "float" ? 3 : 0}
          thousandSeparator=","
          hideControls={readonly}
        />
      );
    }
    if (f.secret) {
      const isSet = secretIsSet(f);
      return (
        <PasswordInput
          key={f.key}
          {...common}
          description={
            <>
              {help ? `${help} ` : ""}
              {readonly ? (isSet ? "已設定（由部署環境提供，不會顯示內容）。" : "尚未設定。") : isSet ? "已設定 — 留空則保留原值；輸入新值即取代。" : "尚未設定。"}
            </>
          }
          placeholder={isSet ? "已設定 — 留空則保留" : "尚未設定"}
          value={String(v ?? "")}
          onChange={(e) => setValue(f.key, e.currentTarget.value)}
          autoComplete="new-password"
          leftSection={isSet ? <IconLock size={14} /> : undefined}
        />
      );
    }
    if (f.is_model) {
      const msg = modelMsg[f.key];
      return (
        <Stack key={f.key} gap={4}>
          <Autocomplete
            {...common}
            data={models[f.key] ?? []}
            value={String(v ?? "")}
            onChange={(val) => setValue(f.key, val)}
            limit={50}
            placeholder="輸入或從清單選擇模型"
            rightSectionPointerEvents="all"
            rightSectionWidth={40}
            rightSection={
              <Tooltip label="向伺服器查詢目前可用的模型">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={() => fetchModels.mutate(f.key)}
                  loading={fetchModels.isPending && fetchModels.variables === f.key}
                  disabled={readonly}
                  aria-label="取得模型清單"
                >
                  <IconRefresh size={16} />
                </ActionIcon>
              </Tooltip>
            }
          />
          {msg && (
            <Text fz="xs" c={msg.ok ? "dimmed" : "red"}>
              {msg.text}
            </Text>
          )}
        </Stack>
      );
    }
    return (
      <TextInput
        key={f.key}
        {...common}
        value={String(v ?? "")}
        onChange={(e) => setValue(f.key, e.currentTarget.value)}
        ff={f.is_url ? "monospace" : undefined}
        placeholder={f.is_url ? "https://…" : undefined}
        rightSection={
          providerDefault !== undefined && String(v) !== providerDefault && !readonly ? (
            <Tooltip label="套用預設值">
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => setValue(f.key, providerDefault)} aria-label="套用預設值">
                <IconArrowBackUp size={14} />
              </ActionIcon>
            </Tooltip>
          ) : undefined
        }
      />
    );
  };

  return (
    <Stack gap="lg">
      {readonly && (
        <Alert color="gray" icon={<IconLock size={18} />} title="由部署環境管理（唯讀）">
          這組設定來自 <Text span ff="monospace" fz="sm">.env</Text> / docker compose，無法在此修改——改了也不會移動實際運作中的服務。
          如需變更，請修改部署設定後重新啟動相關容器。你仍可在這裡測試連線。
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: cols }} spacing="lg" verticalSpacing="md">
        {visibleFields.map(renderField)}
      </SimpleGrid>

      {formError && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} withCloseButton onClose={() => setFormError(null)} title="伺服器拒絕了這次儲存">
          {formError}
        </Alert>
      )}

      {testResult && (
        <Alert
          color={testResult.ok ? "teal" : "red"}
          icon={testResult.ok ? <IconCheck size={18} /> : <IconX size={18} />}
          title={testResult.ok ? "連線測試成功" : "連線測試失敗"}
          withCloseButton
          onClose={() => setTestResult(null)}
        >
          <Stack gap={6}>
            <Text fz="sm" style={{ wordBreak: "break-word" }}>
              {testResult.message_zh ?? testResult.message ?? (testResult.ok ? "成功" : "失敗")}
            </Text>
            {testResult.hint_zh && (
              <Text fz="sm" c="dimmed">
                {testResult.hint_zh}
              </Text>
            )}
            {!testResult.ok && testResult.message_zh && testResult.message && (
              <Text fz="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-word" }}>
                技術細節：{testResult.message.length > 300 ? `${testResult.message.slice(0, 300)}…` : testResult.message}
              </Text>
            )}
            {testResult.details && Object.keys(testResult.details).length > 0 && (
              <Group gap={6} wrap="wrap">
                {Object.entries(testResult.details)
                  .filter(([, val]) => val !== null && val !== undefined && typeof val !== "object")
                  .map(([k, val]) => (
                    <Badge key={k} variant="light" color="gray" tt="none" fw={500}>
                      {k}: {String(val)}
                    </Badge>
                  ))}
              </Group>
            )}
            {testResult.withUnsaved && (
              <Text fz="xs" c="dimmed">
                這次測試使用的是表單上尚未儲存的值。
              </Text>
            )}
          </Stack>
        </Alert>
      )}

      <Group justify="space-between" gap="sm" wrap="wrap">
        <Text fz="xs" c={dirty ? "amber.7" : "dimmed"}>
          {readonly ? "唯讀設定" : dirty ? `${dirtyKeys.length} 個欄位尚未儲存` : "所有變更都已儲存"}
        </Text>
        <Group gap="xs" wrap="wrap">
          {group.test && (
            <Tooltip
              label={group.group === "minio" ? "以目前的值連線；若 bucket 不存在會自動建立" : "用表單上目前的值實際連線一次（不會儲存）"}
              multiline
              w={260}
            >
              <Button
                variant="default"
                leftSection={<IconPlugConnected size={16} />}
                onClick={() => test.mutate()}
                loading={test.isPending}
                disabled={hasErrors}
              >
                測試連線
              </Button>
            </Tooltip>
          )}
          {!readonly && (
            <>
              <Button variant="subtle" color="gray" leftSection={<IconArrowBackUp size={16} />} onClick={() => setDraft(initial)} disabled={!dirty || save.isPending}>
                還原
              </Button>
              <Tooltip label={hasErrors ? "請先修正標示紅色的欄位" : "沒有變更"} disabled={dirty && !hasErrors}>
                <Button leftSection={<IconDeviceFloppy size={16} />} onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || hasErrors}>
                  儲存變更
                </Button>
              </Tooltip>
            </>
          )}
        </Group>
      </Group>
      {footer}
    </Stack>
  );
}


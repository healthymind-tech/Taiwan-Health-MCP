import { Alert, Badge, Box, Button, Card, Group, List, SimpleGrid, Stack, Table, Text, ThemeIcon } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { useQueryClient } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconCheck,
  IconFileImport,
  IconFileExport,
  IconJson,
  IconKey,
  IconTransfer,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { useState } from "react";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import { SectionCard } from "@/components/SectionCard";
import { api, ApiError, errorMessage } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { qk } from "@/lib/queryKeys";
import type { SettingsGroup } from "@/lib/types";
import { GROUP_META, SECRET_MASK, fieldLabel, groupLabel, useSettings } from "../integrations/settingsModel";
import { useAccounts } from "../models/llmApi";
import { llmErrorText } from "../models/llmErrors";

/** Max export version this console understands (adminSettings.SETTINGS_EXPORT_VERSION). */
const MAX_VERSION = 3;

interface ExportDoc {
  version: number;
  exported_at?: string;
  groups: Record<string, Record<string, unknown>>;
  /** v2: flat endpoint list. */
  profiles?: Record<string, unknown>[];
  /** v3: provider accounts, profiles and role bindings. */
  llm?: { providers: Record<string, unknown>[]; profiles: Record<string, unknown>[]; roles?: Record<string, unknown> };
  rp_id?: string;
  passkeys?: Record<string, unknown>[];
}

interface ImportResult {
  ok: boolean;
  imported: number;
  groups: string[];
  profiles: number;
  passkeys: number;
  skipped: string[];
}

interface FieldChange {
  key: string;
  label: string;
  from: string;
  to: string;
  secret: boolean;
  changed: boolean;
}

interface GroupPreview {
  group: string;
  label: string;
  changes: FieldChange[];
}

interface Preview {
  fileName: string;
  doc: ExportDoc;
  groups: GroupPreview[];
  skipped: string[];
  profileCount: number | null;
  profileProblems: string[];
  passkeyCount: number;
}

function parseDoc(text: string): ExportDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("不是有效的 JSON 檔案。");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("檔案格式不正確：最外層必須是物件。");
  const obj = raw as Record<string, unknown>;
  const doc = (obj.document && typeof obj.document === "object" ? obj.document : obj) as Record<string, unknown>;
  const version = Number(doc.version);
  if (!Number.isFinite(version) || version < 1) throw new Error("這不是本系統匯出的設定檔（缺少 version）。");
  if (version > MAX_VERSION) throw new Error(`設定檔版本 ${version} 比此系統支援的 ${MAX_VERSION} 新，請先升級系統。`);
  const groups = doc.groups;
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) throw new Error("檔案格式不正確：groups 必須是物件。");
  if (doc.profiles !== undefined && doc.profiles !== null && !Array.isArray(doc.profiles)) throw new Error("檔案格式不正確：profiles 必須是陣列。");
  return {
    version,
    exported_at: typeof doc.exported_at === "string" ? doc.exported_at : undefined,
    groups: groups as Record<string, Record<string, unknown>>,
    profiles: Array.isArray(doc.profiles) ? (doc.profiles as Record<string, unknown>[]) : undefined,
    llm:
      doc.llm && typeof doc.llm === "object" && Array.isArray((doc.llm as Record<string, unknown>).providers)
        ? (doc.llm as ExportDoc["llm"])
        : undefined,
    rp_id: typeof doc.rp_id === "string" ? doc.rp_id : undefined,
    passkeys: Array.isArray(doc.passkeys) ? (doc.passkeys as Record<string, unknown>[]) : undefined,
  };
}

/** v3: basic shape checks; the server re-validates every account and profile on import. */
function llmProblems(llm: NonNullable<ExportDoc["llm"]>): string[] {
  const problems: string[] = [];
  llm.providers.forEach((p, i) => {
    const name = String(p.name ?? "").trim() || `#${i + 1}`;
    if (!String(p.provider ?? "").trim()) problems.push(`帳號「${name}」缺少 provider。`);
  });
  llm.profiles.forEach((p, i) => {
    const name = String(p.name ?? "").trim() || `#${i + 1}`;
    if (!Array.isArray(p.members) || p.members.length === 0) problems.push(`Profile「${name}」沒有成員。`);
  });
  return problems;
}

/** Mirror of the backend's embedding consistency rule (exact-match variant, stricter). */
function profileProblems(profiles: Record<string, unknown>[]): string[] {
  const problems: string[] = [];
  profiles.forEach((p, i) => {
    const name = String(p.name ?? "").trim() || `#${i + 1}`;
    if (p.kind !== "analysis" && p.kind !== "embedding") problems.push(`端點「${name}」的 kind 不是 analysis / embedding。`);
    if (!String(p.model ?? "").trim()) problems.push(`端點「${name}」缺少模型。`);
    try {
      const u = new URL(String(p.base_url ?? ""));
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      problems.push(`端點「${name}」的 base_url 不是有效網址。`);
    }
  });
  const emb = profiles.filter((p) => p.kind === "embedding" && p.enabled !== false);
  const dims = new Set(emb.map((p) => Math.trunc(Number((p.params as Record<string, unknown> | undefined)?.dimensions ?? 1024))));
  if (dims.size > 1) problems.push(`啟用中的 Embedding 端點維度不一致（${[...dims].join("、")}），伺服器會拒絕。`);
  return problems;
}

function display(v: unknown): string {
  if (v === null || v === undefined || v === "") return "（空）";
  return String(v);
}

function buildPreview(fileName: string, doc: ExportDoc, current: SettingsGroup[]): Preview {
  const byKey = new Map(current.map((g) => [g.group, g]));
  const groups: GroupPreview[] = [];
  const skipped: string[] = [];
  for (const [group, values] of Object.entries(doc.groups)) {
    const g = byKey.get(group);
    if (!g || g.readonly || !values || typeof values !== "object") {
      skipped.push(g?.readonly ? `${groupLabel(g)}（由部署環境管理，不會匯入）` : `${group}（此系統沒有這個群組）`);
      continue;
    }
    const changes: FieldChange[] = [];
    for (const [key, raw] of Object.entries(values)) {
      const f = g.fields.find((x) => x.key === key);
      if (!f) {
        skipped.push(`${group}.${key}（未知欄位）`);
        continue;
      }
      const cur = f.secret ? (f.value ? SECRET_MASK : "") : display(f.value);
      const next = f.secret ? (raw ? "（新的機密值）" : "（空）") : display(raw);
      const changed = f.secret ? Boolean(raw) : String(f.value ?? "") !== String(raw ?? "");
      changes.push({ key, label: fieldLabel(group, f), from: cur, to: next, secret: f.secret, changed });
    }
    groups.push({ group, label: GROUP_META[group]?.label ?? g.label, changes });
  }
  return {
    fileName,
    doc,
    groups,
    skipped,
    // Counted in provider accounts (v3), or legacy endpoints (v2 — each becomes an account).
    profileCount: doc.llm ? doc.llm.providers.length : doc.profiles ? doc.profiles.length : null,
    profileProblems: doc.llm ? llmProblems(doc.llm) : doc.profiles ? profileProblems(doc.profiles) : [],
    passkeyCount: doc.passkeys?.length ?? 0,
  };
}

export function SettingsTransferSection() {
  const qc = useQueryClient();
  const settings = useSettings();
  const accounts = useAccounts();
  const [exporting, setExporting] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const currentProfiles = accounts.data?.accounts ?? [];

  const doExport = async () => {
    setExporting(true);
    try {
      const res = await fetch("/admin/api/settings/export", { credentials: "same-origin" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null;
        throw new ApiError(body?.error ?? `匯出失敗（HTTP ${res.status}）`, res.status, body?.detail, body);
      }
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") ?? "";
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? `tw-health-settings-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify.success(`已下載 ${name}，請妥善保管`, "設定已匯出");
    } catch (e) {
      notify.error(e, "匯出失敗");
    } finally {
      setExporting(false);
    }
  };

  const confirmExport = () =>
    confirmAction({
      title: "匯出設定檔？",
      message: "匯出的 JSON 檔可在另一套系統（或重建後的同一套系統）還原完整設定。",
      consequences: [
        "檔案內的 API 金鑰（Embedding、分析 LLM 等）是明文，任何拿到檔案的人都能使用這些金鑰。",
        "也包含已註冊 passkey 的公鑰（公鑰無法用來登入）。",
        "MinIO 與 worker 等由部署環境管理的設定不會匯出。",
      ],
      confirmLabel: "我了解，下載",
      onConfirm: doExport,
    });

  const onFile = async (file: File) => {
    setParseError(null);
    setResult(null);
    setPreview(null);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("檔案太大（> 5 MB），這不像是設定匯出檔。");
      const text = await file.text();
      const doc = parseDoc(text);
      if (!settings.data) throw new Error("目前設定尚未載入，請稍後再試。");
      setPreview(buildPreview(file.name, doc, settings.data.groups));
    } catch (e) {
      setParseError(errorMessage(e));
    }
  };

  const apply = (p: Preview) => {
    const changedFields = p.groups.reduce((n, g) => n + g.changes.filter((c) => c.changed).length, 0);
    confirmAction({
      title: "套用匯入的設定？",
      message: `來源檔案：${p.fileName}`,
      consequences: [
        `${p.groups.length} 個設定群組、${changedFields} 個欄位會被覆寫（含機密值）。`,
        p.profileCount === null
          ? "檔案沒有模型端點資料，現有端點保持不變。"
          : p.profileCount === 0
            ? `檔案裡沒有任何 Provider 帳號：目前的 ${currentProfiles.length} 個帳號與所有 Profile 會全部被刪除！`
            : `目前的 ${currentProfiles.length} 個 Provider 帳號與所有 Profile 會整批換成檔案中的 ${p.profileCount} 個帳號（含 API 金鑰）與其 Profile。`,
        p.passkeyCount > 0
          ? `檔案含 ${p.passkeyCount} 把 passkey：只有在 rp_id（${p.doc.rp_id || "未知"}）與此系統相同時才會加入；現有 passkey 不會被移除。`
          : "不含 passkey。",
        "設定會立即生效；執行中的工作會在下一次呼叫時使用新設定。",
      ],
      confirmLabel: "套用設定",
      danger: true,
      typeToConfirm: p.profileCount === 0 && currentProfiles.length > 0 ? "IMPORT" : undefined,
      onConfirm: async () => {
        try {
          const r = await api.post<ImportResult>("/admin/api/settings/import", p.doc);
          setResult(r);
          setPreview(null);
          notify.success(`已匯入 ${r.imported} 個欄位、${r.profiles} 個 Profile`, "設定已匯入");
          void qc.invalidateQueries({ queryKey: qk.settings });
          void qc.invalidateQueries({ queryKey: ["llm"] });
          void qc.invalidateQueries({ queryKey: qk.passkeys });
          void qc.invalidateQueries({ queryKey: qk.services });
          void qc.invalidateQueries({ queryKey: qk.overview });
        } catch (e) {
          // Model-endpoint rejections (fingerprint, unreachable endpoint…) come coded: translate them.
          notify.error(llmErrorText(e), "匯入失敗");
          // The backend validates the model endpoints before writing any group
          // value, so a rejection changes nothing; refresh anyway (cheap, and
          // covers a DB error mid-way).
          void qc.invalidateQueries({ queryKey: qk.settings });
          throw e;
        }
      },
    });
  };

  return (
    <SectionCard
      title="設定匯出／匯入"
      description="把設定、模型端點與 passkey 公鑰搬到另一套系統，或在重建後還原。"
      icon={<IconTransfer size={18} />}
    >
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Card padding="md">
          <Stack gap="sm" h="100%">
            <Group gap="sm">
              <ThemeIcon variant="light" size={36}>
                <IconFileExport size={20} />
              </ThemeIcon>
              <Text fw={650}>匯出</Text>
            </Group>
            <Text fz="sm" c="dimmed">
              下載一個 JSON 檔，包含所有可攜設定與模型端點。
            </Text>
            <Alert color="amber" icon={<IconKey size={16} />} p="xs">
              <Text fz="xs">檔案內的 API 金鑰是明文。請當成密碼保管，不要放進版本控制或分享出去。</Text>
            </Alert>
            <Button mt="auto" leftSection={<IconFileExport size={16} />} onClick={confirmExport} loading={exporting} variant="light">
              匯出設定檔
            </Button>
          </Stack>
        </Card>

        <Card padding="md">
          <Stack gap="sm">
            <Group gap="sm">
              <ThemeIcon variant="light" size={36}>
                <IconFileImport size={20} />
              </ThemeIcon>
              <Text fw={650}>匯入</Text>
            </Group>
            <Text fz="sm" c="dimmed">
              選擇先前匯出的 JSON 檔。檔案只會在瀏覽器中讀取並預覽，確認後才會送出。
            </Text>
            <Dropzone
              onDrop={(files) => files[0] && void onFile(files[0])}
              onReject={() => setParseError("請選擇 .json 檔案")}
              accept={{ "application/json": [".json"] }}
              multiple={false}
              radius="md"
              p="md"
              disabled={settings.isPending}
              styles={{ root: { borderStyle: "dashed", borderWidth: 1.5 } }}
            >
              <Group justify="center" gap="sm" style={{ pointerEvents: "none" }} wrap="nowrap">
                <Dropzone.Accept>
                  <IconUpload size={22} />
                </Dropzone.Accept>
                <Dropzone.Reject>
                  <IconX size={22} color="var(--mantine-color-red-6)" />
                </Dropzone.Reject>
                <Dropzone.Idle>
                  <IconJson size={22} />
                </Dropzone.Idle>
                <Text fz="sm" fw={600}>
                  拖曳 tw-health-settings-*.json 到這裡，或點擊選擇
                </Text>
              </Group>
            </Dropzone>
            {parseError && (
              <Text fz="xs" c="red">
                {parseError}
              </Text>
            )}
          </Stack>
        </Card>
      </SimpleGrid>

      {preview && <ImportPreview preview={preview} currentProfileCount={currentProfiles.length} onCancel={() => setPreview(null)} onApply={() => apply(preview)} />}

      {result && (
        <Alert mt="lg" color="teal" icon={<IconCheck size={18} />} title="匯入完成" withCloseButton onClose={() => setResult(null)}>
          <Stack gap={4}>
            <Text fz="sm">
              寫入 {result.imported} 個欄位（群組：{result.groups.length ? result.groups.join("、") : "無"}）、{result.profiles} 組模型設定（Profile）、{result.passkeys} 把 passkey。
            </Text>
            {result.skipped.length > 0 && (
              <>
                <Text fz="sm" fw={600}>
                  略過：
                </Text>
                <List size="xs">
                  {result.skipped.map((s) => (
                    <List.Item key={s}>{s}</List.Item>
                  ))}
                </List>
              </>
            )}
          </Stack>
        </Alert>
      )}
    </SectionCard>
  );
}

function ImportPreview({
  preview: p,
  currentProfileCount,
  onCancel,
  onApply,
}: {
  preview: Preview;
  currentProfileCount: number;
  onCancel: () => void;
  onApply: () => void;
}) {
  const blocked = p.profileProblems.length > 0;
  return (
    <Stack gap="md" mt="lg">
      <Group justify="space-between" gap="sm" wrap="wrap">
        <Box style={{ minWidth: 0 }}>
          <Text fw={650}>匯入預覽：{p.fileName}</Text>
          <Text fz="xs" c="dimmed">
            版本 {p.doc.version}
            {p.doc.exported_at ? ` · 匯出於 ${fmtDateTime(p.doc.exported_at)}` : ""}
          </Text>
        </Box>
        <Group gap="xs">
          <Button variant="default" onClick={onCancel}>
            取消
          </Button>
          <Button color="red" onClick={onApply} disabled={blocked} leftSection={<IconFileImport size={16} />}>
            套用設定…
          </Button>
        </Group>
      </Group>

      {blocked && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="檔案內的模型端點有問題，伺服器會拒絕">
          <List size="sm">
            {p.profileProblems.map((m) => (
              <List.Item key={m}>{m}</List.Item>
            ))}
          </List>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
        <Card padding="sm">
          <Text fz="xs" c="dimmed">
            設定群組
          </Text>
          <Text fw={650}>{p.groups.length} 個</Text>
        </Card>
        <Card padding="sm">
          <Text fz="xs" c="dimmed">
            模型端點
          </Text>
          <Text fw={650} c={p.profileCount === 0 && currentProfileCount > 0 ? "red" : undefined}>
            {p.profileCount === null ? "不變更" : `${currentProfileCount} → ${p.profileCount} 個（整批取代）`}
          </Text>
        </Card>
        <Card padding="sm">
          <Text fz="xs" c="dimmed">
            Passkey
          </Text>
          <Text fw={650}>{p.passkeyCount > 0 ? `${p.passkeyCount} 把（rp_id：${p.doc.rp_id || "未知"}）` : "無"}</Text>
          {p.passkeyCount > 0 && (
            <Text fz="xs" c="dimmed">
              目前網域：{window.location.hostname}。rp_id 不同時不會匯入。
            </Text>
          )}
        </Card>
      </SimpleGrid>

      {p.groups.map((g) => (
        <Card key={g.group} padding={0}>
          <Group px="md" py="xs" justify="space-between">
            <Text fw={600} fz="sm">
              {g.label}
            </Text>
            <Badge variant="light" color={g.changes.some((c) => c.changed) ? "amber" : "gray"}>
              {g.changes.filter((c) => c.changed).length} 個變更
            </Badge>
          </Group>
          <Table.ScrollContainer minWidth={480} type="native">
            <Table fz="xs" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>欄位</Table.Th>
                  <Table.Th>目前</Table.Th>
                  <Table.Th>匯入後</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {g.changes.map((c) => (
                  <Table.Tr key={c.key} style={{ opacity: c.changed ? 1 : 0.55 }}>
                    <Table.Td>{c.label}</Table.Td>
                    <Table.Td ff={c.secret ? undefined : "monospace"} style={{ wordBreak: "break-all" }}>
                      {c.from}
                    </Table.Td>
                    <Table.Td ff={c.secret ? undefined : "monospace"} fw={c.changed ? 600 : undefined} style={{ wordBreak: "break-all" }}>
                      {c.to}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      ))}

      {p.skipped.length > 0 && (
        <Text fz="xs" c="dimmed">
          將略過：{p.skipped.join("；")}
        </Text>
      )}
    </Stack>
  );
}

import { Alert, Badge, Button, Checkbox, Group, Modal, ScrollArea, SegmentedControl, Stack, Text } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { IconAlertTriangle, IconFileImport, IconUpload } from "@tabler/icons-react";
import { useState } from "react";
import { notify } from "@/components/notify";
import { errorMessage } from "@/lib/api";
import { useIsMobile } from "@/lib/hooks";
import type { FhirServer } from "@/lib/types";
import { fhirApi, useInvalidateFhir } from "./fhirApi";

type Resolution = "skip" | "overwrite" | "copy";
interface ImportRow {
  id: string;
  raw: Record<string, unknown>;
  key: string;
  name: string;
  selected: boolean;
  conflict: FhirServer | null;
  resolution: Resolution;
  status?: "ok" | "error" | "skipped";
  message?: string;
}

function parseFile(text: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(text);
  const container = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const raw: unknown = container && Array.isArray(container.servers) ? container.servers : parsed;
  const list = Array.isArray(raw) ? raw : [raw];
  const out = list.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x));
  if (out.length === 0) throw new Error("檔案中找不到 FHIR 伺服器設定（需為單一物件或含 servers 陣列的匯出檔）");
  return out;
}

/** Import servers from an export file, with per-row conflict resolution. */
export function ImportModal({ opened, onClose, servers }: { opened: boolean; onClose: () => void; servers: FhirServer[] }) {
  const isMobile = useIsMobile();
  const invalidate = useInvalidateFhir();
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setRows(null);
    setParseError(null);
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const load = async (file: File) => {
    try {
      const list = parseFile(await file.text());
      const byKey = new Map(servers.map((s) => [s.server_key.toLowerCase(), s]));
      setRows(
        list.map((raw, i) => {
          const key = String(raw.server_key ?? "").trim().toLowerCase();
          return {
            id: `${i}-${key}`,
            raw,
            key,
            name: String(raw.display_name || raw.name || key || `#${i + 1}`),
            selected: Boolean(key),
            conflict: byKey.get(key) ?? null,
            resolution: "skip",
          };
        }),
      );
      setParseError(null);
    } catch (e) {
      setParseError(e instanceof SyntaxError ? `不是有效的 JSON：${e.message}` : errorMessage(e));
    }
  };

  const patch = (id: string, p: Partial<ImportRow>) => setRows((rs) => (rs ? rs.map((r) => (r.id === id ? { ...r, ...p } : r)) : rs));

  const actionable = (rows ?? []).filter((r) => r.selected && !(r.conflict && r.resolution === "skip"));
  const done = Boolean(rows?.some((r) => r.status));

  const run = async () => {
    if (!rows) return;
    setBusy(true);
    const taken = new Set(servers.map((s) => s.server_key.toLowerCase()));
    const results: ImportRow[] = [];
    for (const row of rows) {
      if (!row.selected || (row.conflict && row.resolution === "skip")) {
        results.push({ ...row, status: "skipped", message: "略過" });
        continue;
      }
      // Never let imports fight over the single default flag.
      const body: Record<string, unknown> = { ...row.raw, is_default: false };
      try {
        if (row.conflict && row.resolution === "overwrite") {
          delete body.fhir_server_id;
          await fhirApi.update(row.conflict.fhir_server_id, body);
          results.push({ ...row, status: "ok", message: "已覆寫現有設定" });
        } else {
          if (row.conflict && row.resolution === "copy") {
            let key = `${row.key}-imported`;
            let n = 2;
            while (taken.has(key)) key = `${row.key}-imported-${n++}`;
            body.server_key = key;
            body.name = `${String(row.raw.name ?? row.key)} (imported)`;
            delete body.fhir_server_id; // a copy gets a fresh id → new JWKS URL
          }
          const created = await fhirApi.create(body);
          taken.add(created.server_key.toLowerCase());
          results.push({ ...row, status: "ok", message: row.conflict ? `已匯入為 ${created.server_key}` : "已建立" });
        }
      } catch (e) {
        results.push({ ...row, status: "error", message: errorMessage(e) });
      }
    }
    setRows(results);
    setBusy(false);
    await invalidate();
    const ok = results.filter((r) => r.status === "ok").length;
    const fail = results.filter((r) => r.status === "error").length;
    if (fail) notify.warn(`成功 ${ok} 台，失敗 ${fail} 台，請查看各列錯誤訊息`, "匯入部分失敗");
    else notify.success(`已匯入 ${ok} 台 FHIR 伺服器`);
  };

  return (
    <Modal opened={opened} onClose={close} title={<Text fw={650} fz="lg">匯入 FHIR 伺服器設定</Text>} size="xl" fullScreen={isMobile}>
      <Stack gap="md">
        {!rows ? (
          <>
            <Text fz="sm" c="dimmed">
              選擇先前由「匯出」產生的 JSON 檔。匯入會以檔案中的設定（含 client secret 與私鑰）建立伺服器；匯入的伺服器一律不會成為預設伺服器。
            </Text>
            <Dropzone
              onDrop={(files) => {
                const f = files[0];
                if (f) void load(f);
              }}
              accept={["application/json", ".json"]}
              maxFiles={1}
              maxSize={5 * 1024 * 1024}
              onReject={() => setParseError("只接受 5 MB 以內的 .json 檔")}
              radius="lg"
            >
              <Stack align="center" gap={6} py="lg" style={{ pointerEvents: "none" }}>
                <IconUpload size={32} stroke={1.5} />
                <Text fw={600}>拖曳 JSON 檔到這裡，或點擊選擇</Text>
                <Text fz="xs" c="dimmed">
                  fhir-servers-YYYY-MM-DD.json
                </Text>
              </Stack>
            </Dropzone>
            {parseError && (
              <Alert color="red" icon={<IconAlertTriangle size={18} />}>
                {parseError}
              </Alert>
            )}
          </>
        ) : (
          <>
            <Text fz="sm" c="dimmed">
              檔案中有 {rows.length} 台伺服器。與現有 server_key 相同者，請選擇略過、覆寫或另存為副本。
            </Text>
            <ScrollArea.Autosize mah={isMobile ? undefined : 420} type="auto">
              <Stack gap="xs">
                {rows.map((r) => (
                  <Stack
                    key={r.id}
                    gap={6}
                    p="sm"
                    style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)" }}
                  >
                    <Group justify="space-between" wrap="wrap" gap="xs">
                      <Checkbox
                        checked={r.selected}
                        disabled={done || busy || !r.key}
                        onChange={(e) => patch(r.id, { selected: e.currentTarget.checked })}
                        label={
                          <Text fz="sm" fw={600} span>
                            {r.name}{" "}
                            <Text span ff="monospace" fz="xs" c="dimmed">
                              {r.key || "（缺少 server_key）"}
                            </Text>
                          </Text>
                        }
                      />
                      {r.status ? (
                        <Badge color={r.status === "ok" ? "teal" : r.status === "error" ? "red" : "gray"} variant="light">
                          {r.status === "ok" ? "完成" : r.status === "error" ? "失敗" : "略過"}
                        </Badge>
                      ) : r.conflict ? (
                        <Badge color="amber" variant="light">
                          已存在
                        </Badge>
                      ) : (
                        <Badge color="teal" variant="light">
                          新伺服器
                        </Badge>
                      )}
                    </Group>
                    {r.conflict && !r.status && r.selected && (
                      <SegmentedControl
                        size="xs"
                        value={r.resolution}
                        onChange={(v) => patch(r.id, { resolution: v as Resolution })}
                        disabled={busy}
                        data={[
                          { value: "skip", label: "略過" },
                          { value: "overwrite", label: "覆寫現有" },
                          { value: "copy", label: "另存副本" },
                        ]}
                        fullWidth={isMobile}
                      />
                    )}
                    {r.message && r.status !== "skipped" && (
                      <Text fz="xs" c={r.status === "error" ? "red" : "dimmed"} style={{ wordBreak: "break-word" }}>
                        {r.message}
                      </Text>
                    )}
                  </Stack>
                ))}
              </Stack>
            </ScrollArea.Autosize>
            {rows.some((r) => r.conflict && r.resolution === "overwrite" && r.selected) && !done && (
              <Alert color="amber" icon={<IconAlertTriangle size={18} />} p="sm">
                「覆寫現有」會以檔案內容取代該伺服器的全部設定（含允許的操作與資源類型）。
              </Alert>
            )}
          </>
        )}
        <Group justify="flex-end" gap="sm">
          {rows && !done && (
            <Button variant="subtle" onClick={reset} disabled={busy}>
              重新選擇檔案
            </Button>
          )}
          <Button variant="default" onClick={close} disabled={busy}>
            {done ? "關閉" : "取消"}
          </Button>
          {rows && !done && (
            <Button leftSection={<IconFileImport size={16} />} onClick={() => void run()} loading={busy} disabled={actionable.length === 0}>
              匯入 {actionable.length} 台
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

import {
  Alert,
  Badge,
  Box,
  Button,
  Combobox,
  Group,
  InputBase,
  Loader,
  Modal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  useCombobox,
} from "@mantine/core";
import { IconAlertTriangle, IconCloudDownload, IconSearch, IconUpload } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { UploadDropzone } from "@/components/UploadDropzone";
import { notify } from "@/components/notify";
import { api, ApiError, errorMessage, qs, uploadFile } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useDebounced, useIsMobile } from "@/lib/hooks";
import type { CatalogEntry, JobSummary, UploadedFile } from "@/lib/types";
import { notifyJobStarted } from "../modules/ImportSection";
import type { IgSummary, RegistryHit } from "./igTypes";

const PKG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function RegistryForm({ installed, onDone, busy }: { installed: IgSummary[]; onDone: () => void; busy: string | null }) {
  const [input, setInput] = useState("");
  const [version, setVersion] = useState("");
  const [picked, setPicked] = useState<RegistryHit | null>(null);
  const debounced = useDebounced(input.trim(), 350);
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() });

  const search = useQuery({
    queryKey: qk.registrySearch(debounced),
    queryFn: () => api.get<{ results: RegistryHit[] }>("/admin/api/registry/search" + qs({ q: debounced })),
    enabled: debounced.length >= 2 && picked?.name !== debounced,
    staleTime: 60_000,
    retry: false,
  });

  const start = useMutation({
    mutationFn: (body: { package_id: string; version: string }) =>
      api.post<{ job: JobSummary }>("/admin/api/igs/import", { source: "registry", ...body }),
  });

  // Accept "packageId@version" pasted directly.
  const [rawId, rawVer] = input.includes("@") ? input.split("@", 2) : [input, ""];
  const packageId = rawId.trim();
  const effectiveVersion = (version || rawVer).trim();
  const idError = packageId && !PKG_ID_RE.test(packageId) ? "套件 ID 只能包含英數字、點、底線與連字號" : null;
  const already = installed.find((i) => i.package_id === packageId && (!effectiveVersion || i.version === effectiveVersion));

  const submit = async () => {
    try {
      const res = await start.mutateAsync({ package_id: packageId, version: effectiveVersion });
      notifyJobStarted(res.job, `${packageId}${effectiveVersion ? `@${effectiveVersion}` : ""} 匯入工作`);
      onDone();
    } catch (e) {
      notify.error(e, "無法開始匯入");
    }
  };

  const results = search.data?.results ?? [];

  return (
    <Stack gap="md">
      <Text fz="sm" c="dimmed">
        從 FHIR Package Registry 下載套件並匯入；它宣告的相依 IG（例如 hl7.fhir.r4.core）會自動一起下載。
      </Text>
      <Combobox
        store={combobox}
        onOptionSubmit={(val) => {
          const hit = results.find((r) => r.name === val) ?? null;
          setPicked(hit);
          setInput(val);
          combobox.closeDropdown();
        }}
      >
        <Combobox.Target>
          <InputBase
            label="套件 ID"
            description="輸入至少 2 個字搜尋，或直接貼上 packageId@version"
            placeholder="例如 tw.gov.mohw.twcore"
            leftSection={<IconSearch size={16} />}
            rightSection={search.isFetching ? <Loader size={14} /> : null}
            value={input}
            onChange={(e) => {
              setInput(e.currentTarget.value);
              setPicked(null);
              combobox.openDropdown();
              combobox.updateSelectedOptionIndex();
            }}
            onFocus={() => combobox.openDropdown()}
            onBlur={() => combobox.closeDropdown()}
            error={idError}
            styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
            autoComplete="off"
            data-autofocus
          />
        </Combobox.Target>
        <Combobox.Dropdown hidden={debounced.length < 2 || picked?.name === debounced}>
          <Combobox.Options>
            <ScrollArea.Autosize mah={280} type="auto">
              {search.isError ? (
                <Combobox.Empty>Registry 搜尋失敗：{errorMessage(search.error)}</Combobox.Empty>
              ) : search.isFetching && results.length === 0 ? (
                <Combobox.Empty>搜尋中…</Combobox.Empty>
              ) : results.length === 0 ? (
                <Combobox.Empty>找不到符合的套件，仍可用完整 ID 直接匯入</Combobox.Empty>
              ) : (
                results.slice(0, 50).map((r) => (
                  <Combobox.Option value={r.name} key={r.name}>
                    <Group gap={6} wrap="nowrap" justify="space-between">
                      <Text fz="sm" ff="monospace" style={{ wordBreak: "break-all" }}>
                        {r.name}
                      </Text>
                      {r.fhirVersion && (
                        <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
                          FHIR {r.fhirVersion}
                        </Badge>
                      )}
                    </Group>
                    {r.description && (
                      <Text fz="xs" c="dimmed" lineClamp={2}>
                        {r.description}
                      </Text>
                    )}
                  </Combobox.Option>
                ))
              )}
            </ScrollArea.Autosize>
          </Combobox.Options>
        </Combobox.Dropdown>
      </Combobox>

      {picked && (
        <Box p="sm" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)" }}>
          <Text fz="sm" fw={600} ff="monospace">
            {picked.name}
          </Text>
          {picked.description && (
            <Text fz="xs" c="dimmed" mt={2}>
              {picked.description}
            </Text>
          )}
          {picked.fhirVersion && (
            <Badge size="xs" mt={6} variant="light">
              FHIR {picked.fhirVersion}
            </Badge>
          )}
        </Box>
      )}

      <TextInput
        label="版本"
        description={rawVer ? `已從輸入解析出版本 ${rawVer}` : "留空會匯入 Registry 上的最新版本"}
        placeholder="例如 1.0.0"
        value={version}
        onChange={(e) => setVersion(e.currentTarget.value)}
        disabled={Boolean(rawVer)}
        styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
      />

      {already && (
        <Alert color="amber" p="sm" icon={<IconAlertTriangle size={16} />}>
          <Text fz="sm">
            {already.package_id}@{already.version} 已安裝。再次匯入會以相同版本重新載入（覆寫其構件與術語）。
          </Text>
        </Alert>
      )}
      {busy && (
        <Alert color="blue" p="sm">
          <Text fz="sm">{busy}</Text>
        </Alert>
      )}

      <Group justify="flex-end">
        <Button
          leftSection={<IconCloudDownload size={16} />}
          disabled={!packageId || Boolean(idError)}
          loading={start.isPending}
          onClick={() => void submit()}
        >
          匯入 {packageId ? `${packageId}${effectiveVersion ? `@${effectiveVersion}` : "（最新版）"}` : ""}
        </Button>
      </Group>
    </Stack>
  );
}

function UploadForm({ entry, maxUploadMb, onDone, busy }: { entry: CatalogEntry | null; maxUploadMb: number; onDone: () => void; busy: string | null }) {
  const role = entry?.source_role ?? "ig";
  const extensions = entry?.accepted_extensions ?? [".tgz", ".tar.gz"];

  const upload = async (file: File, onProgress: (l: number, t: number) => void, signal: AbortSignal) => {
    // auto_activate=false: the import job reads the uploaded object directly.
    const res = await uploadFile<{ duplicate: boolean; uploaded_file: UploadedFile }>(
      "/admin/api/uploads" + qs({ module_key: "ig", source_role: role, filename: file.name, auto_activate: false }),
      file,
      (p) => onProgress(p.loaded, p.total),
      signal,
    );
    if (res.duplicate) notify.info("伺服器已有內容相同的套件檔，沿用既有檔案進行匯入。", "重複上傳");
    try {
      const job = await api.post<{ job: JobSummary }>("/admin/api/igs/import", {
        source: "upload",
        uploaded_file_id: res.uploaded_file.uploaded_file_id,
      });
      notifyJobStarted(job.job, `${file.name} 匯入工作`);
      onDone();
    } catch (e) {
      throw new ApiError(`檔案已上傳，但無法開始匯入：${errorMessage(e)}`, e instanceof ApiError ? e.status : 0);
    }
  };

  return (
    <Stack gap="md">
      <Text fz="sm" c="dimmed">
        上傳 FHIR NPM 套件（package.tgz），適用於私有 IG 或 Registry 無法提供的版本。相依的 IG 仍會自動從 Registry 下載。
      </Text>
      {busy ? (
        <Alert color="blue" p="sm">
          <Text fz="sm">{busy}</Text>
        </Alert>
      ) : null}
      <UploadDropzone
        onUpload={upload}
        extensions={extensions}
        maxSizeMb={maxUploadMb}
        title="拖曳 package.tgz 到這裡，或點擊選擇"
        hint={`支援 ${extensions.join("、")} · 上限 ${maxUploadMb} MB · 上傳完成後立即開始匯入`}
      />
    </Stack>
  );
}

export function AddIgModal({
  opened,
  onClose,
  installed,
  catalogEntry,
  maxUploadMb,
  busy,
}: {
  opened: boolean;
  onClose: () => void;
  installed: IgSummary[];
  catalogEntry: CatalogEntry | null;
  maxUploadMb: number;
  busy: string | null;
}) {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState<"registry" | "upload">("registry");
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Text fw={650} fz="lg">
          新增 Implementation Guide
        </Text>
      }
      size="lg"
      fullScreen={isMobile}
    >
      <Stack gap="md">
        <SegmentedControl
          fullWidth
          value={mode}
          onChange={(v) => setMode(v as "registry" | "upload")}
          data={[
            {
              value: "registry",
              label: (
                <Group gap={6} justify="center" wrap="nowrap">
                  <IconCloudDownload size={16} /> 從 Registry
                </Group>
              ),
            },
            {
              value: "upload",
              label: (
                <Group gap={6} justify="center" wrap="nowrap">
                  <IconUpload size={16} /> 上傳 .tgz
                </Group>
              ),
            },
          ]}
        />
        {mode === "registry" ? (
          <RegistryForm installed={installed} onDone={onClose} busy={busy} />
        ) : (
          <UploadForm entry={catalogEntry} maxUploadMb={maxUploadMb} onDone={onClose} busy={busy} />
        )}
      </Stack>
    </Modal>
  );
}

import { Box, Button, Group, Progress, Stack, Text, ThemeIcon } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { IconCloudUpload, IconFile, IconX } from "@tabler/icons-react";
import { useRef, useState, type ReactNode } from "react";
import { fmtBytes } from "@/lib/format";
import { errorMessage } from "@/lib/api";

export interface UploadDropzoneProps {
  /** Perform the upload; report progress via the callback. Throw to show an error. */
  onUpload: (file: File, onProgress: (loaded: number, total: number) => void, signal: AbortSignal) => Promise<unknown>;
  /** Allowed extensions, e.g. [".zip", ".csv"] (checked client-side). */
  extensions?: string[];
  maxSizeMb?: number;
  title?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  compact?: boolean;
}

/** Drag-and-drop file upload with progress, cancel and validation. */
export function UploadDropzone({ onUpload, extensions, maxSizeMb, title, hint, disabled, compact }: UploadDropzoneProps) {
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const busy = file !== null && error === null;

  const start = async (f: File) => {
    setError(null);
    const lower = f.name.toLowerCase();
    if (extensions && extensions.length > 0 && !extensions.some((e) => lower.endsWith(e.toLowerCase()))) {
      setError(`檔案類型不符，需為 ${extensions.join("、")}`);
      setFile(f);
      return;
    }
    if (maxSizeMb && f.size > maxSizeMb * 1024 * 1024) {
      setError(`檔案大小 ${fmtBytes(f.size)} 超過上限 ${maxSizeMb} MB`);
      setFile(f);
      return;
    }
    setFile(f);
    setProgress(0);
    ctrl.current = new AbortController();
    try {
      await onUpload(f, (l, t) => setProgress(t ? (l / t) * 100 : 0), ctrl.current.signal);
      setFile(null);
      setProgress(0);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (file) {
    return (
      <Box p="md" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)" }}>
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <ThemeIcon variant="light" color={error ? "red" : "brand"} size={36}>
              <IconFile size={18} />
            </ThemeIcon>
            <Box style={{ minWidth: 0 }}>
              <Text fz="sm" fw={600} truncate="end">
                {file.name}
              </Text>
              <Text fz="xs" c={error ? "red" : "dimmed"}>
                {error ?? (progress >= 100 ? "上傳完成，伺服器處理中…" : `${fmtBytes(file.size)} · ${progress.toFixed(0)}%`)}
              </Text>
            </Box>
          </Group>
          {error ? (
            <Button variant="default" size="xs" onClick={() => { setFile(null); setError(null); }}>
              重新選擇
            </Button>
          ) : (
            <Button variant="subtle" color="gray" size="xs" leftSection={<IconX size={14} />} onClick={() => ctrl.current?.abort()}>
              取消
            </Button>
          )}
        </Group>
        {!error && <Progress value={progress} mt="sm" size="sm" animated={progress >= 100} striped={progress >= 100} />}
      </Box>
    );
  }

  return (
    <Dropzone
      onDrop={(files) => files[0] && void start(files[0])}
      multiple={false}
      disabled={disabled || busy}
      radius="md"
      p={compact ? "md" : "xl"}
      styles={{ root: { borderStyle: "dashed", borderWidth: 1.5 } }}
    >
      <Stack align="center" gap={6} style={{ pointerEvents: "none" }} ta="center">
        <ThemeIcon variant="light" size={compact ? 36 : 48} radius="xl">
          <IconCloudUpload size={compact ? 18 : 24} />
        </ThemeIcon>
        <Text fw={600} fz="sm">
          {title ?? "拖曳檔案到這裡，或點擊選擇檔案"}
        </Text>
        <Text fz="xs" c="dimmed">
          {hint ??
            [extensions?.length ? `支援 ${extensions.join("、")}` : null, maxSizeMb ? `上限 ${maxSizeMb} MB` : null]
              .filter(Boolean)
              .join(" · ")}
        </Text>
      </Stack>
    </Dropzone>
  );
}

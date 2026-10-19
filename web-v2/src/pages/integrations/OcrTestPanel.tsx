import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Loader,
  ScrollArea,
  SimpleGrid,
  Skeleton,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { useQuery } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconCopy,
  IconDownload,
  IconFileTypePdf,
  IconPhoto,
  IconPlayerPlay,
  IconPlayerStop,
  IconScan,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { JsonView } from "@/components/JsonView";
import { api, errorMessage, request } from "@/lib/api";
import { fmtBytes, fmtDuration } from "@/lib/format";
import { useIsMobile, useNow } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { OcrMarkdown } from "./OcrMarkdown";

interface SampleFile {
  id: string;
  name: string;
  filename: string;
  type: "pdf" | "image";
  description: string;
  mimeType: string;
  sizeBytes?: number;
}

interface OcrTestResult {
  ok: boolean;
  markdown: string;
  analysis: Record<string, unknown> | null;
  ocrProvider: string;
  analysisProvider: string | null;
  analysisConfigured: boolean;
}

interface SourceFile {
  file: File;
  url: string;
  kind: "pdf" | "image" | "other";
  origin: "sample" | "upload";
}

const ACCEPT = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp", "image/tiff"];
const MAX_MB = 50;

function kindOf(file: File): SourceFile["kind"] {
  const n = file.name.toLowerCase();
  if (file.type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  // Browsers cannot display TIFF/BMP inline reliably; treat TIFF as non-previewable.
  if (file.type === "image/tiff" || n.endsWith(".tif") || n.endsWith(".tiff")) return "other";
  if (file.type.startsWith("image/")) return "image";
  return "other";
}

/** Upload a PDF/image (or pick a built-in sample) and run it through the saved OCR provider (MinerU / Indra). */
export function OcrTestPanel() {
  const isMobile = useIsMobile();
  const samples = useQuery({
    queryKey: qk.ocrSamples,
    queryFn: () => api.get<{ samples: SampleFile[] }>("/admin/api/ocr/samples"),
    staleTime: 5 * 60_000,
  });
  const [source, setSource] = useState<SourceFile | null>(null);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [result, setResult] = useState<OcrTestResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const now = useNow(running ? 500 : 60_000);

  // Release object URLs when the source changes / on unmount.
  useEffect(() => {
    const url = source?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [source]);
  useEffect(() => () => ctrl.current?.abort(), []);

  const choose = (file: File, origin: SourceFile["origin"]) => {
    setDropError(null);
    setResult(null);
    setRunError(null);
    setElapsedMs(null);
    setSource({ file, url: URL.createObjectURL(file), kind: kindOf(file), origin });
  };

  const loadSample = async (s: SampleFile) => {
    setLoadingSample(s.id);
    try {
      const res = await fetch(`/admin/api/ocr/samples/${encodeURIComponent(s.id)}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`無法取得範例檔（HTTP ${res.status}）`);
      const blob = await res.blob();
      choose(new File([blob], s.filename, { type: s.mimeType }), "sample");
    } catch (e) {
      setDropError(errorMessage(e));
    } finally {
      setLoadingSample(null);
    }
  };

  const run = async () => {
    if (!source) return;
    ctrl.current?.abort();
    ctrl.current = new AbortController();
    const fd = new FormData();
    fd.append("file", source.file);
    fd.append("filename", source.file.name);
    setRunning(true);
    setResult(null);
    setRunError(null);
    const t0 = Date.now();
    setStartedAt(t0);
    try {
      const r = await request<OcrTestResult>("/admin/api/ocr/test", { method: "POST", rawBody: fd, signal: ctrl.current.signal });
      setResult(r);
    } catch (e) {
      if (ctrl.current.signal.aborted) setRunError("已取消。（伺服器端的 OCR 可能仍會跑完，但結果不會顯示）");
      else setRunError(errorMessage(e));
    } finally {
      setElapsedMs(Date.now() - t0);
      setRunning(false);
    }
  };

  const liveElapsed = running && startedAt ? now - startedAt : elapsedMs;

  return (
    <Stack gap="lg">
      <Alert color="blue" variant="light" icon={<IconScan size={18} />}>
        將 PDF 或圖片送到目前<Text span fw={600}>已儲存</Text>的 OCR 伺服器設定，檢視 OCR（MinerU 或 Indra，依已儲存的供應者；主要供應者失敗時可能由備援接手）輸出的 Markdown。若已設定「分析 LLM」，
        伺服器也會順便對結果跑一次分析（會呼叫 LLM、消耗 token），分析結果顯示在「分析 JSON」分頁。
      </Alert>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Stack gap="xs">
          <Text fw={600} fz="sm">
            1. 選擇內建範例
          </Text>
          {samples.isPending ? (
            <Stack gap={6}>
              <Skeleton h={52} radius="md" />
              <Skeleton h={52} radius="md" />
            </Stack>
          ) : samples.isError ? (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} p="sm">
              <Group justify="space-between" gap="xs" wrap="wrap">
                <Text fz="sm">範例清單載入失敗：{errorMessage(samples.error)}</Text>
                <Button size="xs" variant="light" onClick={() => void samples.refetch()}>
                  重試
                </Button>
              </Group>
            </Alert>
          ) : (samples.data?.samples ?? []).length === 0 ? (
            <Card padding="md">
              <Text fz="sm" c="dimmed">
                伺服器上沒有內建範例檔（node-server/public/samples/）。請改用右側上傳自己的檔案。
              </Text>
            </Card>
          ) : (
            <ScrollArea.Autosize mah={220} type="auto">
              <Stack gap={6}>
                {(samples.data?.samples ?? []).map((s) => {
                  const active = source?.origin === "sample" && source.file.name === s.filename;
                  return (
                    <UnstyledButton
                      key={s.id}
                      onClick={() => void loadSample(s)}
                      disabled={running || loadingSample !== null}
                      style={{
                        border: `1px solid ${active ? "var(--mantine-primary-color-filled)" : "var(--mantine-color-default-border)"}`,
                        borderRadius: "var(--mantine-radius-md)",
                        padding: "8px 12px",
                        background: active ? "var(--mantine-primary-color-light)" : undefined,
                      }}
                    >
                      <Group gap="sm" wrap="nowrap">
                        <ThemeIcon variant="light" color={s.type === "pdf" ? "red" : "blue"} size={32}>
                          {s.type === "pdf" ? <IconFileTypePdf size={18} /> : <IconPhoto size={18} />}
                        </ThemeIcon>
                        <Box style={{ minWidth: 0, flex: 1 }}>
                          <Text fz="sm" fw={600} truncate="end">
                            {s.name}
                          </Text>
                          <Text fz="xs" c="dimmed" truncate="end">
                            {s.filename} · {fmtBytes(s.sizeBytes ?? null)}
                          </Text>
                        </Box>
                        {loadingSample === s.id ? <Loader size="xs" /> : active ? <IconCheck size={16} color="var(--mantine-primary-color-filled)" /> : null}
                      </Group>
                    </UnstyledButton>
                  );
                })}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Stack>

        <Stack gap="xs">
          <Text fw={600} fz="sm">
            或 2. 上傳自己的檔案
          </Text>
          <Dropzone
            onDrop={(files) => files[0] && choose(files[0], "upload")}
            onReject={(rej) => {
              const code = rej[0]?.errors[0]?.code;
              setDropError(code === "file-too-large" ? `檔案超過 ${MAX_MB} MB 上限` : "僅支援 PDF 或圖片（PNG、JPEG、GIF、BMP、WebP、TIFF）");
            }}
            accept={ACCEPT}
            maxSize={MAX_MB * 1024 * 1024}
            multiple={false}
            disabled={running}
            radius="md"
            p="lg"
            styles={{ root: { borderStyle: "dashed", borderWidth: 1.5 } }}
          >
            <Stack align="center" gap={6} style={{ pointerEvents: "none" }} ta="center">
              <Dropzone.Accept>
                <IconUpload size={28} color="var(--mantine-primary-color-filled)" />
              </Dropzone.Accept>
              <Dropzone.Reject>
                <IconX size={28} color="var(--mantine-color-red-6)" />
              </Dropzone.Reject>
              <Dropzone.Idle>
                <ThemeIcon variant="light" size={44} radius="xl">
                  <IconUpload size={22} />
                </ThemeIcon>
              </Dropzone.Idle>
              <Text fw={600} fz="sm">
                拖曳 PDF 或圖片到這裡，或點擊選擇
              </Text>
              <Text fz="xs" c="dimmed">
                檔案只會送往 OCR 伺服器做測試，不會存入系統 · 上限 {MAX_MB} MB
              </Text>
            </Stack>
          </Dropzone>
          {dropError && (
            <Text fz="xs" c="red">
              {dropError}
            </Text>
          )}
        </Stack>
      </SimpleGrid>

      {source && (
        <Card padding="md">
          <Group justify="space-between" gap="sm" wrap="wrap">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: "1 1 240px" }}>
              <ThemeIcon variant="light" color={source.kind === "pdf" ? "red" : "blue"} size={36}>
                {source.kind === "pdf" ? <IconFileTypePdf size={20} /> : <IconPhoto size={20} />}
              </ThemeIcon>
              <Box style={{ minWidth: 0 }}>
                <Text fz="sm" fw={600} truncate="end">
                  {source.file.name}
                </Text>
                <Text fz="xs" c="dimmed">
                  {fmtBytes(source.file.size)} · {source.origin === "sample" ? "內建範例" : "上傳檔案"}
                </Text>
              </Box>
            </Group>
            <Group gap="xs" wrap="wrap">
              {running && liveElapsed !== null && (
                <Badge variant="light" color="blue" leftSection={<IconClock size={12} />}>
                  已執行 {fmtDuration(liveElapsed / 1000)}
                </Badge>
              )}
              {running ? (
                <Button variant="default" color="gray" leftSection={<IconPlayerStop size={16} />} onClick={() => ctrl.current?.abort()}>
                  取消
                </Button>
              ) : (
                <Button leftSection={<IconPlayerPlay size={16} />} onClick={() => void run()}>
                  {result || runError ? "重新執行 OCR" : "執行 OCR"}
                </Button>
              )}
            </Group>
          </Group>
        </Card>
      )}

      {source && (
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
          <Card padding={0}>
            <Group px="md" py="sm" justify="space-between">
              <Text fw={600} fz="sm">
                原始檔預覽
              </Text>
            </Group>
            <Box h={isMobile ? 420 : 720} style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
              {source.kind === "pdf" ? (
                <iframe src={source.url} title="PDF 預覽" style={{ width: "100%", height: "100%", border: 0, display: "block" }} />
              ) : source.kind === "image" ? (
                <ScrollArea h="100%" p="sm">
                  <img src={source.url} alt={source.file.name} style={{ maxWidth: "100%", display: "block", margin: "0 auto" }} />
                </ScrollArea>
              ) : (
                <EmptyState compact icon={<IconPhoto size={20} />} title="瀏覽器無法預覽此格式" description="TIFF 等格式仍可送去 OCR，只是無法在這裡顯示原圖。" />
              )}
            </Box>
          </Card>

          <ResultCard running={running} result={result} error={runError} elapsedMs={elapsedMs} height={isMobile ? 520 : 720} fileName={source.file.name} />
        </SimpleGrid>
      )}
    </Stack>
  );
}

function ResultCard({
  running,
  result,
  error,
  elapsedMs,
  height,
  fileName,
}: {
  running: boolean;
  result: OcrTestResult | null;
  error: string | null;
  elapsedMs: number | null;
  height: number;
  fileName: string;
}) {
  const [tab, setTab] = useState<string | null>("rendered");

  const download = () => {
    if (!result) return;
    const blob = new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName.replace(/\.[^.]+$/, "")}.ocr.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Card padding={0}>
      <Group px="md" py="sm" justify="space-between" gap="xs" wrap="wrap">
        <Text fw={600} fz="sm">
          OCR 結果
        </Text>
        {result && (
          <Group gap={6} wrap="wrap">
            <Badge variant="light" color="teal" leftSection={<IconClock size={12} />}>
              {elapsedMs !== null ? fmtDuration(elapsedMs / 1000) : "—"}
            </Badge>
            <Badge variant="light" color="gray" tt="none">
              {result.markdown.length.toLocaleString("zh-TW")} 字元
            </Badge>
            <Badge variant="light" color="gray" tt="none">
              OCR：{result.ocrProvider || "—"}
            </Badge>
            <CopyButton value={result.markdown} timeout={1500}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? "已複製" : "複製 Markdown"}>
                  <Button size="compact-xs" variant="default" onClick={copy} leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}>
                    複製
                  </Button>
                </Tooltip>
              )}
            </CopyButton>
            <Button size="compact-xs" variant="default" onClick={download} leftSection={<IconDownload size={12} />}>
              下載 .md
            </Button>
          </Group>
        )}
      </Group>
      <Box h={height} style={{ borderTop: "1px solid var(--mantine-color-default-border)", display: "flex", flexDirection: "column" }}>
        {running ? (
          <Stack align="center" justify="center" h="100%" gap="sm" p="lg" ta="center">
            <Loader />
            <Text fz="sm" fw={600}>
              OCR 處理中…
            </Text>
            <Text fz="xs" c="dimmed" maw={340}>
              一般仿單數秒到數十秒即可完成；大型或掃描檔可能需要數分鐘（上限為 OCR 設定中的逾時秒數）。
            </Text>
          </Stack>
        ) : error ? (
          <Box p="md">
            <Alert color="red" icon={<IconAlertTriangle size={18} />} title="OCR 失敗">
              <Text fz="sm" style={{ wordBreak: "break-word" }}>
                {error}
              </Text>
              <Text fz="xs" c="dimmed" mt={6}>
                請確認上方 OCR 伺服器設定已儲存，並先按「測試連線」確認所選的供應者（MinerU / Indra）可連線。
              </Text>
            </Alert>
          </Box>
        ) : !result ? (
          <EmptyState compact icon={<IconScan size={20} />} title="尚未執行" description="按「執行 OCR」開始。" />
        ) : (
          <Tabs value={tab} onChange={setTab} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            <Tabs.List px="sm">
              <Tabs.Tab value="rendered">預覽</Tabs.Tab>
              <Tabs.Tab value="raw">原始 Markdown</Tabs.Tab>
              <Tabs.Tab value="analysis" disabled={!result.analysisConfigured}>
                分析 JSON
              </Tabs.Tab>
            </Tabs.List>
            <Box style={{ flex: 1, minHeight: 0 }}>
              <Tabs.Panel value="rendered" h="100%">
                <ScrollArea h="100%" p="md">
                  {result.markdown.trim() ? (
                    <OcrMarkdown content={result.markdown} />
                  ) : (
                    <EmptyState compact title="OCR 沒有輸出任何文字" description="檔案可能是空白頁或無法辨識的影像。試試把解析方式改為 ocr。" />
                  )}
                </ScrollArea>
              </Tabs.Panel>
              <Tabs.Panel value="raw" h="100%">
                <ScrollArea h="100%" p="md">
                  <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {result.markdown.replace(/\(data:image\/[^)]{80,}\)/g, "(data:image/…內嵌圖片…)")}
                  </Code>
                </ScrollArea>
              </Tabs.Panel>
              <Tabs.Panel value="analysis" h="100%">
                <ScrollArea h="100%" p="md">
                  {result.analysis ? (
                    <Stack gap="sm">
                      {typeof result.analysis.error === "string" ? (
                        <Alert color="amber" icon={<IconAlertTriangle size={16} />} title="OCR 成功，但分析 LLM 失敗">
                          {result.analysis.error}
                        </Alert>
                      ) : (
                        <Text fz="xs" c="dimmed">
                          由 {result.analysisProvider ?? "分析 LLM"} 產生。機器產生的內容，須由臨床人員確認。
                        </Text>
                      )}
                      <JsonView value={result.analysis} />
                    </Stack>
                  ) : (
                    <EmptyState compact title="沒有分析結果" description="尚未設定分析 LLM，因此只執行了 OCR。" />
                  )}
                </ScrollArea>
              </Tabs.Panel>
            </Box>
          </Tabs>
        )}
      </Box>
    </Card>
  );
}

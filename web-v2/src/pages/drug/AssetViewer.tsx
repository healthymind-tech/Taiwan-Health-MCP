// Inline viewers for drug assets served by /admin/api/drug/asset-content:
// PDF (iframe), OCR markdown, analysis JSON, and an image lightbox. Staging
// object storage holds files for only a subset of licenses, so every viewer
// probes first and shows a friendly "missing" state instead of a broken frame.

import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Center,
  Group,
  Image,
  Loader,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { IconChevronLeft, IconChevronRight, IconCloudOff, IconDownload, IconExternalLink } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { JsonView } from "@/components/JsonView";
import { ApiError } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { assetContentUrl } from "./drugMeta";
import classes from "./drug.module.css";

export type ViewerKind = "pdf" | "markdown" | "json" | "text";

export interface ViewerTarget {
  assetId: string;
  kind: ViewerKind;
  title: string;
  subtitle?: string;
  sourceUrl?: string | null;
}

/** A missing object surfaces as 404 (no object_key) or 500 (MinIO GET failed). */
export class AssetMissingError extends Error {}

async function fetchAsset(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError("無法連線到伺服器", 0);
  }
  if (res.status === 404) throw new AssetMissingError("not found");
  if (res.status === 500) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    if (body?.error === "Failed to load asset content") throw new AssetMissingError("storage miss");
    throw new ApiError(body?.error ?? "讀取檔案失敗", 500);
  }
  if (!res.ok && res.status !== 206) throw new ApiError(`讀取檔案失敗（HTTP ${res.status}）`, res.status);
  return res;
}

/** Cheap existence probe: a 1-byte range read (PDFs honour Range). */
export function useAssetProbe(assetId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["drug", "asset-probe", assetId],
    queryFn: async () => {
      const res = await fetchAsset(assetContentUrl(assetId ?? ""), { headers: { Range: "bytes=0-0" } });
      await res.arrayBuffer().catch(() => undefined);
      return true;
    },
    enabled: Boolean(assetId) && enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function MissingAsset({ compact }: { compact?: boolean }) {
  return (
    <EmptyState
      compact={compact}
      icon={<IconCloudOff size={compact ? 20 : 26} />}
      title="檔案不存在於物件儲存"
      description="資料庫有這個檔案的紀錄，但物件儲存（MinIO）中找不到對應內容。重新執行此許可證的管線即可重新下載。"
    />
  );
}

function ViewerBody({ target }: { target: ViewerTarget }) {
  const url = assetContentUrl(target.assetId);
  const isMobile = useIsMobile();
  const probe = useAssetProbe(target.kind === "pdf" ? target.assetId : null);
  const text = useQuery({
    queryKey: ["drug", "asset-text", target.assetId],
    queryFn: async () => (await fetchAsset(url)).text(),
    enabled: target.kind !== "pdf",
    retry: false,
    staleTime: 5 * 60_000,
  });
  const [mode, setMode] = useState<"rendered" | "source">("rendered");

  if (target.kind === "pdf") {
    if (probe.isPending) return <Center h={300}><Loader /></Center>;
    if (probe.isError) return probe.error instanceof AssetMissingError ? <MissingAsset /> : <ErrorState error={probe.error} onRetry={() => void probe.refetch()} />;
    return (
      <Box style={{ height: isMobile ? "calc(100dvh - 140px)" : "78vh", borderRadius: 8, overflow: "hidden", border: "1px solid var(--mantine-color-default-border)" }}>
        <iframe src={url} title={target.title} style={{ width: "100%", height: "100%", border: 0, background: "white" }} />
      </Box>
    );
  }

  if (text.isPending) return <Center h={240}><Loader /></Center>;
  if (text.isError) return text.error instanceof AssetMissingError ? <MissingAsset /> : <ErrorState error={text.error} onRetry={() => void text.refetch()} />;

  const body = text.data;
  if (!body.trim()) return <EmptyState compact title="檔案是空的" />;

  if (target.kind === "json") {
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* show raw text */
    }
    return <JsonView value={parsed} maxHeight={isMobile ? 2000 : 640} />;
  }
  if (target.kind === "markdown") {
    return (
      <Stack gap="sm">
        <SegmentedControl
          size="xs"
          w="fit-content"
          value={mode}
          onChange={(v) => setMode(v as "rendered" | "source")}
          data={[
            { value: "rendered", label: "排版檢視" },
            { value: "source", label: "原始 Markdown" },
          ]}
        />
        {mode === "rendered" ? <Markdown>{body}</Markdown> : <JsonView value={body} maxHeight={640} />}
      </Stack>
    );
  }
  return <JsonView value={body} maxHeight={640} />;
}

export function Markdown({ children }: { children: string }) {
  return (
    <Box className={classes.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children: c }) => (
            <div className={classes.tableWrap}>
              <table>{c}</table>
            </div>
          ),
          // OCR output may reference images by relative path that are not served; drop them.
          img: ({ alt }) => (alt ? <Text span c="dimmed" fz="xs">[圖片：{alt}]</Text> : null),
          a: ({ href, children: c }) => (
            <Anchor href={href} target="_blank" rel="noreferrer noopener">
              {c}
            </Anchor>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}

export function AssetViewerModal({ target, onClose }: { target: ViewerTarget | null; onClose: () => void }) {
  const isMobile = useIsMobile();
  return (
    <Modal
      opened={target !== null}
      onClose={onClose}
      size={target?.kind === "pdf" ? "90%" : "xl"}
      fullScreen={isMobile}
      title={
        target && (
          <Box style={{ minWidth: 0 }}>
            <Text fw={650} fz="md" style={{ wordBreak: "break-all" }}>
              {target.title}
            </Text>
            {target.subtitle && (
              <Text fz="xs" c="dimmed">
                {target.subtitle}
              </Text>
            )}
          </Box>
        )
      }
      styles={{ title: { flex: 1, minWidth: 0 } }}
    >
      {target && (
        <Stack gap="sm">
          <Group gap="xs" wrap="wrap">
            <Button component="a" href={assetContentUrl(target.assetId, { download: true })} size="xs" variant="default" leftSection={<IconDownload size={14} />}>
              下載
            </Button>
            <Button component="a" href={assetContentUrl(target.assetId)} target="_blank" rel="noreferrer" size="xs" variant="default" leftSection={<IconExternalLink size={14} />}>
              在新分頁開啟
            </Button>
            {target.sourceUrl && (
              <Button component="a" href={target.sourceUrl} target="_blank" rel="noreferrer noopener" size="xs" variant="subtle" leftSection={<IconExternalLink size={14} />}>
                TFDA 原始來源
              </Button>
            )}
          </Group>
          <ViewerBody target={target} />
        </Stack>
      )}
    </Modal>
  );
}

// ── Image lightbox ───────────────────────────────────────────────────────────

export interface LightboxImage {
  src: string;
  original: string;
  assetId: string;
  caption?: ReactNode;
  filename?: string | null;
  size?: number | null;
}

function LightboxImg({ img }: { img: LightboxImage }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  useEffect(() => setState("loading"), [img.src]);
  return (
    <Center mih={280} pos="relative">
      {state === "loading" && (
        <Center pos="absolute" inset={0}>
          <Loader />
        </Center>
      )}
      {state === "error" ? (
        <MissingAsset />
      ) : (
        <Image
          src={img.src}
          alt={img.filename ?? "藥品圖片"}
          fit="contain"
          mah="70vh"
          w="auto"
          maw="100%"
          radius="md"
          onLoad={() => setState("ok")}
          onError={() => setState("error")}
          style={{ visibility: state === "ok" ? "visible" : "hidden", background: "white" }}
        />
      )}
    </Center>
  );
}

export function Lightbox({ images, index, onIndex, onClose }: { images: LightboxImage[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const isMobile = useIsMobile();
  const open = index !== null && images.length > 0;
  const i = index ?? 0;
  const img = images[i];
  const prev = () => onIndex((i - 1 + images.length) % images.length);
  const next = () => onIndex((i + 1) % images.length);
  useHotkeys(open && images.length > 1 ? [["ArrowLeft", prev], ["ArrowRight", next]] : []);

  return (
    <Modal
      opened={open}
      onClose={onClose}
      size="xl"
      fullScreen={isMobile}
      title={
        <Text fw={650} fz="md">
          圖片 {images.length > 1 ? `${i + 1} / ${images.length}` : ""}
        </Text>
      }
    >
      {img && (
        <Stack gap="sm">
          <Group justify="center" gap="xs" wrap="nowrap">
            {images.length > 1 && (
              <Tooltip label="上一張（←）">
                <ActionIcon variant="default" size="lg" radius="xl" onClick={prev} aria-label="上一張">
                  <IconChevronLeft size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            <Box style={{ flex: 1, minWidth: 0 }}>
              <LightboxImg img={img} />
            </Box>
            {images.length > 1 && (
              <Tooltip label="下一張（→）">
                <ActionIcon variant="default" size="lg" radius="xl" onClick={next} aria-label="下一張">
                  <IconChevronRight size={18} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
          {img.caption && <Box fz="sm">{img.caption}</Box>}
          <Group justify="space-between" gap="xs" wrap="wrap">
            <Text fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
              {img.filename ?? ""} {img.size ? `· ${fmtBytes(img.size)}` : ""}
            </Text>
            <Group gap="xs">
              <Button component="a" href={img.original} target="_blank" rel="noreferrer" size="xs" variant="default" leftSection={<IconExternalLink size={14} />}>
                原始圖檔
              </Button>
              <Button component="a" href={assetContentUrl(img.assetId, { download: true })} size="xs" variant="default" leftSection={<IconDownload size={14} />}>
                下載
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

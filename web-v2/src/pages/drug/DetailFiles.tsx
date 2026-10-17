// 文件與圖片 tab: insert/label PDFs with their OCR + analysis outputs, an image
// gallery, and the full asset inventory.

import { ActionIcon, Anchor, Badge, Box, Button, Card, Group, Menu, SimpleGrid, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconDots, IconDownload, IconExternalLink, IconEye, IconFileTypePdf, IconFiles, IconPhoto } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { SectionCard } from "@/components/SectionCard";
import { api, qs } from "@/lib/api";
import { fmtBytes, fmtDate } from "@/lib/format";
import { qk } from "@/lib/queryKeys";
import type { DrugAsset, DrugAssetsPayload } from "@/lib/types";
import { Lightbox, type LightboxImage, type ViewerKind, type ViewerTarget } from "./AssetViewer";
import { assetContentUrl, assetTypeLabel } from "./drugMeta";
import type { ExplorerDetail, ExplorerDocument } from "./drugTypes";
import { DrugStatusBadge, DrugThumb } from "./drugUi";
import classes from "./drug.module.css";

function viewerKind(mime: string | null | undefined, type: string, name: string | null | undefined): ViewerKind | "image" | null {
  const m = String(mime ?? "").toLowerCase();
  const n = String(name ?? "").toLowerCase();
  if (type === "shape_image" || m.startsWith("image/")) return "image";
  if (m === "application/pdf" || n.endsWith(".pdf") || type.endsWith("_pdf")) return "pdf";
  if (type === "ocr_markdown" || m.includes("markdown") || n.endsWith(".md")) return "markdown";
  if (type === "analysis_json" || m.includes("json") || n.endsWith(".json")) return "json";
  if (m.startsWith("text/")) return "text";
  return null;
}

export function DetailFiles({ licenseId, detail, onView }: { licenseId: string; detail: ExplorerDetail; onView: (t: ViewerTarget) => void }) {
  const assetsQ = useQuery({
    queryKey: qk.drugAssets(licenseId),
    queryFn: () => api.get<DrugAssetsPayload>(`/admin/api/drug/assets${qs({ license_id: licenseId })}`),
  });

  // Gallery: appearance images (with web previews) first, then any other stored shape images.
  const images: LightboxImage[] = useMemo(() => {
    const out: LightboxImage[] = detail.appearances.flatMap((a) =>
      a.images.map((im) => ({
        src: im.preview_url,
        original: im.original_url,
        assetId: im.asset_id,
        filename: im.filename,
        caption: [a.color, a.shape, a.imprint ? `刻字 ${a.imprint}` : ""].filter(Boolean).join(" · ") || undefined,
      })),
    );
    const seen = new Set(out.map((x) => x.assetId));
    for (const a of detail.assets) {
      if (a.asset_type !== "shape_image" || a.storage_status !== "success" || seen.has(a.asset_id)) continue;
      out.push({ src: assetContentUrl(a.asset_id), original: assetContentUrl(a.asset_id), assetId: a.asset_id, filename: a.source_filename, size: Number(a.size_bytes ?? 0) || null });
    }
    return out;
  }, [detail]);
  const [lb, setLb] = useState<number | null>(null);

  const openAsset = (a: { asset_id: string; asset_type: string; mime_type?: string | null; source_filename?: string | null; normalized_filename?: string | null; source_url?: string | null; upload_date?: string | null }) => {
    const kind = viewerKind(a.mime_type, a.asset_type, a.source_filename ?? a.normalized_filename);
    if (kind === "image") {
      const idx = images.findIndex((x) => x.assetId === a.asset_id);
      if (idx >= 0) setLb(idx);
      else window.open(assetContentUrl(a.asset_id), "_blank", "noopener");
      return;
    }
    if (!kind) {
      window.open(assetContentUrl(a.asset_id, { download: true }), "_self");
      return;
    }
    onView({
      assetId: a.asset_id,
      kind,
      title: a.source_filename || a.normalized_filename || assetTypeLabel(a.asset_type),
      subtitle: `${assetTypeLabel(a.asset_type)}${a.upload_date ? ` · ${fmtDate(a.upload_date)}` : ""}`,
      sourceUrl: a.source_url,
    });
  };

  const assets = assetsQ.data?.assets ?? [];
  const columns: Column<DrugAsset>[] = [
    {
      key: "name",
      header: "檔案",
      primary: true,
      render: (a) => (
        <Box style={{ minWidth: 0 }}>
          <Text fz="sm" fw={600} style={{ wordBreak: "break-all" }}>
            {a.source_filename || a.normalized_filename || "（未命名）"}
          </Text>
          <Text fz="xs" c="dimmed">
            {a.asset_group || "—"}
          </Text>
        </Box>
      ),
      sortValue: (a) => a.source_filename,
    },
    { key: "type", header: "類型", nowrap: true, render: (a) => <Badge variant="light" color="gray" style={{ textTransform: "none" }}>{assetTypeLabel(a.asset_type)}</Badge>, sortValue: (a) => a.asset_type },
    { key: "size", header: "大小", align: "right", nowrap: true, hideOnMobile: true, render: (a) => <Text fz="sm">{fmtBytes(a.size_bytes)}</Text>, sortValue: (a) => a.size_bytes ?? 0 },
    { key: "date", header: "上傳日", nowrap: true, hideOnMobile: true, render: (a) => <Text fz="sm">{fmtDate(a.upload_date)}</Text>, sortValue: (a) => a.upload_date ?? "" },
    {
      key: "status",
      header: "儲存",
      nowrap: true,
      render: (a) => (
        <Tooltip label={`下載：${a.download_status || "—"}`}>
          <Box>
            <DrugStatusBadge status={a.storage_status} size="xs" />
          </Box>
        </Tooltip>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (a) => (
        <Group gap={4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
          <Tooltip label={a.storage_status === "success" ? "檢視" : "檔案尚未存入物件儲存"}>
            <ActionIcon variant="subtle" aria-label="檢視" disabled={a.storage_status !== "success"} onClick={() => openAsset(a)}>
              <IconEye size={16} />
            </ActionIcon>
          </Tooltip>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label="更多">
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item component="a" href={assetContentUrl(a.asset_id, { download: true })} leftSection={<IconDownload size={14} />} disabled={a.storage_status !== "success"}>
                下載
              </Menu.Item>
              {a.source_url && (
                <Menu.Item component="a" href={a.source_url} target="_blank" rel="noreferrer noopener" leftSection={<IconExternalLink size={14} />}>
                  TFDA 原始來源
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
      ),
    },
  ];

  return (
    <Stack gap="md">
      <SectionCard title="仿單與外盒文件" icon={<IconFileTypePdf size={18} />} description="每份 PDF 及其 OCR 文字與 LLM 分析輸出。">
        {detail.documents.length === 0 ? (
          <EmptyState compact icon={<IconFileTypePdf size={22} />} title="沒有 PDF 文件" description="尚未從 TFDA 下載到仿單或外盒 PDF，或這張許可證沒有提供。" />
        ) : (
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
            {detail.documents.map((doc) => (
              <DocumentCard key={doc.source_asset_id} doc={doc} onView={onView} />
            ))}
          </SimpleGrid>
        )}
      </SectionCard>

      <SectionCard title="圖片" icon={<IconPhoto size={18} />} description={images.length ? `${images.length} 張，點擊放大` : undefined}>
        {images.length === 0 ? (
          <EmptyState compact icon={<IconPhoto size={22} />} title="沒有圖片" description="尚未擷取到藥品外觀圖片。" />
        ) : (
          <Group gap="sm">
            {images.map((im, i) => (
              <UnstyledButton key={im.assetId} className={classes.thumbButton} onClick={() => setLb(i)} aria-label={`放大第 ${i + 1} 張圖片`}>
                <DrugThumb src={im.src} alt={im.filename ?? "藥品圖片"} size={112} />
              </UnstyledButton>
            ))}
          </Group>
        )}
      </SectionCard>

      <SectionCard title="所有檔案" icon={<IconFiles size={18} />} flush description="資料庫記錄的所有檔案；狀態非「完成」的檔案尚未存入物件儲存。">
        {assetsQ.isError ? (
          <ErrorState error={assetsQ.error} onRetry={() => void assetsQ.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={assets}
            rowKey={(a) => a.asset_id}
            loading={assetsQ.isPending}
            pageSize={15}
            minWidth={720}
            onRowClick={(a) => a.storage_status === "success" && openAsset(a)}
            empty={<EmptyState compact title="沒有任何檔案" description="執行管線後，爬取到的仿單、圖片與分析結果會列在這裡。" />}
          />
        )}
      </SectionCard>

      <Lightbox images={images} index={lb} onIndex={setLb} onClose={() => setLb(null)} />
    </Stack>
  );
}

function DocumentCard({ doc, onView }: { doc: ExplorerDocument; onView: (t: ViewerTarget) => void }) {
  const stored = doc.storage_status === "success";
  const name = doc.source_filename || doc.normalized_filename || assetTypeLabel(doc.asset_type);
  return (
    <Card withBorder padding="md" radius="md">
      <Stack gap="xs">
        <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <IconFileTypePdf size={28} color="var(--mantine-color-red-filled)" style={{ flexShrink: 0 }} />
            <Box style={{ minWidth: 0 }}>
              <Text fz="sm" fw={600} style={{ wordBreak: "break-all" }}>
                {name}
              </Text>
              <Text fz="xs" c="dimmed">
                {assetTypeLabel(doc.asset_type)} · {fmtDate(doc.upload_date)} · {fmtBytes(Number(doc.size_bytes ?? 0) || null)}
              </Text>
            </Box>
          </Group>
          <DrugStatusBadge status={doc.storage_status} size="xs" />
        </Group>
        {doc.asset_type === "insert_pdf" && (
          <Group gap="xs" wrap="wrap">
            <Text fz="xs" c="dimmed">
              OCR
            </Text>
            <DrugStatusBadge status={doc.ocr_status ?? "pending"} size="xs" />
            <Text fz="xs" c="dimmed" ml={4}>
              LLM 分析
            </Text>
            <DrugStatusBadge status={doc.analysis_status ?? "pending"} size="xs" />
          </Group>
        )}
        <Group gap={6} wrap="wrap">
          <Tooltip label="檔案尚未存入物件儲存" disabled={stored}>
            <Button
              size="xs"
              leftSection={<IconEye size={14} />}
              disabled={!stored}
              onClick={() => onView({ assetId: doc.source_asset_id, kind: "pdf", title: name, subtitle: `${assetTypeLabel(doc.asset_type)} · ${fmtDate(doc.upload_date)}`, sourceUrl: doc.source_url })}
            >
              檢視 PDF
            </Button>
          </Tooltip>
          {doc.ocr_asset_id && (
            <Button size="xs" variant="default" onClick={() => onView({ assetId: doc.ocr_asset_id ?? "", kind: "markdown", title: doc.ocr_filename || "OCR 文字", subtitle: `OCR 結果 · ${name}` })}>
              OCR 文字
            </Button>
          )}
          {doc.analysis_asset_id && (
            <Button size="xs" variant="default" onClick={() => onView({ assetId: doc.analysis_asset_id ?? "", kind: "json", title: doc.analysis_filename || "分析 JSON", subtitle: `LLM 分析輸出 · ${name}` })}>
              分析 JSON
            </Button>
          )}
          {stored && (
            <Tooltip label="下載 PDF">
              <ActionIcon component="a" href={assetContentUrl(doc.source_asset_id, { download: true })} variant="default" size="md" aria-label="下載 PDF">
                <IconDownload size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          {doc.source_url && (
            <Anchor href={doc.source_url} target="_blank" rel="noreferrer noopener" fz="xs" ml="auto">
              TFDA 來源 <IconExternalLink size={11} style={{ verticalAlign: "-1px" }} />
            </Anchor>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

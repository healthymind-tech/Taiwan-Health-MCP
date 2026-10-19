// 結構化分析 tab: the insert sections chosen by the record builder (LLM
// analysis when a PDF was analysed, else the electronic insert), rendered as
// nested readable sections with a raw-JSON escape hatch.

import { Alert, Badge, Button, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { IconFileText, IconInfoCircle } from "@tabler/icons-react";
import { useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { JsonView } from "@/components/JsonView";
import { SectionCard } from "@/components/SectionCard";
import { fmtDateTime } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { Markdown } from "./AssetViewer";
import { ValueView } from "./StructuredView";
import { asDict, asText, isEmptyValue, type ExplorerDetail } from "./drugTypes";

const SOURCE: Record<string, { label: string; color: string; help: string }> = {
  pdf_insert: { label: "仿單 PDF · LLM 分析", color: "indigo", help: "由 OCR（MinerU 或 Indra）讀取仿單 PDF，再由 Analysis LM 整理為結構化欄位。" },
  electronic_insert: { label: "TFDA 電子仿單", color: "teal", help: "取自 TFDA 網站的電子仿單（HTML），未經 LLM 分析。" },
  index_only: { label: "僅許可證索引", color: "gray", help: "尚未取得仿單內容。" },
};

type Mode = "readable" | "sections" | "record";

export function DetailAnalysis({ detail, onOpenOcr, onOpenAnalysisJson }: { detail: ExplorerDetail; onOpenOcr: (assetId: string) => void; onOpenAnalysisJson: (assetId: string) => void }) {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState<Mode>("readable");
  const record = asDict(detail.drug.normalized_record);
  const source = asDict(record.source);
  const content = asDict(record.insert_content);
  const sections = content.full_structured_sections;
  const characteristics = asText(content.drug_characteristics);
  const srcKey = asText(source.primary_insert_source) || "index_only";
  const meta = SOURCE[srcKey] ?? SOURCE.index_only;
  const analysedDoc = detail.documents.find((doc) => doc.analysis_asset_id) ?? null;
  const ocrDoc = detail.documents.find((doc) => doc.ocr_asset_id) ?? null;

  if (Object.keys(record).length === 0) {
    return (
      <SectionCard>
        <EmptyState
          icon={<IconFileText size={26} />}
          title="尚無結構化分析"
          description="這張許可證還沒有正規化紀錄。執行藥品管線後，系統會爬取仿單、OCR 並由 LLM 整理成結構化資料。"
        />
      </SectionCard>
    );
  }

  return (
    <Stack gap="md">
      <SectionCard
        title="仿單內容"
        description={meta.help}
        actions={
          <Group gap="xs" wrap="wrap">
            <Badge color={meta.color} variant="light" size="lg" style={{ textTransform: "none" }}>
              {meta.label}
            </Badge>
          </Group>
        }
      >
        <Stack gap="md">
          <Group justify="space-between" gap="sm" wrap="wrap">
            <SegmentedControl
              size="xs"
              value={mode}
              onChange={(v) => setMode(v as Mode)}
              data={[
                { value: "readable", label: "易讀檢視" },
                { value: "sections", label: isMobile ? "區段 JSON" : "仿單區段 JSON" },
                { value: "record", label: isMobile ? "完整 JSON" : "完整正規化紀錄 JSON" },
              ]}
            />
            <Group gap="xs" wrap="wrap">
              {ocrDoc?.ocr_asset_id && (
                <Button size="xs" variant="default" onClick={() => onOpenOcr(ocrDoc.ocr_asset_id ?? "")}>
                  檢視 OCR 文字
                </Button>
              )}
              {analysedDoc?.analysis_asset_id && (
                <Button size="xs" variant="default" onClick={() => onOpenAnalysisJson(analysedDoc.analysis_asset_id ?? "")}>
                  原始 LLM 輸出
                </Button>
              )}
            </Group>
          </Group>

          {analysedDoc?.completed_at && (
            <Text fz="xs" c="dimmed">
              分析完成於 {fmtDateTime(analysedDoc.completed_at)} · 來源檔 {analysedDoc.source_filename ?? "—"}
            </Text>
          )}

          {srcKey === "pdf_insert" && (
            <Alert color="amber" variant="light" icon={<IconInfoCircle size={18} />} p="xs">
              <Text fz="xs">此內容由機器自動擷取（OCR + LLM），可能有遺漏或誤讀，臨床使用前務必以原始仿單核對。</Text>
            </Alert>
          )}

          {mode === "readable" &&
            (isEmptyValue(sections) && !characteristics ? (
              <EmptyState compact title="沒有仿單區段" description="正規化紀錄中沒有可顯示的仿單內容。" />
            ) : (
              <Stack gap="lg">
                {characteristics && (
                  <Stack gap={4}>
                    <Text fw={650}>藥品特性</Text>
                    <Markdown>{characteristics}</Markdown>
                  </Stack>
                )}
                <ValueView value={sections} />
              </Stack>
            ))}
          {mode === "sections" && <JsonView value={sections ?? {}} maxHeight={isMobile ? 2000 : 720} />}
          {mode === "record" && <JsonView value={record} maxHeight={isMobile ? 2000 : 720} />}
        </Stack>
      </SectionCard>
    </Stack>
  );
}

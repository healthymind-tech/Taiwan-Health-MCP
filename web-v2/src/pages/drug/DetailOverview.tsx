// 概覽 tab: license facts, ingredients, ATC, indications/usage, safety,
// storage, companies, appearance and data completeness.

import { Alert, Badge, Box, Grid, Group, SimpleGrid, Stack, Table, Text, UnstyledButton } from "@mantine/core";
import { IconAlertTriangle, IconBuildingFactory2, IconFlask, IconInfoCircle, IconPill, IconShieldCheck, IconStethoscope } from "@tabler/icons-react";
import { useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { KeyValue } from "@/components/KeyValue";
import { SectionCard } from "@/components/SectionCard";
import { fmtDate } from "@/lib/format";
import type { DrugDetailsPayload } from "@/lib/types";
import { Lightbox, type LightboxImage } from "./AssetViewer";
import { BulletBlock } from "./StructuredView";
import { STAGE_COLUMNS } from "./drugMeta";
import { asArray, asDict, asText, isDict, textItems, type Dict, type ExplorerDetail } from "./drugTypes";
import { DrugStatusBadge, DrugThumb } from "./drugUi";
import classes from "./drug.module.css";

const SAFETY_FIELDS: { key: string; label: string; color?: string }[] = [
  { key: "contraindications", label: "禁忌", color: "red" },
  { key: "warnings", label: "警語", color: "red" },
  { key: "side_effects_stop_use", label: "出現下列副作用應停藥" },
  { key: "symptoms_stop_use_and_seek_care", label: "出現下列症狀應停藥並就醫" },
  { key: "consult_doctor_before_use", label: "使用前請洽醫師" },
  { key: "consult_professional_before_use", label: "使用前請諮詢醫師藥師" },
  { key: "precautions", label: "其他注意事項" },
];

const CONFIDENCE: Record<string, { label: string; color: string }> = {
  high: { label: "高", color: "teal" },
  medium: { label: "中", color: "amber" },
  low: { label: "低", color: "red" },
};

const SOURCE_LABEL: Record<string, string> = {
  pdf_insert: "仿單 PDF（OCR + LLM 分析）",
  electronic_insert: "TFDA 電子仿單",
  index_only: "僅許可證索引",
};

function pick(...vals: unknown[]): string {
  for (const v of vals) {
    const s = asText(v).trim();
    if (s) return s;
  }
  return "";
}

/** Prefer the CSV string; fall back to a DATE column rendered as a date. */
function dateField(text: unknown, dateCol: unknown): string {
  const t = asText(text).trim();
  if (t) return t;
  return dateCol ? fmtDate(asText(dateCol)) : "";
}

export function DetailOverview({ detail, details }: { detail: ExplorerDetail; details: DrugDetailsPayload | undefined }) {
  const d = detail.drug;
  const record = asDict(d.normalized_record ?? details?.record);
  const hasRecord = Object.keys(record).length > 0;
  const rs = asDict(record.record_status);
  const drug = asDict(record.drug);
  const companies = asDict(record.companies);
  const ingredients = asDict(record.ingredients);
  const usage = asDict(record.usage);
  const safety = asDict(record.safety);
  const quality = asDict(record.quality);
  const source = asDict(record.source);
  const active = asArray(ingredients.active).filter(isDict);
  const inactive = asArray(ingredients.inactive).filter(isDict);
  const atc = asArray(drug.atc_codes);
  const purpose = textItems(usage.purpose);
  const indications = purpose.length ? purpose : textItems(drug.indications).length ? textItems(drug.indications) : textItems(d.indications_text);
  const dosage = textItems(usage.dosage_and_administration);
  const dosageFallback = pick(usage.usage_text_from_index, d.usage_text_from_index);
  const storage = textItems(record.storage);
  const safetyBlocks = SAFETY_FIELDS.map((f) => ({ ...f, items: textItems(safety[f.key]) })).filter((f) => f.items.length > 0);
  const manufacturers = asArray(companies.manufacturers).filter(isDict);
  const applicant = asDict(companies.applicant);
  const isActive = d.is_active !== false;

  const images: LightboxImage[] = detail.appearances.flatMap((a) =>
    a.images.map((im) => ({
      src: im.preview_url,
      original: im.original_url,
      assetId: im.asset_id,
      filename: im.filename,
      caption: [a.color, a.shape, a.imprint ? `刻字 ${a.imprint}` : "", a.size].filter(Boolean).join(" · ") || undefined,
    })),
  );
  const [lb, setLb] = useState<number | null>(null);

  const confidence = CONFIDENCE[pick(quality.confidence, d.quality_confidence)];
  const missing = textItems(quality.missing_fields).length ? textItems(quality.missing_fields) : textItems(d.missing_fields);
  const notes = textItems(quality.notes);
  const sourceErrors = textItems(source.errors).length ? textItems(source.errors) : textItems(d.source_errors);
  const availability = details?.availability;

  return (
    <Grid gutter="md">
      <Grid.Col span={{ base: 12, lg: 8 }}>
        <Stack gap="md">
          {!hasRecord && (
            <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />}>
              這張許可證還沒有正規化紀錄，以下只顯示許可證索引的欄位。執行管線後會補上成分、仿單內容與安全性資訊。
            </Alert>
          )}

          <SectionCard title="許可證資料" icon={<IconPill size={18} />}>
            <KeyValue
              cols={3}
              items={[
                { label: "許可證種類", value: pick(drug.license_type, d.license_type) },
                { label: "藥品類別", value: pick(drug.drug_category, d.drug_category) },
                { label: "管制藥品級別", value: pick(drug.controlled_drug_level, d.controlled_drug_level) },
                { label: "劑型", value: pick(drug.dosage_form, d.dosage_form) },
                { label: "發證日期", value: dateField(rs.issue_date, d.issue_date) },
                { label: "有效日期", value: dateField(rs.valid_until, d.valid_until) },
                { label: "異動日期", value: dateField(rs.last_changed_date, d.last_changed_date) },
                { label: "舊證字號", value: pick(drug.old_license_no, d.old_license_no), hidden: !pick(drug.old_license_no, d.old_license_no) },
                { label: "通關簽審文件編號", value: pick(drug.customs_clearance_no, d.customs_clearance_no), hidden: !pick(drug.customs_clearance_no, d.customs_clearance_no) },
                { label: "包裝", value: <Text fz="sm" className={classes.prewrap}>{pick(drug.package, d.package)}</Text>, full: true },
                { label: "條碼", value: <Text fz="sm" ff="monospace" className={classes.prewrap}>{asText(d.barcode_text)}</Text>, full: true, hidden: !asText(d.barcode_text) },
                {
                  label: "註銷",
                  full: true,
                  hidden: isActive,
                  value: (
                    <Text fz="sm" c="red">
                      {[pick(rs.cancellation_status, d.cancellation_status), dateField(rs.cancellation_date, d.cancellation_date), pick(rs.cancellation_reason, d.cancellation_reason)].filter(Boolean).join(" · ") || "已註銷"}
                    </Text>
                  ),
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="成分" icon={<IconFlask size={18} />} flush={active.length > 0 || inactive.length > 0}>
            {active.length > 0 || inactive.length > 0 ? (
              <Stack gap={0}>
                {active.length > 0 && <IngredientTable title="有效成分" rows={active} />}
                {inactive.length > 0 && <IngredientTable title="其他成分（賦形劑）" rows={inactive} />}
              </Stack>
            ) : pick(ingredients.raw_summary, d.main_ingredient_summary) ? (
              <Stack gap={4}>
                <Text fz="xs" c="dimmed">
                  主成分略述（許可證索引）
                </Text>
                <Text fz="sm" className={classes.prewrap}>
                  {pick(ingredients.raw_summary, d.main_ingredient_summary)}
                </Text>
              </Stack>
            ) : (
              <EmptyState compact title="沒有成分資料" />
            )}
          </SectionCard>

          <SectionCard title="適應症與用法" icon={<IconStethoscope size={18} />}>
            {indications.length === 0 && dosage.length === 0 && !dosageFallback ? (
              <EmptyState compact title="沒有適應症或用法資料" />
            ) : (
              <Stack gap="md">
                <BulletBlock title="適應症" items={indications} />
                <BulletBlock title="用法用量" items={dosage.length ? dosage : dosageFallback ? [dosageFallback] : []} />
                <BulletBlock title="儲存方式" items={storage} />
              </Stack>
            )}
          </SectionCard>

          <SectionCard title="安全性" icon={<IconShieldCheck size={18} />} description="來自仿單分析或電子仿單；機器擷取，臨床使用前請以原始仿單核對。">
            {safetyBlocks.length === 0 ? (
              <EmptyState compact title="沒有安全性資料" description={hasRecord ? "仿單中未擷取到禁忌、警語或注意事項。" : "尚未完成仿單分析。"} />
            ) : (
              <Stack gap="md">
                {safetyBlocks.map((b) => (
                  <BulletBlock key={b.key} title={b.label} items={b.items} color={b.color} />
                ))}
              </Stack>
            )}
          </SectionCard>

          {detail.appearances.length > 0 && (
            <SectionCard title="外觀" description={images.length ? "點擊圖片放大檢視" : undefined}>
              <Stack gap="md">
                {detail.appearances.map((a) => (
                  <Group key={a.appearance_id} align="flex-start" gap="md" wrap="wrap">
                    <Group gap="xs" wrap="wrap">
                      {a.images.length === 0 && <DrugThumb src={null} alt="無圖片" size={88} />}
                      {a.images.map((im) => {
                        const idx = images.findIndex((x) => x.assetId === im.asset_id);
                        return (
                          <UnstyledButton key={im.asset_id} className={classes.thumbButton} onClick={() => setLb(idx)} aria-label="放大圖片">
                            <DrugThumb src={im.preview_url} alt={im.filename ?? "外觀圖片"} size={88} />
                          </UnstyledButton>
                        );
                      })}
                    </Group>
                    <Box style={{ flex: "1 1 220px", minWidth: 0 }}>
                      <KeyValue
                        cols={2}
                        items={[
                          { label: "顏色", value: a.color },
                          { label: "形狀", value: a.shape },
                          { label: "刻字", value: a.imprint },
                          { label: "尺寸", value: a.size },
                          { label: "刻痕", value: a.scoring, hidden: !a.scoring },
                          { label: "標記", value: a.symbol, hidden: !a.symbol },
                          { label: "描述", value: a.description, full: true, hidden: !a.description },
                        ]}
                      />
                    </Box>
                  </Group>
                ))}
              </Stack>
            </SectionCard>
          )}
        </Stack>
      </Grid.Col>

      <Grid.Col span={{ base: 12, lg: 4 }}>
        <Stack gap="md">
          <SectionCard title="資料完整度">
            <Stack gap="sm">
              <Group justify="space-between" gap="xs">
                <Text fz="sm" c="dimmed">
                  資料來源
                </Text>
                <Text fz="sm" fw={600} ta="right">
                  {SOURCE_LABEL[pick(source.primary_insert_source)] ?? (hasRecord ? "—" : "尚未正規化")}
                </Text>
              </Group>
              <Group justify="space-between" gap="xs">
                <Text fz="sm" c="dimmed">
                  可信度
                </Text>
                {confidence ? (
                  <Badge color={confidence.color} variant="light">
                    {confidence.label}
                  </Badge>
                ) : (
                  <Text fz="sm">—</Text>
                )}
              </Group>
              {missing.length > 0 && (
                <Box>
                  <Text fz="xs" c="dimmed" mb={4}>
                    缺少欄位
                  </Text>
                  <Group gap={4}>
                    {missing.map((m) => (
                      <Badge key={m} size="xs" variant="outline" color="amber" style={{ textTransform: "none" }}>
                        {m}
                      </Badge>
                    ))}
                  </Group>
                </Box>
              )}
              {notes.map((n) => (
                <Text key={n} fz="xs" c="dimmed">
                  {n}
                </Text>
              ))}
              {sourceErrors.length > 0 && (
                <Alert color="red" variant="light" p="xs" icon={<IconAlertTriangle size={16} />}>
                  <Stack gap={2}>
                    {sourceErrors.map((e, i) => (
                      <Text key={i} fz="xs" style={{ wordBreak: "break-word" }}>
                        {e}
                      </Text>
                    ))}
                  </Stack>
                </Alert>
              )}
            </Stack>
          </SectionCard>

          <SectionCard title="各階段狀態" description={availability ? "依藥品服務的顯示規則（已註銷許可證的待處理會顯示為無資料）" : undefined}>
            <SimpleGrid cols={1} spacing={6}>
              {STAGE_COLUMNS.map((c) => (
                <Group key={c.key} justify="space-between" gap="xs" wrap="nowrap">
                  <Text fz="sm">{c.label}</Text>
                  <DrugStatusBadge status={availability?.[c.key] || asText(d[c.key]) || "pending"} size="xs" />
                </Group>
              ))}
            </SimpleGrid>
            {details?.documents_summary && (
              <Text fz="xs" c="dimmed" mt="sm">
                仿單 PDF {details.documents_summary.insert_pdf_count ?? 0} 份 · 外盒 PDF {details.documents_summary.label_pdf_count ?? 0} 份
              </Text>
            )}
          </SectionCard>

          {atc.length > 0 && (
            <SectionCard title="ATC 分類碼">
              <Stack gap="xs">
                {atc.map((item, i) => {
                  const it: Dict = isDict(item) ? item : { code: asText(item) };
                  const code = pick(it["ATC Code"], it["代碼"], it.ATC, it.code);
                  const rest = Object.entries(it)
                    .filter(([k, v]) => !["ATC Code", "代碼", "ATC", "code"].includes(k) && asText(v).trim())
                    .map(([, v]) => asText(v));
                  return (
                    <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
                      <Badge variant="light" ff="monospace" style={{ textTransform: "none", flexShrink: 0 }}>
                        {code || "—"}
                      </Badge>
                      <Text fz="sm" style={{ wordBreak: "break-word" }}>
                        {rest.join(" · ")}
                      </Text>
                    </Group>
                  );
                })}
              </Stack>
            </SectionCard>
          )}

          <SectionCard title="廠商" icon={<IconBuildingFactory2 size={18} />}>
            <Stack gap="md">
              <KeyValue
                cols={1}
                items={[
                  { label: "申請商", value: pick(applicant.name, d.applicant_name) },
                  { label: "申請商地址", value: pick(applicant.address, d.applicant_address), hidden: !pick(applicant.address, d.applicant_address) },
                  { label: "統一編號", value: pick(applicant.tax_id, d.applicant_tax_id), hidden: !pick(applicant.tax_id, d.applicant_tax_id) },
                ]}
              />
              {(manufacturers.length > 0
                ? manufacturers
                : [{ name: d.manufacturer_name, country: d.manufacturer_country, factory_address: d.manufacturer_factory_address, process: d.manufacturing_process }]
              ).map((m, i) => (
                <Box key={i} p="sm" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}>
                  <Text fz="xs" c="dimmed">
                    製造廠{manufacturers.length > 1 ? ` ${i + 1}` : ""}
                  </Text>
                  <Text fz="sm" fw={600} style={{ wordBreak: "break-word" }}>
                    {pick(m.name) || "—"}
                  </Text>
                  <Text fz="xs" c="dimmed" style={{ wordBreak: "break-word" }}>
                    {[pick(m.country), pick(m.process), pick(m.factory_address)].filter(Boolean).join(" · ")}
                  </Text>
                </Box>
              ))}
            </Stack>
          </SectionCard>
        </Stack>
      </Grid.Col>

      <Lightbox images={images} index={lb} onIndex={setLb} onClose={() => setLb(null)} />
    </Grid>
  );
}

function IngredientTable({ title, rows }: { title: string; rows: Dict[] }) {
  return (
    <Box>
      <Text fz="xs" fw={600} c="dimmed" px="lg" pt="md" pb={6}>
        {title}（{rows.length}）
      </Text>
      <Box style={{ overflowX: "auto" }}>
        <Table verticalSpacing="xs" horizontalSpacing="lg" miw={420} striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>成分</Table.Th>
              <Table.Th style={{ textAlign: "right", whiteSpace: "nowrap" }}>含量</Table.Th>
              <Table.Th>原文</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r, i) => (
              <Table.Tr key={i}>
                <Table.Td fw={500} style={{ wordBreak: "break-word" }}>
                  {pick(r.name) || "—"}
                </Table.Td>
                <Table.Td style={{ textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                  {[pick(r.amount), pick(r.unit)].filter(Boolean).join(" ") || "—"}
                </Table.Td>
                <Table.Td>
                  <Text fz="xs" c="dimmed" style={{ wordBreak: "break-word" }}>
                    {pick(r.raw_text)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    </Box>
  );
}

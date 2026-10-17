// KPI tiles + charts for the drug pipeline (pipeline-status + status summary).

import { BarChart, DonutChart } from "@mantine/charts";
import { Box, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconFileAnalytics, IconHourglass, IconLicense, IconScan } from "@tabler/icons-react";
import { useNavigate } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { fmtNumber, fmtPercent } from "@/lib/format";
import type { DrugAdminStatus, DrugPipelineStatus } from "./drugTypes";

const FAILED_STAGES: { key: string; label: string }[] = [
  { key: "electronic_failed", label: "電子仿單" },
  { key: "insert_failed", label: "仿單 PDF" },
  { key: "label_failed", label: "外盒 PDF" },
  { key: "shape_failed", label: "外觀圖片" },
  { key: "storage_failed", label: "物件儲存" },
  { key: "ocr_failed", label: "OCR" },
  { key: "analysis_failed", label: "LLM 分析" },
  { key: "normalize_failed", label: "正規化" },
];

function explorerLink(params: Record<string, string>): string {
  return `/drug/explorer?${new URLSearchParams(params).toString()}`;
}

export function PipelineKpis({ p, status, loading }: { p: DrugPipelineStatus | undefined; status: DrugAdminStatus | undefined; loading: boolean }) {
  const navigate = useNavigate();
  const listed = p?.index.total_licenses ?? 0;
  const active = status?.summary.active_licenses;
  const q = p?.pipeline;
  const done = q?.queue_done ?? 0;
  const total = q?.queue_total ?? 0;
  const a = p?.analysis;

  return (
    <SimpleGrid cols={{ base: 1, xs: 2, lg: 3, xl: 6 }} spacing="md">
      <StatCard
        label="許可證"
        value={fmtNumber(listed)}
        hint={active !== undefined ? `有效 ${fmtNumber(active)} · 已註銷 ${fmtNumber(Math.max(0, listed - active))}` : "已列入索引"}
        icon={<IconLicense size={20} />}
        loading={loading}
        onClick={() => navigate("/drug/explorer?active=all")}
      />
      <StatCard
        label="管線完成"
        value={total ? fmtPercent(done, total) : "—"}
        hint={`${fmtNumber(done)} / ${fmtNumber(total)} 張有效許可證`}
        icon={<IconCircleCheck size={20} />}
        color="teal"
        progress={total ? (done / total) * 100 : 0}
        loading={loading}
      />
      <StatCard
        label="待處理"
        value={fmtNumber(q?.queue_pending ?? 0)}
        hint={q?.is_complete ? "佇列已清空" : "等待爬取與分析"}
        icon={<IconHourglass size={20} />}
        color="blue"
        loading={loading}
        onClick={() => navigate(explorerLink({ stage: "analysis", stage_statuses: "pending" }))}
      />
      <StatCard
        label="處理失敗"
        value={fmtNumber(q?.queue_failed ?? 0)}
        hint="可重試；點擊查看清單"
        icon={<IconAlertTriangle size={20} />}
        color={(q?.queue_failed ?? 0) > 0 ? "red" : "gray"}
        loading={loading}
        onClick={() => navigate(explorerLink({ has_error: "true", sort: "failed_first" }))}
      />
      <StatCard
        label="仿單已分析"
        value={fmtNumber(a?.done ?? 0)}
        hint={`待分析 ${fmtNumber(a?.pending ?? 0)} · 失敗 ${fmtNumber(a?.failed ?? 0)}`}
        icon={<IconFileAnalytics size={20} />}
        color="indigo"
        progress={a?.total ? ((a.done ?? 0) / a.total) * 100 : 0}
        loading={loading}
        onClick={() => navigate(explorerLink({ asset_types: "analysis_json" }))}
      />
      <StatCard
        label="待 OCR"
        value={fmtNumber(p?.enrichment.needs_ocr_licenses ?? 0)}
        hint={`已擴充 ${fmtNumber(p?.enrichment.enriched_licenses ?? 0)} · 僅電子仿單 ${fmtNumber(p?.enrichment.ei_only_licenses ?? 0)}`}
        icon={<IconScan size={20} />}
        color="amber"
        loading={loading}
      />
    </SimpleGrid>
  );
}

export function PipelineCharts({ p, status }: { p: DrugPipelineStatus | undefined; status: DrugAdminStatus | undefined }) {
  const q = p?.pipeline;
  const other = q ? Math.max(0, q.queue_total - q.queue_done - q.queue_pending - q.queue_failed) : 0;
  const donut = q
    ? [
        { name: "完成", value: q.queue_done, color: "teal.6" },
        { name: "待處理", value: q.queue_pending, color: "blue.5" },
        { name: "失敗", value: q.queue_failed, color: "red.6" },
        ...(other > 0 ? [{ name: "其他", value: other, color: "gray.5" }] : []),
      ].filter((d) => d.value > 0)
    : [];
  const sc = status?.summary.state_counts ?? {};
  const bars = FAILED_STAGES.map((s) => ({ stage: s.label, 失敗: Number(sc[s.key] ?? 0) }));
  const anyFailures = bars.some((b) => b.失敗 > 0);

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
      <SectionCard title="許可證處理進度" description="有效許可證在藥品佇列中的狀態">
        {donut.length === 0 ? (
          <EmptyState compact title="佇列是空的" description="匯入索引 CSV 後，有效許可證會自動排入佇列。" />
        ) : (
          <Group justify="center" gap="xl" wrap="wrap">
            <DonutChart
              data={donut}
              size={180}
              thickness={26}
              withTooltip
              tooltipDataSource="segment"
              chartLabel={q ? fmtPercent(q.queue_done, q.queue_total, 0) : ""}
              valueFormatter={(v) => fmtNumber(v)}
            />
            <Stack gap={8}>
              {donut.map((d) => (
                <Group key={d.name} gap={8} wrap="nowrap">
                  <Box w={10} h={10} style={{ borderRadius: 3, background: `var(--mantine-color-${d.color.replace(".", "-")})` }} />
                  <Text fz="sm" w={56}>
                    {d.name}
                  </Text>
                  <Text fz="sm" fw={600} style={{ fontVariantNumeric: "tabular-nums" }}>
                    {fmtNumber(d.value)}
                  </Text>
                </Group>
              ))}
            </Stack>
          </Group>
        )}
      </SectionCard>
      <SectionCard title="各階段失敗數" description="有效許可證在各處理階段標記為「失敗（可重試）」的數量">
        {!status ? (
          <Text fz="sm" c="dimmed">
            載入中…
          </Text>
        ) : !anyFailures ? (
          <EmptyState compact icon={<IconCircleCheck size={22} />} title="沒有失敗的階段" description="所有階段目前都沒有可重試的失敗。" />
        ) : (
          <BarChart
            h={200}
            data={bars}
            dataKey="stage"
            series={[{ name: "失敗", color: "red.6" }]}
            orientation="vertical"
            yAxisProps={{ width: 72 }}
            gridAxis="x"
            valueFormatter={(v) => fmtNumber(v)}
            barProps={{ radius: 3 }}
          />
        )}
      </SectionCard>
    </SimpleGrid>
  );
}

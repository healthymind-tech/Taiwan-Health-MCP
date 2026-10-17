// Advanced filter drawer for the drug explorer. Edits a draft copy and applies
// on "套用" so the URL (and the server query) changes once, not per keystroke.

import {
  Autocomplete,
  Button,
  Divider,
  Drawer,
  Group,
  MultiSelect,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useState, type ReactNode } from "react";
import { dayjs } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { ASSET_TYPE_LABELS, FILTER_ASSET_TYPES, STAGE_COLUMNS, STAGE_STATUS_OPTIONS } from "./drugMeta";
import type { ExplorerPayload, FacetValue } from "./drugTypes";
import { DEFAULT_FILTERS, type ExplorerFilters } from "./explorerParams";

function facetOptions(values: FacetValue[] | undefined, current: string): { value: string; label: string }[] {
  const opts = (values ?? []).map((v) => ({ value: v.value, label: `${v.value}（${v.count.toLocaleString("zh-TW")}）` }));
  if (current && !opts.some((o) => o.value === current)) opts.unshift({ value: current, label: current });
  return opts;
}

export const UPDATED_PRESETS = [
  { value: "1", label: "最近 24 小時" },
  { value: "7", label: "最近 7 天" },
  { value: "30", label: "最近 30 天" },
  { value: "90", label: "最近 90 天" },
];

export function presetFromDate(date: string): string | null {
  if (!date) return null;
  const days = dayjs().startOf("day").diff(dayjs(date), "day");
  const hit = UPDATED_PRESETS.find((p) => Number(p.value) === days);
  return hit ? hit.value : null;
}

export function ExplorerFiltersDrawer({
  opened,
  onClose,
  filters,
  facets,
  onApply,
}: {
  opened: boolean;
  onClose: () => void;
  filters: ExplorerFilters;
  facets: ExplorerPayload["facets"] | undefined;
  onApply: (f: ExplorerFilters) => void;
}) {
  const isMobile = useIsMobile();
  const [d, setD] = useState<ExplorerFilters>(filters);
  useEffect(() => {
    if (opened) setD(filters);
  }, [opened, filters]);

  const set = <K extends keyof ExplorerFilters>(k: K, v: ExplorerFilters[K]) => setD((x) => ({ ...x, [k]: v }));
  const assetCounts = facets?.asset_types ?? {};
  const assetOptions = FILTER_ASSET_TYPES.map((t) => ({
    value: t,
    label: `${ASSET_TYPE_LABELS[t]}${assetCounts[t] !== undefined ? `（${assetCounts[t].toLocaleString("zh-TW")}）` : ""}`,
  }));

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position={isMobile ? "bottom" : "right"}
      size={isMobile ? "92%" : 440}
      title={
        <Text fw={650} fz="lg">
          進階篩選
        </Text>
      }
      styles={{ body: { paddingBottom: 0 } }}
    >
      <Stack gap="md" pb={96}>
        <Section title="許可證狀態">
          <SegmentedControl
            fullWidth
            value={d.active}
            onChange={(v) => set("active", v as ExplorerFilters["active"])}
            data={[
              { value: "active", label: "有效" },
              { value: "inactive", label: "已註銷" },
              { value: "all", label: "全部" },
            ]}
          />
        </Section>

        <Section title="檔案">
          <MultiSelect
            label="擁有這些檔案"
            placeholder="不限"
            data={assetOptions}
            value={d.asset_types}
            onChange={(v) => set("asset_types", v)}
            clearable
          />
          {d.asset_types.length > 1 && (
            <SegmentedControl
              size="xs"
              value={d.asset_match}
              onChange={(v) => set("asset_match", v as "any" | "all")}
              data={[
                { value: "any", label: "符合任一" },
                { value: "all", label: "全部都要有" },
              ]}
            />
          )}
          <MultiSelect
            label="缺少這些檔案"
            placeholder="不限"
            data={FILTER_ASSET_TYPES.map((t) => ({ value: t, label: ASSET_TYPE_LABELS[t] }))}
            value={d.missing_asset_types}
            onChange={(v) => set("missing_asset_types", v)}
            clearable
          />
        </Section>

        <Section title="處理階段">
          <Select
            label="階段"
            placeholder="選擇一個階段"
            data={STAGE_COLUMNS.map((c) => ({ value: c.stage, label: c.label }))}
            value={d.stage || null}
            onChange={(v) => set("stage", v ?? "")}
            clearable
          />
          <MultiSelect
            label="該階段的狀態"
            placeholder={d.stage ? "選擇狀態" : "請先選擇階段"}
            disabled={!d.stage}
            data={STAGE_STATUS_OPTIONS}
            value={d.stage_statuses}
            onChange={(v) => set("stage_statuses", v)}
            clearable
          />
          <MultiSelect
            label="任一階段為"
            description="例如選「失敗（可重試）」找出任何階段失敗的許可證"
            placeholder="不限"
            data={STAGE_STATUS_OPTIONS}
            value={d.pipeline_statuses}
            onChange={(v) => set("pipeline_statuses", v)}
            clearable
          />
          <Stack gap={4}>
            <Text fz="sm" fw={500}>
              錯誤訊息
            </Text>
            <SegmentedControl
              fullWidth
              size="xs"
              value={d.has_error || "any"}
              onChange={(v) => set("has_error", v === "any" ? "" : (v as "true" | "false"))}
              data={[
                { value: "any", label: "不限" },
                { value: "true", label: "有錯誤" },
                { value: "false", label: "無錯誤" },
              ]}
            />
          </Stack>
          <Select
            label="最近更新"
            placeholder="不限"
            data={UPDATED_PRESETS}
            value={presetFromDate(d.updated_from)}
            onChange={(v) => set("updated_from", v ? dayjs().subtract(Number(v), "day").format("YYYY-MM-DD") : "")}
            clearable
          />
        </Section>

        <Section title="藥品屬性">
          <TextInput
            label="成分"
            placeholder="例如 acetaminophen、普拿疼"
            value={d.ingredient}
            onChange={(e) => set("ingredient", e.currentTarget.value)}
          />
          <Autocomplete
            label="製造商（部分符合）"
            placeholder="例如 永信"
            data={(facets?.manufacturer ?? []).map((v) => v.value)}
            value={d.manufacturer}
            onChange={(v) => set("manufacturer", v)}
            limit={50}
          />
          <Autocomplete
            label="劑型（部分符合）"
            placeholder="例如 錠劑"
            data={(facets?.dosage_form ?? []).map((v) => v.value)}
            value={d.dosage_form}
            onChange={(v) => set("dosage_form", v)}
            limit={50}
          />
          <Select
            label="製造國別"
            placeholder="不限"
            data={facetOptions(facets?.country, d.country)}
            value={d.country || null}
            onChange={(v) => set("country", v ?? "")}
            searchable
            clearable
          />
          <Group grow gap="sm" align="flex-start">
            <Select
              label="外觀顏色"
              placeholder="不限"
              data={facetOptions(facets?.appearance_color, d.appearance_color)}
              value={d.appearance_color || null}
              onChange={(v) => set("appearance_color", v ?? "")}
              searchable
              clearable
            />
            <Select
              label="外觀形狀"
              placeholder="不限"
              data={facetOptions(facets?.appearance_shape, d.appearance_shape)}
              value={d.appearance_shape || null}
              onChange={(v) => set("appearance_shape", v ?? "")}
              searchable
              clearable
            />
          </Group>
          <Text fz="xs" c="dimmed">
            括號內為目前結果中的筆數；下拉選單最多列出前 50 項。
          </Text>
        </Section>
      </Stack>

      <Group
        justify="space-between"
        gap="sm"
        p="md"
        style={{
          position: "sticky",
          bottom: 0,
          background: "var(--mantine-color-body)",
          borderTop: "1px solid var(--mantine-color-default-border)",
          marginInline: "calc(var(--mantine-spacing-md) * -1)",
        }}
      >
        <Button variant="subtle" color="gray" onClick={() => setD({ ...DEFAULT_FILTERS, q: d.q, sort: d.sort, order: d.order, per_page: d.per_page })}>
          重設
        </Button>
        <Group gap="sm">
          <Button variant="default" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => {
              onApply({ ...d, page: 1 });
              onClose();
            }}
          >
            套用篩選
          </Button>
        </Group>
      </Group>
    </Drawer>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap="sm">
      <Divider label={title} labelPosition="left" />
      {children}
    </Stack>
  );
}

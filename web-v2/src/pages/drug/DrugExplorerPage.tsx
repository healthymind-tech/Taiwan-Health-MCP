import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Chip,
  CloseButton,
  Group,
  Indicator,
  Loader,
  Pagination,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconSearch,
  IconSortAscending,
  IconSortDescending,
  IconDatabaseOff,
  IconFilterOff,
} from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { SectionCard } from "@/components/SectionCard";
import { api } from "@/lib/api";
import { fmtDateTime, fmtNumber, fmtRelative } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { ExplorerFiltersDrawer, UPDATED_PRESETS, presetFromDate } from "./ExplorerFiltersDrawer";
import { ASSET_TYPE_LABELS, FILTER_ASSET_TYPES, STAGE_COLUMNS, drugDetailPath, drugStatusMeta } from "./drugMeta";
import type { ExplorerDrug, ExplorerPayload } from "./drugTypes";
import { DrugThumb, StageStrip } from "./drugUi";
import { DEFAULT_FILTERS, activeFilterCount, apiQuery, filtersToParams, parseFilters, type ExplorerFilters } from "./explorerParams";

const SORT_OPTIONS = [
  { value: "", label: "建議順序（待處理優先）" },
  { value: "relevance", label: "相關度" },
  { value: "updated_at", label: "最近更新" },
  { value: "license_id", label: "許可證字號" },
  { value: "name_zh", label: "中文品名" },
  { value: "name_en", label: "英文品名" },
  { value: "pipeline_progress", label: "處理進度" },
  { value: "asset_count", label: "檔案數" },
  { value: "latest_document", label: "最新文件" },
  { value: "failed_first", label: "失敗優先" },
  { value: "missing_data", label: "缺漏資料數" },
];

export default function DrugExplorerPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const filters = useMemo(() => parseFilters(sp), [sp]);
  const [drawer, setDrawer] = useState(false);

  // Debounced search box mirrored into the URL.
  const [text, setText] = useState(filters.q);
  const debounced = useDebounced(text, 350);
  const lastPushed = useRef(filters.q);
  useEffect(() => {
    // Only resync when the URL changes from outside (back/forward, chip removal),
    // never on our own debounced write — that would clobber in-flight typing.
    if (filters.q !== lastPushed.current) {
      lastPushed.current = filters.q;
      setText(filters.q);
    }
  }, [filters.q]);

  const update = (patch: Partial<ExplorerFilters>, opts: { replace?: boolean } = {}) => {
    const next = { ...filters, ...patch };
    if (!("page" in patch)) next.page = 1;
    setSp(filtersToParams(next), { replace: opts.replace });
  };

  useEffect(() => {
    const v = debounced.trim();
    if (v !== filters.q) {
      lastPushed.current = v;
      update({ q: v }, { replace: true });
    }
  }, [debounced]);

  const effective: ExplorerFilters = useMemo(
    () => ({ ...filters, sort: filters.sort || (filters.q ? "relevance" : "") }),
    [filters],
  );
  const queryString = apiQuery(effective);
  const q = useQuery({
    queryKey: qk.drugExplorer(queryString),
    queryFn: () => api.get<ExplorerPayload>(`/admin/api/drug/explorer?${queryString}`),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });

  const data = q.data;
  const total = data?.pagination.total ?? 0;
  const totalPages = data?.pagination.total_pages ?? 1;
  const filterCount = activeFilterCount(filters);
  const assetCounts = data?.facets.asset_types ?? {};

  const open = (d: ExplorerDrug) => navigate(drugDetailPath(d.license_id), { state: { from: location.search } });

  const columns: Column<ExplorerDrug>[] = [
    {
      key: "name",
      header: "藥品",
      primary: true,
      render: (d) => (
        <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
          <DrugThumb src={d.thumbnail_url} alt={d.name_zh || d.license_id} size={44} />
          <Box style={{ minWidth: 0 }}>
            <Group gap={6} wrap="wrap">
              <Text fz="sm" fw={600} style={{ wordBreak: "break-word" }}>
                {d.name_zh || "（無中文品名）"}
              </Text>
              {!d.is_active && (
                <Badge size="xs" color="gray" variant="outline">
                  已註銷
                </Badge>
              )}
              {d.has_error && (
                <Tooltip label={d.last_error_message || "有錯誤"} multiline maw={360}>
                  <IconAlertTriangle size={14} color="var(--mantine-color-red-filled)" />
                </Tooltip>
              )}
            </Group>
            {d.name_en && (
              <Text fz="xs" c="dimmed" lineClamp={1} style={{ wordBreak: "break-word" }}>
                {d.name_en}
              </Text>
            )}
            <Text fz="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
              {d.license_id}
            </Text>
          </Box>
        </Group>
      ),
    },
    {
      key: "maker",
      header: "製造商",
      render: (d) => (
        <Box maw={220}>
          <Text fz="sm" lineClamp={2} style={{ wordBreak: "break-word" }}>
            {d.manufacturer_name || "—"}
          </Text>
          {d.manufacturer_country && (
            <Text fz="xs" c="dimmed">
              {d.manufacturer_country}
            </Text>
          )}
        </Box>
      ),
    },
    {
      key: "form",
      header: "劑型",
      hideOnMobile: true,
      render: (d) => (
        <Text fz="sm" maw={140} lineClamp={2}>
          {d.dosage_form || "—"}
        </Text>
      ),
    },
    {
      key: "stages",
      header: "處理進度",
      render: (d) => (
        <Stack gap={4}>
          <StageStrip statuses={d.statuses} />
          <Text fz={11} c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
            {d.pipeline_progress} / {STAGE_COLUMNS.length} 階段 · {d.asset_count} 個檔案
          </Text>
        </Stack>
      ),
    },
    {
      key: "updated",
      header: "更新",
      nowrap: true,
      hideOnMobile: true,
      render: (d) => (
        <Tooltip label={fmtDateTime(d.updated_at)} disabled={!d.updated_at}>
          <Text fz="xs" c="dimmed">
            {d.updated_at ? fmtRelative(d.updated_at) : "—"}
          </Text>
        </Tooltip>
      ),
    },
  ];

  // Removable chips describing every active filter.
  const chips: { key: string; label: string; clear: Partial<ExplorerFilters> }[] = [];
  if (filters.active !== "active") chips.push({ key: "active", label: filters.active === "all" ? "含已註銷" : "僅已註銷", clear: { active: "active" } });
  if (filters.asset_types.length > 1)
    chips.push({ key: "am", label: filters.asset_match === "all" ? "檔案：全部都要有" : "檔案：符合任一", clear: { asset_match: "any" } });
  if (filters.missing_asset_types.length)
    chips.push({ key: "miss", label: `缺少：${filters.missing_asset_types.map((t) => ASSET_TYPE_LABELS[t] ?? t).join("、")}`, clear: { missing_asset_types: [] } });
  if (filters.stage && filters.stage_statuses.length)
    chips.push({
      key: "stage",
      label: `${STAGE_COLUMNS.find((c) => c.stage === filters.stage)?.label ?? filters.stage}：${filters.stage_statuses.map((s) => drugStatusMeta(s).label).join("、")}`,
      clear: { stage: "", stage_statuses: [] },
    });
  if (filters.pipeline_statuses.length)
    chips.push({ key: "ps", label: `任一階段：${filters.pipeline_statuses.map((s) => drugStatusMeta(s).label).join("、")}`, clear: { pipeline_statuses: [] } });
  if (filters.has_error) chips.push({ key: "err", label: filters.has_error === "true" ? "有錯誤" : "無錯誤", clear: { has_error: "" } });
  if (filters.ingredient) chips.push({ key: "ing", label: `成分：${filters.ingredient}`, clear: { ingredient: "" } });
  if (filters.manufacturer) chips.push({ key: "mf", label: `製造商：${filters.manufacturer}`, clear: { manufacturer: "" } });
  if (filters.dosage_form) chips.push({ key: "df", label: `劑型：${filters.dosage_form}`, clear: { dosage_form: "" } });
  if (filters.country) chips.push({ key: "ct", label: `國別：${filters.country}`, clear: { country: "" } });
  if (filters.appearance_color) chips.push({ key: "ac", label: `顏色：${filters.appearance_color}`, clear: { appearance_color: "" } });
  if (filters.appearance_shape) chips.push({ key: "as", label: `形狀：${filters.appearance_shape}`, clear: { appearance_shape: "" } });
  if (filters.updated_from)
    chips.push({
      key: "upd",
      label: `更新：${UPDATED_PRESETS.find((p) => p.value === presetFromDate(filters.updated_from))?.label ?? `${filters.updated_from} 之後`}`,
      clear: { updated_from: "" },
    });

  const anyFilter = filterCount > 0 || filters.q !== "";

  return (
    <>
      <PageHeader
        title="藥品瀏覽器"
        icon={<IconSearch size={24} />}
        breadcrumbs={[{ label: "藥品", to: "/drug" }, { label: "瀏覽器" }]}
        description="搜尋所有許可證，依檔案、處理階段與藥品屬性篩選，點擊查看完整資料、仿單與分析結果。"
      />

      <Stack gap="md">
        <SectionCard>
          <Stack gap="sm">
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <TextInput
                style={{ flex: 1, minWidth: 0 }}
                size="md"
                leftSection={q.isFetching ? <Loader size={16} /> : <IconSearch size={18} />}
                placeholder="搜尋許可證字號、中英文品名、製造商或成分"
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
                rightSection={text ? <CloseButton aria-label="清除搜尋" onClick={() => setText("")} /> : null}
                aria-label="搜尋藥品"
              />
              <Indicator label={filterCount} size={18} disabled={filterCount === 0} offset={4}>
                <Button size="md" variant="default" leftSection={<IconAdjustmentsHorizontal size={18} />} onClick={() => setDrawer(true)} px={{ base: "sm", sm: "md" }}>
                  <Text span visibleFrom="xs" fz="sm">
                    篩選
                  </Text>
                </Button>
              </Indicator>
            </Group>

            <Group gap="sm" wrap="wrap" justify="space-between">
              <SegmentedControl
                size="xs"
                value={filters.active}
                onChange={(v) => update({ active: v as ExplorerFilters["active"] })}
                data={[
                  { value: "active", label: "有效" },
                  { value: "inactive", label: "已註銷" },
                  { value: "all", label: "全部" },
                ]}
              />
              <Group gap={6} wrap="nowrap">
                <Select
                  size="xs"
                  w={190}
                  data={SORT_OPTIONS}
                  value={filters.sort}
                  onChange={(v) => update({ sort: v ?? "" })}
                  allowDeselect={false}
                  aria-label="排序"
                  comboboxProps={{ withinPortal: true }}
                />
                <Tooltip label={filters.order === "asc" ? "遞增（點擊改遞減）" : "遞減（點擊改遞增）"}>
                  <ActionIcon variant="default" size="md" aria-label="切換排序方向" onClick={() => update({ order: filters.order === "asc" ? "desc" : "asc" })}>
                    {filters.order === "asc" ? <IconSortAscending size={16} /> : <IconSortDescending size={16} />}
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>

            <Box>
              <Text fz="xs" c="dimmed" mb={6}>
                擁有檔案
              </Text>
              <Chip.Group multiple value={filters.asset_types} onChange={(v) => update({ asset_types: v })}>
                <Group gap={6} wrap="wrap">
                  {FILTER_ASSET_TYPES.map((t) => (
                    <Chip key={t} value={t} size="xs" variant="outline">
                      {ASSET_TYPE_LABELS[t]}
                      {assetCounts[t] !== undefined && (
                        <Text span fz={11} c="dimmed" ml={4}>
                          {fmtNumber(assetCounts[t])}
                        </Text>
                      )}
                    </Chip>
                  ))}
                </Group>
              </Chip.Group>
            </Box>

            {chips.length > 0 && (
              <Group gap={6} wrap="wrap">
                {chips.map((c) => (
                  <Badge
                    key={c.key}
                    variant="light"
                    size="lg"
                    radius="sm"
                    style={{ textTransform: "none", fontWeight: 500, maxWidth: "100%" }}
                    rightSection={<CloseButton size="xs" aria-label={`移除 ${c.label}`} onClick={() => update(c.clear)} />}
                  >
                    <Text span fz="xs" truncate="end">
                      {c.label}
                    </Text>
                  </Badge>
                ))}
                <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconFilterOff size={12} />} onClick={() => setSp(filtersToParams({ ...DEFAULT_FILTERS, per_page: filters.per_page }))}>
                  清除全部
                </Button>
              </Group>
            )}
          </Stack>
        </SectionCard>

        <SectionCard
          flush
          title={
            <Group gap={8} wrap="wrap">
              <span>搜尋結果</span>
              {data && (
                <Badge variant="light" color="gray" size="lg" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {fmtNumber(total)} 筆
                </Badge>
              )}
            </Group>
          }
          actions={
            <Group gap={6} wrap="nowrap">
              <Text fz="xs" c="dimmed">
                每頁
              </Text>
              <Select
                size="xs"
                w={80}
                data={["10", "25", "50", "100"]}
                value={String(filters.per_page)}
                onChange={(v) => update({ per_page: Number(v ?? 25) })}
                allowDeselect={false}
                aria-label="每頁筆數"
              />
            </Group>
          }
        >
          {q.isError && !data ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <Box style={{ opacity: q.isPlaceholderData ? 0.6 : 1, transition: "opacity 120ms" }}>
              <DataTable
                columns={columns}
                rows={data?.drugs ?? []}
                rowKey={(d) => d.license_id}
                loading={q.isPending}
                onRowClick={open}
                minWidth={860}
                empty={
                  anyFilter ? (
                    <EmptyState
                      icon={<IconSearch size={26} />}
                      title="找不到符合的藥品"
                      description="試著縮短關鍵字、改用許可證字號，或放寬篩選條件。中文品名需輸入連續的字。"
                      action={
                        <Button variant="light" leftSection={<IconFilterOff size={16} />} onClick={() => setSp(new URLSearchParams())}>
                          清除搜尋與篩選
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={<IconDatabaseOff size={26} />}
                      title="還沒有任何藥品資料"
                      description="請先在藥品管線頁上傳並匯入許可證索引 CSV。"
                      action={<Button onClick={() => navigate("/drug")}>前往藥品管線</Button>}
                    />
                  )
                }
              />
            </Box>
          )}
          {data && totalPages > 1 && (
            <Group justify="space-between" px="md" py="sm" wrap="wrap" gap="xs" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
              <Text fz="xs" c="dimmed">
                第 {fmtNumber((filters.page - 1) * filters.per_page + 1)}–{fmtNumber(Math.min(filters.page * filters.per_page, total))} 筆，共 {fmtNumber(total)} 筆
              </Text>
              <Pagination
                size="sm"
                total={totalPages}
                value={Math.min(filters.page, totalPages)}
                onChange={(p) => {
                  update({ page: p });
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                siblings={1}
                boundaries={1}
              />
            </Group>
          )}
        </SectionCard>
      </Stack>

      <ExplorerFiltersDrawer opened={drawer} onClose={() => setDrawer(false)} filters={filters} facets={data?.facets} onApply={(f) => setSp(filtersToParams(f))} />
    </>
  );
}

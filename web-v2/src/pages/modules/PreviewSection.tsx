import {
  Alert,
  Badge,
  Box,
  Button,
  CloseButton,
  Drawer,
  Group,
  Pagination,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconFilterOff, IconInfoCircle, IconSearch, IconTable } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { SectionCard } from "@/components/SectionCard";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { KeyValue } from "@/components/KeyValue";
import { JsonView } from "@/components/JsonView";
import { CopyText } from "@/components/CopyText";
import { api, qs } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { fmtNumber } from "@/lib/format";
import { useDebounced, useIsMobile } from "@/lib/hooks";
import { PREVIEW_CONFIGS, str, type FilterDef, type PreviewPayload, type PreviewRow } from "./previewConfig";

function defaults(filters: FilterDef[]): Record<string, string> {
  return Object.fromEntries(filters.map((f) => [f.key, f.defaultValue]));
}

function DetailValue({ value }: { value: unknown }) {
  if (value === true) return <Badge color="teal" variant="light" size="sm">是</Badge>;
  if (value === false) return <Badge color="gray" variant="light" size="sm">否</Badge>;
  if (typeof value === "number") return <Text fz="sm">{fmtNumber(value)}</Text>;
  const s = str(value);
  if (!s) return null;
  if (s.length <= 40 && !/\s/.test(s)) return <CopyText value={s} mono />;
  return (
    <Text fz="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {s}
    </Text>
  );
}

export function PreviewSection({ moduleKey, hasData }: { moduleKey: string; hasData: boolean }) {
  const cfg = PREVIEW_CONFIGS[moduleKey];
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [params, setParams] = useState<Record<string, string>>(() => (cfg ? defaults(cfg.filters) : {}));
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<PreviewRow | null>(null);
  const q = useDebounced(search.trim(), 350);

  const reqParams = useMemo(
    () => ({ ...params, q, page: String(page), per_page: String(cfg?.perPage ?? 25) }),
    [params, q, page, cfg?.perPage],
  );

  const query = useQuery({
    queryKey: qk.modulePreview(moduleKey, reqParams),
    queryFn: () => api.get<PreviewPayload>(`/admin/api/modules/${moduleKey}/preview` + qs(reqParams)),
    enabled: Boolean(cfg) && hasData,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  if (!cfg) return null;

  const data = query.data;
  const setParam = (key: string, value: string) => {
    setParams((p) => ({ ...p, [key]: value }));
    setPage(1);
  };
  const isFiltered = Boolean(q) || cfg.filters.some((f) => (params[f.key] ?? f.defaultValue) !== f.defaultValue);
  const reset = () => {
    setParams(defaults(cfg.filters));
    setSearch("");
    setPage(1);
  };

  const cols = cfg.columns(params, data);
  const columns: Column<PreviewRow>[] = cols.map((c) => ({
    key: c.key,
    header: c.header,
    render: c.render ?? ((r) => str(r[c.key]) || "—"),
    hideOnMobile: c.hideOnMobile,
    primary: c.primary,
    align: c.align,
  }));

  const rows = data?.rows ?? [];
  const total = Number(data?.total ?? 0);
  const perPage = Number(data?.per_page ?? cfg.perPage) || cfg.perPage;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const isTreeRoot = data?.type === "tree_root";
  const hint = data ? cfg.hint?.(data, params) : null;

  const onRowClick = (row: PreviewRow) => {
    const drill = data ? cfg.drillDown?.(data, row) : null;
    if (drill) {
      setParams((p) => ({ ...p, ...drill }));
      setPage(1);
      return;
    }
    setDetail(row);
  };

  let body;
  if (!hasData) {
    body = <EmptyState compact icon={<IconTable size={20} />} title="尚無資料可預覽" description="完成匯入後，這裡可以搜尋與檢視實際寫入的資料列。" />;
  } else if (query.isError) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else if (data?.type === "empty") {
    body = <EmptyState compact title="資料尚未載入" description="此模組目前沒有資料，請先執行匯入。" />;
  } else if (data?.type === "error") {
    body = <ErrorState error={new Error(data.message ?? "預覽失敗")} onRetry={() => void query.refetch()} />;
  } else {
    body = (
      <Box style={{ opacity: query.isFetching && query.isPlaceholderData ? 0.6 : 1, transition: "opacity 120ms" }}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => cfg.rowKey(r, rows.indexOf(r))}
          loading={query.isPending}
          onRowClick={onRowClick}
          pageSize={isTreeRoot ? 25 : 0}
          minWidth={720}
          empty={
            <EmptyState
              compact
              icon={<IconSearch size={20} />}
              title="沒有符合條件的資料"
              description="試試其他關鍵字，或清除篩選條件。"
              action={
                isFiltered && (
                  <Button variant="light" size="xs" onClick={reset}>
                    清除篩選
                  </Button>
                )
              }
            />
          }
        />
        {!isTreeRoot && total > 0 && (
          <Group justify="space-between" px="md" py="sm" gap="xs" wrap="wrap">
            <Text fz="xs" c="dimmed">
              符合 {fmtNumber(total)} 筆
              {data?.total_all !== undefined && data.total_all !== total ? `（全部 ${fmtNumber(Number(data.total_all))} 筆）` : ""}
              ，第 {page} / {fmtNumber(pages)} 頁
            </Text>
            <Pagination size="sm" total={pages} value={Math.min(page, pages)} onChange={setPage} siblings={isMobile ? 0 : 1} boundaries={1} />
          </Group>
        )}
      </Box>
    );
  }

  return (
    <SectionCard
      title="資料預覽"
      icon={<IconTable size={18} />}
      description="直接查詢資料庫中已匯入的內容，用來驗證匯入結果。點選任一列可查看完整欄位。"
      flush
    >
      <Stack gap="sm" p="md" pb={0}>
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder={cfg.searchPlaceholder}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setPage(1);
          }}
          rightSection={search ? <CloseButton size="sm" aria-label="清除搜尋" onClick={() => setSearch("")} /> : null}
          disabled={!hasData}
        />
        {cfg.filters.length > 0 && (
          <Group gap="sm" wrap="wrap" align="flex-end">
            {cfg.filters
              .filter((f) => !f.visible || f.visible(params))
              .map((f) => {
                const options = typeof f.options === "function" ? f.options(data) : f.options;
                const value = params[f.key] ?? f.defaultValue;
                return f.kind === "segmented" ? (
                  <Stack key={f.key} gap={4}>
                    <Text fz="xs" c="dimmed" fw={600}>
                      {f.label}
                    </Text>
                    <SegmentedControl size="xs" data={options} value={value} onChange={(v) => setParam(f.key, v)} disabled={!hasData} />
                  </Stack>
                ) : (
                  <Select
                    key={f.key}
                    label={f.label}
                    size="xs"
                    data={options.some((o) => o.value === value) ? options : [...options, { value, label: value }]}
                    value={value}
                    onChange={(v) => setParam(f.key, v ?? f.defaultValue)}
                    searchable={f.searchable}
                    allowDeselect={false}
                    nothingFoundMessage="沒有符合的選項"
                    limit={200}
                    w={{ base: "100%", xs: 200 }}
                    comboboxProps={{ withinPortal: true }}
                    disabled={!hasData}
                  />
                );
              })}
            {isFiltered && (
              <Button variant="subtle" size="xs" color="gray" leftSection={<IconFilterOff size={14} />} onClick={reset}>
                清除篩選
              </Button>
            )}
          </Group>
        )}
        {hint && (
          <Alert color="blue" variant="light" p="xs" icon={<IconInfoCircle size={16} />}>
            <Text fz="xs">{hint}</Text>
          </Alert>
        )}
        {typeof data?.last_sync === "string" && data.last_sync && (
          <Text fz="xs" c="dimmed">
            上游資料最後更新：{data.last_sync}
          </Text>
        )}
      </Stack>
      <Box mt="sm">{body}</Box>

      <Drawer
        opened={detail !== null}
        onClose={() => setDetail(null)}
        position="right"
        size={isMobile ? "100%" : "lg"}
        title={
          <Text fw={650} fz="lg" lineClamp={2}>
            {detail ? cfg.title(detail) || "資料列" : ""}
          </Text>
        }
      >
        {detail && (
          <Stack gap="lg">
            <KeyValue
              cols={2}
              items={Object.entries(detail).map(([k, v]) => ({
                label: (
                  <>
                    {cfg.labels[k] ?? k}
                    {cfg.labels[k] && (
                      <Text span ff="monospace" fz={10} c="dimmed" ml={6}>
                        {k}
                      </Text>
                    )}
                  </>
                ),
                value: <DetailValue value={v} />,
                full: str(v).length > 60,
              }))}
            />
            <Stack gap={4}>
              <Text fz="xs" c="dimmed" fw={600}>
                原始 JSON
              </Text>
              <JsonView value={detail} maxHeight={280} />
            </Stack>
          </Stack>
        )}
      </Drawer>
    </SectionCard>
  );
}

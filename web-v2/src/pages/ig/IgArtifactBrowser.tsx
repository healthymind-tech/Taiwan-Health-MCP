import {
  Badge,
  Box,
  Button,
  Chip,
  CloseButton,
  Group,
  Pagination,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconArrowLeft, IconSearch } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { KeyValue } from "@/components/KeyValue";
import { CopyText } from "@/components/CopyText";
import { api, qs } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { fmtNumber } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { IgCodeSystemTree } from "@/pages/terminology/explorer/IgCodeSystemTree";
import type { IgArtifact, IgPreviewPayload } from "./igTypes";

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));

function usePreview(packageId: string, params: Record<string, string>, enabled = true) {
  const all = useMemo(() => ({ package_id: packageId, ...params }), [packageId, params]);
  return useQuery({
    queryKey: qk.modulePreview("ig", all),
    queryFn: () => api.get<IgPreviewPayload>("/admin/api/modules/ig/preview" + qs(all)),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

const PER_PAGE = 25;

/** Detail rows differ by resource type: concepts, profile elements, ValueSet members. */
function detailColumns(resourceType: string): Column<Row>[] {
  if (resourceType === "StructureDefinition") {
    return [
      {
        key: "path",
        header: "元素路徑",
        primary: true,
        render: (r) => (
          <Text fz="sm" ff="monospace" style={{ wordBreak: "break-all" }}>
            {s(r.path)}
            {s(r.slice_name) && <Text span c="dimmed">:{s(r.slice_name)}</Text>}
          </Text>
        ),
      },
      { key: "card", header: "基數", render: (r) => <Text fz="sm" ff="monospace">{s(r.cardinality)}</Text>, nowrap: true },
      { key: "type", header: "型別", render: (r) => <Text fz="xs" style={{ wordBreak: "break-word" }}>{s(r.type) || "—"}</Text>, hideOnMobile: true },
      {
        key: "flags",
        header: "旗標",
        render: (r) => (
          <Group gap={4}>
            {r.must_support === true && <Badge size="xs" color="brand">MS</Badge>}
            {r.is_modifier === true && <Badge size="xs" color="amber">?!</Badge>}
            {s(r.binding_strength) && <Badge size="xs" variant="outline" color="gray">{s(r.binding_strength)}</Badge>}
          </Group>
        ),
      },
      { key: "short", header: "說明", render: (r) => <Text fz="xs" lineClamp={2}>{s(r.short) || "—"}</Text>, hideOnMobile: true },
    ];
  }
  if (resourceType === "CodeSystem") {
    return [
      { key: "code", header: "Code", primary: true, render: (r) => <Text fz="sm" ff="monospace">{s(r.code)}</Text> },
      { key: "display", header: "Display", render: (r) => <Text fz="sm">{s(r.display) || "—"}</Text> },
      { key: "definition", header: "定義", render: (r) => <Text fz="xs" lineClamp={2}>{s(r.definition) || "—"}</Text>, hideOnMobile: true },
    ];
  }
  return [
    { key: "code", header: "Code", primary: true, render: (r) => <Text fz="sm" ff="monospace">{s(r.code) || "—"}</Text> },
    { key: "display", header: "Display", render: (r) => <Text fz="sm" style={{ wordBreak: "break-word" }}>{s(r.display) || "—"}</Text> },
    { key: "system", header: "System", render: (r) => <Text fz="xs" ff="monospace" style={{ wordBreak: "break-all" }}>{s(r.system) || "—"}</Text>, hideOnMobile: true },
    { key: "row_type", header: "來源", render: (r) => <Badge size="xs" variant="light" color="gray">{s(r.row_type) || "—"}</Badge> },
  ];
}

function ArtifactDetail({ packageId, artifactKey, onBack }: { packageId: string; artifactKey: string; onBack: () => void }) {
  const [page, setPage] = useState(1);
  const params = useMemo(() => ({ node: `artifact:${artifactKey}`, page: String(page), per_page: String(PER_PAGE) }), [artifactKey, page]);
  const q = usePreview(packageId, params);
  const d = q.data;
  const sel = d?.selected;
  const det = d?.detail ?? {};
  const total = Number(d?.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const rows = (d?.rows ?? []) as Row[];

  return (
    <Stack gap="md">
      <Group gap="xs">
        <Button variant="subtle" size="xs" leftSection={<IconArrowLeft size={14} />} onClick={onBack}>
          返回構件列表
        </Button>
      </Group>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton h={160} />
      ) : d?.type === "error" ? (
        <ErrorState error={new Error(d.message ?? "找不到構件")} />
      ) : sel ? (
        <>
          <Box>
            <Group gap={6} wrap="wrap">
              <Badge variant="light">{sel.resource_type}</Badge>
              {sel.status && <Badge variant="outline" color="gray">{sel.status}</Badge>}
            </Group>
            <Text fw={650} fz="lg" mt={6} style={{ wordBreak: "break-word" }}>
              {sel.title}
            </Text>
            {sel.description && (
              <Text fz="sm" c="dimmed" mt={4} lineClamp={6} style={{ whiteSpace: "pre-wrap" }}>
                {sel.description}
              </Text>
            )}
          </Box>
          <KeyValue
            cols={2}
            items={[
              { label: "Artifact key", value: <CopyText value={sel.artifact_key} mono /> },
              { label: "ID", value: <CopyText value={sel.artifact_id} mono /> },
              { label: "Canonical URL", value: <CopyText value={s(det.url)} mono />, full: true, hidden: !s(det.url) },
              { label: "基底", value: <CopyText value={s(det.base_definition)} mono />, full: true, hidden: !s(det.base_definition) },
              { label: "型別", value: s(det.type) || sel.base_type, hidden: !(s(det.type) || sel.base_type) },
              { label: "Derivation", value: sel.derivation, hidden: !sel.derivation },
              { label: "分組", value: sel.grouping_name || sel.grouping_id, hidden: !(sel.grouping_name || sel.grouping_id) },
              { label: "版本", value: s(det.version), hidden: !s(det.version) },
              { label: "Expression", value: <Text fz="xs" ff="monospace">{s(det.expression)}</Text>, full: true, hidden: !s(det.expression) },
            ]}
          />
          {sel.resource_type === "CodeSystem" && (
            <Stack gap={6}>
              <Text fw={600} fz="sm">
                概念階層
              </Text>
              <IgCodeSystemTree packageId={packageId} artifactKey={sel.artifact_key} />
            </Stack>
          )}
          {["StructureDefinition", "ValueSet"].includes(sel.resource_type) && (
            <Stack gap={6}>
              <Text fw={600} fz="sm">
                {sel.resource_type === "StructureDefinition" ? "元素（differential）" : sel.resource_type === "CodeSystem" ? "概念" : "允許的代碼"}
                <Text span c="dimmed" fz="xs" ml={6}>
                  共 {fmtNumber(total)} 筆
                </Text>
              </Text>
              <Box style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)", overflow: "hidden" }}>
                <DataTable
                  columns={detailColumns(sel.resource_type)}
                  rows={rows}
                  rowKey={(r) => `${s(r.id ?? r.element_id)}|${s(r.system)}|${s(r.code)}|${rows.indexOf(r)}`}
                  minWidth={560}
                  empty={<EmptyState compact title="沒有內容" />}
                />
              </Box>
              {pages > 1 && (
                <Group justify="flex-end">
                  <Pagination size="sm" total={pages} value={page} onChange={setPage} siblings={0} />
                </Group>
              )}
            </Stack>
          )}
        </>
      ) : null}
    </Stack>
  );
}

/** Artifacts of one IG, browsable by resource type with search. */
export function IgArtifactBrowser({ packageId }: { packageId: string }) {
  const [type, setType] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const q = useDebounced(search.trim(), 350);

  const root = usePreview(packageId, useMemo(() => ({}), []));
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of root.data?.tree ?? []) for (const c of g.children ?? []) m.set(c.resource_type, (m.get(c.resource_type) ?? 0) + Number(c.artifact_count ?? 0));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [root.data]);
  const selectedType = type ?? (typeCounts.find(([t]) => t === "StructureDefinition")?.[0] ?? typeCounts[0]?.[0] ?? null);

  const listParams = useMemo(
    () => ({ resource_type: selectedType ?? "", q, page: String(page), per_page: String(PER_PAGE) }),
    [selectedType, q, page],
  );
  const list = usePreview(packageId, listParams, Boolean(selectedType));

  if (openKey) return <ArtifactDetail packageId={packageId} artifactKey={openKey} onBack={() => setOpenKey(null)} />;

  if (root.isError) return <ErrorState error={root.error} onRetry={() => void root.refetch()} />;
  if (root.isPending) return <Skeleton h={200} />;
  if (root.data?.type === "empty" || root.data?.type === "error" || typeCounts.length === 0) {
    return <EmptyState compact title="沒有構件索引" description={root.data?.message ?? "此 IG 沒有可瀏覽的構件。"} />;
  }

  const rows = (list.data?.rows ?? []) as unknown as IgArtifact[];
  const total = Number(list.data?.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const columns: Column<IgArtifact>[] = [
    {
      key: "title",
      header: "名稱",
      primary: true,
      render: (a) => (
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text fz="sm" fw={600} style={{ wordBreak: "break-word" }}>
            {a.title}
          </Text>
          <Text fz="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
            {a.artifact_id}
          </Text>
        </Stack>
      ),
    },
    { key: "type", header: "類型", render: (a) => <Badge size="xs" variant="light">{a.resource_type}</Badge>, nowrap: true },
    { key: "base", header: "基底 / Kind", render: (a) => <Text fz="xs">{a.base_type || a.kind || "—"}</Text>, hideOnMobile: true },
    { key: "status", header: "狀態", render: (a) => <Text fz="xs">{a.status || "—"}</Text>, hideOnMobile: true },
  ];

  return (
    <Stack gap="sm">
      <ScrollArea type="never" offsetScrollbars={false}>
        <Chip.Group
          value={selectedType ?? ""}
          onChange={(v) => {
            setType(typeof v === "string" ? v : null);
            setPage(1);
          }}
        >
          <Group gap={6} wrap="wrap">
            {typeCounts.map(([t, n]) => (
              <Chip key={t} value={t} size="xs" variant="light">
                {t}（{fmtNumber(n)}）
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </ScrollArea>
      <TextInput
        leftSection={<IconSearch size={16} />}
        placeholder={`在 ${selectedType ?? "所有類型"} 中搜尋 ID、名稱、標題、URL`}
        value={search}
        onChange={(e) => {
          setSearch(e.currentTarget.value);
          setPage(1);
        }}
        rightSection={search ? <CloseButton size="sm" aria-label="清除搜尋" onClick={() => setSearch("")} /> : null}
      />
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <Box
          style={{
            border: "1px solid var(--mantine-color-default-border)",
            borderRadius: "var(--mantine-radius-md)",
            overflow: "hidden",
            opacity: list.isFetching && list.isPlaceholderData ? 0.6 : 1,
          }}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(a) => a.artifact_key}
            loading={list.isPending}
            onRowClick={(a) => setOpenKey(a.artifact_key)}
            minWidth={560}
            empty={<EmptyState compact icon={<IconSearch size={20} />} title="沒有符合的構件" description="換個關鍵字或類型試試。" />}
          />
        </Box>
      )}
      {total > 0 && (
        <Group justify="space-between" gap="xs" wrap="wrap">
          <Text fz="xs" c="dimmed">
            共 {fmtNumber(total)} 筆
          </Text>
          {pages > 1 && <Pagination size="sm" total={pages} value={Math.min(page, pages)} onChange={setPage} siblings={0} />}
        </Group>
      )}
    </Stack>
  );
}

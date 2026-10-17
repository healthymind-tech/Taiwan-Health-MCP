import { Badge, Button, Chip, CloseButton, Drawer, Group, Pill, Select, Stack, Text, TextInput } from "@mantine/core";
import { IconAdjustmentsHorizontal, IconSearch } from "@tabler/icons-react";
import { useState } from "react";
import { useIsMobile } from "@/lib/hooks";
import type { DepsFilter, IgFilters, IgSort, OriginFilter } from "./igFilters";
import { ORIGIN_LABEL } from "./igOriginBadge";

export interface FacetCounts {
  origin: { manual: number; dependency: number; unknown: number };
  deps: { missing: number; complete: number };
  fhir: { value: string; count: number }[];
  defaultOnly: number;
  examples: number;
}

export type FilterPatch = Partial<Record<"origin" | "deps" | "fhir" | "default" | "examples" | "sort", string | null>>;

const SORT_OPTIONS: { value: IgSort; label: string }[] = [
  { value: "name", label: "名稱（預設 IG 優先）" },
  { value: "recent", label: "最近安裝" },
  { value: "size", label: "內容最多" },
];

const DEPS_LABEL: Record<Exclude<DepsFilter, "">, string> = { missing: "有缺少相依", complete: "相依完整" };

/** Number of active (non-search, non-sort) filters. */
export function activeFilterCount(f: IgFilters): number {
  return [f.origin, f.deps, f.fhir, f.defaultOnly, f.examples].filter(Boolean).length;
}

function FilterControls({
  f,
  facets,
  onChange,
  stacked,
}: {
  f: IgFilters;
  facets: FacetCounts;
  onChange: (patch: FilterPatch) => void;
  stacked: boolean;
}) {
  const w = stacked ? undefined : 170;
  const comboboxProps = { withinPortal: true, floatingStrategy: "fixed" as const };
  return (
    <>
      <Select
        label={stacked ? "安裝方式" : undefined}
        aria-label="安裝方式"
        placeholder="所有安裝方式"
        value={f.origin || null}
        onChange={(v) => onChange({ origin: (v as OriginFilter) || null })}
        data={[
          { value: "manual", label: `${ORIGIN_LABEL.manual}（${facets.origin.manual}）` },
          { value: "dependency", label: `${ORIGIN_LABEL.dependency}（${facets.origin.dependency}）` },
        ]}
        clearable
        w={w}
        comboboxProps={comboboxProps}
      />
      <Select
        label={stacked ? "相依狀態" : undefined}
        aria-label="相依狀態"
        placeholder="所有相依狀態"
        value={f.deps || null}
        onChange={(v) => onChange({ deps: (v as DepsFilter) || null })}
        data={[
          { value: "missing", label: `${DEPS_LABEL.missing}（${facets.deps.missing}）` },
          { value: "complete", label: `${DEPS_LABEL.complete}（${facets.deps.complete}）` },
        ]}
        clearable
        w={w}
        comboboxProps={comboboxProps}
      />
      <Select
        label={stacked ? "FHIR 版本" : undefined}
        aria-label="FHIR 版本"
        placeholder="所有 FHIR 版本"
        value={f.fhir || null}
        onChange={(v) => onChange({ fhir: v || null })}
        data={facets.fhir.map((o) => ({ value: o.value, label: `FHIR ${o.value}（${o.count}）` }))}
        clearable
        w={w}
        comboboxProps={comboboxProps}
      />
      <Group gap={6} wrap="wrap" role="group" aria-label="其他篩選">
        <Chip size="sm" checked={f.defaultOnly} onChange={(c) => onChange({ default: c ? "1" : null })}>
          預設 IG
        </Chip>
        <Chip size="sm" checked={f.examples} onChange={(c) => onChange({ examples: c ? "1" : null })}>
          含範例（{facets.examples}）
        </Chip>
      </Group>
    </>
  );
}

/** Search box, filters (inline on desktop, a drawer on phones), sort and the active-filter pills. */
export function IgFilterBar({
  f,
  search,
  onSearch,
  facets,
  onChange,
  onClearAll,
  resultCount,
}: {
  f: IgFilters;
  search: string;
  onSearch: (q: string) => void;
  facets: FacetCounts;
  onChange: (patch: FilterPatch) => void;
  onClearAll: () => void;
  resultCount: number;
}) {
  const isMobile = useIsMobile();
  const [drawer, setDrawer] = useState(false);
  const active = activeFilterCount(f);

  const pills: { key: string; label: string; clear: FilterPatch }[] = [
    ...(f.origin ? [{ key: "origin", label: `安裝方式：${ORIGIN_LABEL[f.origin]}`, clear: { origin: null } }] : []),
    ...(f.deps ? [{ key: "deps", label: `相依：${DEPS_LABEL[f.deps]}`, clear: { deps: null } }] : []),
    ...(f.fhir ? [{ key: "fhir", label: `FHIR ${f.fhir}`, clear: { fhir: null } }] : []),
    ...(f.defaultOnly ? [{ key: "default", label: "預設 IG", clear: { default: null } }] : []),
    ...(f.examples ? [{ key: "examples", label: "含範例", clear: { examples: null } }] : []),
  ];

  const sortSelect = (
    <Select
      label={isMobile ? "排序" : undefined}
      aria-label="排序"
      value={f.sort}
      onChange={(v) => onChange({ sort: v && v !== "name" ? v : null })}
      data={SORT_OPTIONS}
      allowDeselect={false}
      w={isMobile ? undefined : 190}
      comboboxProps={{ withinPortal: true, floatingStrategy: "fixed" }}
    />
  );

  return (
    <Stack gap="xs">
      <Group gap="sm" wrap={isMobile ? "nowrap" : "wrap"} align="center">
        <TextInput
          placeholder="搜尋名稱、Package ID、Canonical、版本、說明…"
          aria-label="搜尋 IG"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => onSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && search) {
              e.stopPropagation();
              onSearch("");
            }
          }}
          rightSection={search ? <CloseButton size="sm" aria-label="清除搜尋" onClick={() => onSearch("")} /> : null}
          style={{ flex: "1 1 240px", minWidth: 0 }}
        />
        {isMobile ? (
          <Button
            variant={active ? "light" : "default"}
            leftSection={<IconAdjustmentsHorizontal size={16} />}
            rightSection={active ? <Badge size="xs" circle>{active}</Badge> : null}
            onClick={() => setDrawer(true)}
            aria-label={active ? `篩選與排序（已套用 ${active} 個篩選）` : "篩選與排序"}
            style={{ flexShrink: 0 }}
          >
            篩選
          </Button>
        ) : (
          <>
            <FilterControls f={f} facets={facets} onChange={onChange} stacked={false} />
            <Group gap="xs" ml="auto" wrap="nowrap">
              <Text fz="xs" c="dimmed" visibleFrom="lg">
                排序
              </Text>
              {sortSelect}
            </Group>
          </>
        )}
      </Group>

      {(pills.length > 0 || f.q) && (
        <Group gap={6} wrap="wrap" aria-label="已套用的篩選">
          {f.q && (
            <Pill withRemoveButton onRemove={() => onSearch("")} removeButtonProps={{ tabIndex: 0, "aria-hidden": false, "aria-label": "移除搜尋條件" }}>
              搜尋：{f.q}
            </Pill>
          )}
          {pills.map((p) => (
            <Pill key={p.key} withRemoveButton onRemove={() => onChange(p.clear)} removeButtonProps={{ tabIndex: 0, "aria-hidden": false, "aria-label": `移除篩選「${p.label}」` }}>
              {p.label}
            </Pill>
          ))}
          <Button variant="subtle" color="gray" size="compact-xs" onClick={onClearAll}>
            全部清除
          </Button>
        </Group>
      )}

      <Drawer
        opened={drawer}
        onClose={() => setDrawer(false)}
        position="bottom"
        size="auto"
        title={
          <Group gap="xs">
            <IconAdjustmentsHorizontal size={18} />
            <Text fw={650}>篩選與排序</Text>
          </Group>
        }
      >
        <Stack gap="md" pb="md">
          <FilterControls f={f} facets={facets} onChange={onChange} stacked />
          {sortSelect}
          <Group grow gap="sm">
            <Button variant="default" onClick={onClearAll} disabled={!active && !f.q}>
              清除篩選
            </Button>
            <Button onClick={() => setDrawer(false)}>顯示 {resultCount} 個結果</Button>
          </Group>
        </Stack>
      </Drawer>
    </Stack>
  );
}


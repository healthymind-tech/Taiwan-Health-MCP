import { Badge, Box, Button, Chip, CloseButton, Group, Kbd, ScrollArea, Select, Skeleton, Stack, Text, TextInput } from "@mantine/core";
import { IconCategory, IconFilterOff, IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { fmtNumber } from "@/lib/format";
import { useDebounced, useIsMobile } from "@/lib/hooks";
import type { IgRef } from "./igTypes";
import { ArtifactDrawer } from "./detail/ArtifactDrawer";
import { ExampleList, ExtensionGrid, GenericList, ProfileGrid, SearchParamTable, TerminologyList, type ViewProps } from "./detail/ArtifactViews";
import { CATEGORY_META, CATEGORY_ORDER, DP, isCategory, useDetailParams } from "./detail/detailMeta";
import { useIgArtifacts, useIgOverview, type ArtifactItem, type Category, type CategoryCount } from "./detail/explorerApi";
import classes from "./detail/detail.module.css";

const ALL = "all";
const PAGE = 300;

const VIEW: Record<Category, (p: ViewProps) => JSX.Element> = {
  profile: ProfileGrid,
  datatype: ProfileGrid,
  logical: ProfileGrid,
  base: ProfileGrid,
  extension: ExtensionGrid,
  terminology: TerminologyList,
  search: SearchParamTable,
  example: ExampleList,
  capability: GenericList,
};

function groupLabel(cat: Category, key: string): string {
  if (!key) return cat === "logical" ? "邏輯模型" : cat === "extension" ? "未宣告使用位置" : "其他";
  return key;
}

interface Segment {
  key: string;
  cat: Category;
  group: string;
  /** Singleton groups merged into one segment ("其他"). */
  merged: boolean;
  items: ArtifactItem[];
}

/**
 * Items in server order, split into (category, group) runs. Within a category,
 * groups of one item are merged into a trailing "其他" segment so a long tail
 * of one-profile resources renders as one grid instead of one card per row.
 */
export function segmentsOf(items: ArtifactItem[], byCategory: boolean): Segment[] {
  const runs: Segment[] = [];
  for (const it of items) {
    const k = byCategory ? it.category : `${it.category}|${it.group}`;
    const last = runs[runs.length - 1];
    if (last && last.key === k) last.items.push(it);
    else runs.push({ key: k, cat: it.category, group: it.group, merged: false, items: [it] });
  }
  if (byCategory) return runs;
  const big = runs.filter((r) => r.items.length > 1);
  const singles = runs.filter((r) => r.items.length === 1);
  if (singles.length < 2) return runs;
  return [...big, { key: `${singles[0].cat}|~merged`, cat: singles[0].cat, group: "", merged: true, items: singles.flatMap((r) => r.items) }];
}

const CHIP_LIMIT = 12;

function Rail({ facets, active, onPick, searching, total }: { facets: CategoryCount[]; active: string; onPick: (c: string) => void; searching: boolean; total: number }) {
  const count = (c: Category) => facets.find((f) => f.key === c)?.count ?? 0;
  const present = CATEGORY_ORDER.filter((c) => count(c) > 0 || c === active);
  const items: { key: string; label: string; n: number; color?: string; icon?: ReactNode }[] = [
    ...(searching ? [{ key: ALL, label: "全部分類", n: total, icon: <IconCategory size={16} /> }] : []),
    ...present.map((c) => ({ key: c, label: CATEGORY_META[c].label, n: count(c), color: CATEGORY_META[c].color, icon: CATEGORY_META[c].icon(16) })),
  ];
  return (
    <Stack gap={2} role="tablist" aria-orientation="vertical" aria-label="構件分類">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="tab"
          aria-selected={active === it.key}
          className={classes.railItem}
          data-active={active === it.key || undefined}
          data-disabled={it.n === 0 || undefined}
          style={{ ["--rail-color" as string]: it.color }}
          onClick={() => onPick(it.key)}
        >
          <Box c={it.color ? undefined : "dimmed"} style={{ display: "flex", color: it.color }}>
            {it.icon}
          </Box>
          <Text fz="sm" style={{ flex: 1, minWidth: 0 }} truncate>
            {it.label}
          </Text>
          <Text fz="xs" c="dimmed" className="tabular">
            {fmtNumber(it.n)}
          </Text>
        </button>
      ))}
    </Stack>
  );
}

/** 構件: category rail + per-category presentation, URL-synced (cat / grp / aq / art). */
export function IgArtifactBrowser({ ig, onOpenCodeSystem }: { ig: IgRef; onOpenCodeSystem: (csId: string) => void }) {
  const isMobile = useIsMobile();
  const { get, patch } = useDetailParams();
  const urlQ = get(DP.q) ?? "";
  const [search, setSearch] = useState(urlQ);
  const debounced = useDebounced(search.trim(), 300);
  const [limit, setLimit] = useState(PAGE);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (debounced !== urlQ) patch({ [DP.q]: debounced || null, [DP.group]: null }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => {
    setSearch((cur) => (cur.trim() === urlQ ? cur : urlQ));
  }, [urlQ]);

  const overview = useIgOverview(ig);
  const searching = urlQ !== "";
  const catParam = get(DP.cat);
  const firstCat = overview.data?.categories[0]?.key ?? "profile";
  const cat: string = catParam === ALL && searching ? ALL : isCategory(catParam) ? catParam : searching ? ALL : firstCat;
  const group = cat !== ALL ? get(DP.group) : null;
  const artKey = get(DP.artifact);

  useEffect(() => setLimit(PAGE), [cat, group, urlQ]);

  const list = useIgArtifacts(ig, { category: cat === ALL ? "" : cat, group, q: urlQ, limit }, Boolean(overview.data) || Boolean(catParam));
  const data = list.data;
  const facets = data?.facets ?? overview.data?.categories ?? [];
  const facetTotal = facets.reduce((n, f) => n + f.count, 0);
  const groups = data?.groups ?? [];

  // "/" focuses the search box (outside inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pick = (c: string) => patch({ [DP.cat]: c === firstCat && !searching ? null : c, [DP.group]: null });
  const open = (key: string) => patch({ [DP.artifact]: key });
  const segments = useMemo(() => segmentsOf(data?.items ?? [], cat === ALL), [data?.items, cat]);
  const [allChips, setAllChips] = useState(false);
  useEffect(() => setAllChips(false), [cat]);
  const chipGroups = allChips || groups.length <= CHIP_LIMIT + 2 ? groups : groups.slice(0, CHIP_LIMIT);
  const showGroupHeads = cat === ALL || (!group && groups.length > 1);

  if (overview.isError) return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;
  if (overview.data && overview.data.total === 0) return <EmptyState title="此 IG 沒有構件" description="套件中沒有可瀏覽的 FHIR 資源。" />;

  return (
    <div className={classes.layout}>
      <Box className={isMobile ? undefined : classes.rail}>
        {isMobile ? (
          <Select
            aria-label="構件分類"
            value={cat}
            onChange={(v) => v && pick(v)}
            allowDeselect={false}
            data={[
              ...(searching ? [{ value: ALL, label: `全部分類（${facetTotal}）` }] : []),
              ...CATEGORY_ORDER.filter((c) => facets.some((f) => f.key === c && f.count > 0) || c === cat).map((c) => ({
                value: c,
                label: `${CATEGORY_META[c].label}（${facets.find((f) => f.key === c)?.count ?? 0}）`,
              })),
            ]}
            comboboxProps={{ withinPortal: true }}
          />
        ) : !overview.data && !data ? (
          <Stack gap={6}>
            {Array.from({ length: 7 }, (_, i) => (
              <Skeleton key={i} h={34} />
            ))}
          </Stack>
        ) : (
          <Rail facets={facets} active={cat} onPick={pick} searching={searching} total={facetTotal} />
        )}
      </Box>

      <Stack gap="md" style={{ minWidth: 0 }}>
        <TextInput
          ref={inputRef}
          leftSection={<IconSearch size={16} />}
          placeholder="搜尋所有構件：ID、名稱、標題、canonical、說明"
          aria-label="搜尋構件"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && search) {
              e.stopPropagation();
              setSearch("");
            }
          }}
          rightSectionWidth={search ? 36 : 44}
          rightSection={search ? <CloseButton size="sm" aria-label="清除搜尋" onClick={() => setSearch("")} /> : isMobile ? null : <Kbd size="xs">/</Kbd>}
        />

        {cat !== ALL && isCategory(cat) && (
          <Group justify="space-between" gap="xs" wrap="wrap" className={classes.fadeUp} key={cat}>
            <Box style={{ minWidth: 0 }}>
              <Group gap={8}>
                <span className={classes.swatch} style={{ background: CATEGORY_META[cat].color }} />
                <Text fw={650}>{CATEGORY_META[cat].label}</Text>
                <Badge variant="light" color="gray">
                  {fmtNumber(data?.total ?? facets.find((f) => f.key === cat)?.count ?? 0)}
                </Badge>
              </Group>
              <Text fz="xs" c="dimmed" mt={2}>
                {CATEGORY_META[cat].hint}
              </Text>
            </Box>
          </Group>
        )}

        {cat !== ALL && groups.length > 1 && (
          <ScrollArea type="auto" offsetScrollbars scrollbarSize={6}>
            <Chip.Group value={group ?? ""} onChange={(v) => patch({ [DP.group]: typeof v === "string" && v !== "" ? v : null })}>
              <Group gap={6} wrap={isMobile ? "nowrap" : "wrap"}>
                <Chip value="" size="xs" variant="light" checked={group === null} onClick={() => patch({ [DP.group]: null })}>
                  全部（{fmtNumber(groups.reduce((n, g) => n + g.count, 0))}）
                </Chip>
                {chipGroups.map((g) => (
                  <Chip key={g.key || "∅"} value={g.key} size="xs" variant="light">
                    {groupLabel(cat as Category, g.key)}（{fmtNumber(g.count)}）
                  </Chip>
                ))}
                {chipGroups.length < groups.length && (
                  <Button size="compact-xs" variant="subtle" onClick={() => setAllChips(true)}>
                    再顯示 {groups.length - chipGroups.length} 個
                  </Button>
                )}
              </Group>
            </Chip.Group>
          </ScrollArea>
        )}

        <Text fz="xs" c="dimmed" aria-live="polite">
          {data ? (searching ? `「${urlQ}」：${cat === ALL ? "全部分類" : CATEGORY_META[cat as Category]?.label} 共 ${fmtNumber(data.total)} 筆` : `共 ${fmtNumber(data.total)} 筆`) : " "}
        </Text>

        {list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !data ? (
          <Stack gap="sm">
            <Skeleton h={24} w={180} />
            <Group grow>
              <Skeleton h={120} />
              <Skeleton h={120} />
            </Group>
            <Group grow>
              <Skeleton h={120} />
              <Skeleton h={120} />
            </Group>
          </Stack>
        ) : data.items.length === 0 ? (
          <EmptyState
            compact
            icon={<IconFilterOff size={20} />}
            title={searching ? "沒有符合的構件" : "這個分類沒有構件"}
            description={searching ? "換個關鍵字，或切到「全部分類」。" : undefined}
            action={
              searching ? (
                <Button variant="light" size="xs" onClick={() => setSearch("")}>
                  清除搜尋
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Stack gap="lg" style={{ opacity: list.isPlaceholderData ? 0.55 : 1, transition: "opacity 150ms ease" }}>
            {segments.map((s) => {
              const View = VIEW[s.cat];
              return (
                <Stack key={s.key} gap="xs">
                  {showGroupHeads && (
                    <Group gap={8} className={classes.groupHead}>
                      {cat === ALL && <span className={classes.swatch} style={{ background: CATEGORY_META[s.cat].color }} />}
                      <Text fz="sm" fw={650}>
                        {cat === ALL ? CATEGORY_META[s.cat].label : s.merged ? "其他（各 1 個）" : groupLabel(s.cat, s.group)}
                      </Text>
                      <Text fz="xs" c="dimmed" className="tabular">
                        {cat === ALL || s.merged ? `${s.items.length}` : `${groups.find((g) => g.key === s.group)?.count ?? s.items.length}`}
                      </Text>
                    </Group>
                  )}
                  <View ig={ig} showGroup={s.merged || cat === ALL} items={s.items} resolved={data.resolved ?? {}} activeKey={artKey} onOpen={open} onOpenCodeSystem={onOpenCodeSystem} />
                </Stack>
              );
            })}
            {data.items.length < data.total && (
              <Group justify="center">
                <Button variant="default" loading={list.isFetching} onClick={() => setLimit((n) => Math.min(1000, n + PAGE))} disabled={limit >= 1000}>
                  {limit >= 1000 ? `僅顯示前 1,000 筆，請用搜尋縮小範圍` : `再載入（已顯示 ${fmtNumber(data.items.length)} / ${fmtNumber(data.total)}）`}
                </Button>
              </Group>
            )}
          </Stack>
        )}
      </Stack>

      <ArtifactDrawer ig={ig} artifactKey={artKey} onClose={() => patch({ [DP.artifact]: null })} onOpenArtifact={open} onOpenCodeSystem={onOpenCodeSystem} />
    </div>
  );
}

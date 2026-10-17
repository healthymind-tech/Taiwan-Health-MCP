import { Alert, Anchor, Badge, Box, Button, CloseButton, Collapse, Drawer, Group, Pagination, ScrollArea, Skeleton, Stack, Text, TextInput, Tooltip, UnstyledButton } from "@mantine/core";
import { IconArrowRight, IconChevronDown, IconChevronRight, IconFilterOff, IconInfoCircle, IconListDetails, IconSearch } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import { CopyText } from "@/components/CopyText";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { fmtNumber } from "@/lib/format";
import { useDebounced, useIsMobile } from "@/lib/hooks";
import { Hl, Panel } from "./parts";
import { LOINC_AXES, LOINC_FACET_KEYS, termGet, tk, type FacetValue, type LoincAxis, type LoincFacetKey, type LoincFacets, type LoincRow, type LoincTerm } from "./termApi";
import classes from "./explorer.module.css";

export const AXIS_META: Record<LoincFacetKey, { zh: string; en: string; color: string; col: keyof LoincRow }> = {
  component: { zh: "成分", en: "Component", color: "var(--mantine-color-brand-6)", col: "component" },
  property: { zh: "屬性", en: "Property", color: "var(--mantine-color-indigo-6)", col: "property" },
  time: { zh: "時間", en: "Time", color: "var(--mantine-color-violet-6)", col: "time_aspect" },
  system: { zh: "檢體系統", en: "System", color: "var(--mantine-color-teal-6)", col: "system" },
  scale: { zh: "尺度", en: "Scale", color: "var(--mantine-color-orange-6)", col: "scale_type" },
  method: { zh: "方法", en: "Method", color: "var(--mantine-color-pink-6)", col: "method_type" },
  class: { zh: "類別", en: "Class", color: "var(--mantine-color-cyan-7)", col: "class" },
  status: { zh: "狀態", en: "Status", color: "var(--mantine-color-gray-6)", col: "status" },
};

const STATUS_COLOR: Record<string, string> = { ACTIVE: "teal", DEPRECATED: "red", DISCOURAGED: "orange", TRIAL: "blue" };

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return (
    <Badge size="sm" variant="light" color={STATUS_COLOR[status] ?? "gray"}>
      {status}
    </Badge>
  );
}

function MiniAxis({ r }: { r: LoincRow }) {
  return (
    <div className={classes.miniAxis}>
      {LOINC_AXES.map((a) => {
        const v = String(r[AXIS_META[a].col] ?? "");
        if (!v) return null;
        return (
          <span key={a} style={{ "--ax": AXIS_META[a].color } as CSSProperties} title={`${AXIS_META[a].zh}：${v}`}>
            {v}
          </span>
        );
      })}
    </div>
  );
}

export function LoincExplorer() {
  const isMobile = useIsMobile();
  const [sp, setSp] = useSearchParams();
  const code = sp.get("code");
  const filters = useMemo(() => {
    const f: Partial<Record<LoincFacetKey, string>> = {};
    for (const k of LOINC_FACET_KEYS) {
      const v = sp.get(`f_${k}`);
      if (v) f[k] = v;
    }
    return f;
  }, [sp]);
  const [text, setText] = useState(sp.get("q") ?? "");
  const q = useDebounced(text.trim(), 300);
  const [page, setPage] = useState(1);
  const [facetsOpen, setFacetsOpen] = useState(!isMobile);

  const params = useMemo(() => ({ ...filters, q, page, per_page: 20 }), [filters, q, page]);
  const res = useQuery({
    queryKey: tk("loinc-facets", params),
    queryFn: () => termGet<LoincFacets>("loinc/facets", params),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const setFilter = (k: LoincFacetKey, v: string | null) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(`f_${k}`, v);
    else next.delete(`f_${k}`);
    setSp(next, { replace: true });
    setPage(1);
  };
  const clearAll = () => {
    const next = new URLSearchParams(sp);
    for (const k of LOINC_FACET_KEYS) next.delete(`f_${k}`);
    setSp(next, { replace: true });
    setText("");
    setPage(1);
  };
  const openTerm = (c: string | null) => {
    const next = new URLSearchParams(sp);
    if (c) next.set("code", c);
    else next.delete("code");
    setSp(next, { replace: true });
  };

  const d = res.data;
  const active = Object.entries(filters) as [LoincFacetKey, string][];

  const facetPanel = (
    <Stack gap="md" p="sm">
      {LOINC_FACET_KEYS.map((k) => (
        <FacetGroup key={k} facet={k} values={d?.facets[k] ?? []} truncated={Boolean(d?.facets_truncated[k])} active={filters[k] ?? null} onPick={(v) => setFilter(k, filters[k] === v ? null : v)} loading={!d} filters={{ ...filters, q }} />
      ))}
    </Stack>
  );

  return (
    <Stack gap="sm">
      <TextInput
        leftSection={<IconSearch size={16} />}
        placeholder="搜尋 LOINC：2345-7、glucose、HbA1c、血糖…"
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          setPage(1);
        }}
        rightSection={text ? <CloseButton size="sm" aria-label="清除搜尋" onClick={() => setText("")} /> : null}
      />
      {active.length > 0 && (
        <Group gap={6}>
          {active.map(([k, v]) => (
            <Badge
              key={k}
              size="lg"
              variant="light"
              tt="none"
              style={{ color: AXIS_META[k].color, background: `color-mix(in srgb, ${AXIS_META[k].color} 12%, transparent)` }}
              rightSection={<CloseButton size="xs" aria-label={`移除 ${AXIS_META[k].zh}`} onClick={() => setFilter(k, null)} />}
            >
              {AXIS_META[k].zh}：{v === "∅" ? "（空白）" : v}
            </Badge>
          ))}
          <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconFilterOff size={12} />} onClick={clearAll}>
            清除全部
          </Button>
        </Group>
      )}
      <div className={classes.shell} style={{ gridTemplateColumns: isMobile ? undefined : "minmax(250px, 0.42fr) minmax(0, 1.58fr)" }}>
        <Panel
          title="多軸篩選"
          right={
            isMobile ? (
              <Button size="compact-xs" variant="subtle" onClick={() => setFacetsOpen((o) => !o)} rightSection={facetsOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}>
                {facetsOpen ? "收合" : "展開"}
              </Button>
            ) : null
          }
        >
          {isMobile ? <Collapse in={facetsOpen}>{facetPanel}</Collapse> : <ScrollArea h={680}>{facetPanel}</ScrollArea>}
        </Panel>
        <Panel title={d ? `${fmtNumber(d.total)} 個 LOINC 術語` : "LOINC 術語"} right={<Text fz={11} c="dimmed">點選查看六軸與答案清單</Text>}>
          {res.isError ? (
            <ErrorState error={res.error} onRetry={() => void res.refetch()} />
          ) : !d ? (
            <Stack p="md" gap="sm">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} h={54} radius="md" />
              ))}
            </Stack>
          ) : d.rows.length === 0 ? (
            <EmptyState compact icon={<IconSearch size={20} />} title="沒有符合條件的術語" description="移除部分篩選或換個關鍵字。" />
          ) : (
            <Box style={{ opacity: res.isPlaceholderData ? 0.55 : 1, transition: "opacity 140ms" }}>
              {d.rows.map((r, i) => (
                <UnstyledButton key={r.loinc_num} className={`${classes.drillItem} ${classes.nestedItem}`} style={{ width: "100%", animationDelay: `${i * 18}ms`, alignItems: "flex-start" }} data-selected={r.loinc_num === code || undefined} onClick={() => openTerm(r.loinc_num)}>
                  <Text span className={classes.code} w={74} style={{ flex: "0 0 auto" }}>
                    {r.loinc_num}
                  </Text>
                  <Box style={{ minWidth: 0, flex: 1 }}>
                    <Group gap={6} wrap="nowrap">
                      <Text fz="sm" fw={550} lineClamp={1} style={{ flex: 1 }}>
                        <Hl text={r.long_common_name} q={q} />
                      </Text>
                      {r.status !== "ACTIVE" && <StatusBadge status={r.status} />}
                    </Group>
                    {r.name_zh && (
                      <Text fz="xs" c="brand" fw={600}>
                        <Hl text={r.name_zh} q={q} />
                      </Text>
                    )}
                    <Box mt={4}>
                      <MiniAxis r={r} />
                    </Box>
                  </Box>
                </UnstyledButton>
              ))}
              {d.total > d.per_page && (
                <Group justify="space-between" p="sm">
                  <Text fz="xs" c="dimmed">
                    第 {page} / {fmtNumber(Math.ceil(d.total / d.per_page))} 頁
                  </Text>
                  <Pagination size="sm" total={Math.ceil(d.total / d.per_page)} value={page} onChange={setPage} siblings={isMobile ? 0 : 1} />
                </Group>
              )}
            </Box>
          )}
        </Panel>
      </div>
      <Drawer
        opened={Boolean(code)}
        onClose={() => openTerm(null)}
        position="right"
        size={isMobile ? "100%" : "min(860px, 70vw)"}
        title={
          <Group gap={8}>
            <IconListDetails size={18} />
            <Text fw={650}>LOINC 術語</Text>
          </Group>
        }
        transitionProps={{ transition: "slide-left", duration: 260 }}
      >
        {code && (
          <TermView
            code={code}
            onOpen={openTerm}
            onFilter={(k, v) => {
              openTerm(null);
              setFilter(k, v);
            }}
          />
        )}
      </Drawer>
    </Stack>
  );
}

function FacetGroup({
  facet,
  values,
  truncated,
  active,
  onPick,
  loading,
  filters,
}: {
  facet: LoincFacetKey;
  values: FacetValue[];
  truncated: boolean;
  active: string | null;
  onPick: (v: string) => void;
  loading: boolean;
  filters: Record<string, string>;
}) {
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState("");
  const s = useDebounced(search.trim(), 250);
  const meta = AXIS_META[facet];
  const found = useQuery({
    queryKey: tk("loinc-fv", facet, s, filters),
    queryFn: () => termGet<{ items: FacetValue[] }>("loinc/facet-values", { facet, search: s, ...filters }).then((r) => r.items),
    enabled: more && s.length > 0,
    staleTime: 60_000,
  });
  const list = more && s ? (found.data ?? []) : more ? values : values.slice(0, 7);
  const max = Math.max(1, ...values.map((v) => v.count));
  return (
    <Box>
      <Group gap={6} mb={4}>
        <span className={classes.kindDot} style={{ background: meta.color }} />
        <Text fz="xs" fw={700}>
          {meta.zh}
        </Text>
        <Text fz={10.5} c="dimmed">
          {meta.en}
        </Text>
      </Group>
      {loading ? (
        <Skeleton h={80} />
      ) : (
        <Stack gap={2}>
          {more && (
            <TextInput size="xs" placeholder={`搜尋${meta.zh}…`} value={search} onChange={(e) => setSearch(e.currentTarget.value)} mb={4} />
          )}
          {list.map((v) => (
            <UnstyledButton
              key={v.value}
              className={classes.facetRow}
              data-active={active === v.value || undefined}
              style={{ "--ax": meta.color, "--w": `${(v.count / max) * 100}%` } as CSSProperties}
              onClick={() => onPick(v.value)}
            >
              <Text span fz={12.5} truncate>
                {v.value === "∅" ? "（空白）" : v.value}
              </Text>
              <Text span fz={11} c="dimmed" className="tabular">
                {fmtNumber(v.count)}
              </Text>
            </UnstyledButton>
          ))}
          {(values.length > 7 || truncated) && (
            <UnstyledButton fz={11} c="brand" onClick={() => setMore((m) => !m)} px={8}>
              {more ? "收合" : `顯示更多${truncated ? "／搜尋" : ""}`}
            </UnstyledButton>
          )}
        </Stack>
      )}
    </Box>
  );
}

function fmtNum(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
}

function RangeChart({ ranges }: { ranges: LoincTerm["reference_ranges"] }) {
  const vals = ranges.flatMap((r) => [r.low, r.high]).filter((v): v is number => v !== null && v !== undefined);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.35 || Math.abs(hi) * 0.5 || 1;
  const min = Math.max(0, lo - pad);
  const max = hi + pad;
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  const gender = (g: string) => (g === "M" ? "男" : g === "F" ? "女" : "不分");
  return (
    <Stack gap={10}>
      {ranges.map((r, i) => (
        <Box key={i}>
          <Group justify="space-between" mb={4} gap={4}>
            <Text fz="xs" fw={600}>
              {gender(r.gender)} · {r.age_min}–{r.age_max} 歲 {r.interpretation ? `· ${r.interpretation}` : ""}
            </Text>
            <Text fz="xs" c="dimmed" className="tabular">
              {fmtNum(r.low)} – {fmtNum(r.high)} {r.unit ?? ""}
            </Text>
          </Group>
          <div className={classes.rangeTrack} role="img" aria-label={`${fmtNum(r.low)} 到 ${fmtNum(r.high)} ${r.unit ?? ""}`}>
            <div className={classes.rangeBand} style={{ left: `${pct(r.low ?? min)}%`, width: `${Math.max(2, pct(r.high ?? max) - pct(r.low ?? min))}%`, animationDelay: `${i * 90}ms` }}>
              <span>{fmtNum(r.low)}</span>
              <span>{fmtNum(r.high)}</span>
            </div>
          </div>
        </Box>
      ))}
      <Group justify="space-between">
        <Text fz={10} c="dimmed" className="tabular">
          {fmtNum(Number(min.toFixed(2)))}
        </Text>
        <Text fz={10} c="dimmed" className="tabular">
          {fmtNum(Number(max.toFixed(2)))} {ranges[0]?.unit ?? ""}
        </Text>
      </Group>
    </Stack>
  );
}

function PanelMembers({ code, onOpen, depth = 0 }: { code: string; onOpen: (c: string) => void; depth?: number }) {
  const q = useQuery({ queryKey: tk("loinc-term", code), queryFn: () => termGet<LoincTerm>("loinc/term", { code }), staleTime: 5 * 60_000 });
  if (q.isPending) return <Skeleton h={60} ml={depth ? 14 : 0} />;
  if (q.isError) return <Text fz="xs" c="red">{String(q.error)}</Text>;
  return (
    <div className={classes.nested}>
      {q.data.panel_items.map((it, i) => (
        <PanelItem key={`${it.loinc_num}-${i}`} it={it} onOpen={onOpen} depth={depth} index={i} />
      ))}
    </div>
  );
}

function PanelItem({ it, onOpen, depth, index }: { it: LoincTerm["panel_items"][number]; onOpen: (c: string) => void; depth: number; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={classes.nestedItem} style={{ animationDelay: `${Math.min(index, 20) * 20}ms` }}>
      <Group gap={6} wrap="nowrap" align="flex-start">
        {it.is_panel && depth < 4 ? (
          <UnstyledButton onClick={() => setOpen((o) => !o)} aria-label={open ? "收合子面板" : "展開子面板"} className={classes.treeChevron} data-open={open || undefined} style={{ marginTop: -2 }}>
            <IconChevronRight size={13} />
          </UnstyledButton>
        ) : (
          <Text fz={10} c="dimmed" w={22} ta="right" className="tabular" style={{ flex: "0 0 auto", marginTop: 2 }}>
            {it.seq}
          </Text>
        )}
        <Anchor fz="xs" className={classes.code} onClick={() => onOpen(it.loinc_num)} style={{ flex: "0 0 auto" }}>
          {it.loinc_num}
        </Anchor>
        <Text fz="xs" style={{ flex: 1, minWidth: 0 }}>
          {it.display || it.long_common_name}
          {it.is_panel && (
            <Badge size="xs" variant="light" color="violet" ml={6}>
              子面板
            </Badge>
          )}
        </Text>
        {it.required && (
          <Tooltip label={it.required.startsWith("R") ? "必填（Required）" : it.required === "O" ? "選填（Optional）" : it.required} withArrow>
            <Badge size="xs" variant="outline" color={it.required.startsWith("R") ? "red" : "gray"}>
              {it.required}
            </Badge>
          </Tooltip>
        )}
      </Group>
      {open && <PanelMembers code={it.loinc_num} onOpen={onOpen} depth={depth + 1} />}
    </div>
  );
}

function TermView({ code, onOpen, onFilter }: { code: string; onOpen: (c: string) => void; onFilter: (k: LoincFacetKey, v: string) => void }) {
  const q = useQuery({ queryKey: tk("loinc-term", code), queryFn: () => termGet<LoincTerm>("loinc/term", { code }), staleTime: 5 * 60_000 });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isPending)
    return (
      <Stack>
        <Skeleton h={36} w="40%" />
        <Skeleton h={70} />
        <Skeleton h={140} />
      </Stack>
    );
  const t = q.data;
  const c = t.concept;
  const structure = Object.values(t.structure_available).some(Boolean);
  return (
    <Stack gap="lg" key={code} className={classes.detailCard} p={0}>
      <Box>
        <Group gap={8} wrap="wrap">
          <Text className={classes.bigCode}>{c.loinc_num}</Text>
          <CopyText value={c.loinc_num} mono />
          <StatusBadge status={c.status} />
          {c.class && (
            <Badge size="sm" variant="outline" color="cyan" style={{ cursor: "pointer" }} onClick={() => onFilter("class", c.class)}>
              {c.class}
            </Badge>
          )}
        </Group>
        <Text fz="lg" fw={650} mt={6}>
          {c.long_common_name}
        </Text>
        {c.shortname && (
          <Text fz="xs" c="dimmed" ff="monospace">
            {c.shortname}
          </Text>
        )}
        {t.map_to.length > 0 && (
          <Alert mt="sm" p="xs" color="red" variant="light" icon={<IconInfoCircle size={16} />}>
            <Text fz="sm">
              {c.status === "DEPRECATED" ? "已棄用，" : ""}請改用：
              {t.map_to.map((m) => (
                <Anchor key={m.map_to} onClick={() => onOpen(m.map_to)} ml={6} fw={600}>
                  <IconArrowRight size={12} /> {m.map_to} {m.long_common_name ?? ""}
                </Anchor>
              ))}
            </Text>
          </Alert>
        )}
      </Box>

      <Box>
        <Text fz="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
          六軸結構（點選任一軸可依此篩選）
        </Text>
        <div className={classes.axisBar}>
          {t.axes.map((a, i) => (
            <Tooltip key={a.axis} label={a.value ? `只看${AXIS_META[a.axis as LoincAxis].zh} = ${a.value}` : "此軸未指定"} withArrow openDelay={300}>
              <div
                className={classes.axisSeg}
                style={{ "--ax": AXIS_META[a.axis as LoincAxis].color, animationDelay: `${i * 60}ms` } as CSSProperties}
                data-empty={!a.value || undefined}
                onClick={() => a.value && onFilter(a.axis as LoincFacetKey, a.value)}
                role="button"
                tabIndex={0}
              >
                <Text fz={10} fw={800} tt="uppercase" style={{ color: AXIS_META[a.axis as LoincAxis].color, letterSpacing: "0.05em" }}>
                  {AXIS_META[a.axis as LoincAxis].zh} · {AXIS_META[a.axis as LoincAxis].en}
                </Text>
                <Text fz="sm" fw={650} mt={2} style={{ wordBreak: "break-word" }}>
                  {a.value || "—"}
                </Text>
                {a.parts.map((p) => (
                  <Text key={p.part_number} fz={10.5} ff="monospace" c="dimmed" title={p.part_name ?? undefined}>
                    {p.part_number}
                  </Text>
                ))}
              </div>
            </Tooltip>
          ))}
        </div>
        {!t.structure_available["loinc.part_links"] && (
          <Text fz={11} c="dimmed" mt={4}>
            Part 代碼需重新匯入 LOINC（20261020 遷移後）才會顯示。
          </Text>
        )}
      </Box>

      {(c.name_zh || c.common_name_zh || c.specimen_type || c.unit) && (
        <Panel title="台灣對照">
          <Group gap="xl" p="md" wrap="wrap">
            {[
              ["中文名稱", c.name_zh],
              ["常用名", c.common_name_zh],
              ["檢體", c.specimen_type],
              ["單位", c.unit],
            ].map(([k, v]) =>
              v ? (
                <Box key={k}>
                  <Text fz={10.5} c="dimmed" fw={700}>
                    {k}
                  </Text>
                  <Text fz="sm" fw={600}>
                    {v}
                  </Text>
                </Box>
              ) : null,
            )}
          </Group>
        </Panel>
      )}

      {t.reference_ranges.length > 0 && (
        <Panel title="參考值範圍">
          <Box p="md">
            <RangeChart ranges={t.reference_ranges} />
          </Box>
        </Panel>
      )}

      {t.panel_items.length > 0 && (
        <Panel title={`面板成員（${t.panel_items.length}）`}>
          <Box p="md">
            <div className={classes.nested}>
              {t.panel_items.map((it, i) => (
                <PanelItem key={`${it.loinc_num}-${i}`} it={it} onOpen={onOpen} depth={0} index={i} />
              ))}
            </div>
          </Box>
        </Panel>
      )}

      {t.answer_lists.length > 0 && (
        <Panel title={`答案清單（${t.answer_list_total}）`}>
          <Stack gap="md" p="md">
            {t.answer_lists.map((l) => (
              <Box key={l.id}>
                <Group gap={6}>
                  <Text className={classes.code} fz={12.5}>
                    {l.id}
                  </Text>
                  <Text fz="sm" fw={600}>
                    {l.name}
                  </Text>
                  {l.link_type && (
                    <Badge size="xs" variant="light" color={l.link_type === "NORMATIVE" ? "red" : "blue"}>
                      {l.link_type}
                    </Badge>
                  )}
                  {l.context && (
                    <Text fz={10.5} c="dimmed">
                      情境 {l.context}
                    </Text>
                  )}
                </Group>
                {l.answers.length === 0 ? (
                  <Text fz="xs" c="dimmed" mt={4}>
                    外部定義的答案清單（無 LA 代碼）。
                  </Text>
                ) : (
                  <div className={classes.nested} style={{ marginTop: 6 }}>
                    {l.answers.map((a, i) => (
                      <div key={a.code} className={classes.nestedItem} style={{ animationDelay: `${Math.min(i, 20) * 22}ms` }}>
                        <Group gap={8} wrap="nowrap">
                          <Text fz={10} c="dimmed" w={18} ta="right" className="tabular">
                            {a.seq ?? ""}
                          </Text>
                          <Text className={classes.code} fz={11.5} c="dimmed">
                            {a.code}
                          </Text>
                          <Text fz="sm">{a.display}</Text>
                          {a.score && (
                            <Badge size="xs" variant="outline">
                              分數 {a.score}
                            </Badge>
                          )}
                        </Group>
                      </div>
                    ))}
                  </div>
                )}
              </Box>
            ))}
          </Stack>
        </Panel>
      )}

      {(t.in_panels.length > 0 || t.mapped_from.length > 0) && (
        <Panel title="關聯">
          <Stack gap="sm" p="md">
            {t.in_panels.length > 0 && (
              <Box>
                <Text fz="xs" fw={700} c="dimmed" mb={4}>
                  出現在這些面板
                </Text>
                <Group gap={6}>
                  {t.in_panels.map((p) => (
                    <Badge key={p.parent_loinc} variant="light" color="violet" tt="none" style={{ cursor: "pointer" }} onClick={() => onOpen(p.parent_loinc)}>
                      {p.parent_loinc} {p.long_common_name ?? ""}
                    </Badge>
                  ))}
                </Group>
              </Box>
            )}
            {t.mapped_from.length > 0 && (
              <Box>
                <Text fz="xs" fw={700} c="dimmed" mb={4}>
                  這些舊代碼對應到此術語（MapTo）
                </Text>
                <Group gap={6}>
                  {t.mapped_from.map((p) => (
                    <Badge key={p.loinc_num} variant="outline" color="gray" tt="none" style={{ cursor: "pointer" }} onClick={() => onOpen(p.loinc_num)}>
                      {p.loinc_num}
                    </Badge>
                  ))}
                </Group>
              </Box>
            )}
          </Stack>
        </Panel>
      )}
      {!structure && (
        <Text fz="xs" c="dimmed">
          面板、答案清單與 MapTo 需重新匯入 LOINC 後才會出現。
        </Text>
      )}
    </Stack>
  );
}

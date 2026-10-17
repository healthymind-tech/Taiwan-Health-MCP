import { Alert, Badge, Box, Group, Pagination, Skeleton, Stack, Switch, Text, TextInput, Tooltip, UnstyledButton } from "@mantine/core";
import { IconInfoCircle, IconPill, IconSearch } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import { CopyText } from "@/components/CopyText";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { fmtNumber } from "@/lib/format";
import { useDebounced, useIsMobile } from "@/lib/hooks";
import { EdgeLayer, useNodeRegistry, type GraphEdge } from "./EdgeLayer";
import { Hl, Panel } from "./parts";
import { termGet, tk, type RxConcept, type RxDetail, type RxSummary } from "./termApi";
import classes from "./explorer.module.css";

const LAYER_COLOR: Record<string, string> = {
  ingredient: "var(--mantine-color-teal-6)",
  clinical: "var(--mantine-color-brand-6)",
  branded: "var(--mantine-color-grape-6)",
  pack: "var(--mantine-color-orange-6)",
  form: "var(--mantine-color-indigo-6)",
  synonym: "var(--mantine-color-gray-6)",
};
const TTY_LAYER: Record<string, string> = {};
const LEFT = new Set(["has_ingredient", "consists_of", "has_dose_form", "has_tradename", "isa"]);

function ttyColor(tty: string): string {
  return LAYER_COLOR[TTY_LAYER[tty] ?? "synonym"] ?? LAYER_COLOR.synonym;
}

function TtyBadge({ tty }: { tty: string }) {
  const c = ttyColor(tty);
  return (
    <Badge size="xs" variant="light" style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, flex: "0 0 auto" }}>
      {tty}
    </Badge>
  );
}

export function RxnormExplorer() {
  const isMobile = useIsMobile();
  const [sp, setSp] = useSearchParams();
  const rxcui = sp.get("rxcui");
  const [text, setText] = useState("");
  const [tty, setTty] = useState<string | null>(null);
  const [suppressed, setSuppressed] = useState(false);
  const [page, setPage] = useState(1);
  const q = useDebounced(text.trim(), 300);

  const summary = useQuery({ queryKey: tk("rx-summary"), queryFn: () => termGet<RxSummary>("rxnorm/summary"), staleTime: 10 * 60_000 });
  for (const l of summary.data?.layers ?? []) for (const t of l.ttys) TTY_LAYER[t.tty] = l.key;
  const list = useQuery({
    queryKey: tk("rx-search", q, tty ?? "", String(suppressed), page),
    queryFn: () => termGet<{ total: number; rows: RxConcept[] }>("rxnorm/search", { q, tty: tty ?? "", suppressed, page, per_page: 15 }),
    enabled: Boolean(q || tty),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const open = (id: string) => {
    const next = new URLSearchParams(sp);
    next.set("rxcui", id);
    setSp(next, { replace: true });
  };

  const maxCount = Math.max(1, ...(summary.data?.layers ?? []).flatMap((l) => l.ttys.map((t) => t.count)));

  return (
    <Stack gap="sm">
      <Alert color="blue" variant="light" p="xs" icon={<IconInfoCircle size={16} />}>
        <Text fz="xs">
          目前只匯入 RxNorm 的概念層（RXNCONSO），沒有 RXNREL 關係表，因此下方以「詞彙類型（TTY）分層」呈現；概念之間的關係是依 RxNorm 正規化命名規則（成分 + 劑量 + 劑型 [品牌]）推導，並非官方關係資料。
        </Text>
      </Alert>
      {summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : (
        <div className={classes.layers}>
          {(summary.data?.layers ?? Array.from({ length: 6 }, (_, i) => ({ key: String(i), label: "", ttys: [] }))).map((l, li) => (
            <div key={l.key} className={classes.layer} style={{ animationDelay: `${li * 60}ms`, borderTop: `3px solid ${LAYER_COLOR[l.key] ?? "var(--mantine-color-gray-4)"}` }}>
              {!summary.data ? (
                <Skeleton h={80} />
              ) : (
                <>
                  <Text fz="xs" fw={700} style={{ color: LAYER_COLOR[l.key] }}>
                    {l.label}
                  </Text>
                  <Stack gap={3} mt={6}>
                    {l.ttys.map((t) => (
                      <Tooltip key={t.tty} label={`${t.label}${t.suppressed ? ` · ${fmtNumber(t.suppressed)} 筆已抑制` : ""}`} withArrow openDelay={250}>
                        <UnstyledButton
                          className={classes.facetRow}
                          data-active={tty === t.tty || undefined}
                          style={{ "--ax": LAYER_COLOR[l.key], "--w": `${Math.max(3, (Math.log10(t.count + 1) / Math.log10(maxCount + 1)) * 100)}%` } as CSSProperties}
                          onClick={() => {
                            setTty(tty === t.tty ? null : t.tty);
                            setPage(1);
                          }}
                        >
                          <Text span fz={12} ff="monospace" fw={650}>
                            {t.tty}
                          </Text>
                          <Text span fz={11} c="dimmed" className="tabular">
                            {fmtNumber(t.count)}
                          </Text>
                        </UnstyledButton>
                      </Tooltip>
                    ))}
                  </Stack>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div className={classes.shell} style={{ gridTemplateColumns: isMobile ? undefined : "minmax(300px, 0.7fr) minmax(0, 1.3fr)" }}>
        <Panel
          title={tty ? `${tty} 概念` : "搜尋概念"}
          right={<Switch size="xs" label="含已抑制" checked={suppressed} onChange={(e) => (setSuppressed(e.currentTarget.checked), setPage(1))} />}
        >
          <Box p="sm">
            <TextInput leftSection={<IconSearch size={16} />} placeholder="metformin、Glucophage、RxCUI 6809…" value={text} onChange={(e) => (setText(e.currentTarget.value), setPage(1))} />
          </Box>
          {!q && !tty ? (
            <EmptyState compact icon={<IconPill size={20} />} title="輸入藥名或 RxCUI，或點選上方的 TTY" description="例如 metformin（IN）→ 看到它組成的臨床藥品與品牌藥。" />
          ) : list.isError ? (
            <ErrorState error={list.error} />
          ) : !list.data ? (
            <Skeleton h={200} m="sm" />
          ) : list.data.rows.length === 0 ? (
            <EmptyState compact title="沒有符合的概念" />
          ) : (
            <Box style={{ opacity: list.isPlaceholderData ? 0.6 : 1 }}>
              {list.data.rows.map((r) => (
                <UnstyledButton key={r.rxcui} className={classes.drillItem} style={{ width: "100%" }} data-selected={r.rxcui === rxcui || undefined} onClick={() => open(r.rxcui)}>
                  <TtyBadge tty={r.tty} />
                  <Text fz="sm" style={{ flex: 1, minWidth: 0 }} lineClamp={2}>
                    <Hl text={r.name} q={q} />
                  </Text>
                  <Text fz={10.5} ff="monospace" c="dimmed">
                    {r.rxcui}
                  </Text>
                </UnstyledButton>
              ))}
              {list.data.total > 15 && (
                <Group justify="space-between" p="sm">
                  <Text fz="xs" c="dimmed">
                    {fmtNumber(list.data.total)} 筆
                  </Text>
                  <Pagination size="sm" total={Math.ceil(list.data.total / 15)} value={page} onChange={setPage} siblings={0} />
                </Group>
              )}
            </Box>
          )}
        </Panel>
        <Panel title="命名推導關係圖">
          {rxcui ? <RxGraph rxcui={rxcui} onOpen={open} mobile={isMobile} /> : <EmptyState compact icon={<IconPill size={20} />} title="選一個概念" description="左側點選任一概念，這裡會畫出它的成分、劑型、品牌與相關藥品。" />}
        </Panel>
      </div>
    </Stack>
  );
}

function RxGraph({ rxcui, onOpen, mobile }: { rxcui: string; onOpen: (id: string) => void; mobile: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const { nodes, register } = useNodeRegistry();
  const q = useQuery({ queryKey: tk("rx", rxcui), queryFn: () => termGet<RxDetail>("rxnorm/concept", { rxcui }), staleTime: 5 * 60_000 });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data)
    return (
      <Group p="lg" justify="center" gap="xl">
        <Skeleton h={120} w={160} />
        <Skeleton h={90} w={220} />
        <Skeleton h={120} w={160} />
      </Group>
    );
  const d = q.data;
  const left = d.groups.filter((g) => LEFT.has(g.relation));
  const right = d.groups.filter((g) => !LEFT.has(g.relation));
  const edges: GraphEdge[] = mobile
    ? []
    : [
        ...left.map((_g, i) => ({ id: `l${i}`, from: "center", to: `g:l${i}`, shape: "side" as const, kind: "attr" as const })),
        ...right.map((_g, i) => ({ id: `r${i}`, from: "center", to: `g:r${i}`, shape: "side" as const, kind: "isa" as const, flow: true })),
      ];
  const group = (g: RxDetail["groups"][number], key: string, i: number) => (
    <div key={key} ref={register(`g:${key}`)} className={classes.node} style={{ maxWidth: "none", cursor: "default", animationDelay: `${i * 70}ms`, "--accent": ttyColor(g.items[0]?.tty ?? "") } as CSSProperties}>
      <Text fz={10} fw={800} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.04em" }}>
        {g.label}
        {g.total > g.items.length ? ` · ${fmtNumber(g.total)}` : ""}
      </Text>
      <Stack gap={2} mt={4}>
        {g.items.slice(0, 6).map((it) => (
          <UnstyledButton key={it.rxcui} onClick={() => onOpen(it.rxcui)} className={classes.result} py={3} px={4}>
            <Group gap={6} wrap="nowrap">
              <TtyBadge tty={it.tty} />
              <Text fz="xs" lineClamp={2}>
                {it.name}
              </Text>
            </Group>
          </UnstyledButton>
        ))}
        {g.items.length > 6 && (
          <Text fz={10.5} c="dimmed" px={4}>
            …另有 {g.items.length - 6} 筆
          </Text>
        )}
      </Stack>
    </div>
  );
  return (
    <div ref={wrap} className={classes.graph} style={{ padding: mobile ? 12 : 20 }} key={rxcui}>
      {!mobile && <EdgeLayer container={wrap} nodes={nodes} edges={edges} layoutKey={rxcui} />}
      <div
        className={classes.focusRow}
        style={{
          margin: 0,
          gridTemplateColumns: mobile ? undefined : left.length && right.length ? "minmax(0,1fr) minmax(220px, 300px) minmax(0,1fr)" : "minmax(200px, 280px) minmax(0,1fr)",
        }}
      >
        {left.length > 0 && <div className={classes.attrCol}>{left.map((g, i) => group(g, `l${i}`, i))}</div>}
        <div ref={register("center")} className={classes.focus} style={{ "--accent": ttyColor(d.concept.tty) } as CSSProperties}>
          <span className={classes.pulse} />
          <Group gap={6}>
            <TtyBadge tty={d.concept.tty} />
            <Text fz={11} c="dimmed">
              {d.concept.tty_label}
            </Text>
            {d.concept.suppress && d.concept.suppress !== "N" && (
              <Badge size="xs" color="gray" variant="outline">
                suppress={d.concept.suppress}
              </Badge>
            )}
          </Group>
          <Text fz={17} fw={700} mt={8} style={{ lineHeight: 1.3 }}>
            {d.concept.name}
          </Text>
          <Group mt={6} gap={6}>
            <CopyText value={d.concept.rxcui} mono />
          </Group>
          {(d.parsed.doseForm || d.parsed.brand || d.parsed.ingredients.length > 1) && (
            <Stack gap={2} mt="sm">
              {d.parsed.ingredients.length > 0 && d.concept.tty !== "IN" && (
                <Text fz={11} c="dimmed">
                  成分：{d.parsed.components.join(" + ")}
                </Text>
              )}
              {d.parsed.doseForm && (
                <Text fz={11} c="dimmed">
                  劑型：{d.parsed.doseForm}
                </Text>
              )}
              {d.parsed.brand && (
                <Text fz={11} c="dimmed">
                  品牌：{d.parsed.brand}
                </Text>
              )}
            </Stack>
          )}
        </div>
        {right.length > 0 && (
          <div
            className={classes.attrCol}
            style={left.length || mobile ? undefined : { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", alignItems: "start" }}
          >
            {right.map((g, i) => group(g, `r${i}`, i))}
          </div>
        )}
      </div>
      {d.groups.length === 0 && (
        <Text fz="sm" c="dimmed" ta="center" mt="md">
          此類型（{d.concept.tty}）沒有可由名稱推導的關係。
        </Text>
      )}
    </div>
  );
}

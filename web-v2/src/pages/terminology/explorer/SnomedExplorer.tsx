import { ActionIcon, Alert, Anchor, Badge, Box, Button, Group, Skeleton, Stack, Text, Tooltip } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconArrowBackUp, IconArrowForwardUp, IconArrowRight, IconHierarchy2, IconHome, IconInfoCircle } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { Link, useSearchParams } from "react-router";
import { CopyText } from "@/components/CopyText";
import { ErrorState } from "@/components/EmptyState";
import { fmtNumber } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { EdgeLayer, useNodeRegistry, type GraphEdge } from "./EdgeLayer";
import { Hl, Panel, SearchBox } from "./parts";
import { termGet, tk, type ConceptRef, type Neighbourhood } from "./termApi";
import classes from "./explorer.module.css";

const ROOT = "138875005";
const CHILD_PAGE = 24;

/** Accent colour per semantic tag (top-level hierarchies). */
const TAG_COLOR: Record<string, string> = {
  disorder: "var(--mantine-color-red-6)",
  finding: "var(--mantine-color-orange-6)",
  "body structure": "var(--mantine-color-teal-6)",
  procedure: "var(--mantine-color-indigo-6)",
  "regime/therapy": "var(--mantine-color-indigo-4)",
  organism: "var(--mantine-color-green-6)",
  substance: "var(--mantine-color-grape-6)",
  product: "var(--mantine-color-pink-6)",
  "observable entity": "var(--mantine-color-cyan-6)",
  "qualifier value": "var(--mantine-color-gray-6)",
  "morphologic abnormality": "var(--mantine-color-yellow-7)",
  "situation": "var(--mantine-color-lime-7)",
  event: "var(--mantine-color-blue-6)",
  "SNOMED RT+CTV3": "var(--mantine-color-gray-6)",
};
const tagColor = (tag: string | null | undefined): string => (tag && TAG_COLOR[tag]) || "var(--mantine-color-brand-6)";

type DocWithVT = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };

function NodeCard({
  c,
  onFocus,
  refFn,
  vtName,
  label,
  delay = 0,
  attr,
}: {
  c: ConceptRef;
  onFocus: (id: string) => void;
  refFn: (el: HTMLElement | null) => void;
  vtName?: string;
  label?: string;
  delay?: number;
  attr?: boolean;
}) {
  return (
    <button
      type="button"
      ref={refFn}
      className={`${classes.node} ${attr ? classes.nodeAttr : ""}`}
      data-inactive={!c.active || undefined}
      style={{ "--accent": tagColor(c.tag), animationDelay: `${delay}ms`, viewTransitionName: vtName } as CSSProperties}
      onClick={() => onFocus(c.id)}
      title={c.fsn ?? c.term}
    >
      {label && (
        <Text fz={9.5} fw={800} c="indigo" tt="uppercase" style={{ letterSpacing: "0.05em" }} lineClamp={1}>
          {label}
        </Text>
      )}
      <Text fz="sm" fw={600} lineClamp={2} style={{ lineHeight: 1.3 }}>
        {c.term}
      </Text>
      <Group gap={6} mt={2} wrap="nowrap">
        {c.tag && (
          <Text fz={10.5} c="dimmed" truncate>
            {c.tag}
          </Text>
        )}
        {c.has_children && (
          <Tooltip label="還有子概念" withArrow>
            <IconHierarchy2 size={11} color="var(--mantine-color-dimmed)" />
          </Tooltip>
        )}
        {!c.active && (
          <Badge size="xs" color="gray" variant="outline">
            inactive
          </Badge>
        )}
      </Group>
    </button>
  );
}

export function SnomedExplorer() {
  const isMobile = useIsMobile();
  const reduce = useReducedMotion() ?? false;
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const focus = sp.get("concept") || ROOT;
  const [hist, setHist] = useState<{ stack: string[]; idx: number }>(() => ({ stack: [focus], idx: 0 }));
  const [extra, setExtra] = useState<ConceptRef[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const { nodes, register } = useNodeRegistry();

  const fetchN = (id: string) =>
    qc.fetchQuery({ queryKey: tk("sct", id), queryFn: () => termGet<Neighbourhood>("snomed/concept", { id, child_limit: CHILD_PAGE }), staleTime: 5 * 60_000 });
  const q = useQuery({ queryKey: tk("sct", focus), queryFn: () => termGet<Neighbourhood>("snomed/concept", { id: focus, child_limit: CHILD_PAGE }), staleTime: 5 * 60_000 });

  useEffect(() => setExtra([]), [focus]);

  const applyFocus = (id: string, push: boolean) => {
    const next = new URLSearchParams(sp);
    next.set("concept", id);
    setSp(next, { replace: true });
    if (push) setHist((h) => ({ stack: [...h.stack.slice(0, h.idx + 1), id], idx: h.idx + 1 }));
  };

  /** Prefetch, then swap inside a view transition so the clicked card morphs into the focus. */
  const goTo = async (id: string, push = true) => {
    if (id === focus) return;
    try {
      await fetchN(id);
    } catch {
      /* the query shows the error */
    }
    const doc = document as DocWithVT;
    if (!reduce && doc.startViewTransition) doc.startViewTransition(() => flushSync(() => applyFocus(id, push)));
    else applyFocus(id, push);
  };
  const back = () => {
    if (hist.idx === 0) return;
    const id = hist.stack[hist.idx - 1];
    setHist((h) => ({ ...h, idx: h.idx - 1 }));
    void goTo(id, false);
  };
  const fwd = () => {
    if (hist.idx >= hist.stack.length - 1) return;
    const id = hist.stack[hist.idx + 1];
    setHist((h) => ({ ...h, idx: h.idx + 1 }));
    void goTo(id, false);
  };

  const moreChildren = async () => {
    if (!q.data) return;
    setLoadingMore(true);
    try {
      const page = await termGet<Neighbourhood["children"]>("snomed/children", { id: focus, offset: CHILD_PAGE + extra.length, limit: CHILD_PAGE });
      setExtra((e) => [...e, ...page.items]);
    } finally {
      setLoadingMore(false);
    }
  };

  const d = q.data;
  const children = useMemo(() => (d ? [...d.children.items, ...extra] : []), [d, extra]);

  // A concept may appear twice (e.g. parent and attribute target): view-transition names must be unique.
  const vtNames = useMemo(() => {
    const m = new Map<string, string>();
    const used = new Set<string>([focus]);
    const add = (key: string, id: string) => {
      if (used.has(id)) return;
      used.add(id);
      m.set(key, `sct-${id}`);
    };
    d?.parents.forEach((p) => add(`p:${p.id}`, p.id));
    d?.attributes.forEach((a, i) => add(`a:${i}`, a.target.id));
    d?.associations.forEach((a, i) => add(`h:${i}`, a.target.id));
    children.forEach((c) => add(`c:${c.id}`, c.id));
    return m;
  }, [focus, d, children]);
  const vt = (key: string) => vtNames.get(key);

  const edges: GraphEdge[] = [];
  if (d && !isMobile) {
    for (const p of d.parents) edges.push({ id: `p${p.id}`, from: `p:${p.id}`, to: "focus", shape: "down", kind: "isa" });
    for (const c of children) edges.push({ id: `c${c.id}`, from: "focus", to: `c:${c.id}`, shape: "down", kind: "isa", group: "children" });
    d.attributes.forEach((_a, i) => edges.push({ id: `a${i}`, from: "focus", to: `a:${i}`, shape: "side", kind: "attr" }));
    d.associations.forEach((_a, i) => edges.push({ id: `h${i}`, from: "focus", to: `h:${i}`, shape: "side", kind: "assoc", flow: true }));
    d.icd10_maps.forEach((_m, i) => edges.push({ id: `m${i}`, from: "focus", to: `m:${i}`, shape: "side", kind: "map" }));
  }
  const layoutKey = `${focus}|${children.length}|${isMobile}`;

  const leftCol = d && d.icd10_maps.length > 0 && (
    <div className={classes.attrCol}>
      <Text className={classes.tierLabel} ta={isMobile ? "left" : "right"} style={{ marginInline: isMobile ? 0 : "auto 0" }}>
        ICD-10 對應（{d.icd10_maps.length}）
      </Text>
      {d.icd10_maps.map((m, i) => (
        <Box key={i} ref={register(`m:${i}`)} className={classes.node} style={{ "--accent": "var(--mantine-color-teal-6)", maxWidth: "none", animationDelay: `${i * 40}ms`, cursor: "default" } as CSSProperties}>
          <Group gap={6} wrap="nowrap">
            <Anchor component={Link} to={`/terminology/icd?tab=preview&sys=cm&code=${encodeURIComponent(m.target)}`} className={classes.code} fz={13}>
              {m.target}
            </Anchor>
            <Text fz={10.5} c="dimmed">
              群組 {m.group} · 優先 {m.priority}
            </Text>
          </Group>
          {m.advice && (
            <Text fz={10.5} c="dimmed" lineClamp={2}>
              {m.advice}
            </Text>
          )}
        </Box>
      ))}
    </div>
  );

  const rightCol =
    d && (d.attributes.length > 0 || d.associations.length > 0) ? (
      <div className={classes.attrCol}>
        {d.attributes.length > 0 && <Text className={classes.tierLabel} ta="left" style={{ marginInline: 0 }}>屬性關係（{d.attributes.length}）</Text>}
        {d.attributes.map((a, i) => (
          <NodeCard key={`a${i}`} c={a.target} label={a.type} attr onFocus={(id) => void goTo(id)} refFn={register(`a:${i}`)} vtName={vt(`a:${i}`)} delay={i * 40} />
        ))}
        {d.associations.length > 0 && <Text className={classes.tierLabel} ta="left" style={{ marginInline: 0 }}>歷史關聯</Text>}
        {d.associations.map((a, i) => (
          <NodeCard key={`h${i}`} c={a.target} label={`${a.label} →`} onFocus={(id) => void goTo(id)} refFn={register(`h:${i}`)} vtName={vt(`h:${i}`)} delay={i * 60} />
        ))}
      </div>
    ) : (
      <div />
    );

  return (
    <Stack gap="sm">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <SearchBox<ConceptRef>
            id="snomed"
            placeholder="搜尋 SNOMED CT：44054006、type 2 diabetes、gravid uterus…"
            search={(s) => termGet<{ items: ConceptRef[] }>("snomed/search", { q: s }).then((r) => r.items)}
            hitKey={(h) => h.id}
            minLength={2}
            onPick={(h) => void goTo(h.id)}
            renderHit={(h, s) => (
              <Group gap={8} wrap="nowrap">
                <span className={classes.kindDot} style={{ background: tagColor(h.tag) }} />
                <Box style={{ minWidth: 0 }}>
                  <Text fz="sm" lineClamp={1}>
                    <Hl text={h.term} q={s} />
                  </Text>
                  <Text fz={11} c="dimmed" ff="monospace">
                    {h.id} · {h.tag ?? ""}
                    {!h.active && " · inactive"}
                  </Text>
                </Box>
              </Group>
            )}
          />
        </Box>
        <Tooltip label="上一個概念">
          <ActionIcon variant="default" size="lg" onClick={back} disabled={hist.idx === 0} aria-label="上一個概念">
            <IconArrowBackUp size={18} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="下一個概念">
          <ActionIcon variant="default" size="lg" onClick={fwd} disabled={hist.idx >= hist.stack.length - 1} aria-label="下一個概念">
            <IconArrowForwardUp size={18} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="回到根概念">
          <ActionIcon variant="default" size="lg" onClick={() => void goTo(ROOT)} aria-label="回到根概念">
            <IconHome size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Panel>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !d ? (
          <Stack p="lg" gap="lg" align="center">
            <Group gap="sm">
              <Skeleton h={48} w={160} radius="md" />
              <Skeleton h={48} w={160} radius="md" />
            </Group>
            <Skeleton h={130} w={380} radius="lg" />
            <Group gap="sm">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} h={48} w={140} radius="md" />
              ))}
            </Group>
          </Stack>
        ) : (
          <div ref={wrap} className={classes.graph} style={{ padding: isMobile ? 12 : 20 }}>
            {!isMobile && <EdgeLayer container={wrap} nodes={nodes} edges={edges} layoutKey={layoutKey} />}
            {d.parents.length > 0 && (
              <>
                <Text className={`${classes.tierLabel} ${classes.tierCenter}`}>父概念 · IS-A（{d.parents.length}）</Text>
                <div className={classes.tier} style={isMobile ? { justifyContent: "flex-start" } : undefined}>
                  {d.parents.map((p, i) => (
                    <NodeCard key={p.id} c={p} onFocus={(id) => void goTo(id)} refFn={register(`p:${p.id}`)} vtName={vt(`p:${p.id}`)} delay={i * 50} />
                  ))}
                </div>
              </>
            )}
            <div className={classes.focusRow}>
              {isMobile ? null : leftCol || <div />}
              <FocusCard d={d} refFn={register("focus")} />
              {rightCol}
              {isMobile && leftCol}
            </div>
            {d.children.total > 0 ? (
              <>
                <Text className={`${classes.tierLabel} ${classes.tierCenter}`}>子概念（{fmtNumber(d.children.total)}）</Text>
                <div className={classes.tier} style={isMobile ? { justifyContent: "flex-start" } : undefined}>
                  {children.map((c, i) => (
                    <NodeCard key={c.id} c={c} onFocus={(id) => void goTo(id)} refFn={register(`c:${c.id}`)} vtName={vt(`c:${c.id}`)} delay={Math.min(i, 24) * 22} />
                  ))}
                </div>
                {children.length < d.children.total && (
                  <Group justify="center" mt="md">
                    <Button variant="light" size="xs" loading={loadingMore} onClick={() => void moreChildren()}>
                      顯示更多子概念（尚有 {fmtNumber(d.children.total - children.length)} 個）
                    </Button>
                  </Group>
                )}
              </>
            ) : (
              d.concept.active && (
                <Text className={`${classes.tierLabel} ${classes.tierCenter}`} c="dimmed">
                  沒有子概念（葉節點）
                </Text>
              )
            )}
          </div>
        )}
      </Panel>
      <Group gap="md" wrap="wrap">
        {["disorder", "finding", "procedure", "body structure", "organism", "substance", "qualifier value"].map((t) => (
          <Group key={t} gap={6}>
            <span className={classes.kindDot} style={{ background: tagColor(t) }} />
            <Text fz="xs" c="dimmed">
              {t}
            </Text>
          </Group>
        ))}
        <Text fz="xs" c="dimmed">
          點選任一節點即可聚焦；實線為 IS-A，藍色為屬性關係，橘色為停用概念的歷史關聯。
        </Text>
      </Group>
    </Stack>
  );
}

function FocusCard({ d, refFn }: { d: Neighbourhood; refFn: (el: HTMLElement | null) => void }) {
  const c = d.concept;
  return (
    <div ref={refFn} className={classes.focus} data-inactive={!c.active || undefined} style={{ viewTransitionName: `sct-${c.id}`, "--accent": c.active ? tagColor(c.tag) : undefined } as CSSProperties}>
      {c.active && <span className={classes.pulse} />}
      <Group gap={6} wrap="wrap">
        {c.tag && (
          <Badge size="sm" variant="light" style={{ color: tagColor(c.tag), background: `color-mix(in srgb, ${tagColor(c.tag)} 14%, transparent)` }}>
            {c.tag}
          </Badge>
        )}
        <Badge size="sm" variant={c.active ? "light" : "outline"} color={c.active ? "teal" : "gray"}>
          {c.active ? "active" : "inactive"}
        </Badge>
        {c.defined !== null && (
          <Tooltip label={c.defined ? "fully defined：由屬性完整定義" : "primitive：屬性不足以完整定義"} withArrow>
            <Badge size="sm" variant="outline" color="gray">
              {c.defined ? "≡ defined" : "⊑ primitive"}
            </Badge>
          </Tooltip>
        )}
      </Group>
      <Text fz={20} fw={700} mt={8} style={{ lineHeight: 1.25 }}>
        {c.pt ?? c.id}
      </Text>
      {c.fsn && (
        <Text fz="xs" c="dimmed" mt={2}>
          FSN：{c.fsn}
        </Text>
      )}
      <Group gap={6} mt={6}>
        <CopyText value={c.id} mono />
        {c.effective_time && (
          <Text fz={11} c="dimmed">
            生效 {c.effective_time}
          </Text>
        )}
      </Group>
      {c.synonyms.length > 0 && (
        <Group gap={4} mt="sm">
          {c.synonyms.slice(0, 8).map((s) => (
            <Badge key={s} size="xs" variant="default" tt="none" fw={500}>
              {s}
            </Badge>
          ))}
          {c.synonyms.length > 8 && (
            <Text fz={11} c="dimmed">
              +{c.synonyms.length - 8}
            </Text>
          )}
        </Group>
      )}
      {!c.active && (
        <Alert mt="sm" p="xs" color="orange" variant="light" icon={<IconInfoCircle size={16} />}>
          <Text fz="xs">
            此概念已停用。
            {d.associations.length > 0 ? (
              <>
                {" "}
                {d.associations.map((a, i) => (
                  <span key={i}>
                    {a.label} <IconArrowRight size={10} /> {a.target.term}
                    {i < d.associations.length - 1 ? "；" : ""}
                  </span>
                ))}
              </>
            ) : (
              " 沒有歷史關聯可指向替代概念。"
            )}
          </Text>
        </Alert>
      )}
      {d.inbound_attribute_count > 0 && (
        <Text fz={11} c="dimmed" mt="xs">
          有 {fmtNumber(d.inbound_attribute_count)} 筆其他概念的屬性關係指向此概念。
        </Text>
      )}
    </div>
  );
}

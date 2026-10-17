import { Badge, Box, Group, Text, Tooltip } from "@mantine/core";
import { useElementSize, useReducedMotion } from "@mantine/hooks";
import { IconArrowsShuffle, IconBolt, IconListNumbers, IconRefresh, IconStack2 } from "@tabler/icons-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { STRATEGY_META, type ProviderAccount, type Route, type RouteMember, type RouteStrategy } from "./llmApi";
import { ProviderAvatar } from "./ProviderAvatar";
import classes from "./models.module.css";

export interface FlowTrace {
  /** Member that answered. */
  answered: number | null;
  /** Members tried and failed, in order. */
  failed: number[];
}

interface Ctx {
  routes: Map<number, Route>;
  accounts: Map<number, ProviderAccount>;
  labels: Record<string, string>;
  cooling: Record<string, number>;
  trace?: FlowTrace;
  reduceMotion: boolean;
}

const STRATEGY_ICON: Record<RouteStrategy, typeof IconBolt> = {
  single: IconBolt,
  fallback: IconListNumbers,
  round_robin: IconRefresh,
  load_balance: IconArrowsShuffle,
};

const DUR = 2.2;

/** Does this member (or anything inside it) contain the answering member? */
function containsMember(ctx: Ctx, m: RouteMember, target: number | null, seen = new Set<number>()): boolean {
  if (target === null) return false;
  if (m.id === target) return true;
  if (m.member_type !== "route" || m.child_route_id === null || seen.has(m.child_route_id)) return false;
  seen.add(m.child_route_id);
  return (ctx.routes.get(m.child_route_id)?.members ?? []).some((c) => containsMember(ctx, c, target, seen));
}

/**
 * Animated diagram of a profile: a hub per level (its strategy), edges to each
 * member, nested profiles drawn as framed sub-flows. With `trace`, the path a
 * test request took is highlighted.
 */
export function RouteFlow({
  route,
  routes,
  accounts,
  labels,
  cooling = {},
  trace,
  source = "請求",
  compact = false,
}: {
  route: Route;
  routes: Route[];
  accounts: ProviderAccount[];
  /** provider type id → label */
  labels: Record<string, string>;
  cooling?: Record<string, number>;
  trace?: FlowTrace;
  source?: string;
  /** Narrower nodes for side panels. */
  compact?: boolean;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const ctx: Ctx = {
    routes: new Map(routes.map((r) => [r.id, r])),
    accounts: new Map(accounts.map((a) => [a.id, a])),
    labels,
    cooling,
    trace,
    reduceMotion,
  };
  return (
    <FlowScroll compact={compact}>
      <Box className={classes.flowRow}>
        <Box className={classes.flowSource}>
          <div className={classes.sourcePulse} />
          <Text fz="xs" fw={700}>
            {source}
          </Text>
        </Box>
        <Level route={route} ctx={ctx} depth={0} path={new Set()} />
      </Box>
    </FlowScroll>
  );
}

/** Horizontal scroller that says so when the diagram is wider than its column (touch screens hide scrollbars). */
function FlowScroll({ compact, children }: { compact: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<"none" | "more" | "end">("none");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      if (el.scrollWidth <= el.clientWidth + 1) setOverflow("none");
      else setOverflow(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 ? "end" : "more");
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);
  return (
    <Box>
      <Box ref={ref} className={classes.flowScroll} data-compact={compact || undefined} data-more={overflow === "more" || undefined}>
        {children}
      </Box>
      {overflow !== "none" && (
        <Text fz={11} c="dimmed" ta="right" mt={2}>
          {overflow === "more" ? "左右滑動可看完整路徑 →" : "← 左右滑動可看完整路徑"}
        </Text>
      )}
    </Box>
  );
}

function Level({ route, ctx, depth, path }: { route: Route; ctx: Ctx; depth: number; path: Set<number> }) {
  const colRef = useRef<HTMLDivElement>(null);
  const conn = useElementSize();
  const [centers, setCenters] = useState<number[]>([]);
  const [colH, setColH] = useState(0);
  const members = route.members;
  const enabledMembers = members.filter((m) => m.enabled);
  const Icon = STRATEGY_ICON[route.strategy];
  const nextPath = new Set(path).add(route.id);

  // Measure each member block's vertical centre so edges land on it, whatever its height.
  useLayoutEffect(() => {
    const el = colRef.current;
    if (!el) return;
    const measure = () => {
      const kids = Array.from(el.children) as HTMLElement[];
      setCenters(kids.map((k) => k.offsetTop + k.offsetHeight / 2));
      setColH(el.offsetHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const k of Array.from(el.children)) ro.observe(k);
    return () => ro.disconnect();
  }, [members.length, route.id]);

  // Round robin: the active lane rotates.
  const [rr, setRr] = useState(0);
  useEffect(() => {
    if (route.strategy !== "round_robin" || ctx.reduceMotion || enabledMembers.length < 2) return;
    const t = setInterval(() => setRr((x) => x + 1), DUR * 1000);
    return () => clearInterval(t);
  }, [route.strategy, ctx.reduceMotion, enabledMembers.length]);

  const totalW = enabledMembers.reduce((s, m) => s + Math.max(0, m.weight), 0);
  const firstEnabled = members.findIndex((m) => m.enabled);
  const rrIndex = enabledMembers.length ? members.indexOf(enabledMembers[rr % enabledMembers.length]) : -1;
  const trace = ctx.trace;

  const laneState = (m: RouteMember, i: number): { active: boolean; share: number } => {
    if (!m.enabled) return { active: false, share: 0 };
    switch (route.strategy) {
      case "single":
      case "fallback":
        return { active: i === firstEnabled, share: 1 };
      case "round_robin":
        return { active: i === rrIndex, share: 1 };
      case "load_balance":
        return { active: m.weight > 0, share: totalW > 0 ? m.weight / totalW : 0 };
    }
  };

  const W = Math.max(conn.width, 1);
  const H = Math.max(colH, 1);
  const y0 = H / 2;
  const edge = (y: number) => `M0,${y0} C${W * 0.55},${y0} ${W * 0.45},${y} ${W},${y}`;

  return (
    <Box className={classes.flowLevel}>
      <Tooltip label={STRATEGY_META[route.strategy].description} multiline maw={260} withArrow>
        <Box className={classes.hub} data-depth={depth}>
          <Icon size={16} />
          <Text fz={11} fw={700} lh={1.2} ta="center" lineClamp={2}>
            {route.name}
          </Text>
          <Badge size="xs" variant="light" tt="none">
            {STRATEGY_META[route.strategy].short}
          </Badge>
        </Box>
      </Tooltip>

      <div className={classes.flowConnector} ref={conn.ref} style={{ height: H }}>
        {conn.width > 0 && centers.length === members.length && (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
            {members.map((m, i) => {
              const { active, share } = laneState(m, i);
              const onPath = trace ? containsMember(ctx, m, trace.answered) : false;
              const failed = trace ? trace.failed.includes(m.id) : false;
              const stroke = onPath ? "var(--mantine-color-teal-5)" : failed ? "var(--mantine-color-red-5)" : active ? "var(--mantine-color-brand-5)" : "var(--mantine-color-gray-5)";
              const width = onPath ? 3.5 : active ? 1.5 + share * 3.5 : 1.25;
              return (
                <g key={m.id}>
                  <path
                    d={edge(centers[i])}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={width}
                    strokeLinecap="round"
                    className={`${classes.edge} ${!active && !onPath ? classes.edgeIdle : ""} ${trace && !onPath && !failed ? classes.edgeMuted : ""}`}
                  />
                  {!ctx.reduceMotion &&
                    (active || onPath) &&
                    !(trace && !onPath) &&
                    (() => {
                      const n = onPath ? 3 : Math.min(5, Math.max(1, Math.round(share * 6)));
                      return Array.from({ length: n }, (_, k) => (
                        <circle key={k} r={onPath ? 3.4 : 2.6} fill={stroke}>
                          <animateMotion dur={`${DUR}s`} begin={`${(-k * DUR) / n}s`} repeatCount="indefinite" path={edge(centers[i])} />
                        </circle>
                      ));
                    })()}
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <div className={classes.flowColumn} ref={colRef}>
        {members.map((m, i) => {
          const share = route.strategy === "load_balance" && m.enabled && totalW > 0 ? m.weight / totalW : null;
          const state = trace ? (m.id === trace.answered ? "ok" : trace.failed.includes(m.id) ? "failed" : undefined) : undefined;
          if (m.member_type === "route") {
            const child = m.child_route_id !== null ? ctx.routes.get(m.child_route_id) : undefined;
            if (!child || nextPath.has(child.id)) {
              return (
                <Box key={m.id} className={classes.leaf} data-disabled>
                  <Text fz="xs" c="red">
                    {child ? `循環引用：${child.name}` : "找不到 Profile"}
                  </Text>
                </Box>
              );
            }
            return (
              <Box key={m.id} className={classes.nested} data-disabled={!m.enabled || undefined}>
                <Group gap={6} className={classes.nestedLabel}>
                  <IconStack2 size={12} />
                  <Text fz={10} fw={700}>
                    {child.name}
                  </Text>
                  {share !== null && <Text fz={10} c="dimmed">{Math.round(share * 100)}%</Text>}
                </Group>
                <Level route={child} ctx={ctx} depth={depth + 1} path={nextPath} />
              </Box>
            );
          }
          const acc = m.provider_id !== null ? ctx.accounts.get(m.provider_id) : undefined;
          const cool = ctx.cooling[String(m.id)];
          return (
            <Box
              key={m.id}
              className={classes.leaf}
              data-disabled={!m.enabled || acc?.enabled === false || undefined}
              data-state={state}
              style={{ "--leaf-accent": `var(--mantine-color-${acc ? "brand" : "gray"}-5)` } as CSSProperties}
            >
              <Group gap={8} wrap="nowrap">
                <ProviderAvatar provider={acc?.provider ?? "?"} label={acc ? (ctx.labels[acc.provider] ?? acc.provider) : undefined} size={26} />
                <Box style={{ minWidth: 0, flex: 1 }}>
                  <Text fz={12} fw={650} truncate="end" lh={1.25}>
                    {m.model}
                  </Text>
                  <Text fz={10} c="dimmed" truncate="end">
                    {acc?.name ?? "（帳號已刪除）"}
                  </Text>
                </Box>
                {share !== null && (
                  <Text fz="xs" fw={700} c="brand" className="tabular">
                    {Math.round(share * 100)}%
                  </Text>
                )}
                {route.strategy === "fallback" && m.enabled && i !== firstEnabled && (
                  <Badge size="xs" variant="default" tt="none">
                    備援
                  </Badge>
                )}
                {cool && (
                  <Tooltip label={`連續失敗，冷卻中（約 ${Math.ceil(cool / 1000)} 秒）`}>
                    <Badge size="xs" color="amber" variant="light">
                      冷卻
                    </Badge>
                  </Tooltip>
                )}
              </Group>
            </Box>
          );
        })}
      </div>
    </Box>
  );
}

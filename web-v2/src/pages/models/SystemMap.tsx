import { Badge, Box, Group, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconBrain, IconStack2, IconVectorTriangle } from "@tabler/icons-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { LlmProfileKind } from "@/lib/types";
import { flattenRoute, STRATEGY_META, type FlatLeaf, type ProviderAccount, type Route } from "./llmApi";
import { llmText } from "./llmErrors";
import { ProviderAvatar } from "./ProviderAvatar";
import classes from "./overview.module.css";

const ROLE_META: Record<LlmProfileKind, { title: string; sub: string; icon: typeof IconBrain; color: string }> = {
  analysis: { title: "分析 LLM", sub: "藥品仿單萃取", icon: IconBrain, color: "var(--mantine-color-brand-5)" },
  embedding: { title: "Embedding", sub: "語意搜尋・向量工作", icon: IconVectorTriangle, color: "var(--mantine-color-indigo-5)" },
};

const DUR = 2.6;

interface Edge {
  id: string;
  from: string;
  to: string;
  role: LlmProfileKind;
  share: number;
  backup: boolean;
  muted: boolean;
}

/**
 * The whole model setup on one canvas: roles → their profiles → the models
 * (grouped by provider account) a request can land on. Edge weight = chance
 * the model is tried first; dashed = backup only.
 */
export function SystemMap({
  routes,
  roles,
  accounts,
  labels,
  cooling,
}: {
  routes: Route[];
  roles: Record<LlmProfileKind, number | null>;
  accounts: ProviderAccount[];
  labels: Record<string, string>;
  cooling: Record<string, number>;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const wrap = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [rects, setRects] = useState<Record<string, { x1: number; x2: number; y: number }>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** Hover / keyboard focus highlight, and a highlight pinned by clicking a role. */
  const [hovered, setFocus] = useState<LlmProfileKind | null>(null);
  const [pinned, setPinned] = useState<LlmProfileKind | null>(null);
  const focus = hovered ?? pinned;

  const routeMap = useMemo(() => new Map(routes.map((r) => [r.id, r])), [routes]);
  const accMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const lanes = (["analysis", "embedding"] as const).map((role) => {
    const route = roles[role] ? routeMap.get(roles[role]!) : undefined;
    return { role, route, leaves: route ? flattenRoute(route, routeMap, accMap) : [] };
  });

  // Group leaves by account for the right-hand column (an account may serve both roles).
  const groups = new Map<number, { account: ProviderAccount; leaves: { leaf: FlatLeaf; role: LlmProfileKind }[] }>();
  for (const lane of lanes) {
    for (const leaf of lane.leaves) {
      if (!leaf.account) continue;
      const g = groups.get(leaf.account.id) ?? { account: leaf.account, leaves: [] };
      g.leaves.push({ leaf, role: lane.role });
      groups.set(leaf.account.id, g);
    }
  }

  const edges: Edge[] = [];
  for (const lane of lanes) {
    if (!lane.route) continue;
    edges.push({ id: `e:${lane.role}`, from: `role:${lane.role}`, to: `route:${lane.role}`, role: lane.role, share: 1, backup: false, muted: false });
    for (const l of lane.leaves) {
      edges.push({
        id: `e:${lane.role}:${l.member.id}`,
        from: `route:${lane.role}`,
        to: `leaf:${lane.role}:${l.member.id}`,
        role: lane.role,
        share: l.share,
        backup: l.share === 0,
        muted: Boolean(l.skipped),
      });
    }
  }

  const register = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(id, el);
      else nodes.current.delete(id);
    },
    [],
  );

  const layoutKey = JSON.stringify([routes.map((r) => [r.id, r.updated_at, r.members.length]), roles, accounts.map((a) => [a.id, a.enabled])]);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const next: Record<string, { x1: number; x2: number; y: number }> = {};
      for (const [id, n] of nodes.current) {
        const r = n.getBoundingClientRect();
        next[id] = { x1: r.left - base.left, x2: r.right - base.left, y: r.top - base.top + r.height / 2 };
      }
      setRects(next);
      setSize({ w: base.width, h: base.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layoutKey]);

  const path = (e: Edge) => {
    const a = rects[e.from];
    const b = rects[e.to];
    if (!a || !b) return null;
    const x1 = a.x2;
    const x2 = b.x1;
    const dx = Math.max(40, (x2 - x1) * 0.5);
    return `M${x1},${a.y} C${x1 + dx},${a.y} ${x2 - dx},${b.y} ${x2},${b.y}`;
  };

  return (
    <Box ref={wrap} className={classes.map} onMouseLeave={() => setFocus(null)}>
      {size.w > 0 && (
        <svg className={classes.mapEdges} width={size.w} height={size.h} aria-hidden>
          {edges.map((e) => {
            const d = path(e);
            if (!d) return null;
            const color = ROLE_META[e.role].color;
            const dim = (focus !== null && focus !== e.role) || e.muted;
            const width = e.backup ? 1.4 : 1.6 + e.share * 4;
            return (
              <g key={e.id} opacity={dim ? 0.18 : 1} className={classes.edgeGroup}>
                <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={e.backup ? "4 6" : undefined} opacity={e.backup ? 0.55 : 0.9} className={e.backup ? classes.edgeDash : undefined} />
                {!reduceMotion &&
                  !e.backup &&
                  !dim &&
                  (() => {
                    const n = Math.max(1, Math.round(e.share * 4));
                    return Array.from({ length: n }, (_, k) => (
                      <circle key={k} r={3} fill={color}>
                        <animateMotion dur={`${DUR}s`} begin={`${(-k * DUR) / n}s`} repeatCount="indefinite" path={d} />
                      </circle>
                    ));
                  })()}
              </g>
            );
          })}
        </svg>
      )}

      <Text className={classes.colTitle}>角色</Text>
      <Text className={classes.colTitle}>Profile</Text>
      <Text className={classes.colTitle}>帳號與模型</Text>

      {/* Column 1: roles */}
      <Box className={classes.col}>
        {lanes.map(({ role, route }) => {
          const m = ROLE_META[role];
          return (
            <UnstyledButton
              key={role}
              ref={register(`role:${role}`)}
              className={classes.roleNode}
              style={{ "--accent": m.color } as CSSProperties}
              data-dim={(focus !== null && focus !== role) || undefined}
              onMouseEnter={() => setFocus(role)}
              onFocus={() => setFocus(role)}
              onBlur={() => setFocus(null)}
              onClick={() => setPinned((p) => (p === role ? null : role))}
              aria-pressed={pinned === role}
              aria-label={`${m.title}：${pinned === role ? "顯示全部路徑" : "只看這個角色的路徑"}`}
              title={pinned === role ? "再按一次顯示全部路徑" : "只看這個角色的路徑"}
            >
              <span className={classes.rolePulse} />
              <m.icon size={20} />
              <Box>
                <Text fz="sm" fw={700} lh={1.2}>
                  {m.title}
                </Text>
                <Text fz={11} c="dimmed">
                  {route ? m.sub : "未指定 Profile"}
                </Text>
              </Box>
            </UnstyledButton>
          );
        })}
      </Box>

      {/* Column 2: profiles */}
      <Box className={classes.col}>
        {lanes.map(({ role, route, leaves }) =>
          route ? (
            <Box
              key={role}
              ref={register(`route:${role}`)}
              className={classes.routeNode}
              style={{ "--accent": ROLE_META[role].color } as CSSProperties}
              data-dim={(focus !== null && focus !== role) || undefined}
              onMouseEnter={() => setFocus(role)}
            >
              <Group gap={6} wrap="nowrap">
                <IconStack2 size={16} className={classes.routeIcon} />
                <Text fz="sm" fw={700} truncate="end">
                  {route.name}
                </Text>
              </Group>
              <Group gap={6} mt={6}>
                <Badge size="xs" variant="light" tt="none" color={role === "embedding" ? "indigo" : "brand"}>
                  {STRATEGY_META[route.strategy].label}
                </Badge>
                <Text fz={11} c="dimmed">
                  {leaves.filter((l) => !l.skipped).length} 個可用模型
                </Text>
              </Group>
            </Box>
          ) : (
            <Box key={role} className={classes.routeEmpty}>
              <Text fz="xs" c="dimmed">
                {ROLE_META[role].title} 尚未指定 Profile
              </Text>
            </Box>
          ),
        )}
      </Box>

      {/* Column 3: accounts and their models */}
      <Box className={classes.col}>
        {[...groups.values()].map(({ account, leaves }) => (
          <Box key={account.id} className={classes.accountGroup} data-disabled={!account.enabled || undefined}>
            <Group gap={8} wrap="nowrap" mb={6}>
              <ProviderAvatar provider={account.provider} label={labels[account.provider]} size={24} />
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text fz={12} fw={700} truncate="end">
                  {account.name}
                </Text>
                <Text fz={10} c="dimmed" truncate="end">
                  {labels[account.provider] ?? account.provider}
                </Text>
              </Box>
              <AccountDot account={account} />
            </Group>
            {leaves.map(({ leaf, role }) => {
              const cool = cooling[String(leaf.member.id)];
              const state = leaf.skipped ? "off" : cool ? "cool" : leaf.share > 0 ? "primary" : "backup";
              return (
                <Tooltip
                  key={`${role}:${leaf.member.id}`}
                  multiline
                  maw={280}
                  withArrow
                  label={
                    <Box>
                      <Text fz="xs" fw={700}>
                        {leaf.member.model}
                      </Text>
                      <Text fz="xs">
                        {ROLE_META[role].title}・第 {leaf.rank || "—"} 順位
                        {leaf.share > 0 && `・約 ${Math.round(leaf.share * 100)}% 請求先送這裡`}
                      </Text>
                      {leaf.via.length > 0 && <Text fz="xs">經由 {leaf.via.join(" › ")}</Text>}
                      {leaf.skipped && <Text fz="xs">{SKIP_TEXT[leaf.skipped]}</Text>}
                      {cool && <Text fz="xs">連續失敗，冷卻中約 {Math.ceil(cool / 1000)} 秒</Text>}
                    </Box>
                  }
                >
                  <Box
                    ref={register(`leaf:${role}:${leaf.member.id}`)}
                    className={classes.leafRow}
                    data-state={state}
                    data-dim={(focus !== null && focus !== role) || undefined}
                    style={{ "--accent": ROLE_META[role].color } as CSSProperties}
                    onMouseEnter={() => setFocus(role)}
                  >
                    <span className={classes.leafDot} />
                    <Text fz={11.5} ff="monospace" truncate="end" style={{ flex: 1 }}>
                      {leaf.member.model}
                    </Text>
                    <Text fz={10.5} fw={700} className={classes.leafTag}>
                      {state === "off" ? "略過" : state === "cool" ? "冷卻" : state === "primary" ? (leaf.share >= 0.999 ? "主要" : `${Math.round(leaf.share * 100)}%`) : "備援"}
                    </Text>
                  </Box>
                </Tooltip>
              );
            })}
          </Box>
        ))}
        {groups.size === 0 && (
          <Box className={classes.routeEmpty}>
            <Text fz="xs" c="dimmed">
              尚無模型
            </Text>
          </Box>
        )}
      </Box>

      <Group gap="md" className={classes.legend}>
        <LegendItem line="solid" text="主要／分流（粗細＝先送機率）" />
        <LegendItem line="dash" text="備援" />
        <LegendItem dot="var(--mantine-color-amber-5)" text="冷卻中" />
        <LegendItem dot="var(--mantine-color-gray-5)" text="略過（停用／未允許）" />
      </Group>
    </Box>
  );
}

const SKIP_TEXT: Record<NonNullable<FlatLeaf["skipped"]>, string> = {
  disabled: "此成員已停用，不會被使用。",
  account_disabled: "帳號已停用，不會被使用。",
  not_allowed: "訂閱帳號未允許角色使用，只能手動測試。",
};

function AccountDot({ account }: { account: ProviderAccount }) {
  const t = account.last_test;
  const bad = account.oauth?.status && account.oauth.status !== "ok";
  const color = !account.enabled ? "gray" : bad || (t && !t.ok) ? "red" : t?.ok ? "teal" : "gray";
  const label = !account.enabled ? "帳號已停用" : bad ? "需重新登入" : t ? (t.ok ? "最近一次測試正常" : `最近一次測試失敗：${llmText(t)}`) : "尚未測試";
  return (
    <Tooltip label={label} withArrow>
      <span className={classes.statusDot} data-color={color} />
    </Tooltip>
  );
}

function LegendItem({ line, dot, text }: { line?: "solid" | "dash"; dot?: string; text: string }) {
  return (
    <Group gap={6} wrap="nowrap">
      {line && (
        <svg width="26" height="8" aria-hidden>
          <line x1="1" y1="4" x2="25" y2="4" stroke="var(--mantine-color-brand-5)" strokeWidth={line === "solid" ? 3 : 1.5} strokeDasharray={line === "dash" ? "4 4" : undefined} strokeLinecap="round" />
        </svg>
      )}
      {dot && <span className={classes.legendDot} style={{ background: dot }} />}
      <Text fz={11} c="dimmed">
        {text}
      </Text>
    </Group>
  );
}

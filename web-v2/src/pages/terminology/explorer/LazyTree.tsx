import { Box, Group, Skeleton, Text, UnstyledButton } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconChevronLeft, IconChevronRight, IconHome } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { errorMessage } from "@/lib/api";
import { tk } from "./termApi";
import classes from "./explorer.module.css";

export interface TreeItem {
  id: string;
  hasChildren: boolean;
}

export interface ChildPage<T> {
  items: T[];
  total: number;
}

export interface RowState {
  depth: number;
  expanded: boolean;
  selected: boolean;
  focused: boolean;
  /** On the path from the root to the selected node. */
  onPath: boolean;
}

export interface Reveal<T> {
  /** Ancestors to expand, root-most first (the target itself may be last). */
  path: string[];
  target: string;
  /** Pre-fetched children by parent id ("" = root) — avoids one round-trip per level. */
  seed?: Record<string, T[]>;
  nonce: number;
}

interface Entry<T> {
  items: T[];
  total: number;
  loading: boolean;
  error: string | null;
}

type FlatRow<T> =
  | { kind: "node"; key: string; item: T; depth: number; parent: string; pos: number; size: number; enter: number; exit: boolean }
  | { kind: "skeleton"; key: string; depth: number; enter: number }
  | { kind: "more"; key: string; parent: string; depth: number; remaining: number }
  | { kind: "error"; key: string; parent: string; depth: number; message: string };

interface CommonProps<T extends TreeItem> {
  /** Cache namespace: children of the same parent id are shared across mounts. */
  cacheKey: string;
  loadChildren: (parentId: string, offset: number) => Promise<ChildPage<T>>;
  rootId?: string;
  renderRow: (item: T, s: RowState) => ReactNode;
  selectedId?: string | null;
  onSelect?: (item: T) => void;
  reveal?: Reveal<T> | null;
  ariaLabel: string;
}

const INDENT = 18;
const STAGGER_MS = 16;

/** Children cache shared by the tree and the drill-down list. */
function useChildren<T extends TreeItem>(cacheKey: string, loadChildren: CommonProps<T>["loadChildren"]) {
  const qc = useQueryClient();
  const store = useRef(new Map<string, Entry<T>>());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const loader = useRef(loadChildren);
  loader.current = loadChildren;

  const ensure = useCallback(
    async (id: string, more = false) => {
      const cur = store.current.get(id);
      if (cur && (cur.loading || (!more && !cur.error))) return;
      const offset = more && cur ? cur.items.length : 0;
      store.current.set(id, { items: more && cur ? cur.items : [], total: cur?.total ?? 0, loading: true, error: null });
      bump();
      try {
        const page = await qc.fetchQuery({
          queryKey: tk("tree", cacheKey, id, offset),
          queryFn: () => loader.current(id, offset),
          staleTime: 5 * 60_000,
        });
        const prev = more && cur ? cur.items : [];
        store.current.set(id, { items: [...prev, ...page.items], total: page.total, loading: false, error: null });
      } catch (e) {
        store.current.set(id, { items: cur?.items ?? [], total: cur?.total ?? 0, loading: false, error: errorMessage(e) });
      }
      bump();
    },
    [qc, cacheKey, bump],
  );

  const seed = useCallback(
    (map: Record<string, T[]>) => {
      for (const [id, items] of Object.entries(map)) {
        if (!store.current.get(id)?.items.length) store.current.set(id, { items, total: items.length, loading: false, error: null });
      }
      bump();
    },
    [bump],
  );

  return { store: store.current, ensure, seed, version };
}

/**
 * Lazy, virtualised tree (desktop). Children load on expand; only the rows in
 * view (+ overscan) are mounted, so a 98k-node hierarchy costs what is visible.
 * WAI-ARIA tree keyboard model: ↑/↓ move, → expand / first child, ← collapse /
 * parent, Enter / Space select, Home / End.
 */
export function LazyTree<T extends TreeItem>({
  cacheKey,
  loadChildren,
  rootId = "",
  renderRow,
  selectedId,
  onSelect,
  reveal,
  ariaLabel,
  rowHeight = 48,
  height = 560,
}: CommonProps<T> & { rowHeight?: number; height?: number }) {
  const reduce = useReducedMotion() ?? false;
  const domId = useId().replace(/:/g, "");
  const { store, ensure, seed, version } = useChildren<T>(cacheKey, loadChildren);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [enterFor, setEnterFor] = useState<{ id: string; at: number } | null>(null);
  const [exiting, setExiting] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(height);
  const scroller = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<string | null>(null);
  const [pathIds, setPathIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    void ensure(rootId);
  }, [ensure, rootId]);

  // Search reveal: seed the levels, expand the chain, then scroll the target into view.
  useEffect(() => {
    if (!reveal) return;
    if (reveal.seed) seed(reveal.seed);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of reveal.path) if (id !== reveal.target) next.add(id);
      return next;
    });
    for (const id of reveal.path) if (id !== reveal.target) void ensure(id);
    setPathIds(new Set(reveal.path));
    setFocusId(reveal.target);
    pendingScroll.current = reveal.target;
    setEnterFor(null);
  }, [reveal?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => {
    const out: FlatRow<T>[] = [];
    const walk = (parent: string, depth: number, exitBranch: boolean, enterBase: number | null) => {
      const e = store.get(parent);
      if (!e) return;
      const animate = enterBase !== null;
      e.items.forEach((item, i) => {
        const isExiting = exitBranch;
        out.push({ kind: "node", key: item.id, item, depth, parent, pos: i + 1, size: e.total, enter: animate ? Math.min(i, 14) : -1, exit: isExiting });
        if (expanded.has(item.id) && item.hasChildren) {
          const entering = enterFor && enterFor.id === item.id ? 0 : null;
          walk(item.id, depth + 1, isExiting || exiting === item.id, entering);
        }
      });
      if (e.loading) for (let k = 0; k < Math.min(3, Math.max(1, e.total - e.items.length || 3)); k++) out.push({ kind: "skeleton", key: `${parent}~sk${k}`, depth, enter: k });
      else if (e.error) out.push({ kind: "error", key: `${parent}~err`, parent, depth, message: e.error });
      else if (e.items.length < e.total) out.push({ kind: "more", key: `${parent}~more`, parent, depth, remaining: e.total - e.items.length });
    };
    walk(rootId, 0, false, null);
    return out;
  }, [store, expanded, rootId, enterFor, exiting, version]);


  const nodeRows = rows.filter((r): r is Extract<FlatRow<T>, { kind: "node" }> => r.kind === "node");
  const indexOf = (id: string) => rows.findIndex((r) => r.kind === "node" && r.item.id === id);

  useLayoutEffect(() => {
    const target = pendingScroll.current;
    const el = scroller.current;
    if (!target || !el) return;
    const i = indexOf(target);
    if (i < 0) return;
    pendingScroll.current = null;
    const top = Math.max(0, i * rowHeight - el.clientHeight / 2 + rowHeight / 2);
    el.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
    // Bring the tree itself into the page viewport too (it may sit below the fold).
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  });

  const toggle = (item: T) => {
    if (!item.hasChildren) return;
    if (expanded.has(item.id)) {
      if (reduce) {
        setExpanded((p) => {
          const n = new Set(p);
          n.delete(item.id);
          return n;
        });
        return;
      }
      setExiting(item.id);
      window.setTimeout(() => {
        setExpanded((p) => {
          const n = new Set(p);
          n.delete(item.id);
          return n;
        });
        setExiting((x) => (x === item.id ? null : x));
      }, 150);
    } else {
      setEnterFor({ id: item.id, at: Date.now() });
      setExpanded((p) => new Set(p).add(item.id));
      void ensure(item.id);
    }
  };

  const select = (item: T) => {
    setFocusId(item.id);
    setPathIds(new Set());
    onSelect?.(item);
  };

  const keepVisible = (id: string) => {
    const el = scroller.current;
    const i = indexOf(id);
    if (!el || i < 0) return;
    const top = i * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (nodeRows.length === 0) return;
    const cur = nodeRows.findIndex((r) => r.item.id === (focusId ?? selectedId));
    const at = cur < 0 ? 0 : cur;
    const row = nodeRows[at];
    let next: number | null = null;
    switch (ev.key) {
      case "ArrowDown":
        next = Math.min(nodeRows.length - 1, cur < 0 ? 0 : at + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, at - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = nodeRows.length - 1;
        break;
      case "ArrowRight":
        if (row.item.hasChildren && !expanded.has(row.item.id)) toggle(row.item);
        else if (row.item.hasChildren && nodeRows[at + 1]?.parent === row.item.id) next = at + 1;
        break;
      case "ArrowLeft":
        if (expanded.has(row.item.id) && row.item.hasChildren) toggle(row.item);
        else if (row.parent !== rootId) next = nodeRows.findIndex((r) => r.item.id === row.parent);
        break;
      case "Enter":
      case " ":
        select(row.item);
        break;
      default:
        return;
    }
    ev.preventDefault();
    if (next !== null && next >= 0) {
      const id = nodeRows[next].item.id;
      setFocusId(id);
      keepVisible(id);
    }
  };

  // Rows animate in the first time they appear (expand / load), not when
  // virtualisation remounts them on scroll.
  const seen = useRef(new Set<string>());
  let fresh = 0;
  useEffect(() => {
    for (const r of rows) if (r.kind === "node") seen.current.add(r.key);
  });

  const overscan = 8;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowHeight) + overscan);
  const activeId = focusId ?? selectedId ?? null;
  const optionId = (id: string) => `${domId}-${encodeURIComponent(id).replace(/%/g, "_")}`;
  const rootEntry = store.get(rootId);

  return (
    <div
      ref={scroller}
      className={classes.treeScroller}
      style={{ height }}
      role="tree"
      aria-label={ariaLabel}
      tabIndex={0}
      aria-activedescendant={activeId && indexOf(activeId) >= 0 ? optionId(activeId) : undefined}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        const t = e.currentTarget.scrollTop;
        window.requestAnimationFrame(() => setScrollTop(t));
      }}
    >
      {!rootEntry || (rootEntry.loading && rootEntry.items.length === 0) ? (
        <Box p="sm">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} h={rowHeight - 12} mb={12} radius="sm" style={{ opacity: 1 - i * 0.1 }} />
          ))}
        </Box>
      ) : (
        <div style={{ height: rows.length * rowHeight, position: "relative" }}>
          {rows.slice(first, last).map((r, k) => {
            const top = (first + k) * rowHeight;
            const pad = 8 + r.depth * INDENT;
            const style = { transform: `translateY(${top}px)`, height: rowHeight, paddingLeft: pad } as const;
            if (r.kind === "skeleton") {
              return (
                <div key={r.key} className={`${classes.treeRow} ${classes.enter}`} style={{ ...style, animationDelay: `${r.enter * 40}ms` }} aria-hidden>
                  <Skeleton h={14} w={`${60 - r.enter * 12}%`} radius="sm" ml={26} />
                </div>
              );
            }
            if (r.kind === "more") {
              return (
                <div key={r.key} className={classes.treeRow} style={style}>
                  <UnstyledButton className={classes.treeMore} onClick={() => void ensure(r.parent, true)}>
                    載入更多（尚有 {r.remaining.toLocaleString()} 筆）
                  </UnstyledButton>
                </div>
              );
            }
            if (r.kind === "error") {
              return (
                <div key={r.key} className={classes.treeRow} style={style}>
                  <Text fz="xs" c="red" ml={26}>
                    {r.message}{" "}
                    <UnstyledButton fz="xs" c="brand" onClick={() => void ensure(r.parent)}>
                      重試
                    </UnstyledButton>
                  </Text>
                </div>
              );
            }
            const id = r.item.id;
            const enterIdx = !seen.current.has(r.key) && !reduce ? Math.min(fresh++, 14) : -1;
            const isExp = expanded.has(id) && r.item.hasChildren;
            const state: RowState = {
              depth: r.depth,
              expanded: isExp,
              selected: selectedId === id,
              focused: activeId === id,
              onPath: pathIds.has(id),
            };
            return (
              <div
                key={r.key}
                id={optionId(id)}
                role="treeitem"
                aria-level={r.depth + 1}
                aria-setsize={r.size}
                aria-posinset={r.pos}
                aria-expanded={r.item.hasChildren ? isExp : undefined}
                aria-selected={state.selected}
                className={`${classes.treeRow} ${classes.treeNode} ${enterIdx >= 0 ? classes.enter : ""} ${r.exit ? classes.exit : ""}`}
                data-selected={state.selected || undefined}
                data-focused={state.focused || undefined}
                data-onpath={state.onPath || undefined}
                style={{ ...style, animationDelay: enterIdx >= 0 ? `${enterIdx * STAGGER_MS}ms` : undefined }}
                onClick={() => select(r.item)}
              >
                {r.depth > 0 && <span className={classes.treeGuide} style={{ left: pad - INDENT + 9 }} aria-hidden />}
                <span
                  className={classes.treeChevron}
                  data-open={isExp || undefined}
                  data-leaf={!r.item.hasChildren || undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(r.item);
                  }}
                  aria-hidden
                >
                  <IconChevronRight size={14} />
                </span>
                <div className={classes.treeContent} onDoubleClick={() => toggle(r.item)}>
                  {renderRow(r.item, state)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Phone layout of the same hierarchy: one level at a time, sliding in from the
 * right when drilling down and from the left when going back.
 */
export function DrillList<T extends TreeItem>({
  cacheKey,
  loadChildren,
  rootId = "",
  renderRow,
  selectedId,
  onSelect,
  reveal,
  ariaLabel,
  labelOf,
}: CommonProps<T> & { labelOf: (item: T) => string }) {
  const { store, ensure, seed } = useChildren<T>(cacheKey, loadChildren);
  const [stack, setStack] = useState<{ id: string; label: string }[]>([]);
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const current = stack.length ? stack[stack.length - 1].id : rootId;

  useEffect(() => {
    void ensure(current);
  }, [ensure, current]);

  useEffect(() => {
    if (!reveal) return;
    if (reveal.seed) seed(reveal.seed);
    // Labels for the crumbs come from the seeded levels.
    const crumbs: { id: string; label: string }[] = [];
    let parent = rootId;
    for (const id of reveal.path) {
      if (id === reveal.target) break;
      const item = (reveal.seed?.[parent] ?? store.get(parent)?.items ?? []).find((x) => x.id === id);
      crumbs.push({ id, label: item ? labelOf(item) : id });
      parent = id;
    }
    setDir("fwd");
    setStack(crumbs);
  }, [reveal?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const e = store.get(current);
  const open = (item: T) => {
    onSelect?.(item);
    if (item.hasChildren) {
      setDir("fwd");
      setStack((s) => [...s, { id: item.id, label: labelOf(item) }]);
    }
  };
  const back = (to: number) => {
    setDir("back");
    setStack((s) => s.slice(0, to));
  };

  return (
    <Box className={classes.drill} aria-label={ariaLabel}>
      <Group gap={4} wrap="nowrap" className={classes.drillCrumbs}>
        {stack.length > 0 && (
          <UnstyledButton className={classes.drillBack} onClick={() => back(stack.length - 1)} aria-label="上一層">
            <IconChevronLeft size={18} />
          </UnstyledButton>
        )}
        <UnstyledButton onClick={() => back(0)} aria-label="最上層" className={classes.drillCrumb}>
          <IconHome size={14} />
        </UnstyledButton>
        {stack.map((s, i) => (
          <UnstyledButton key={s.id} className={classes.drillCrumb} data-last={i === stack.length - 1 || undefined} onClick={() => back(i + 1)}>
            {s.label}
          </UnstyledButton>
        ))}
      </Group>
      <div key={current} className={dir === "fwd" ? classes.slideFwd : classes.slideBack} role="list">
        {!e || (e.loading && e.items.length === 0)
          ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={44} mb={8} radius="md" />)
          : e.items.map((item) => (
              <div key={item.id} role="listitem" className={classes.drillItem} data-selected={selectedId === item.id || undefined} onClick={() => open(item)}>
                <div style={{ flex: 1, minWidth: 0 }}>{renderRow(item, { depth: 0, expanded: false, selected: selectedId === item.id, focused: false, onPath: false })}</div>
                {item.hasChildren && <IconChevronRight size={16} className={classes.drillChevron} />}
              </div>
            ))}
        {e?.error && (
          <Text fz="sm" c="red" p="sm">
            {e.error}
          </Text>
        )}
        {e && !e.loading && e.items.length < e.total && (
          <UnstyledButton className={classes.treeMore} onClick={() => void ensure(current, true)} m="sm">
            載入更多（尚有 {(e.total - e.items.length).toLocaleString()} 筆）
          </UnstyledButton>
        )}
      </div>
    </Box>
  );
}

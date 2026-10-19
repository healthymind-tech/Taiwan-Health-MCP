import { ActionIcon, Badge, Box, Group, SegmentedControl, Text, TextInput, Tooltip } from "@mantine/core";
import { useElementSize, useReducedMotion } from "@mantine/hooks";
import { IconArrowsDiagonalMinimize2, IconArrowsMaximize, IconChevronRight, IconSearch, IconX } from "@tabler/icons-react";
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { TypeList } from "./parts";
import type { ElementRow, LinkTarget } from "./profileTypes";
import { allExpandable, ancestors, card, defaultExpanded, flatten, searchRows, viewSet, type FlatRow, type TreeIndex, type TreeView } from "./treeModel";
import classes from "./profile.module.css";

const INDENT = 16;
const STAGGER_MS = 14;

export interface TreeReveal {
  id: string;
  nonce: number;
}

export interface ElementTreeProps {
  idx: TreeIndex;
  links: Record<string, LinkTarget>;
  required: Set<string>;
  view: TreeView;
  onView: (v: TreeView) => void;
  query: string;
  onQuery: (q: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  reveal: TreeReveal | null;
  diffAvailable: boolean;
  height: number;
}

/**
 * Virtualised, IG-Publisher-style element tree. Only the rows in view (+ overscan)
 * are mounted; rows animate in the first time they appear (expand / filter).
 * Keyboard: ↑/↓ move, → expand, ← collapse / parent, Enter select.
 */
export function ElementTree({ idx, links, required, view, onView, query, onQuery, selectedId, onSelect, reveal, diffAvailable, height }: ElementTreeProps) {
  const reduce = useReducedMotion() ?? false;
  const { ref: sizeRef, width } = useElementSize();
  const compact = width > 0 && width < 620;
  const rowHeight = compact ? 52 : 36;

  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(idx, required));
  const [focusId, setFocusId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<string | null>(null);
  const seen = useRef(new Set<string>());

  // Typed locally, pushed to the URL by the page (debounced there).
  const [text, setText] = useState(query);
  useEffect(() => setText((cur) => (cur.trim() === query.trim() ? cur : query)), [query]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (text.trim() !== query.trim()) onQuery(text.trim());
    }, 220);
    return () => window.clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const vset = useMemo(() => viewSet(idx, view, required), [idx, view, required]);
  const search = useMemo(() => searchRows(idx, query, links, vset), [idx, query, links, vset]);
  const visible = search ? search.visible : vset;

  // Filtered views open fully; the snapshot view starts with the interesting branches open.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      if (view === "snapshot") return;
    }
    setExpanded(view === "snapshot" ? defaultExpanded(idx, required) : allExpandable(idx));
  }, [view, idx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Search: open the path to every match.
  useEffect(() => {
    if (!search) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of search.matches) for (const a of ancestors(id, idx)) next.add(a);
      return next;
    });
  }, [search, idx]);

  // Deep link / external selection: open the path, scroll it into view, flash it.
  useEffect(() => {
    if (!reveal || !idx.byId.has(reveal.id)) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const a of ancestors(reveal.id, idx)) next.add(a);
      return next;
    });
    setFocusId(reveal.id);
    setFlashId(reveal.id);
    pendingScroll.current = reveal.id;
    const t = window.setTimeout(() => setFlashId(null), 1500);
    return () => window.clearTimeout(t);
  }, [reveal?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => flatten(idx, visible, expanded), [idx, visible, expanded]);
  const indexOf = (id: string) => rows.findIndex((r) => r.row.id === id);

  useLayoutEffect(() => {
    const target = pendingScroll.current;
    const el = scroller.current;
    if (!target || !el) return;
    const i = indexOf(target);
    if (i < 0) return;
    pendingScroll.current = null;
    el.scrollTo({ top: Math.max(0, i * rowHeight - el.clientHeight / 2 + rowHeight / 2), behavior: reduce ? "auto" : "smooth" });
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  });

  useEffect(() => {
    for (const r of rows) seen.current.add(r.row.id);
  });

  const toggle = (id: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const keepVisible = (id: string) => {
    const el = scroller.current;
    const i = indexOf(id);
    if (!el || i < 0) return;
    const top = i * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const cur = rows.findIndex((r) => r.row.id === (focusId ?? selectedId));
    const at = cur < 0 ? 0 : cur;
    const fr = rows[at];
    let next: number | null = null;
    switch (ev.key) {
      case "ArrowDown":
        next = Math.min(rows.length - 1, cur < 0 ? 0 : at + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, at - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rows.length - 1;
        break;
      case "ArrowRight":
        if (fr.expandable && !fr.expanded) toggle(fr.row.id);
        else if (fr.expandable) next = at + 1;
        break;
      case "ArrowLeft":
        if (fr.expandable && fr.expanded) toggle(fr.row.id);
        else if (fr.row.parent) next = indexOf(fr.row.parent);
        break;
      case "Enter":
      case " ":
        onSelect(fr.row.id);
        break;
      default:
        return;
    }
    ev.preventDefault();
    if (next !== null && next >= 0) {
      setFocusId(rows[next].row.id);
      keepVisible(rows[next].row.id);
    }
  };

  const overscan = 10;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  let fresh = 0;
  const activeId = focusId ?? selectedId;

  return (
    <Box ref={sizeRef} className={classes.treeWrap}>
      <Group gap="xs" p="sm" wrap="wrap" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => onView(v as TreeView)}
          data={[
            { value: "snapshot", label: "完整 Snapshot" },
            { value: "diff", label: "Differential", disabled: !diffAvailable },
            { value: "key", label: "關鍵元素" },
          ]}
        />
        <TextInput
          size="xs"
          placeholder="搜尋元素 id、說明、型別…"
          leftSection={<IconSearch size={14} />}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          rightSection={
            text ? (
              <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setText("")} aria-label="清除搜尋">
                <IconX size={12} />
              </ActionIcon>
            ) : null
          }
          style={{ flex: "1 1 200px", minWidth: 160 }}
          aria-label="搜尋元素"
        />
        {search && (
          <Badge variant="light" color={search.matches.size ? "brand" : "gray"} className="tabular">
            {search.matches.size} 筆符合
          </Badge>
        )}
        <Group gap={4} ml="auto">
          <Tooltip label="全部展開">
            <ActionIcon variant="default" onClick={() => setExpanded(allExpandable(idx))} aria-label="全部展開">
              <IconArrowsMaximize size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="全部收合">
            <ActionIcon variant="default" onClick={() => setExpanded(new Set(idx.rows.filter((r) => r.depth === 0).map((r) => r.id)))} aria-label="全部收合">
              <IconArrowsDiagonalMinimize2 size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      {!compact && (
        <div className={classes.treeHead} aria-hidden>
          <span>名稱</span>
          <span>旗標</span>
          <span>基數</span>
          <span>型別</span>
          <span className={classes.colShort}>說明</span>
        </div>
      )}
      <div
        ref={scroller}
        className={classes.scroller}
        style={{ height: Math.min(height, Math.max(rows.length, 3) * rowHeight + 2) }}
        role="tree"
        aria-label="Profile 元素樹"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          const t = e.currentTarget.scrollTop;
          window.requestAnimationFrame(() => setScrollTop(t));
        }}
      >
        {rows.length === 0 ? (
          <Text c="dimmed" fz="sm" ta="center" py="xl">
            {query ? `沒有符合「${query}」的元素` : "這個檢視沒有元素"}
          </Text>
        ) : (
          <div style={{ height: rows.length * rowHeight, position: "relative" }}>
            {rows.slice(first, last).map((fr, k) => {
              const i = first + k;
              const enterIdx = !seen.current.has(fr.row.id) && !reduce ? Math.min(fresh++, 16) : -1;
              return (
                <TreeRowView
                  key={fr.row.id}
                  fr={fr}
                  top={i * rowHeight}
                  height={rowHeight}
                  compact={compact}
                  links={links}
                  required={required.has(fr.row.id)}
                  muted={Boolean(visible && search ? !search.matches.has(fr.row.id) : vset && view === "diff" && !fr.row.inDiff)}
                  terms={terms}
                  selected={selectedId === fr.row.id}
                  focused={activeId === fr.row.id}
                  flash={flashId === fr.row.id}
                  enterIdx={enterIdx}
                  onToggle={toggle}
                  onSelect={(id) => {
                    setFocusId(id);
                    onSelect(id);
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </Box>
  );
}

interface RowViewProps {
  fr: FlatRow;
  top: number;
  height: number;
  compact: boolean;
  links: Record<string, LinkTarget>;
  required: boolean;
  muted: boolean;
  terms: string[];
  selected: boolean;
  focused: boolean;
  flash: boolean;
  enterIdx: number;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}

const TreeRowView = memo(function TreeRowView({ fr, top, height, compact, links, required, muted, terms, selected, focused, flash, enterIdx, onToggle, onSelect }: RowViewProps) {
  const r = fr.row;
  const pad = 8 + r.depth * INDENT;
  const removed = r.max === "0";
  return (
    <div
      role="treeitem"
      aria-level={r.depth + 1}
      aria-expanded={fr.expandable ? fr.expanded : undefined}
      aria-selected={selected}
      className={`${classes.treeRow} ${enterIdx >= 0 ? classes.enter : ""}`}
      data-compact={compact || undefined}
      data-selected={selected || undefined}
      data-focused={focused || undefined}
      data-flash={flash || undefined}
      data-muted={muted || undefined}
      data-removed={removed || undefined}
      style={{ transform: `translateY(${top}px)`, height, animationDelay: enterIdx >= 0 ? `${enterIdx * STAGGER_MS}ms` : undefined }}
      onClick={() => onSelect(r.id)}
    >
      <div className={classes.cellName} style={{ paddingLeft: pad }}>
        {Array.from({ length: r.depth }, (_, d) => (
          <span key={d} className={classes.guide} style={{ left: 8 + d * INDENT + 10 }} aria-hidden />
        ))}
        <span
          className={classes.chevron}
          data-open={(fr.expandable && fr.expanded) || undefined}
          data-leaf={!fr.expandable || undefined}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(r.id);
          }}
          aria-hidden
        >
          <IconChevronRight size={14} />
        </span>
        <ElementIcon r={r} />
        <span className={classes.nameText} title={r.id}>
          <Highlight text={r.depth === 0 ? r.path : r.name} terms={terms} />
          {r.sliceName && (
            <span className={classes.slice}>
              :<Highlight text={r.sliceName} terms={terms} />
            </span>
          )}
        </span>
      </div>
      <div className={classes.cellFlags}>
        <Flags r={r} required={required} />
      </div>
      <div className={classes.cellCard}>
        <Card r={r} />
      </div>
      <div className={classes.cellType} style={compact ? { paddingLeft: pad + 46 } : undefined}>
        {r.contentReference ? (
          <Text span fz="inherit" c="dimmed">
            見 {r.contentReference.replace(/^.*#/, "")}
          </Text>
        ) : (
          <TypeList types={r.types} links={links} />
        )}
      </div>
      {!compact && (
        <div className={`${classes.cellShort} ${classes.colShort}`} title={r.short ?? undefined}>
          {fixedSummary(r)}
          <Highlight text={r.short ?? ""} terms={terms} />
        </div>
      )}
    </div>
  );
});

function fixedSummary(r: ElementRow): ReactNode {
  const fp = r.fixed ?? r.pattern;
  if (!fp || typeof fp.value === "object") return null;
  return (
    <Text span fz="inherit" c="teal" ff="monospace" mr={6}>
      = {String(fp.value)}
    </Text>
  );
}

function Card({ r }: { r: ElementRow }) {
  const c = card(r.min, r.max);
  if (!c) return null;
  const cls = [r.max === "0" ? classes.cardZero : (r.min ?? 0) >= 1 ? classes.cardReq : "", r.cardChanged ? classes.cardChanged : ""].join(" ");
  const node = <span className={cls}>{c}</span>;
  return r.cardChanged ? <Tooltip label={`基礎定義為 ${card(r.baseMin, r.baseMax)}，此 Profile 改為 ${c}`}>{node}</Tooltip> : node;
}

function Flags({ r, required }: { r: ElementRow; required: boolean }) {
  const out: ReactNode[] = [];
  if (required)
    out.push(
      <Tooltip key="req" label="LLM 必填：出現在 fhir_get_profile_required_elements 的結果中">
        <span className={`${classes.flag} ${classes.flagReq}`}>必</span>
      </Tooltip>,
    );
  if (r.mustSupport)
    out.push(
      <Tooltip key="ms" label="Must Support：系統必須能處理這個元素">
        <span className={`${classes.flag} ${classes.flagMs}`}>MS</span>
      </Tooltip>,
    );
  if (r.isModifier)
    out.push(
      <Tooltip key="mod" label={`?! 修飾元素：會改變資源的意義${r.isModifierReason ? `（${r.isModifierReason}）` : ""}`} multiline maw={320}>
        <span className={`${classes.flag} ${classes.flagMod}`}>?!</span>
      </Tooltip>,
    );
  if (r.isSummary)
    out.push(
      <Tooltip key="sum" label="Σ 摘要元素：_summary=true 時會回傳">
        <span className={`${classes.flag} ${classes.flagSum}`}>Σ</span>
      </Tooltip>,
    );
  if (r.constraintCount > 0)
    out.push(
      <Tooltip key="inv" label={`${r.constraintCount} 條約束規則：${r.constraints.filter((c) => c.key !== "ele-1").map((c) => c.key).join("、")}`} multiline maw={320}>
        <span className={`${classes.flag} ${classes.flagInv}`}>I{r.constraintCount > 1 ? r.constraintCount : ""}</span>
      </Tooltip>,
    );
  if (r.fixed || r.pattern)
    out.push(
      <Tooltip key="fix" label={r.fixed ? `固定值 ${r.fixed.field}` : `Pattern ${r.pattern!.field}`}>
        <span className={`${classes.flag} ${classes.flagFix}`}>{r.fixed ? "F" : "P"}</span>
      </Tooltip>,
    );
  return <>{out}</>;
}

/** Small glyph per element kind (resource, slice, extension, choice, reference, primitive, complex). */
function ElementIcon({ r }: { r: ElementRow }) {
  const t0 = r.types[0]?.code ?? "";
  let g = "D";
  let color = "indigo";
  let tip = "複合資料型別";
  if (r.depth === 0) [g, color, tip] = ["R", "brand", "資源 / 定義根"];
  else if (t0 === "Extension") [g, color, tip] = ["E", "cyan", "擴充（Extension）"];
  else if (r.sliceName) [g, color, tip] = ["S", "violet", "切片（slice）"];
  else if (r.id.endsWith("[x]") || r.types.length > 1) [g, color, tip] = ["X", "grape", "多型別選擇（[x]）"];
  else if (t0 === "Reference" || t0 === "canonical") [g, color, tip] = ["→", "blue", "參照（Reference）"];
  else if (r.contentReference) [g, color, tip] = ["#", "gray", "引用其他元素的定義"];
  else if (/^[a-z]/.test(t0)) [g, color, tip] = ["p", "gray", "基本型別（primitive）"];
  else if (t0 === "BackboneElement" || t0 === "Element") [g, color, tip] = ["B", "teal", "子結構（BackboneElement）"];
  return (
    <span
      className={classes.icon}
      title={tip}
      style={{ background: `var(--mantine-color-${color}-light)`, color: `var(--mantine-color-${color}-light-color)` }}
      aria-hidden
    >
      {g}
    </span>
  );
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length || !text) return <>{text}</>;
  const lower = text.toLowerCase();
  const marks: Array<[number, number]> = [];
  for (const t of terms) {
    let at = lower.indexOf(t);
    while (at >= 0 && marks.length < 20) {
      marks.push([at, at + t.length]);
      at = lower.indexOf(t, at + t.length);
    }
  }
  if (!marks.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let pos = 0;
  marks.forEach(([s, e], i) => {
    if (s < pos) return;
    if (s > pos) out.push(<Fragment key={`t${i}`}>{text.slice(pos, s)}</Fragment>);
    out.push(
      <mark key={`m${i}`} className={classes.hit}>
        {text.slice(s, e)}
      </mark>,
    );
    pos = e;
  });
  if (pos < text.length) out.push(<Fragment key="end">{text.slice(pos)}</Fragment>);
  return <>{out}</>;
}

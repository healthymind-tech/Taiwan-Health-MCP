import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import classes from "./explorer.module.css";

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** "down": from's bottom to to's top. "side": from's right/left edge to to's facing edge. */
  shape: "down" | "side";
  kind?: "isa" | "attr" | "assoc" | "map";
  label?: string;
  flow?: boolean;
  /** Edges sharing a group only reach targets in the group's top row (wrapped tiers stay readable). */
  group?: string;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Node registry + SVG edge layer for hand-laid graphs (same approach as the
 * models page SystemMap): nodes are ordinary DOM elements; edges are measured
 * from their boxes and redrawn on resize / layout changes.
 */
export function useNodeRegistry() {
  const nodes = useRef(new Map<string, HTMLElement>());
  const register = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(id, el);
      else nodes.current.delete(id);
    },
    [],
  );
  return { nodes, register };
}

export function EdgeLayer({
  container,
  nodes,
  edges,
  layoutKey,
}: {
  container: RefObject<HTMLDivElement | null>;
  nodes: RefObject<Map<string, HTMLElement>>;
  edges: GraphEdge[];
  layoutKey: string;
}) {
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });

  const svgRef = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    // The container's ref attaches after this child's layout effect on first
    // mount, so fall back to the SVG's own parent (same element).
    const el = container.current ?? (svgRef.current?.parentElement as HTMLDivElement | null);
    if (!el) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const base = el.getBoundingClientRect();
        const next: Record<string, Box> = {};
        for (const [id, n] of nodes.current ?? []) {
          const r = n.getBoundingClientRect();
          next[id] = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
        }
        setBoxes(next);
        setSize({ w: base.width, h: base.height });
      });
    };
    measure();
    // Entry animations move nodes for ~400 ms: re-measure once they settle.
    const t1 = window.setTimeout(measure, 450);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(t1);
      ro.disconnect();
    };
  }, [layoutKey, container, nodes]);

  const topOf = new Map<string, number>();
  for (const e of edges) {
    const b = boxes[e.to];
    if (e.group && b) topOf.set(e.group, Math.min(topOf.get(e.group) ?? Infinity, b.y));
  }

  return (
    <svg ref={svgRef} className={classes.graphEdges} width={size.w} height={size.h} aria-hidden>
      {edges.map((e, i) => {
        const a = boxes[e.from];
        const b = boxes[e.to];
        if (!a || !b) return null;
        if (e.group && b.y > (topOf.get(e.group) ?? b.y) + 4) return null;
        let d: string;
        let lx: number;
        let ly: number;
        if (e.shape === "down") {
          const x1 = a.x + a.w / 2;
          const y1 = a.y + a.h;
          const x2 = b.x + b.w / 2;
          const y2 = b.y;
          const my = (y1 + y2) / 2;
          d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
          lx = (x1 + x2) / 2;
          ly = my;
        } else {
          const right = b.x > a.x + a.w / 2;
          const x1 = right ? a.x + a.w : a.x;
          const y1 = a.y + a.h / 2;
          const x2 = right ? b.x : b.x + b.w;
          const y2 = b.y + b.h / 2;
          const mx = (x1 + x2) / 2;
          d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
          lx = mx;
          ly = (y1 + y2) / 2 - 4;
        }
        const len = Math.hypot(b.x - a.x, b.y - a.y) * 1.4 + 40;
        return (
          <g key={e.id}>
            <path d={d} className={classes.edge} data-kind={e.kind} style={{ ["--len" as string]: len, animationDelay: `${Math.min(i, 20) * 25}ms` }} />
            {e.flow && <path d={d} className={classes.edgeFlow} />}
            {e.label && (
              <text x={lx} y={ly} textAnchor="middle" className={classes.edgeLabel}>
                {e.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

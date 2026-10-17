import { Box, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { memo, useState } from "react";
import classes from "./mcp.module.css";

/**
 * Collapsible JSON viewer. `expandDepth` levels start open; `version` bumps reset
 * every node (used by 全部展開 / 全部收合).
 */
export function JsonTree({ value, expandDepth = 2, version = 0 }: { value: unknown; expandDepth?: number; version?: number }) {
  return (
    <Box className={classes.tree} key={version}>
      <Node value={value} depth={0} expandDepth={expandDepth} last />
    </Box>
  );
}

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className={classes.jNull}>null</span>;
  switch (typeof value) {
    case "string":
      return <span className={classes.jString}>{JSON.stringify(value)}</span>;
    case "number":
      return <span className={classes.jNumber}>{String(value)}</span>;
    case "boolean":
      return <span className={classes.jBool}>{String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

const Node = memo(function Node({
  name,
  value,
  depth,
  expandDepth,
  last,
}: {
  name?: string;
  value: unknown;
  depth: number;
  expandDepth: number;
  last: boolean;
}) {
  const isArr = Array.isArray(value);
  const isObj = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < expandDepth);
  const comma = last ? "" : ",";
  const label = name !== undefined ? (
    <>
      <span className={classes.jKey}>{JSON.stringify(name)}</span>
      <span className={classes.jPunct}>: </span>
    </>
  ) : null;

  if (!isObj) {
    return (
      <div className={classes.line} style={{ paddingLeft: depth * 14 + 18 }}>
        {label}
        <Scalar value={value} />
        <span className={classes.jPunct}>{comma}</span>
      </div>
    );
  }
  const entries: Array<[string | undefined, unknown]> = isArr
    ? (value as unknown[]).map((v) => [undefined, v])
    : Object.entries(value as Record<string, unknown>);
  const [o, c] = isArr ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) {
    return (
      <div className={classes.line} style={{ paddingLeft: depth * 14 + 18 }}>
        {label}
        <span className={classes.jPunct}>
          {o}
          {c}
          {comma}
        </span>
      </div>
    );
  }
  return (
    <>
      <div className={classes.line} style={{ paddingLeft: depth * 14 }}>
        <UnstyledButton className={classes.toggle} onClick={() => setOpen((x) => !x)} aria-expanded={open} aria-label={open ? "收合" : "展開"}>
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </UnstyledButton>
        {label}
        <span className={classes.jPunct}>{o}</span>
        {!open && (
          <>
            <UnstyledButton className={classes.summary} onClick={() => setOpen(true)}>
              {isArr ? `${entries.length} 項` : `${entries.length} 個欄位`}
            </UnstyledButton>
            <span className={classes.jPunct}>
              {c}
              {comma}
            </span>
          </>
        )}
      </div>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <Node key={k ?? i} name={k} value={v} depth={depth + 1} expandDepth={expandDepth} last={i === entries.length - 1} />
          ))}
          <div className={classes.line} style={{ paddingLeft: depth * 14 + 18 }}>
            <span className={classes.jPunct}>
              {c}
              {comma}
            </span>
          </div>
        </>
      )}
    </>
  );
});

export function JsonTreeEmpty() {
  return (
    <Text c="dimmed" fz="sm">
      —
    </Text>
  );
}

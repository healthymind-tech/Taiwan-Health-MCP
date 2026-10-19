import { ActionIcon, Button, CopyButton, Group, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconChevronRight, IconCopy, IconFold, IconFoldDown } from "@tabler/icons-react";
import { memo, useState } from "react";
import classes from "./detail.module.css";

type Json = unknown;

const STR_CLAMP = 240;
const ARRAY_PAGE = 100;

function Str({ s }: { s: string }) {
  const [full, setFull] = useState(false);
  if (s.length <= STR_CLAMP || full) return <span className={classes.jStr}>{JSON.stringify(s)}</span>;
  return (
    <>
      <span className={classes.jStr}>{JSON.stringify(s.slice(0, STR_CLAMP))}</span>
      <button type="button" className={classes.jSummary} onClick={() => setFull(true)} aria-label="顯示完整字串">
        …（還有 {s.length - STR_CLAMP} 字）
      </button>
    </>
  );
}

function Leaf({ v }: { v: Json }) {
  if (typeof v === "string") return <Str s={v} />;
  if (typeof v === "number") return <span className={classes.jNum}>{String(v)}</span>;
  if (v === null || typeof v === "boolean") return <span className={classes.jLit}>{String(v)}</span>;
  return <span>{String(v)}</span>;
}

const isBranch = (v: Json): v is Record<string, Json> | Json[] => typeof v === "object" && v !== null;

const Node = memo(function Node({ k, v, depth, openDepth, last }: { k: string | null; v: Json; depth: number; openDepth: number; last: boolean }) {
  const branch = isBranch(v);
  const [open, setOpen] = useState(depth < openDepth);
  const [shown, setShown] = useState(ARRAY_PAGE);
  const comma = last ? null : <span className={classes.jPunct}>,</span>;
  const key =
    k !== null ? (
      <>
        <span className={classes.jKey}>{JSON.stringify(k)}</span>
        <span className={classes.jPunct}>: </span>
      </>
    ) : null;
  if (!branch) {
    return (
      <div>
        {key}
        <Leaf v={v} />
        {comma}
      </div>
    );
  }
  const isArr = Array.isArray(v);
  const entries: [string | null, Json][] = isArr ? (v as Json[]).map((x) => [null, x]) : Object.entries(v as Record<string, Json>);
  const [o, c] = isArr ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) {
    return (
      <div>
        {key}
        <span className={classes.jPunct}>
          {o}
          {c}
        </span>
        {comma}
      </div>
    );
  }
  const visible = isArr ? entries.slice(0, shown) : entries;
  return (
    <div>
      <button type="button" className={classes.jToggle} data-open={open || undefined} onClick={() => setOpen((x) => !x)} aria-expanded={open} aria-label={open ? "收合" : "展開"}>
        <IconChevronRight size={12} />
      </button>
      {key}
      <span className={classes.jPunct}>{o}</span>
      {open ? (
        <>
          <div className={classes.jChildren}>
            {visible.map(([ck, cv], i) => (
              <Node key={ck ?? i} k={ck} v={cv} depth={depth + 1} openDepth={openDepth} last={i === entries.length - 1} />
            ))}
            {isArr && entries.length > shown && (
              <button type="button" className={classes.jSummary} onClick={() => setShown((n) => n + ARRAY_PAGE)}>
                再顯示 {Math.min(ARRAY_PAGE, entries.length - shown)} 項（共 {entries.length}）
              </button>
            )}
          </div>
          <span className={classes.jPunct}>{c}</span>
        </>
      ) : (
        <>
          <button type="button" className={classes.jSummary} onClick={() => setOpen(true)}>
            {isArr ? `${entries.length} 項` : `${entries.length} 個欄位`}
          </button>
          <span className={classes.jPunct}>{c}</span>
        </>
      )}
      {comma}
    </div>
  );
});

/** Syntax-highlighted, collapsible JSON viewer (keyboard: Tab to a toggle, Enter/Space). */
export function JsonTree({ value, maxHeight = 560, initialDepth = 2 }: { value: Json; maxHeight?: number | string; initialDepth?: number }) {
  // Remount with a different open depth to expand / collapse everything.
  const [mode, setMode] = useState<{ depth: number; n: number }>({ depth: initialDepth, n: 0 });
  let text = "";
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <div>
      <Group justify="space-between" mb={6} gap="xs">
        <Text fz="xs" c="dimmed">
          {(text.length / 1024).toFixed(1)} KB
        </Text>
        <Group gap={4}>
          <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconFoldDown size={13} />} onClick={() => setMode((m) => ({ depth: 99, n: m.n + 1 }))}>
            全部展開
          </Button>
          <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconFold size={13} />} onClick={() => setMode((m) => ({ depth: 1, n: m.n + 1 }))}>
            收合
          </Button>
          <CopyButton value={text} timeout={1500}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? "已複製" : "複製 JSON"}>
                <ActionIcon size="sm" variant="subtle" color={copied ? "teal" : "gray"} onClick={copy} aria-label="複製 JSON">
                  {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
      </Group>
      <div className={classes.json} style={{ maxHeight, paddingLeft: 26 }} key={mode.n}>
        <Node k={null} v={value} depth={0} openDepth={mode.depth} last />
      </div>
    </div>
  );
}

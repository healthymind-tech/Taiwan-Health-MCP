import { Badge, Box, Group, ScrollArea, Text } from "@mantine/core";
import { useEffect, useRef } from "react";
import { fmtDateTime } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";

export interface LogLine {
  id?: string | number;
  level: string;
  message: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

const LEVEL_COLOR: Record<string, string> = {
  error: "red",
  warn: "amber",
  warning: "amber",
  info: "blue",
  debug: "gray",
};

/** Terminal-style log list. Auto-scrolls to the bottom when `follow`. */
export function LogViewer({ lines, height = 420, follow = true }: { lines: LogLine[]; height?: number | string; follow?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const stacked = useIsMobile();
  useEffect(() => {
    if (follow && viewport.current) viewport.current.scrollTo({ top: viewport.current.scrollHeight });
  }, [lines.length, follow]);

  return (
    <Box
      style={{
        background: "var(--log-bg)",
        borderRadius: "var(--mantine-radius-md)",
        border: "1px solid var(--log-border)",
      }}
    >
      <ScrollArea h={height} viewportRef={viewport} type="auto" offsetScrollbars>
        <Box p="sm" ff="monospace" fz={12}>
          {lines.length === 0 && (
            <Text c="dimmed" fz="xs" ff="monospace">
              尚無日誌
            </Text>
          )}
          {lines.map((l, i) => {
            const lvl = String(l.level || "info").toLowerCase();
            const payload = l.payload && Object.keys(l.payload).length > 0 ? JSON.stringify(l.payload) : "";
            return (
              <Group
                key={l.id ?? i}
                gap={stacked ? 4 : 8}
                wrap={stacked ? "wrap" : "nowrap"}
                align="flex-start"
                py={stacked ? 4 : 2}
                style={{ lineHeight: 1.55, borderBottom: stacked ? "1px solid var(--log-border)" : undefined }}
              >
                <Text span c="dimmed" fz={11} ff="monospace" style={{ whiteSpace: "nowrap" }}>
                  {l.timestamp ? fmtDateTime(l.timestamp, true).slice(5) : ""}
                </Text>
                <Badge size="xs" color={LEVEL_COLOR[lvl] ?? "gray"} variant="light" w={52} style={{ flexShrink: 0 }}>
                  {lvl}
                </Badge>
                <Box style={{ minWidth: 0, flex: stacked ? "1 1 100%" : 1, wordBreak: "break-word", color: "var(--log-fg)" }}>
                  {l.message}
                  {payload && (
                    <Text span c="dimmed" fz={11} ff="monospace" ml={6}>
                      {payload.length > 600 ? `${payload.slice(0, 600)}…` : payload}
                    </Text>
                  )}
                </Box>
              </Group>
            );
          })}
        </Box>
      </ScrollArea>
    </Box>
  );
}

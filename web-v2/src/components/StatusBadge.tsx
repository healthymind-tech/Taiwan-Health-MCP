import { Badge, Box, Group, Text, Tooltip } from "@mantine/core";
import type { ReactNode } from "react";
import { jobStatusMeta } from "@/lib/meta";
import classes from "./StatusBadge.module.css";

export type Health = "ok" | "warn" | "error" | "idle" | "unknown" | "running";

const HEALTH_COLOR: Record<Health, string> = {
  ok: "teal",
  warn: "amber",
  error: "red",
  idle: "gray",
  unknown: "gray",
  running: "blue",
};

/** A small coloured dot; pulses when `live`. */
export function Dot({ color, live, size = 8 }: { color: string; live?: boolean; size?: number }) {
  return (
    <Box
      component="span"
      className={live ? classes.live : undefined}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        display: "inline-block",
        flexShrink: 0,
        background: `var(--mantine-color-${color}-filled)`,
        ["--dot-color" as string]: `var(--mantine-color-${color}-filled)`,
      }}
    />
  );
}

/** Job status badge (排隊中 / 執行中 / 成功 / 失敗 …). */
export function JobStatusBadge({ status, size = "sm" }: { status: string | null | undefined; size?: "xs" | "sm" | "md" }) {
  const m = jobStatusMeta(status);
  return (
    <Badge color={m.color} size={size} leftSection={<Dot color={m.color} live={m.live} size={6} />}>
      {m.label}
    </Badge>
  );
}

/** Generic health indicator: dot + label, optional tooltip. */
export function HealthBadge({
  state,
  label,
  tooltip,
  size = "sm",
}: {
  state: Health;
  label: ReactNode;
  tooltip?: ReactNode;
  size?: "xs" | "sm" | "md";
}) {
  const color = HEALTH_COLOR[state];
  const badge = (
    <Badge color={color} size={size} leftSection={<Dot color={color} live={state === "running"} size={6} />}>
      {label}
    </Badge>
  );
  return tooltip ? <Tooltip label={tooltip}>{badge}</Tooltip> : badge;
}

/** Inline dot + text, for dense lists. */
export function HealthText({ state, children }: { state: Health; children: ReactNode }) {
  return (
    <Group gap={8} wrap="nowrap">
      <Dot color={HEALTH_COLOR[state]} live={state === "running"} />
      <Text fz="sm" span>
        {children}
      </Text>
    </Group>
  );
}

export function probeHealth(status: string | null | undefined): Health {
  switch (String(status ?? "").toLowerCase()) {
    case "ok":
    case "healthy":
    case "success":
    case "ready":
      return "ok";
    case "degraded":
    case "warn":
    case "warning":
    case "recovering":
      return "warn";
    case "error":
    case "failed":
    case "unreachable":
    case "down":
      return "error";
    case "":
    case "unknown":
    case "never":
      return "unknown";
    default:
      return "idle";
  }
}

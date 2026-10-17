import { Card, Group, Progress, Skeleton, Stack, Text, ThemeIcon } from "@mantine/core";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

export interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  color?: string;
  /** 0–100; renders a thin progress bar under the value. */
  progress?: number;
  loading?: boolean;
  onClick?: () => void;
  /** Accessible name when the tile is clickable (defaults to its visible text). */
  ariaLabel?: string;
}

/** KPI tile. */
export function StatCard({ label, value, hint, icon, color = "brand", progress, loading, onClick, ariaLabel }: StatCardProps) {
  return (
    <Card
      padding="md"
      onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined}
      className={onClick ? "hover-lift" : undefined}
      {...(onClick
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": ariaLabel,
            onKeyDown: (e: ReactKeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            },
          }
        : {})}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Text fz="xs" c="dimmed" fw={600} tt="uppercase" style={{ letterSpacing: 0.4 }}>
            {label}
          </Text>
          {loading ? (
            <Skeleton h={30} w={90} />
          ) : (
            <Text fz={26} fw={700} lh={1.15} style={{ fontVariantNumeric: "tabular-nums" }}>
              {value}
            </Text>
          )}
          {hint && (
            <Text fz="xs" c="dimmed" lineClamp={2}>
              {hint}
            </Text>
          )}
        </Stack>
        {icon && (
          <ThemeIcon size={40} radius="md" variant="light" color={color}>
            {icon}
          </ThemeIcon>
        )}
      </Group>
      {progress !== undefined && <Progress value={progress} color={color} size="sm" radius="xl" mt="sm" />}
    </Card>
  );
}

import { Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCheck, IconInfoCircle, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { errorParts } from "@/lib/api";

/** Clip raw technical text so a toast never turns into a wall of HTML / JSON. */
function clip(s: string, max = 240): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * What happened, what to do next, and (small, dimmed) the raw technical cause.
 * Used by toasts and inline error states so every failure reads the same way.
 */
export function ErrorText({ err }: { err: unknown }) {
  const p = errorParts(err);
  return (
    <Stack gap={4}>
      <Text fz="sm">{p.message}</Text>
      {p.hint && (
        <Text fz="sm" c="dimmed">
          {p.hint}
        </Text>
      )}
      {p.detail && (
        <Text fz="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-word" }}>
          技術細節：{clip(p.detail)}
        </Text>
      )}
    </Stack>
  );
}

/** Toast helpers — one consistent look for every outcome. */
export const notify = {
  success(message: ReactNode, title?: string): void {
    notifications.show({ color: "teal", title, message, icon: <IconCheck size={18} />, autoClose: 4000 });
  },
  info(message: ReactNode, title?: string): void {
    notifications.show({ color: "blue", title, message, icon: <IconInfoCircle size={18} />, autoClose: 5000 });
  },
  warn(message: ReactNode, title?: string): void {
    notifications.show({ color: "amber", title, message, icon: <IconAlertTriangle size={18} />, autoClose: 7000 });
  },
  error(err: unknown, title = "操作失敗"): void {
    notifications.show({
      color: "red",
      title,
      message: typeof err === "string" ? err : <ErrorText err={err} />,
      icon: <IconX size={18} />,
      autoClose: 9000,
    });
  },
};

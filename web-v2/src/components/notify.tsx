import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCheck, IconInfoCircle, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { errorMessage } from "@/lib/api";

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
      message: typeof err === "string" ? err : errorMessage(err),
      icon: <IconX size={18} />,
      autoClose: 9000,
    });
  },
};

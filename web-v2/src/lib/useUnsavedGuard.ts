import { useEffect } from "react";
import { useBlocker } from "react-router";
import { confirmAction } from "@/components/confirm";

export function confirmDiscard(onDiscard: () => void, onCancel?: () => void): void {
  confirmAction({
    title: "放棄未儲存的變更？",
    message: "這個表單有尚未儲存的修改，離開後將無法復原。",
    confirmLabel: "放棄變更並離開",
    cancelLabel: "繼續編輯",
    danger: true,
    onConfirm: onDiscard,
    onCancel,
  });
}

/**
 * Unsaved-changes guard: in-app navigation (links, Back/Forward) asks through a
 * Mantine dialog via react-router's useBlocker; tab close / reload falls back to
 * the browser's mandatory beforeunload prompt.
 */
export function useUnsavedGuard(when: boolean): void {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    confirmDiscard(
      () => blocker.proceed(),
      () => blocker.reset(),
    );
  }, [blocker]);

  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [when]);
}

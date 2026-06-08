// Minimal toast system: a module-level store + a container component.
// No external state library — useSyncExternalStore keeps it dependency-free.

import { useSyncExternalStore } from "react";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Toast[] {
  return toasts;
}

export function pushToast(message: string, kind: ToastKind = "info"): void {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message }];
  emit();
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, 4_000);
}

export const toast = {
  info: (m: string) => pushToast(m, "info"),
  success: (m: string) => pushToast(m, "success"),
  error: (m: string) => pushToast(m, "error"),
};

export function ToastContainer(): JSX.Element {
  const items = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

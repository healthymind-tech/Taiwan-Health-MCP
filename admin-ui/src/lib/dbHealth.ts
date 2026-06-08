// Lightweight signal so any API call that hits a 503 "database_unavailable"
// can immediately surface the DB-recovery overlay, instead of waiting for the
// next background health poll. The DbHealthGate subscribes to this.

type Listener = () => void;

const listeners = new Set<Listener>();

export function notifyDbUnavailable(): void {
  for (const listener of listeners) listener();
}

export function onDbUnavailable(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Tiny pub/sub so any failed request can flip the DB-down overlay immediately.
type Listener = () => void;
const listeners = new Set<Listener>();
export function notifyDbUnavailable(): void {
  for (const l of listeners) l();
}
export function onDbUnavailable(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

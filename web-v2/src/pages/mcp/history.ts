/** Per-browser playground history (localStorage; every access guarded). */

export interface HistoryEntry {
  id: string;
  tool: string;
  presetLabel: string | null;
  args: Record<string, unknown>;
  at: number;
  httpStatus: number;
  toolOk: boolean;
  elapsedMs: number;
  /** True when the arguments were too large to keep. */
  argsOmitted?: boolean;
}

const KEY = "twh.mcp.playground.history.v1";
const MAX = 25;
/** Entries larger than this are kept without their arguments (bundles can be big). */
const MAX_ARGS_CHARS = 60_000;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]).filter((e) => e && typeof e.tool === "string") : [];
  } catch {
    return [];
  }
}

function save(entries: HistoryEntry[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* storage full / blocked: history is a convenience only */
  }
}

export function pushHistory(e: Omit<HistoryEntry, "id" | "argsOmitted">): HistoryEntry[] {
  let args = e.args;
  let argsOmitted = false;
  try {
    if (JSON.stringify(args).length > MAX_ARGS_CHARS) argsOmitted = true;
  } catch {
    argsOmitted = true;
  }
  if (argsOmitted) args = {};
  const entry: HistoryEntry = { ...e, args, argsOmitted, id: `${e.at}-${Math.random().toString(36).slice(2, 8)}` };
  const next = [entry, ...loadHistory()].slice(0, MAX);
  save(next);
  return next;
}

export function clearHistory(): HistoryEntry[] {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return [];
}

// Relative timestamp formatting, shared across tabs (mirrors the old
// formatRelativeTime in admin_html_shell.py).

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 0) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

export function secondsBetween(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!startIso) return null;
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return null;
  const parsedEnd = endIso ? Date.parse(endIso) : nowMs;
  const end = Number.isFinite(parsedEnd) ? parsedEnd : nowMs;
  return Math.max(0, (end - start) / 1000);
}

export function formatPreciseRelative(
  iso: string | null | undefined,
  nowMs = Date.now(),
): string {
  const seconds = secondsBetween(iso, null, nowMs);
  if (seconds === null) return "never";
  return `${formatDuration(seconds)} ago`;
}

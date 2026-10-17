import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import utc from "dayjs/plugin/utc";
import "dayjs/locale/zh-tw";

dayjs.extend(relativeTime);
dayjs.extend(utc);
dayjs.locale("zh-tw");

export { dayjs };

const nf = new Intl.NumberFormat("zh-TW");

export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return nf.format(Number(n));
}

/** 1234567 → "123.5 萬"; small numbers stay exact. */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)} 億`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)} 萬`;
  return nf.format(v);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 100 ? 0 : 1)} ${units[i]}`;
}

export function fmtPercent(part: number, total: number, digits = 1): string {
  if (!total) return "0%";
  return `${((part / total) * 100).toFixed(digits)}%`;
}

function parse(value: string | number | Date | null | undefined): dayjs.Dayjs | null {
  if (value === null || value === undefined || value === "") return null;
  const d = dayjs(value);
  return d.isValid() ? d : null;
}

/** "3 分鐘前" */
export function fmtRelative(value: string | number | Date | null | undefined): string {
  const d = parse(value);
  return d ? d.fromNow() : "—";
}

/** "2026-10-15 14:03" in the viewer's local time. */
export function fmtDateTime(value: string | number | Date | null | undefined, withSeconds = false): string {
  const d = parse(value);
  return d ? d.format(withSeconds ? "YYYY-MM-DD HH:mm:ss" : "YYYY-MM-DD HH:mm") : "—";
}

export function fmtDate(value: string | number | Date | null | undefined): string {
  const d = parse(value);
  return d ? d.format("YYYY-MM-DD") : "—";
}

/** Seconds → "1 小時 4 分" / "12 秒". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小時`;
}

export function durationBetween(start?: string | null, end?: string | null): number | null {
  const a = parse(start);
  if (!a) return null;
  const b = parse(end) ?? dayjs();
  return b.diff(a, "second");
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}

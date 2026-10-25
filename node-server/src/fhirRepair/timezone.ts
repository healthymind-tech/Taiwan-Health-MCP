/**
 * The site timezone (ISSUES_v14.1 R3 / item 5): the UTC offset that completes a date-time written
 * without one. It is a facility setting and is never guessed; its sources, in order:
 *
 *   1. the tool's explicit `timezone` argument;
 *   2. a `site_config` line naming it (the facility settings text fhir_check_grounding /
 *      fhir_author_resources take), e.g.
 *          - 時區：+08:00          timezone: Asia/Taipei          UTC offset = UTC+8
 *      label 時區 / 时区 / timezone / time zone / tz / UTC offset, then `:` / `：` / `=` / space, then
 *      a UTC offset (+08:00, +0800, +8, UTC+8, GMT+08:00, Z / UTC) or an IANA zone name;
 *      several lines naming different zones → none (ambiguous, reported);
 *   3. the same line inside the 【院所設定】 (site config) section of `source_text`.
 * An IANA name is resolved at each value's own local wall time (DST aware); a wall time that
 * does not exist or is ambiguous in that zone (a DST transition) is not completed.
 */

const OFFSET_RE = /^(?:(?:UTC|GMT)\s*)?([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i;
const ZULU_RE = /^(?:Z|UTC|GMT)$/i;
const IANA_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2}$/;

export interface TimezoneSpec {
  /** A fixed offset ("+08:00" / "Z") or an IANA zone name. */
  kind: "offset" | "iana";
  value: string;
}

/** A timezone argument / site_config value → spec (null = not a timezone). */
export function parseTimezone(raw: unknown): TimezoneSpec | null {
  if (typeof raw !== "string") return null;
  const t = raw.normalize("NFKC").trim();
  if (!t) return null;
  if (ZULU_RE.test(t)) return { kind: "offset", value: "Z" };
  const m = OFFSET_RE.exec(t);
  if (m) {
    const hh = Number(m[2]);
    const mm = m[3] !== undefined ? Number(m[3]) : 0;
    if (hh > 14 || mm > 59) return null;
    if (hh === 0 && mm === 0) return { kind: "offset", value: "+00:00" };
    return { kind: "offset", value: `${m[1]}${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` };
  }
  if (IANA_RE.test(t) && ianaValid(t)) return { kind: "iana", value: t };
  return null;
}

const ianaCache = new Map<string, Intl.DateTimeFormat | null>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  if (ianaCache.has(zone)) return ianaCache.get(zone)!;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    f = null;
  }
  if (ianaCache.size > 200) ianaCache.clear();
  ianaCache.set(zone, f);
  return f;
}

function ianaValid(zone: string): boolean {
  return formatter(zone) !== null;
}

/** Wall time (as a UTC epoch of its fields) that `zone` shows at instant `epoch`. */
function wallAt(f: Intl.DateTimeFormat, epoch: number): number {
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(epoch))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === 24 ? 0 : parts.hour, parts.minute, parts.second);
}

function fmtOffset(minutes: number): string {
  if (minutes === 0) return "+00:00";
  const sign = minutes < 0 ? "-" : "+";
  const a = Math.abs(minutes);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/**
 * The UTC offset of `spec` at the local wall time `local` (ISO `YYYY-MM-DDThh:mm:ss`, no offset).
 * Null when the wall time does not exist or is ambiguous in the zone (DST transition).
 */
export function offsetFor(spec: TimezoneSpec, local: string): string | null {
  if (spec.kind === "offset") return spec.value === "Z" ? "Z" : spec.value;
  const f = formatter(spec.value);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(local);
  if (!f || !m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  // Candidate offsets: the zone's offsets a day around the wall time (covers any DST change).
  const offsets = new Set<number>();
  for (const probe of [wall - 86400000, wall, wall + 86400000]) offsets.add(Math.round((wallAt(f, probe) - probe) / 60000));
  const fits = [...offsets].filter((o) => wallAt(f, wall - o * 60000) === wall);
  return fits.length === 1 ? fmtOffset(fits[0]) : null;
}

const LABEL = String.raw`(?:時區|时区|時區設定|timezone|time\s*zone|tz|utc\s*offset|時差)`;
const LINE_RE = new RegExp(String.raw`^[\s\-*•·・>]*${LABEL}\s*(?:[:：=]|\s)\s*(.+?)\s*$`, "i");

/** The site-config section of a source text (after the 【院所設定】 marker, up to the next 【…】 heading). */
function siteSection(sourceText: string): string | null {
  const i = sourceText.indexOf("院所設定】");
  if (i < 0) return null;
  const rest = sourceText.slice(i + "院所設定】".length);
  const j = rest.indexOf("【");
  return j >= 0 ? rest.slice(0, j) : rest;
}

export interface SiteTimezone {
  timezone: string | null;
  source: string | null;
  /** Why no timezone was taken although a line named one (several different zones / not a timezone). */
  problem?: string;
}

/** The timezone a site_config text names (see the module comment). */
export function siteConfigTimezone(text: string | null | undefined, label = "site_config"): SiteTimezone {
  if (typeof text !== "string" || !text.trim()) return { timezone: null, source: null };
  const found = new Map<string, string>();
  const bad: string[] = [];
  for (const line of text.normalize("NFKC").split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    // The value may carry a note: "+08:00（台灣）", "Asia/Taipei (UTC+8)" — the first token that parses.
    const tokens = m[1].split(/[\s,;，；()（）]+/).filter(Boolean);
    let spec: TimezoneSpec | null = parseTimezone(m[1]);
    for (let k = 0; !spec && k < tokens.length; k++) spec = parseTimezone(tokens[k]) ?? (tokens[k + 1] ? parseTimezone(tokens[k] + tokens[k + 1]) : null);
    if (spec) found.set(spec.value, line.trim());
    else bad.push(line.trim());
  }
  if (found.size === 1) {
    const [[tz]] = [...found.entries()];
    return { timezone: tz, source: label };
  }
  if (found.size > 1) return { timezone: null, source: null, problem: `${label} names several timezones (${[...found.keys()].join(", ")}); none was used` };
  if (bad.length) return { timezone: null, source: null, problem: `${label} line '${bad[0].slice(0, 60)}' does not name a UTC offset (+08:00) or an IANA zone (Asia/Taipei)` };
  return { timezone: null, source: null };
}

/**
 * The site timezone of a tool call: the explicit argument, else site_config, else the site-config
 * section of source_text. An explicit argument that is not a timezone is returned as a problem.
 */
export function siteTimezone(args: { timezone?: string | null; siteConfig?: string | null; sourceText?: string | null }): SiteTimezone {
  if (typeof args.timezone === "string" && args.timezone.trim()) {
    const spec = parseTimezone(args.timezone);
    return spec ? { timezone: spec.value, source: "timezone argument" } : { timezone: null, source: null, problem: `timezone '${args.timezone}' is not a UTC offset (+08:00) or an IANA zone (Asia/Taipei)` };
  }
  const fromConfig = siteConfigTimezone(args.siteConfig ?? null);
  if (fromConfig.timezone || fromConfig.problem) return fromConfig;
  const section = typeof args.sourceText === "string" ? siteSection(args.sourceText) : null;
  if (section) {
    const fromSource = siteConfigTimezone(section, "source_text site config section");
    if (fromSource.timezone || fromSource.problem) return fromSource;
  }
  return { timezone: null, source: null };
}

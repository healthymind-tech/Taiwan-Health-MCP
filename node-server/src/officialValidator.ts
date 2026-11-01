/**
 * The official HL7 validator (validator_cli 7.0.1 in its resident HTTP mode: `java -jar validator_cli.jar server
 * <port> -version 4.0.1 -ig <package#version> -tx <server>`, POST /validateResource?profile=…) as the judge of
 * structure, slicing, profiles, invariants / FHIRPath, document rules and terminology (v18 R1 / parity v2).
 *
 * One resident validator per IG package. The in-process TS validator stays as a degraded fallback (mode `prefer`) and
 * is never mixed into an official result: a response says which engine produced it.
 *
 * Configuration (env, read once):
 *   OFFICIAL_VALIDATOR_URLS        comma list of `<package_id>[#<version>]=<base url>`
 *   OFFICIAL_VALIDATOR_MODE        off | prefer (official, TS fallback when unavailable) | require (no fallback)
 *                                  default: prefer when URLs are set, else off
 *   OFFICIAL_VALIDATOR_TIMEOUT_MS  per request, default 180000
 *   OFFICIAL_VALIDATOR_CONCURRENCY in-flight requests per validator, default 2 (it queues internally anyway)
 */

import { logError, logWarning } from "./logger.js";

export const OFFICIAL_SOURCE = "hl7-validator_cli-7.0.1";

export type OfficialMode = "off" | "prefer" | "require";

export interface OfficialIssue {
  severity: string;
  path: string;
  code: string;
  message: string;
  message_id?: string;
  source: string;
}

export interface OfficialConfig {
  mode: OfficialMode;
  endpoints: Array<{ packageId: string; version: string | null; url: string }>;
  timeoutMs: number;
  concurrency: number;
}

export function parseOfficialConfig(env: Record<string, string | undefined>): OfficialConfig {
  const endpoints: OfficialConfig["endpoints"] = [];
  for (const part of String(env.OFFICIAL_VALIDATOR_URLS ?? "").split(",")) {
    const m = /^\s*([^#=\s]+)(?:#([^=\s]+))?\s*=\s*(\S+?)\/?\s*$/u.exec(part);
    if (m) endpoints.push({ packageId: m[1], version: m[2] ?? null, url: m[3] });
  }
  const raw = String(env.OFFICIAL_VALIDATOR_MODE ?? "").trim();
  const mode: OfficialMode = raw === "off" || raw === "prefer" || raw === "require" ? raw : endpoints.length ? "prefer" : "off";
  const num = (v: string | undefined, d: number): number => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { mode, endpoints, timeoutMs: num(env.OFFICIAL_VALIDATOR_TIMEOUT_MS, 180_000), concurrency: num(env.OFFICIAL_VALIDATOR_CONCURRENCY, 2) };
}

/** OperationOutcome → issues in the MCP issue shape (path = the first expression, as validator_cli reports it). */
export function issuesFromOutcome(oo: unknown): OfficialIssue[] {
  if (!oo || typeof oo !== "object" || (oo as any).resourceType !== "OperationOutcome") throw new Error("not an OperationOutcome");
  const out: OfficialIssue[] = [];
  for (const i of Array.isArray((oo as any).issue) ? (oo as any).issue : []) {
    if (!i || typeof i !== "object") continue;
    const ext: any[] = Array.isArray(i.extension) ? i.extension : [];
    const id = ext.find((x) => typeof x?.url === "string" && x.url.endsWith("operationoutcome-message-id"))?.valueCode;
    const path = (Array.isArray(i.expression) && i.expression[0]) || (Array.isArray(i.location) && i.location[0]) || "";
    out.push({
      severity: String(i.severity ?? "error"),
      path: String(path),
      code: String(i.code ?? "invalid"),
      message: String(i.details?.text ?? i.diagnostics ?? ""),
      ...(typeof id === "string" ? { message_id: id } : {}),
      source: OFFICIAL_SOURCE,
    });
  }
  return out;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A resident validator is unavailable (down, timed out, not configured for the package). */
export class OfficialUnavailable extends Error {}

export class OfficialValidator {
  private inflight = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();
  private downUntil = new Map<string, number>();

  constructor(readonly config: OfficialConfig, private readonly fetchImpl: Fetch = fetch as unknown as Fetch, private readonly now: () => number = Date.now) {}

  get mode(): OfficialMode {
    return this.config.mode;
  }

  /** The validator for a package (exact version first, then any version of the id), or null. */
  endpointFor(packageId: string, version: string): string | null {
    if (this.config.mode === "off") return null;
    const e = this.config.endpoints.find((x) => x.packageId === packageId && x.version === version) ?? this.config.endpoints.find((x) => x.packageId === packageId && x.version === null);
    return e ? e.url : null;
  }

  async validate(base: string, resource: unknown, profile: string | null): Promise<OfficialIssue[]> {
    if ((this.downUntil.get(base) ?? 0) > this.now()) throw new OfficialUnavailable(`official validator ${base} marked down`);
    await this.acquire(base);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.config.timeoutMs);
    try {
      const q = profile ? `?profile=${encodeURIComponent(profile)}` : "";
      const res = await this.fetchImpl(`${base}/validateResource${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/fhir+json", Accept: "application/fhir+json" },
        body: JSON.stringify(resource),
        signal: ctl.signal,
      });
      if (!res.ok) throw new OfficialUnavailable(`official validator ${base} answered HTTP ${res.status}`);
      return issuesFromOutcome(await res.json());
    } catch (e) {
      // a dead / hung validator is skipped for 30 s so callers fall back quickly instead of each waiting the timeout
      this.downUntil.set(base, this.now() + 30_000);
      logError("official validator call failed", { endpoint: base, error: String((e as Error).message) });
      throw e instanceof OfficialUnavailable ? e : new OfficialUnavailable(String((e as Error).message));
    } finally {
      clearTimeout(timer);
      this.release(base);
    }
  }

  private async acquire(base: string): Promise<void> {
    const n = this.inflight.get(base) ?? 0;
    if (n < this.config.concurrency) {
      this.inflight.set(base, n + 1);
      return;
    }
    await new Promise<void>((resolve) => {
      const q = this.waiters.get(base) ?? [];
      q.push(resolve);
      this.waiters.set(base, q);
    });
    this.inflight.set(base, (this.inflight.get(base) ?? 0) + 1);
  }

  private release(base: string): void {
    this.inflight.set(base, Math.max(0, (this.inflight.get(base) ?? 1) - 1));
    const next = this.waiters.get(base)?.shift();
    if (next) next();
  }
}

let shared: OfficialValidator | null = null;

export function officialValidator(): OfficialValidator {
  if (!shared) {
    shared = new OfficialValidator(parseOfficialConfig(process.env));
    if (shared.mode !== "off") logWarning("official validator enabled", { mode: shared.mode, endpoints: shared.config.endpoints.map((e) => `${e.packageId}${e.version ? `#${e.version}` : ""}`) });
  }
  return shared;
}

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
 *   OFFICIAL_VALIDATOR_TIMEOUT_MS  per request once sent (queueing in MCP excluded), default 120000
 *   OFFICIAL_VALIDATOR_CONCURRENCY in-flight requests per validator, default 1 — its HTTP server handles one request at
 *                                  a time, so more only queue inside it where the timeout cannot see them
 *
 * Every request carries validator_cli's own `validationTimeout` (OFFICIAL_VALIDATOR_VALIDATION_TIMEOUT_MS, default the
 * request timeout − 30 s): a validation that runs too long stops inside the validator with a partial result (reported as
 * `unverified`, the result incomplete) instead of holding the validator's single request thread.
 *
 * Terminology-server trouble inside an official result (a tx.fhir.org timeout, an unreachable server) is not a finding
 * about the instance: those issues are returned apart as `unverified` (the caller marks the result incomplete), and
 * because validator_cli keeps such failures in its in-memory terminology cache for the life of the process
 * (TerminologyCache.store: transient failures are not persisted but stay in memory), the validator is restarted
 * (POST /stop; the container's restart policy brings it back) at most once per 10 minutes, and calls wait for it.
 */

import { logError, logWarning } from "./logger.js";

export const OFFICIAL_SOURCE = "hl7-validator_cli-7.0.1";

export type OfficialMode = "off" | "prefer" | "require";

export interface OfficialIssue {
  severity: string;
  path: string;
  /** the path exactly as validator_cli wrote it, when it carried a Type/id comment */
  official_path?: string;
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
  /** validator_cli's per-request time limit (`validationTimeout`, ms): it stops and returns a partial result instead of
   *  holding its single request thread (v20.2 — one slow ValueSet check must not take the service down) */
  validationTimeoutMs: number;
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
  const timeoutMs = num(env.OFFICIAL_VALIDATOR_TIMEOUT_MS, 120_000);
  return {
    mode,
    endpoints,
    timeoutMs,
    concurrency: num(env.OFFICIAL_VALIDATOR_CONCURRENCY, 1),
    validationTimeoutMs: num(env.OFFICIAL_VALIDATOR_VALIDATION_TIMEOUT_MS, Math.max(10_000, timeoutMs - 30_000)),
  };
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
    // validator_cli writes the resource's type / id into the path as a FHIRPath comment (`entry[1].resource/*Patient/x*/`);
    // MCP paths carry none, so prefix matching (per-entry split, caused_by, invariants, slices) works on the plain path
    const plain = String(path).replace(/\/\*[^*]*\*\//gu, "");
    out.push({
      severity: String(i.severity ?? "error"),
      path: plain,
      ...(plain !== String(path) ? { official_path: String(path) } : {}),
      code: String(i.code ?? "invalid"),
      message: String(i.details?.text ?? i.diagnostics ?? ""),
      ...(typeof id === "string" ? { message_id: id } : {}),
      source: OFFICIAL_SOURCE,
    });
  }
  return out;
}

/** An issue that reports terminology-server trouble (timeout, unreachable, 5xx), not a property of the instance. */
const TX_TRANSIENT =
  /SocketTimeoutException|SocketException|ConnectException|UnknownHostException|SSLException|NoRouteToHostException|timed out|Read timeout|Connection (?:refused|reset)|Error contacting|Unable to connect|could not connect|Too Many Requests|HTTP(?: status)?[: ]+(?:5\d\d|429)\b|terminology server[^.]{0,80}(?:unavailable|not available|error|could not be reached|did not respond)/iu;

// v20.2: validator_cli's own per-request time limit (`validationTimeout`): the result is incomplete, not a finding
const VALIDATION_TIMED_OUT = /^Validation process exceeded maximum allowed time of \d+ms/u;

export function isTransientTxIssue(i: { message: string }): boolean {
  return TX_TRANSIENT.test(i.message) || VALIDATION_TIMED_OUT.test(i.message);
}

export interface OfficialResult {
  issues: OfficialIssue[];
  /** terminology-server failures: the codes concerned could not be verified this time */
  unverified: OfficialIssue[];
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A resident validator is unavailable (down, timed out, not configured for the package). */
export class OfficialUnavailable extends Error {}

export class OfficialValidator {
  private inflight = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();
  private downUntil = new Map<string, number>();
  private restarting = new Map<string, Promise<void>>();
  private lastRestart = new Map<string, number>();

  constructor(
    readonly config: OfficialConfig,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get mode(): OfficialMode {
    return this.config.mode;
  }

  /** The validator for a package (exact version first, then any version of the id), or null. */
  endpointFor(packageId: string, version: string): string | null {
    if (this.config.mode === "off") return null;
    const e = this.config.endpoints.find((x) => x.packageId === packageId && x.version === version) ?? this.config.endpoints.find((x) => x.packageId === packageId && x.version === null);
    return e ? e.url : null;
  }

  async validate(base: string, resource: unknown, profile: string | null): Promise<OfficialResult> {
    if ((this.downUntil.get(base) ?? 0) > this.now()) throw new OfficialUnavailable(`official validator ${base} is not reachable (retry shortly)`);
    const restarting = this.restarting.get(base);
    if (restarting) await restarting;
    await this.acquire(base);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.config.timeoutMs);
    try {
      const q = `?validationTimeout=${this.config.validationTimeoutMs}${profile ? `&profile=${encodeURIComponent(profile)}` : ""}`;
      const res = await this.fetchImpl(`${base}/validateResource${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/fhir+json", Accept: "application/fhir+json" },
        body: JSON.stringify(resource),
        signal: ctl.signal,
      });
      if (!res.ok) throw new OfficialUnavailable(`official validator ${base} answered HTTP ${res.status}`);
      const all = issuesFromOutcome(await res.json());
      const unverified = all.filter(isTransientTxIssue);
      // only a terminology-server failure is cached inside the validator (restart to drop it); its own time limit is not
      if (unverified.some((i) => TX_TRANSIENT.test(i.message))) this.scheduleRestart(base);
      return { issues: all.filter((i) => !isTransientTxIssue(i)), unverified };
    } catch (e) {
      const timedOut = ctl.signal.aborted;
      // a refused / reset connection marks the validator down briefly so callers fall back at once; a timeout does
      // not (the validator is alive, the request was slow)
      if (!timedOut && !(e instanceof OfficialUnavailable)) this.downUntil.set(base, this.now() + 15_000);
      logError("official validator call failed", { endpoint: base, error: timedOut ? `timed out after ${this.config.timeoutMs} ms` : String((e as Error).message) });
      if (timedOut) throw new OfficialUnavailable(`official validator ${base} did not answer within ${Math.round(this.config.timeoutMs / 1000)} s`);
      throw e instanceof OfficialUnavailable ? e : new OfficialUnavailable(String((e as Error).message));
    } finally {
      clearTimeout(timer);
      this.release(base);
    }
  }

  /**
   * Restart a validator whose terminology cache holds a transient failure (POST /stop → the container restarts), at
   * most once per 10 minutes; later calls wait (≤ 3 min) until it answers again.
   */
  private scheduleRestart(base: string): void {
    const last = this.lastRestart.get(base) ?? -Infinity;
    if (this.now() - last < 600_000 || this.restarting.has(base)) return;
    this.lastRestart.set(base, this.now());
    logWarning("official validator: terminology failure cached in the validator; restarting it", { endpoint: base });
    const p = (async (): Promise<void> => {
      try {
        await this.fetchImpl(`${base}/stop`, { method: "POST", headers: {}, body: "", signal: AbortSignal.timeout(10_000) });
      } catch {
        // already gone
      }
      const until = this.now() + 180_000;
      await this.sleep(5_000);
      while (this.now() < until) {
        try {
          // any HTTP answer (405 for GET) means the server is back
          await this.fetchImpl(`${base}/version`, { method: "GET", headers: {}, body: undefined as unknown as string, signal: AbortSignal.timeout(3_000) });
          return;
        } catch {
          await this.sleep(3_000);
        }
      }
    })().finally(() => this.restarting.delete(base));
    this.restarting.set(base, p);
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

type JsonObj = Record<string, any>;

/** The references (`reference` strings) under a resource element path like `subject` / `medication[x]` / `section.entry`. */
function refsAt(resource: unknown, sub: string): Array<{ path: string; ref: string }> {
  const out: Array<{ path: string; ref: string }> = [];
  const walk = (node: unknown, parts: string[], at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, k) => walk(n, parts, `${at}[${k}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as JsonObj;
    if (!parts.length) {
      if (typeof o.reference === "string") out.push({ path: at, ref: o.reference });
      return;
    }
    const [head, ...rest] = parts;
    const name = head.replace(/\[\d+\]$/u, "");
    const keys = name.endsWith("[x]") ? Object.keys(o).filter((k) => k.startsWith(name.slice(0, -3)) && /^[A-Z]/u.test(k.slice(name.length - 3))) : [name];
    for (const k of keys) if (k in o) walk(o[k], rest, `${at}.${k}`);
  };
  walk(resource, sub.split(".").filter(Boolean), "");
  return out;
}

function allRefs(node: unknown, at = ""): Array<{ path: string; ref: string }> {
  const out: Array<{ path: string; ref: string }> = [];
  if (Array.isArray(node)) node.forEach((n, k) => out.push(...allRefs(n, `${at}[${k}]`)));
  else if (node && typeof node === "object") {
    const o = node as JsonObj;
    if (typeof o.reference === "string") out.push({ path: at, ref: o.reference });
    for (const [k, v] of Object.entries(o)) if (k !== "reference" && typeof v === "object") out.push(...allRefs(v, `${at}.${k}`));
  }
  return out;
}

/**
 * validator_cli 7.0.1 names the wrong entry in two Bundle messages (the index is one too high): `Entry 'u' isn't
 * reachable …` (issue path `Bundle.entry[k]`) and `Can't find 'r' in the bundle (Bundle.entry[k].resource.x)`. The
 * official path / message are kept; `location_path` names the element the message is about, found by the fullUrl /
 * reference the message quotes (the pointer layer and the per-entry split use it).
 */
export function relocateBundleIssues(bundle: unknown, issues: Array<JsonObj>): void {
  const b = bundle as JsonObj;
  if (!b || b.resourceType !== "Bundle" || !Array.isArray(b.entry)) return;
  const entries: JsonObj[] = b.entry;
  for (const i of issues) {
    const msg = String(i.message ?? "");
    const reach = /^Entry '([^']+)' isn't reachable by traversing links/u.exec(msg);
    if (reach) {
      const j = entries.findIndex((e) => e && e.fullUrl === reach[1]);
      if (j >= 0) i.location_path = `Bundle.entry[${j}]`;
      continue;
    }
    const cf = /^Can't find '([^']+)' in the bundle(?: \(([^)]*)\))?/u.exec(msg);
    if (!cf) continue;
    const ref = cf[1];
    // where the message / path says the reference is: (entry index, element path below the resource)
    const hints: Array<[number, string]> = [];
    const inMsg = /^Bundle\.entry\[(\d+)\]\.resource\.(.+)$/u.exec(cf[2] ?? "");
    if (inMsg) hints.push([Number(inMsg[1]), inMsg[2]]);
    const inPath = /^Bundle\.entry\[(\d+)\]\.resource\.(.+)$/u.exec(String(i.path ?? ""));
    if (inPath) hints.push([Number(inPath[1]), inPath[2].replace(/\[\d+\]/gu, "")]);
    let found: string | null = null;
    for (const [k, sub] of hints) {
      for (const j of [k, k - 1, k + 1]) {
        if (j < 0 || j >= entries.length) continue;
        const hit = refsAt(entries[j]?.resource, sub).find((r) => r.ref === ref);
        if (hit) {
          found = `Bundle.entry[${j}].resource${hit.path}`;
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      // anywhere in the Bundle: the first Reference with this value
      for (let j = 0; j < entries.length && !found; j++) {
        const hit = allRefs(entries[j]?.resource).find((r) => r.ref === ref);
        if (hit) found = `Bundle.entry[${j}].resource${hit.path}`;
      }
    }
    if (found) i.location_path = found;
  }
}

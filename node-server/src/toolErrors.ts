/**
 * Error shaping for MCP tool calls, written for an LLM client.
 *
 * Every helper here is pure (no DB, no network) so it can be unit tested. The
 * goal is that every failed tool call tells the calling model three things:
 * a stable `code`, what went wrong in plain words (`message`), and what to do
 * next (`hint`) — instead of a raw zod issue dump, a SQL error or "fetch failed".
 *
 * Used by mcp.ts (argument validation, the error boundary around every
 * handler, unknown / not-registered tools), server.ts (the POST /tools bridge)
 * and fhirServerService.ts (external FHIR server transport errors).
 */
import { z } from "zod";

export interface ToolErrorInfo {
  code: string;
  message: string;
  hint: string;
  retryable: boolean;
}

// ── Argument validation ──────────────────────────────────────────────────────

export interface ParamSpec {
  name: string;
  /** Human type: "string", "integer", "number", "boolean", "array", "object", "one of: a | b". */
  type: string;
  required: boolean;
  default?: unknown;
  allowed?: string[];
  min?: number;
  max?: number;
  example: unknown;
}

interface ZodDefLike {
  typeName?: string;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  defaultValue?: () => unknown;
  values?: unknown;
  value?: unknown;
  options?: z.ZodTypeAny[];
  checks?: Array<{ kind: string; value?: number; inclusive?: boolean }>;
  minLength?: { value: number } | null;
}

function defOf(t: z.ZodTypeAny): ZodDefLike {
  return ((t as unknown as { _def?: ZodDefLike })._def ?? {}) as ZodDefLike;
}

/** Strip Optional / Nullable / Default / Effects wrappers; report whether the param may be omitted. */
function unwrap(t: z.ZodTypeAny): { core: z.ZodTypeAny; optional: boolean; defaultValue: unknown; hasDefault: boolean } {
  let cur = t;
  let optional = false;
  let hasDefault = false;
  let defaultValue: unknown = undefined;
  for (let i = 0; i < 10; i++) {
    const d = defOf(cur);
    if (d.typeName === "ZodOptional" || d.typeName === "ZodNullable") {
      optional = true;
      cur = d.innerType as z.ZodTypeAny;
    } else if (d.typeName === "ZodDefault") {
      optional = true;
      if (!hasDefault) {
        hasDefault = true;
        try {
          defaultValue = d.defaultValue?.();
        } catch {
          defaultValue = undefined;
        }
      }
      cur = d.innerType as z.ZodTypeAny;
    } else if (d.typeName === "ZodEffects") {
      cur = d.schema as z.ZodTypeAny;
    } else if (d.typeName === "ZodBranded" || d.typeName === "ZodReadonly" || d.typeName === "ZodCatch") {
      cur = (d.type ?? d.innerType) as z.ZodTypeAny;
    } else {
      break;
    }
    if (!cur) break;
  }
  return { core: cur, optional, defaultValue, hasDefault };
}

/** Describe one parameter of a tool input shape. */
export function describeParam(name: string, schema: z.ZodTypeAny): ParamSpec {
  const { core, optional, defaultValue, hasDefault } = unwrap(schema);
  const d = core ? defOf(core) : {};
  const spec: ParamSpec = { name, type: "any", required: !optional, example: null };
  if (hasDefault && defaultValue !== undefined) spec.default = defaultValue;
  switch (d.typeName) {
    case "ZodString":
      spec.type = "string";
      spec.example = typeof defaultValue === "string" && defaultValue ? defaultValue : `<${name}>`;
      break;
    case "ZodNumber": {
      const isInt = (d.checks ?? []).some((c) => c.kind === "int");
      spec.type = isInt ? "integer" : "number";
      for (const c of d.checks ?? []) {
        if (c.kind === "min" && typeof c.value === "number") spec.min = c.value;
        if (c.kind === "max" && typeof c.value === "number") spec.max = c.value;
      }
      if (typeof defaultValue === "number") spec.example = defaultValue;
      else if (spec.min !== undefined && spec.max !== undefined) spec.example = isInt ? Math.ceil((spec.min + spec.max) / 2) : (spec.min + spec.max) / 2;
      else if (spec.min !== undefined) spec.example = isInt ? Math.ceil(spec.min) + (Number.isInteger(spec.min) ? 1 : 0) : spec.min + 1;
      else if (spec.max !== undefined) spec.example = Math.min(1, spec.max);
      else spec.example = 1;
      break;
    }
    case "ZodBoolean":
      spec.type = "boolean";
      spec.example = typeof defaultValue === "boolean" ? defaultValue : true;
      break;
    case "ZodEnum":
    case "ZodNativeEnum": {
      const raw = d.values;
      const vals = Array.isArray(raw) ? raw.map(String) : raw && typeof raw === "object" ? Object.values(raw as Record<string, unknown>).map(String) : [];
      spec.allowed = vals;
      spec.type = `one of: ${vals.join(" | ")}`;
      spec.example = defaultValue ?? vals[0] ?? null;
      break;
    }
    case "ZodLiteral":
      spec.allowed = [String(d.value)];
      spec.type = `exactly ${JSON.stringify(d.value)}`;
      spec.example = d.value;
      break;
    case "ZodArray":
      spec.type = "array";
      spec.example = [];
      break;
    case "ZodObject":
    case "ZodRecord":
      spec.type = "object";
      spec.example = {};
      break;
    case "ZodUnion": {
      const parts = (d.options ?? []).map((o) => describeParam(name, o));
      spec.type = parts.map((p) => p.type).join(" or ") || "any";
      spec.example = parts[0]?.example ?? null;
      break;
    }
    default:
      spec.type = "any";
      spec.example = null;
  }
  return spec;
}

export function describeShape(shape: z.ZodRawShape): ParamSpec[] {
  return Object.entries(shape ?? {}).map(([name, schema]) => describeParam(name, schema as z.ZodTypeAny));
}

/** Levenshtein distance (small strings only). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array<number>(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

/** Closest candidate name to `input` (case-insensitive, edit distance / shared word), or null. */
export function closestName(input: string, candidates: readonly string[]): string | null {
  const x = input.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const y = c.toLowerCase();
    let score = editDistance(x, y);
    if (y.includes(x) || x.includes(y)) score = Math.min(score, 1);
    const xs = x.split(/[_\-\s]+/).filter((w) => w.length > 2);
    if (xs.some((w) => y.split(/[_\-\s]+/).includes(w))) score = Math.min(score, 2);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  const limit = Math.max(2, Math.floor(x.length / 3));
  return best !== null && bestScore <= limit ? best : null;
}

function short(v: unknown): string {
  let s: string;
  try {
    s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

function typeOfValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function boundText(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `between ${min} and ${max}`;
  if (min !== undefined) return `>= ${min}`;
  if (max !== undefined) return `<= ${max}`;
  return "";
}

export interface ArgumentProblem {
  parameter: string;
  problem: string;
  expected: string;
  example: unknown;
}

export interface ArgumentErrorInfo extends ToolErrorInfo {
  code: "INVALID_ARGUMENTS";
  problems: ArgumentProblem[];
  unknown_parameters: string[];
  expected_parameters: ParamSpec[];
  example_arguments: Record<string, unknown>;
}

/**
 * Turn zod issues for a tool call into an actionable message: which parameter, which rule, an example value,
 * the full parameter list, and any argument names the tool does not take (with a "did you mean").
 */
export function describeArgumentIssues(
  tool: string,
  shape: z.ZodRawShape,
  issues: readonly z.ZodIssue[],
  args: unknown,
): ArgumentErrorInfo {
  const params = describeShape(shape);
  const byName = new Map(params.map((p) => [p.name, p]));
  const given = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const unknown = Object.keys(given).filter((k) => !byName.has(k));

  const problems: ArgumentProblem[] = issues.map((issue) => {
    const top = String(issue.path[0] ?? "");
    const pname = issue.path.length ? issue.path.join(".") : "(arguments)";
    const spec = byName.get(top);
    const expected = spec ? spec.type + (spec.min !== undefined || spec.max !== undefined ? ` ${boundText(spec.min, spec.max)}` : "") : "";
    const example = spec && issue.path.length === 1 ? spec.example : undefined;
    const value = issue.path.reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string | number, unknown>)[k] : undefined), given);
    let problem: string;
    const iss = issue as z.ZodIssue & Record<string, unknown>;
    switch (issue.code) {
      case "invalid_type":
        if (iss.received === "undefined") problem = "is required but was not provided";
        else if (iss.expected === "number" && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
          problem = `must be a JSON number, not a string (got ${short(value)}; send ${Number(value)} without quotes)`;
        else problem = `must be ${String(iss.expected)} (got ${String(iss.received)}${value !== undefined ? ` ${short(value)}` : ""})`;
        break;
      case "invalid_enum_value":
        problem = `must be one of ${((iss.options as unknown[]) ?? []).map((o) => JSON.stringify(o)).join(", ")} (got ${short(iss.received)})`;
        break;
      case "too_small":
        if (iss.type === "string") problem = `must be at least ${String(iss.minimum)} character(s)`;
        else if (iss.type === "array") problem = `must contain at least ${String(iss.minimum)} item(s)`;
        else problem = `must be ${iss.inclusive ? ">=" : ">"} ${String(iss.minimum)} (got ${short(value)})`;
        break;
      case "too_big":
        if (iss.type === "string") problem = `must be at most ${String(iss.maximum)} character(s)`;
        else if (iss.type === "array") problem = `must contain at most ${String(iss.maximum)} item(s)`;
        else problem = `must be ${iss.inclusive ? "<=" : "<"} ${String(iss.maximum)} (got ${short(value)})`;
        break;
      case "not_multiple_of":
        problem = `must be a multiple of ${String(iss.multipleOf)}`;
        break;
      case "unrecognized_keys":
        problem = `has unknown key(s): ${((iss.keys as string[]) ?? []).join(", ")}`;
        break;
      default:
        problem = issue.message;
    }
    return { parameter: pname, problem, expected, example };
  });

  const exampleArgs: Record<string, unknown> = {};
  for (const p of params) if (p.required) exampleArgs[p.name] = p.example;
  for (const pr of problems) {
    const top = pr.parameter.split(".")[0];
    const spec = byName.get(top);
    if (spec && !(top in exampleArgs)) exampleArgs[top] = spec.example;
  }

  const paramList = params
    .map((p) => `${p.name} (${p.type}${p.required ? ", required" : p.default !== undefined ? `, default ${short(p.default)}` : ", optional"})`)
    .join("; ");
  const problemText = problems
    .map((p) => `\`${p.parameter}\` ${p.problem}${p.example !== undefined && p.example !== null ? ` — e.g. ${short(p.example)}` : ""}`)
    .join("; ");
  const unknownText = unknown.length
    ? ` Argument(s) not accepted by this tool (ignored): ${unknown
        .map((u) => {
          const near = closestName(u, params.map((p) => p.name));
          return near ? `${u} (did you mean ${near}?)` : u;
        })
        .join(", ")}.`
    : "";
  return {
    code: "INVALID_ARGUMENTS",
    message: `Invalid arguments for ${tool}: ${problemText || "the arguments do not match the input schema"}.${unknownText}`,
    hint: `Fix the listed parameter(s) and call ${tool} again. Parameters: ${paramList || "(none)"}. Minimal example arguments: ${JSON.stringify(exampleArgs)}`,
    retryable: true,
    problems,
    unknown_parameters: unknown,
    expected_parameters: params,
    example_arguments: exampleArgs,
  };
}

/** A zod validation failure for a tool call, carrying the actionable description (still a ZodError for callers). */
export class ToolArgumentError extends z.ZodError {
  readonly info: ArgumentErrorInfo;
  constructor(issues: z.ZodIssue[], info: ArgumentErrorInfo) {
    super(issues);
    this.info = info;
  }
}

// ── Unknown / not-registered tools ───────────────────────────────────────────

/** Data module behind each gated tool group: what is missing and where an admin loads it. */
export const MODULE_DATA_SOURCES: Readonly<Record<string, { data: string; admin_page: string }>> = {
  icd: { data: "ICD-10-CM / ICD-10-PCS code tables", admin_page: "醫療術語 → ICD-10 (admin console /admin/terminology)" },
  lab: { data: "LOINC terminology", admin_page: "醫療術語 → LOINC (admin console /admin/terminology)" },
  snomed: { data: "SNOMED CT International release", admin_page: "醫療術語 → SNOMED CT (admin console /admin/terminology)" },
  drug: { data: "Taiwan FDA drug license index", admin_page: "藥品 (admin console /admin/drug)" },
  ig: { data: "FHIR Implementation Guide packages", admin_page: "IG 套件庫 (admin console /admin/ig)" },
  health_supplements: { data: "Taiwan FDA health supplement records", admin_page: "健康食品 (admin console)" },
  food_nutrition: { data: "Taiwan FDA food nutrition database", admin_page: "食品營養 (admin console)" },
};

export interface CatalogRef {
  name: string;
  groupLabel: string;
  /** Module key whose data gates the tool (fhir_condition → icd, fhir_medication → drug), or null when always on. */
  dataModule: string | null;
}

/** Error for a tool name that is unknown, or known but not registered because its module has no data. */
export function toolUnavailableInfo(name: string, catalog: readonly CatalogRef[]): ToolErrorInfo & { available_when?: string } {
  const entry = catalog.find((t) => t.name === name);
  if (!entry) {
    const near = closestName(name, catalog.map((t) => t.name));
    return {
      code: "UNKNOWN_TOOL",
      message: `There is no tool named '${name}' on this server.${near ? ` Did you mean '${near}'?` : ""}`,
      hint: "List the available tools (MCP tools/list, or GET /openapi.json for the REST bridge) and call one of those names.",
      retryable: false,
    };
  }
  const src = entry.dataModule ? MODULE_DATA_SOURCES[entry.dataModule] : undefined;
  if (src) {
    return {
      code: "TOOL_NOT_AVAILABLE",
      message:
        `'${name}' (${entry.groupLabel}) is not available on this server right now: its data (${src.data}) has not been loaded. ` +
        "Other tools are unaffected.",
      hint:
        `Do not retry this call. Tell the user an administrator must import the ${src.data} in the admin console (${src.admin_page}); ` +
        "health_check.services shows which modules are ready. Use another available tool meanwhile.",
      retryable: false,
      available_when: `${src.data} imported`,
    };
  }
  return {
    code: "TOOL_NOT_AVAILABLE",
    message: `'${name}' (${entry.groupLabel}) is not registered on this server right now (its service failed to start).`,
    hint: "Retry later; if it persists, tell the user to check the server logs / admin console 服務健康 page. health_check shows the service status.",
    retryable: true,
  };
}

// ── Exceptions thrown inside a tool handler ──────────────────────────────────

/** True for a node-postgres DatabaseError (5-char SQLSTATE + severity / routine fields). */
export function isPgError(err: unknown): err is Error & { code: string } {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; severity?: unknown; routine?: unknown };
  return typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) && (typeof e.severity === "string" || typeof e.routine === "string");
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

function errCode(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  if (e && typeof e.code === "string") return e.code;
  if (e?.cause && typeof e.cause.code === "string") return e.cause.code;
  return "";
}

/**
 * Classify an exception escaping a tool handler. SQL / connection errors never pass their raw text to the client
 * (the caller logs it); application errors keep their own message (clipped, no stack).
 */
export function classifyToolException(tool: string, err: unknown): ToolErrorInfo & { internal: boolean } {
  if (err instanceof ToolExecutionError) return { ...err.info, internal: false };
  const code = errCode(err);
  if (isPgError(err)) {
    const c = err.code;
    if (c === "42P01" || c === "3F000") {
      return {
        code: "DATA_NOT_LOADED",
        message: `${tool} could not run: the server's data tables for it are missing (the module has not been imported, or was cleared).`,
        hint: "Do not retry. Tell the user an administrator must import this module's data in the admin console; health_check.services shows which modules are ready.",
        retryable: false,
        internal: true,
      };
    }
    if (c === "42703" || c === "42883") {
      return {
        code: "SERVER_SCHEMA_OUTDATED",
        message: `${tool} could not run: the server database schema is older than the server code (a migration has not been applied).`,
        hint: "Do not retry. Tell the user an administrator must apply the pending database migrations (db/migrations) and restart.",
        retryable: false,
        internal: true,
      };
    }
    if (c.startsWith("08") || c === "57P01" || c === "57P02" || c === "57P03" || c === "53300" || c === "53000") {
      return {
        code: "DATABASE_UNAVAILABLE",
        message: `${tool} could not run: the server's database is temporarily unavailable.`,
        hint: "Retry in a minute. If it keeps failing, tell the user the server's database is down (admin console 服務健康).",
        retryable: true,
        internal: true,
      };
    }
    if (c === "57014") {
      return {
        code: "QUERY_TIMEOUT",
        message: `${tool} took too long and was cancelled by the database.`,
        hint: "Narrow the request (a more specific keyword, a smaller limit) and try again.",
        retryable: true,
        internal: true,
      };
    }
    if (c.startsWith("22")) {
      return {
        code: "INVALID_ARGUMENT_VALUE",
        message: `${tool} rejected an argument value (wrong format for the database, e.g. text where a number or date is expected).`,
        hint: "Check each argument's format against the tool's input schema (numbers as JSON numbers, dates as YYYY-MM-DD, ids as listed by the search tools) and call again.",
        retryable: true,
        internal: true,
      };
    }
    return {
      code: "INTERNAL_QUERY_FAILED",
      message: `${tool} failed on the server (database query error). This is a server-side problem, not caused by your arguments.`,
      hint: "Retry once; if it fails again, tell the user the tool is failing on the server and should be reported to the administrator.",
      retryable: true,
      internal: true,
    };
  }
  if (NETWORK_CODES.has(code)) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message: `${tool} could not reach a backing service (${code}).`,
      hint: "Retry in a minute. If it keeps failing, tell the user a backing service of the server (database / cache / object storage) is unreachable.",
      retryable: true,
      internal: true,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    code: "TOOL_EXECUTION_FAILED",
    message: `${tool} failed: ${msg.split("\n")[0].slice(0, 300)}`,
    hint: "Check the arguments against the tool description and try again; if the same call keeps failing, tell the user to report it to the server administrator.",
    retryable: false,
    internal: false,
  };
}

/** Thrown by the tool error boundary: a sanitized, coded failure (message already safe for the client). */
export class ToolExecutionError extends Error {
  readonly info: ToolErrorInfo;
  constructor(info: ToolErrorInfo) {
    super(`[${info.code}] ${info.message} Hint: ${info.hint}`);
    this.name = "ToolExecutionError";
    this.info = info;
  }
}

// ── Outbound HTTP (external FHIR servers, OAuth token endpoints) ─────────────

/**
 * Classify a fetch() failure (no HTTP response) against an external server.
 * `where` names the server for the message, e.g. "FHIR server 'hapi' (https://…)".
 */
export function classifyFetchError(err: unknown, where: string, timeoutSeconds?: number): ToolErrorInfo {
  const name = (err as { name?: unknown } | null)?.name;
  const code = errCode(err);
  const adminFix = "an administrator can check the server entry in the admin console (FHIR 伺服器 → 測試連線)";
  if (name === "AbortError" || name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    return {
      code: "UPSTREAM_TIMEOUT",
      message: `${where} did not respond in time${timeoutSeconds ? ` (${timeoutSeconds}s timeout)` : ""}.`,
      hint: `Retry later or narrow the request (e.g. add search parameters / _count). If it keeps timing out, ${adminFix}.`,
      retryable: true,
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      code: "UPSTREAM_DNS_FAILED",
      message: `${where}: the host name could not be resolved (${code}).`,
      hint: `Do not retry now. The configured base URL is probably wrong or the host no longer exists; ${adminFix}.`,
      retryable: false,
    };
  }
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return {
      code: "UPSTREAM_UNREACHABLE",
      message: `${where} refused or could not be reached (${code}).`,
      hint: `The server may be down or the port/URL is wrong. Retry later; ${adminFix}.`,
      retryable: true,
    };
  }
  if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") {
    return {
      code: "UPSTREAM_CONNECTION_RESET",
      message: `${where} closed the connection unexpectedly (${code}).`,
      hint: "Retry once; if it repeats, the remote server or a proxy is dropping requests.",
      retryable: true,
    };
  }
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    return {
      code: "UPSTREAM_TLS_ERROR",
      message: `${where}: the TLS certificate could not be verified (${code}).`,
      hint: `Do not retry. ${adminFix[0].toUpperCase()}${adminFix.slice(1)} (certificate / https URL).`,
      retryable: false,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    code: "UPSTREAM_REQUEST_FAILED",
    message: `${where}: the request failed before a response was received (${(code || msg).slice(0, 120)}).`,
    hint: `Retry later; if it persists, ${adminFix}.`,
    retryable: true,
  };
}

// ── REST bridge body ─────────────────────────────────────────────────────────

/**
 * Extra fields for a failed `POST /tools/<name>` (added next to the existing error / tool / detail):
 * code, message, hint, retryable, and for argument errors the per-parameter problems + parameter list + example.
 */
export function toolErrorFields(tool: string, exc: unknown): Record<string, unknown> {
  if (exc instanceof ToolArgumentError) {
    const i = exc.info;
    return {
      code: i.code,
      message: i.message,
      hint: i.hint,
      retryable: i.retryable,
      problems: i.problems,
      unknown_parameters: i.unknown_parameters,
      expected_parameters: i.expected_parameters,
      example_arguments: i.example_arguments,
    };
  }
  if (exc instanceof ToolExecutionError) {
    const { code, message, hint, retryable } = exc.info;
    return { code, message, hint, retryable };
  }
  const attached = (exc as { toolError?: ToolErrorInfo } | null)?.toolError;
  if (attached && typeof attached === "object") return { ...attached };
  if (exc instanceof z.ZodError) {
    const i = describeArgumentIssues(tool, {}, exc.issues, undefined);
    return { code: i.code, message: i.message, hint: i.hint, retryable: true };
  }
  const { internal: _internal, ...info } = classifyToolException(tool, exc);
  return { ...info };
}

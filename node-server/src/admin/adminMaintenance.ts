/**
 * Per-module maintenance mode: state, cached reads and the toggle.
 *
 * Originally a port of `src/admin_maintenance.py` (`MAINTENANCE_MODULES`, the short-TTL cache, `get_states`,
 * `set_enabled`).
 *
 * State lives in `admin.app_settings` (group_key "maintenance", one row per module_key, value "true"/"false").
 *
 * Effect: the flag gates MCP tools. `withMaintenanceGate` in ../mcp.ts (composed into the single dispatch wrapper
 * next to `withToolMetrics`, so /mcp, POST /tools/<name> and the admin playground are all covered) reads
 * `getStates` (5 s cache — a toggle takes effect within ~5 s in every process) and makes calls to the tools of a
 * module in maintenance return an isError result with code MODULE_MAINTENANCE (en + zh-TW message). Group → module
 * mapping: mcp.ts `GROUP_MAINTENANCE_MODULE` (rxnorm has no tool group, so its flag gates nothing). tools/list is
 * deliberately left unchanged so clients see no tool-list churn. The admin console also shows the flag (module
 * pages, dashboard, MCP tool catalog / playground).
 */

import { query, withTransaction } from "../db.js";

const GROUP_KEY = "maintenance";

/** Raised when a module does not support maintenance mode (mirrors Python ValueError → HTTP 400). */
export class MaintenanceValueError extends Error {}

/** Modules that currently expose a maintenance toggle. */
export const MAINTENANCE_MODULES: readonly string[] = ["drug", "icd", "loinc", "snomed", "ig", "rxnorm"];

const CACHE_TTL_MS = 5000;
let _cache: { at: number; states: Map<string, boolean> } | null = null;

export function bustCache(): void {
  _cache = null;
}

/** Mirror `_coerce_bool`. */
function coerceBool(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/** Mirror `_load_all`: {module_key: enabled} for every stored row, cached. */
async function loadAll(): Promise<Map<string, boolean>> {
  const now = Date.now();
  if (_cache !== null && now - _cache.at < CACHE_TTL_MS) return _cache.states;
  const res = await query<{ key: string; value: string | null }>(
    "SELECT key, value FROM admin.app_settings WHERE group_key = $1",
    [GROUP_KEY],
  );
  const states = new Map<string, boolean>();
  for (const r of res.rows) states.set(r.key, coerceBool(r.value));
  _cache = { at: now, states };
  return states;
}

/**
 * Faithful port of `get_states`: {module_key: enabled} for the requested keys
 * (defaults to every maintenance-capable module, sorted). Always includes a
 * value for each requested key. Insertion order matches Python's sorted default.
 */
export async function getStates(moduleKeys?: readonly string[]): Promise<Record<string, boolean>> {
  const keys = moduleKeys !== undefined ? [...moduleKeys] : [...MAINTENANCE_MODULES].sort();
  const states = await loadAll();
  const out: Record<string, boolean> = {};
  for (const k of keys) out[k] = states.get(k) ?? false;
  return out;
}

/**
 * Faithful port of `set_enabled`: persist the maintenance flag for a module and
 * return the new state. Upserts into `admin.app_settings` and appends an audit
 * row, both in one transaction, then busts the cache.
 *
 * Throws `MaintenanceValueError` if the module does not support maintenance mode.
 */
export async function setEnabled(moduleKey: string, enabled: boolean, updatedBy: string): Promise<boolean> {
  if (!MAINTENANCE_MODULES.includes(moduleKey)) {
    throw new MaintenanceValueError(`Module '${moduleKey}' does not support maintenance mode`);
  }
  const value = enabled ? "true" : "false";
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO admin.app_settings (group_key, key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (group_key, key)
       DO UPDATE SET value = EXCLUDED.value,
                    updated_by = EXCLUDED.updated_by,
                    updated_at = NOW()`,
      [GROUP_KEY, moduleKey, value, updatedBy],
    );
    await client.query(
      `INSERT INTO admin.admin_audit_log
          (admin_user, action, target_type, target_id, payload_json)
       VALUES ($1, 'set_maintenance', 'module', $2, $3::jsonb)`,
      [updatedBy, moduleKey, JSON.stringify({ enabled })],
    );
  });
  bustCache();
  return enabled;
}

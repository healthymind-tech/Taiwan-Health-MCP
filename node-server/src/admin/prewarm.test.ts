import { test } from "node:test";
import assert from "node:assert/strict";
import { prewarmRelations } from "./prewarm.js";

function fakeClient(opts: { extension: boolean; existing: Set<string>; failing?: Set<string> }) {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push(sql);
      if (sql.includes("pg_extension")) return { rows: [{ ok: opts.extension }] };
      const rel = String(params?.[0]);
      if (sql.includes("reltoastrelid")) return { rows: opts.existing.has(rel) ? [{ oid: `pg_toast.of_${rel}` }] : [] };
      if (sql.includes("to_regclass")) return { rows: [{ oid: opts.existing.has(rel) ? rel : null }] };
      if (sql.includes("pg_prewarm(")) {
        if (opts.failing?.has(rel)) throw new Error("could not read block");
        return { rows: [{ blocks: "128" }] };
      }
      throw new Error(`unexpected sql ${sql}`);
    },
  };
}

test("returns null without the pg_prewarm extension and prewarms nothing", async () => {
  const c = fakeClient({ extension: false, existing: new Set(["a"]) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(await prewarmRelations(c as any, ["a"]), null);
  assert.equal(c.calls.filter((s) => s.includes("pg_prewarm(")).length, 0);
});

test("skips missing relations and keeps going after a failure", async () => {
  const c = fakeClient({ extension: true, existing: new Set(["a", "c"]), failing: new Set(["a"]) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (await prewarmRelations(c as any, ["a", "b", "c"]))!;
  assert.deepEqual(
    r.map((x) => [x.relation, x.blocks, x.skipped ?? null, Boolean(x.error)]),
    [
      ["a", null, null, true],
      ["b", null, "missing", false],
      ["c", 128, null, false],
    ],
  );
});

test("toast: entries resolve the TOAST relation and pass the mode through", async () => {
  const seen: unknown[][] = [];
  const c = fakeClient({ extension: true, existing: new Set(["t"]) });
  const orig = c.query.bind(c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (c as any).query = async (sql: string, params?: unknown[]) => {
    if (sql.includes("pg_prewarm(")) seen.push(params ?? []);
    return orig(sql, params);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (await prewarmRelations(c as any, ["toast:t", "toast:none"], "prefetch"))!;
  assert.deepEqual(seen, [["pg_toast.of_t", "prefetch"]]);
  assert.equal(r[1].skipped, "missing");
});

/**
 * rankSnomed hierarchy filter: which plan shape each hierarchy size / database state gets.
 * Pure unit tests over a fake query function (no Postgres).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rankSnomed,
  resetSnomedAncestorsProbe,
  SNOMED_FSN_TYPE,
  SNOMED_HIERARCHY_EXACT_MAX,
} from "./terminologyRanking.js";

interface Call {
  sql: string;
  params: unknown[];
}

/** Fake `query`: hierarchy size, whether snomed.concept_ancestors is filled, one pooled concept. */
function fakeDb(opts: { size: number; ancestors: "missing" | "empty" | "filled" }) {
  const calls: Call[] = [];
  const q = (async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("count(*)::int AS n")) return { rows: [{ n: Math.min(opts.size, SNOMED_HIERARCHY_EXACT_MAX + 1) }] };
    if (sql.includes("to_regclass('snomed.concept_ancestors')")) return { rows: [{ ok: opts.ancestors !== "missing" }] };
    if (sql.includes("EXISTS (SELECT 1 FROM snomed.concept_ancestors)")) return { rows: [{ ok: opts.ancestors === "filled" }] };
    if (sql.includes("FROM snomed.descriptions WHERE concept_id = ANY")) {
      return {
        rows: [
          { concept_id: "80891009", type_id: SNOMED_FSN_TYPE, term: "Heart structure (body structure)", us_preferred: false },
          { concept_id: "80891009", type_id: "900000000000013009", term: "Heart structure", us_preferred: true },
        ],
      };
    }
    return { rows: [{ concept_id: "80891009", active: true, sim: 0.8 }] };
  }) as never;
  const pool = (): Call => {
    const c = calls.find((x) => x.sql.includes("lex AS"));
    assert.ok(c, "pool query issued");
    return c;
  };
  return { q, calls, pool };
}

const VEC = "[0.1,0.2]";

test("no filter: plain full-text ∪ nearest-vector pool, no hierarchy probes", async () => {
  resetSnomedAncestorsProbe();
  const db = fakeDb({ size: 0, ancestors: "filled" });
  const r = await rankSnomed("heart", VEC, 5, {}, db.q);
  assert.equal(r[0].concept_id, "80891009");
  assert.equal(r[0].preferred, "Heart structure");
  assert.equal(db.calls.filter((c) => c.sql.includes("count(*)::int AS n")).length, 0);
  const p = db.pool();
  assert.doesNotMatch(p.sql, /descendants|concept_ancestors/);
  assert.match(p.sql, /ORDER BY \(e\.embedding <=> \$2::halfvec\) LIMIT 40/);
  assert.deepEqual(p.params, ["heart", VEC]);
});

test("filter concept that is not an active concept: empty without the pool query", async () => {
  resetSnomedAncestorsProbe();
  const db = fakeDb({ size: 0, ancestors: "filled" });
  assert.deepEqual(await rankSnomed("heart", VEC, 5, { hierarchy: "1" }, db.q), []);
  assert.equal(db.calls.some((c) => c.sql.includes("lex AS")), false);
});

test("small hierarchy: exact vector scan over the expanded descendants", async () => {
  resetSnomedAncestorsProbe();
  const db = fakeDb({ size: 928, ancestors: "filled" });
  await rankSnomed("heart", VEC, 5, { hierarchy: "80891009" }, db.q);
  const p = db.pool();
  assert.match(p.sql, /descendants AS \(/);
  assert.match(p.sql, /AND d\.concept_id IN \(SELECT concept_id FROM descendants\)/);
  // "+ 0" keeps the HNSW index out: exact nearest members.
  assert.match(p.sql, /ORDER BY \(e\.embedding <=> \$4::halfvec\) \+ 0 LIMIT 40/);
  assert.doesNotMatch(p.sql, /concept_ancestors/);
  assert.deepEqual(p.params, ["heart", "80891009", "116680003", VEC]);
  // The size probe is bounded.
  const probe = db.calls.find((c) => c.sql.includes("count(*)::int AS n"))!;
  assert.match(probe.sql, new RegExp(`LIMIT ${SNOMED_HIERARCHY_EXACT_MAX + 1}\\)`));
});

test("large hierarchy with the ancestor closure: per-candidate membership probe, no descendant expansion", async () => {
  resetSnomedAncestorsProbe();
  const db = fakeDb({ size: 42697, ancestors: "filled" });
  await rankSnomed("heart", VEC, 5, { hierarchy: "123037004" }, db.q);
  const p = db.pool();
  assert.doesNotMatch(p.sql, /descendants/);
  assert.match(p.sql, /SELECT a\.ancestor_ids FROM snomed\.concept_ancestors a WHERE a\.concept_id = m\.concept_id\) @> ARRAY\[\$2::bigint\]/);
  assert.match(p.sql, /WHERE \(e\.concept_id = \$2::bigint OR \(SELECT a\.ancestor_ids/);
  // Lexical half: sorted matches tested lazily (OFFSET 0 fences the test out of the subquery).
  assert.match(p.sql, /ORDER BY len, d\.concept_id OFFSET 0\) m/);
  // Vector half: the HNSW walk (no "+ 0").
  assert.match(p.sql, /ORDER BY \(e\.embedding <=> \$3::halfvec\) LIMIT 40/);
  assert.deepEqual(p.params, ["heart", "123037004", VEC]);
});

test("large hierarchy without the closure (not migrated / empty): hashed descendant set", async () => {
  for (const state of ["missing", "empty"] as const) {
    resetSnomedAncestorsProbe();
    const db = fakeDb({ size: 59616, ancestors: state });
    await rankSnomed("appendectomy", VEC, 5, { hierarchy: "71388002" }, db.q);
    const p = db.pool();
    assert.match(p.sql, /descendants AS MATERIALIZED \(/);
    assert.match(p.sql, /\(m\.concept_id IN \(SELECT concept_id FROM descendants\)\) IS TRUE/);
    assert.match(p.sql, /WHERE \(e\.concept_id IN \(SELECT concept_id FROM descendants\)\) IS TRUE ORDER BY \(e\.embedding <=> \$4::halfvec\) LIMIT 40/);
    assert.doesNotMatch(p.sql, /snomed\.concept_ancestors a/);
    assert.deepEqual(p.params, ["appendectomy", "71388002", "116680003", VEC]);
  }
});

test("keyword-only (no vector) large hierarchy: lexical half only", async () => {
  resetSnomedAncestorsProbe();
  const db = fakeDb({ size: 27725, ancestors: "filled" });
  await rankSnomed("aspirin", null, 5, { hierarchy: "105590001" }, db.q);
  const p = db.pool();
  assert.doesNotMatch(p.sql, /concept_embeddings/);
  assert.match(p.sql, /concept_ancestors/);
  assert.deepEqual(p.params, ["aspirin", "105590001"]);
});

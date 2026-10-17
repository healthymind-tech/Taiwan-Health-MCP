/**
 * Concurrent embed loop (`embedTable`) against a fake pool + fake embedder:
 * bounded in-flight requests, every row written exactly once, error / missing
 * vector handling, and pause → resume without skips or duplicates.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { embedTable, liveConcurrency, type BatchEmbedder } from "./embeddings.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** In-memory stand-in for one `*_embeddings` table, answering the loader's SQL. */
class FakePool {
  rows = new Map<string, { h: string; e: string }>();
  writes = new Map<string, number>();
  deletes = 0;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("ALTER TABLE") || s.startsWith("CREATE TABLE")) return { rows: [], rowCount: 0 };
    if (s.startsWith("SELECT code AS k, source_hash AS h")) {
      return { rows: [...this.rows].map(([k, v]) => ({ k, h: v.h })), rowCount: this.rows.size };
    }
    if (s.startsWith("INSERT INTO t.emb")) {
      assert.match(s, /unnest\(\$1::TEXT\[\], \$2::text\[\], \$3::text\[\]\)/);
      const [ks, es, hs] = params as [string[], string[], string[]];
      assert.equal(new Set(ks).size, ks.length, "one statement never touches a key twice");
      await sleep(1);
      ks.forEach((k, i) => {
        this.rows.set(String(k), { h: hs[i], e: es[i] });
        this.writes.set(String(k), (this.writes.get(String(k)) ?? 0) + 1);
      });
      return { rows: [], rowCount: ks.length };
    }
    if (s.startsWith("DELETE FROM t.emb")) {
      const keep = new Set((params[0] as string[]).map(String));
      let n = 0;
      for (const k of [...this.rows.keys()]) {
        if (!keep.has(k)) {
          this.rows.delete(k);
          n += 1;
        }
      }
      this.deletes += 1;
      return { rows: [], rowCount: n };
    }
    if (s.startsWith("SELECT COUNT(*)::int AS c FROM t.emb")) {
      return { rows: [{ c: this.rows.size }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${s}`);
  }

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

/** Fake embedding provider with an artificial latency that tracks in-flight peaks. */
class FakeEmbedder implements BatchEmbedder {
  inFlight = 0;
  maxInFlight = 0;
  calls = 0;
  constructor(
    private delayMs = 5,
    private behaviour: (call: number, texts: string[]) => "ok" | "null" | "throw" = () => "ok",
  ) {}

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    const call = this.calls++;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await sleep(this.delayMs);
      const mode = this.behaviour(call, texts);
      if (mode === "throw") throw new Error(`provider exploded on call ${call}`);
      if (mode === "null") return texts.map(() => null);
      return texts.map((t) => [t.length, 0.5, 1]);
    } finally {
      this.inFlight -= 1;
    }
  }
}

const SOURCE = Array.from({ length: 103 }, (_, i) => ({ code: `C${String(i).padStart(3, "0")}`, name: `name ${i}` }));

function args(rows = SOURCE, shouldStop?: () => boolean | Promise<boolean>) {
  return {
    table: "t.emb",
    keyCol: "code",
    keySqlType: "TEXT",
    rows,
    keyOf: (r: any) => r.code,
    textOf: (r: any) => `${r.code} ${r.name}`,
    desc: "Test",
    shouldStop,
  };
}

test("concurrency N keeps exactly N batches in flight and writes each row once", async () => {
  const pool = new FakePool();
  const emb = new FakeEmbedder(10);
  const s = await embedTable(pool.asPool(), emb, { batchSize: 5, concurrency: () => 4 }, args());
  assert.equal(emb.maxInFlight, 4);
  assert.equal(emb.calls, Math.ceil(103 / 5));
  assert.equal(s.stopped, false);
  assert.equal(s.changed, 103);
  assert.equal(s.embedded_total, 103);
  assert.ok([...pool.writes.values()].every((n) => n === 1));
  assert.equal(pool.writes.size, 103);

  // Re-run: content hashes match → no provider call at all.
  const emb2 = new FakeEmbedder(1);
  const s2 = await embedTable(pool.asPool(), emb2, { batchSize: 5, concurrency: () => 4 }, args());
  assert.equal(emb2.calls, 0);
  assert.equal(s2.changed, 0);
});

test("concurrency 1 stays strictly serial", async () => {
  const pool = new FakePool();
  const emb = new FakeEmbedder(2);
  await embedTable(pool.asPool(), emb, { batchSize: 10, concurrency: () => 1 }, args());
  assert.equal(emb.maxInFlight, 1);
  assert.equal(pool.rows.size, 103);
});

test("duplicate source keys are collapsed (last wins) instead of failing the upsert", async () => {
  const pool = new FakePool();
  const rows = [...SOURCE.slice(0, 10), { code: "C001", name: "renamed" }];
  const s = await embedTable(pool.asPool(), new FakeEmbedder(1), { batchSize: 32, concurrency: () => 2 }, args(rows));
  assert.equal(s.embedded_total, 10);
  assert.equal(pool.rows.get("C001")!.e, `[${"C001 renamed".length},0.5,1]`);
});

test("rows without a vector are skipped (not written) and picked up by the next run", async () => {
  const pool = new FakePool();
  // Batches 2 and 3 get no vector from any profile (all profiles failed → null).
  const emb = new FakeEmbedder(3, (call) => (call === 2 || call === 3 ? "null" : "ok"));
  const s = await embedTable(pool.asPool(), emb, { batchSize: 10, concurrency: () => 3 }, args());
  assert.equal(s.stopped, false);
  assert.equal(s.embedded_total, 103 - 20, "the incompleteness is visible to the job's completion check");

  const emb2 = new FakeEmbedder(1);
  const s2 = await embedTable(pool.asPool(), emb2, { batchSize: 10, concurrency: () => 3 }, args());
  assert.equal(s2.changed, 20);
  assert.equal(s2.embedded_total, 103);
  assert.ok([...pool.writes.values()].every((n) => n === 1), "retry run re-embedded only the gaps");
});

test("a provider error fails the run after draining; the rerun completes without duplicates", async () => {
  const pool = new FakePool();
  const emb = new FakeEmbedder(5, (call) => (call === 6 ? "throw" : "ok"));
  await assert.rejects(
    embedTable(pool.asPool(), emb, { batchSize: 5, concurrency: () => 4 }, args()),
    /provider exploded on call 6/,
  );
  assert.equal(emb.inFlight, 0, "no request left running after the rejection");
  assert.ok(emb.calls < Math.ceil(103 / 5), "dispatch stopped after the error");
  assert.equal(pool.deletes, 0, "orphan pruning never runs on a failed pass");
  const partial = pool.rows.size;
  assert.ok(partial > 0 && partial < 103);

  const s = await embedTable(pool.asPool(), new FakeEmbedder(1), { batchSize: 5, concurrency: () => 4 }, args());
  assert.equal(s.changed, 103 - partial);
  assert.equal(pool.rows.size, 103);
  assert.ok([...pool.writes.values()].every((n) => n === 1));
});

test("pause stops scheduling new batches, lands in-flight ones, and resume finishes the rest", async () => {
  const pool = new FakePool();
  const emb = new FakeEmbedder(10);
  let stop = false;
  const s = await embedTable(
    pool.asPool(),
    emb,
    { batchSize: 5, concurrency: () => 4 },
    args(SOURCE, () => {
      if (emb.calls >= 6) stop = true;
      return stop;
    }),
  );
  assert.equal(s.stopped, true);
  assert.equal(emb.inFlight, 0);
  assert.ok(emb.calls < Math.ceil(103 / 5), "stopped before the end");
  assert.equal(pool.rows.size, emb.calls * 5, "every dispatched batch was written, none half-way");
  assert.equal(pool.deletes, 0, "no orphan pruning against a half-embedded table");

  const emb2 = new FakeEmbedder(1);
  const s2 = await embedTable(pool.asPool(), emb2, { batchSize: 5, concurrency: () => 4 }, args());
  assert.equal(s2.stopped, false);
  assert.equal(s2.changed, 103 - emb.calls * 5, "resume embeds exactly the rows the paused run did not");
  assert.equal(pool.rows.size, 103);
  assert.ok([...pool.writes.values()].every((n) => n === 1), "resume neither skipped nor duplicated rows");
});

test("liveConcurrency refreshes in the background and keeps the value on read errors", async () => {
  let next: number | null = 8;
  let reads = 0;
  const get = liveConcurrency(2, async () => {
    reads += 1;
    if (next === null) throw new Error("db down");
    return next;
  }, 0);
  assert.equal(get(), 2, "first call returns the initial value synchronously");
  await sleep(5);
  assert.equal(get(), 8);
  next = null;
  await sleep(5);
  get();
  await sleep(5);
  assert.equal(get(), 8, "a failed refresh keeps the last known value");
  assert.ok(reads >= 2);
});

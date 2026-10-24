/**
 * Context store: memory implementation always; Redis implementation when a throwaway Redis is
 * reachable (AUTHORING_TEST_REDIS_URL, default redis://127.0.0.1:16379 — `docker run --rm -p
 * 16379:6379 redis:7`), under the key prefix `authoring:test:` which the test deletes afterwards.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, type RedisClientType } from "redis";
import {
  ContextExpiredError,
  FallbackContextStore,
  MemoryContextStore,
  RedisContextStore,
  deleteEntry,
  getEntry,
  isContextId,
  listEntries,
  putEntries,
  type ContextEntry,
  type ContextStore,
} from "./contextStore.js";

function entry(key: string, extra: Partial<ContextEntry> = {}): ContextEntry {
  return {
    key,
    input: { key, profile: "Patient", fields: { gender: "male" } },
    resource: { resourceType: "Patient", gender: "male" },
    status: "valid",
    provenance: { "Patient.gender": "model" },
    missing: [],
    refs: { resolved: [], pending: [] },
    issues: [],
    fieldMap: { "Patient.gender": "gender" },
    updated_at: "2026-10-24T00:00:00.000Z",
    ...extra,
  };
}

async function redisClient(): Promise<RedisClientType | null> {
  const url = process.env.AUTHORING_TEST_REDIS_URL || "redis://127.0.0.1:16379";
  const client: RedisClientType = createClient({ url, socket: { connectTimeout: 500, reconnectStrategy: () => new Error("no redis") } });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    return null;
  }
}

const TEST_PREFIX = "authoring:test:";

/** The contract every implementation must satisfy. */
function contractTests(label: string, make: () => Promise<{ store: ContextStore; close: () => Promise<void> }>): void {
  test(`${label}: create → get → put → list → delete; ids are 128-bit hex`, async () => {
    const { store, close } = await make();
    try {
      const id = await store.create();
      assert.ok(isContextId(id), id);
      const ctx = await store.get(id);
      assert.equal(ctx.id, id);
      assert.equal(ctx.version, 1);
      assert.deepEqual(ctx.entries, {});
      await putEntries(store, id, [entry("patient-1"), entry("cond-1", { status: "refs_pending", refs: { resolved: [], pending: ["enc-1"] } })]);
      const got = await getEntry(store, id, "cond-1");
      assert.equal(got?.status, "refs_pending");
      assert.deepEqual(
        (await listEntries(store, id)).map((e) => e.key),
        ["patient-1", "cond-1"],
      );
      assert.equal((await store.get(id)).version, 2);
      assert.equal(await deleteEntry(store, id, "patient-1"), true);
      assert.equal(await deleteEntry(store, id, "nobody"), false);
      assert.deepEqual(
        (await listEntries(store, id)).map((e) => e.key),
        ["cond-1"],
      );
      assert.equal(await store.delete(id), true);
      assert.equal(await store.delete(id), false);
      await assert.rejects(store.get(id), ContextExpiredError);
    } finally {
      await close();
    }
  });

  test(`${label}: contexts are isolated from each other`, async () => {
    const { store, close } = await make();
    try {
      const a = await store.create();
      const b = await store.create();
      await putEntries(store, a, [entry("patient-1")]);
      await putEntries(store, b, [entry("patient-1", { resource: { resourceType: "Patient", gender: "female" } })]);
      assert.equal((await getEntry(store, a, "patient-1"))?.resource.gender, "male");
      assert.equal((await getEntry(store, b, "patient-1"))?.resource.gender, "female");
      await store.delete(a);
      assert.equal((await getEntry(store, b, "patient-1"))?.resource.gender, "female");
      await store.delete(b);
    } finally {
      await close();
    }
  });

  test(`${label}: unknown id → ContextExpiredError with code CONTEXT_EXPIRED (never an empty context)`, async () => {
    const { store, close } = await make();
    try {
      const bogus = "0123456789abcdef0123456789abcdef";
      for (const op of [() => store.get(bogus), () => store.touch(bogus), () => store.update(bogus, () => undefined), () => putEntries(store, bogus, [entry("x")])]) {
        await assert.rejects(op, (e: unknown) => e instanceof ContextExpiredError && e.code === "CONTEXT_EXPIRED" && e.contextId === bogus);
      }
    } finally {
      await close();
    }
  });

  test(`${label}: 64 contexts updated in parallel, plus 32 concurrent updates of one context, lose nothing`, async () => {
    const { store, close } = await make();
    try {
      const ids = await Promise.all(Array.from({ length: 64 }, () => store.create()));
      assert.equal(new Set(ids).size, 64);
      await Promise.all(ids.map((id, i) => putEntries(store, id, [entry(`k-${i}`), entry("shared")])));
      const records = await Promise.all(ids.map((id) => store.get(id)));
      records.forEach((r, i) => assert.deepEqual(Object.keys(r.entries).sort(), [`k-${i}`, "shared"].sort()));
      // Same context, concurrent writers: every key survives (CAS retry on conflict).
      const one = ids[0];
      await Promise.all(Array.from({ length: 32 }, (_, i) => putEntries(store, one, [entry(`c-${i}`)])));
      const final = await store.get(one);
      assert.equal(Object.keys(final.entries).length, 2 + 32);
      await Promise.all(ids.map((id) => store.delete(id)));
    } finally {
      await close();
    }
  });
}

// ---- memory ---------------------------------------------------------------- //

contractTests("memory", async () => ({ store: new MemoryContextStore(), close: async () => undefined }));

test("memory: idle TTL — expires after 60 min without access, every access refreshes it", async () => {
  let t = 1_000_000;
  const store = new MemoryContextStore({ now: () => t });
  const id = await store.create();
  t += 59 * 60 * 1000;
  await store.touch(id); // refresh at 59 min
  t += 59 * 60 * 1000;
  await putEntries(store, id, [entry("a")]); // still alive (58 min since touch)
  t += 61 * 60 * 1000;
  await assert.rejects(store.get(id), ContextExpiredError);
  assert.equal(store.size, 0);
});

test("memory: update mutates a copy and bumps the version; callers never share state with the store", async () => {
  const store = new MemoryContextStore();
  const id = await store.create();
  const e = entry("a");
  await putEntries(store, id, [e]);
  e.resource.gender = "mutated-after-put";
  const got = await store.get(id);
  assert.equal(got.entries.a.resource.gender, "male");
  got.entries.a.resource.gender = "mutated-after-get";
  assert.equal((await store.get(id)).entries.a.resource.gender, "male");
  assert.equal((await store.get(id)).version, 2);
});

test("fallback store reports memory and keeps working when Redis is not ready", async () => {
  const store = new FallbackContextStore(null, () => false);
  assert.equal(store.kind, "memory");
  const id = await store.create();
  await putEntries(store, id, [entry("a")]);
  assert.equal((await listEntries(store, id)).length, 1);
});

// ---- redis (optional) ------------------------------------------------------ //

const redisAvailable = await redisClient();
if (redisAvailable) {
  await redisAvailable.quit();
  contractTests("redis", async () => {
    const client = (await redisClient())!;
    const store = new RedisContextStore(client, { prefix: TEST_PREFIX });
    return {
      store,
      close: async () => {
        const keys = await client.keys(`${TEST_PREFIX}*`);
        if (keys.length) await client.del(keys);
        await client.quit();
      },
    };
  });

  test("redis: hash layout (version + data), TTL set on create and refreshed on access, expiry → CONTEXT_EXPIRED", async () => {
    const client = (await redisClient())!;
    try {
      const store = new RedisContextStore(client, { prefix: TEST_PREFIX });
      const id = await store.create();
      const key = `${TEST_PREFIX}${id}`;
      assert.deepEqual(Object.keys(await client.hGetAll(key)).sort(), ["data", "version"]);
      const ttl = await client.ttl(key);
      assert.ok(ttl > 3500 && ttl <= 3600, `ttl ${ttl}`);
      await client.expire(key, 100);
      await store.get(id);
      assert.ok((await client.ttl(key)) > 3500, "get refreshes the TTL");
      await client.expire(key, 100);
      await putEntries(store, id, [entry("a")]);
      assert.ok((await client.ttl(key)) > 3500, "update refreshes the TTL");
      assert.equal(await client.hGet(key, "version"), "2");
      await store.delete(id);

      const short = new RedisContextStore(client, { prefix: TEST_PREFIX, ttlSeconds: 1 });
      const id2 = await short.create();
      await new Promise((r) => setTimeout(r, 1300));
      await assert.rejects(short.get(id2), ContextExpiredError);
      await assert.rejects(putEntries(short, id2, [entry("a")]), ContextExpiredError);
    } finally {
      const keys = await client.keys(`${TEST_PREFIX}*`);
      if (keys.length) await client.del(keys);
      await client.quit();
    }
  });

  test("redis: a stale writer loses the CAS and re-applies on the fresh record", async () => {
    const client = (await redisClient())!;
    try {
      const plain = new RedisContextStore(client, { prefix: TEST_PREFIX });
      const id = await plain.create();
      const key = `${TEST_PREFIX}${id}`;
      // A client whose first CAS write is preceded by another writer's commit (version 1 → 2, entry "fast").
      let injected = false;
      const racing = new Proxy(client, {
        get(target, prop, receiver) {
          if (prop !== "eval") return Reflect.get(target, prop, receiver);
          return async (script: string, o: unknown) => {
            if (!injected && script.includes("HSET")) {
              injected = true;
              const current = JSON.parse((await target.hGet(key, "data")) as string);
              await target.hSet(key, { version: "2", data: JSON.stringify({ ...current, version: 2, entries: { fast: entry("fast") } }) });
            }
            return target.eval(script, o as never);
          };
        },
      }) as RedisClientType;
      let calls = 0;
      const final = await new RedisContextStore(racing, { prefix: TEST_PREFIX }).update(id, (ctx) => {
        calls++;
        ctx.entries.slow = entry("slow");
      });
      assert.equal(calls, 2, "mutation re-applied after the lost CAS");
      assert.deepEqual(Object.keys(final.entries).sort(), ["fast", "slow"]);
      assert.equal(final.version, 3);
      assert.deepEqual(Object.keys((await plain.get(id)).entries).sort(), ["fast", "slow"]);
      await plain.delete(id);
    } finally {
      const keys = await client.keys(`${TEST_PREFIX}*`);
      if (keys.length) await client.del(keys);
      await client.quit();
    }
  });
} else {
  test("redis store tests skipped (no throwaway Redis at AUTHORING_TEST_REDIS_URL / 127.0.0.1:16379)", { skip: true }, () => undefined);
}

test("memory: records are cloned losslessly — RawNumber spellings survive put/get, version stays a number", async () => {
  const { RawNumber, stringifyLossless } = await import("../losslessJson.js");
  const store = new MemoryContextStore();
  const id = await store.create();
  await store.update(id, (ctx) => {
    ctx.entries.k = { ...entry("k"), resource: { resourceType: "Observation", valueQuantity: { value: new RawNumber("1e2") } } };
  });
  const got = await store.get(id);
  assert.equal(typeof got.version, "number");
  assert.equal(got.version, 2);
  assert.ok(stringifyLossless(got.entries.k.resource).includes('"value":1e2'));
  assert.equal(JSON.parse(JSON.stringify(got.entries.k.resource)).valueQuantity.value, 100);
});

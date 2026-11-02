/**
 * parity v3, large-Bundle non-determinism: request-scoped pin, eviction with tiny quotas, transient failures, limits, per-run
 * isolation of a shared engine, and the indexed Bundle reachability. No live services (fake resolvers).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceValidator, backwardScan, completenessOf, forwardClosure, hasNoVerdict, isValid, type CodeCheck, type Issue, type ValidatorResolver } from "./fhirValidator.js";
import { TransientLookupError, currentSnapshot, setCacheLimits, withValidationSnapshot } from "./fhirValidationSnapshot.js";
import { DbValidatorResolver } from "./fhirValidationResolver.js";
import type { PackageRow } from "./fhirIg.js";
import { TtlCache } from "./fhirTerminology.js";
import { TtlMemo } from "./ttlMemo.js";

const CORE = "http://hl7.org/fhir/StructureDefinition/";

/** The smallest resource definition the engine walks: Basic with an id, a code and a subject. */
function basicSd(url = `${CORE}Basic`): Record<string, any> {
  const el = (path: string, code: string, min = 0, max = "1", extra: Record<string, any> = {}): Record<string, any> => ({ id: path, path, min, max, base: { path, min, max }, type: [{ code }], ...extra });
  return {
    resourceType: "StructureDefinition",
    url,
    name: "Basic",
    type: "Basic",
    kind: "resource",
    derivation: "specialization",
    snapshot: {
      element: [
        { id: "Basic", path: "Basic", min: 0, max: "*", base: { path: "Basic", min: 0, max: "*" } },
        el("Basic.id", "http://hl7.org/fhirpath/System.String"),
        el("Basic.code", "code", 1, "1", { binding: { strength: "required", valueSet: "http://example.org/ValueSet/vs" } }),
      ],
    },
  };
}

interface Fake extends ValidatorResolver {
  calls: Record<string, number>;
}

function fakeResolver(over: Partial<ValidatorResolver> = {}): Fake {
  const calls: Record<string, number> = {};
  const count = (k: string): void => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  return {
    calls,
    fetchStructureDefinition: async (url) => {
      count("sd");
      return url === `${CORE}Basic` ? basicSd() : null;
    },
    fetchValueSet: async (url) => {
      count("vs");
      return { url, compose: {} };
    },
    valueSetContains: async () => {
      count("member");
      return true;
    },
    checkCode: async (): Promise<CodeCheck> => {
      count("code");
      return { status: "ok" };
    },
    ...over,
  };
}

const basic = (code = "a"): Record<string, any> => ({ resourceType: "Basic", id: "x", code });

// --------------------------------------------------------------------------- //
// Pin
// --------------------------------------------------------------------------- //

test("pin: a lookup is answered once per run, the first answer stands; the next run sees the new answer", async () => {
  let answer: boolean | undefined = true;
  let asked = 0;
  const resolver = fakeResolver({
    valueSetContains: async () => {
      asked++;
      const a = answer;
      answer = false; // the data changes while the run is in progress
      return a;
    },
  });
  const engine = new InstanceValidator(resolver);
  const first = await engine.validate({ resourceType: "Basic", id: "x", code: "a" });
  assert.equal(asked, 1);
  assert.equal(isValid(first), true);
  const second = await engine.validate({ resourceType: "Basic", id: "x", code: "a" });
  assert.equal(asked, 2, "expiry only affects the next request: a new run asks again");
  assert.equal(isValid(second), false);
});

test("TtlCache: inside a snapshot an evicted / expired / too heavy value keeps its first value", async () => {
  const c = new TtlCache<string>(10);
  await withValidationSnapshot(async () => {
    c.set("a", "A", 5);
    c.set("b", "B", 8); // evicts a
    c.set("huge", "H", 100); // never held
    assert.equal(c.size, 1);
    assert.equal(c.get("a"), "A");
    assert.equal(c.get("huge"), "H");
    setCacheLimits({ ttlMs: -1 });
    try {
      assert.equal(c.get("b"), "B", "expired for the process, pinned for the request");
    } finally {
      setCacheLimits({});
    }
    c.set("a", "A2", 1); // a concurrent refill must not change what this request saw
    assert.equal(c.get("a"), "A");
  });
  assert.equal(c.get("a"), "A2", "the next request sees the new value");
  assert.equal(c.get("huge"), undefined);
});

test("TtlCache / TtlMemo: a tiny quota evicts everything, the pin still answers; concurrent snapshots do not share pins", async () => {
  setCacheLimits({ maxEntries: 1, maxWeight: 1 });
  try {
    const memo = new TtlMemo<number>(60_000, 100);
    const cache = new TtlCache<number>();
    let computed = 0;
    const load = (k: string): Promise<number> =>
      memo.get(k, async () => {
        computed++;
        return computed;
      });
    const run = async (): Promise<number[]> =>
      withValidationSnapshot(async () => {
        const a = await load("a");
        await load("b"); // evicts a from the shared memo
        const again = await load("a");
        await new Promise((r) => setImmediate(r));
        cache.set("k", a, 1);
        cache.set("other", 0, 1); // evicts k
        return [a, again, cache.get("k")!];
      });
    const [x, y] = await Promise.all([run(), run()]);
    assert.equal(x[0], x[1]);
    assert.equal(x[0], x[2]);
    assert.equal(y[0], y[1]);
    assert.equal(y[0], y[2]);
  } finally {
    setCacheLimits({});
  }
});

test("TtlMemo: a rejected lookup is not pinned nor memoised", async () => {
  const memo = new TtlMemo<string>(60_000, 10);
  let n = 0;
  const load = (): Promise<string> =>
    memo.get("k", async () => {
      if (++n === 1) throw new Error("connection refused");
      return "ok";
    });
  await withValidationSnapshot(async () => {
    await assert.rejects(load());
    assert.equal(await load(), "ok");
  });
  assert.equal(n, 2);
});

test("withValidationSnapshot: nested calls join the request's snapshot; none outside", async () => {
  assert.equal(currentSnapshot(), undefined);
  await withValidationSnapshot(async () => {
    const outer = currentSnapshot();
    await withValidationSnapshot(async () => assert.equal(currentSnapshot(), outer));
  });
});

// --------------------------------------------------------------------------- //
// Concurrent validations on one engine
// --------------------------------------------------------------------------- //

test("a shared engine: concurrent validate() calls with different options do not leak into each other", async () => {
  const sd = basicSd();
  sd.snapshot.element[2] = { id: "Basic.code", path: "Basic.code", min: 1, max: "1", base: { path: "Basic.code", min: 1, max: "1" }, type: [{ code: "Coding" }] };
  const seen: Array<[string, string | undefined]> = [];
  const resolver = fakeResolver({
    fetchStructureDefinition: async (url) => (url === `${CORE}Basic` ? sd : null),
    checkCode: async (_s, code, _d, _v, langs) => {
      seen.push([code, langs?.[0]]);
      await new Promise((r) => setImmediate(r));
      return { status: "ok" };
    },
  });
  const engine = new InstanceValidator(resolver);
  const run = (lang: string): Promise<Issue[]> => engine.validate({ resourceType: "Basic", id: "x", code: { system: "http://example.org/cs", code: lang } }, { languages: [lang] });
  await Promise.all(["de", "fr", "ja", "ko", "nl", "pt"].map(run));
  assert.equal(seen.length, 6);
  for (const [code, lang] of seen) assert.equal(lang, code, "each run uses its own options");
});

test("a shared engine: the same resource object validated concurrently gives the same result each time", async () => {
  const engine = new InstanceValidator(fakeResolver());
  const r = basic();
  const texts = await Promise.all(Array.from({ length: 8 }, () => engine.validate(r).then((x) => JSON.stringify(x))));
  assert.equal(new Set(texts).size, 1);
});

// --------------------------------------------------------------------------- //
// Transient failures
// --------------------------------------------------------------------------- //

test("transient: a membership lookup that fails once is unverified, not an error, and is asked again by the next run", async () => {
  let n = 0;
  const resolver = fakeResolver({
    valueSetContains: async () => {
      if (++n === 1) throw new Error("connection terminated");
      return false; // the real answer: not a member
    },
  });
  const engine = new InstanceValidator(resolver);
  const first = await engine.validate(basic());
  assert.equal(first.some((i) => i.severity === "error" || i.severity === "fatal"), false, JSON.stringify(first));
  const c = completenessOf(first);
  assert.equal(c.checked_fully, false);
  assert.equal(c.lookups_failed, 1);
  assert.equal(isValid(first), true);
  assert.equal(hasNoVerdict(first), false);
  const second = await engine.validate(basic());
  assert.equal(isValid(second), false, "the failure was not remembered");
  assert.equal(completenessOf(second).checked_fully, true);
});

test("transient: a code check that fails is unverified, never Unknown code", async () => {
  const sd = basicSd();
  sd.snapshot.element[2] = { id: "Basic.code", path: "Basic.code", min: 1, max: "1", base: { path: "Basic.code", min: 1, max: "1" }, type: [{ code: "Coding" }] };
  let n = 0;
  const resolver = fakeResolver({
    fetchStructureDefinition: async (url) => (url === `${CORE}Basic` ? sd : null),
    checkCode: async (): Promise<CodeCheck> => {
      if (++n === 1) throw new Error("timeout");
      return { status: "invalid-code", severity: "error", message: "Unknown code" };
    },
  });
  const res = { resourceType: "Basic", id: "x", code: { system: "http://example.org/cs", code: "c" } };
  const engine = new InstanceValidator(resolver);
  const first = await engine.validate(res);
  assert.equal(isValid(first), true, JSON.stringify(first));
  assert.equal(completenessOf(first).checked_fully, false);
  const second = await engine.validate(res);
  assert.equal(isValid(second), false);
  assert.ok(second.some((i) => i.message === "Unknown code"));
});

test("transient: a definition that cannot be loaded gives no verdict and no invented finding; the next run judges", async () => {
  let n = 0;
  const resolver = fakeResolver({
    fetchStructureDefinition: async (url) => {
      if (++n === 1) throw new Error("connection refused");
      return url === `${CORE}Basic` ? basicSd() : null;
    },
  });
  const engine = new InstanceValidator(resolver);
  const first = await engine.validate(basic());
  assert.equal(first.length, 1, JSON.stringify(first));
  assert.equal(first[0].severity, "warning");
  assert.equal(first[0].code, "exception");
  assert.equal(hasNoVerdict(first), true);
  assert.equal(completenessOf(first).checked_fully, false);
  const second = await engine.validate(basic());
  assert.equal(hasNoVerdict(second), false);
  assert.equal(completenessOf(second).checked_fully, true);
});

test("DbValidatorResolver: a database failure is a rejection inside a snapshot, the graceful answer outside; never a finding", async () => {
  // no pool in unit tests: every query fails
  const pkg = { package_id: "x.y", version: "1.0.0" } as unknown as PackageRow;
  const db = new DbValidatorResolver(pkg);
  assert.equal(await db.definitionExists("http://example.org/x"), true);
  await withValidationSnapshot(async () => {
    await assert.rejects(db.checkCode("http://snomed.info/sct", "38341003", null));
    await assert.rejects(db.definitionExists("http://example.org/x"), TransientLookupError);
  });
  const issues = await new InstanceValidator(db).validate({ resourceType: "Patient", id: "p" });
  assert.equal(issues.length, 1);
  assert.equal(hasNoVerdict(issues), true);
  assert.equal(isValid(issues), true);
  assert.equal(completenessOf(issues).checked_fully, false);
});

test("a real not found stays a result: no failure counted", async () => {
  const resolver = fakeResolver({ valueSetContains: async () => undefined, fetchValueSet: async () => null });
  const out = await new InstanceValidator(resolver).validate(basic());
  assert.equal(completenessOf(out).lookups_failed, undefined);
});

// --------------------------------------------------------------------------- //
// Limits
// --------------------------------------------------------------------------- //

test("completeness: a limit or an unevaluated invariant makes checked_fully false and is named", () => {
  const limit: Issue = { severity: "warning", path: "x", code: "too-deep", message: "m", unchecked: { kind: "limit", canonical: "element-depth" } };
  const inv: Issue = { severity: "information", path: "x", code: "invariant-unevaluated", message: "m", unchecked: { kind: "invariant", canonical: "p#k" } };
  assert.deepEqual(completenessOf([limit]), { checked_fully: false, profiles_unchecked: [], valuesets_unchecked: [], limits_exceeded: ["element-depth"] });
  assert.deepEqual(completenessOf([inv]), { checked_fully: false, profiles_unchecked: [], valuesets_unchecked: [], invariants_unchecked: ["p#k"] });
});

// --------------------------------------------------------------------------- //
// Reachability
// --------------------------------------------------------------------------- //

/** The repeated scan of BundleValidator.checkAllInterlinked, as written in Java. */
function naiveScan(edges: number[][], visited: Set<number>): number[] {
  const out: number[] = [];
  let found: boolean;
  do {
    found = false;
    for (let e = 0; e < edges.length; e++) {
      if (visited.has(e) || !edges[e].some((t) => visited.has(t))) continue;
      out.push(e);
      found = true;
      forwardClosure([e], edges, visited);
    }
  } while (found);
  return out;
}

test("backwardScan reports in the order of the repeated scan (random graphs)", () => {
  let x = 123456789;
  const rnd = (n: number): number => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x % n;
  };
  for (let round = 0; round < 3000; round++) {
    const n = 1 + rnd(25);
    const edges: number[][] = Array.from({ length: n }, () => Array.from({ length: rnd(4) }, () => rnd(n)));
    const seedA = new Set<number>();
    forwardClosure([0], edges, seedA);
    const seedB = new Set(seedA);
    assert.deepEqual(backwardScan(edges, seedB), naiveScan(edges, seedA), JSON.stringify(edges));
    assert.deepEqual([...seedB].sort((a, b) => a - b), [...seedA].sort((a, b) => a - b));
  }
});

test("reachability is near-linear on a chain listed backwards (one scan per report before)", () => {
  const n = 200_000;
  const edges: number[][] = Array.from({ length: n }, (_, i) => (i === n - 1 ? [] : [i + 1]));
  edges[n - 1] = [0];
  const visited = new Set<number>([0]);
  const t = performance.now();
  const out = backwardScan(edges, visited);
  assert.equal(out.length, n - 1);
  assert.equal(out[0], n - 1);
  assert.ok(performance.now() - t < 5000);
});

test("depth limit: the structural pass reports what it does not walk (too-deep, limits_exceeded), never returns silently", async () => {
  const engine = new InstanceValidator(fakeResolver()) as any;
  const issues: Issue[] = [];
  await engine.structuralPass(basic(), "Basic", issues, 61);
  await engine.structObject(null, {}, {}, "Basic.deep", issues, 61, false);
  assert.deepEqual(issues.map((i) => i.path), ["Basic", "Basic.deep"]);
  assert.ok(issues.every((i) => i.severity === "warning" && i.code === "too-deep"));
  const c = completenessOf(issues);
  assert.equal(c.checked_fully, false);
  assert.deepEqual(c.limits_exceeded, ["element-depth"]);
});

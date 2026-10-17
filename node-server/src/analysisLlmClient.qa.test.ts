/**
 * QA: runtime behaviour of the Analysis LM client — failover across leaves,
 * circuit breaker interaction, budget escalation per model family, rate limits
 * and transport retries. Pure unit tests: globalThis.fetch is stubbed, stats
 * recording is switched off, nothing touches Postgres.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AnalysisLlmRateLimited, AnalysisLlmUnavailable, callAnalysisLlm, type LlmCallAttempt } from "./analysisLlmClient.js";
import { setProfileStatsEnabled } from "./admin/llmProfileStats.js";
import { coolingDown, isCoolingDown, reportFailure, reportSuccess, resetBreakers, type LlmProfile } from "./admin/llmProfiles.js";
import { getStats, resetAll } from "./rateLimiter.js";

setProfileStatsEnabled(false);

const realFetch = globalThis.fetch;

function leaf(id: number, model = "qwen3-32b", params: Record<string, unknown> = {}): LlmProfile {
  return {
    id,
    kind: "analysis",
    name: `leaf${id}`,
    provider: "openai_compatible",
    base_url: `http://leaf${id}.test/v1`,
    api_key: "",
    model,
    enabled: true,
    priority: id,
    weight: 1,
    params,
  };
}

const okBody = (content = '{"ok":true}', usage = { prompt_tokens: 10, completion_tokens: 5 }) =>
  JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage });

interface Hit {
  host: string;
  body: Record<string, unknown>;
}

/** Route fake replies by host; record every request. */
function stubFetch(byHost: Record<string, (body: Record<string, unknown>, n: number) => Response | Promise<Response>>): Hit[] {
  const hits: Hit[] = [];
  const counts = new Map<string, number>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    hits.push({ host: url.host, body });
    const n = (counts.get(url.host) ?? 0) + 1;
    counts.set(url.host, n);
    const h = byHost[url.host];
    if (!h) throw new Error(`unexpected host ${url.host}`);
    return h(body, n);
  }) as typeof fetch;
  return hits;
}

const msgs = [{ role: "user", content: "extract JSON" }];

beforeEach(() => {
  resetBreakers();
  resetAll();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── 1. failover ──────────────────────────────────────────────────────────────

test("failover: HTTP 500 on first leaf → second leaf answers; failure fed to breaker once", async () => {
  const hits = stubFetch({
    "leaf1.test": () => new Response("upstream boom", { status: 500 }),
    "leaf2.test": () => new Response(okBody(), { status: 200 }),
  });
  const attempts: LlmCallAttempt[] = [];
  const r = await callAnalysisLlm([leaf(1), leaf(2)], msgs, (a) => void attempts.push(a));
  assert.equal(r.profileUsed.id, 2);
  assert.equal(r.content, '{"ok":true}');
  assert.deepEqual(hits.map((h) => h.host), ["leaf1.test", "leaf2.test"], "5xx is not transport-retried");
  assert.deepEqual(attempts.map((a) => a.status), ["failed", "ok"]);
  assert.equal(isCoolingDown(1), false, "one failure does not trip");
});

test("failover: HTTP 429 → next leaf (no in-place retry, no param dropping)", async () => {
  const hits = stubFetch({
    "leaf1.test": () => new Response(JSON.stringify({ error: { message: "rate limited temperature" } }), { status: 429 }),
    "leaf2.test": () => new Response(okBody(), { status: 200 }),
  });
  const r = await callAnalysisLlm([leaf(1, "m", { temperature: 0 }), leaf(2)], msgs);
  assert.equal(r.profileUsed.id, 2);
  assert.equal(hits.filter((h) => h.host === "leaf1.test").length, 1);
});

test("failover: 200 with an HTML proxy page (non-JSON) is an endpoint failure → next leaf", async () => {
  stubFetch({
    "leaf1.test": () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 200 }),
    "leaf2.test": () => new Response(okBody(), { status: 200 }),
  });
  const attempts: LlmCallAttempt[] = [];
  const r = await callAnalysisLlm([leaf(1), leaf(2)], msgs, (a) => void attempts.push(a));
  assert.equal(r.profileUsed.id, 2);
  assert.match(attempts[0].error, /non-JSON reply/);
});

test("failover: 200 with an OpenRouter-style {error} body → ProviderReplyError → next leaf", async () => {
  stubFetch({
    "leaf1.test": () => new Response(JSON.stringify({ error: { message: "upstream provider down", code: 502 } }), { status: 200 }),
    "leaf2.test": () => new Response(okBody(), { status: 200 }),
  });
  const attempts: LlmCallAttempt[] = [];
  const r = await callAnalysisLlm([leaf(1), leaf(2)], msgs, (a) => void attempts.push(a));
  assert.equal(r.profileUsed.id, 2);
  assert.equal(attempts[0].status, "failed");
  assert.match(attempts[0].error, /upstream provider down/);
});

test("invalid JSON *content* is returned as-is from the first leaf (validation is the caller's job, no failover)", async () => {
  const hits = stubFetch({
    "leaf1.test": () => new Response(okBody("this is not json"), { status: 200 }),
    "leaf2.test": () => new Response(okBody(), { status: 200 }),
  });
  const r = await callAnalysisLlm([leaf(1), leaf(2)], msgs);
  assert.equal(r.profileUsed.id, 1);
  assert.equal(r.content, "this is not json");
  assert.equal(hits.length, 1);
});

test("truncated output (finish_reason=length) on leaf1 → escalates, then leaf2; leaf1 NOT fed to the breaker", async () => {
  const lengths: number[] = [];
  stubFetch({
    "leaf1.test": (b) => {
      lengths.push(Number(b.max_tokens));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"a":' }, finish_reason: "length" }] }), { status: 200 });
    },
    "leaf2.test": () => new Response(okBody(), { status: 200 }),
  });
  for (let i = 0; i < 4; i += 1) {
    const r = await callAnalysisLlm([leaf(1), leaf(2)], msgs);
    assert.equal(r.profileUsed.id, 2);
  }
  assert.equal(isCoolingDown(1), false, "TokenBudgetExceeded must not trip the breaker");
  assert.deepEqual(lengths.slice(0, 2), [16384, 32768], "non-reasoning: 16k → 32k then give up");
});

test("only budget failures → plain Error, NOT AnalysisLlmUnavailable", async () => {
  stubFetch({
    "leaf1.test": () => new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }), { status: 200 }),
  });
  await assert.rejects(callAnalysisLlm([leaf(1)], msgs), (err: Error) => {
    assert.ok(!(err instanceof AnalysisLlmUnavailable));
    assert.match(err.message, /Every Analysis LM profile failed/);
    return true;
  });
});

test("every leaf fails at the endpoint → AnalysisLlmUnavailable naming each leaf", async () => {
  stubFetch({
    "leaf1.test": () => new Response("x", { status: 500 }),
    "leaf2.test": () => new Response("y", { status: 503 }),
  });
  await assert.rejects(callAnalysisLlm([leaf(1), leaf(2)], msgs), (err: Error) => {
    assert.ok(err instanceof AnalysisLlmUnavailable);
    assert.match(err.message, /leaf1: HTTP 500/);
    assert.match(err.message, /leaf2: HTTP 503/);
    return true;
  });
});

test("no leaves configured → AnalysisLlmUnavailable", async () => {
  await assert.rejects(callAnalysisLlm([], msgs), AnalysisLlmUnavailable);
});

// ── breaker ──────────────────────────────────────────────────────────────────

test("breaker: trips on the 3rd consecutive failure, reportSuccess resets it", () => {
  reportFailure(77, "a");
  reportFailure(77, "b");
  assert.equal(isCoolingDown(77), false);
  reportFailure(77, "c");
  assert.equal(isCoolingDown(77), true);
  const left = coolingDown()[77];
  assert.ok(left > 59_000 && left <= 60_000, `cooldown ~60s, got ${left}`);
  reportSuccess(77);
  assert.equal(isCoolingDown(77), false);
  reportFailure(77, "d");
  assert.equal(isCoolingDown(77), false, "counter restarted after success");
});

test("breaker: failures are cumulative, not consecutive-within-window (no decay) — 3 failures hours apart still trip", () => {
  // Documented characteristic: `failures` never decays, only reportSuccess clears it.
  const realNow = Date.now;
  try {
    let t = realNow();
    Date.now = () => t;
    reportFailure(88, "a");
    t += 3 * 3_600_000;
    reportFailure(88, "b");
    t += 3 * 3_600_000;
    reportFailure(88, "c");
    assert.equal(isCoolingDown(88), true);
  } finally {
    Date.now = realNow;
  }
});

test("breaker: callAnalysisLlm does not skip or reorder a cooled leaf itself (ordering is frozen in the list it is given)", async () => {
  for (let i = 0; i < 3; i += 1) reportFailure(1, "dead");
  assert.equal(isCoolingDown(1), true);
  const hits = stubFetch({
    "leaf1.test": () => new Response("dead", { status: 500 }),
    "leaf2.test": () => new Response(okBody(), { status: 200 }),
  });
  await callAnalysisLlm([leaf(1), leaf(2)], msgs);
  assert.equal(hits[0].host, "leaf1.test", "cooled leaf is still tried first when the caller's list is stale");
});

// ── 2. budget escalation ─────────────────────────────────────────────────────

async function budgetsFor(model: string, params: Record<string, unknown> = {}): Promise<number[]> {
  const seen: number[] = [];
  stubFetch({
    "leaf1.test": (b) => {
      seen.push(Number(b.max_tokens ?? b.max_completion_tokens));
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }), { status: 200 });
    },
  });
  await callAnalysisLlm([leaf(1, model, params)], msgs).catch(() => undefined);
  return seen;
}

test("budget: reasoning family (gpt-5/o3/…) doubles to 65536", async () => {
  assert.deepEqual(await budgetsFor("gpt-5-mini"), [16384, 32768, 65536]);
  assert.deepEqual(await budgetsFor("O3-mini"), [16384, 32768, 65536], "case-insensitive");
});

test("budget: non-reasoning family capped at 32768", async () => {
  assert.deepEqual(await budgetsFor("deepseek-r1"), [16384, 32768]);
});

test("budget: max_token_budget override raises / lowers the ceiling", async () => {
  assert.deepEqual(await budgetsFor("qwen", { max_token_budget: 100000 }), [16384, 32768, 65536, 100000]);
  assert.deepEqual(await budgetsFor("o3", { max_token_budget: 20000 }), [16384, 20000]);
});

test("budget: configured max_tokens above the ceiling is used as-is, never escalated", async () => {
  assert.deepEqual(await budgetsFor("qwen", { max_tokens: 50000 }), [50000]);
  assert.deepEqual(await budgetsFor("qwen", { max_tokens: "junk" }), [16384, 32768]);
});

test("budget: a 200 with empty content and finish_reason=stop is an endpoint failure, not escalated", async () => {
  const seen: number[] = [];
  stubFetch({
    "leaf1.test": (b) => {
      seen.push(Number(b.max_tokens));
      return new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), { status: 200 });
    },
  });
  await assert.rejects(callAnalysisLlm([leaf(1)], msgs), AnalysisLlmUnavailable);
  assert.deepEqual(seen, [16384]);
});

test("budget: empty content next to reasoning (thinking ate the budget) is still escalated", async () => {
  const seen: number[] = [];
  stubFetch({
    "leaf1.test": (b) => {
      seen.push(Number(b.max_tokens));
      return new Response(JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "let me think…" }, finish_reason: "stop" }] }), { status: 200 });
    },
  });
  await callAnalysisLlm([leaf(1)], msgs).catch(() => undefined);
  assert.deepEqual(seen, [16384, 32768]);
});

test(
  "a 200 `{}` reply (proxy/misconfigured endpoint, no choices, no error) should count as an endpoint failure, not a budget failure",
  async () => {
    let calls = 0;
    stubFetch({
      "leaf1.test": () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    });
    await assert.rejects(callAnalysisLlm([leaf(1, "gpt-5")], msgs), AnalysisLlmUnavailable);
    assert.equal(calls, 1, "a broken endpoint should not be re-asked with a bigger budget");
  },
);

test(
  "tokens consumed by truncated (budget) attempts are recorded in the TPM limiter",
  async () => {
    stubFetch({
      "leaf1.test": () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "length" }], usage: { prompt_tokens: 1000, completion_tokens: 16384 } }),
          { status: 200 },
        ),
    });
    await callAnalysisLlm([leaf(1, "qwen", { tpm: 1_000_000 })], msgs).catch(() => undefined);
    assert.ok(getStats(1).tokens > 0, `TPM saw ${getStats(1).tokens} tokens`);
  },
);

// ── rate limits ──────────────────────────────────────────────────────────────

test("rate limit: RPM reached on leaf1 → leaf2 used", async () => {
  const hits = stubFetch({
    "leaf1.test": () => new Response(okBody(), { status: 200 }),
    "leaf2.test": () => new Response(okBody(), { status: 200 }),
  });
  const a = await callAnalysisLlm([leaf(1, "m", { rpm: 1 }), leaf(2)], msgs);
  const b = await callAnalysisLlm([leaf(1, "m", { rpm: 1 }), leaf(2)], msgs);
  assert.equal(a.profileUsed.id, 1);
  assert.equal(b.profileUsed.id, 2);
  assert.equal(hits.length, 2, "the limited leaf was not called");
});

test(
  "a self-imposed RPM limit must not feed the circuit breaker (endpoint is healthy)",
  async () => {
    stubFetch({
      "leaf1.test": () => new Response(okBody(), { status: 200 }),
      "leaf2.test": () => new Response(okBody(), { status: 200 }),
    });
    await callAnalysisLlm([leaf(1, "m", { rpm: 1 }), leaf(2)], msgs);
    for (let i = 0; i < 3; i += 1) await callAnalysisLlm([leaf(1, "m", { rpm: 1 }), leaf(2)], msgs);
    assert.equal(isCoolingDown(1), false, "leaf1 was cooled down for our own local rate limit");
  },
);

test(
  "when the only leaf is merely rate-limited the call should wait (or signal 'retry later'), not report the fleet as down",
  async () => {
    stubFetch({ "leaf1.test": () => new Response(okBody(), { status: 200 }) });
    await callAnalysisLlm([leaf(1, "m", { rpm: 1 })], msgs);
    await assert.rejects(callAnalysisLlm([leaf(1, "m", { rpm: 1 })], msgs), (err: Error) => {
      assert.ok(!(err instanceof AnalysisLlmUnavailable));
      assert.ok(err instanceof AnalysisLlmRateLimited);
      assert.ok(err.retryAfterMs > 0 && err.retryAfterMs <= 60_000);
      return true;
    });
    assert.equal(isCoolingDown(1), false);
  },
);

test("rate limit: a window that reopens within the wait cap is waited for, then the same leaf answers", async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const hits = stubFetch({ "leaf1.test": () => new Response(okBody(), { status: 200 }) });
    await callAnalysisLlm([leaf(1, "m", { rpm: 1 })], msgs);
    offset += 59_950; // the window reopens ~50 ms from now
    const r = await callAnalysisLlm([leaf(1, "m", { rpm: 1 })], msgs, undefined, { maxRateLimitWaitMs: 1_000 });
    assert.equal(r.profileUsed.id, 1);
    assert.equal(hits.length, 2);
  } finally {
    Date.now = realNow;
  }
});

// ── transport retries ────────────────────────────────────────────────────────

test("transport: a hanging leaf times out once and fails over immediately (no retry on timeout)", async () => {
  let leaf1Calls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(input)).host;
    if (host === "leaf2.test") return new Response(okBody(), { status: 200 });
    leaf1Calls += 1;
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }) as typeof fetch;
  const t0 = Date.now();
  const r = await callAnalysisLlm([leaf(1, "m", { timeout_ms: 30 }), leaf(2)], msgs);
  const elapsed = Date.now() - t0;
  assert.equal(r.profileUsed.id, 2);
  assert.equal(leaf1Calls, 1);
  assert.ok(elapsed < 2_000, `failover took ${elapsed}ms`);
});

test("transport: a connection reset is retried quickly on the same leaf", async () => {
  let leaf1Calls = 0;
  globalThis.fetch = (async () => {
    leaf1Calls += 1;
    if (leaf1Calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    return new Response(okBody(), { status: 200 });
  }) as typeof fetch;
  const r = await callAnalysisLlm([leaf(1)], msgs);
  assert.equal(r.profileUsed.id, 1);
  assert.equal(leaf1Calls, 2);
});

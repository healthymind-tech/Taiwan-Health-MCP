/** mcpSessions: idle MCP sessions are closed, the cap closes the least recently used, a use keeps a session alive. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry, sessionLimitsFromEnv } from "./mcpSessions.js";

class FakeSession {
  closed = 0;
  close(): void {
    this.closed++;
  }
}

test("a session idle longer than the limit is closed and forgotten; a used one stays", () => {
  let now = 0;
  const reg = new SessionRegistry<FakeSession>({ idleMs: 1000, maxSessions: 0 }, () => now);
  const a = new FakeSession();
  const b = new FakeSession();
  reg.add("a", a);
  reg.add("b", b);
  now = 900;
  assert.equal(reg.get("a"), a, "a use at 900 renews a");
  now = 1500;
  assert.equal(reg.sweep(), 1);
  assert.equal(b.closed, 1);
  assert.equal(a.closed, 0);
  assert.equal(reg.get("b"), undefined, "a closed session is unknown (the server answers 404)");
  assert.equal(reg.size, 1);
  now = 2000;
  assert.equal(reg.sweep(), 1);
  assert.equal(a.closed, 1);
  assert.equal(reg.size, 0);
});

test("over the cap the least recently used session is closed to admit a new one", () => {
  let now = 0;
  const reg = new SessionRegistry<FakeSession>({ idleMs: 0, maxSessions: 2 }, () => now++);
  const s = [new FakeSession(), new FakeSession(), new FakeSession()];
  reg.add("0", s[0]);
  reg.add("1", s[1]);
  reg.get("0");
  reg.add("2", s[2]);
  assert.deepEqual(s.map((x) => x.closed), [0, 1, 0]);
  assert.equal(reg.size, 2);
  assert.equal(reg.sweep(), 0, "idle 0 = never closed for idling");
});

test("delete forgets a session the transport closed itself, without closing it again; a failing close is still dropped", () => {
  const reg = new SessionRegistry<{ close(): void }>({ idleMs: 10, maxSessions: 0 }, () => 100);
  let closes = 0;
  reg.add("x", { close: () => void closes++ });
  reg.delete("x");
  assert.equal(reg.size, 0);
  assert.equal(closes, 0);
  let now = 0;
  const reg2 = new SessionRegistry<{ close(): void }>({ idleMs: 10, maxSessions: 0 }, () => now);
  reg2.add("y", {
    close: () => {
      throw new Error("boom");
    },
  });
  now = 100;
  assert.equal(reg2.sweep(), 1);
  assert.equal(reg2.size, 0);
});

test("limits from env: defaults 60 min / 500, overridable, 0 allowed", () => {
  const saved = { i: process.env.MCP_SESSION_IDLE_MS, m: process.env.MCP_MAX_SESSIONS };
  try {
    delete process.env.MCP_SESSION_IDLE_MS;
    delete process.env.MCP_MAX_SESSIONS;
    assert.deepEqual(sessionLimitsFromEnv(), { idleMs: 3_600_000, maxSessions: 500 });
    process.env.MCP_SESSION_IDLE_MS = "0";
    process.env.MCP_MAX_SESSIONS = "20";
    assert.deepEqual(sessionLimitsFromEnv(), { idleMs: 0, maxSessions: 20 });
  } finally {
    for (const [k, v] of [["MCP_SESSION_IDLE_MS", saved.i], ["MCP_MAX_SESSIONS", saved.m]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

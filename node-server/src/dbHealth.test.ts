import { test } from "node:test";
import assert from "node:assert/strict";
import { isDbDownError } from "./dbHealth.js";

test("isDbDownError recognises Node pg / pgbouncer outage wording", () => {
  for (const m of [
    "connect ECONNREFUSED 172.18.0.9:5432",
    "Connection terminated unexpectedly",
    "server login has been failing, cached error: the database system is shutting down (server_login_retry)",
    "read ECONNRESET",
  ]) assert.equal(isDbDownError(new Error(m)), true, m);
  assert.equal(isDbDownError(new Error('relation "x" does not exist')), false);
});

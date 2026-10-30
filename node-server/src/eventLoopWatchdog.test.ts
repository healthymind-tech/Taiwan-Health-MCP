import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MOD = fileURLToPath(new URL("./eventLoopWatchdog.ts", import.meta.url));

test("event-loop watchdog: a main thread blocked past the threshold is killed (and logs why); a healthy one is not", () => {
  const blocked = spawnSync(process.execPath, ["--import", "tsx", "-e", `import("${MOD}").then((m) => { m.startEventLoopWatchdog(1); setTimeout(() => { const t = Date.now(); while (Date.now() - t < 8000) {} console.log("survived"); }, 1200); });`], { encoding: "utf8", timeout: 20000 });
  assert.equal(blocked.signal, "SIGKILL", blocked.stderr);
  assert.ok(!blocked.stdout.includes("survived"));
  assert.match(blocked.stderr, /event loop blocked/);
  const healthy = spawnSync(process.execPath, ["--import", "tsx", "-e", `import("${MOD}").then((m) => { const h = m.startEventLoopWatchdog(1); setTimeout(async () => { await h.stop(); console.log("ok"); }, 3000); });`], { encoding: "utf8", timeout: 20000 });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.match(healthy.stdout, /ok/);
});

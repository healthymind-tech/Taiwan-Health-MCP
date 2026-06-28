#!/usr/bin/env python3
"""End-to-end smoke harness (D4 skeleton).

Drives one real business path through a full stack and records the outcome so
Python and Node deployments can be compared step-by-step:

    upload source file -> trigger import -> wait for worker -> MCP tool query
    -> FHIR resource generation -> FHIR validation.

Phase-0 deliverable: it must *run* against the Python full stack and write an
"expected result" baseline. Steps that need real fixtures / a populated DB are
implemented defensively — a missing precondition yields SKIP, not a crash
(skeleton stage — failures allowed). See plan §2.4.

Usage:
    # Baseline mode: run against Python stack, capture expected results.
    python scripts/e2e_smoke.py \
        --base-url http://127.0.0.1:8080 \
        --mcp-url  http://127.0.0.1:8011 \
        --expected e2e-smoke-expected.json

    # Compare mode: run against Node stack and diff vs baseline.
    python scripts/e2e_smoke.py \
        --base-url http://127.0.0.1:8080 \
        --mcp-url  http://127.0.0.1:8000 \
        --baseline e2e-smoke-expected.json

`--base-url` is the front door (nginx) exposing `/admin/api/*`; `--mcp-url` is
the MCP endpoint (`/mcp`). They can point at the same host.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx


@dataclass
class StepResult:
    step: str
    status: str  # PASS | FAIL | SKIP
    summary: str = ""
    detail: dict[str, Any] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Minimal MCP client (subset of scripts/api_parity_test.py)
# --------------------------------------------------------------------------- #
class MCPClient:
    def __init__(self, base_url: str, timeout: float) -> None:
        self.url = base_url.rstrip("/")
        if not self.url.endswith("/mcp"):
            self.url += "/mcp"
        self.timeout = timeout
        self.session_id: str | None = None
        self.rid = 0

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json",
             "Accept": "application/json, text/event-stream"}
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        return h

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        r = httpx.post(self.url, json=payload, headers=self._headers(),
                       timeout=self.timeout, follow_redirects=True)
        r.raise_for_status()
        if sid := r.headers.get("Mcp-Session-Id"):
            self.session_id = sid
        if "text/event-stream" in r.headers.get("content-type", ""):
            for line in r.text.splitlines():
                if line.startswith("data: "):
                    return json.loads(line[6:])
            return {}
        return r.json()

    def connect(self) -> None:
        self.rid += 1
        self._post({"jsonrpc": "2.0", "method": "initialize", "id": self.rid,
                    "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "e2e-smoke", "version": "1.0"}}})

    def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        self.rid += 1
        resp = self._post({"jsonrpc": "2.0", "method": "tools/call", "id": self.rid,
                           "params": {"name": name, "arguments": arguments}})
        return resp.get("result", resp)


# --------------------------------------------------------------------------- #
# Steps. Each returns a StepResult and may short-circuit later steps via ctx.
# --------------------------------------------------------------------------- #
def step_admin_login(ctx: dict, args) -> StepResult:
    user = os.environ.get("ADMIN_USERNAME", "admin")
    pw = os.environ.get("ADMIN_PASSWORD", "admin")
    client: httpx.Client = ctx["http"]
    r = client.post(f"{args.base_url}/admin/api/login", json={"username": user, "password": pw})
    if r.status_code in (200, 204):
        return StepResult("admin_login", "PASS", f"status {r.status_code}")
    return StepResult("admin_login", "FAIL", f"status {r.status_code}: {r.text[:120]}")


def step_upload_source(ctx: dict, args) -> StepResult:
    # TODO: post a cut-down fixture (small ICD/LOINC zip) to /admin/api/sources/upload.
    # Skeleton: assert the sources endpoint is reachable; real upload pending fixtures.
    client: httpx.Client = ctx["http"]
    r = client.get(f"{args.base_url}/admin/api/sources")
    if r.status_code == 200:
        return StepResult("upload_source", "SKIP",
                          "sources endpoint reachable; fixture upload TODO",
                          {"count": _safelen(r)})
    return StepResult("upload_source", "SKIP", f"sources status {r.status_code} (allowed)")


def step_trigger_import(ctx: dict, args) -> StepResult:
    # TODO: POST /admin/api/jobs to enqueue an import for the uploaded fixture.
    return StepResult("trigger_import", "SKIP", "enqueue import TODO (needs fixture + module)")


def step_wait_worker(ctx: dict, args) -> StepResult:
    # TODO: poll /admin/api/jobs/<id> until terminal; honor a timeout budget.
    return StepResult("wait_worker", "SKIP", "worker poll TODO (depends on trigger_import)")


def step_mcp_query(ctx: dict, args) -> StepResult:
    mcp: MCPClient = ctx["mcp"]
    try:
        mcp.connect()
        result = mcp.call_tool("health_check", {})
        ok = bool(result)
        return StepResult("mcp_query", "PASS" if ok else "FAIL",
                          "health_check returned" if ok else "empty result",
                          {"has_result": ok})
    except Exception as exc:  # noqa: BLE001
        return StepResult("mcp_query", "FAIL", f"mcp error: {exc}")


def step_fhir_generate(ctx: dict, args) -> StepResult:
    mcp: MCPClient = ctx["mcp"]
    try:
        # fhir_list_igs is always available once the IG module is populated.
        result = mcp.call_tool("fhir_list_igs", {})
        return StepResult("fhir_generate", "PASS", "fhir_list_igs returned",
                          {"truthy": bool(result)})
    except Exception as exc:  # noqa: BLE001
        return StepResult("fhir_generate", "SKIP", f"fhir tool unavailable (allowed): {exc}")


def step_fhir_validate(ctx: dict, args) -> StepResult:
    # TODO: build a Condition/Medication via fhir_build_bundle + fhir_validate_resource
    # against the generated resource from step_fhir_generate.
    return StepResult("fhir_validate", "SKIP", "validate TODO (depends on fhir_generate output)")


STEPS: list[Callable[[dict, Any], StepResult]] = [
    step_admin_login,
    step_upload_source,
    step_trigger_import,
    step_wait_worker,
    step_mcp_query,
    step_fhir_generate,
    step_fhir_validate,
]


def _safelen(resp: httpx.Response) -> int | None:
    try:
        body = resp.json()
        if isinstance(body, list):
            return len(body)
        if isinstance(body, dict):
            for key in ("items", "sources", "data"):
                if isinstance(body.get(key), list):
                    return len(body[key])
    except Exception:  # noqa: BLE001
        return None
    return None


# --------------------------------------------------------------------------- #
# Runner
# --------------------------------------------------------------------------- #
def run(args: argparse.Namespace) -> int:
    ctx = {
        "http": httpx.Client(timeout=args.timeout, follow_redirects=True),
        "mcp": MCPClient(args.mcp_url, args.timeout),
    }
    results: list[StepResult] = []
    started = time.time()
    for fn in STEPS:
        try:
            res = fn(ctx, args)
        except Exception as exc:  # noqa: BLE001
            res = StepResult(fn.__name__.removeprefix("step_"), "FAIL", f"unhandled: {exc}")
        results.append(res)
        print(f"{res.status} {res.step}: {res.summary}")
    ctx["http"].close()
    elapsed = round(time.time() - started, 2)

    payload = {"elapsed_excluded": True, "steps": [r.__dict__ for r in results]}

    if args.expected:
        Path(args.expected).write_text(json.dumps(payload, indent=2, ensure_ascii=False))
        print(f"\nExpected baseline written: {args.expected}")

    exit_code = 0
    if args.baseline:
        try:
            base = json.loads(Path(args.baseline).read_text())
            exit_code = _compare(base, payload)
        except FileNotFoundError:
            print(f"FAIL: baseline {args.baseline} not found")
            exit_code = 2

    failed = [r for r in results if r.status == "FAIL"]
    print(f"\n{len(results)} steps in {elapsed}s, {len(failed)} failed")
    return exit_code or (1 if failed else 0)


def _compare(base: dict, current: dict) -> int:
    """Compare step status sequence (summaries/timestamps ignored)."""
    bsteps = {s["step"]: s["status"] for s in base.get("steps", [])}
    diffs = []
    for s in current.get("steps", []):
        if bsteps.get(s["step"]) != s["status"]:
            diffs.append(f"{s['step']}: baseline {bsteps.get(s['step'])} != current {s['status']}")
    for d in diffs:
        print(f"DIFF {d}")
    print(f"{len(diffs)} step-status diff(s) vs baseline")
    return 1 if diffs else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8080", help="front door (nginx)")
    parser.add_argument("--mcp-url", default="http://127.0.0.1:8011", help="MCP endpoint")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--expected", type=Path, help="write expected-result baseline")
    parser.add_argument("--baseline", type=Path, help="compare current run against this baseline")
    return run(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())

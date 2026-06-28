#!/usr/bin/env python3
"""Admin REST + WS parity harness (D2 skeleton).

Compares the legacy Python admin console (`/admin/api/*`, `/admin/ws`) with the
Node.js re-implementation. Phase-0 deliverable: it must *run* and produce a
golden baseline against Python; per-endpoint Node comparison is wired but
tolerant of a missing Node target (skeleton stage — failures allowed).

Usage:
    # Golden mode: dump Python responses to a baseline file.
    python scripts/admin_parity_test.py \
        --python-url http://127.0.0.1:8011 \
        --golden admin-golden.json

    # Compare mode: Python vs Node, normalized JSON equality.
    python scripts/admin_parity_test.py \
        --python-url http://127.0.0.1:8011 \
        --node-url   http://127.0.0.1:8000 \
        --report admin-parity-report.json

Auth: posts ADMIN_USERNAME / ADMIN_PASSWORD (env, falls back to admin/admin) to
`/admin/api/login` and reuses the `tw_health_admin_session` cookie.

Scope (this skeleton): read-only GET endpoints only. Write-type endpoints,
the 6-step FHIR Servers wizard, and the `/admin/ws` event-sequence comparison
are declared in the registries below as TODO and intentionally not yet exercised
(see docs/node-backend-full-refactor-plan.md §2.2).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx


# --------------------------------------------------------------------------- #
# Endpoint registries
# --------------------------------------------------------------------------- #
# Read-only GET endpoints safe to call against a live admin console. Keep this
# list in sync with src/admin_*.py route tables as they are ported to Node.
READ_ONLY_GETS: list[str] = [
    "/admin/api/overview",
    "/admin/api/services",
    "/admin/api/modules",
    "/admin/api/settings",
    "/admin/api/sources",
    "/admin/api/jobs",
    "/admin/api/schedule",
    "/admin/api/ig",
    "/admin/api/fhir-servers",
    "/admin/api/db-health",
]

# Write-type / interactive endpoints — documented here so the harness has a
# complete contract surface, but NOT executed in the skeleton. Each needs an
# isolated DB and a request/response + post-write DB-row comparison.
WRITE_TYPE_TODO: list[str] = [
    "POST /admin/api/settings",            # settings CRUD + test
    "POST /admin/api/sources/upload",      # fingerprint dedupe
    "POST /admin/api/jobs",                # enqueue import
    "POST /admin/api/schedule",            # cron CRUD
    "POST /admin/api/modules/maintenance", # maintenance mode toggle
    "POST /admin/api/ig/import",           # IG gallery import
    "POST /admin/api/fhir-servers",        # 6-step wizard create
    "POST /admin/api/fhir-servers/discover",
    "POST /admin/api/fhir-servers/test-request",
]

# WebSocket live-log comparison — connect /admin/ws, trigger a job, compare the
# event type/order sequence (timestamps ignored). TODO in skeleton.
WS_TODO = "/admin/ws"

# Response keys whose values are non-deterministic (clocks, durations, uptimes)
# and must be stripped before comparison / golden capture.
VOLATILE_KEYS = {
    "timestamp", "ts", "now", "uptime", "uptime_seconds", "duration",
    "duration_ms", "elapsed", "elapsed_ms", "started_at", "finished_at",
    "updated_at", "created_at", "last_seen", "heartbeat_at", "generated_at",
    "server_time",
}


@dataclass
class EndpointResult:
    path: str
    status: str  # PASS | FAIL | SKIP | GOLDEN
    message: str = ""
    python_status_code: int | None = None
    node_status_code: int | None = None
    differences: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Admin HTTP client
# --------------------------------------------------------------------------- #
class AdminClient:
    """Session-cookie admin client (mirrors web/admin-app login flow)."""

    def __init__(self, base_url: str, timeout: float) -> None:
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.client = httpx.Client(timeout=timeout, follow_redirects=True)
        self.logged_in = False

    def login(self, username: str, password: str) -> None:
        # JSON alias accepted by admin_console.py (/admin/api/login).
        resp = self.client.post(
            f"{self.base}/admin/api/login",
            json={"username": username, "password": password},
        )
        if resp.status_code not in (200, 204):
            raise RuntimeError(
                f"login failed: {resp.status_code} {resp.text[:200]}"
            )
        self.logged_in = True

    def get(self, path: str) -> httpx.Response:
        return self.client.get(f"{self.base}{path}")

    def close(self) -> None:
        self.client.close()


# --------------------------------------------------------------------------- #
# Normalisation + comparison
# --------------------------------------------------------------------------- #
def normalize(value: Any) -> Any:
    """Drop volatile keys recursively so two snapshots can be compared."""
    if isinstance(value, dict):
        return {
            k: normalize(v)
            for k, v in sorted(value.items())
            if k not in VOLATILE_KEYS
        }
    if isinstance(value, list):
        return [normalize(v) for v in value]
    return value


def shape_diff(left: Any, right: Any, path: str = "") -> list[str]:
    diffs: list[str] = []
    if type(left) is not type(right):
        return [f"{path or '<root>'}: type {type(left).__name__} != {type(right).__name__}"]
    if isinstance(left, dict):
        for key in sorted(set(left) | set(right)):
            if key not in left:
                diffs.append(f"{path}.{key}: missing on python")
            elif key not in right:
                diffs.append(f"{path}.{key}: missing on node")
            else:
                diffs.extend(shape_diff(left[key], right[key], f"{path}.{key}"))
    elif isinstance(left, list):
        if len(left) != len(right):
            diffs.append(f"{path}: length {len(left)} != {len(right)}")
        for i, (lv, rv) in enumerate(zip(left, right)):
            diffs.extend(shape_diff(lv, rv, f"{path}[{i}]"))
    elif left != right:
        diffs.append(f"{path or '<root>'}: {left!r} != {right!r}")
    return diffs


def safe_json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except Exception:  # noqa: BLE001 - non-JSON body is itself a signal
        return {"__nonjson__": resp.text[:500]}


# --------------------------------------------------------------------------- #
# Runner
# --------------------------------------------------------------------------- #
def run(args: argparse.Namespace) -> int:
    username = os.environ.get("ADMIN_USERNAME", "admin")
    password = os.environ.get("ADMIN_PASSWORD", "admin")

    python = AdminClient(args.python_url, args.timeout)
    try:
        python.login(username, password)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL python login: {exc}")
        return 2
    print(f"PASS python login ({args.python_url})")

    node: AdminClient | None = None
    if args.node_url:
        node = AdminClient(args.node_url, args.timeout)
        try:
            node.login(username, password)
            print(f"PASS node login ({args.node_url})")
        except Exception as exc:  # noqa: BLE001
            print(f"SKIP node login (skeleton, allowed): {exc}")
            node = None

    results: list[EndpointResult] = []
    golden: dict[str, Any] = {}

    for path in READ_ONLY_GETS:
        try:
            p_resp = python.get(path)
        except Exception as exc:  # noqa: BLE001
            results.append(EndpointResult(path, "FAIL", f"python error: {exc}"))
            print(f"FAIL {path}: python error: {exc}")
            continue

        p_body = normalize(safe_json(p_resp))
        golden[path] = {"status_code": p_resp.status_code, "body": p_body}

        if node is None:
            results.append(
                EndpointResult(path, "GOLDEN", "python captured", p_resp.status_code)
            )
            print(f"GOLDEN {path}: python {p_resp.status_code}")
            continue

        try:
            n_resp = node.get(path)
        except Exception as exc:  # noqa: BLE001
            results.append(EndpointResult(path, "SKIP", f"node error: {exc}", p_resp.status_code))
            print(f"SKIP {path}: node error (allowed): {exc}")
            continue

        n_body = normalize(safe_json(n_resp))
        diffs = shape_diff(p_body, n_body)
        if p_resp.status_code != n_resp.status_code:
            diffs.insert(0, f"status {p_resp.status_code} != {n_resp.status_code}")
        status = "PASS" if not diffs else "FAIL"
        results.append(
            EndpointResult(path, status, "", p_resp.status_code, n_resp.status_code, diffs)
        )
        print(f"{status} {path}" + (f": {len(diffs)} diff(s)" if diffs else ""))
        for d in diffs[:10]:
            print(f"    - {d}")

    python.close()
    if node:
        node.close()

    if args.golden:
        Path(args.golden).write_text(json.dumps(golden, indent=2, ensure_ascii=False))
        print(f"\nGolden baseline written: {args.golden} ({len(golden)} endpoints)")

    if args.report:
        report = [r.__dict__ for r in results]
        Path(args.report).write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(f"Report written: {args.report}")

    print(f"\nTODO (not yet exercised): {len(WRITE_TYPE_TODO)} write-type endpoints, "
          f"WS {WS_TODO}")

    failed = [r for r in results if r.status == "FAIL"]
    print(f"\n{len(results)} endpoints, {len(failed)} failed")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-url", default="http://127.0.0.1:8011")
    parser.add_argument("--node-url", default=None)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--golden", type=Path, help="write Python golden baseline here")
    parser.add_argument("--report", type=Path, help="write JSON comparison report here")
    return run(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""One-shot extractor: pull the inlined public-page HTML out of src/server.py
into verbatim source files under web/legacy/ so the Next.js front-end can serve
byte-identical pages.

Run once from the repo root:  python scripts/extract_legacy_html.py

It parses src/server.py with ast (no import / no DB needed) and writes:
  web/legacy/landing.html   <- _LANDING_HTML            (verbatim)
  web/legacy/privacy.html   <- _PRIVACY_HTML            (verbatim)
  web/legacy/dpa.html       <- _DPA_HTML                (verbatim)
  web/legacy/status.html    <- _STATUS_HTML_TEMPLATE    (verbatim, keeps the
                                "__CATEGORY_MAP__" etc. placeholders so the Node
                                route can inject /status.json at request time)
"""
from __future__ import annotations

import ast
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SERVER = ROOT / "src" / "server.py"
OUT = ROOT / "web" / "legacy"

WANTED = {
    "_LANDING_HTML": "landing.html",
    "_PRIVACY_HTML": "privacy.html",
    "_DPA_HTML": "dpa.html",
    "_STATUS_HTML_TEMPLATE": "status.html",
}


def main() -> None:
    tree = ast.parse(SERVER.read_text(encoding="utf-8"))
    found: dict[str, str] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            continue
        name = node.targets[0].id
        if name in WANTED and isinstance(node.value, ast.Constant):
            if isinstance(node.value.value, str):
                found[name] = node.value.value

    missing = set(WANTED) - set(found)
    if missing:
        raise SystemExit(f"Could not extract: {sorted(missing)}")

    OUT.mkdir(parents=True, exist_ok=True)
    for name, filename in WANTED.items():
        dest = OUT / filename
        dest.write_text(found[name], encoding="utf-8")
        print(f"wrote {dest.relative_to(ROOT)} ({len(found[name])} bytes)")


if __name__ == "__main__":
    main()

"""
FHIR reference-context store + Bundle assembly (Phase 3).

IG-agnostic, pure (no DB, no external service). The reference context is a
**urn allocator only**: it maps ``(context_id, key) → urn:uuid`` so an LLM can
wire resources together with stable references *before* the target resources are
finalized — set the target's ``fullUrl`` and a referrer's ``reference`` to the
same minted urn. ``build_bundle`` takes the resources inline and assembles a FHIR
Bundle, reporting reference integrity (it never silently mis-wires).

The store is process-global and ephemeral (TTL-evicted); in streamable-http it is
process-local, which is fine for an interactive authoring session. Because urns are
minted per ``(context_id, key)`` and reused, a caller can re-establish the same
mapping after a restart by reusing the same context id + keys.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Optional

# context_id -> {"created_at": float, "touched_at": float, "map": {key: urn}}
_CONTEXTS: dict[str, dict[str, Any]] = {}
_CONTEXT_TTL_SECONDS = 3600.0


def _now() -> float:
    return time.monotonic()


def _sweep() -> None:
    """Drop contexts untouched for longer than the TTL (lazy eviction)."""
    cutoff = _now() - _CONTEXT_TTL_SECONDS
    stale = [cid for cid, ctx in _CONTEXTS.items() if ctx["touched_at"] < cutoff]
    for cid in stale:
        _CONTEXTS.pop(cid, None)


def new_context() -> str:
    _sweep()
    context_id = uuid.uuid4().hex
    _CONTEXTS[context_id] = {"created_at": _now(), "touched_at": _now(), "map": {}}
    return context_id


def _ensure(context_id: Optional[str]) -> str:
    _sweep()
    if not context_id or context_id not in _CONTEXTS:
        cid = context_id or uuid.uuid4().hex
        _CONTEXTS[cid] = {"created_at": _now(), "touched_at": _now(), "map": {}}
        return cid
    _CONTEXTS[context_id]["touched_at"] = _now()
    return context_id


def mint(context_id: Optional[str], key: str) -> tuple[str, str]:
    """Return ``(context_id, urn)`` for ``key``, creating the context and/or the
    urn on first use. Stable: the same ``(context_id, key)`` always returns the
    same urn."""
    cid = _ensure(context_id)
    cmap = _CONTEXTS[cid]["map"]
    if key not in cmap:
        cmap[key] = f"urn:uuid:{uuid.uuid4()}"
    return cid, cmap[key]


def get_map(context_id: Optional[str]) -> dict[str, str]:
    if not context_id or context_id not in _CONTEXTS:
        return {}
    _CONTEXTS[context_id]["touched_at"] = _now()
    return dict(_CONTEXTS[context_id]["map"])


def _rewrite_references(node: Any, key_to_urn: dict[str, str]) -> None:
    """Recursively rewrite ``{"reference": "<key>" | "<Type>/<key>"}`` strings to
    their minted urn, in place. References already in ``urn:uuid:`` form or not
    matching a known key are left untouched."""
    if isinstance(node, dict):
        ref = node.get("reference")
        if isinstance(ref, str) and not ref.startswith("urn:uuid:"):
            cand = ref
            if cand not in key_to_urn and "/" in cand:
                cand = cand.split("/", 1)[1]
            if cand in key_to_urn:
                node["reference"] = key_to_urn[cand]
        for value in node.values():
            _rewrite_references(value, key_to_urn)
    elif isinstance(node, list):
        for item in node:
            _rewrite_references(item, key_to_urn)


def _collect_references(node: Any, out: list[str]) -> None:
    if isinstance(node, dict):
        ref = node.get("reference")
        if isinstance(ref, str):
            out.append(ref)
        for value in node.values():
            _collect_references(value, out)
    elif isinstance(node, list):
        for item in node:
            _collect_references(item, out)


def build_bundle(
    entries: list[dict],
    bundle_type: str = "transaction",
    context_id: Optional[str] = None,
) -> dict:
    """Assemble inline resource entries into a FHIR Bundle.

    Each entry is ``{resource, key?, fullUrl?, request?}``. The ``fullUrl`` is
    taken from an explicit ``fullUrl``, else minted from ``key`` via the context,
    else a fresh urn. References inside resources that name a known ``key`` (or
    ``Type/key``) are rewritten to the urn; ``urn:uuid:`` references that don't
    match any entry's fullUrl are reported in ``unresolved`` (never guessed).

    Returns ``{bundle, referenceMap, unresolved}``.
    """
    key_to_urn: dict[str, str] = {}
    prepared: list[dict] = []

    # First pass: assign a fullUrl to every entry and build the key → urn map.
    for entry in entries or []:
        resource = entry.get("resource") or {}
        key = entry.get("key")
        full_url = entry.get("fullUrl")
        if not full_url:
            if key is not None:
                context_id, full_url = mint(context_id, str(key))
            else:
                full_url = f"urn:uuid:{uuid.uuid4()}"
        if key is not None:
            key_to_urn[str(key)] = full_url
        prepared.append(
            {"resource": resource, "fullUrl": full_url, "request": entry.get("request")}
        )

    full_urls = {p["fullUrl"] for p in prepared}

    # Second pass: rewrite key references → urn, then assemble + check integrity.
    bundle_entries: list[dict] = []
    unresolved: list[dict] = []
    for p in prepared:
        resource = p["resource"]
        _rewrite_references(resource, key_to_urn)
        refs: list[str] = []
        _collect_references(resource, refs)
        for ref in refs:
            if ref.startswith("urn:uuid:") and ref not in full_urls:
                unresolved.append(
                    {"resourceType": resource.get("resourceType"), "reference": ref}
                )
        be: dict[str, Any] = {"fullUrl": p["fullUrl"], "resource": resource}
        request = p["request"]
        if bundle_type == "transaction" and not request:
            request = {"method": "POST", "url": resource.get("resourceType") or ""}
        if request:
            be["request"] = request
        bundle_entries.append(be)

    bundle = {
        "resourceType": "Bundle",
        "type": bundle_type,
        "entry": bundle_entries,
    }
    return {
        "bundle": bundle,
        "referenceMap": key_to_urn,
        "unresolved": unresolved,
    }

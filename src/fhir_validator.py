"""
In-process FHIR validator (Phase 4) — pre-flight conformance checks.

Pure, synchronous checks over a parsed StructureDefinition (``snapshot.element``) +
a resource dict: structure (cardinality / required / choice[x] / fixed / pattern /
maxLength), value/pattern slicing cardinality, and FHIRPath invariants via
``fhirpathpy``. Required-binding membership is DB-backed and lives in the service
(it needs ValueSet expansion).

Honesty contract: this is a **pre-flight** check (``source:"builtin"``); the
downstream FHIR server stays authoritative. Anything that cannot be evaluated
locally (e.g. a FHIRPath function fhirpathpy does not implement) is reported as
``information`` — never a false ``error``/pass.
"""

from __future__ import annotations

from typing import Any

import fhirpathpy

import fhir_snapshot

SOURCE = "builtin"


def issue(severity: str, path: str, code: str, message: str) -> dict:
    return {"severity": severity, "path": path, "code": code, "message": message}


def _elements(sd: dict) -> list[dict]:
    return (sd.get("snapshot") or {}).get("element") or []


def _rel_path(path: str, root: str) -> str | None:
    if path == root:
        return ""
    prefix = root + "."
    return path[len(prefix) :] if path.startswith(prefix) else None


def _get_at_path(node: Any, rel: str) -> list:
    """Return the flat list of values found at a dotted element path relative to
    ``node``. A trailing ``[x]`` segment matches any concrete choice property
    (``onset[x]`` → ``onsetDateTime`` / ``onsetPeriod`` / …)."""
    if rel == "":
        return [node]
    current = [node]
    for seg in rel.split("."):
        nxt: list = []
        choice = seg.endswith("[x]")
        stem = seg[:-3] if choice else seg
        for item in current:
            if not isinstance(item, dict):
                continue
            if choice:
                for key, val in item.items():
                    if (
                        key.startswith(stem)
                        and key != stem
                        and key[len(stem)].isupper()
                    ):
                        nxt.extend(val if isinstance(val, list) else [val])
            elif seg in item:
                val = item[seg]
                nxt.extend(val if isinstance(val, list) else [val])
        current = nxt
        if not current:
            break
    return [v for v in current if v is not None]


def _choice_props_present(node: dict, stem: str) -> list[str]:
    out = []
    for key in node:
        if (
            key.startswith(stem)
            and key != stem
            and key[len(stem) : len(stem) + 1].isupper()
        ):
            out.append(key)
    return out


def _pattern_matches(actual: Any, pattern: Any) -> bool:
    """pattern[x]: every element of the pattern must be present in the actual value
    (deep subset). fixed[x] uses exact equality instead (handled by caller)."""
    if isinstance(pattern, dict):
        if not isinstance(actual, dict):
            return False
        return all(_pattern_matches(actual.get(k), v) for k, v in pattern.items())
    if isinstance(pattern, list):
        if not isinstance(actual, list):
            return False
        return all(any(_pattern_matches(a, p) for a in actual) for p in pattern)
    return actual == pattern


def validate_structure(sd: dict, resource: dict) -> list[dict]:
    root = sd.get("type") or resource.get("resourceType") or ""
    issues: list[dict] = []
    for el in _elements(sd):
        if fhir_snapshot.is_slice_member(el):
            continue  # slice + slice-child constraints handled in validate_slicing
        path = el.get("path") or ""
        rel = _rel_path(path, root)
        if rel is None or rel == "":
            continue
        # Parent-presence gate: a nested element's constraints (required/fixed/…)
        # apply only *within* an existing parent. When the optional ancestor is
        # absent (e.g. no Patient.contact at all), its required children
        # (contact.telecom.system) are not applicable — skip rather than falsely
        # demand them.
        if "." in rel and not _get_at_path(resource, rel.rsplit(".", 1)[0]):
            continue
        # only enforce direct children precisely; deeper paths are best-effort
        min_card = el.get("min")
        max_card = el.get("max")
        is_choice = rel.endswith("[x]")
        values = _get_at_path(resource, rel)

        if isinstance(min_card, int) and min_card >= 1 and not values:
            issues.append(
                issue(
                    "error",
                    path,
                    "required",
                    f"{path} is required (min={min_card}) but missing",
                )
            )
        if max_card not in (None, "*"):
            try:
                cap = int(max_card)
                if len(values) > cap:
                    issues.append(
                        issue(
                            "error",
                            path,
                            "cardinality",
                            f"{path} occurs {len(values)} times (max={cap})",
                        )
                    )
            except (TypeError, ValueError):
                pass

        if is_choice and "." not in rel:
            stem = rel[:-3]
            present = _choice_props_present(resource, stem)
            if len(present) > 1:
                issues.append(
                    issue(
                        "error",
                        path,
                        "choice",
                        f"{path}: only one of {present} may be present",
                    )
                )

        fixed, pattern = fhir_snapshot._fixed_pattern(el)
        if fixed is not None:
            for v in values:
                if v != fixed["value"]:
                    issues.append(
                        issue("error", path, "fixed", f"{path} must equal fixed value")
                    )
                    break
        if pattern is not None:
            for v in values:
                if not _pattern_matches(v, pattern["value"]):
                    issues.append(
                        issue(
                            "error",
                            path,
                            "pattern",
                            f"{path} must match the required pattern",
                        )
                    )
                    break

        max_len = el.get("maxLength")
        if isinstance(max_len, int):
            for v in values:
                if isinstance(v, str) and len(v) > max_len:
                    issues.append(
                        issue(
                            "error",
                            path,
                            "maxLength",
                            f"{path} exceeds maxLength {max_len}",
                        )
                    )
                    break
    return issues


def validate_slicing(sd: dict, resource: dict) -> list[dict]:
    root = sd.get("type") or resource.get("resourceType") or ""
    els = _elements(sd)
    issues: list[dict] = []
    # group slice constraint elements by their base path
    for head in els:
        slicing = head.get("slicing")
        if not slicing or head.get("sliceName"):
            continue
        disc = slicing.get("discriminator") or []
        if not disc or any(d.get("type") not in ("value", "pattern") for d in disc):
            continue  # only value/pattern discriminators in v1
        path = head.get("path") or ""
        rel = _rel_path(path, root)
        if not rel:
            continue
        entries = _get_at_path(resource, rel)
        slices = [e for e in els if e.get("path") == path and e.get("sliceName")]
        for sl in slices:
            name = sl.get("sliceName")
            expected = _slice_discriminator_values(els, path, name, disc)
            if not expected:
                continue
            matched = [
                e
                for e in entries
                if all(
                    expected.get(dp) is not None and _value_at(e, dp) == expected[dp]
                    for dp in expected
                )
            ]
            smin = sl.get("min")
            if isinstance(smin, int) and smin >= 1 and len(matched) < smin:
                issues.append(
                    issue(
                        "error",
                        f"{path}:{name}",
                        "slice-cardinality",
                        f"slice '{name}' requires at least {smin} matching entr(y/ies)",
                    )
                )
    return issues


def _value_at(node: Any, dotted: str) -> Any:
    cur = node
    for seg in dotted.split("."):
        if isinstance(cur, list):
            cur = cur[0] if cur else None
        if not isinstance(cur, dict):
            return None
        cur = cur.get(seg)
    if isinstance(cur, list):
        return cur[0] if cur else None
    return cur


def _slice_discriminator_values(els, base_path, slice_name, disc) -> dict:
    """Resolve each discriminator's expected value for a slice from its child
    elements' fixed/pattern definitions (e.g. ``X:slice.system`` fixedUri)."""
    out: dict[str, Any] = {}
    for d in disc:
        dpath = d.get("path")
        if not dpath:
            continue
        child_id_a = f"{base_path}:{slice_name}.{dpath}"
        for el in els:
            if el.get("id") == child_id_a or (
                el.get("path") == f"{base_path}.{dpath}"
                and el.get("sliceName") == slice_name
            ):
                fixed, pattern = fhir_snapshot._fixed_pattern(el)
                if fixed is not None:
                    out[dpath] = fixed["value"]
                elif pattern is not None:
                    out[dpath] = pattern["value"]
                break
    return out


def evaluate_invariants(sd: dict, resource: dict) -> list[dict]:
    root = sd.get("type") or resource.get("resourceType") or ""
    issues: list[dict] = []
    unevaluable = 0
    for el in _elements(sd):
        if fhir_snapshot.is_slice_member(el):
            continue
        path = el.get("path") or ""
        rel = _rel_path(path, root)
        if rel is None:
            continue
        nodes = _get_at_path(resource, rel)
        for c in el.get("constraint") or []:
            expr = c.get("expression")
            if not expr:
                continue
            key = c.get("key") or "invariant"
            severity = c.get("severity") or "error"
            human = c.get("human") or expr
            for node in nodes:
                try:
                    result = fhirpathpy.evaluate(node, expr)
                except Exception:
                    unevaluable += 1
                    continue
                satisfied = bool(result) and result != [False]
                if not satisfied:
                    issues.append(issue(severity, path, key, human))
                    break
    if unevaluable:
        issues.append(
            issue(
                "information",
                "",
                "invariant-unevaluated",
                f"{unevaluable} invariant expression(s) could not be evaluated locally "
                f"(unsupported FHIRPath function); not a conformance failure",
            )
        )
    return issues


def is_valid(issues: list[dict]) -> bool:
    return not any(i["severity"] == "error" for i in issues)

"""
StructureDefinition snapshot projector (Phase 1).

Pure, stateless helpers over a StructureDefinition's ``snapshot.element`` array —
the structural truth the IG already ships in ``fhir.artifacts.raw_json``. Kept DB-
free so it is unit-testable in isolation and reusable by the Phase 5 resource-
skeleton generator. Every function takes the parsed StructureDefinition dict.
"""

from __future__ import annotations

from typing import Any, Optional


def _elements(sd: dict) -> list[dict]:
    return (sd.get("snapshot") or {}).get("element") or []


def _fixed_pattern(el: dict) -> tuple[Optional[dict], Optional[dict]]:
    """Extract a ``fixed[x]`` / ``pattern[x]`` value (the type is encoded in the
    key suffix, e.g. ``fixedUri`` / ``patternCodeableConcept``)."""
    fixed: Optional[dict] = None
    pattern: Optional[dict] = None
    for key, value in el.items():
        if key.startswith("fixed") and key != "fixed":
            fixed = {"field": key, "value": value}
        elif key.startswith("pattern") and key != "pattern":
            pattern = {"field": key, "value": value}
    return fixed, pattern


def is_slice_member(el: dict) -> bool:
    """True when an element belongs to a slice — the slice root **or any of its
    descendants**.

    ``el.get("sliceName")`` is only set on the slice *root* (e.g.
    ``Patient.identifier:idCardNumber``); its child elements
    (``Patient.identifier:idCardNumber.system`` …) carry the slice marker only in
    their ``id``. Base-schema walkers must use this — keying off ``sliceName``
    alone misclassifies slice-internal constraints (a slice's ``min=1`` /
    ``fixed`` child) as **base** constraints and enforces them on every entry.
    Base element ids never contain ``:`` (e.g. ``Patient.identifier``)."""
    return ":" in (el.get("id") or "")


def _types(el: dict) -> list[dict]:
    out: list[dict] = []
    for t in el.get("type") or []:
        item: dict[str, Any] = {"code": t.get("code")}
        if t.get("targetProfile"):
            item["targetProfile"] = t["targetProfile"]
        if t.get("profile"):
            item["profile"] = t["profile"]
        out.append(item)
    return out


def _binding(el: dict) -> Optional[dict]:
    b = el.get("binding")
    if not b:
        return None
    return {"strength": b.get("strength"), "valueSet": b.get("valueSet")}


def _constraints(el: dict) -> list[dict]:
    return [
        {
            "key": c.get("key"),
            "severity": c.get("severity"),
            "human": c.get("human"),
            "expression": c.get("expression"),
        }
        for c in el.get("constraint") or []
    ]


def project_element(el: dict) -> dict:
    """LLM-friendly projection of a single snapshot element."""
    fixed, pattern = _fixed_pattern(el)
    return {
        "id": el.get("id"),
        "path": el.get("path"),
        "sliceName": el.get("sliceName"),
        "min": el.get("min"),
        "max": el.get("max"),
        "mustSupport": bool(el.get("mustSupport")),
        "types": _types(el),
        "binding": _binding(el),
        "fixed": fixed,
        "pattern": pattern,
        "short": el.get("short"),
        "constraints": _constraints(el),
    }


def project_elements(sd: dict) -> list[dict]:
    """Full element list of a profile (``view=elements``)."""
    return [project_element(e) for e in _elements(sd)]


def element_paths(sd: dict) -> set[str]:
    """Set of element paths — used by the profile ranker."""
    return {e.get("path") for e in _elements(sd) if e.get("path")}


def get_element(
    sd: dict, path: str, slice_name: Optional[str] = None
) -> Optional[dict]:
    """One element by path (optionally a named slice) — ``view=element``."""
    for el in _elements(sd):
        if el.get("path") == path and (
            slice_name is None or el.get("sliceName") == slice_name
        ):
            return project_element(el)
    return None


def get_binding(sd: dict, path: str) -> Optional[dict]:
    """The required/extensible/example binding on an element — ``view=binding``."""
    el = get_element(sd, path)
    if el is None:
        return None
    return {"path": path, "binding": el["binding"], "types": el["types"]}


def _choice_property(path: str, type_code: str) -> str:
    """``onset[x]`` + ``dateTime`` → ``onsetDateTime`` (the JSON property name)."""
    base = path.split(".")[-1]
    stem = base[:-3] if base.endswith("[x]") else base
    if not type_code:
        return stem
    return stem + type_code[:1].upper() + type_code[1:]


def get_choices(sd: dict, path: str) -> Optional[dict]:
    """Resolve a ``[x]`` choice element to its allowed types + JSON property names
    + an input-type hint — ``view=choices``."""
    for el in _elements(sd):
        if el.get("path") == path:
            choices = [
                {
                    "type": t.get("code"),
                    "jsonProperty": _choice_property(path, t.get("code") or ""),
                }
                for t in el.get("type") or []
            ]
            return {
                "path": path,
                "min": el.get("min"),
                "max": el.get("max"),
                "choices": choices,
            }
    return None


def get_slices(sd: dict, path: str) -> Optional[dict]:
    """Slicing rules/discriminator at ``path`` + the defined slices — ``view=slices``."""
    els = _elements(sd)
    head: Optional[dict] = None
    for el in els:
        if el.get("path") == path and el.get("slicing"):
            head = el
            break
    if head is None:
        return None
    slicing = head["slicing"]
    slices = [
        project_element(el)
        for el in els
        if el.get("path") == path and el.get("sliceName")
    ]
    return {
        "path": path,
        "slicing": {
            "rules": slicing.get("rules"),
            "discriminator": slicing.get("discriminator"),
        },
        "slices": slices,
    }

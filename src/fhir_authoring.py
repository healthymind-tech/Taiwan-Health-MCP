"""
Schema-guided fill helpers (Phase 5) — pure, DB-free mechanical pinning.

The authoring division of labour: the LLM fills *semantic* blanks; the server pins
*mechanical* fields deterministically. These helpers do the latter — set
``fixed[x]``/``pattern[x]`` values and ``meta.profile`` — over a draft resource,
without touching semantics. Reused by ``FHIRIGService.finalize_resource``.
"""

from __future__ import annotations

import copy
from typing import Any

import fhir_snapshot


def ensure_meta_profile(resource: dict, canonical: str) -> bool:
    """Ensure ``canonical`` is present in ``resource.meta.profile``. Returns True
    when it was added."""
    if not canonical:
        return False
    meta = resource.setdefault("meta", {})
    profiles = meta.setdefault("profile", [])
    if canonical in profiles:
        return False
    profiles.append(canonical)
    return True


def set_at_path(
    resource: dict, rel_path: str, value: Any, *, overwrite: bool = False
) -> str:
    """Set ``value`` at a simple dotted ``rel_path`` under ``resource``.

    Conservative: descends only through **existing** dict nodes and never
    fabricates intermediate structure (a missing/array parent → ``skipped-missing``
    / ``skipped-array``), so it cannot mis-build a repeating element (e.g. turn a
    FHIR array into an object). The leaf itself is created on its existing parent.
    Returns ``"set"`` / ``"exists"`` / ``"skipped-array"`` / ``"skipped-missing"``."""
    if not rel_path:
        return "skipped-missing"
    segments = rel_path.split(".")
    node: Any = resource
    for seg in segments[:-1]:
        nxt = node.get(seg)
        if isinstance(nxt, list):
            return "skipped-array"
        if nxt is None:
            return "skipped-missing"
        if not isinstance(nxt, dict):
            return "skipped-missing"
        node = nxt
    leaf = segments[-1]
    if isinstance(node.get(leaf), list):
        return "skipped-array"
    if leaf in node and node[leaf] is not None and not overwrite:
        return "exists"
    node[leaf] = value
    return "set"


def _merge_pattern(node: dict, leaf: str, pattern: Any) -> str:
    """Shallow-merge a ``pattern[x]`` object into ``node[leaf]`` (set missing keys
    only). Returns ``"set"`` / ``"exists"`` / ``"skipped-array"``."""
    current = node.get(leaf)
    if isinstance(current, list):
        return "skipped-array"
    if current is None:
        node[leaf] = dict(pattern) if isinstance(pattern, dict) else pattern
        return "set"
    if isinstance(current, dict) and isinstance(pattern, dict):
        changed = False
        for k, v in pattern.items():
            if k not in current or current[k] is None:
                current[k] = v
                changed = True
        return "set" if changed else "exists"
    return "exists"


def pin_fixed_pattern(sd: dict, resource: dict) -> list[dict]:
    """Pin every ``fixed[x]`` / ``pattern[x]`` from the profile snapshot onto the
    draft where absent. Returns a trace of ``{path, field, action}``."""
    root = sd.get("type") or resource.get("resourceType") or ""
    prefix = root + "."
    trace: list[dict] = []
    for el in (sd.get("snapshot") or {}).get("element") or []:
        if fhir_snapshot.is_slice_member(el):
            continue  # slice fixed/pattern handled by pin_slices (needs a _slice tag)
        path = el.get("path") or ""
        if not path.startswith(prefix):
            continue
        rel = path[len(prefix) :]
        fixed, pattern = fhir_snapshot._fixed_pattern(el)
        if fixed is not None:
            action = set_at_path(resource, rel, fixed["value"])
            trace.append({"path": path, "field": fixed["field"], "action": action})
        elif pattern is not None:
            segments = rel.split(".")
            node: Any = resource
            action = "set"
            for seg in segments[:-1]:
                nxt = node.get(seg)
                if isinstance(nxt, list):
                    action = "skipped-array"
                    break
                if nxt is None or not isinstance(nxt, dict):
                    action = "skipped-missing"
                    break
                node = nxt
            if action in ("skipped-array", "skipped-missing"):
                trace.append(
                    {"path": path, "field": pattern["field"], "action": action}
                )
                continue
            action = _merge_pattern(node, segments[-1], pattern["value"])
            trace.append({"path": path, "field": pattern["field"], "action": action})
    return trace


# --------------------------------------------------------------------------- #
#  Slice-aware pinning                                                          #
# --------------------------------------------------------------------------- #
#
# A profile's identifier/name/etc. is often *sliced* (e.g. TW Core Patient's
# idCardNumber / passportNumber / residentNumber identifier slices), with the
# discriminator + required values (``system``, ``type.coding.system/code``) held
# as ``fixed``/``pattern`` on the slice's **child** elements. Those cannot be
# pinned by ``pin_fixed_pattern`` (they live inside a repeating array and the
# server cannot guess which slice a given entry is meant to be). The division of
# labour: the LLM tags each entry with ``_slice: "<sliceName>"`` (a *semantic*
# choice — "this is a national ID card"); the server then pins that slice's
# mechanical fixed/pattern fields onto the entry and strips the tag.


def _max_is_array(max_card: Any) -> bool:
    return max_card == "*" or (str(max_card).isdigit() and int(max_card) > 1)


def _slice_template(els: list[dict], base_path: str, slice_name: str) -> dict:
    """Assemble the nested fixed/pattern object a slice mandates, from its child
    elements' ``fixed[x]``/``pattern[x]`` (array-vs-object shape inferred from each
    intermediate element's ``max``)."""
    prefix = f"{base_path}:{slice_name}."
    max_map: dict[str, Any] = {}
    for el in els:
        eid = el.get("id") or ""
        if eid.startswith(prefix):
            max_map[eid[len(prefix) :]] = el.get("max")
    template: dict = {}
    for el in els:
        eid = el.get("id") or ""
        if not eid.startswith(prefix):
            continue
        fixed, pattern = fhir_snapshot._fixed_pattern(el)
        value = fixed["value"] if fixed is not None else None
        if value is None and pattern is not None:
            value = pattern["value"]
        if value is None:
            continue
        _insert_template(template, eid[len(prefix) :].split("."), value, max_map, "")
    return template


def _insert_template(
    node: dict, segs: list[str], value: Any, max_map: dict, sub_prefix: str
) -> None:
    seg = segs[0]
    sub = f"{sub_prefix}.{seg}" if sub_prefix else seg
    is_array = _max_is_array(max_map.get(sub))
    if len(segs) == 1:
        node.setdefault(seg, [value] if is_array else value)
        return
    if is_array:
        arr = node.setdefault(seg, [{}])
        if not arr:
            arr.append({})
        if isinstance(arr[0], dict):
            _insert_template(arr[0], segs[1:], value, max_map, sub)
    else:
        child = node.setdefault(seg, {})
        if isinstance(child, dict):
            _insert_template(child, segs[1:], value, max_map, sub)


def _deep_merge_fill(target: dict, template: Any) -> None:
    """Fill ``target`` with ``template`` where absent — the LLM's existing values
    always win; only missing keys/elements are added."""
    if not isinstance(template, dict):
        return
    for k, v in template.items():
        if k not in target or target[k] is None:
            target[k] = copy.deepcopy(v)
        elif isinstance(target[k], dict) and isinstance(v, dict):
            _deep_merge_fill(target[k], v)
        elif isinstance(target[k], list) and isinstance(v, list):
            if not target[k]:
                target[k] = copy.deepcopy(v)
            else:
                for i, tv in enumerate(v):
                    if i < len(target[k]) and isinstance(target[k][i], dict):
                        _deep_merge_fill(target[k][i], tv)
                    elif i >= len(target[k]):
                        target[k].append(copy.deepcopy(tv))


def pin_slices(sd: dict, resource: dict) -> list[dict]:
    """Pin slice-mandated fixed/pattern values onto entries the LLM tagged with
    ``_slice``. Operates on direct array elements (``identifier``/``name``/…);
    strips the ``_slice`` tag. Returns a trace of ``{path, slice, action, fields?}``."""
    els = (sd.get("snapshot") or {}).get("element") or []
    root = sd.get("type") or resource.get("resourceType") or ""
    prefix = root + "."
    slice_root_ids = {e.get("id") for e in els if e.get("sliceName")}
    trace: list[dict] = []
    for head in els:
        if fhir_snapshot.is_slice_member(head) or not head.get("slicing"):
            continue
        path = head.get("path") or ""
        if not path.startswith(prefix):
            continue
        rel = path[len(prefix) :]
        if "." in rel:  # only direct array elements (identifier, name, telecom…)
            continue
        entries = resource.get(rel)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            hint = entry.pop("_slice", None)
            if not hint:
                continue
            if f"{path}:{hint}" not in slice_root_ids:
                trace.append({"path": path, "slice": hint, "action": "unknown-slice"})
                continue
            template = _slice_template(els, path, str(hint))
            _deep_merge_fill(entry, template)
            trace.append(
                {
                    "path": path,
                    "slice": hint,
                    "action": "pinned",
                    "fields": sorted(template.keys()),
                }
            )
    return trace

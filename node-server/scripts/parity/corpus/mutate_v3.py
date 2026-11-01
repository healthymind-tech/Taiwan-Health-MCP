"""Corpus mutations, parity v3 review (REVIEW_port_1 section 6): mutation classes the parity_v2 mutators do not reach.
Writes the evaluator corpus layout (corpus/loaders.ts `evaluator`): <out>/<id>.json (the bytes validator_cli is given)
+ <out>/manifest.jsonl rows {id, ig, package, source, kind, family, mutation, mutation_path, raw, text_level, profile,
profile_source[, tier]}. The official side (<id>.official.json) is computed by the evaluator with validator_cli.

Families (all prefixed v3-; deterministic — seeded by source file + family + index):
  v3-absent-value   (F1) a primitive's value replaced by `_x` + data-absent-reason (code-like names first / any
                    primitive), or the value kept with the extension beside it
  v3-narrative      (F2) text.div: no xmlns, broken nesting, div inside p, p inside table, javascript: href,
                    <script>, non-div root, empty div, unknown element
  v3-dup-id         (F3) two elements of one resource with the same element id; two contained resources with the same
                    id (an existing contained duplicated, or two new ones with a #reference to them)
  v3-raw-literal    (F4) text-level, applied AFTER serialization (raw: true, text_level: true — feed the file bytes):
                    integer written 1.0 / 1e3 / 1E0, decimal in exponent form, duplicate JSON keys (other value / same
                    value / object member)
  v3-dup-prim-ext   (F7) the same extension twice on a primitive (`_x.extension`): an existing primitive extension
                    duplicated, or data-absent-reason twice beside the value
  v3-code-system    (F6) invalid Attachment.contentType (pdf / text / x-nonsense), invalid BCP-47 codes (language
                    elements, bcp:47 codings, Resource.language)

usage:
  python3 -I mutate_v3.py <out_dir> --from-corpus ~/ref/parity_corpus/<ig>   # sources = the corpus' __orig items
  python3 -I mutate_v3.py <out_dir> --examples <dir> --ig <name> --package id#ver [--manifest <existing manifest.jsonl>]
  options: --n <mutants per source and family, default 3> --families v3-narrative,v3-dup-id,...
Only the standard library is used.
"""
import argparse, copy, json, os, pathlib, random, sys

DAR = "http://hl7.org/fhir/StructureDefinition/data-absent-reason"
XHTML_NS = "http://www.w3.org/1999/xhtml"
CODE_LIKE = {"status", "gender", "intent", "use", "code", "priority", "mode", "kind", "type", "language", "clinicalStatus", "criticality", "comparator", "unit", "system"}
SENT = "__V3_RAW_SENTINEL__"
DUPKEY = "__V3_DUPKEY__"


# ---------------------------------------------------------------- tree helpers
def walk(o, p=()):
    """(path, parent, key, value) for every member / item below o (pre-order)."""
    if isinstance(o, dict):
        for k, v in list(o.items()):
            yield p + (k,), o, k, v
            yield from walk(v, p + (k,))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            yield p + (i,), o, i, v
            yield from walk(v, p + (i,))


def fhir_path(p):
    out = ""
    for k in p:
        out += f"[{k}]" if isinstance(k, int) else ("." + k if out else k)
    return out


def resources(root):
    """(path prefix, resource dict) — the root, Bundle entry resources (not contained)."""
    out = [((), root)]
    if root.get("resourceType") == "Bundle":
        for i, e in enumerate(root.get("entry") or []):
            if isinstance(e, dict) and isinstance(e.get("resource"), dict):
                out.append((("entry", i, "resource"), e["resource"]))
    return out


def in_resource(res):
    """walk() below one resource, not descending into contained / nested Bundle resources."""
    def rec(o, p):
        if isinstance(o, dict):
            for k, v in list(o.items()):
                if k in ("contained",) or (k == "resource" and isinstance(v, dict) and "resourceType" in v):
                    continue
                yield p + (k,), o, k, v
                yield from rec(v, p + (k,))
        elif isinstance(o, list):
            for i, v in enumerate(o):
                yield p + (i,), o, i, v
                yield from rec(v, p + (i,))
    yield from rec(res, ())


def primitives(res):
    """(path, parent dict, key) of primitive members (string / number / bool, incl. array items via the key)."""
    for p, parent, k, v in in_resource(res):
        if isinstance(parent, dict) and isinstance(k, str) and not k.startswith("_") and k not in ("resourceType", "id", "url", "div", "reference", "fullUrl") and isinstance(v, (str, int, float, bool)):
            yield p, parent, k


def pick_resource(root, r, pred=lambda res: True):
    cands = [(pre, res) for pre, res in resources(root) if pred(res)]
    if not cands:
        return None, None
    # prefer entry resources for Bundles (the Bundle itself has little content)
    inner = [c for c in cands if c[0]] or cands
    return r.choice(inner)


# ---------------------------------------------------------------- mutations: each (root, r) -> (mutation, path) | None
def absent_value(root, r, variant):
    pre, res = pick_resource(root, r, lambda x: any(True for _ in primitives(x)))
    if res is None:
        return None
    prims = [x for x in primitives(res) if not isinstance(x[1].get(x[2]), bool)]
    if variant == "dar-code-like":
        prims = [x for x in prims if x[2] in CODE_LIKE and isinstance(x[1][x[2]], str)] or prims
    if not prims:
        return None
    p, parent, k = r.choice(prims)
    ext = {"extension": [{"url": DAR, "valueCode": "unknown"}]}
    if variant == "dar-with-value":
        parent["_" + k] = ext
    else:
        del parent[k]
        parent["_" + k] = ext
    return variant, fhir_path(pre + p)


NARR = {
    "drop-xmlns": lambda d: d.replace(f' xmlns="{XHTML_NS}"', "", 1),
    "broken-nesting": lambda d: f'<div xmlns="{XHTML_NS}"><p>x</div>',
    "div-in-p": lambda d: f'<div xmlns="{XHTML_NS}"><p><div>x</div></p></div>',
    "p-in-table": lambda d: f'<div xmlns="{XHTML_NS}"><table><p>x</p></table></div>',
    "active-href": lambda d: f'<div xmlns="{XHTML_NS}"><a href="javascript:alert(1)">x</a></div>',
    "script": lambda d: f'<div xmlns="{XHTML_NS}"><script>x</script><p>x</p></div>',
    "non-div-root": lambda d: f'<p xmlns="{XHTML_NS}">x</p>',
    "empty-div": lambda d: f'<div xmlns="{XHTML_NS}"></div>',
    "unknown-element": lambda d: f'<div xmlns="{XHTML_NS}"><blink>x</blink></div>',
    "unclosed-in-orig": lambda d: d.replace("</p>", "", 1) if "</p>" in d else d[: max(1, len(d) - 6)],
}


def narrative(root, r, variant):
    pre, res = pick_resource(root, r, lambda x: "resourceType" in x)
    if res is None:
        return None
    text = res.get("text")
    if not isinstance(text, dict) or not isinstance(text.get("div"), str):
        res["text"] = text = {"status": "generated", "div": f'<div xmlns="{XHTML_NS}"><p>x</p></div>'}
    new = NARR[variant](text["div"])
    if new == text["div"]:
        return None
    text["div"] = new
    return variant, fhir_path(pre + ("text", "div"))


def dup_id(root, r, variant):
    if variant == "element-id":
        pre, res = pick_resource(root, r, lambda x: sum(1 for _, _, _, v in in_resource(x) if isinstance(v, dict)) >= 2)
        if res is None:
            return None
        elems = [(p, v) for p, _, _, v in in_resource(res) if isinstance(v, dict) and p and p[0] not in ("meta", "text")]
        if len(elems) < 2:
            return None
        (p1, a), (p2, b) = r.sample(elems, 2)
        a["id"] = b["id"] = "dup1"
        return variant, fhir_path(pre + p2)
    pre, res = pick_resource(root, r, lambda x: "resourceType" in x)
    if res is None:
        return None
    cont = res.get("contained")
    if variant == "contained-copy":
        if not (isinstance(cont, list) and cont and isinstance(cont[0], dict) and cont[0].get("id")):
            return None
        cont.append(copy.deepcopy(cont[0]))
        return variant, fhir_path(pre + ("contained", len(cont) - 1))
    # contained-new: two Organizations "o" and a reference to "#o" (dom-3 satisfied)
    refs = [(p, v) for p, _, _, v in in_resource(res) if isinstance(v, dict) and isinstance(v.get("reference"), str)]
    if not refs:
        return None
    p, ref = r.choice(refs)
    ref["reference"] = "#o"
    res["contained"] = (cont if isinstance(cont, list) else []) + [{"resourceType": "Organization", "id": "o", "name": "A"}, {"resourceType": "Organization", "id": "o", "name": "B"}]
    return variant, fhir_path(pre + ("contained",))


def raw_literal(root, r, variant):
    """Marks the target with a sentinel; serialize() swaps in the literal text. Returns (mutation, path, swaps)."""
    pre, res = pick_resource(root, r, lambda x: "resourceType" in x)
    if res is None:
        return None
    nums = [(p, parent, k) for p, parent, k, v in in_resource(res) if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if variant in ("int-1.0", "int-1e3", "int-1E0"):
        ints = [x for x in nums if isinstance(x[1][x[2]], int)]
        if not ints:
            return None
        p, parent, k = r.choice(ints)
        v = parent[k]
        lit = {"int-1.0": f"{v}.0", "int-1e3": "1e3", "int-1E0": f"{v}E0"}[variant]
        parent[k] = SENT
        return variant, fhir_path(pre + p), [(json.dumps(SENT), lit)]
    if variant == "decimal-exp":
        decs = [x for x in nums if isinstance(x[1][x[2]], float)] or nums
        if not decs:
            return None
        p, parent, k = r.choice(decs)
        lit = f"{parent[k]}e0"
        parent[k] = SENT
        return variant, fhir_path(pre + p), [(json.dumps(SENT), lit)]
    # duplicate keys: insert a sentinel member right after the target member, swapped for "key": <value>
    prims = [(p, parent, k) for p, parent, k in primitives(res) if isinstance(parent.get(k), str)]
    objs = [(p, parent, k) for p, parent, k, v in in_resource(res) if isinstance(parent, dict) and isinstance(k, str) and isinstance(v, dict) and p and p[0] != "text"]
    pool = objs if variant == "dup-key-object" else prims
    if not pool:
        return None
    p, parent, k = r.choice(pool)
    if variant == "dup-key-same":
        dup = parent[k]
    elif variant == "dup-key-object":
        dup = {}
    else:
        dup = parent[k] + "-dup" if not k in CODE_LIKE else ("unknown" if parent[k] != "unknown" else "other")
    items = list(parent.items())
    parent.clear()
    for kk, vv in items:
        parent[kk] = vv
        if kk == k:
            parent[DUPKEY] = 0
    return variant, fhir_path(pre + p), [(json.dumps(DUPKEY) + ": 0", json.dumps(k) + ": " + json.dumps(dup, ensure_ascii=False))]


def dup_prim_ext(root, r, variant):
    pre, res = pick_resource(root, r, lambda x: "resourceType" in x)
    if res is None:
        return None
    if variant == "dup-existing":
        hits = [(p, parent, k) for p, parent, k, v in in_resource(res) if isinstance(k, str) and k.startswith("_") and isinstance(v, dict) and isinstance(v.get("extension"), list) and v["extension"]]
        if not hits:
            return None
        p, parent, k = r.choice(hits)
        parent[k]["extension"].append(copy.deepcopy(parent[k]["extension"][0]))
        return variant, fhir_path(pre + p)
    prims = list(primitives(res))
    if not prims:
        return None
    p, parent, k = r.choice(prims)
    if isinstance(parent[k], list):
        return None
    parent["_" + k] = {"extension": [{"url": DAR, "valueCode": "unknown"}, {"url": DAR, "valueCode": "unknown"}]}
    return variant, fhir_path(pre + p)


def code_system(root, r, variant):
    pre, res = pick_resource(root, r, lambda x: "resourceType" in x)
    if res is None:
        return None
    if variant.startswith("contentType-"):
        hits = [(p, parent, k) for p, parent, k, v in walk(root) if k == "contentType" and isinstance(v, str)]
        if not hits:
            return None
        p, parent, k = r.choice(hits)
        parent[k] = {"contentType-pdf": "pdf", "contentType-text": "text", "contentType-nonsense": "application/x-nonsense-zz"}[variant]
        return variant, fhir_path(p)
    if variant == "bcp47-element":
        hits = [(p, parent, k) for p, parent, k, v in walk(root) if k == "language" and isinstance(v, str)]
        if not hits:
            return None
        p, parent, k = r.choice(hits)
        parent[k] = "xx-nonsense-zz"
        return variant, fhir_path(p)
    if variant == "bcp47-coding":
        hits = [(p, v) for p, _, _, v in walk(root) if isinstance(v, dict) and v.get("system") == "urn:ietf:bcp:47" and isinstance(v.get("code"), str)]
        if not hits:
            return None
        p, c = r.choice(hits)
        c["code"] = "xx-nonsense-zz"
        c.pop("display", None)
        return variant, fhir_path(p + ("code",))
    # Resource.language on a resource that has none
    res["language"] = "xx-nonsense-zz"
    return "bcp47-resource-language", fhir_path(pre + ("language",))


FAMILIES = {
    "v3-absent-value": (absent_value, ["dar-code-like", "dar-any", "dar-with-value"]),
    "v3-narrative": (narrative, list(NARR)),
    "v3-dup-id": (dup_id, ["element-id", "contained-copy", "contained-new"]),
    "v3-raw-literal": (raw_literal, ["int-1.0", "int-1e3", "int-1E0", "decimal-exp", "dup-key", "dup-key-same", "dup-key-object"]),
    "v3-dup-prim-ext": (dup_prim_ext, ["dup-existing", "dup-dar"]),
    "v3-code-system": (code_system, ["contentType-pdf", "contentType-text", "contentType-nonsense", "bcp47-element", "bcp47-coding", "bcp47-resource-language"]),
}


def serialize(obj, swaps):
    text = json.dumps(obj, indent=2, ensure_ascii=False)
    for a, b in swaps:
        if a not in text:
            raise ValueError("sentinel lost")
        text = text.replace(a, b, 1)
    return text


def sources_from_corpus(d):
    rows = [json.loads(l) for l in open(d / "manifest.jsonl", encoding="utf-8") if l.strip()]
    for row in rows:
        if row.get("family") != "orig":
            continue
        f = d / f"{row['id']}.json"
        if f.exists():
            yield row, json.loads(f.read_text(encoding="utf-8"))


def sources_from_examples(d, ig, package, manifest):
    known = {}
    if manifest:
        for l in open(manifest, encoding="utf-8"):
            if l.strip():
                row = json.loads(l)
                known.setdefault(row["source"], row)
    for f in sorted(d.glob("*.json")):
        try:
            res = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(res, dict) or "resourceType" not in res:
            continue
        row = dict(known.get(f.name, {}))
        if not row:
            prof = ((res.get("meta") or {}).get("profile") or [None])[0]
            if not prof:
                continue
            row = {"profile": prof, "profile_source": "meta.profile"}
        row.update({"ig": row.get("ig", ig), "package": row.get("package", package), "source": f.name, "kind": "bundle" if res["resourceType"] == "Bundle" else "single"})
        yield row, res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--from-corpus")
    ap.add_argument("--examples")
    ap.add_argument("--ig")
    ap.add_argument("--package")
    ap.add_argument("--manifest")
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--families", default=",".join(FAMILIES))
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.from_corpus:
        srcs = list(sources_from_corpus(pathlib.Path(os.path.expanduser(a.from_corpus))))
    elif a.examples and a.ig and a.package:
        srcs = list(sources_from_examples(pathlib.Path(a.examples), a.ig, a.package, a.manifest))
    else:
        ap.error("--from-corpus <dir>, or --examples <dir> --ig --package")
    fams = [f for f in a.families.split(",") if f in FAMILIES]
    written = 0
    with open(out / "manifest.jsonl", "w", encoding="utf-8") as man:
        for row, base in srcs:
            stem = pathlib.Path(row["source"]).stem
            for fam in fams:
                fn, variants = FAMILIES[fam]
                seen = set()
                idx = 0
                for attempt in range(a.n * len(variants) * 2):
                    if idx >= a.n * len(variants):
                        break
                    variant = variants[attempt % len(variants)]
                    r = random.Random(f"{row['source']}|{fam}|{attempt}")
                    obj = copy.deepcopy(base)
                    try:
                        res = fn(obj, r, variant)
                    except (ValueError, IndexError, KeyError, TypeError):
                        res = None
                    if not res:
                        continue
                    mutation, path = res[0], res[1]
                    swaps = res[2] if len(res) > 2 else []
                    try:
                        text = serialize(obj, swaps)
                    except ValueError:
                        continue
                    if text in seen:
                        continue
                    seen.add(text)
                    mid = f"{stem}__{fam}__{idx:03d}"
                    idx += 1
                    (out / f"{mid}.json").write_text(text, encoding="utf-8")
                    m = {"id": mid, "ig": row.get("ig"), "package": row.get("package"), "source": row["source"], "kind": row.get("kind"), "family": fam, "mutation": mutation, "mutation_path": path, "raw": bool(swaps), "text_level": bool(swaps), "profile": row.get("profile"), "profile_source": row.get("profile_source")}
                    if "tier" in row:
                        m["tier"] = row["tier"]
                    man.write(json.dumps(m, ensure_ascii=False) + "\n")
                    written += 1
    print(f"{written} mutants from {len(srcs)} sources -> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()

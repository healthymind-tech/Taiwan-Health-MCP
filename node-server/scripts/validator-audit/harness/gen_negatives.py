"""Generate a mutated (mostly negative) corpus from the valid IG examples.

usage: gen_negatives.py examples.json all_sd.json out.json

Every mutation records `mutation` and the expected direction (`expect`: invalid
unless noted); the oracle verdict is still the reference for scoring.
"""
import copy, json, random, sys

random.seed(20261016)
examples = json.load(open(sys.argv[1]))
sds = json.load(open(sys.argv[2]))
out = []

TW_ICD = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-cm-2023-tw"


def add(base, mutation, res, expect="invalid"):
    out.append({"pkg": base["pkg"], "key": f"{base['key']}#{mutation}", "res": res, "mutation": mutation, "expect": expect})


def profile_sd(ex):
    for p in ex["res"].get("meta", {}).get("profile", []):
        sd = sds.get(f"{ex['pkg']}|{p.split('|')[0]}")
        if sd:
            return sd
    return None


def top_elements(sd):
    root = sd["type"]
    for el in sd["snapshot"]["element"]:
        eid = el["id"]
        if eid.count(".") != 1 or ":" in eid:
            continue
        yield el, eid.split(".", 1)[1]


def present_key(res, name):
    if name.endswith("[x]"):
        stem = name[:-3]
        for k in res:
            if k.startswith(stem) and len(k) > len(stem) and k[len(stem)].isupper():
                return k
        return None
    return name if name in res else None


def strings_in(node, path=()):
    """Yield (path, value) for string leaves (excluding narrative div)."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k in ("div", "resourceType", "url", "reference", "fullUrl"):
                continue
            yield from strings_in(v, path + (k,))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from strings_in(v, path + (i,))
    elif isinstance(node, str):
        yield path, node


def set_path(node, path, value):
    for p in path[:-1]:
        node = node[p]
    node[path[-1]] = value


def get_path(node, path):
    for p in path:
        node = node[p]
    return node


def codings(node, path=()):
    if isinstance(node, dict):
        if "system" in node and "code" in node and isinstance(node.get("code"), str):
            yield path, node
        for k, v in node.items():
            if k == "text":
                continue
            yield from codings(v, path + (k,))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from codings(v, path + (i,))


singles = [e for e in examples if e["res"].get("resourceType") != "Bundle"]

for ex in singles:
    res = ex["res"]
    sd = profile_sd(ex)
    # M1 remove each required top-level element (profile min >= 1)
    if sd:
        removed = 0
        for el, name in top_elements(sd):
            if (el.get("min") or 0) >= 1 and name not in ("id",):
                k = present_key(res, name)
                if k and removed < 3:
                    r = copy.deepcopy(res)
                    del r[k]
                    r.pop("_" + k, None)
                    add(ex, f"M1-remove-required-{k}", r)
                    removed += 1
    # M3 bad code in a required-bound code element (status)
    if "status" in res and isinstance(res["status"], str):
        r = copy.deepcopy(res)
        r["status"] = "bogus-status"
        add(ex, "M3-status-bogus", r)
    # M5 unknown property
    r = copy.deepcopy(res)
    r["foo"] = "bar"
    add(ex, "M5-unknown-prop", r)
    # M17 invalid id
    if "id" in res:
        r = copy.deepcopy(res)
        r["id"] = "bad id!"
        add(ex, "M17-bad-id", r)
    # M2 wrong primitive JSON type (first string leaf that is not a code-ish id)
    leaves = [(p, v) for p, v in strings_in(res) if p and p[-1] not in ("id",) and "meta" not in p]
    if leaves:
        p, v = random.choice(leaves)
        r = copy.deepcopy(res)
        set_path(r, p, 12345)
        add(ex, "M2-number-for-string-" + ".".join(map(str, p)), r)
        p, v = random.choice(leaves)
        r = copy.deepcopy(res)
        set_path(r, p, "")
        add(ex, "M14-empty-string-" + ".".join(map(str, p)), r)
    # M6 array/single violations
    for k, v in res.items():
        if isinstance(v, list) and v and isinstance(v[0], dict) and k not in ("contained", "extension"):
            r = copy.deepcopy(res)
            r[k] = v[0]
            add(ex, f"M6-object-for-array-{k}", r)
            break
    if "status" in res and isinstance(res["status"], str):
        r = copy.deepcopy(res)
        r["status"] = [res["status"]]
        add(ex, "M6-array-for-single-status", r)
    # M8 invariants
    if res.get("resourceType") == "Observation" and any(k.startswith("value") for k in res):
        r = copy.deepcopy(res)
        r["dataAbsentReason"] = {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/data-absent-reason", "code": "unknown"}]}
        add(ex, "M8-obs6-value-and-dar", r)
    # M9 bad code in an IG/THO CodeSystem coding; M10 wrong display
    cods = [(p, c) for p, c in codings(res) if isinstance(c.get("system"), str)
            and ("twcore.mohw.gov.tw" in c["system"] or "nhicore.nhi.gov.tw" in c["system"] or "terminology.hl7.org/CodeSystem" in c["system"])]
    if cods:
        p, c = cods[0]
        r = copy.deepcopy(res)
        get_path(r, p)["code"] = "ZZZ-NOT-A-CODE"
        add(ex, "M9-bad-code-" + ".".join(map(str, p)), r)
        withdisp = [(p, c) for p, c in cods if c.get("display")]
        if withdisp:
            p, c = withdisp[0]
            r = copy.deepcopy(res)
            get_path(r, p)["display"] = "Completely Wrong Display"
            add(ex, "M10-wrong-display-" + ".".join(map(str, p)), r)
    # M12 unknown extension; M13 known extension wrong type; M4 extension both value+children
    r = copy.deepcopy(res)
    r.setdefault("extension", []).append({"url": "http://foo.org/fhir/StructureDefinition/nope", "valueString": "x"})
    add(ex, "M12-unknown-extension", r)
    if ex["res"].get("resourceType") == "Patient":
        r = copy.deepcopy(res)
        r.setdefault("extension", []).append({"url": "http://hl7.org/fhir/StructureDefinition/patient-birthPlace", "valueString": "Taipei"})
        add(ex, "M13-ext-wrong-type", r)
        r = copy.deepcopy(res)
        r.setdefault("extension", []).append({"url": "http://hl7.org/fhir/StructureDefinition/patient-birthPlace", "valueAddress": {"city": "Taipei"}, "extension": [{"url": "a", "valueString": "b"}]})
        add(ex, "M4-ext1-value-and-children", r)
        r = copy.deepcopy(res)
        r.setdefault("extension", []).append({"url": "http://hl7.org/fhir/StructureDefinition/patient-birthPlace", "valueAddress": {"city": "Taipei"}})
        add(ex, "P-known-extension-ok", r, expect="valid")
        r = copy.deepcopy(res)
        for ident in r.get("identifier", [])[:1]:
            ident["system"] = [ident.get("system", "http://a.org"), "http://b.org/x"]
        add(ex, "N-identifier-system-array", r)
        r = copy.deepcopy(res)
        r["birthDate"] = "1990-13-45"
        add(ex, "M4-bad-date", r)
        r = copy.deepcopy(res)
        r.setdefault("identifier", []).append({"system": "http://example.org/ids", "value": "1"})
        add(ex, "M18-example-url", r)
        r = copy.deepcopy(res)
        r.setdefault("identifier", []).append({"system": "http://www.moi.gov.tw", "value": "B123456789"})
        r.setdefault("identifier", []).append({"use": "usual", "system": "https://www.hospital.example.tw/mrn", "value": "MRN-1"})
        add(ex, "P-multiple-identifiers", r, expect="valid")
    if res.get("resourceType") == "Condition":
        for code, exp in (("foo", "invalid"), ("resolved", "valid"), ("remission", "valid"), ("relapse", "valid")):
            r = copy.deepcopy(res)
            r["clinicalStatus"] = {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-clinical", "code": code}]}
            if exp == "valid" and code in ("resolved", "remission"):
                r["abatementDateTime"] = "2023-01-01"
            add(ex, f"N-clinicalStatus-{code}", r, expect=exp)
        if "category" in res:
            r = copy.deepcopy(res)
            del r["category"]
            add(ex, "N-condition-no-category", r)
    if res.get("resourceType") == "Encounter":
        r = copy.deepcopy(res)
        r["period"] = {"start": "2023-02-01T10:00:00+08:00", "end": "2023-01-01T10:00:00+08:00"}
        add(ex, "M8-per1-reversed", r)
    if res.get("resourceType") in ("Patient", "Practitioner", "Organization"):
        r = copy.deepcopy(res)
        r["managingOrganization" if res["resourceType"] == "Patient" else "extension"] = (
            {"reference": "#missing"} if res["resourceType"] == "Patient" else r.get("extension", [])
        )
        if res["resourceType"] == "Patient":
            add(ex, "M8-ref-contained-missing", r)

# Vital-sign specific negatives/positives (user's minimal repro)
for ex in singles:
    profs = " ".join(ex["res"].get("meta", {}).get("profile", []))
    if ex["pkg"] != "tw.gov.mohw.twcore" or "Observation-" not in profs:
        continue
    res = ex["res"]
    if any(k.startswith("value") for k in res) and not res.get("component"):
        r = copy.deepcopy(res)
        for k in [k for k in r if k.startswith("value")]:
            del r[k]
        add(ex, "N-vs2-no-value", r)
        r = copy.deepcopy(res)
        for k in [k for k in r if k.startswith("value")]:
            del r[k]
        r["dataAbsentReason"] = {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/data-absent-reason", "code": "unknown", "display": "Unknown"}]}
        add(ex, "P-vs2-dataAbsentReason", r, expect="valid")
    if "valueQuantity" in res:
        r = copy.deepcopy(res)
        r["valueBoolean"] = True
        del r["valueQuantity"]
        add(ex, "M11-choice-type-not-allowed", r)
        r = copy.deepcopy(res)
        r["valueQuantity"]["system"] = "http://unitsofmeasure.org/wrong"
        add(ex, "M7-fixed-system-wrong", r)
    if res.get("component"):
        r = copy.deepcopy(res)
        c0 = r["component"][0]
        for k in [k for k in c0 if k.startswith("value")]:
            del c0[k]
        add(ex, "N-vs3-component-no-value", r)
    if res.get("category"):
        r = copy.deepcopy(res)
        r["category"] = [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "laboratory"}]}]
        add(ex, "M15-required-slice-missing", r)
    if "effectiveDateTime" in res:
        r = copy.deepcopy(res)
        r["effectiveDateTime"] = "2023-01-01T10:00:00"
        add(ex, "M4-datetime-no-tz", r)

# Bundles: drop/garble entries
for ex in [e for e in examples if e["res"].get("resourceType") == "Bundle"]:
    res = ex["res"]
    entries = res.get("entry", [])
    if len(entries) > 1:
        r = copy.deepcopy(res)
        del r["entry"][0]
        add(ex, "B-drop-first-entry", r)
        r = copy.deepcopy(res)
        r["entry"][0]["resource"]["foo"] = 1
        add(ex, "B-entry-unknown-prop", r)
        r = copy.deepcopy(res)
        r["entry"].append(copy.deepcopy(r["entry"][0]))
        add(ex, "B-duplicate-first-entry", r)
    r = copy.deepcopy(res)
    r["type"] = "not-a-type"
    add(ex, "B-bad-type", r)

json.dump(out, open(sys.argv[3], "w"), ensure_ascii=False)
print(len(out), "mutations")

"""v2 mutation families (issues A-F of the second external report) over the IG examples.

usage: gen_v2_mutations.py examples.json[.gz] terms.json out.json

terms.json holds locally-known terms for the codes used in the examples
(LOINC long common name / short name / consumer name, SNOMED active and
inactive descriptions, ICD-10-CM titles); it is produced from the staging DB
(see README). Every mutant gets key "<example key>#<family>-<n>" and an
"expect" hint (valid / invalid); the oracle verdict is what is compared.
Deterministic (fixed seed).
"""
import copy, json, random, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle

rnd = random.Random(20261016)
examples = [c for c in oracle.load_json(sys.argv[1]) if c["res"].get("resourceType") != "Bundle"]
terms = oracle.load_json(sys.argv[2])
out = []

LOINC, SCT, ISO = "http://loinc.org", "http://snomed.info/sct", "urn:iso:std:iso:3166"
ICD = "http://hl7.org/fhir/sid/icd-10-cm"


def codings(node, acc=None):
    """All Coding-like dicts (system+code, not Quantity) inside a resource."""
    acc = [] if acc is None else acc
    if isinstance(node, dict):
        if isinstance(node.get("system"), str) and isinstance(node.get("code"), str) and "value" not in node:
            acc.append(node)
        for k, v in node.items():
            if k != "contained":
                codings(v, acc)
    elif isinstance(node, list):
        for v in node:
            codings(v, acc)
    return acc


def quantities(node, acc=None):
    acc = [] if acc is None else acc
    if isinstance(node, dict):
        if "value" in node and isinstance(node.get("value"), (int, float)) and node.get("system") == "http://unitsofmeasure.org":
            acc.append(node)
        for v in node.values():
            quantities(v, acc)
    elif isinstance(node, list):
        for v in node:
            quantities(v, acc)
    return acc


def idents(node, acc=None):
    acc = [] if acc is None else acc
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "identifier":
                for i in (v if isinstance(v, list) else [v]):
                    if isinstance(i, dict) and isinstance(i.get("system"), str):
                        acc.append(i)
            idents(v, acc)
    elif isinstance(node, list):
        for v in node:
            idents(v, acc)
    return acc


def add(c, fam, res, expect):
    n = sum(1 for o in out if o["key"].startswith(c["key"] + "#" + fam + "-"))
    out.append({"pkg": c["pkg"], "key": f"{c['key']}#{fam}-{n}", "res": res, "expect": expect})


def mutate(c, pick, fn, fam, expect, limit=1):
    """Apply fn to up to `limit` targets picked from a fresh copy (one mutant per target)."""
    targets = pick(c["res"])
    for idx in range(min(limit, len(targets))):
        res = copy.deepcopy(c["res"])
        t = pick(res)[idx]
        if fn(t) is False:
            continue
        add(c, fam, res, expect)


# ---------------------------------------------------------------- A: displays
all_disp = {}
for c in examples:
    for cd in codings(c["res"]):
        if isinstance(cd.get("display"), str):
            all_disp.setdefault(cd["system"], {})[cd["code"]] = cd["display"]

for c in examples:
    # A-swap: a display taken from another code of the same system
    def swap(cd):
        pool = [d for k, d in all_disp.get(cd["system"], {}).items() if k != cd["code"] and d.lower() != str(cd.get("display", "")).lower()]
        if not pool:
            return False
        cd["display"] = rnd.choice(sorted(pool))
    mutate(c, lambda r: [x for x in codings(r) if x["system"] in all_disp], swap, "A-swap", "invalid")
    # A-zh: Chinese display on international terminologies
    def zh(cd):
        cd["display"] = "測試名稱"
    mutate(c, lambda r: [x for x in codings(r) if x["system"] in (LOINC, SCT) or x["system"].startswith("http://terminology.hl7.org/CodeSystem/")], zh, "A-zh", "invalid")
    # A-case (positive): an existing display in upper case
    def upper(cd):
        cd["display"] = cd["display"].upper()
    mutate(c, lambda r: [x for x in codings(r) if isinstance(x.get("display"), str) and x["display"].upper() != x["display"]], upper, "A-case", "valid")
    # A-ws (negative): doubled inner space
    def ws(cd):
        if " " not in cd["display"]:
            return False
        cd["display"] = cd["display"].replace(" ", "  ", 1)
    mutate(c, lambda r: [x for x in codings(r) if isinstance(x.get("display"), str) and " " in x["display"]], ws, "A-ws", "invalid")
    # LOINC: long common name / short name valid, consumer name invalid
    for fam, field, expect in (("A-lcn", "lcn", "valid"), ("A-short", "short", "valid"), ("A-consumer", "consumer", "invalid")):
        def setf(cd, field=field):
            t = terms["loinc"].get(cd["code"], {})
            v = t.get(field)
            if not v or (field == "consumer" and v.lower() in (t.get("lcn", "").lower(), t.get("short", "").lower())):
                return False
            cd["display"] = v
        mutate(c, lambda r: [x for x in codings(r) if x["system"] == LOINC and x["code"] in terms["loinc"]], setf, fam, expect)
    # SNOMED: any active synonym / inactive description valid; another concept's term invalid
    def sct_syn(cd):
        pool = terms["sct"].get(cd["code"], [])
        if not pool:
            return False
        cd["display"] = rnd.choice(sorted(pool))
    mutate(c, lambda r: [x for x in codings(r) if x["system"] == SCT and x["code"] in terms["sct"]], sct_syn, "A-sctsyn", "valid")
    def sct_inactive(cd):
        pool = terms["sct_inactive"].get(cd["code"], [])
        if not pool:
            return False
        cd["display"] = rnd.choice(sorted(pool))
    mutate(c, lambda r: [x for x in codings(r) if x["system"] == SCT and x["code"] in terms["sct_inactive"]], sct_inactive, "A-sctinactive", "valid")
    def sct_other(cd):
        others = [t[0] for k, t in sorted(terms["sct"].items()) if k != cd["code"] and t]
        cd["display"] = rnd.choice(others)
    mutate(c, lambda r: [x for x in codings(r) if x["system"] == SCT and x["code"] in terms["sct"]], sct_other, "A-sctother", "invalid")
    # ICD-10-CM: TW Core ICD codes re-expressed in the international system
    def icd(cd, good):
        name = terms["icd"].get(cd["code"])
        if not name:
            return False
        cd["system"] = ICD
        cd["display"] = name if good else "糖尿病"
    mutate(c, lambda r: [x for x in codings(r) if "icd-10-cm" in x["system"]], lambda cd: icd(cd, True), "A-icdok", "valid")
    mutate(c, lambda r: [x for x in codings(r) if "icd-10-cm" in x["system"]], lambda cd: icd(cd, False), "A-icdzh", "invalid")
    # ISO 3166
    for fam, disp, expect in (("A-isoTaiwan", "Taiwan", "invalid"), ("A-isoOK", "Taiwan, Province of China", "valid")):
        def iso(cd, disp=disp):
            if cd["code"] != "TW":
                return False
            cd["display"] = disp
        mutate(c, lambda r: [x for x in codings(r) if x["system"] == ISO], iso, fam, expect)

# ---------------------------------------------------------------- B: unknown definition URLs
FAKE_CS = [
    "http://terminology.hl7.org/CodeSystem/v3-DataOrigin", "http://terminology.hl7.org/CodeSystem/medication-request-category",
    "http://terminology.hl7.org/CodeSystem/v3-ActEncounterCode", "http://terminology.hl7.org/CodeSystem/route-codes",
    "http://terminology.hl7.org/CodeSystem/route", "http://terminology.hl7.org/CodeSystem/v2-0079",
    "http://terminology.hl7.org/CodeSystem/request-category", "http://terminology.hl7.org/CodeSystem/allergyintolerance-verify",
    "http://hl7.org/fhir/sid/twnhi", "http://hl7.org/fhir/CodeSystem/observation-category",
]
OK_CS = ["https://www.hospital.example.tw/cs/local", "http://terminology.hl7.org/foo/bar", "urn:oid:2.16.886.101.20003.20014"]
i = 0
for c in examples:
    def fake(cd):
        global i
        cd["system"] = FAKE_CS[i % len(FAKE_CS)]
        cd.pop("display", None)
        i += 1
    mutate(c, codings, fake, "B-cs", "invalid")
    def fake_ok(cd):
        global i
        cd["system"] = OK_CS[i % len(OK_CS)]
        i += 1
    # positive only where no required binding is involved is not knowable here; leave expect unset
    mutate(c, lambda r: [x for x in codings(r) if x["system"].startswith("http://snomed.info")], fake_ok, "B-csok", None)
    res = copy.deepcopy(c["res"])
    res.setdefault("extension", []).append({"url": "http://hl7.org/fhir/StructureDefinition/country", "valueString": "TW"})
    add(c, "B-ext", res, "invalid")
    res = copy.deepcopy(c["res"])
    res.setdefault("extension", []).append({"url": "http://hl7.org/fhir/StructureDefinition/patient-nationality",
                                             "extension": [{"url": "code", "valueCodeableConcept": {"text": "TW"}},
                                                           {"url": "http://hl7.org/fhir/StructureDefinition/foo-nested", "valueString": "x"}]})
    add(c, "B-extnested", res, "invalid")
    def ident_fake(idf):
        idf["system"] = "http://terminology.hl7.org/CodeSystem/hospital-mrn"
    mutate(c, idents, ident_fake, "B-ident", "invalid")
    def ident_ok(idf):
        idf["system"] = "http://hl7.org/fhir/sid/us-ssn"
    mutate(c, idents, ident_ok, "B-identok", "valid")

# ---------------------------------------------------------------- C: UCUM
BAD_UNITS = ["[uIU]/mL", "tab", "/HPF", "beats/min", "mmHg", "degC", "mcg", "IU", "units", "cells/uL", "x10^3/uL", "bpm", "kg/m^2", "mL/min/1.73m2"]
GOOD_UNITS = ["mg/dL", "mmol/L", "u[IU]/mL", "m[IU]/L", "Cel", "%", "{score}", "1", "/min", "mm[Hg]", "10*3/uL", "/[HPF]", "kg/m2", "mL/min/{1.73_m2}"]
j = 0
for c in examples:
    def bad(q):
        global j
        q["code"] = BAD_UNITS[j % len(BAD_UNITS)]
        j += 1
    mutate(c, quantities, bad, "C-bad", "invalid")
    def good(q):
        global j
        q["code"] = GOOD_UNITS[j % len(GOOD_UNITS)]
        j += 1
    mutate(c, quantities, good, "C-good", None)  # may violate a unit binding / pattern

# ---------------------------------------------------------------- D: OIDs
BAD_OIDS = ["urn:oid:2.16.886.101.donghu.mrn", "urn:oid:2.16.886.101.20003.20014.0001", "urn:oid:1.2.3", "urn:oid:3.1.2.4", "urn:oid:2.16.886.101.", "urn:oid:2.16"]
GOOD_OIDS = ["urn:oid:2.16.886.101.20003.20014", "urn:oid:1.3.6.1.4.1", "urn:oid:2.16.840.1.113883.4.1", "urn:oid:2.16.886.101.20003.20014.10"]
k = 0
for c in examples:
    def boid(idf):
        global k
        idf["system"] = BAD_OIDS[k % len(BAD_OIDS)]
        k += 1
    mutate(c, idents, boid, "D-bad", "invalid")
    def goid(idf):
        global k
        idf["system"] = GOOD_OIDS[k % len(GOOD_OIDS)]
        k += 1
    mutate(c, idents, goid, "D-good", "valid")

# ---------------------------------------------------------------- E: ValueSet URL as Coding.system
VS_FOR = {
    "http://terminology.hl7.org/CodeSystem/observation-category": "http://hl7.org/fhir/ValueSet/observation-category",
    "http://terminology.hl7.org/CodeSystem/condition-clinical": "http://hl7.org/fhir/ValueSet/condition-clinical",
    "http://terminology.hl7.org/CodeSystem/condition-ver-status": "http://hl7.org/fhir/ValueSet/condition-ver-status",
    "http://terminology.hl7.org/CodeSystem/condition-category": "http://hl7.org/fhir/ValueSet/condition-category",
    "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical": "http://hl7.org/fhir/ValueSet/allergyintolerance-clinical",
    "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification": "http://hl7.org/fhir/ValueSet/allergyintolerance-verification",
    "http://terminology.hl7.org/CodeSystem/v3-MaritalStatus": "http://hl7.org/fhir/ValueSet/marital-status",
    "http://terminology.hl7.org/CodeSystem/medicationrequest-category": "http://hl7.org/fhir/ValueSet/medicationrequest-category",
    "http://terminology.hl7.org/CodeSystem/v2-0203": "http://hl7.org/fhir/ValueSet/identifier-type",
    "http://terminology.hl7.org/CodeSystem/organization-type": "http://hl7.org/fhir/ValueSet/organization-type",
    "http://loinc.org": "http://hl7.org/fhir/ValueSet/observation-codes",
}
for c in examples:
    def vs(cd):
        cd["system"] = VS_FOR[cd["system"]]
        cd.pop("display", None)
    mutate(c, lambda r: [x for x in codings(r) if x["system"] in VS_FOR], vs, "E-vs", "invalid")

# ---------------------------------------------------------------- F1: vital-sign alternative codes
ALT = {"29463-7": "3141-9", "8310-5": "8331-1", "8302-2": "8306-3", "8867-4": "8889-8", "9279-1": "76170-0",
       "2708-6": "59408-5", "39156-5": "89270-3", "9843-4": "8287-5", "85354-9": "8480-6"}
for c in examples:
    r = c["res"]
    if r.get("resourceType") != "Observation":
        continue
    cds = [x for x in (r.get("code") or {}).get("coding", []) if x.get("system") == LOINC and x.get("code") in ALT]
    if not cds:
        continue
    res = copy.deepcopy(r)
    res["code"]["coding"] = [{"system": LOINC, "code": ALT[cds[0]["code"]]}]
    add(c, "F1-alt", res, "invalid")
    res = copy.deepcopy(r)
    res.pop("meta", None)
    res["code"]["coding"] = [{"system": LOINC, "code": ALT[cds[0]["code"]]}]
    add(c, "F1-altnoprof", res, "invalid")

import collections
# Cap each family (deterministic sample) to keep the oracle load polite.
CAP = 60
byfam = collections.defaultdict(list)
for o in out:
    byfam[o["key"].split("#")[1].rsplit("-", 1)[0]].append(o)
out = []
for fam in sorted(byfam):
    items = byfam[fam]
    out.extend(items if len(items) <= CAP else random.Random(fam).sample(items, CAP))
json.dump(out, open(sys.argv[3], "w"), ensure_ascii=False, indent=0)
print(len(out), collections.Counter(o["key"].split("#")[1].rsplit("-", 1)[0] for o in out))

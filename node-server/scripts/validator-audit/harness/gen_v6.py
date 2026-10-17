"""(v6) Probes for `|version` canonicals and for slice members vs base-element rules.

usage: gen_v6.py examples.json.gz core_patient_sd.json out.json

- `core_patient_sd.json`: hl7.fhir.r4.core#4.0.1 StructureDefinition/Patient (snapshot), e.g.
  `psql -At -c "select raw_json from fhir.artifacts where package_id='hl7.fhir.r4.core'
   and canonical_url='http://hl7.org/fhir/StructureDefinition/Patient'"`.
- Items may carry `ver` (validate against that IG version: the CLI oracle runs
  `-ig <pkg>#<ver>`) and `overlay` (extra StructureDefinitions: `-ig <file>` for the
  CLI, served before the DB closure by localValidate.ts).

Families:
  M-*   meta.profile with |version (installed, release line maj.min, wildcard,
        other installed version outside the closure, nonexistent, major only)
  E-*   Extension.url with |version
  S-*   slice member must also satisfy the base element (TW Core 0.3.2 Patient
        identifier without system; PAS closure = TW Core 0.3.2)
  B-*   required binding ValueSet with |version (custom profile overlay)
  T-*   Reference.targetProfile with |version (custom profile overlay)
  Y-*   type profile with |version (custom profile overlay)
"""
import copy, gzip, json, sys

TW = "tw.gov.mohw.twcore"
PAS = "tw.gov.mohw.nhi.pas"
PAT = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Patient-twcore"
AGE = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/person-age"
PROBE = "http://twh.probe/fhir/StructureDefinition/"


def load(path):
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def main():
    examples = load(sys.argv[1])
    core = load(sys.argv[2])
    pat = next(c["res"] for c in examples if c["pkg"] == TW and c["key"] == "Patient/pat-example")
    good = copy.deepcopy(pat)
    good["id"] = "v6-good"
    bad = copy.deepcopy(pat)  # idCardNumber slice member without system (base Patient.identifier.system 1..1)
    bad["id"] = "v6-nosys"
    del bad["identifier"][0]["system"]
    out = []

    def add(key, pkg, res, expect, ver=None, overlay=None, note=""):
        item = {"key": key, "pkg": pkg, "res": res, "expect": expect, "note": note}
        if ver:
            item["ver"] = ver
        if overlay:
            item["overlay"] = overlay
        out.append(item)

    def with_profile(base, profile, rid):
        r = copy.deepcopy(base)
        r["id"] = rid
        r["meta"] = {"profile": [profile]}
        return r

    # --- M: meta.profile |version (TW Core 1.0.0 closure) ---------------------------
    for suffix, expect, note in [
        ("", "invalid", "control, unversioned"),
        ("|1.0.0", "invalid", "installed version"),
        ("|1.0", "invalid", "maj.min release line → 1.0.0"),
        ("|1.0.9", "invalid", "same maj.min, nonexistent patch → 1.0.0 (getByPackage maj.min index)"),
        ("|1.0.x", "invalid", "wildcard"),
        ("|1", "valid", "major only: not resolvable → unchecked"),
        ("|0.3.2", "valid", "other installed version, outside the 1.0.0 closure → unchecked"),
        ("|9.9.9", "valid", "nonexistent version → unchecked"),
    ]:
        tag = suffix.replace("|", "v") or "unver"
        add(f"M-tw-{tag}", TW, with_profile(bad, PAT + suffix, f"m-tw-{tag.replace('.', '-')}"), expect, note=note)
    add("M-tw-good-v1.0.0", TW, with_profile(good, PAT + "|1.0.0", "m-tw-good"), "valid", note="control")
    # PAS 1.2.7 closure holds TW Core 0.3.2 (not 1.0.0)
    for suffix, expect, note in [
        ("", "invalid", "unversioned → TW Core 0.3.2 in the PAS closure"),
        ("|0.3.2", "invalid", "installed in the PAS closure"),
        ("|1.0.0", "valid", "installed in the DB but not in the PAS closure → unchecked"),
    ]:
        tag = suffix.replace("|", "v") or "unver"
        add(f"M-pas-{tag}", PAS, with_profile(bad, PAT + suffix, f"m-pas-{tag.replace('.', '-')}"), expect, note=note)

    # --- E: Extension.url |version -------------------------------------------------
    for suffix, expect in [("|1.0.0", "valid"), ("|1.0", "valid"), ("|9.9.9", "invalid"), ("|0.3.2", "invalid")]:
        r = copy.deepcopy(good)
        r["id"] = "e-" + suffix[1:].replace(".", "-")
        for e in r.get("extension", []):
            if e.get("url") == AGE:
                e["url"] = AGE + suffix
                break
        else:
            r.setdefault("extension", []).append({"url": AGE + suffix, "valueAge": {"value": 32, "system": "http://unitsofmeasure.org", "code": "a"}})
        add(f"E-tw-age{suffix.replace('|', 'v')}", TW, r, expect)

    # --- S: slice member vs base element ---------------------------------------------
    add("S-032-nosys", TW, with_profile(bad, PAT, "s-032-nosys"), "invalid", ver="0.3.2", note="TW Core 0.3.2: slice idCardNumber has no system min, base does")
    add("S-032-good", TW, with_profile(good, PAT, "s-032-good"), "valid", ver="0.3.2")
    add("S-100-nosys", TW, with_profile(bad, PAT, "s-100-nosys"), "invalid", note="TW Core 1.0.0: both slice and base")
    bad2 = copy.deepcopy(good)
    bad2["identifier"][1].pop("system", None)  # MR slice member without system
    add("S-032-mr-nosys", TW, with_profile(bad2, PAT, "s-032-mr-nosys"), "invalid", ver="0.3.2")

    # --- B / T / Y: custom profiles with versioned bindings / target / type profiles ----
    def probe_sd(name, mutate):
        sd = copy.deepcopy(core)
        for k in ("text", "extension", "mapping", "meta"):
            sd.pop(k, None)
        sd.update({
            "id": name, "url": PROBE + name, "version": "0.1.0", "name": name.replace("-", ""),
            "title": name, "status": "draft", "derivation": "constraint", "abstract": False,
            "baseDefinition": "http://hl7.org/fhir/StructureDefinition/Patient",
        })
        diff = []
        for el in sd["snapshot"]["element"]:
            m = mutate(el)
            if m:
                diff.append(m)
        sd["differential"] = {"element": [{"id": "Patient", "path": "Patient"}] + diff}
        return sd

    def binding(vs):
        def m(el):
            if el["id"] == "Patient.maritalStatus":
                el["binding"] = {"strength": "required", "valueSet": vs}
                return {"id": el["id"], "path": el["path"], "binding": el["binding"]}
        return m

    def target(profiles):
        def m(el):
            if el["id"] == "Patient.generalPractitioner":
                el["type"] = [{"code": "Reference", "targetProfile": profiles}]
                return {"id": el["id"], "path": el["path"], "type": el["type"]}
        return m

    def typeprof(profile):
        def m(el):
            if el["id"] == "Patient.identifier":
                el["type"] = [{"code": "Identifier", "profile": [profile]}]
                return {"id": el["id"], "path": el["path"], "type": el["type"]}
        return m

    base_res = {"resourceType": "Patient", "active": True, "name": [{"family": "Chen", "given": ["Ling"]}], "gender": "female"}

    def probe_res(name, extra):
        r = copy.deepcopy(base_res)
        r["id"] = name.lower()
        r["meta"] = {"profile": [PROBE + name]}
        r.update(copy.deepcopy(extra))
        return r

    marital_ni = {"maritalStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v3-NullFlavor", "code": "NI"}]}}
    for name, vs, expect in [
        ("B-vs-unver", "http://hl7.org/fhir/ValueSet/marital-status", "invalid"),
        ("B-vs-v4.0.1", "http://hl7.org/fhir/ValueSet/marital-status|4.0.1", "invalid"),
        ("B-vs-v4.0", "http://hl7.org/fhir/ValueSet/marital-status|4.0", "invalid"),
        ("B-vs-v9.9.9", "http://hl7.org/fhir/ValueSet/marital-status|9.9.9", "valid"),
    ]:
        sd = probe_sd(name, binding(vs))
        add(name, TW, probe_res(name, marital_ni), expect, overlay=[sd], note=f"required binding {vs}; NullFlavor#NI is not in marital-status")
    gp = {"contained": [{"resourceType": "Practitioner", "id": "pr1", "name": [{"family": "Lin"}]}], "generalPractitioner": [{"reference": "#pr1"}]}
    for name, profs, expect in [
        ("T-tp-v4.0.1", ["http://hl7.org/fhir/StructureDefinition/Practitioner|4.0.1"], "valid"),
        ("T-tp-v9.9.9", ["http://hl7.org/fhir/StructureDefinition/Practitioner|9.9.9"], "invalid"),
        ("T-tp-twv0.3.2", ["https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Practitioner-twcore|0.3.2"], "invalid"),
        ("T-tp-mixed", ["http://hl7.org/fhir/StructureDefinition/Practitioner|9.9.9", "http://hl7.org/fhir/StructureDefinition/Practitioner"], "invalid"),
    ]:
        sd = probe_sd(name, target(profs))
        add(name, TW, probe_res(name, gp), expect, overlay=[sd], note=f"targetProfile {profs}")
    ident = {"identifier": [{"system": "http://www.moi.gov.tw", "value": "A123456789"}]}
    for name, prof, expect in [
        ("Y-type-v4.0.1", "http://hl7.org/fhir/StructureDefinition/Identifier|4.0.1", "valid"),
        ("Y-type-v9.9.9", "http://hl7.org/fhir/StructureDefinition/Identifier|9.9.9", "invalid"),
    ]:
        sd = probe_sd(name, typeprof(prof))
        add(name, TW, probe_res(name, ident), expect, overlay=[sd], note=f"type profile {prof}")

    json.dump(out, open(sys.argv[3], "w"), ensure_ascii=False, indent=1)
    print(len(out), "items")


if __name__ == "__main__":
    main()

"""(v13) ValueSet canonical as Coding.system in different contexts (TW Core 1.0.0): CodeableConcept
coding with the binding's own ValueSet / an included one / an unrelated one, the same in another
element, a second coding, no meta.profile, directly bound Codings (ImagingStudy.series.modality,
Encounter.class), a Coding-slice-bound ValueSet (MedicationRequest), Bundles (first / second use).

usage: gen_v13.py corpus/examples.json.gz v13_probes.json
validator_cli verdicts depend on what the run loaded before: warm the oracle one item per JVM
(REPORT.md §v13) and, for the batch behaviour, all items in one run."""
import copy, gzip, json, sys
CORPUS = sys.argv[1]
ex = {x["key"]: x for x in json.load(gzip.open(CORPUS)) if x["pkg"] == "tw.gov.mohw.twcore"}
TW = "tw.gov.mohw.twcore"; B = "https://twcore.mohw.gov.tw/ig/twcore/"
LAB = B + "ValueSet/laboratory-code-tw"
obs = ex["Observation/obs-loinc-example"]["res"]; img = ex["ImagingStudy/img-ct-example"]["res"]
enc = ex["Encounter/enc-example"]["res"]; mr = ex["MedicationRequest/med-req-cod-example"]["res"]
pat = ex["Patient/pat-example"]["res"]
out = []
def add(key, r): out.append({"pkg": TW, "key": key, "res": r})
def o(coding_list, **kw):
    r = copy.deepcopy(obs); r.pop("text", None); r["code"] = {"coding": coding_list}; r.update(kw); return r
add("L1-lab-vs-real", o([{"system": LAB, "code": "2160-0"}]))
add("L2-lab-vs-fake", o([{"system": LAB, "code": "WBC"}]))
add("L3-included-vs", o([{"system": B + "ValueSet/loinc-observation-code", "code": "2160-0"}]))
add("L4-category-vs", o([{"system": B + "ValueSet/laboratory-category-tw", "code": "06001C"}]))
add("L5-unrelated-vs", o([{"system": B + "ValueSet/medication-path-tw", "code": "PO"}]))
r = copy.deepcopy(obs); r.pop("text", None); r["method"] = {"coding": [{"system": LAB, "code": "2160-0"}]}; add("L6-method-lab-vs", r)
r = o([{"system": LAB, "code": "2160-0"}]); r.pop("meta"); add("L7-noprofile-lab-vs", r)
add("L8-two-codings", o([{"system": "http://loinc.org", "code": "2160-0"}, {"system": LAB, "code": "2160-0"}]))
add("L9-lab-vs-nhi-code", o([{"system": LAB, "code": "06001C"}]))
add("L10-lab-vs-text", o([{"system": LAB, "code": "hs-Troponin I"}]))
def im(sysurl, code):
    r = copy.deepcopy(img); r.pop("text", None); r["series"][0]["modality"] = {"system": sysurl, "code": code}; return r
add("E1-modality-bound-vs", im(B + "ValueSet/AcquisitionModality", "CT"))
add("E2-modality-other-vs", im(LAB, "CT"))
r = copy.deepcopy(enc); r.pop("text", None); r["class"] = {"system": "http://terminology.hl7.org/ValueSet/v3-ActEncounterCode", "code": "PRENC"}; add("E3-class-hl7-vs", r)
r = copy.deepcopy(enc); r.pop("text", None); r["class"] = {"system": LAB, "code": "2160-0"}; add("E4-class-lab-vs", r)
r = copy.deepcopy(mr); r.pop("text", None); r["medicationCodeableConcept"] = {"text": "x", "coding": [{"system": B + "ValueSet/medication-nhi-tw", "code": "A000015421"}]}; add("M1-med-nhi-vs", r)
p = copy.deepcopy(pat); p.pop("text", None)
ob = o([{"system": LAB, "code": "2160-0"}], subject={"reference": "urn:uuid:7f3a1a2e-0d5c-4b8a-9a43-1d0c2b6f0001"}); ob.pop("performer", None)
add("B1-bundle-lab-vs", {"resourceType": "Bundle", "type": "collection", "entry": [
    {"fullUrl": "urn:uuid:7f3a1a2e-0d5c-4b8a-9a43-1d0c2b6f0001", "resource": p},
    {"fullUrl": "urn:uuid:7f3a1a2e-0d5c-4b8a-9a43-1d0c2b6f0002", "resource": ob}]})
# second pass (appended): bundles with two lab-vs observations, and a binding-first ordering
ob2 = copy.deepcopy(ob); ob2["code"] = {"coding": [{"system": LAB, "code": "WBC"}]}
out2 = [x for x in out]
out2.append({"pkg": TW, "key": "B2-bundle-two-lab-vs", "res": {"resourceType": "Bundle", "type": "collection", "entry": [
    {"fullUrl": "urn:uuid:7f3a1a2e-0d5c-4b8a-9a43-1d0c2b6f0001", "resource": p},
    {"fullUrl": "urn:uuid:7f3a1a2e-0d5c-4b8a-9a43-1d0c2b6f0002", "resource": ob},
    {"fullUrl": "urn:uuid:7f3a1a2e-0d5c-4b8a-9a43-1d0c2b6f0003", "resource": ob2}]}})
obok = copy.deepcopy(ob); obok["code"] = {"coding": [{"system": "http://loinc.org", "code": "2160-0"}]}
out2.append({"pkg": TW, "key": "B3-bundle-ok-then-lab-vs", "res": {"resourceType": "Bundle", "type": "collection", "entry": [
    {"fullUrl": "urn:uuid:7f3a1a2e-0d5c-4b8a-9a43-1d0c2b6f0001", "resource": p},
    {"fullUrl": "urn:uuid:7f3a1a2e-0d5c-4b8a-9a43-1d0c2b6f0004", "resource": obok},
    {"fullUrl": "urn:uuid:7f3a1a2e-0d5c-4b8a-9a43-1d0c2b6f0003", "resource": ob2}]}})
json.dump(out2, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
print(len(out2))

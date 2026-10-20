"""(v8) Probes for the evaluation report v6 false negatives (all synthetic, built
from the TW Core 1.0.0 package examples; mostly Bundles, as the evaluation
validates LLM-produced bundles with fhir_validate_bundle):

  A-*  an unresolvable HL7-space CodeSystem URL (…/CodeSystem/v3-ActEncounterCode)
       on every element kind and context: Encounter.class (Coding), CodeableConcepts
       (Encounter.type, Condition.category, Observation.category slice), extension
       values, contained resources, classHistory, Identifier.type, Meta.tag,
       Quantity.system, `|version`, no meta.profile, R5 array shape, nested bundle
  P-*  http://hl7.org/fhir/sid/icd-10-pcs as Coding.system (not a SIDUtilities
       system, not served by tx.fhir.org)
  C-*  Observation.category written as an (unknown) extension / wrong system on a
       laboratory-result Observation (slice `category:twcore` then missing)
  U-*  Unrecognized property in LLM-typical places
  D-*  invalid resource ids
  F-*  references containing whitespace
  X-*  `variable` extension (var-1) inside bundles
  R-*  RxNorm displays: another drug, a synonym, a Chinese name, the right name
  S-*  bundle entries without a usable resource (array / missing / no resourceType)
  V-*  valid controls

usage: gen_v8.py examples.json.gz out.json
"""
import copy, json, sys

src = sys.argv[1]
import gzip
ex = {x["key"]: x for x in json.load(gzip.open(src) if src.endswith(".gz") else open(src))}
TW = "tw.gov.mohw.twcore"
TWEXT = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/"
BAD_CS = "http://terminology.hl7.org/CodeSystem/v3-ActEncounterCode"
ACT = "http://terminology.hl7.org/CodeSystem/v3-ActCode"
PCS = "http://hl7.org/fhir/sid/icd-10-pcs"
RX = "http://www.nlm.nih.gov/research/umls/rxnorm"
VAR = "http://hl7.org/fhir/StructureDefinition/variable"
out = []


def base(key):
    return copy.deepcopy(ex[key]["res"])


def bundle(resources, btype="collection", fullurl=True):
    b = {"resourceType": "Bundle", "id": "b1", "type": btype, "entry": []}
    for r in resources:
        ent = {"resource": r}
        if fullurl:
            ent["fullUrl"] = f"https://example.tw/fhir/{r['resourceType']}/{r['id']}"
        if btype == "transaction":
            ent["request"] = {"method": "PUT", "url": f"{r['resourceType']}/{r['id']}"}
        b["entry"].append(ent)
    return b


def add(key, res, tool="bundle", expect="invalid", **kw):
    item = {"pkg": TW, "key": "v8/" + key, "res": res, "expect": expect}
    if tool:
        item["tool"] = tool
    item.update(kw)
    out.append(item)


pat = base("Patient/pat-example")
enc = base("Encounter/enc-example")
con = base("Condition/con-example")
lab = base("Observation/obs-lab-example")
pro = base("Procedure/pro-example")
med = base("MedicationRequest/med-req-cod-example")
obs = base("Observation/obs-simple-example")


def with_class(system=BAD_CS, **kw):
    e = base("Encounter/enc-example")
    e["class"] = {"system": system, "code": "AMB", "display": "ambulatory"}
    e.update(kw)
    return e


# ---- A: unresolvable THO CodeSystem URL, every element kind / context ----------------
add("A-class-collection", bundle([pat, with_class()]))
add("A-class-transaction", bundle([pat, with_class()], "transaction"))
e = with_class(); e.pop("meta"); add("A-class-no-meta-profile", bundle([pat, e]))
e = base("Encounter/enc-example"); e["type"] = [{"coding": [{"system": BAD_CS, "code": "AMB"}]}]; add("A-type-cc", bundle([pat, e]))
c = base("Condition/con-example"); c["category"] = [{"coding": [{"system": BAD_CS, "code": "AMB"}]}]; add("A-condition-category", bundle([pat, c]))
o = base("Observation/obs-lab-example"); o["category"] = [{"coding": [{"system": BAD_CS, "code": "laboratory"}]}]; add("A-obs-category-slice", bundle([pat, o]))
e = base("Encounter/enc-example"); e["extension"] = [{"url": "http://example.tw/fhir/StructureDefinition/x", "valueCoding": {"system": BAD_CS, "code": "AMB"}}]; add("A-extension-valueCoding", bundle([pat, e]))
e = base("Encounter/enc-example"); e["extension"] = [{"url": "http://example.tw/fhir/StructureDefinition/x", "valueCodeableConcept": {"coding": [{"system": BAD_CS, "code": "AMB"}]}}]; add("A-extension-valueCC", bundle([pat, e]))
o = base("Observation/obs-simple-example"); inner = with_class(); inner["id"] = "ce"; o["contained"] = [inner]; o["encounter"] = {"reference": "#ce"}; add("A-contained-encounter", bundle([pat, o]))
e = base("Encounter/enc-example"); e["classHistory"] = [{"class": {"system": BAD_CS, "code": "AMB"}, "period": {"start": "2024-01-01"}}]; add("A-classHistory", bundle([pat, e]))
p = base("Patient/pat-example"); p["identifier"][0]["type"] = {"coding": [{"system": BAD_CS, "code": "MR"}]}; add("A-identifier-type", bundle([p, enc]))
e = base("Encounter/enc-example"); e["meta"]["tag"] = [{"system": BAD_CS, "code": "AMB"}]; add("A-meta-tag", bundle([pat, e]))
o = base("Observation/obs-simple-example"); o["valueQuantity"] = {"value": 1, "unit": "x", "system": BAD_CS, "code": "AMB"}; add("A-quantity-system", bundle([pat, o]))
add("A-class-versioned-system", bundle([pat, with_class(BAD_CS + "|2.0.0")]))
e = base("Encounter/enc-example"); e["class"] = [{"system": BAD_CS, "code": "AMB"}]; add("A-class-r5-array", bundle([pat, e]))
add("A-nested-bundle", bundle([pat, bundle([with_class()])]))
add("A-class-resource-tool", with_class(), tool=None)
add("A-class-document-like-first", bundle([with_class(), pat, con]))

# ---- P: http://hl7.org/fhir/sid/icd-10-pcs ------------------------------------------
p1 = base("Procedure/pro-example"); p1["code"] = {"coding": [{"system": PCS, "code": "0DTJ4ZZ", "display": "Resection of Appendix, Percutaneous Endoscopic Approach"}]}; add("P-procedure-code", bundle([pat, p1]))
p2 = base("Procedure/pro-example"); p2["code"] = {"coding": [{"system": PCS, "code": "0DTJ4ZZ"}]}; add("P-procedure-nodisplay-resource", p2, tool=None)
c = base("Condition/con-example"); c["code"] = {"coding": [{"system": PCS, "code": "0DTJ4ZZ"}]}; add("P-condition-code", bundle([pat, c]))
e = base("Encounter/enc-example"); e["extension"] = [{"url": "http://example.tw/fhir/StructureDefinition/x", "valueCodeableConcept": {"coding": [{"system": PCS, "code": "0DTJ4ZZ"}]}}]; add("P-extension-valueCC", bundle([pat, e]))
p3 = base("Procedure/pro-example"); p3["code"] = {"coding": [{"system": "http://snomed.info/sct", "code": "80146002"}, {"system": PCS, "code": "0DTJ4ZZ"}]}; add("P-second-coding", bundle([pat, p3], "transaction"))

# ---- C: Observation.category as an extension / wrong system (lab result) -------------
o = base("Observation/obs-lab-example"); o["category"] = [{"extension": [{"url": TWEXT + "extension-observation-category-tw", "valueCodeableConcept": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "laboratory"}]}}]}]; add("C-category-as-extension", bundle([pat, o]))
o = base("Observation/obs-lab-example"); o["category"] = [{"coding": [{"system": TWEXT.replace("StructureDefinition", "CodeSystem") + "extension-observation-category-tw", "code": "laboratory"}]}]; add("C-category-twcore-cs-url", bundle([pat, o]))
o = base("Observation/obs-lab-example"); o["extension"] = [{"url": TWEXT + "extension-observation-category-tw", "valueCode": "laboratory"}]; o.pop("category", None); add("C-category-extension-on-resource", bundle([pat, o]))

# ---- U: Unrecognized property ---------------------------------------------------------
e = base("Encounter/enc-example"); e["class"] = {"coding": [{"system": ACT, "code": "AMB"}]}; add("U-class-cc-shaped", bundle([pat, e]))
m = base("MedicationRequest/med-req-cod-example"); m.setdefault("dosageInstruction", [{}])[0]["timing"] = {"repeat": {"frequency": 1, "period": 1, "periodUnits": "d"}}; add("U-periodUnits", bundle([pat, m]))
o = base("Observation/obs-simple-example"); o["valueQuantity"] = {"value": 1, "units": "mg"}; add("U-quantity-units", bundle([pat, o]))
p = base("Patient/pat-example"); p["gender"] = "male"; p["birthdate"] = "1990-01-01"; add("U-patient-birthdate-lower", bundle([p, enc]))

# ---- D: invalid resource ids ---------------------------------------------------------
e = base("Encounter/enc-example"); e["id"] = "enc_001"; add("D-id-underscore", bundle([pat, e]))
p = base("Patient/pat-example"); p["id"] = "p" * 70; add("D-id-too-long", bundle([p, enc]))
e = base("Encounter/enc-example"); e["id"] = "enc 001"; add("D-id-space-resource", e, tool=None)

# ---- F: references with whitespace ----------------------------------------------------
e = base("Encounter/enc-example"); e["subject"] = {"reference": "Patient/ pat-example"}; add("F-ref-inner-space", bundle([pat, e]))
c = base("Condition/con-example"); c["subject"] = {"reference": "Patient/pat-example "}; add("F-ref-trailing-space", bundle([pat, c]))

# ---- X: variable extension (var-1) in bundles -----------------------------------------
o = base("Observation/obs-simple-example"); o["extension"] = [{"url": VAR, "valueExpression": {"language": "text/fhirpath", "expression": "1 + 1"}}]; add("X-var-unnamed-obs-bundle", bundle([pat, o], "transaction"))
e = base("Encounter/enc-example"); e["extension"] = [{"url": VAR, "valueExpression": {"name": "n", "language": "text/fhirpath", "expression": "1"}}]; add("X-var-named-on-encounter-bundle", bundle([pat, e]))

# ---- R: RxNorm displays ----------------------------------------------------------------
def medreq(code, disp):
    m = base("MedicationRequest/med-req-cod-example")
    coding = {"system": RX, "code": code}
    if disp is not None:
        coding["display"] = disp
    m["medicationCodeableConcept"].setdefault("coding", []).append(coding)
    return m
add("R-other-drug-bundle", bundle([pat, medreq("313375", "Clopidogrel 75 MG Oral Tablet")]))
add("R-other-drug-resource", medreq("313375", "Clopidogrel 75 MG Oral Tablet"), tool=None)
add("R-synonym-display", bundle([pat, medreq("313375", "Thyroglobulin 100 mg tablet")]))
add("R-cjk-display", bundle([pat, medreq("309362", "保栓通膜衣錠75毫克")]))
add("R-right-display", bundle([pat, medreq("309362", "clopidogrel 75 MG Oral Tablet")]), expect="valid")

# ---- S: bundle entries without a usable resource ---------------------------------------
b = bundle([pat, with_class()]); b["entry"][1]["resource"] = [b["entry"][1]["resource"]]; add("S-resource-array", b)
b = bundle([pat, enc]); b["entry"].insert(1, {"fullUrl": "https://example.tw/fhir/Encounter/x", "resource": {"id": "x", "status": "finished"}}); add("S-resource-no-type", b)
b = bundle([pat, with_class()]); b["entry"].insert(0, {"fullUrl": "https://example.tw/fhir/Patient/zz"}); add("S-entry-no-resource", b)

# ---- V: valid controls ---------------------------------------------------------------
# (enc-example carries an example.org identifier system, an error for the CLI and for us: dropped here)
enc_ok = base("Encounter/enc-example"); enc_ok.pop("identifier", None)
add("V-plain", bundle([pat, enc_ok, con]), expect="valid")
add("V-transaction", bundle([pat, enc_ok, lab, pro], "transaction"), expect="valid")
e = copy.deepcopy(enc_ok); e["type"] = [{"coding": [{"system": ACT, "code": "AMB"}]}]; add("V-type-actcode", bundle([pat, e]), expect="valid")

json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
print(len(out), "items")

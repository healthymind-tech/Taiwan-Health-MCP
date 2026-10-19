"""(v7) Probes for the evaluation report v5 false negatives (all synthetic, built
from the TW Core 1.0.0 package examples):

  X-*  extension context (StructureDefinition.context: element / extension types,
       contextInvariant) and the extension's own invariants (var-1), incl. which
       copy of a core-URL extension is used (R4 core vs hl7.fhir.uv.extensions.r4)
  U-*  "Unrecognized property" below datatypes, also where the profile walk stops
       (type not allowed by the profile, array for a single element, 2nd choice value)
  A-*  Coding.system URLs in the HL7 space that do not resolve (v3-ActEncounterCode)
  I-*  code existence in IG CodeSystems (TW Core icd-10-cm-2023-tw, content complete)
  R-*  RxNorm code existence / display (tx.fhir.org)

usage: gen_v7.py examples.json.gz out.json
"""
import copy, gzip, json, sys

src = sys.argv[1]
ex = {x["key"]: x for x in json.load(gzip.open(src) if src.endswith(".gz") else open(src))}
TW = "tw.gov.mohw.twcore"
out = []


def base(key):
    r = copy.deepcopy(ex[key]["res"])
    return r


def add(key, res, tool=None, pkg=TW, **kw):
    item = {"pkg": pkg, "key": "v7/" + key, "res": res}
    if tool:
        item["tool"] = tool
    item.update(kw)
    out.append(item)


VAR = "http://hl7.org/fhir/StructureDefinition/variable"
BIRTHPLACE = "http://hl7.org/fhir/StructureDefinition/patient-birthPlace"
TWEXT = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/"
var_named = {"url": VAR, "valueExpression": {"name": "score", "language": "text/fhirpath", "expression": "1 + 1"}}
var_unnamed = {"url": VAR, "valueExpression": {"language": "text/fhirpath", "expression": "1 + 1"}}
NARR = {"status": "generated", "div": "<div xmlns=\"http://www.w3.org/1999/xhtml\">x</div>"}


def questionnaire(item_type="string", root_ext=None, item_ext=None):
    q = {"resourceType": "Questionnaire", "id": "q1", "text": NARR, "status": "active",
         "item": [{"linkId": "1", "text": "x", "type": item_type}]}
    if root_ext:
        q["extension"] = root_ext
    if item_ext:
        q["item"][0]["extension"] = item_ext
    return q


# ---- X: extension context ---------------------------------------------------------
o = base("Observation/obs-simple-example"); o["extension"] = [var_named]; add("X-var-on-observation", o)
o = base("Observation/obs-simple-example"); o["extension"] = [var_unnamed]; add("X-var-unnamed-on-observation", o)
add("X-var-unnamed-on-questionnaire", questionnaire(root_ext=[var_unnamed]))
add("X-var-named-on-questionnaire", questionnaire(root_ext=[var_named]))
add("X-var-named-on-q-item", questionnaire(item_ext=[var_named]))
add("X-var-named-on-q-item-item", {**questionnaire(), "item": [{"linkId": "1", "text": "g", "type": "group", "item": [{"linkId": "1.1", "text": "x", "type": "string", "extension": [var_named]}]}]})
add("X-var-named-on-q-item-text", {**questionnaire(), "item": [{"linkId": "1", "text": "x", "_text": {"extension": [var_named]}, "type": "string"}]})
p = base("Patient/pat-example"); p["name"][0]["extension"] = [{"url": BIRTHPLACE, "valueAddress": {"city": "Taipei"}}]; add("X-birthplace-on-humanname", p)
p = base("Patient/pat-example"); p.setdefault("extension", []).append({"url": BIRTHPLACE, "valueAddress": {"city": "Taipei"}}); add("X-birthplace-on-patient", p)
o = base("Observation/obs-simple-example"); o["extension"] = [{"url": BIRTHPLACE, "valueAddress": {"city": "Taipei"}}]; add("X-birthplace-on-observation", o)
p = base("Patient/pat-example"); p["name"][0]["extension"] = [{"url": TWEXT + "tw-village", "valueString": "大有里"}]; add("X-twvillage-on-humanname", p)
p = base("Patient/pat-example"); p.setdefault("extension", []).append({"url": TWEXT + "person-age", "valueAge": {"value": 30, "unit": "a", "system": "http://unitsofmeasure.org", "code": "a"}}); add("X-personage-on-patient", p)
o = base("Observation/obs-simple-example"); o["extension"] = [{"url": TWEXT + "person-age", "valueAge": {"value": 30, "unit": "a", "system": "http://unitsofmeasure.org", "code": "a"}}]; add("X-personage-on-observation", o)
o = base("Observation/obs-simple-example"); o["code"]["coding"][0]["extension"] = [{"url": TWEXT + "person-age", "valueAge": {"value": 30, "unit": "a", "system": "http://unitsofmeasure.org", "code": "a"}}]; add("X-personage-on-coding", o)
p = base("Patient/pat-example"); p["_birthDate"] = {"extension": [{"url": "http://hl7.org/fhir/StructureDefinition/data-absent-reason", "valueCode": "unknown"}]}; p.pop("birthDate", None); add("X-dar-on-birthdate", p)
p = base("Patient/pat-example"); p["_gender"] = {"extension": [{"url": TWEXT + "tw-village", "valueString": "x"}]}; add("X-twvillage-on-gender", p)
add("X-qunit-on-string-item", questionnaire("string", item_ext=[{"url": "http://hl7.org/fhir/StructureDefinition/questionnaire-unit", "valueCoding": {"system": "http://unitsofmeasure.org", "code": "kg"}}]))
add("X-qunit-on-decimal-item", questionnaire("decimal", item_ext=[{"url": "http://hl7.org/fhir/StructureDefinition/questionnaire-unit", "valueCoding": {"system": "http://unitsofmeasure.org", "code": "kg"}}]))
o = base("Observation/obs-simple-example"); o["extension"] = [{"url": "http://hl7.org/fhir/StructureDefinition/artifact-title", "valueString": "t"}]; add("X-resource-context-on-observation", o)
o = base("Observation/obs-simple-example"); o["code"]["extension"] = [{"url": "http://hl7.org/fhir/StructureDefinition/artifact-title", "valueString": "t"}]; add("X-resource-context-on-cc", o)
o = base("Observation/obs-simple-example"); o["extension"] = [var_named]
add("X-var-in-bundle", {"resourceType": "Bundle", "id": "b1", "type": "collection", "entry": [{"fullUrl": "https://example.tw/fhir/Observation/obs-simple-example", "resource": o}]}, tool="bundle")

# ---- U: unrecognized properties -----------------------------------------------------
c = base("Condition/con-example"); c["code"]["coding"][0]["slice"] = "icd"; add("U-slice-condition-code", c)
o = base("Observation/obs-weight-example"); o.pop("valueQuantity"); o["valueCodeableConcept"] = {"coding": [{"system": "http://loinc.org", "code": "29463-7", "slice": "x"}]}; add("U-slice-disallowed-choice-type", o)
c = base("Condition/con-example"); c["code"] = [{"coding": [{"system": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-cm-2021-tw", "code": "E08.649", "slice": "x"}]}]; add("U-slice-array-for-single", c)
o = base("Observation/obs-simple-example"); o["valueQuantity"] = {"value": 1, "slice": "x"}; add("U-slice-second-choice", o)
e = base("Encounter/enc-example"); e["class"] = [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": "AMB", "slice": "x"}]}]; add("U-encounter-class-array", e)
o = base("Observation/obs-simple-example"); o["code"]["coding"][0]["_code"] = {"slice": "x"}; add("U-slice-in-primitive-ext", o)
o = base("Observation/obs-simple-example"); o["extension"] = [{"url": "http://example.org/fhir/StructureDefinition/unknown", "valueCodeableConcept": {"coding": [{"code": "a", "slice": "x"}]}}]; add("U-slice-in-unknown-extension", o)
o = base("Observation/obs-simple-example"); o["status"] = {"slice": "x"}; add("U-object-for-primitive", o)
o = base("Observation/obs-simple-example"); o["code"]["coding"][0]["slice"] = "x"
add("U-slice-in-bundle-entry", {"resourceType": "Bundle", "id": "b2", "type": "collection", "entry": [{"fullUrl": "https://example.tw/fhir/Observation/obs-simple-example", "resource": o}]}, tool="bundle")

# ---- A: HL7-space URL resolution ---------------------------------------------------
for sysurl, tag in (("http://terminology.hl7.org/CodeSystem/v3-ActEncounterCode", "cs"), ("http://terminology.hl7.org/ValueSet/v3-ActEncounterCode", "vs")):
    e = base("Encounter/enc-example"); e["class"] = {"system": sysurl, "code": "AMB"}; add(f"A-class-{tag}", e)
    e = base("Encounter/enc-example"); e["class"] = [{"coding": [{"system": sysurl, "code": "AMB"}]}]; add(f"A-class-array-{tag}", e)
    e = base("Encounter/enc-example"); e["type"] = [{"coding": [{"system": sysurl, "code": "AMB"}]}]; add(f"A-type-{tag}", e)
    e = base("Encounter/enc-example"); e["class"] = {"system": sysurl, "code": "AMB"}
    add(f"A-class-in-bundle-{tag}", {"resourceType": "Bundle", "id": "b3", "type": "collection", "entry": [{"fullUrl": "https://example.tw/fhir/Encounter/enc-example", "resource": e}]}, tool="bundle")

# ---- I: IG CodeSystem code existence -----------------------------------------------
ICD23 = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-cm-2023-tw"
c = base("Condition/con-example"); c["code"] = {"coding": [{"system": ICD23, "code": "I13.0", "display": "Hypertensive heart and chronic kidney disease with heart failure"}]}; add("I-icd2023-unknown", c)
c = base("Condition/con-example"); c["code"] = {"coding": [{"system": ICD23, "code": "I13.0"}]}; add("I-icd2023-unknown-nodisplay", c)
c = base("Condition/con-example"); c["code"] = {"coding": [{"system": ICD23, "code": "I13.0", "slice": "x"}]}; add("I-icd2023-unknown-plus-slice", c)
c = base("Condition/con-example"); c["code"] = [{"coding": [{"system": ICD23, "code": "I13.0"}]}]; add("I-icd2023-unknown-array", c)

# ---- R: RxNorm -----------------------------------------------------------------------
RX = "http://www.nlm.nih.gov/research/umls/rxnorm"
for tag, code, disp in (("wrong-display", "313375", "Clopidogrel 75 MG Oral Tablet"), ("case-only", "309362", "CLOPIDOGREL 75 MG ORAL TABLET"),
                        ("psn-atom", "213169", "Plavix 75 MG Oral Tablet"), ("unknown", "99999999", "x"), ("no-display", "313375", None),
                        ("sy-atom", "213169", "Plavix 75 MG (clopidogrel bisulfate 97.875 MG) Oral Tablet")):
    m = base("MedicationRequest/med-req-cod-example")
    coding = {"system": RX, "code": code}
    if disp:
        coding["display"] = disp
    m["medicationCodeableConcept"].setdefault("coding", []).append(coding)
    add(f"R-{tag}", m)

json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
print(len(out), "items")

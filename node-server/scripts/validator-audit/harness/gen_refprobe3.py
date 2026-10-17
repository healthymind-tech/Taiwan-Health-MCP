import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_refprobe_lib import *
P = {}
resp = lambda e: dict(e, response={"status": "201 Created"})
P["tr_nofull"] = bundle("transaction-response", [resp({"resource": pat()})])
P["br_nofull"] = bundle("batch-response", [resp({"resource": pat()})])
P["b_nofull"] = bundle("batch", [tx({"resource": pat()})])
P["h_nofull"] = bundle("history", [dict({"resource": pat()}, request={"method": "PUT", "url": "Patient/p1"}, response={"status": "200"})])
P["t_nofull_tworefs"] = bundle("transaction", [tx({"resource": pat()}), tx({"resource": obs("Patient/zz", extra={"performer": [{"reference": "Practitioner/x"}], "specimen": {"reference": U(5)}})})])
P["t_nofull_contained_only"] = bundle("transaction", [tx({"resource": obs("#p", extra={"contained": [pat("p")]})})])
# relative ref with abs fullUrl but resolving to a TW Core Patient profile violation -> does HL7 check target profile?
twobs = obs("Patient/p1", extra={"meta": {"profile": ["https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Observation-laboratoryResult-twcore"]}})
P["c_rel_target_check_abs"] = bundle("collection", [{"fullUrl": "http://ex.org/fhir/Patient/p1", "resource": org("p1") | {"resourceType": "Patient"}}, {"fullUrl": "http://ex.org/fhir/Observation/ob1", "resource": obs("Patient/p1", extra={"specimen": {"reference": "Patient/p1"}})}])
P["c_rel_target_check_urn"] = bundle("collection", [{"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(2), "resource": obs("Patient/p1", extra={"specimen": {"reference": "Patient/p1"}})}])
out = [{"pkg": "tw.gov.mohw.twcore", "key": "RefProbe3/" + k, "res": v, "tool": "bundle"} for k, v in P.items()]
json.dump(out, open(sys.argv[1], "w"), indent=1)

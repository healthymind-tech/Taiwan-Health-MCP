import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_refprobe_lib import *
P = {}
P["c_nofull_norefs"] = bundle("collection", [{"resource": pat()}, {"resource": org()}])
P["t_nofull"] = bundle("transaction", [tx({"resource": pat()}), tx({"resource": obs("Patient/zz")})])
P["s_nofull"] = bundle("searchset", [{"resource": pat()}])
P["c_nofull_relref"] = bundle("collection", [{"fullUrl": "http://ex.org/fhir/Patient/p1", "resource": pat()}, {"resource": obs("Patient/p1")}])
def comp2(**kw):
    c = {"resourceType": "Composition", "id": "c1", "text": TXT, "status": "final", "type": {"text": "x"},
         "subject": {"reference": U(1)}, "date": "2024-01-01", "author": [{"reference": U(1)}], "title": "t"}
    c.update(kw); return c
P["d_author_dangling"] = bundle("document", [{"fullUrl": U(3), "resource": comp2(author=[{"reference": U(9)}])}, {"fullUrl": U(1), "resource": pat()}])
P["d_encounter_dangling"] = bundle("document", [{"fullUrl": U(3), "resource": comp2(encounter={"reference": U(9)})}, {"fullUrl": U(1), "resource": pat()}])
P["d_custodian_dangling"] = bundle("document", [{"fullUrl": U(3), "resource": comp2(custodian={"reference": U(9)})}, {"fullUrl": U(1), "resource": pat()}])
P["d_attester_dangling"] = bundle("document", [{"fullUrl": U(3), "resource": comp2(attester=[{"mode": "legal", "party": {"reference": U(9)}}])}, {"fullUrl": U(1), "resource": pat()}])
P["d_section_entry_dangling"] = bundle("document", [{"fullUrl": U(3), "resource": comp2(section=[{"title": "s", "text": TXT, "entry": [{"reference": U(9)}]}])}, {"fullUrl": U(1), "resource": pat()}])
P["d_subsection_entry_dangling"] = bundle("document", [{"fullUrl": U(3), "resource": comp2(section=[{"title": "s", "text": TXT, "section": [{"title": "s2", "text": TXT, "entry": [{"reference": U(9)}]}]}])}, {"fullUrl": U(1), "resource": pat()}])
P["d_section_entry_ok"] = bundle("document", [{"fullUrl": U(3), "resource": comp2(section=[{"title": "s", "text": TXT, "entry": [{"reference": U(4)}]}])}, {"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(4), "resource": obs(U(1))}])
P["d_backlink_ok"] = bundle("document", [{"fullUrl": U(3), "resource": comp2()}, {"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(4), "resource": obs(U(1))}])
prov = {"resourceType": "Provenance", "id": "pv", "text": TXT, "target": [{"reference": U(3)}], "recorded": "2024-01-01T00:00:00Z", "agent": [{"who": {"reference": U(1)}}]}
P["d_provenance_ok"] = bundle("document", [{"fullUrl": U(3), "resource": comp2()}, {"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(5), "resource": prov}])
P["d_rel_typeid_urnfull"] = bundle("document", [{"fullUrl": U(3), "resource": comp2(subject={"reference": "Patient/p1"})}, {"fullUrl": U(1), "resource": pat()}])
P["d_rel_abs_full"] = bundle("document", [{"fullUrl": "http://ex.org/fhir/Composition/c1", "resource": comp2(subject={"reference": "Patient/p1"}, author=[{"reference": "Patient/p1"}])}, {"fullUrl": "http://ex.org/fhir/Patient/p1", "resource": pat()}])
P["d_versioned"] = bundle("document", [{"fullUrl": "http://ex.org/fhir/Composition/c1", "resource": comp2(subject={"reference": "Patient/p1/_history/2"}, author=[{"reference": "http://ex.org/fhir/Patient/p1"}])}, {"fullUrl": "http://ex.org/fhir/Patient/p1", "resource": pat()}])
P["d_two_orphans_linked"] = bundle("document", [{"fullUrl": U(3), "resource": comp2()}, {"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(4), "resource": obs(U(6))}, {"fullUrl": U(6), "resource": org("o6")}])
P["d_orphan_contained_ref"] = bundle("document", [{"fullUrl": U(3), "resource": comp2()}, {"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(4), "resource": obs("#p9", extra={"contained": [{"resourceType": "Patient", "id": "p9", "link": [{"other": {"reference": U(1)}, "type": "seealso"}]}]})}])
mh = {"resourceType": "MessageHeader", "id": "mh", "text": TXT, "eventCoding": {"system": "http://example.org/ev", "code": "x"}, "source": {"endpoint": "http://ex.org"}, "focus": [{"reference": U(1)}]}
P["m_orphan"] = bundle("message", [{"fullUrl": U(3), "resource": mh}, {"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(4), "resource": org("o4")}])
P["m_focus_dangling"] = bundle("message", [{"fullUrl": U(3), "resource": dict(mh, focus=[{"reference": U(9)}])}, {"fullUrl": U(1), "resource": pat()}])
P["c_orphan"] = bundle("collection", [{"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(4), "resource": org("o4")}])
P["c_dup_fullurl"] = bundle("collection", [{"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(1), "resource": pat("p2")}])
P["c_fullurl_id_mismatch"] = bundle("collection", [{"fullUrl": "http://ex.org/fhir/Patient/p9", "resource": pat()}])
out = [{"pkg": "tw.gov.mohw.twcore", "key": "RefProbe2/" + k, "res": v, "tool": "bundle"} for k, v in P.items()]
json.dump(out, open(sys.argv[1], "w"), indent=1)

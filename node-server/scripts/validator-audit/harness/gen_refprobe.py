"""Reference-resolution probe corpus (bundles + standalone)."""
import json, sys
TXT = {"status": "generated", "div": "<div xmlns=\"http://www.w3.org/1999/xhtml\">x</div>"}
U = lambda n: "urn:uuid:%08d-0000-4000-8000-000000000000" % n
def pat(i="p1"): return {"resourceType": "Patient", "id": i, "text": TXT, "name": [{"text": "A"}]}
def org(i="o1"): return {"resourceType": "Organization", "id": i, "text": TXT, "name": "Org"}
def obs(subj, i="ob1", extra=None):
    r = {"resourceType": "Observation", "id": i, "text": TXT, "status": "final",
         "code": {"text": "x"}, "subject": {"reference": subj}, "valueString": "v"}
    if extra: r.update(extra)
    return r
def bundle(t, entries, **kw):
    b = {"resourceType": "Bundle", "id": "b1", "type": t, "entry": entries}
    if t in ("document", "message"):
        b["identifier"] = {"system": "urn:ietf:rfc:3986", "value": U(999)}
        b["timestamp"] = "2024-01-01T00:00:00Z"
    b.update(kw); return b
def tx(e, method="POST", url=None):
    e = dict(e); e["request"] = {"method": method, "url": url or e["resource"]["resourceType"]}; return e
P = {}
# collection
P["c_urn_ok"] = bundle("collection", [{"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(2), "resource": obs(U(1))}])
P["c_urn_dangling"] = bundle("collection", [{"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(2), "resource": obs(U(7))}])
P["c_rel_ok_absfull"] = bundle("collection", [{"fullUrl": "http://ex.org/fhir/Patient/p1", "resource": pat()}, {"fullUrl": "http://ex.org/fhir/Observation/ob1", "resource": obs("Patient/p1")}])
P["c_rel_dangling_absfull"] = bundle("collection", [{"fullUrl": "http://ex.org/fhir/Patient/p1", "resource": pat()}, {"fullUrl": "http://ex.org/fhir/Observation/ob1", "resource": obs("Patient/zz")}])
P["c_abs_dangling"] = bundle("collection", [{"fullUrl": "http://ex.org/fhir/Patient/p1", "resource": pat()}, {"fullUrl": "http://ex.org/fhir/Observation/ob1", "resource": obs("http://other.org/fhir/Patient/zz")}])
P["c_versioned_ok"] = bundle("collection", [{"fullUrl": "http://ex.org/fhir/Patient/p1", "resource": pat()}, {"fullUrl": "http://ex.org/fhir/Observation/ob1", "resource": obs("Patient/p1/_history/1")}])
P["c_wrongtype_urn"] = bundle("collection", [{"fullUrl": U(1), "resource": org()}, {"fullUrl": U(2), "resource": obs(U(1), extra={"specimen": {"reference": U(1)}})}])
P["c_urn_dangling_nofull"] = bundle("collection", [{"resource": pat()}, {"resource": obs(U(7))}])
# transaction
P["t_urn_ok"] = bundle("transaction", [tx({"fullUrl": U(1), "resource": pat()}), tx({"fullUrl": U(2), "resource": obs(U(1))})])
P["t_urn_dangling"] = bundle("transaction", [tx({"fullUrl": U(1), "resource": pat()}), tx({"fullUrl": U(2), "resource": obs(U(7))})])
P["t_rel_dangling"] = bundle("transaction", [tx({"fullUrl": U(1), "resource": pat()}), tx({"fullUrl": U(2), "resource": obs("Patient/zz")})])
# document
comp = lambda subj: {"resourceType": "Composition", "id": "c1", "text": TXT, "status": "final", "type": {"text": "x"},
                     "subject": {"reference": subj}, "date": "2024-01-01", "author": [{"reference": U(1)}], "title": "t"}
P["d_ok"] = bundle("document", [{"fullUrl": U(3), "resource": comp(U(1))}, {"fullUrl": U(1), "resource": pat()}])
P["d_urn_dangling"] = bundle("document", [{"fullUrl": U(3), "resource": comp(U(7))}, {"fullUrl": U(1), "resource": pat()}])
P["d_rel_dangling"] = bundle("document", [{"fullUrl": "http://ex.org/fhir/Composition/c1", "resource": comp("Patient/zz")}, {"fullUrl": U(1), "resource": pat()}])
P["d_entry_dangling"] = bundle("document", [{"fullUrl": U(3), "resource": comp(U(1))}, {"fullUrl": U(1), "resource": pat()}, {"fullUrl": U(4), "resource": obs(U(8))}])
# contained
P["c_contained_ok"] = bundle("collection", [{"fullUrl": U(2), "resource": obs("#p", extra={"contained": [pat("p")]})}])
P["c_contained_missing"] = bundle("collection", [{"fullUrl": U(2), "resource": obs("#nope", extra={"contained": [pat("p")]})}])
out = [{"pkg": "tw.gov.mohw.twcore", "key": "RefProbe/" + k, "res": v, "tool": "bundle"} for k, v in P.items()]
# standalone
out.append({"pkg": "tw.gov.mohw.twcore", "key": "RefProbe/s_contained_missing", "res": obs("#nope", extra={"contained": [pat("p")]})})
out.append({"pkg": "tw.gov.mohw.twcore", "key": "RefProbe/s_urn_dangling", "res": obs(U(7))})
out.append({"pkg": "tw.gov.mohw.twcore", "key": "RefProbe/s_rel", "res": obs("Patient/zz")})
json.dump(out, open(sys.argv[1], "w"), indent=1)

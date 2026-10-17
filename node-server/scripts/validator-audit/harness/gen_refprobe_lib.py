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

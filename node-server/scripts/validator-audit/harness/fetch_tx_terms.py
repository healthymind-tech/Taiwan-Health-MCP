"""v4: fetch the CVX and WHO ICD-10 code systems exactly as tx.fhir.org serves them
(the terminology server validator_cli 7.0.1 uses), via $expand.

usage: fetch_tx_terms.py out_dir      -> out_dir/cvx.json, out_dir/icd10who.json

icd10who.json is a FHIR CodeSystem (content = complete, flat concept list with
the long-description designations): the file to upload as the optional ICD
source "WHO ICD-10 (FHIR JSON)" (role icd10_who) on the admin console.

CVX (287 codes) expands in one call. ICD-10 is larger than tx's 3000-code expansion
cap, so it is fetched per chapter (is-a filter, paged) and flattened. Sequential,
0.5 s between calls (be polite to tx.fhir.org).
"""
import json, os, sys, time, urllib.request

TX = "https://tx.fhir.org/r4/ValueSet/$expand"


def expand(include, offset=0, count=1000):
    body = {"resourceType": "Parameters", "parameter": [
        {"name": "valueSet", "resource": {"resourceType": "ValueSet", "status": "active", "compose": {"include": [include]}}},
        {"name": "count", "valueInteger": count}, {"name": "offset", "valueInteger": offset},
        {"name": "includeDesignations", "valueBoolean": True}, {"name": "activeOnly", "valueBoolean": False}]}
    req = urllib.request.Request(TX, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/fhir+json", "Accept": "application/fhir+json"})
    out = json.load(urllib.request.urlopen(req, timeout=300))
    time.sleep(0.5)
    return out


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    cvx = expand({"system": "http://hl7.org/fhir/sid/cvx"}, count=5000)
    json.dump(cvx, open(os.path.join(out_dir, "cvx.json"), "w"), ensure_ascii=False)
    flat, version = {}, None

    def walk(c):
        flat[c["code"]] = {k: v for k, v in c.items() if k != "contains"}
        for x in c.get("contains", []):
            walk(x)

    for ch in ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV",
               "XVI", "XVII", "XVIII", "XIX", "XX", "XXI", "XXII"]:
        off = 0
        while True:
            d = expand({"system": "http://hl7.org/fhir/sid/icd-10", "filter": [{"property": "concept", "op": "is-a", "value": ch}]}, off)
            e = d["expansion"]
            for p in e.get("parameter", []):
                if p["name"] == "used-codesystem":
                    version = p["valueUri"].split("|")[1]
            cs = e.get("contains", [])
            for c in cs:
                walk(c)
            off += len(cs)
            if not cs or off >= e.get("total", 0):
                break
    cs = {"resourceType": "CodeSystem", "url": "http://hl7.org/fhir/sid/icd-10", "version": version,
          "name": "ICD10", "title": "ICD-10 (WHO), as served by tx.fhir.org", "status": "active",
          "content": "complete", "count": len(flat),
          "concept": [{k: v for k, v in c.items() if k in ("code", "display", "designation")} for c in flat.values()]}
    json.dump(cs, open(os.path.join(out_dir, "icd10who.json"), "w"), ensure_ascii=False)
    print(f"cvx={len(cvx['expansion']['contains'])} icd10={len(flat)} ({version})", file=sys.stderr)


if __name__ == "__main__":
    main()

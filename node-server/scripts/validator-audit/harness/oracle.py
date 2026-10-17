"""Oracle client: validator.dicom.tw (HL7 validator wrapper). Caches results by content hash."""
import hashlib, json, os, sys, time, urllib.parse, urllib.request

MODULES = {
    "tw.gov.mohw.twcore": "tw.gov.mohw.twcore - 1.0.0 release (2025-12-10)",
    "tw.gov.mohw.nhi.pas": "tw.gov.mohw.nhi.pas - 1.2.7 release (2026-10-01)",
}
BASE = "https://validator.dicom.tw/api/validator"
CACHE = os.environ.get("ORACLE_CACHE", "/tmp/twh-validator-audit/oracle_cache")


def validate(resource, ig, delay=0.5):
    os.makedirs(CACHE, exist_ok=True)
    body = json.dumps(resource, ensure_ascii=False, sort_keys=True).encode("utf-8")
    key = hashlib.sha256(MODULES[ig].encode() + body).hexdigest()
    path = os.path.join(CACHE, key + ".json")
    if os.path.exists(path):
        return json.load(open(path))
    q = urllib.parse.urlencode({"moduleName": "HapiFhir", "fhirServer": MODULES[ig]})
    for attempt in range(4):
        try:
            req = urllib.request.Request(BASE + "?" + q, data=body, method="POST",
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=300) as r:
                out = json.load(r)
            break
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "replace")
            try:
                out = json.loads(txt)
                break
            except Exception:
                print("oracle http error", e.code, txt[:200], file=sys.stderr)
        except Exception as e:  # network
            print("oracle error", e, file=sys.stderr)
        time.sleep(5 * (attempt + 1))
    else:
        raise RuntimeError("oracle unavailable")
    time.sleep(delay)
    oo = ((out.get("data") or {}).get("results")) or {}
    issues = []
    for i in oo.get("issue", []):
        mid = None
        for ext in i.get("extension", []):
            if ext.get("url", "").endswith("operationoutcome-message-id"):
                mid = ext.get("valueCode")
        issues.append({
            "severity": i.get("severity"),
            "code": i.get("code"),
            "expression": (i.get("expression") or i.get("location") or [""])[0],
            "message": (i.get("details") or {}).get("text") or i.get("diagnostics"),
            "messageId": mid,
        })
    res = {"status": out.get("status"), "message": out.get("message"), "issues": issues}
    json.dump(res, open(path, "w"), ensure_ascii=False, indent=1)
    return res


def load_json(path):
    """Read a corpus/report file; `.gz` is decompressed transparently."""
    import gzip
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        return json.load(f)

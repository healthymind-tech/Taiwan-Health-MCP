"""Client for our MCP builtin validator via the OpenAPI bridge (POST /tools/<name>)."""
import json, os, urllib.request

BASE = os.environ.get("MCP_BASE", "http://127.0.0.1:8090")
VERSIONS = {"tw.gov.mohw.twcore": "1.0.0", "tw.gov.mohw.nhi.pas": "1.2.7"}


def call(tool, args):
    req = urllib.request.Request(f"{BASE}/tools/{tool}", data=json.dumps(args).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read().decode("utf-8")
    out = json.loads(raw)
    # The bridge may wrap the tool text in {content:[{text}]}; unwrap if so.
    if isinstance(out, dict) and "content" in out and isinstance(out["content"], list):
        out = json.loads(out["content"][0]["text"])
    return out


def validate(resource, ig, tool="fhir_validate_resource"):
    args = {"package_id": ig, "version": VERSIONS[ig]}
    if tool == "fhir_validate_bundle":
        args["bundle"] = resource
    else:
        args["resource"] = resource
    env = call(tool, args)
    data = env.get("data") or {}
    issues = list(data.get("issues") or [])
    for e in data.get("entries") or []:
        for i in e.get("issues") or []:
            i = dict(i); i["path"] = f"entry[{e.get('fullUrl')}]." + (i.get("path") or "")
            issues.append(i)
    for r in data.get("referenceIssues") or []:
        # Informational echo of unresolved refs; the validator itself reports
        # them at the right severity (warning, or error for document bundles).
        issues.append({"severity": "warning", "path": "", "code": "reference", "message": json.dumps(r)})
    return {"ok": env.get("ok"), "valid": data.get("valid"), "issues": issues, "error": env.get("error")}

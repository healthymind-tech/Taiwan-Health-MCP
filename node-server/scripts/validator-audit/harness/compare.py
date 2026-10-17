"""Compare our validator vs the oracle over a corpus file.
usage: compare.py corpus.json out.json [label]
corpus item: {pkg, key, res, expect?}
ORACLE=dicom (default) | cli (cached CLI results only; uncached items are skipped)"""
import json, os, sys, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle, ours
if os.environ.get("ORACLE") == "cli":
    import cli_oracle
    os.environ.setdefault("CLI_NO_RUN", "1")
    _validate = cli_oracle.validate
else:
    _validate = oracle.validate

corpus = oracle.load_json(sys.argv[1])
rows = []
for c in corpus:
    o = _validate(c["res"], c["pkg"])
    if o is None:
        continue
    o_err = [i for i in o["issues"] if i["severity"] in ("error", "fatal")]
    tool = "fhir_validate_bundle" if c.get("tool") == "bundle" else "fhir_validate_resource"
    try:
        u = ours.validate(c["res"], c["pkg"], tool)
    except Exception as e:
        u = {"ok": False, "valid": None, "issues": [], "error": str(e)}
    u_err = [i for i in u["issues"] if i.get("severity") in ("error", "fatal")]
    rows.append({"key": c["key"], "pkg": c["pkg"], "oracle_valid": not o_err, "ours_valid": (u["valid"] is True) and not u_err,
                 "oracle_errors": o_err, "our_errors": u_err, "our_ok": u["ok"], "our_error": u.get("error")})
tp = sum(1 for r in rows if not r["oracle_valid"] and not r["ours_valid"])
tn = sum(1 for r in rows if r["oracle_valid"] and r["ours_valid"])
fp = sum(1 for r in rows if r["oracle_valid"] and not r["ours_valid"])
fn = sum(1 for r in rows if not r["oracle_valid"] and r["ours_valid"])
summary = {"n": len(rows), "agree": tp + tn, "tp_invalid": tp, "tn_valid": tn, "false_reject": fp, "false_accept": fn,
           "precision": tp / (tp + fp) if tp + fp else None, "recall": tp / (tp + fn) if tp + fn else None}
by = collections.defaultdict(lambda: [0, 0])
for r in rows:
    by[r["pkg"]][0] += 1
    by[r["pkg"]][1] += r["oracle_valid"] == r["ours_valid"]
summary["per_ig"] = {k: f"{v[1]}/{v[0]}" for k, v in by.items()}
json.dump({"summary": summary, "rows": rows}, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
print(json.dumps(summary, indent=1))
for r in rows:
    if r["oracle_valid"] != r["ours_valid"]:
        print("DISAGREE", r["pkg"], r["key"], "oracle_valid=", r["oracle_valid"], "ours_valid=", r["ours_valid"])
        for e in r["our_errors"][:6]:
            print("   ours:", e.get("path"), e.get("code"), (e.get("message") or "")[:160])
        for e in r["oracle_errors"][:6]:
            print("   orcl:", e["expression"], e["messageId"], (e["message"] or "")[:160])

"""Compare local-run results (localValidate.ts output) against the oracle.
usage: compare_local.py corpus.json ours.json report.json [-v]
ORACLE=dicom (default: validator.dicom.tw) | cli (local HL7 validator_cli, see cli_oracle.py)"""
import json, os, sys, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle
if os.environ.get("ORACLE") == "cli":
    import cli_oracle
    os.environ.setdefault("CLI_NO_RUN", "1")  # never start the CLI from a comparison; warm the cache first
    _validate = cli_oracle.validate
else:
    _validate = oracle.validate
corpus = oracle.load_json(sys.argv[1])
ours = {(r["pkg"], r["key"]): r for r in oracle.load_json(sys.argv[2])}
rows = []
for c in corpus:
    u = ours.get((c["pkg"], c["key"]))
    if u is None: continue
    o = _validate(c["res"], c["pkg"], c) if os.environ.get("ORACLE") == "cli" else _validate(c["res"], c["pkg"])
    if o is None: continue  # not in the CLI cache
    o_err = [i for i in o["issues"] if i["severity"] in ("error", "fatal")]
    u_err = [i for i in u["issues"] if i.get("severity") in ("error", "fatal")]
    rows.append({"key": c["key"], "pkg": c["pkg"], "expect": c.get("expect"), "oracle_valid": not o_err, "ours_valid": bool(u["valid"]) and not u_err,
                 "oracle_errors": o_err, "our_errors": u_err, "our_error": u.get("error")})
tp = sum(1 for r in rows if not r["oracle_valid"] and not r["ours_valid"])
tn = sum(1 for r in rows if r["oracle_valid"] and r["ours_valid"])
fp = sum(1 for r in rows if r["oracle_valid"] and not r["ours_valid"])
fn = sum(1 for r in rows if not r["oracle_valid"] and r["ours_valid"])
summary = {"n": len(rows), "agree": tp + tn, "both_invalid": tp, "both_valid": tn, "false_reject": fp, "false_accept": fn,
           "precision_invalid": round(tp / (tp + fp), 4) if tp + fp else None, "recall_invalid": round(tp / (tp + fn), 4) if tp + fn else None}
by = collections.defaultdict(lambda: [0, 0])
for r in rows:
    by[r["pkg"]][0] += 1
    by[r["pkg"]][1] += r["oracle_valid"] == r["ours_valid"]
summary["per_ig"] = {k: f"{v[1]}/{v[0]}" for k, v in by.items()}
json.dump({"summary": summary, "rows": rows}, open(sys.argv[3], "w"), ensure_ascii=False, indent=1)
print(json.dumps(summary, indent=1))
for r in rows:
    if r["oracle_valid"] != r["ours_valid"] or "-v" in sys.argv:
        print("DISAGREE" if r["oracle_valid"] != r["ours_valid"] else "AGREE", r["pkg"], r["key"], "oracle_valid=", r["oracle_valid"], "ours_valid=", r["ours_valid"])
        for e in r["our_errors"][:8]:
            print("   ours:", e.get("path"), e.get("code"), (e.get("message") or "")[:220])
        for e in r["oracle_errors"][:8]:
            print("   orcl:", e["expression"], e["messageId"], (e["message"] or "")[:220])

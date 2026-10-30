"""ISSUES_v17 R1 — compare the self-check's validation verdicts (selfcheck.ts --out) with HL7
validator_cli on the same examples (results cached by validator-audit/harness/cli_oracle.py; run
that first, one JVM at a time:  CLI_DIR=… python3 -I harness/cli_oracle.py <pkg#ver>.corpus.json).

    python3 -I compare_cli.py <out-dir> <package#version> [...]

Per package: examples whose verdict (valid / invalid) agrees, and for each disagreement the error
messages only one side reports (first few). Only ids, paths and validator messages are printed.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "validator-audit", "harness"))
os.environ.setdefault("CLI_NO_RUN", "1")
import cli_oracle  # noqa: E402

out_dir = sys.argv[1]
for spec in sys.argv[2:]:
    pid, ver = spec.split("#")
    items = {i["id"].split("/", 1)[1]: i for i in json.load(open(os.path.join(out_dir, f"{spec}.selfcheck.json"))) if i["kind"] == "example"}
    corpus = json.load(open(os.path.join(out_dir, f"{spec}.corpus.json")))
    agree, differ, missing = 0, [], 0
    for c in corpus:
        aid = c["key"].split("/", 1)[1]
        ours = items.get(aid)
        cli = cli_oracle.cached(c["res"], pid, ver)
        if ours is None or cli is None:
            missing += 1
            continue
        cli_err = [i for i in cli["issues"] if i["severity"] in ("error", "fatal")]
        cli_valid = not cli_err
        if cli_valid == ours["valid"]:
            agree += 1
        else:
            differ.append({"id": aid, "ours_valid": ours["valid"], "cli_valid": cli_valid,
                           "ours_first_errors": ours.get("errors", [])[:2],
                           "cli_first_errors": [f'{i["expression"]} | {str(i["message"])[:180]}' for i in cli_err[:2]]})
    n = agree + len(differ)
    print(json.dumps({"package": spec, "compared": n, "agree": agree, "agree_pct": round(100 * agree / n, 1) if n else None,
                      "no_cli_result": missing, "disagreements": differ[:15]}, ensure_ascii=False))

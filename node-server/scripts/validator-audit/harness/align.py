"""Error-level alignment between oracle and ours for a compare_local.py report.

usage: align.py cmp.json [cmp2.json ...] [-v]
Compares the sets of distinct error/fatal locations per item by normalised instance path (HL7 `/*Type/id*/`
annotations and `.ofType(X)` stripped, choice `value[x]` renamed). Reports
per-file counts of matched / oracle-only / ours-only errors, and lists the
unmatched ones with -v.
"""
import json, re, sys, collections

def norm(p):
    p = p or ""
    p = re.sub(r"/\*[^*]*\*/", "", p)
    p = re.sub(r"\.ofType\(([A-Za-z]+)\)", "", p)
    p = p.replace("[x]", "")
    p = re.sub(r"\.(value|effective|onset|abatement|medication|due|deceased|multipleBirth|occurrence|performed|timing|serviced|location|asNeeded|dose|rate|reported|product|item|diagnosis|procedure|collected|fasting|bounds|allowed|used|answer|recorded|born|age|offset|time|subject|detail|statusReason|content|instantiates|defaultValue|scheduled|reason|entity)([A-Z][A-Za-z]*)(?=$|[.\[])", r".\1", p)
    p = p.replace("..", ".").rstrip(".")
    p = re.sub(r"\[0\]$", "", p)
    return p

def key_variants(p):
    p = norm(p)
    out = {p}
    # oracle sometimes reports at the parent element / one level up
    out.add(re.sub(r"\[\d+\]", "", p))
    return out

files = [a for a in sys.argv[1:] if not a.startswith("-")]
verbose = "-v" in sys.argv
tot = collections.Counter()
for f in files:
    rows = json.load(open(f))["rows"]
    c = collections.Counter()
    lines = []
    for r in rows:
        # Distinct normalised error locations per item (HL7 repeats one error
        # once per profile in the derivation chain; we de-duplicate).
        o_set = {norm(e["expression"]): e for e in r["oracle_errors"]}
        u_set = {norm(e.get("path")): e for e in r["our_errors"]}
        def close(a, b):
            if a == b: return True
            sa, sb = re.sub(r"\[\d+\]", "", a), re.sub(r"\[\d+\]", "", b)
            return sa == sb or sa.startswith(sb + ".") or sb.startswith(sa + ".")
        o_only = [e for p, e in o_set.items() if not any(close(p, q) for q in u_set)]
        u_only = [e for q, e in u_set.items() if not any(close(p, q) for p in o_set)]
        strict = lambda a, b: re.sub(r"\[\d+\]", "", a) == re.sub(r"\[\d+\]", "", b)
        so = [e for p, e in o_set.items() if not any(strict(p, q) for q in u_set)]
        su = [e for q, e in u_set.items() if not any(strict(p, q) for p in o_set)]
        c["strict_oracle_only"] += len(so); c["strict_ours_only"] += len(su)
        c["strict_items_with_mismatch"] += bool(so or su)
        if "--strict" in sys.argv and (so or su):
            lines.append(f"-- STRICT {r['pkg']} {r['key']}")
            for e in so: lines.append(f"   S-ORACLE-ONLY {e['expression']} [{e['messageId']}] {(e['message'] or '')[:160]}")
            for e in su: lines.append(f"   S-OURS-ONLY   {e.get('path')} [{e.get('code')}] {(e.get('message') or '')[:160]}")
        c["oracle_error_locations"] += len(o_set); c["ours_error_locations"] += len(u_set)
        c["oracle_only"] += len(o_only); c["ours_only"] += len(u_only)
        if o_only or u_only:
            c["items_with_mismatch"] += 1
            lines.append(f"-- {r['pkg']} {r['key']} (oracle_valid={r['oracle_valid']} ours_valid={r['ours_valid']})")
            for e in o_only: lines.append(f"   ORACLE-ONLY {e['expression']} [{e['messageId']}] {(e['message'] or '')[:180]}")
            for e in u_only: lines.append(f"   OURS-ONLY   {e.get('path')} [{e.get('code')}] {(e.get('message') or '')[:180]}")
    c["items"] = len(rows)
    tot.update(c)
    print(f, dict(c))
    if verbose: print("\n".join(lines))
if len(files) > 1: print("TOTAL", dict(tot))

import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle
corpus = oracle.load_json(sys.argv[1])
for i, c in enumerate(corpus):
    r = oracle.validate(c["res"], c["pkg"])
    errs = [x for x in r["issues"] if x["severity"] in ("error", "fatal")]
    print(i, c["pkg"], c["key"], "errors=%d" % len(errs), flush=True)

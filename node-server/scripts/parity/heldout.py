"""Held-out parity set (parity v2): deterministic mutations of an IG's own example Bundles, validated by the official
validator_cli (one JVM, memory/CPU capped docker container, -profile = the Bundle profile) and written in the format
scripts/parity/run.ts reads (<name>.bundle.json + <name>.compare.json with `official_errors`).

The ten mutation kinds follow the evaluator's held-out method (drop / unarray / unknown property / empty object / bad
code / bad display / bad primitive type / drop entry / reorder entries / dangling reference); everything is seeded by
the Bundle's file stem, so the same inputs give the same set.

usage: python3 heldout.py <out_dir> <ig_spec id#ver> <bundle_profile> <bundle.json> [...]
env:   CLI_DIR (validator_cli.jar + fhircache/), HELDOUT_N (mutants per Bundle, default 20), CLI_TX (default tx.fhir.org)
"""
import copy, json, os, pathlib, random, shutil, subprocess, sys

CLI_DIR = os.environ.get("CLI_DIR", "/home/brian/tools/validator-cli")
TX = os.environ.get("CLI_TX", "https://tx.fhir.org")
N = int(os.environ.get("HELDOUT_N", "20"))


def walk(o, p=()):
    if isinstance(o, dict):
        for k, v in o.items():
            yield from walk(v, p + (k,))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            yield from walk(v, p + (i,))
    yield p, o


def get(o, p):
    for k in p:
        o = o[k]
    return o


def m_drop(b, r, paths):
    p = r.choice([x for x in paths if len(x) >= 4 and isinstance(x[-1], str) and x[-1] not in ("resourceType", "resource", "fullUrl")])
    del get(b, p[:-1])[p[-1]]
    return "drop:" + p[-1]


def m_shape(b, r, paths):
    p = r.choice([x for x in paths if len(x) >= 4 and isinstance(x[-1], str) and isinstance(get(b, x), list) and len(get(b, x)) == 1])
    get(b, p[:-1])[p[-1]] = get(b, p)[0]
    return "unarray:" + p[-1]


def m_unknown(b, r, paths):
    p = r.choice([x for x in paths if len(x) >= 3 and isinstance(get(b, x), dict)])
    get(b, p)["bogusProperty"] = "x"
    return "unknown-prop"


def m_empty(b, r, paths):
    p = r.choice([x for x in paths if len(x) >= 4 and isinstance(x[-1], str) and isinstance(get(b, x), dict)])
    get(b, p[:-1])[p[-1]] = {}
    return "empty:" + p[-1]


def m_code(b, r, paths):
    p = r.choice([x for x in paths if x and x[-1] == "code" and isinstance(get(b, x), str)])
    get(b, p[:-1])["code"] = "ZZZ-9"
    return "bad-code"


def m_display(b, r, paths):
    p = r.choice([x for x in paths if x and x[-1] == "display" and isinstance(get(b, x), str)])
    get(b, p[:-1])["display"] = "Wrong display text"
    return "bad-display"


def m_type(b, r, paths):
    c = [x for x in paths if len(x) >= 4 and isinstance(get(b, x), bool)] or [x for x in paths if len(x) >= 4 and isinstance(get(b, x), (int, float))]
    p = r.choice(c)
    get(b, p[:-1])[p[-1]] = "notatype"
    return "bad-type"


def m_entry(b, r, paths):
    e = b.get("entry") or []
    del e[r.randrange(1, len(e))]
    return "drop-entry"


def m_order(b, r, paths):
    e = b.get("entry") or []
    e.insert(0, e.pop(r.randrange(1, len(e))))
    return "reorder-entry"


def m_ref(b, r, paths):
    p = r.choice([x for x in paths if x and x[-1] == "reference" and isinstance(get(b, x), str)])
    get(b, p[:-1])["reference"] = "urn:uuid:00000000-0000-4000-8000-000000000000"
    return "dangling-ref"


MUT = [m_drop, m_shape, m_unknown, m_empty, m_code, m_display, m_type, m_entry, m_order, m_ref]


def main():
    out, ig, profile = sys.argv[1:4]
    files = sys.argv[4:]
    os.makedirs(out, exist_ok=True)
    items = []
    for f in files:
        b = json.load(open(f))
        if not (isinstance(b, dict) and b.get("resourceType") == "Bundle" and b.get("entry")):
            continue
        stem = pathlib.Path(f).stem
        items.append((stem + "__orig", "orig", b))
        r = random.Random(stem)
        for i in range(N):
            m = MUT[i % len(MUT)] if i < len(MUT) else r.choice(MUT)
            bb = copy.deepcopy(b)
            paths = [p for p, _ in walk(bb) if p]
            try:
                kind = m(bb, r, paths)
            except (ValueError, IndexError, KeyError):
                continue
            items.append((f"{stem}__m{i}", kind, bb))
    work = os.path.join(CLI_DIR, "work")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(os.path.join(work, "in"))
    for name, _, b in items:
        json.dump(b, open(os.path.join(work, "in", name + ".json"), "w"), ensure_ascii=False)
    print(f"{len(items)} Bundles; running validator_cli", file=sys.stderr, flush=True)
    cmd = ["docker", "run", "--rm", "--memory=2500m", "--cpus=2", "-v", f"{CLI_DIR}:/w", "-v", f"{CLI_DIR}/fhircache:/root/.fhir", "-w", "/w",
           "eclipse-temurin:21-jre", "nice", "-n", "15", "java", "-Xmx2000m", "-jar", "validator_cli.jar", "work/in", "-version", "4.0.1",
           "-ig", ig, "-tx", TX, "-profile", profile, "-level", "errors", "-output", "work/out.json"]
    with open(os.path.join(CLI_DIR, "work.log"), "a") as log:
        subprocess.run(cmd, stdout=log, stderr=log)
    res = json.load(open(os.path.join(work, "out.json")))
    oos = [e["resource"] for e in res.get("entry", [])] if res.get("resourceType") == "Bundle" else [res]
    official = {}
    for oo in oos:
        fn = next((x.get("valueString") for x in oo.get("extension", []) if x.get("url", "").endswith("operationoutcome-file")), "")
        official[pathlib.Path(fn).stem] = [{"severity": i.get("severity"), "message": (i.get("details") or {}).get("text") or i.get("diagnostics"),
                                           "expression": (i.get("expression") or i.get("location") or [""])[0]}
                                          for i in oo.get("issue", []) if i.get("severity") in ("error", "fatal")]
    n = 0
    for name, kind, b in items:
        if name not in official:
            continue
        json.dump(b, open(os.path.join(out, name + ".bundle.json"), "w"), ensure_ascii=False)
        json.dump({"kind": kind, "package": ig, "bundle_profile": profile, "official_errors": official[name]}, open(os.path.join(out, name + ".compare.json"), "w"), ensure_ascii=False)
        n += 1
    print(f"{n} Bundles written to {out}", file=sys.stderr)


if __name__ == "__main__":
    main()

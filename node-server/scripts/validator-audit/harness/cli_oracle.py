"""Second oracle: the official HL7 validator_cli (default 7.0.1) run locally in a
memory-capped docker container (eclipse-temurin JRE), terminology from tx.fhir.org.
This is the reference setup external users report against
(`-ig tw.gov.mohw.twcore#1.0.0 -tx tx.fhir.org`).

Batch mode: every uncached resource of one IG is written to a work dir and
validated in a single CLI run (package loading takes ~1.5 min per run).
Results are cached by content hash in $CLI_CACHE, in the same issue format as
oracle.py.

usage (warm the cache):  cli_oracle.py corpus.json[.gz] [more corpora...]
env: CLI_DIR (holds validator_cli.jar + fhircache/), CLI_CACHE,
     CLI_ISO_CACHE (optional, read first): results of single-resource CLI runs.

(v4) validator_cli carries terminology results across the resources of one
batch run, so a verdict can depend on what else was in the batch. When a batch
verdict does not reproduce in a single-resource run (fresh JVM, only that
resource), the single-resource result is the reference: warm it with
`CLI_CACHE=$CLI_ISO_CACHE cli_oracle.py one_item.json` and list it in
results/oracle_isolated.json.
"""
import fcntl, hashlib, json, os, subprocess, sys, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle

CLI_DIR = os.environ.get("CLI_DIR", "/tmp/claude-1000/cli")
CACHE = os.environ.get("CLI_CACHE", os.path.join(CLI_DIR, "cache"))
IGS = {"tw.gov.mohw.twcore": "tw.gov.mohw.twcore#1.0.0", "tw.gov.mohw.nhi.pas": "tw.gov.mohw.nhi.pas#1.2.7"}
TX = os.environ.get("CLI_TX", "https://tx.fhir.org")
BATCH = int(os.environ.get("CLI_BATCH", "400"))


def ig_spec(ig, ver=None):
    """-ig argument: the default version of the IG, or `ig#ver` (v6 items carry `ver`)."""
    return f"{ig}#{ver}" if ver else IGS[ig]


def overlay_hash(overlay):
    """(v6) extra StructureDefinitions loaded with `-ig <file>` next to the IG."""
    if not overlay:
        return ""
    return hashlib.sha256(json.dumps(overlay, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def key_of(resource, ig, ver=None, overlay=None):
    body = json.dumps(resource, ensure_ascii=False, sort_keys=True).encode("utf-8")
    oh = overlay_hash(overlay)
    return hashlib.sha256(("cli|" + ig_spec(ig, ver) + (("|" + oh) if oh else "")).encode() + body).hexdigest()


ISO_CACHE = os.environ.get("CLI_ISO_CACHE")


def cached(resource, ig, ver=None, overlay=None):
    k = key_of(resource, ig, ver, overlay) + ".json"
    if ISO_CACHE and os.path.exists(os.path.join(ISO_CACHE, k)):
        return json.load(open(os.path.join(ISO_CACHE, k)))
    p = os.path.join(CACHE, k)
    return json.load(open(p)) if os.path.exists(p) else None


def _issues(oo):
    out = []
    for i in oo.get("issue", []):
        mid = None
        for ext in i.get("extension", []):
            if ext.get("url", "").endswith("operationoutcome-message-id"):
                mid = ext.get("valueCode")
        out.append({"severity": i.get("severity"), "code": i.get("code"),
                    "expression": (i.get("expression") or i.get("location") or [""])[0],
                    "message": (i.get("details") or {}).get("text") or i.get("diagnostics"), "messageId": mid})
    return out


def run_batch(items, ig, ver=None, overlay=None):
    """items: list of resources (all same ig / ver / overlay). Validates the uncached ones.
    Serialised with a lock file: only one CLI container at a time."""
    os.makedirs(CACHE, exist_ok=True)
    lock = open(os.path.join(CLI_DIR, "cli.lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        _run_batch(items, ig, ver, overlay)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def _run_batch(items, ig, ver=None, overlay=None):
    todo = {}
    for r in items:
        k = key_of(r, ig, ver, overlay)
        if not os.path.exists(os.path.join(CACHE, k + ".json")):
            todo[k] = r
    keys = list(todo)
    for start in range(0, len(keys), BATCH):
        chunk = keys[start:start + BATCH]
        work = os.path.join(CLI_DIR, "work")
        shutil.rmtree(work, ignore_errors=True)
        os.makedirs(os.path.join(work, "in"))
        for k in chunk:
            json.dump(todo[k], open(os.path.join(work, "in", k + ".json"), "w"), ensure_ascii=False)
        extra = []
        if overlay:
            os.makedirs(os.path.join(work, "sd"))
            for i, sd in enumerate(overlay):
                json.dump(sd, open(os.path.join(work, "sd", f"sd{i}.json"), "w"), ensure_ascii=False)
                extra += ["-ig", f"work/sd/sd{i}.json"]
        cmd = ["docker", "run", "--rm", "--memory=3500m", "--cpus=2", "-v", f"{CLI_DIR}:/w",
               "-v", f"{CLI_DIR}/fhircache:/root/.fhir", "-w", "/w", "eclipse-temurin:21-jre",
               "java", "-Xmx2800m", "-jar", "validator_cli.jar", "work/in", "-version", "4.0.1",
               "-ig", ig_spec(ig, ver), *extra, "-tx", TX, "-output", "work/out.json"]
        print(f"[cli] {ig}: validating {len(chunk)} resources", file=sys.stderr, flush=True)
        log = open(os.path.join(CLI_DIR, "work.log"), "a")
        subprocess.run(cmd, stdout=log, stderr=log)
        if not os.path.exists(os.path.join(work, "out.json")):
            print(f"[cli] {ig}: no output (see {CLI_DIR}/work.log)", file=sys.stderr, flush=True)
            continue
        out = json.load(open(os.path.join(work, "out.json")))
        oos = [e["resource"] for e in out.get("entry", [])] if out.get("resourceType") == "Bundle" else [out]
        for oo in oos:
            fn = None
            for ext in oo.get("extension", []):
                if ext.get("url", "").endswith("operationoutcome-file"):
                    fn = ext.get("valueString")
            if not fn:
                continue
            k = os.path.basename(fn).replace(".json", "")
            if k in todo:
                json.dump({"status": "ok", "issues": _issues(oo)}, open(os.path.join(CACHE, k + ".json"), "w"), ensure_ascii=False, indent=1)


def validate(resource, ig, item=None):
    """Cached result; with CLI_NO_RUN=1 a cache miss returns None instead of
    starting a CLI container (used by the comparison scripts). `item` (the corpus
    row) supplies the optional v6 fields `ver` and `overlay`."""
    ver = (item or {}).get("ver")
    overlay = (item or {}).get("overlay")
    c = cached(resource, ig, ver, overlay)
    if c is None and os.environ.get("CLI_NO_RUN") == "1":
        return None
    if c is None:
        run_batch([resource], ig, ver, overlay)
        c = cached(resource, ig, ver, overlay)
    if c is None:
        raise RuntimeError("cli oracle produced no result")
    return c


if __name__ == "__main__":
    for path in sys.argv[1:]:
        corpus = oracle.load_json(path)
        groups = {}
        for c in corpus:
            g = (c["pkg"], c.get("ver"), overlay_hash(c.get("overlay")))
            groups.setdefault(g, (c.get("overlay"), []))[1].append(c["res"])
        for (ig, ver, _), (overlay, res) in groups.items():
            run_batch(res, ig, ver, overlay)
        missing = sum(1 for c in corpus if cached(c["res"], c["pkg"], c.get("ver"), c.get("overlay")) is None)
        print(path, "items", len(corpus), "missing", missing)

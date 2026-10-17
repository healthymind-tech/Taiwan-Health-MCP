"""v3 (issue G): ICD-10-CM complete-code-set probes and mutations.

usage: gen_icd_v3.py examples.json.gz v2_probes.json.gz icd10cm_order_2026.txt out_probes.json out_mut.json

- out_probes: the reporter's G0-G4 repros, the two real-bundle patterns (plus a
  positive control bundle) and rule probes (header codes, case, missing dot,
  short title, diacritics, QA0 category, XML-only 7th characters).
- out_mut:    seeded mutation family over the CMS order file: valid 7-character
  codes (long title / short title / no display), header codes, fabricated codes
  and swapped displays.
The CMS order file is read as data only (fixed-width text).
"""
import copy, json, random, sys
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import oracle

SYS = "http://hl7.org/fhir/sid/icd-10-cm"
PKG = "tw.gov.mohw.twcore"
BASE = "https://twcore.mohw.gov.tw/ig/twcore/"


def dotted(raw):
    return raw[:3] + "." + raw[3:] if len(raw) > 3 else raw


def read_order(path):
    rows = []
    for line in open(path, encoding="ascii"):
        line = line.rstrip("\r\n")
        if len(line) < 16:
            continue
        raw = line[6:13].strip()
        rows.append({"code": dotted(raw), "raw": raw, "header": line[14] == "0",
                     "short": line[16:76].strip(), "long": line[77:].strip() or line[16:76].strip()})
    return rows


def condition(base, coding):
    r = copy.deepcopy(base)
    r["code"] = {"coding": [coding]}
    return r


def coding(code, display=None):
    c = {"system": SYS, "code": code}
    if display is not None:
        c["display"] = display
    return c


def bundle(examples, conditions, bid):
    pat = examples["Patient/pat-example"]
    pra = examples["Practitioner/pra-dr-example"]
    entries = [{"fullUrl": BASE + "Patient/pat-example", "resource": pat},
               {"fullUrl": BASE + "Practitioner/pra-dr-example", "resource": pra}]
    for c in conditions:
        entries.append({"fullUrl": BASE + "Condition/" + c["id"], "resource": c})
    return {"resourceType": "Bundle", "id": bid, "type": "collection", "entry": entries}


def main():
    ex_path, probes_path, order_path, out_probes, out_mut = sys.argv[1:6]
    examples = {c["key"]: c["res"] for c in oracle.load_json(ex_path) if c["pkg"] == PKG}
    base = [c["res"] for c in oracle.load_json(probes_path) if c["key"] == "A-icd-A09-ok"][0]
    order = read_order(order_path)
    by = {r["code"]: r for r in order}
    probes = []

    def add(key, res, lst=probes):
        item = {"pkg": PKG, "key": key, "res": res}
        if res.get("resourceType") == "Bundle":
            item["tool"] = "bundle"
        lst.append(item)

    s = by["S93.411A"]
    # Reporter repros (only code.coding[0] differs).
    add("G0-S93.411A-display-ok", condition(base, coding("S93.411A", s["long"])))
    add("G0b-S06.0X0A-nodisplay", condition(base, coding("S06.0X0A")))
    add("G1-S06.0XX0A", condition(base, coding("S06.0XX0A")))
    add("G2-S01.0XXA", condition(base, coding("S01.0XXA")))
    add("G3-S93.411A-wrong-display", condition(base, coding("S93.411A", "Sprain of right ankle, initial encounter")))
    add("G4-Z99.99", condition(base, coding("Z99.99")))
    # Real-bundle patterns.
    c1 = condition(base, coding("S93.411A", s["long"]))
    add("RB0-bundle-valid-control", bundle(examples, [c1], "icd-rb0"))
    c2 = condition(base, coding("S93.411A", "Sprain of right ankle, initial encounter"))
    add("RB1-bundle-S93.411A-wrong-display", bundle(examples, [c2], "icd-rb1"))
    c3 = condition(base, coding("S06.0XX0A", "Concussion without loss of consciousness, initial encounter"))
    c4 = condition(base, coding("S01.0XXA", "Unspecified open wound of scalp, initial encounter"))
    c4["id"] = "con-example-2"
    add("RB2-bundle-S06.0XX0A-S01.0XXA", bundle(examples, [c3, c4], "icd-rb2"))
    # Rule probes.
    add("P-header-S93.41", condition(base, coding("S93.41", by["S93.41"]["long"])))
    add("P-header-S93.411", condition(base, coding("S93.411", by["S93.411"]["long"])))
    add("P-category-S93", condition(base, coding("S93")))
    add("P-chapter-range", condition(base, coding("S00-T88")))
    add("P-lowercase", condition(base, coding("s93.411a")))
    add("P-lowercase-display", condition(base, coding("s93.411a", s["long"])))
    add("P-nodot", condition(base, coding("S93411A")))
    add("P-short-title", condition(base, coding("S93.411A", s["short"])))
    add("P-display-lower", condition(base, coding("S93.411A", s["long"].lower())))
    add("P-display-trailing-space", condition(base, coding("S93.411A", s["long"] + " ")))
    add("P-display-double-space", condition(base, coding("S93.411A", s["long"].replace(" ", "  ", 1))))
    add("P-ascii-sezary", condition(base, coding("C84.10", by["C84.10"]["long"])))
    add("P-diacritic-sezary", condition(base, coding("C84.10", "Sézary disease, unspecified site")))
    add("P-QA0-category", condition(base, coding("QA0")))
    add("P-QA0.0101", condition(base, coding("QA0.0101", by["QA0.0101"]["long"])))
    add("P-xml-only-S06.1X7D", condition(base, coding("S06.1X7D")))
    add("P-S06.1X7A", condition(base, coding("S06.1X7A")))
    add("P-placeholder-T36.0X1A", condition(base, coding("T36.0X1A", by["T36.0X1A"]["long"])))
    add("P-7th-missing-S93.411", condition(base, coding("S93.411", "Sprain of calcaneofibular ligament of right ankle, initial encounter")))
    add("P-trailing-dot", condition(base, coding("A09.")))
    json.dump(probes, open(out_probes, "w"), ensure_ascii=False)

    rnd = random.Random(20261017)
    seven = [r for r in order if len(r["raw"]) == 7 and not r["header"]]
    headers = [r for r in order if r["header"]]
    billable = [r for r in order if not r["header"]]
    muts = []
    for i, r in enumerate(rnd.sample(seven, 40)):
        add(f"M-valid7-long-{i}-{r['code']}", condition(base, coding(r["code"], r["long"])), muts)
    for i, r in enumerate(rnd.sample(seven, 15)):
        add(f"M-valid7-short-{i}-{r['code']}", condition(base, coding(r["code"], r["short"])), muts)
    for i, r in enumerate(rnd.sample(billable, 15)):
        add(f"M-valid-nodisplay-{i}-{r['code']}", condition(base, coding(r["code"])), muts)
    for i, r in enumerate(rnd.sample(headers, 15)):
        add(f"M-header-{i}-{r['code']}", condition(base, coding(r["code"], r["long"])), muts)
    # Fabricated codes: wrong 7th character, extra placeholder, extra digit.
    i = 0
    for r in rnd.sample(seven, 80):
        if i >= 30:
            break
        kind = i % 3
        if kind == 0:
            cand = [r["code"][:-1] + ch for ch in "BCEGHJKMNPQRZ"]
        elif kind == 1:
            cand = [r["code"][:-1] + "X" + r["code"][-1]]
        else:
            cand = [r["code"] + "1"]
        cand = [c for c in cand if c not in by]
        if not cand:
            continue
        add(f"M-fabricated-{i}-{cand[0]}", condition(base, coding(cand[0], r["long"])), muts)
        i += 1
    # Swapped displays (another code's long title).
    pairs = rnd.sample(seven, 60)
    for i in range(30):
        a, b = pairs[2 * i], pairs[2 * i + 1]
        if a["long"].lower() == b["long"].lower() or a["short"].lower() == b["long"].lower():
            continue
        add(f"M-wrong-display-{i}-{a['code']}", condition(base, coding(a["code"], b["long"])), muts)
    json.dump(muts, open(out_mut, "w"), ensure_ascii=False)
    print(len(probes), "probes;", len(muts), "mutations")


if __name__ == "__main__":
    main()

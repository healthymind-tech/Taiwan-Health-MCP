"""v4: probes and seeded mutation families for the terminologies added in v4
(LOINC answer / part / group / answer-list codes, SNOMED CT inactive content,
CVX, WHO ICD-10, Coding.version vs ValueSet include, ValueSet URL as
Coding.system, PAS ICD-10-CM slice discriminator).

usage: gen_v4.py examples.json.gz Loinc_2.80.zip SnomedCT_InternationalRF2_*.zip \
                 cvx.json icd10who.json out_probes.json out_mut.json

cvx.json / icd10who.json come from fetch_tx_terms.py (tx.fhir.org expansions).
Every input is read as data only.
"""
import copy, csv, gzip, io, json, random, sys, zipfile

TW = "tw.gov.mohw.twcore"
PAS = "tw.gov.mohw.nhi.pas"
LOINC = "http://loinc.org"
SCT = "http://snomed.info/sct"
CVX = "http://hl7.org/fhir/sid/cvx"
ICD10 = "http://hl7.org/fhir/sid/icd-10"
TWB = "https://twcore.mohw.gov.tw/ig/twcore/"
TX_SNOMED_DATE = "20250201"

# ---------------------------------------------------------------- helpers

VD = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
      [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
      [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
      [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]]
VP = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
      [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
      [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]]
VINV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9]


def verhoeff(body):
    c = 0
    for i, d in enumerate(reversed(body)):
        c = VD[c][VP[(i + 1) % 8][int(d)]]
    return str(VINV[c])


def sctid(item):
    body = str(item) + "00"  # partition 00 = concept, international namespace
    return body + verhoeff(body)


def loinc_check(num):
    s, dbl = 0, True
    for ch in reversed(str(num)):
        d = int(ch)
        if dbl:
            d *= 2
            d = d // 10 + d % 10 if d > 9 else d
        s += d
        dbl = not dbl
    return str((10 - s % 10) % 10)


def coding(system, code, display=None, version=None):
    c = {"system": system, "code": code}
    if version is not None:
        c["version"] = version
    if display is not None:
        c["display"] = display
    return c


def base_obs(value_coding, oid="v4"):
    """Plain R4 Observation (no profile, no binding on value): pure CodeSystem checks."""
    return {"resourceType": "Observation", "id": oid, "status": "final",
            "code": {"coding": [{"system": LOINC, "code": "72166-2"}]},
            "subject": {"reference": "Patient/pat-example"},
            "effectiveDateTime": "2024-01-01",
            "valueCodeableConcept": {"coding": [value_coding]}}


def item(pkg, key, res, expect=None):
    d = {"pkg": pkg, "key": key, "res": res}
    if expect is not None:
        d["expect"] = expect
    return d


def read_csv(z, name):
    r = csv.reader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig"))
    h = next(r)
    return [dict(zip(h, row)) for row in r]


def rf2(z, name):
    with z.open(name) as f:
        h = f.readline().decode("utf-8-sig").rstrip("\r\n").split("\t")
        for line in f:
            yield dict(zip(h, line.decode("utf-8").rstrip("\r\n").split("\t")))


# ---------------------------------------------------------------- main

def main():
    ex_path, loinc_zip, sct_zip, cvx_path, icd_path, out_probes, out_mut = sys.argv[1:8]
    allex = json.load(gzip.open(ex_path))
    ex = {x["key"]: x for x in allex if x["pkg"] == TW}
    rnd = random.Random(20261018)
    probes, mut = [], []

    # ---------------- LOINC answer / part / group / answer-list codes
    lz = zipfile.ZipFile(loinc_zip)
    answers = {}
    lists = {}
    for r in read_csv(lz, "AccessoryFiles/AnswerFile/AnswerList.csv"):
        if r["AnswerStringId"]:
            answers.setdefault(r["AnswerStringId"], r["DisplayText"])
        lists.setdefault(r["AnswerListId"], r["AnswerListName"])
    parts = {}
    for r in read_csv(lz, "AccessoryFiles/PartFile/Part.csv"):
        parts.setdefault(r["PartNumber"], r)
    groups = {r["GroupId"]: r["Group"] for r in read_csv(lz, "AccessoryFiles/GroupFile/Group.csv")}

    def lo(key, code, display=None):
        probes.append(item(TW, "L-" + key, base_obs(coding(LOINC, code, display))))

    lo("LA-ok", "LA6752-5", "Mild")
    lo("LA-case", "LA6752-5", "MILD")
    lo("LA-ws", "LA6752-5", "Mild ")
    lo("LA-wrong", "LA6752-5", "Severe")
    lo("LA-nodisp", "LA6752-5")
    lo("LA-badcheck", "LA6752-4")
    lo("LA-fab", "LA99990-" + loinc_check(99990))
    lo("LA-zh", "LA6752-5", "輕微")
    lp = parts["LP7057-5"]
    lo("LP-name", "LP7057-5", lp["PartName"])
    lo("LP-dispname", "LP7057-5", lp["PartDisplayName"])
    lo("LP-wrong", "LP7057-5", "foo bar")
    lo("LP-nodisp", "LP7057-5")
    diff = [p for p in parts.values() if p["PartName"].lower() != p["PartDisplayName"].lower() and p["Status"] == "ACTIVE"]
    p2 = rnd.choice(diff)
    lo("LP2-name", p2["PartNumber"], p2["PartName"])
    lo("LP2-dispname", p2["PartNumber"], p2["PartDisplayName"])
    dep = [p for p in parts.values() if p["Status"] == "DEPRECATED"]
    p3 = rnd.choice(dep)
    lo("LP-deprecated", p3["PartNumber"], p3["PartDisplayName"])
    ll = sorted(lists)[100]
    lo("LL-name", ll, lists[ll])
    lo("LL-wrong", ll, "foo bar")
    lo("LL-nodisp", ll)
    lg = sorted(groups)[100]
    lo("LG-name", lg, groups[lg])
    lo("LG-wrong", lg, "foo bar")
    lo("LG-nodisp", lg)

    la_codes = sorted(answers)
    for i, c in enumerate(rnd.sample(la_codes, 30)):
        mut.append(item(TW, f"LA-valid-{i}", base_obs(coding(LOINC, c, answers[c]))))
    for i, c in enumerate(rnd.sample(la_codes, 30)):
        other = answers[rnd.choice(la_codes)]
        if other.lower() == answers[c].lower():
            continue
        mut.append(item(TW, f"LA-swap-{i}", base_obs(coding(LOINC, c, other))))
    for i, c in enumerate(rnd.sample(la_codes, 10)):
        d = answers[c]
        if " " not in d:
            continue
        mut.append(item(TW, f"LA-ws-{i}", base_obs(coding(LOINC, c, d.replace(" ", "  ", 1)))))
    for i, c in enumerate(rnd.sample(sorted(p for p in parts if parts[p]["Status"] == "ACTIVE"), 15)):
        mut.append(item(TW, f"LP-valid-{i}", base_obs(coding(LOINC, c, parts[c]["PartDisplayName"]))))
    for i, c in enumerate(rnd.sample(sorted(parts), 10)):
        mut.append(item(TW, f"LP-swap-{i}", base_obs(coding(LOINC, c, "Wrong " + parts[c]["PartDisplayName"]))))
    max_la = max(int(c[2:].split("-")[0]) for c in la_codes)
    for i in range(8):
        n = max_la + 50000 + rnd.randint(0, 40000)
        mut.append(item(TW, f"LA-fab-{i}", base_obs(coding(LOINC, f"LA{n}-{loinc_check(n)}"))))

    # ---------------- SNOMED CT inactive content
    sz = zipfile.ZipFile(sct_zip)
    root = sz.namelist()[0].split("/")[0] + "/"
    stamp = root.split("_")[-1][:8]
    concepts = {}
    for r in rf2(sz, f"{root}Snapshot/Terminology/sct2_Concept_Snapshot_INT_{stamp}.txt"):
        concepts[r["id"]] = (r["active"] == "1", r["effectiveTime"], r["moduleId"])
    first_seen = {}
    for r in rf2(sz, f"{root}Full/Terminology/sct2_Concept_Full_INT_{stamp}.txt"):
        t = r["effectiveTime"]
        if r["id"] not in first_seen or t < first_seen[r["id"]]:
            first_seen[r["id"]] = t
    desc = {}
    for r in rf2(sz, f"{root}Snapshot/Terminology/sct2_Description_Snapshot-en_INT_{stamp}.txt"):
        if r["languageCode"] != "en" or r["typeId"] not in ("900000000000003001", "900000000000013009"):
            continue
        desc.setdefault(r["conceptId"], []).append((r["term"], r["active"] == "1", r["effectiveTime"]))

    def so(key, code, display=None, version=None):
        probes.append(item(TW, "S-" + key, base_obs(coding(SCT, code, display, version))))

    so("inact-ok", "9258009", "Gravid uterus")
    so("inact-fsn", "9258009", "Gravid uterus structure (body structure)")
    so("inact-wrong", "9258009", "foo bar")
    so("inact-nodisp", "9258009")
    so("inact-inactdesc", "6369005", "Penicillin")
    so("inact-activedesc", "6369005", "Penicillin antibacterial agent")
    so("active-inactdesc", "77386006", "Pregnancy, NOS")
    so("fab", sctid(987654321))
    so("fab2", sctid(1234567))
    so("badcheck", "9258008")
    late = sorted(c for c, (a, t, m) in concepts.items() if a and first_seen.get(c, "0") > TX_SNOMED_DATE and m == "900000000000207008")
    if late:
        c = late[len(late) // 2]
        fsn = [d for d, a, t in desc.get(c, []) if a]
        so("new-after-tx", c, fsn[0] if fsn else None)
    recent_inact = sorted((c, d) for c, ds in desc.items() if concepts.get(c, (False,))[0]
                          for d, a, t in ds if not a and t > TX_SNOMED_DATE)
    if recent_inact:
        c, d = recent_inact[len(recent_inact) // 2]
        so("desc-inactivated-after-tx", c, d)
    old_inact = sorted((c, d) for c, ds in desc.items() if concepts.get(c, (False,))[0]
                       for d, a, t in ds if not a and t <= TX_SNOMED_DATE)
    so("us-version-ok", "77386006", "Pregnancy", "http://snomed.info/sct/731000124108")
    so("us-version-fab", sctid(987654321), None, "http://snomed.info/sct/731000124108")
    so("intl-version-fab", sctid(987654321), None, "http://snomed.info/sct/900000000000207008")

    inactive = sorted(c for c, (a, t, m) in concepts.items() if not a and t <= TX_SNOMED_DATE
                      and any(x[1] for x in desc.get(c, [])))
    active = sorted(c for c, (a, t, m) in concepts.items() if a and first_seen.get(c, "0") <= TX_SNOMED_DATE)
    for i, c in enumerate(rnd.sample(inactive, 30)):
        d = rnd.choice([x[0] for x in desc[c] if x[1]])
        mut.append(item(TW, f"SCT-inact-valid-{i}", base_obs(coding(SCT, c, d))))
    for i, c in enumerate(rnd.sample(inactive, 30)):
        other = rnd.choice([x[0] for x in desc[rnd.choice(active)] if x[1]] or ["foo"])
        if any(other.lower() == x[0].lower() for x in desc[c]):
            continue
        mut.append(item(TW, f"SCT-inact-swap-{i}", base_obs(coding(SCT, c, other))))
    for i, c in enumerate(rnd.sample(inactive, 10)):
        mut.append(item(TW, f"SCT-inact-nodisp-{i}", base_obs(coding(SCT, c))))
    for i in range(20):
        mut.append(item(TW, f"SCT-fab-{i}", base_obs(coding(SCT, sctid(rnd.randint(10 ** 8, 10 ** 9 - 1))))))
    for i, c in enumerate(rnd.sample(active, 20)):
        ds = [x[0] for x in desc.get(c, []) if x[1]]
        if ds:
            mut.append(item(TW, f"SCT-active-valid-{i}", base_obs(coding(SCT, c, rnd.choice(ds)))))
    for i, (c, d) in enumerate(rnd.sample(old_inact, 15)):
        if any(d.lower() == x[0].lower() for x in desc[c] if x[1]):
            continue
        mut.append(item(TW, f"SCT-active-inactdesc-{i}", base_obs(coding(SCT, c, d))))

    # ---------------- Coding.version vs ValueSet include (pregnancy status, preferred binding)
    preg = ex["Observation/obs-pregnancy-status-example"]["res"]

    def pv(key, version, code="77386006", display="Pregnancy"):
        r = copy.deepcopy(preg)
        r["valueCodeableConcept"]["coding"][0] = coding(SCT, code, display, version)
        probes.append(item(TW, "V-" + key, r))

    pv("none", None)
    pv("intl", "http://snomed.info/sct/900000000000207008")
    pv("intl-date", "http://snomed.info/sct/900000000000207008/version/20250201")
    pv("intl-olddate", "http://snomed.info/sct/900000000000207008/version/20240101")
    pv("us", "http://snomed.info/sct/731000124108")
    pv("us-date", "http://snomed.info/sct/731000124108/version/20250301")
    pv("garbage", "foo")
    pv("nl", "http://snomed.info/sct/11000146104")
    so("us-version-nobinding", "77386006", "Pregnancy", "http://snomed.info/sct/731000124108")

    # ---------------- CVX (Immunization-twcore vaccineCode)
    cvx = json.load(open(cvx_path))["expansion"]["contains"]
    imm = ex["Immunization/imm-example"]["res"]

    def cv(key, code, display=None, keep_ndc=True):
        r = copy.deepcopy(imm)
        codings = r["vaccineCode"]["coding"]
        r["vaccineCode"]["coding"] = [coding(CVX, code, display)] + ([c for c in codings if c.get("system") != CVX] if keep_ndc else [])
        return r

    for k, code, disp in [("ok", "197", "Influenza, high-dose, quadrivalent, PF"), ("case", "197", "INFLUENZA, HIGH-DOSE, QUADRIVALENT, PF"),
                          ("long", "197", next(d["value"] for c in cvx if c["code"] == "197" for d in c.get("designation", []))),
                          ("wrong", "197", "foo bar"), ("ws", "197", "Influenza,  high-dose, quadrivalent, PF"),
                          ("unknown", "9999", None), ("unknown-disp", "9999", "foo"), ("nodisp", "197", None),
                          ("88-lower", "88", "influenza, unspecified formulation"), ("leading-zero", "08", None), ("no-zero", "8", None)]:
        probes.append(item(TW, "C-" + k, cv(k, code, disp)))
    cvx_codes = {c["code"]: c for c in cvx}
    for i, c in enumerate(rnd.sample(sorted(cvx_codes), 40)):
        mut.append(item(TW, f"CVX-valid-{i}", cv("", c, cvx_codes[c]["display"], keep_ndc=False)))
    for i, c in enumerate(rnd.sample(sorted(cvx_codes), 20)):
        o = cvx_codes[rnd.choice(sorted(cvx_codes))]["display"]
        if o.lower() == cvx_codes[c]["display"].lower():
            continue
        mut.append(item(TW, f"CVX-swap-{i}", cv("", c, o, keep_ndc=False)))
    for i, n in enumerate(rnd.sample(range(400, 999), 10)):
        mut.append(item(TW, f"CVX-fab-{i}", cv("", str(n), None, keep_ndc=False)))

    # ---------------- WHO ICD-10 (Condition-twcore code)
    icd = {c["code"]: c for c in json.load(open(icd_path))["concept"]}
    con = ex["Condition/con-example"]["res"]

    def ic(code, display=None):
        r = copy.deepcopy(con)
        r["code"] = {"coding": [coding(ICD10, code, display)]}
        return r

    for k, code, disp in [("ok", "A09", "Other gastroenteritis and colitis of infectious and unspecified origin"),
                          ("case", "A09", "OTHER GASTROENTERITIS AND COLITIS OF INFECTIOUS AND UNSPECIFIED ORIGIN"),
                          ("wrong", "A09", "foo bar"), ("sub", "A09.0", None), ("unknown", "A09.5", None), ("nodot", "A090", None),
                          ("block", "A00-A09", "Intestinal infectious diseases"), ("chapter", "I", None), ("lower", "a09", None),
                          ("longdesc", "C00.0", "Malignant neoplasm: External upper lip"), ("shortdesc", "C00.0", "External upper lip"),
                          ("covid", "U07.1", "COVID-19, virus identified"), ("cm-only", "S93.411A", None)]:
        probes.append(item(TW, "W-" + k, ic(code, disp)))
    codes = sorted(c for c in icd if c[0].isalpha() and "-" not in c)
    for i, c in enumerate(rnd.sample(codes, 40)):
        mut.append(item(TW, f"ICD10-valid-{i}", ic(c, icd[c]["display"])))
    for i, c in enumerate(rnd.sample(codes, 20)):
        o = icd[rnd.choice(codes)]["display"]
        if o.lower() == icd[c]["display"].lower():
            continue
        mut.append(item(TW, f"ICD10-swap-{i}", ic(c, o)))
    fab = []
    while len(fab) < 20:
        c = rnd.choice("ABCDEFGHIJKLMNOPQRSTZ") + f"{rnd.randint(0, 99):02d}." + str(rnd.randint(0, 9))
        if c not in icd and c not in fab:
            fab.append(c)
    for i, c in enumerate(fab):
        mut.append(item(TW, f"ICD10-fab-{i}", ic(c)))

    # ---------------- ValueSet URL as Coding.system
    mr = ex["MedicationRequest/med-req-cod-example"]["res"]

    def mx(key, system, code):
        r = copy.deepcopy(mr)
        r["medicationCodeableConcept"] = {"text": "x", "coding": [coding(system, code)]}
        probes.append(item(TW, "X-" + key, r))

    mx("fda-vs", TWB + "ValueSet/medication-fda-tw", "衛署藥輸字第025485號")
    mx("path-vs", TWB + "ValueSet/medication-path-tw", "PO")
    mx("nhi-vs-2", TWB + "ValueSet/medication-nhi-tw", "AC12345100")
    enc = ex["Encounter/enc-example"]["res"]
    r = copy.deepcopy(enc)
    r["class"] = coding(TWB + "ValueSet/medication-path-tw", "PO")
    probes.append(item(TW, "X-encounter-class-twvs", r))
    probes.append(item(TW, "X-obs-code-twvs", {**base_obs(coding(LOINC, "LA6752-5", "Mild")),
                                                 "code": {"coding": [coding(TWB + "ValueSet/medication-path-tw", "PO")]}}))
    probes.append(item(TW, "X-obs-value-twvs", base_obs(coding(TWB + "ValueSet/medication-path-tw", "PO"))))

    # ---------------- PAS Condition ICD-10-CM slice (memberOf over an unresolvable CodeSystem)
    pc = next(x["res"] for x in allex if x["key"] == "Condition/con-diagnosis" and x["pkg"] == PAS)
    for k, sysurl, code in [("cm2023-cs", TWB + "CodeSystem/icd-10-cm-2023-tw", "M17.11"),
                            ("cm-hl7", "http://hl7.org/fhir/sid/icd-10-cm", "M17.11"),
                            ("cm2023-vs", TWB + "ValueSet/icd-10-cm-2023-tw", "M17.11"),
                            ("cm2014-cs", TWB + "CodeSystem/icd-10-cm-2014-tw", "M17.11")]:
        r = copy.deepcopy(pc)
        r["code"] = {"coding": [coding(sysurl, code)]}
        probes.append(item(PAS, "P-" + k, r))

    json.dump(probes, open(out_probes, "w"), ensure_ascii=False)
    json.dump(mut, open(out_mut, "w"), ensure_ascii=False)
    print(f"probes={len(probes)} mut={len(mut)}", file=sys.stderr)


if __name__ == "__main__":
    main()

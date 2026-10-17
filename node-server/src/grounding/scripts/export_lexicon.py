"""One-off exporter: dump the tables of the Python reference lexicon (tw_lexicon.py + the lexical tables of
grounding_ref.py) into the TypeScript data module node-server/src/grounding/twLexiconData.ts.

Regex sources are exported verbatim in Python syntax; lexicon.ts translates them (`\\b`, `\\w`, `\\-`) when
compiling. After the initial export the TS data module is the source of truth (versioned; its SHA-256 is reported
in provenance) — re-running this script overwrites it.

    cd /tmp && python3 -I <repo>/node-server/src/grounding/scripts/export_lexicon.py \
        --ref <repo>/mcp_proposal/reference --out <repo>/node-server/src/grounding/twLexiconData.ts
"""
import argparse, json, os, sys

ap = argparse.ArgumentParser()
ap.add_argument("--ref", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()
sys.path.insert(0, os.path.abspath(a.ref))
import tw_lexicon as L  # noqa: E402
import grounding_ref as G  # noqa: E402

data = {
    "name": "tw-lexicon",
    "version": L.LEXICON_VERSION.split(" ", 1)[1],
    "normalization": {"dashes": "‐‑‒–—―−－ー", "keepSymbols": "".join(sorted(L.KEEP_SYMBOLS))},
    "sections": {
        "terms": L.SECTION_TERMS,
        "soapLetters": L.SOAP_LETTERS,
        "instructionMarkers": [L.INSTRUCTION_MARK],
        "siteConfigMarker": "【院所設定】",
        "singleLineSections": sorted(L.SINGLE_LINE_SECTIONS),
    },
    "context": {
        "negCues": L.NEG_CUES, "uncertainCues": L.UNCERTAIN_CUES, "histCues": L.HIST_CUES, "clauseSplit": L.CLAUSE_SPLIT.pattern,
        "obsHistCues": ["上次", "前次", "previous", "prior", "初診時", "當時", "舊值"],
        "absenceWords": L.ABSENCE_WORDS, "absenceConcepts": L.ABSENCE_CONCEPTS,
    },
    "identifiers": {
        "labels": L.ID_LABELS, "twIdPattern": L.TW_ID_RE.pattern, "twIdLetters": "ABCDEFGHJKLMNPQRSTUVXYWZIO",
        "noSiteSystems": ["http://www.moi.gov.tw", "http://hl7.org/fhir/sid/passport-TWN", "http://www.immigration.gov.tw", "urn:ietf:rfc:3986"],
    },
    "gender": {
        "male": r"男(?!友|朋友)|先生|\bmale\b|\bboy\b|(?<![a-z0-9])m(?![a-z0-9])|\bman\b",
        "female": r"(?<!婦)女(?!兒|友|婿|性友人)|小姐|女士|\bfemale\b|\bgirl\b|(?<![a-z0-9])f(?![a-z0-9]|/u)|\bwoman\b|孕婦",
    },
    "dates": {
        "cnNum": L.CN_NUM,
        "patterns": [[rx.pattern, kind] for rx, kind in L.DATE_PATTERNS],
        "time": L.TIME_RE.pattern, "cnTime": L.CN_TIME_RE.pattern,
        "relative": [[rx.pattern, off] for rx, off in L.RELATIVE],
        "fhirDateTime": L.FHIR_DT.pattern,
    },
    "numbers": {
        "number": L.NUM_RE.pattern,
        "unitAliases": L.UNIT_ALIASES,
        "doseUnitClass": L.DOSE_UNIT_CLASS,
        "convert": [[f, t, k] for (f, t), k in L.CONVERT.items()],
    },
    "medication": {
        "freqCodes": {k: list(v) for k, v in L.FREQ_CODES.items()},
        "freqCodePattern": r"(?<![a-z0-9])(q\d{1,2}h|qd|qday|qam|qpm|qn|bid|tid|qid|hs|qod|qw|biw|tiw|stat|daily)(?![a-z0-9])",
        "freqZh": [[rx.pattern, n] for rx, n in L.FREQ_ZH],
        "everyNHours": L.EVERY_N_H.pattern, "prn": L.PRN_RE.pattern, "hs": L.HS_RE.pattern,
        "routes": L.ROUTES,
        "unitDoseForm": r"\d\s*(#|tab|cap|錠|顆|粒|包)|一顆|一錠|一粒",
    },
    "encounter": {
        "encClass": L.ENC_CLASS, "departments": L.DEPT_ZH, "departmentSuffix": r"(照護|醫學科|醫學|科|部|中心)$",
        "disposition": {"home": ["返家", "回家", "home", "離院"], "snf": ["護理之家", "安養", "nursing", "長照", "snf"], "emd": ["急診", "er", "ed", "emergency"],
                        "hosp": ["轉院", "transfer"], "exp": ["死亡", "expired"], "aadvice": ["自動出院", "against"]},
        "visitWords": G.VISIT_WORDS, "birthLabels": G.BIRTH_LABELS,
        "visitLineWords": ["就診", "到院", "visit", "date", "日期：", "入院"],
        "identityLine": G.IDENTITY_RE.pattern,
    },
    "terminology": {
        "stop": sorted(L.STOP), "zhEn": L.ZH_EN, "abbrev": L.ABBREV, "latToken": L._LAT_TOKEN.pattern,
        "genericTokens": sorted(L.GENERIC_TOKENS), "genericBigrams": sorted(L.GENERIC_BIGRAMS),
    },
    "observation": {
        "vitalLabels": G.VITAL_LABELS, "profileLabelCode": G.PROFILE_LABEL_CODE, "fixedCodeProfiles": list(G.FIXED_CODE_PROFILES),
    },
    "status": {"workflowDefaults": L.WORKFLOW_DEFAULTS, "statusEvidence": L.STATUS_EVIDENCE},
    "structure": {"listItem": G.LIST_ITEM.pattern},
}

body = json.dumps(data, ensure_ascii=False, indent=1)
ts = f'''/**
 * Taiwan clinical-text lexicon for the grounding engine — VERSIONED DATA.
 *
 * Initially exported from the Python reference (mcp_proposal/reference/tw_lexicon.py {L.LEXICON_VERSION} and the
 * lexical tables of grounding_ref.py) by scripts/export_lexicon.py. This module is now the source of truth:
 * any change to a table must bump `version`; the SHA-256 of the canonical JSON of this object is reported as
 * `lexiconSha256` in tool provenance so results can be tied to an exact lexicon.
 *
 * Regex sources are written in Python `re` syntax (Unicode `\\b` / `\\w`); lexicon.ts translates them.
 */

export const TW_LEXICON_DATA = {body};
'''
with open(a.out, "w", encoding="utf-8") as f:
    f.write(ts)
print("wrote", a.out)

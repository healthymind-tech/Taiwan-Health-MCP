# IG Concept Search

Maps Chinese or English free text, abbreviations and chart wording to codes of **any CodeSystem of an installed
IG** — for example TW Core `medical-service-payment-tw` (Taiwan NHI medical service payment codes), occupation,
department or medication-frequency codes, or the PAS CodeSystems. The code lives in `node-server/src/conceptSearch/`
and is used by `fhir_normalize_code` (when the target is an IG CodeSystem) and `search_medical_codes(system=…)`;
SNOMED CT / LOINC / ICD-10 keep their own tables.

## What is searched

Every IG CodeSystem is indexed by `ig_import` (automatically after an IG is installed) or `ig_concept_index`
(backfill / rebuild):

| Source | Notes |
|--------|-------|
| The CodeSystem JSON | display, **designations in every language** (e.g. the English names TW Core already ships), nested `concept.concept`, string properties (e.g. ingredients), short definitions (≤ 120 characters, low weight) |
| CodeSystem supplements | FHIR R4 `content = supplement`, merged by `supplements` (optionally `|version`): designations and properties. Supplements shipped in IG packages, uploaded in the admin console, or bundled with the code (see "Bundled data" below) all apply. A numeric usage property (code or description mentions `claim-volume` / `usage` / `popularity` / `申報量` / `使用量`, e.g. a `claim-volume` built from the NHI open dataset 診療項目醫令申報量(年)) is not a name: it becomes a **usage prior** for ranking (see "Usage" below) |
| Linked names | Coding properties (e.g. a supplement's `loinc`) and the targets of IG ConceptMaps whose `group.source` is the CodeSystem: the shared LOINC COMPONENT, SNOMED descriptions, otherwise the coding display |
| UMLS (optional) | When a concept's English name is a string of a UMLS concept (CUI), that CUI's other synonyms / abbreviations become **match-only** terms (at most 12 per concept) |

CodeSystems served by the ICD / LOINC / SNOMED tables (`icd-10-cm-*-tw` …) are not indexed. A signature decides
whether a CodeSystem needs rebuilding; unchanged ones are skipped.

## Query processing

- **Normalisation**: NFKC (full-width → half-width), case, Unicode dashes, variant characters (臺/台, 脢/酶 …), Chinese
  numerals before measure words (小於五公分 → 小於5公分), `cm` → 公分, `<` → 小於, dotted abbreviations (C.R.P → crp), `w/o`.
- **Chart noise removed**: laterality, `x1`, `5針`, suture specs (4-0 Nylon), `r/o`, `f/u`, `s/p`, dosing / sampling
  frequencies (`q6h`, `q3m`, `bid`, `prn`), measured values and doses with a unit (`7.8%`, `0.5mg`, `25 cmH2O`, `28Fr`,
  `2.4 ATA`) and decimal lab values (`Hb 9.1`). Sizes (公分), durations and ages are kept.
- **Shorthand**: short shorthand joined by `&` / `/` (`I&D`, `U/A`, `B/C`) is one word; its parts remain words of their
  own (`Na/K` → na, k).
- **Tokens**: English words (-s / -ing / -ed folded), Chinese character bigrams plus low-weight unigrams; an English
  word absent from the index matches as a prefix (abd → abdominal, vanco → vancomycin); an English word of 7+ letters
  that a name lacks also matches, at a discount, another form sharing its first 6 letters (recurrent ↔ recurrence,
  laparoscopic ↔ laparoscopy).
- **Query variants** (each scored, the best kept, agreement between variants adds a little): the text, its clinical
  core, without brackets, abbreviation expansions, zh ↔ en bridges, UMLS synonyms. Every expansion comes from data:
  SNOMED CT "ACR - expansion" descriptions, LOINC shortname ↔ component, abbreviations defined inside IG names
  ("… lithotripsy (ESWL)", Schwartz–Hearst validated), English ↔ Chinese word pairs mined from ICD-10 / IG bilingual
  names (Dice + mutual best match), the abbrev / zhEn tables of `grounding/twLexiconData.ts`, and optionally UMLS —
  stored in `fhir.term_thesaurus` / `fhir.umls_terms`.
- **General abbreviation lexicon fills gaps** (`fhir.abbreviation_lexicon`, the SPECIALIST Lexicon's LRABR; a copy is
  bundled with the code and loaded while the table is empty, a UMLS file carrying LRABR replaces it): an abbreviation in the query's **first clause** is looked up there only when the
  CodeSystem does not use it as a word itself (e.g. "Procalcitonin (PCT)" already contains PCT) and no thesaurus
  expansion is supported by the CodeSystem (support < 0.45). A general lexicon gives an abbreviation dozens of senses
  (LP → lipoprotein, lumbar puncture …); each sense is scored by how well the CodeSystem's own names name it — the best
  lexical score of the sense on its own (capped at 1) + 0.3 × usage of that concept — kept at support ≥ 0.45, one
  reading per concept, best first (the best one is also embedded). Upper-case acronyms (PLEX, BMA) apply only to words
  written like abbreviations, lower-case clippings (chole, trach) only to words the CodeSystem does not know;
  abbreviations of fewer than 3 letters / digits are too ambiguous to expand from it; a one-word expansion must be a
  clipping (trach → tracheostomy) — ABO → antibody, where the letters merely occur, is dropped. Abbreviations in later
  clauses (indication, notes) are not expanded, so a wrong sense there adds no noise.
- **Scoring**: BM25-like with query / name coverage; only the **text as typed** matching a name exactly is `exact`
  and always ranks first (official Chinese names typed verbatim: top-1 ≥ 98%).
- **Semantic**: the same embedding model and identity as ICD (`ig_embed` job; vectors keyed by `sha256(name)`, so a
  name shared by package versions is embedded once). The core text, the abbreviation-expanded text and the first
  clause are embedded in one call and scanned exactly against that CodeSystem's vectors (no HNSW). CodeSystems with
  more than 20,000 concepts are indexed lexically only. Without a usable embedding endpoint, or before the
  CodeSystem has vectors, responses carry `search_mode: "keyword_only"`.
- **Fusion**: 0.55 × lexical + 0.45 × semantic (similarities rescaled within the query's own similarity distribution — best = 1, rank 40 = 0 — and weighted by a confidence of (best − rank-40 value) ÷ 0.12; no absolute 0.7 floor any more: absolute similarity levels are model-specific, and Qwen3-Embedding-4B with a query instruction puts the best match at ~0.6–0.75. The query vector carries the `ig_concept` task instruction).
- **Usage** (only when the CodeSystem carries a usage property; otherwise ranking is unchanged):
  - prior: + 0.3 × usage (log-scaled to 0–1 relative to the CodeSystem's most used code);
  - **sibling ordering**: among codes of one `group` (same name stem, differing only by a method / setting / size
    qualifier — 白蛋白 vs 白蛋白(免疫比濁法), 血液透析(一次)-住院 vs -門診), the members the query **cannot tell apart** —
    same exact-match status and the same share of the query's words covered (within 0.05), or, when no word of the
    query matched, a similarity within 0.02 — are ordered by usage instead of by vector noise. The group keeps its
    place among the candidates; only its representative changes. A query that names the qualifier ("住院 洗腎",
    "recurrent") covers more words with that sibling, so usage never overrides it.
- **Multi-item text** ("Na/K/Cl", "CBC/DC, Hb …"): the response carries `clauses` (each clause's best code, in text
  order) and the first clause's concept gets a small boost.

## Response fields

IG candidates of `fhir_normalize_code`: `code`, `display`, `source` (`lexical` / `semantic` / `hybrid`), `score`,
`matched_term` / `matched_language` (the IG name that matched — **always the IG's own display or designation, never a
UMLS string**), `exact`, `category` (from a categorical property or the hierarchy), `group` + `siblings`
(near-duplicate codes with the same name stem, e.g. the same test by another method). `system` may be a canonical, a
CodeSystem id or alias words (e.g. `nhi_payment`). `fhir_lookup_code` adds `hint` and `near_codes` when a code is
not found.

## Admin console (IG packages → 術語搜尋索引)

- Index / vector / thesaurus / abbreviation-lexicon status (the lexicon shows its source: bundled or an uploaded UMLS
  file); "補建索引" (skips unchanged CodeSystems) and "全部重建" (force). While an index job runs the panel shows its step
  and "CodeSystems checked / total"; when it ends it shows the result — "索引已是最新（N 個 CodeSystem 未變更）" (index up to
  date, N unchanged) when nothing was rebuilt.
- "N 個套件尚未建立索引" (N packages not indexed yet) counts only packages that **have indexable CodeSystems**; packages
  with profiles only, or whose CodeSystems are served by the ICD / LOINC / SNOMED tables or are `content = not-present`,
  are listed as a neutral note ("no indexable CodeSystem") and need no action.
- **Upload a CodeSystem supplement JSON** (`application/fhir+json`, up to 64 MB); the list shows the package
  versions it applies to; uploads and deletions rebuild the affected index. Bundled supplements carry a 「內建」 badge;
  deleting one is remembered (it is not re-applied by the next import) and "還原" / "還原內建 supplement" restores it
  (queues `ig_concept_index`, which applies it). API: `GET/POST/DELETE /admin/api/igs/supplements`,
  `POST /admin/api/igs/supplements/bundled/restore` (`{url?}`, all when omitted), `GET /admin/api/igs/concept-index`,
  `POST /admin/api/igs/concept-index/rebuild`.

## Bundled data (no manual upload)

The code ships openly licensed reference data (`node-server/data/`, copied into both images; sources, versions,
licences and how to regenerate them: `node-server/data/README.md`, generators in `node-server/scripts/supplements/`).
On a fresh install the operator imports an IG (e.g. TW Core) through the normal admin flow — no file uploads, no
direct DB writes:

| File | Supplements | Content |
|------|-------------|---------|
| `nhi-payment-en-supplement` | TW Core `medical-service-payment-tw` | NHI English item names of the payment codes |
| `nhi-payment-loinc-supplement` | same | LOINC links of the TWPAS ConceptMap `nhi-loinc` (with LOINC names) |
| `nhi-payment-usage-supplement` | same | NHI annual claim volume — a usage prior for ranking |
| `nhi-medication-supplement` | TW Core `medication-nhi-tw` | Chinese / English names, ingredients and ATC of NHI drug codes |
| `lrabr-2024AA.tsv.gz` | — | SPECIALIST Lexicon LRABR abbreviation lexicon (filtered like the loader keeps it, 115,233 rows) |

- **When**: before every index build — `ig_import` (including dependency installs) and `ig_concept_index`
  ("補建索引") — each bundled supplement whose `supplements` canonical names an **installed** CodeSystem is written to
  `fhir.codesystem_supplements` (`uploaded_by = 'system:bundled'`, the same write path as uploads); the same job then
  builds the index, including the packages a newly applied supplement touches — no second rebuild. A supplement whose
  target is not installed yet is applied when it is.
- **Idempotent, never overwrites**: a row with the same url + version (whoever stored it) is left alone; when an
  **operator-uploaded different version** of the url exists the bundled version is not written; only an older
  **bundled** version is replaced by a newer bundled one.
- **Deletion is respected**: deleting a bundled supplement records an opt-out (`admin.app_settings`, group
  `bundled_supplements`, key = url); it does not come back until restored.
- **Abbreviation lexicon**: the bundled LRABR is loaded only while `fhir.abbreviation_lexicon` is empty
  (`source = 'bundled:LRABR-2024AA'`; parsed fully first, written in one transaction); uploading a UMLS file that
  carries LRABR (`umls_import`) still replaces it. The lexicon is not part of the index signature, so loading it
  triggers no rebuild.
- **Installs that already hold them** (e.g. production, where the same 4 supplements were uploaded by hand with the
  same url + version and the lexicon came from a UMLS file): nothing is written, nothing re-indexed or re-embedded; the
  list marks those rows 「內建」.

## UMLS (optional, requires a UMLS licence)

Without UMLS the engine works as described, just without UMLS synonyms. To enable it:

1. Write the compact subset (same parser, ~36 MB):
   `node dist/loaders/umls.js --subset umls-2024AA-metathesaurus-full.zip umls-subset-2024AA.rrf.gz`
   (the Metathesaurus zip, or a zip holding only `META/MRCONSO.RRF` + `META/MRSAB.RRF`, is accepted as well and is
   streamed member by member, but uploading the full 4 GB zip through the browser is impractical.)
2. Upload it in the admin console as source `ig / umls_metathesaurus` and run the `umls_import` job; the index is
   rebuilt afterwards.

**Source vocabularies (SAB)**: MRSAB rows with `CURVER = Y` and `SRL = 0`, plus `SNOMEDCT_US` (covered by this
deployment's SNOMED CT licence), minus non-clinical sources: HGNC, OMIM, GO, NCBI, LCH, LCH_NW, SRC, MTHMST*, UWDA,
FMA, MTHSPL, USP, USPMG, HL7V2.5, HL7V3.0, CDCREC, MVX, CVX, TKMT, SPN, MCM, QMR, RAM, CCS, CCSR_*, DXP, ICPC. Only
`LAT = ENG`, `SUPPRESS = N` strings of ≤ 80 characters, and only concepts with at least 2 distinct strings, are kept
(2024AA: ~2.53 M strings / 0.76 M concepts, `fhir.umls_terms` ≈ 610 MB). The SAB is recorded internally only
(`fhir.concept_index_terms.source`); **no UMLS string is ever returned by a tool**.

**Abbreviation lexicon** (a copy is bundled — see "Bundled data"; this is how to load it from a UMLS file): `LRABR` of the SPECIALIST Lexicon (NLM Lexical Systems Group; `LEX/LRABR` inside
`LEX.tgz`, ~20 MB; open source and freely available — no UMLS licence needed). Only acronym / abbreviation rows with a 2–10 character abbreviation and a 3–80 character ASCII
expansion are kept, spelling variants (plasma exchange / plasma-exchange) collapse (2024 release: ~115 k rows /
34 k abbreviations). Add it as a third argument when writing the subset:
`node dist/loaders/umls.js --subset <umls.zip> umls-subset-2024AA-lrabr.rrf.gz LEX/LRABR`; an `LRABR` member of an
uploaded UMLS zip is read as well. `umls_import` replaces `fhir.abbreviation_lexicon` only when the file carries it
(apply migration `20261027_abbreviation_lexicon.sql` first; without the table it logs a warning and skips). Lexicon
strings likewise **only steer matching and never appear in tool output**.

## Jobs and tables

| Job | Description |
|-----|-------------|
| `ig_import` | Applies the bundled data (supplements / lexicon), indexes the packages it installed (plus those a newly applied supplement touches), then queues `ig_embed` |
| `ig_concept_index` | Applies the bundled data, then backfill / rebuild; progress counts CodeSystems (options: `packages`, `force`, `embed_max_concepts`, `thesaurus`, `queue_embed`); then rebuilds the thesaurus and queues `ig_embed` when vectors are missing |
| `ig_embed` | Embeds the embeddable names (incremental, content-addressed) |
| `umls_import` | Loads UMLS (optional; also the abbreviation lexicon when the file carries LRABR), then queues `ig_concept_index` |

Tables: `fhir.concept_index_cs` / `_concepts` / `_terms`, `fhir.concept_embeddings`, `fhir.term_thesaurus`,
`fhir.codesystem_supplements` (migration `20261022_ig_concept_search.sql`), `fhir.umls_terms` /
`fhir.umls_release` (`20261023_umls_terms.sql`), `fhir.abbreviation_lexicon` (`20261027_abbreviation_lexicon.sql`).

## Limitations

- Taiwan-specific chart abbreviations (NSD, Foley, OB, "echo" for ultrasound …) are mostly absent from
  SNOMED / LOINC / UMLS / LRABR and may still not be found; two-letter abbreviations (PD, LP, VF) are not expanded from
  the general lexicon and rely on the CodeSystem itself, the thesaurus and the embedding.
- CodeSystems with Chinese names only and no English designation (e.g. occupations) rely on the embedding for
  English queries.
- A very large CodeSystem (tens of thousands of concepts) takes a few seconds to load on its first query; it is
  cached in memory afterwards.

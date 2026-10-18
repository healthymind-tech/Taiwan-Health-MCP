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
| CodeSystem supplements | FHIR R4 `content = supplement`, merged by `supplements` (optionally `|version`): designations and properties. Supplements shipped in IG packages and those uploaded in the admin console both apply |
| Linked names | Coding properties (e.g. a supplement's `loinc`) and the targets of IG ConceptMaps whose `group.source` is the CodeSystem: the shared LOINC COMPONENT, SNOMED descriptions, otherwise the coding display |
| UMLS (optional) | When a concept's English name is a string of a UMLS concept (CUI), that CUI's other synonyms / abbreviations become **match-only** terms (at most 12 per concept) |

CodeSystems served by the ICD / LOINC / SNOMED tables (`icd-10-cm-*-tw` …) are not indexed. A signature decides
whether a CodeSystem needs rebuilding; unchanged ones are skipped.

## Query processing

- **Normalisation**: NFKC (full-width → half-width), case, Unicode dashes, variant characters (臺/台, 脢/酶 …), Chinese
  numerals before measure words (小於五公分 → 小於5公分), `cm` → 公分, `<` → 小於, dotted abbreviations (C.R.P → crp), `w/o`.
- **Chart noise removed**: laterality, `x1`, `5針`, suture specs (4-0 Nylon), `r/o`, `f/u`, `s/p`.
- **Tokens**: English words (-s / -ing / -ed folded), Chinese character bigrams plus low-weight unigrams; an English
  word absent from the index matches as a prefix (abd → abdominal, vanco → vancomycin).
- **Query variants** (each scored, the best kept, agreement between variants adds a little): the text, its clinical
  core, without brackets, abbreviation expansions, zh ↔ en bridges, UMLS synonyms. Every expansion comes from data:
  SNOMED CT "ACR - expansion" descriptions, LOINC shortname ↔ component, abbreviations defined inside IG names
  ("… lithotripsy (ESWL)", Schwartz–Hearst validated), English ↔ Chinese word pairs mined from ICD-10 / IG bilingual
  names (Dice + mutual best match), the abbrev / zhEn tables of `grounding/twLexiconData.ts`, and optionally UMLS —
  stored in `fhir.term_thesaurus` / `fhir.umls_terms`.
- **Scoring**: BM25-like with query / name coverage; only the **text as typed** matching a name exactly is `exact`
  and always ranks first (official Chinese names typed verbatim: top-1 ≥ 98%).
- **Semantic**: the same embedding model and identity as ICD (`ig_embed` job; vectors keyed by `sha256(name)`, so a
  name shared by package versions is embedded once). The core text, the abbreviation-expanded text and the first
  clause are embedded in one call and scanned exactly against that CodeSystem's vectors (no HNSW). CodeSystems with
  more than 20,000 concepts are indexed lexically only. Without a usable embedding endpoint, or before the
  CodeSystem has vectors, responses carry `search_mode: "keyword_only"`.
- **Fusion**: 0.55 × lexical + 0.45 × semantic (similarities rescaled from a 0.7 floor and weighted by confidence).
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

- Index / vector / thesaurus status; "補建索引" (skips unchanged CodeSystems) and "全部重建" (force).
- **Upload a CodeSystem supplement JSON** (`application/fhir+json`, up to 64 MB); the list shows the package
  versions it applies to; uploads and deletions rebuild the affected index. API:
  `GET/POST/DELETE /admin/api/igs/supplements`, `GET /admin/api/igs/concept-index`,
  `POST /admin/api/igs/concept-index/rebuild`.

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

## Jobs and tables

| Job | Description |
|-----|-------------|
| `ig_import` | Indexes the packages it installed, then queues `ig_embed` |
| `ig_concept_index` | Backfill / rebuild (options: `packages`, `force`, `embed_max_concepts`, `thesaurus`, `queue_embed`); then rebuilds the thesaurus and queues `ig_embed` when vectors are missing |
| `ig_embed` | Embeds the embeddable names (incremental, content-addressed) |
| `umls_import` | Loads UMLS (optional), then queues `ig_concept_index` |

Tables: `fhir.concept_index_cs` / `_concepts` / `_terms`, `fhir.concept_embeddings`, `fhir.term_thesaurus`,
`fhir.codesystem_supplements` (migration `20261022_ig_concept_search.sql`), `fhir.umls_terms` /
`fhir.umls_release` (`20261023_umls_terms.sql`).

## Limitations

- Taiwan-specific chart abbreviations (TTE, CVC, NSD, Foley, OB, "echo" for ultrasound …) are mostly absent from
  SNOMED / LOINC / UMLS and may still not be found.
- CodeSystems with Chinese names only and no English designation (e.g. occupations) rely on the embedding for
  English queries.
- A very large CodeSystem (tens of thousands of concepts) takes a few seconds to load on its first query; it is
  cached in memory afterwards.

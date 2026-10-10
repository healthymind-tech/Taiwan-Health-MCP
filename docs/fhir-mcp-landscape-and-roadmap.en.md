# FHIR MCP Landscape and Project Roadmap

**Status:** strategy document (research + planning, no code changes yet)
**Date:** 2026-10-10
**Purpose:** (1) record what FHIR MCP tools elsewhere do and where this project stands;
(2) lay out a prioritised optimisation roadmap; (3) serve as the working draft for proposals
to Taiwan's Ministry of Health and Welfare (MOHW) and to open-source foundations.

!!! warning "Freshness and verification"
    Research reflects GitHub READMEs, official documents and press as of 2026-10-10. Star counts,
    versions and government programme dates all move; re-open the source before quoting it.
    Items marked **[unverified]** had no primary source and need a manual check.

---

## 0. Summary (TL;DR)

- **Nine out of ten FHIR MCP servers are thin proxies that do read / search / create / update
  against one FHIR server.** They differ only in OAuth plumbing and token-saving tricks. Only four
  do profile validation, four do ValueSet expansion, and **only this project** browses profiles
  across multiple IGs and generates resource skeletons from a profile.
- **Our weak spot is exactly their strong spot:** the live-server surface is thin (no
  `$everything`, history, transaction bundle submission, pagination, FHIRPath filtering) and
  there is no SMART App Launch user context.
- **MOHW's policy gap overlaps our strength:** the national certification lab created in
  2026-08 explicitly **does not certify FHIR servers or converters**, only SMART on FHIR apps and
  CQL modules; the TW Core IG validation guide still points to the HL7 Java validator; every
  medical centre must interoperate by end of 2026, regional hospitals by end of 2027. Taiwan has
  **no open-source TW Core test kit**, whereas Australia (Inferno AU Core), the US (ONC Inferno)
  and Germany (gematik Referenzvalidator) all have one, all Apache-2.0.
- **Core thesis of the roadmap:** spend three months closing the thin-proxy table stakes, then
  grow `fhir_validate_*` into a **TW Core conformance self-check suite**, and package it as a
  **SMART on FHIR app** to enter official certification and the THAS marketplace.
- **Foundations:** first choice is the Linux Foundation's **Open Health Stack Software
  Foundation** (founded 2026-07) and **LF AI & Data Sandbox**; locally, join **HL7 Taiwan** as
  an organisational member and use the **Open Culture Foundation (OCF)** for fiscal sponsorship.
  Every foundation first checks governance files, CI running tests, an OpenSSF badge and a
  second contributing organisation.

---

## 1. What other FHIR tools do

### 1.1 Categories

| Type | Representative projects | What they do |
|---|---|---|
| **A. Live-server proxy** | WSO2 `fhir-mcp-server` (Python, 137★), LangCare (Go, 67★), Momentum (102★, unmaintained since 2025-10), Medplum built-in `fhir-request`, Aidbox (alpha), Google MCP Toolbox (read-only), AWS HealthLake (official, with bulk import/export), community Azure server | Wrap `read / search / create / update / delete` as MCP tools; the work is OAuth2 / SMART Backend Services / IAM plumbing |
| **B. Validation and terminology** | CSIRO `aehrc/mcp-fhir-tools` (wraps HL7 validator + Ontoserver), `fhir-mcp-suite` (HAPI validation + tx.fhir.org terminology + OpenFDA interactions, 0★), `rlinlen/fhir-validator-agent` (**defaults to TW Core**, wraps the Java validator, 0★), several tx.fhir.org wrappers | Turn the official validator or an external terminology server into MCP tools; hold no data themselves |
| **C. Authoring / toolkits** | HealthChain (Python SDK, 229★, `build_resource` / `validate_resource` / `lookup_code`), `medvertical/records-agent-tools` (FSH / IG Publisher diagnostic skills), `fhir-augury` (indexes HL7 Jira / Zulip / FSH for search) | Help write resources as an SDK or skills; validation is usually a subset |
| **D. Guardrail / safety proxies** | `HealthClawGuardrails` (27 tools, Safe-Harbor de-identification, propose/commit two-step writes), `fhirHydrant` (SMART Backend Services, batch/transaction, `$validate`, dry-run writes) | Add authorisation, redaction and audit in front of any FHIR server |

### 1.2 Capability matrix (✓ verified in README / docs; ~ partial; blank = absent or unverified)

| Capability | WSO2 | LangCare | fhir-mcp-suite | Medplum | Aidbox | AWS | fhirHydrant | aehrc | HealthChain | HealthClaw | **This project** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Live-server read / search | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | ~ (`crud_fhir_server`) |
| Writes (C/U/D) | ✓ | C/U | | ✓ | ✓ | ✓ | opt-in | | | two-step | allow-list + `confirm_write` |
| `$everything` / extended operations | ✓ | | | ✓ | | ✓ | ✓ | | | | |
| batch / transaction submission | | | | native | | | ✓ | | | | build only |
| SMART / OAuth to EHR | auth code | Backend Services | | OAuth2 | policies | SigV4 | Backend Services | | | | auth code + client credentials + `private_key_jwt` |
| Profile validation | | | HAPI | | ✓ | | via `$validate` | HL7 validator | subset | subset | **in-process** (structure + slicing + FHIRPath invariants) |
| ValueSet expansion / code lookup | | | ✓ | | | | lookup only | lookup only | lookup | | ✓ |
| Multi-IG profile / element browsing | | | | | | | | | | | **✓ (only one)** |
| Profile-driven skeleton + finalize | | | | | | | | | build | | **✓ (only one)** |
| Drug interactions | | | ✓ | | | | | | | | |
| Bulk import / export | | | | server-side | | ✓ | | | | | |
| CDS Hooks / Subscriptions | | | | | | | | | | topic list | |
| SQL-on-FHIR (ViewDefinition) | | | | | | | | | | | |
| De-identification / PHI masking | | logs only | | | | | | | | ✓ | |
| Natural language → search-parameter planning | | | | | | | | | | | |
| Semantic / vector search | | | | | | | | | | | ✓ (ICD / drugs / terminology) |
| FHIRPath response filtering | ✓ | | | | | | ✓ | | | | |
| Clinical calculators | | | | | | | | | | | ✓ |

### 1.3 Who has real traction, and why

| Project | Source of traction |
|---|---|
| AWS HealthLake MCP | Official vendor, Bedrock AgentCore integration, continuous PyPI releases; a CVE shows real usage |
| Medplum | Built into a widely used open-source EHR platform with a hosted endpoint |
| Google MCP Toolbox | Ships inside the general-purpose `genai-toolbox` repo |
| WSO2 | Most-starred dedicated FHIR MCP; brand, Epic sandbox demo, 100+ tests |
| HealthChain | Entered the LangChain ecosystem as an SDK; MCP is just one output surface |

Almost everything else is < 35★, single-maintainer, and more than half is stale (> 9 months) or
archived. **This project, at 165★, is the second most-starred dedicated FHIR MCP after the
big-vendor repos**, and the only one that combines terminology, multi-IG authoring / validation
and governed CRUD.

### 1.4 What nobody does well (opportunity list)

1. **End-to-end IG authoring**: no MCP wraps SUSHI / IG Publisher; no tool generates StructureDefinitions or ValueSets.
2. **SQL-on-FHIR / ViewDefinition**: zero implementations.
3. **Natural language → FHIR search-parameter planning**: every server assumes the LLM already knows the search parameters.
4. **Terminology + live data + validation in one server**: only the 0★ `fhir-mcp-suite` attempted it.
5. **Subscriptions / CDS Hooks**: effectively absent.
6. **Write safety**: only HealthClaw, last-ehr and this project gate writes with a second step.
7. **Non-US localisation**: only Australia (aehrc) and Taiwan (this project, rlinlen); nothing for EU, Japanese or Korean core IGs.
8. **R5 / R6**: nearly everything hard-codes R4.

---

## 2. Where this project stands

### 2.1 What we already have that is rare

- 19 `fhir_*` IG tools: multi-IG package registry (pulls straight from `packages.fhir.org`),
  profile / element / slicing / choice / binding views, ValueSet expansion (inline + local SNOMED /
  LOINC / ICD + dependency packages), `fhir_normalize_code` (free text → standard code),
  schema-guided fill (`fhir_get_resource_skeleton` → `fhir_finalize_resource`), reference
  resolution, Bundle assembly, in-process validator.
- External servers: three OAuth modes (authorization code with encrypted grants and automatic
  refresh, client credentials, `private_key_jwt` with public JWKS), per-server resource-type and
  operation allow-lists, writes require `confirm_write`, tokens never reach the MCP caller.
- Full local copies of ICD-10-CM/PCS, LOINC, SNOMED CT, RxNorm, TFDA drugs, and TW Core v1.0.0
  (in step with MOHW's current published version).
- The non-FHIR clinical tools among the 60 (lab interpretation, pill identification, package
  insert OCR + LLM, clinical calculators) give context no other FHIR MCP has.

### 2.2 Weaknesses relative to peers

| Weakness | Impact |
|---|---|
| `crud_fhir_server` only offers `metadata / read / search / create / update / patch / delete` | No `$everything`, `history`, `vread`, transaction bundle submission, remote `$validate`, or `next`-link pagination |
| No SMART App Launch (EHR launch / user context) | Locked out of the THAS marketplace and the certification lab's SMART app track |
| Validator can only warn on external ValueSets and `memberOf` | Hard to convince hospitals when results differ from the official HL7 validator |
| `audit.query_log` table exists but the backend never writes it | Audit is the first question every foundation and MOHW's generative-AI guideline asks |
| No PHI masking option | Missing last line of defence when an LLM reads real records |
| No CI running tests, no standalone GOVERNANCE / SECURITY / CoC files, no SBOM | Foundation entry requirements and MOHW's 2026-05 SBOM policy |

---

## 3. Optimisation roadmap

Principles: first close what everyone else has, then amplify what nobody has; every item maps to
a deliverable tool or file, and follows the existing design rule (multiple views over the same
data collapse into a `view` / `operation` parameter rather than new tools).

### Phase A — Table stakes (about 4–6 weeks)

| # | Item | Approach | Main files |
|---|---|---|---|
| A1 | New `crud_fhir_server` operations: `everything`, `history`, `vread`, `transaction` (submit a batch / transaction Bundle), `validate` (remote `$validate`), `page` (follow a `next` link) | Extend `operationToRequest()`; writes stay behind `confirm_write` and the allow-list; `transaction` counts as a write | `fhirServerService.ts`, `mcp.ts`, `docs/tools/fhir-server-tools.md` |
| A2 | `fhirpath_filter` parameter: apply a FHIRPath projection to responses to save tokens | `fhirpath` dependency already present | `fhirServerService.ts` |
| A3 | `fhir_describe_server_search`: list available search parameters and operations for a resource type from the CapabilityStatement (counterpart of WSO2 `get_capabilities`) | `capability_summary` is already stored; add parsing | `fhirServerService.ts` |
| A4 | Actually write `audit.query_log` (SHA-256 of params, tool name, duration, status) | Write from the shared MCP tool-call wrapper; table already in `db/schema.sql` | `mcp.ts`, new `auditService.ts` |
| A5 | CI: GitHub Actions running `npm run typecheck` and `npm test` (`node-server/` and `web/`) | Today only `deploy-docs.yml` exists | `.github/workflows/ci.yml` |

### Phase B — Amplify the national gap: TW Core conformance self-check suite (about 8–10 weeks)

| # | Item | Approach |
|---|---|---|
| B1 | **`fhir_run_conformance_suite`**: against a registered external server, sample per profile of a chosen IG (`search` → `validate`) and report must-support coverage, binding violations and slicing errors (OperationOutcome + summary) | Compose A1 with the existing `fhir_validate_resource`; borrow the test grouping of ONC Inferno and HL7 AU's AU Core Test Kit |
| B2 | Build a **regression suite** from the 98 official TW Core examples: the validator must pass all of them and catch deliberately broken variants | Lives in `node-server/src/fhirValidator.test.ts`; also the cheapest credibility evidence to show MOHW |
| B3 | **Official validator comparison mode (optional)**: a `validator: builtin \| hl7` switch, where `hl7` calls an optional Java sidecar container and returns results tagged with `source` | MOHW's validation guide points to `validator_cli.jar`; a comparison mode removes the "your validator differs from the official one" objection. Default stays in-process; compose defaults unchanged |
| B4 | Terminology delegation: on `TERMINOLOGY_SERVER_REQUIRED`, delegate to a configured external terminology server (tx.fhir.org, Ontoserver, a future MOHW terminology service); add `fhir_translate_code` (ConceptMap `$translate`; TW Core ships 6 ConceptMaps plus our local SNOMED↔ICD map) and `fhir_subsumes` (SNOMED descendant lookup already exists) | `fhirTerminology.ts`; settings in `admin.app_settings` |
| B5 | Import the NHI IG family (TWNHIBASE, PAS prior authorisation) as additional packages and demonstrate a full "cancer-drug prior authorisation Bundle" flow: ICD / drug → skeleton → validate → submit | Multi-IG architecture already supports it; must handle PAS depending on an older TW Core |
| B6 | Batch `fhir_normalize_code` with stronger provenance, aimed at MOHW's "chart → SNOMED / LOINC" LLM converter track | Return candidates, confidence, source ConceptMap / embedding distance for human review |

### Phase C — Differentiation nobody has (about 8 weeks, can run alongside B)

| # | Item | Why |
|---|---|---|
| C1 | **SMART on FHIR app packaging**: obtain patient context via EHR launch and offer a "coding / validation / medication lookup" sidebar backed by this project's tools | The only software type the certification lab certifies, and the entry to the THAS marketplace; the first cohort of 50 already included an ICD-10 auto-coding category |
| C2 | **`fhir_plan_search`**: given a resource type and a natural-language intent, return ranked, explained search-parameter combinations from the IG's SearchParameter artifacts and the server's CapabilityStatement | Zero implementations worldwide; we already store SearchParameters as artifacts |
| C3 | **`fhir_run_view_definition`**: run a SQL-on-FHIR ViewDefinition over a Bundle or search result and emit a table | Zero implementations worldwide; pure FHIRPath, feasible in-process; matches the indicator-reporting needs of the Healthy Taiwan Deep Cultivation programme |
| C4 | `redact: safe_harbor` option on `crud_fhir_server`: mask the 18 identifier classes before returning | Addresses the risk items in MOHW's 2026-05 generative-AI guideline for healthcare institutions |
| C5 | SBOM (CycloneDX) generated per release; `publiccode.yml` | MOHW's 2026-05 medical-AI SBOM policy; moda's public-code platform format |

### Phase D — Open-source governance (start with A, ongoing)

- `GOVERNANCE.md`, `CODE_OF_CONDUCT.md` (extracted from `CONTRIBUTING.md`), `SECURITY.md` (reporting address and SLA), DCO.
- OpenSSF Best Practices Passing badge (hard requirement for LF AI & Data Sandbox).
- Versioning: tag `v0.2.0` with a GitHub Release; update the CHANGELOG for the 49 → 60 tool delta.
- A public read-only hosted demo endpoint plus an MCP registry `server.json`, so "one URL is enough to try it".
- Find a **second contributing organisation** (hospital IT, a medical informatics department, an HL7 Taiwan member); every foundation's Incubation stage requires it.

---

## 4. Policy entry points at MOHW

| Entry point | Status (2026-10) | How we enter |
|---|---|---|
| Taiwan Medical Information Standards Platform: TWCDI / IG proposals | Briefing held 2025-11; 2026 schedule **[unverified]** | Submit the "open-source TW Core validation toolchain" as companion tooling for the IG; suggest adding an open-source licence to the TW Core IG sources (public today, but no LICENSE) |
| Taiwan Connectathon (run by MISAT) | 2026 edition ended in June | Enter the 2027 edition with the B1 self-check suite and offer "pre-connectathon self-check" to participating hospitals |
| National Digital Health Interoperability and Performance Certification Lab | Founded 2026-08-18; certifies only SMART on FHIR apps / CQL modules / TSPs | Submit the C1 SMART app; the FHIR server itself is outside the tracks, so do not propose under that identity |
| THAS national SMART app marketplace | First cohort awarded 2026-04 (50 of 115); second call **[unverified]** | Apply once C1 is complete |
| Healthy Taiwan Deep Cultivation programme, scope 3 (FY114–118) | Scoring includes "number of AI uses in SMART on FHIR mode" | Open-source projects are not funded directly; partner with an applying hospital and become the tool inside its proposal |
| NSTC smart-healthcare key technology programme | Deadline each February | Co-propose with an academic partner |
| moda *Public-Sector Open Source Software Playbook* (2026-04) | Published CC0 | Cite it in proposals as the policy basis for an agency adopting an MIT project |

**Proposal narrative (one sentence):** "A TW Core v1.0.0-compatible, self-hostable, MIT-licensed
FHIR validation and terminology toolchain that lets hospitals use an AI assistant to self-check and
fix data quality before the 2026–2027 interoperability deadlines, delivered as a SMART on FHIR app
into national certification and the marketplace."

**Boundaries to state up front:**

- This project is a **tool layer**, not an autonomous agent; every tool is read-only, and the one
  writing tool, `crud_fhir_server`, needs double confirmation. This matches the 2026-05
  generative-AI guideline's line that "AI agent systems are not yet in scope".
- The validator is a **pre-check** and does not replace the official HL7 validator; B3's comparison
  mode exists precisely so that claim can be tested.
- No diagnostic claims, to stay outside the software-as-medical-device definition.

---

## 5. Open-source foundation path

| Organisation | Fit | Entry requirements | Recommendation |
|---|---|---|---|
| **Open Health Stack Software Foundation** (LF, founded 2026-07, backed by Google.org and WHO) | High | Newly founded, rules pending; has an Implementer Program | **First choice**; approach as a FHIR tooling contributor |
| **LF AI & Data (Sandbox)** | Medium | OSI licence, sponsorship by an existing member, technical charter, OpenSSF Passing, DCO; Incubation needs ≥ 3 contributing organisations and ≥ 500★ | Propose Sandbox after Phase D |
| **HL7 Taiwan** | High | Organisational membership approved by the board | Join now to gain standing for IG proposals and connectathons |
| **Open Culture Foundation (OCF)** | High (local) | Fiscal sponsorship, trademark and legal protection | Use OCF if accepting government contracts or donations without forming an entity |
| OpenJS Foundation | Medium-low | Two CPC sponsors | Fallback |
| Apache Incubator | Low | Requires Apache-2.0, a Champion, diverse committers | Not recommended |
| Twinkle AI community | High | None | Co-list on Twinkle Hub, cross-reference each other |

Licensing: MIT is accepted across the LF family; only Apache requires a licence change. If patent
protection becomes a concern, Apache-2.0 can be evaluated later, but it affects existing forks and
is not urgent.

---

## 6. Comparable precedents (evidence for proposals)

| Country | Tool | Licence | Operator |
|---|---|---|---|
| USA | ONC Inferno ((g)(10) certification test site) | Apache-2.0 | MITRE / ONC |
| Australia | AU Core Inferno Test Kit, Sparked | Apache-2.0 | CSIRO / HL7 AU |
| Germany | gematik Referenzvalidator | Apache-2.0 | gematik |
| International | HL7 FHIR Validator (`org.hl7.fhir.core`) | Apache-2.0 | HL7 |
| Taiwan | TW Core IG sources | **no licence file** | Outsourced by MOHW's Department of Information Management (mainly ITRI) **[partially verified]** |

Taiwan's 2020 mask-availability map, where the government supplied data and the civic community
supplied tools, is structurally identical to how this project uses TFDA and NHI open data, and is
the local precedent MOHW will recognise most readily.

---

## 7. Items needing a manual check

- 2026 TWCDI / IG proposal briefing and the second THAS call schedule.
- Certification lab application process and fees.
- Whether FHIR Box and MOHW's LLM standards converter will be released as open source.
- Second-round call of the Responsible AI Execution Center in 2026.
- Current HL7 Taiwan membership fees and application form.
- Whether moda's code.gov.tw accepts non-government projects.
- Formal membership rules of the Open Health Stack Software Foundation.

---

## 8. Sources

International projects:
[wso2/fhir-mcp-server](https://github.com/wso2/fhir-mcp-server) ·
[langcare/langcare-mcp-fhir](https://github.com/langcare/langcare-mcp-fhir) ·
[pcmedsinge/fhir-mcp-suite](https://github.com/pcmedsinge/fhir-mcp-suite) ·
[the-momentum/fhir-mcp-server](https://github.com/the-momentum/fhir-mcp-server) ·
[Medplum MCP](https://www.medplum.com/docs/ai/mcp) ·
[Aidbox MCP](https://www.health-samurai.io/docs/aidbox/modules/other-modules/mcp) ·
[Google Cloud Healthcare API × MCP Toolbox](https://docs.cloud.google.com/healthcare-api/docs/tutorials/pre-built-tools-with-mcp-toolbox) ·
[awslabs/mcp healthlake-mcp-server](https://github.com/awslabs/mcp/tree/main/src/healthlake-mcp-server) ·
[aehrc/mcp-fhir-tools](https://github.com/aehrc/mcp-fhir-tools) ·
[rlinlen/fhir-validator-agent](https://github.com/rlinlen/fhir-validator-agent) ·
[healthchainai/HealthChain](https://github.com/healthchainai/HealthChain) ·
[faulkj/fhirHydrant](https://github.com/faulkj/fhirHydrant) ·
[aks129/HealthClawGuardrails](https://github.com/aks129/HealthClawGuardrails) ·
[medvertical/records-agent-tools](https://github.com/medvertical/records-agent-tools) ·
[awesome-healthcare-mcp-servers](https://github.com/rdmgator12/awesome-healthcare-mcp-servers)

Taiwan policy:
[TW Core IG v1.0.0](https://twcore.mohw.gov.tw/ig/twcore/index.html) ·
[TW Core validation guide](https://twcore.mohw.gov.tw/ig/twcore/validates.html) ·
[MOHW_TWCoreIG_Build sources](https://github.com/cctwFHIRterm/MOHW_TWCoreIG_Build) ·
[NHI FHIR IGs (TWNHIFHIR)](https://github.com/TWNHIFHIR) ·
[Taiwan Medical Information Standards Platform](https://medstandard.mohw.gov.tw/) ·
[National Digital Health Certification Lab](https://medstandard.mohw.gov.tw/digital-health-cert-lab-2026) ·
[FHIR introduction and proposal briefing (2025-11)](https://dep.mohw.gov.tw/DOIM/cp-936-84314-114.html) ·
[2026 Taiwan Connectathon](https://dep.mohw.gov.tw/DOIM/cp-936-86750-114.html) ·
[Taiwan Top 50 SMART Apps](https://blog.mohw.gov.tw/2058/) ·
[FHIR Box (NSTC 21st board meeting)](https://www.mohw.gov.tw/cp-7399-86614-1.html) ·
[Medical-centre interoperability deadline (CNA)](https://www.cna.com.tw/news/ahel/202604130151.aspx) ·
[Generative-AI guideline for healthcare institutions (Lee and Li summary)](https://www.leeandli.com/TW/Newsletters/7656.htm) ·
[Medical-AI SBOM policy (iThome)](https://www.ithome.com.tw/news/175594) ·
[Healthy Taiwan Deep Cultivation programme](https://htsprout.nhri.org.tw/UploadFile/DHPlan_1140227.pdf) ·
[moda Public-Sector Open Source Software Playbook](https://moda.gov.tw/digital-affairs/democracy-network/services/19352)

Foundations and precedents:
[Open Health Stack Software Foundation](https://blog.google/innovation-and-ai/technology/health/open-health-stack-software-foundation/) ·
[LF AI & Data project lifecycle](https://github.com/lfai/proposing-projects/blob/master/ProjectLifecycle.md) ·
[OpenJS project progression](https://github.com/openjs-foundation/cross-project-council/blob/main/PROJECT_PROGRESSION.md) ·
[HL7 Taiwan](http://www.hl7.org.tw/) ·
[Open Culture Foundation](https://ocf.tw/p/ocf) ·
[ONC Inferno](https://github.com/inferno-framework/inferno-core) ·
[Inferno AU Core](https://inferno.hl7.org.au/) ·
[gematik Referenzvalidator](https://github.com/gematik/app-referencevalidator)

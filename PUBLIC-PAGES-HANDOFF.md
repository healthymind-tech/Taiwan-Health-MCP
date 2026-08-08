# Public Marketing Pages — Handoff Spec

**Source repo:** `Taiwan-Health-MCP` (branch `main`, at commit `9dd6ad4`)
**Purpose:** hand this to the agent building the standalone marketing site. It describes
every public-facing page currently bundled inside the MCP server product, what each page
is for, what it contains, and what it depends on.
**End goal:** the new site owns these pages; this repo deletes them.

---

## 1. TL;DR

Four public pages ship inside the product today. **None of them are React.** They are
verbatim static HTML documents under `web/legacy/`, extracted unchanged from the old
Python `src/server.py` during the Node migration. The Next.js layer around them is 101
lines of glue that reads the file off disk and returns it.

| Route | File | Lines | Kind | Backend dependency |
|---|---|---|---|---|
| `/` | `web/legacy/landing.html` | 588 | Marketing landing page | None (`force-static`) |
| `/status` | `web/legacy/status.html` | 747 | **Interactive MCP tool tester** | **Yes** (`force-dynamic`) |
| `/privacy` | `web/legacy/privacy.html` | 116 | Legal — privacy policy | None |
| `/dpa` | `web/legacy/dpa.html` | 193 | Legal — data processing agreement | None |

Total: **1,691 lines of HTML + 101 lines of glue.**

Three of the four are pure content and move cleanly. `/status` is not a marketing page at
all — see §6 for the decision it forces.

---

## 2. How the pages are wired today

```
GET /          → web/app/route.ts         (8 lines)  → loadLegacy("landing.html")
GET /privacy   → web/app/privacy/route.ts (8 lines)  → loadLegacy("privacy.html")  + withDarkMode()
GET /dpa       → web/app/dpa/route.ts     (8 lines)  → loadLegacy("dpa.html")      + withDarkMode()
GET /status    → web/app/status/route.ts  (30 lines) → loadLegacy("status.html")
                                                       + fetch backend /status.json
                                                       + string-replace 3 placeholders
```

`web/lib/legacy.ts` (47 lines) is the only helper. It does three things:

1. `loadLegacy(name)` — `fs.readFileSync(process.cwd()/legacy/<name>)`.
2. `withDarkMode(html)` — injects a `<script>` + `<style>` block before `</head>`.
   Applied to **privacy and dpa only**, because those two shipped light-only; landing and
   status carry their own dark-mode CSS inline.
3. `htmlResponse(html)` — sets `content-type: text/html; charset=utf-8`.

There is no shared stylesheet, no component library, no build step for these pages. Every
page inlines its own complete `<style>` block.

**Build plumbing that exists only for these files:**
- `web/next.config.js:10` — `experimental.outputFileTracingIncludes` forces `./legacy/**/*`
  into the standalone bundle for the `/` and `/status` routes.
- `web/Dockerfile:20` — `COPY --from=builder /app/legacy ./legacy`.

---

## 3. Page specs

### 3.1 `/` — Landing page (`landing.html`, 588 lines)

Static marketing page. Rendering mode `force-static`. Nine blocks in order:

| # | Block | Contents |
|---|---|---|
| 1 | `nav` | Sticky. `logo-h.png` linking to `/`, then anchor links: Overview, Features, Modules, Examples, Setup, Auth, Support, plus `/status`. |
| 2 | `.hero #top` | H1 "Taiwan Health / MCP Server". Tagline: *"An open-source Model Context Protocol server that gives AI assistants structured, read-only access to Taiwan's medical and clinical knowledge for Taiwan healthcare workflows."* Endpoint box showing `https://tw-health-mcp.healthymind-tech.com/mcp`. Badge row: `51 Tools`, `ICD-10-CM 2025`, `LOINC 2.80`, `SNOMED CT`, `Taiwan FDA`, `TWCore IG v1.0`, `FHIR R4`. |
| 3 | `#description` | Two paragraphs. Para 1: who it is for (clinicians, researchers, developers, health-tech products) and what they can query. Para 2: privacy stance — no PHI collected; audit logs store tool name + SHA-256 param hash only. |
| 4 | `#features` | 5 cards, each an emoji icon + blurb + 5-bullet list: **🏥 Medical Coding**, **🧪 Lab Interpretation**, **📋 Clinical Guidelines**, **🍎 Food & Nutrition**, **⚕️ FHIR R4**. |
| 5 | `#modules` | 7-row table (Module / Version-Source / Sync): ICD-10-CM & PCS, LOINC, SNOMED CT International, TFDA Health Supplements, Taiwan Food Nutrition, TWCore IG, Taiwan Clinical Guidelines. |
| 6 | `#examples` | 5 worked scenarios. Each = a Chinese user prompt in a highlighted box + a 4-step `<ol>` of what the server does. Topics: (1) diagnosis lookup + clinical guidance, (2) lab result interpretation, (3) FHIR resource generation, (4) nutrition analysis, (5) health supplement search. |
| 7 | `#setup` | 4 numbered steps: visit `claude.com/connectors` → search "Taiwan Health" → click Connect (no account/OAuth) → or add the MCP endpoint to Claude Desktop config directly. |
| 8 | `#authentication` | Green callout "✓ No authentication required." Followed by a paragraph explaining the single-writer exception: `crud_fhir_server` writes only to an operator-registered *external* FHIR server, only for allow-listed operations, only with `confirm_write=true`. |
| 9 | `#support` + `footer` | 6 link cards: GitHub repo, Report an Issue, Status & Tool Tester, Privacy Policy, DPA, Email support. Footer repeats Status / Privacy / DPA / GitHub + "MIT License". |

### 3.2 `/status` — Status & Tool Tester (`status.html`, 747 lines)

**This is a functional application, not marketing.** Rendering mode `force-dynamic`.
Roughly 500 of its 747 lines are JavaScript.

**Layout:** header (`logo-s.png`, title, live "N / M tools available" counter, links to
`/` and `/privacy`) over a two-pane body — left: search box + category filter chips +
tool list; right: detail pane with a generated form and a result viewer.

**Server-side data flow** (`web/app/status/route.ts`):
fetches `${BACKEND_INTERNAL_URL}/status.json` (default `http://localhost:8000`), then
string-replaces three placeholders in the HTML:

| Placeholder | Becomes |
|---|---|
| `"__CATEGORY_MAP__"` | `{ toolName: groupName }` for all 49 tools |
| `"__TOOL_EXAMPLES__"` | default argument payload per tool |
| `"__TOOL_SELECTOR_EXAMPLES__"` | alternate arg sets keyed by a tool's mode/type enum |

If the backend is unreachable it renders with empty objects rather than 500-ing.

**Client-side behaviour:** it speaks real MCP JSON-RPC over `fetch('/mcp')` —
`initialize` → `notifications/initialized` → `tools/list` → `tools/call`. It handles both
`application/json` and `text/event-stream` responses (full SSE reader), tracks the
`mcp-session-id` header, generates an input form from each tool's JSON Schema (string /
number / boolean / enum / array / object field types), and renders the response as a
collapsible JSON tree with expand-all / collapse-all / copy. Tools present in
`CATEGORY_MAP` but absent from `tools/list` render as greyed-out "unavailable" — that is
how it visualises the module row-count gating.

**Backend contract it depends on:** `GET /status.json`, served by
`node-server/src/server.ts:159`, whose payload is a hardcoded single-line JSON string
constant in `node-server/src/statusData.ts` (8 lines, one enormous literal). Note this is
a **static snapshot, regenerated by hand** — it is not derived live from the tool
registry, so it can and does drift from the real tool set.

### 3.3 `/privacy` — Privacy Policy (`privacy.html`, 116 lines)

Pure legal text, no JS. Header: *Effective date 2025-01-01 | Last updated 2026-04-09*.
Ten sections:

1. **Overview** — what the service is; `crud_fhir_server` carve-out from "read-only".
2. **Data We Collect** — no PII. `audit.query_log` holds tool name, SHA-256 param hash, duration, status, timestamp. Raw values never logged.
3. **Data Sources** — ICD-10 (NLM/CMS, public domain), LOINC 2.80 (Regenstrief), SNOMED CT International, TFDA open data, TWCore IG (MoHW).
4. **How Data Is Used** — no training, profiling, or advertising.
5. **Third-Party Data Processing** — Anthropic telemetry disclaimer, links to Anthropic's privacy policy.
6. **Data Retention** — audit logs 90 days; Redis TTL 1–24 h.
7. **No Authentication Required** — no accounts, tokens, cookies, or identifiers.
8. **Your Rights** — no PII, therefore no subject requests.
9. **Changes to This Policy**
10. **Contact** — GitHub issues + `support@healthymind-tech.com`.

### 3.4 `/dpa` — Data Processing Agreement (`dpa.html`, 193 lines)

Pure legal text, no JS. Header: Service / Operator (**HealthyMind Tech**) / same dates.
Thirteen sections:

1. **Parties and Scope**
2. **Nature of Processing** — read-only API; `crud_fhir_server` exception; operator-as-controller note.
3. **Categories of Data Processed** — 5-row table (category / source / retained?): tool call metadata (90 d), SHA-256 param hash (90 d), query strings (transient), Redis cache (TTL), PHI (not collected).
4. **Purpose and Legal Basis** — legitimate interest.
5. **Data Minimisation and HIPAA Design** — hash-only audit trail, HIPAA safe-harbour framing.
6. **Sub-processors** — 3-row table: self-hosted PostgreSQL 16, self-hosted Redis 7, Anthropic.
7. **International Transfers** — hosted in Taiwan; Anthropic may process in the US.
8. **Security Measures** — 5 bullets: TLS, network isolation, pgBouncer, internal-only metrics, append-only audit schema.
9. **Data Subject Rights** — 30-day investigation commitment.
10. **Breach Notification** — 72 hours.
11. **Retention and Deletion**
12. **Contact and Governing Law** — Taiwan (R.O.C.); Taiwan Taipei District Court.
13. **Changes to This Agreement**

---

## 4. Shared assets, branding, and design tokens

**Assets** (served from `web/public/`):

| File | Used by |
|---|---|
| `logo-h.png` (horizontal) | landing, privacy, dpa navs — **also `web/app/admin/login/page.tsx:77`** |
| `logo-s.png` (square) | status header only |
| `favicon.png` | all four pages — **also `web/app/layout.tsx:17`** |
| `favicon.ico` | — |

> `logo-h.png` and `favicon.png` are shared with the admin console and **must stay in this
> repo**. Copy them to the new project; do not move them.
> (`static/logo-h.png` and `static/logo-s.png` at the repo root are unreferenced
> Python-era duplicates.)

**Hardcoded values the new site must own:**

- Production MCP endpoint: `https://tw-health-mcp.healthymind-tech.com/mcp`
- GitHub: `https://github.com/healthymind-tech/Taiwan-Health-MCP` (+ `/issues`)
- Email: `support@healthymind-tech.com`
- Operator entity: **HealthyMind Tech**
- Legal dates: effective `2025-01-01`, last updated `2026-04-09`
- Anthropic connector directory: `https://claude.com/connectors`

**Design tokens** (extracted from the inline styles — the four pages are visually consistent):

| Token | Light | Dark |
|---|---|---|
| Accent | `#0066cc` | `#5aa2ff` |
| Page background | `#fff` | `#0f1115` |
| Body text | `#1a1a1a` / `#222` | `#e6e8eb` |
| Muted text | `#555` / `#666` | `#aab2bf` / `#9aa3b2` |
| Border | `#e5e7eb` | `#262b35` |
| Surface / table head | `#f6f8fb` | `#161b22` |
| Badge | bg `#e8f0fe`, fg `#1a56cc` | bg `#16263f`, fg `#7cb7ff` |

Font: `system-ui, -apple-system, sans-serif`. Content column: `max-width: 900px`.
Line-height `1.7`. Breakpoints: 768 / 600 / 400 px.

**Dark mode:** driven by `document.documentElement.dataset.theme`, set by an inline
no-flash script that reads `localStorage['admin-theme']` and falls back to
`prefers-color-scheme`. That key is **shared with the admin console** — an artifact of
living in the same origin. The new standalone site should pick its own key.

---

## 5. Content accuracy — MUST FIX before reuse

The existing copy has drifted from the product. **Do not port it verbatim.**

1. **Tool count is wrong.** Landing says `51 Tools` (hero badge) and *"The remaining 50
   tools are read-only"*; DPA §2 says *"Of the 51 tools, 50 perform read-only lookups"*.
   The real number is **49** — 48 read-only plus `crud_fhir_server`.

2. **The Clinical Guidelines module no longer exists.** It was removed in commit
   `0879b65` ("remove clinical guideline module"). Still referenced in three places:
   the 📋 Clinical Guidelines feature card, the "Taiwan Clinical Guidelines" row in the
   Modules table, and step 2 of landing Example 1. Privacy §1 also still lists "Taiwan
   clinical guideline data" as a source.

3. **The Drug / TFDA module is missing entirely.** It is now the largest and most
   distinctly Taiwanese part of the product — TFDA licence index, TFDA crawler, drug
   assets in object storage, and a MinerU OCR + LLM pipeline that extracts structured
   data from drug package inserts. It has 4 MCP tools (`search_drug`,
   `identify_unknown_pill`, `get_drug_details`, `get_drug_asset_links`) and appears on
   neither the feature cards nor the Modules table. This is the biggest content gap.

**Current accurate module list** (11 tool groups / 49 tools): ICD-10 (5), Drug/TFDA (4),
Lab/LOINC (4), SNOMED CT (4), FHIR R4 Condition (2), FHIR R4 Medication (2), FHIR IG (19),
Health Supplements (1), Food Nutrition (4), FHIR Servers (3), System (1).

Also worth knowing for accurate copy: **tools appear and disappear based on loaded data.**
`node-server/src/moduleStatus.ts` gates each group on a row-count threshold (ICD ≥ 10,000;
SNOMED ≥ 100,000; LOINC ≥ 1,000; drug/IG ≥ 1), so a given deployment exposes a subset.
FHIR Servers and `health_check` are always registered.

---

## 6. Decision required: what happens to `/status`

`/status` is a working tool playground, not marketing. Three options:

**A — Leave it in the product (recommended).** The new site links out to
`https://<product-host>/status`. Nothing changes on the backend; no CORS work. The new
marketing site stays 100% static and can deploy anywhere.

**B — Move it to the marketing site.** Then the new site's JS calls `/mcp` and
`/status.json` **cross-origin**. Requires: CORS on both endpoints for the marketing
origin, and awareness that `POST /tools/*` and `/openapi.json` already have a CORS +
optional-bearer layer (`node-server/src/publicToolsSecurity.ts`) while `/mcp` currently
sits behind the same middleware. Extra risk for little marketing gain.

**C — Drop it.** Simplest. The tool tester's job is arguably already served by the admin
console. Removes `/status.json` and `statusData.ts` from the backend too.

The removal checklist in §7 marks which steps are conditional on this choice.

---

## 7. Removal checklist for this repo

**Always delete:**

- [ ] `web/legacy/landing.html`, `privacy.html`, `dpa.html`
- [ ] `web/app/route.ts`, `web/app/privacy/route.ts`, `web/app/dpa/route.ts`
- [ ] `web/lib/legacy.ts` — *unless* `/status` stays (it is the only remaining consumer)
- [ ] `web/next.config.js:8-11` — drop the `experimental.outputFileTracingIncludes` block
- [ ] `web/Dockerfile:20` — drop `COPY --from=builder /app/legacy ./legacy` (and adjust the comment on line 16)
- [ ] `docs/deployment/privacy.md` and `docs/deployment/dpa.md` document the removed routes — update or delete, and remove their `mkdocs.yml` nav entries (lines 81–82)
- [ ] Grep `README.md` and `docs/` for `/status`, `/privacy`, `/dpa` links and repoint them at the new site

**Only if `/status` is also removed (option C):**

- [ ] `web/legacy/status.html`, `web/app/status/route.ts`, `web/lib/legacy.ts`
- [ ] `web/next.config.js` — the `/status.json` rewrite
- [ ] `node-server/src/statusData.ts` and its `GET /status.json` handler (`server.ts:159`)
- [ ] `nginx/nginx.conf:62` — `location = /status.json`
- [ ] `web/public/logo-s.png` (status page is its only consumer)

**Must NOT be deleted:**

- `web/app/layout.tsx` — the admin SPA renders inside it
- `web/app/admin/**`, `web/middleware.ts`
- `web/public/logo-h.png`, `web/public/favicon.png` — used by the admin login page and root layout
- `nginx.conf`'s `location / → web` — still needed to serve `/admin`

**Open question to resolve before shipping the removal:** once `/` is gone, the Next.js
app 404s at the root. Decide whether nginx should 301 `/`, `/privacy`, `/dpa` to the new
marketing site, or redirect `/` → `/admin`. Anthropic's connector directory listing points
at the current `/privacy` URL, so a **permanent redirect is safer than a 404**.

---

## 8. What the new project needs from this repo

Copy over, then adapt:

1. `web/legacy/*.html` — the four documents, as content reference (see §5 before reusing copy).
2. `web/public/logo-h.png`, `logo-s.png`, `favicon.png`, `favicon.ico` — copies, not moves.
3. The design tokens in §4, if visual continuity with the admin console matters.

The new site needs **no runtime dependency on this repo** if `/status` stays behind
(option A). It is a fully static site: four pages, no API calls, no build-time data
fetching.

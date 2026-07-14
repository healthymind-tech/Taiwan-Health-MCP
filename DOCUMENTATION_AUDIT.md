# Documentation & Website Audit

**Date:** 2026-07-14
**Trigger:** the backend was migrated from Python to Node/TypeScript across several
agent sessions (finished in `e25fa9d`). Documentation and the public pages were not
updated with it.

**Source of truth used:** the running stack (`docker compose ps`, live
`GET /openapi.json`, live Postgres), `compose.yaml`, `nginx/nginx.conf`,
`node-server/src/**`, `web/**`, `Dockerfile*`, `.github/workflows/deploy-docs.yml`,
`db/schema.sql`. No documentation was trusted as evidence of behaviour.

---

## 1. How the GitHub Pages website is built and deployed

| Aspect | Finding |
|---|---|
| Generator | **MkDocs + Material theme** (`mkdocs.yml`, `theme.name: material`) |
| Content source | `docs/` (55 Markdown files) |
| Build | `.github/workflows/deploy-docs.yml` → `mkdocs build` → `./site` |
| Deploy | `peaceiris/actions-gh-pages@v3`, `publish_dir: ./site` → pushes to the **`gh-pages` branch** |
| Trigger | `push` to `main`, limited to `docs/**`, `mkdocs.yml`, `.github/workflows/deploy-docs.yml` |
| Permissions | `contents: write` (correct for the branch-push method) |
| Python | 3.11; deps installed inline: `mkdocs mkdocs-material pymdown-extensions mike` |
| Build output | `site/` — **untracked, generated. Never edit by hand.** |
| `.nojekyll` | Not in the repo; `peaceiris/actions-gh-pages` writes one into the published branch automatically. No action needed. |
| CNAME / custom domain | None configured. |

**Defect found in the site configuration:** `mkdocs.yml` points `site_url`, `repo_url`
and `repo_name` at **`audi0417/Taiwan-Health-MCP`** / `Taiwan-ICD10-Health-MCP`, but the
repository's actual remote is **`healthymind-tech/Taiwan-Health-MCP`**. Every "edit this
page" and repo link on the published site therefore points at the wrong GitHub
repository, and `site_url` (canonical URLs + sitemap) is wrong.

**Note on `requirements-docs.txt`:** it pins `mkdocs-minify-plugin` and
`mkdocs-git-revision-date-localized-plugin`, which are **not installed by the workflow and
not enabled in `mkdocs.yml`**. Unused by CI; it only affects local preview.

---

## 2. Pages that are published but not in the navigation

MkDocs builds **every** `.md` under `docs/`, whether or not it appears in `nav`. These
four are live on the public site with no nav entry, and all four are historical planning
documents describing work that is now finished:

- `docs/datasets.md`
- `docs/node-migration-assessment.md`
- `docs/node-backend-full-refactor-plan.md`
- `docs/admin-datasets-redesign.md`

---

## 3. The core discrepancy

The documentation describes a **Python backend that no longer exists.**

Verified current state:

- `git ls-files '*.py'` → **empty**. There is no Python anywhere in the tree.
- `requirements.txt`, `loader/` and `src/*.py` are deleted.
- `app` = `node dist/server.js`; `admin-worker` = `node dist/admin/adminWorker.js`.
- `tests/` and `scripts/` contain **only stale root-owned `__pycache__`** — the pytest
  suite the docs describe is gone. The only test in the repo is
  `node-server/src/loaders/loinc.test.ts`, run with `npm test` (verified: 1 test, passes).
- `pytest.ini`, `requirements-dev.txt` and `pyproject.toml` (black/isort) still configure a
  Python toolchain that has nothing left to act on.

### The entry point changed, and every documented URL is wrong

`compose.yaml` gives the `app` service **`expose: 8000`, not `ports:`** — port 8000 is
**not published to the host**. The only front door is **nginx on `${WEB_PORT:-8080}`**,
which routes `/mcp`, `/openapi.json`, `/tools/*`, `/status.json`, `/admin/api/*`,
`/admin/ws`, `/fhir-client/*` and `/fhir-oauth/*` to `app`, and everything else (public
pages + the `/admin` SPA) to the `web` Next.js service.

Every `http://<host>:8000/...` URL in the documentation is therefore unreachable.
(During the audit `localhost:8000` *did* answer — it is an **unrelated host process**, not
this stack. That coincidence is plausibly how the error survived.)

The `web` and `nginx` services are **absent from every documented service list**.

### Other verified drift

| Claim in docs | Reality |
|---|---|
| Embeddings configured via `OLLAMA_BASE_URL` | That env var **does not exist in the code**. Embedding / OCR / Analysis-LM endpoints live in `admin.llm_profiles`, managed in the admin console. |
| `config/datasets.yaml` sets source paths | **Read by no code.** Node loaders use `FHIR_CODE_DIR` / `*_ZIP` env overrides; in production the admin console stages sources from MinIO. |
| Admin SPA is `admin-ui/` | The live SPA is **`web/admin-app/`**. `admin-ui/` (58 tracked files) is referenced by **no build** — dead. |
| `/privacy` + `/dpa` served by `PrivacyPageMiddleware` in `src/server.py` | Served by the **Next.js `web` service** (`web/app/privacy/route.ts`, `web/app/dpa/route.ts`; content in `web/legacy/*.html`). |
| Drug pipeline is a Python shim in a polyglot worker (CLAUDE.md) | Fully native TypeScript (`loaders/drugIndex.ts`, `drugEnrichment.ts`, `drugAnalysis.ts`). OCR is an external **MinerU** HTTP service. |
| Backend `/health` endpoint | Exists on `app` but is **not routed by nginx** (404 through the front door). Use `/status.json`. |

---

## 4. Unsupported public-facing claims (highest severity)

On the **public product pages** served by `web` — the compliance-facing pages submitted
for the Anthropic Connectors Directory review:

1. **`web/legacy/landing.html:530` and `web/legacy/dpa.html:62`** — *"All 28 tools are
   read-only. The server does not accept writes…"*
   - The tool count is **51**, not 28 (verified against the live `/openapi.json`).
   - The read-only claim is **false**: `crud_fhir_server` performs `create` / `update` /
     `patch` / `delete` against external FHIR servers (`fhirServerService.ts:30`
     `WRITE_OPERATIONS`; `POST`/`PUT`/`PATCH`/`DELETE` builders at lines 423–443). Writes
     are gated by `confirm_write=true` and an admin-configured allow-list — but they exist.
   - This is a factual misstatement on a data-protection page: the most important fix here.
2. **`web/legacy/landing.html:223`** — the hero badge reads **"24 Tools"**, contradicting
   the same page's "28 tools" three hundred lines below. Both are wrong.

---

## 5. File inventory and status

Legend: **Accurate** · **Minor** · **Major** (rewrite) · **Obsolete** · **Generated**

### Root documentation

| File | Published? | Status | Required change |
|---|---|---|---|
| `README.md` | No (GitHub) | **Major** | Python badge + `mcp`/FastMCP SDK claim, `audi0417` clone URL, `:8000` endpoints, missing `web`/`nginx`, `pip install -r requirements.txt` + pytest section |
| `CLAUDE.md` | No | **Major** | "READ FIRST" banner still claims a Python drug shim + polyglot worker; service table lists `src/*.py`; `OLLAMA_BASE_URL`; `admin-ui/` |
| `AGENTS.md` | No | **Major** | Describes `src/*.py`, `loader/main.py`, pytest, PEP 8 / Black, `config/datasets.yaml` — none exist |
| `CONTRIBUTING.md` | No | **Major** | Python 3.12 venv + `pip install` + pytest workflow |
| `SESSION_HANDOFF.md` | No | Accurate (historical) | Point-in-time handoff; leave as-is |
| `src/README.md` | No | **Obsolete** | Describes 11 deleted `*_service.py` files and "最多 24 tools"; `src/` now holds only `prompts/` |
| `node-server/README.md` | No | **Major** | Says "Phase 0 — base layer + MCP stub only"; it is now the entire backend |
| `admin-ui/README.md` | No | **Obsolete** | Directory is dead; superseded by `web/admin-app/` |
| `.env.example` | No | **Minor** | Missing `WEB_PORT`, `PUBLIC_BASE_URL`, `FHIR_SERVER_SECRET_KEY`, `DRUG_AUTOCHAIN_BATCH_LIMIT`; claims pgBouncer is on 6432 (it is 5432); password-hash recipe uses `python` |

### GitHub Pages content (`docs/`)

| File | In nav | Status | Required change |
|---|---|---|---|
| `docs/index.md` | ✓ | **Minor** | "以官方 `mcp` SDK 建構" → Node MCP SDK; architecture summary lacks `web`/`nginx` |
| `docs/getting-started.md` | ✓ | **Major** | `:8000` endpoints, service list, `loader/main.py` note, pytest verification block, python hash recipe |
| `docs/deployment/index.md` | ✓ | **Major** | "Python 版本 3.12+"; service list missing `web`/`nginx` |
| `docs/deployment/configuration.md` | ✓ | **Major** | Env table covers a fraction of the real set; Claude Desktop `stdio` example runs `python src/server.py`; `:8000` URLs |
| `docs/deployment/performance.md` | ✓ | **Minor** | asyncpg → `pg` |
| `docs/deployment/privacy.md` | ✓ | **Major** | `/privacy` is served by `web`, not `PrivacyPageMiddleware` / `_PRIVACY_HTML` |
| `docs/deployment/dpa.md` | ✓ | **Major** | Same — served by `web`; `:8000` proxy example |
| `docs/architecture/deployment.md` | ✓ | **Major** | Mermaid diagram omits `nginx` + `web`; calls the app "mcp SDK, port 8000" |
| `docs/development/index.md` | ✓ | **Major** | Project-structure list is entirely the old Python layout |
| `docs/development/testing.md` | ✓ | **Major (fictional)** | Documents `tests/test_api_integration.py`, "30 個 tool", pytest classes — **none of this exists** |
| `docs/development/code-style.md` | ✓ | **Major** | "Python Style Guide", PEP 8, Python snippets |
| `docs/development/contributing.md` | ✓ | Accurate | Links only |
| `docs/admin/index.md` | ✓ | **Major** | `src/admin_*.py`, `src/db_health.py`, `admin-ui/`; missing passkeys + LLM-profiles surfaces |
| `docs/admin/jobs-and-worker.md` | ✓ | **Major** | Every component named as `src/admin_*.py` |
| `docs/api/index.md` | ✓ | **Major** | Service table lists Python modules; no mention of the actual HTTP surface |
| `docs/api/{icd,lab,guideline}-service.md`, `api/fhir-services.md` | ✓ | **Minor** | asyncpg / `server.py` lifespan references |
| `docs/tools/*.md` (10 files) | ✓ | **Accurate** | Verified: all 51 tool names match the live `/openapi.json` exactly |
| `docs/modules/*.md` (10 files) | ✓ | **Minor** | Service-file names; content otherwise current |
| `docs/data-sources/*.md` (5 files) | ✓ | **Minor** | `test-data.md` is new and accurate; `index.md` says embeddings "需 Ollama" (now profile-driven) |
| `docs/guides/*.md`, `docs/faq/*.md` | ✓ | **Accurate** | No stale implementation references found |
| `docs/fhir-*.md` (4 files) | ✓ | **Minor** | `fhir-ig-mcp-toolset-assessment.md` references `requirements.txt` / Python |
| `docs/datasets.md` | ✗ (published, unlinked) | **Historical** | 935-line module reference written against the Python loaders |
| `docs/node-migration-assessment.md` | ✗ | **Historical** | Plan for work now complete |
| `docs/node-backend-full-refactor-plan.md` | ✗ | **Historical** | Same |
| `docs/admin-datasets-redesign.md` | ✗ | **Historical** | "Status: Planning" — the redesign shipped |

### Website / static assets

| File | Status | Required change |
|---|---|---|
| `web/legacy/landing.html` | **Major** | "24 Tools" badge; "All 28 tools are read-only" (§4) |
| `web/legacy/dpa.html` | **Major** | "All 28 tools … read-only" (§4) |
| `web/legacy/privacy.html` | **Minor** | "read-only access" framing needs the `crud_fhir_server` carve-out |
| `web/legacy/status.html` | Accurate | Status data is fetched live from the backend |
| `mkdocs.yml` | **Major** | Wrong `site_url` / `repo_url` / `repo_name` (§1) |
| `.github/workflows/deploy-docs.yml` | Accurate | Syntax, trigger, permissions and publish dir verified correct |
| `site/` | **Generated** | Untracked build output — do not edit |

### Screenshots / diagrams

- **No screenshots exist anywhere in the repo or the docs.** Nothing to replace; no broken
  image paths found.
- One diagram: the Mermaid graph in `docs/architecture/deployment.md`. It is stale (no
  `nginx`, no `web`) and is authored inline in the Markdown — there is no separate diagram
  source file to regenerate.
- Site branding assets (`web/public/logo-*.png`, `favicon.*`) are current and correctly
  referenced.

---

## 6. Suspected code defects (documented, not changed)

1. **`PUBLIC_BASE_URL` is never passed to the `app` container.** `config.ts` reads it (for
   the OAuth redirect URI and as the WebAuthn RP-ID fallback), but `compose.yaml` does not
   forward it — nor the `WEBAUTHN_*` vars. Consequence: `webauthnRpId` silently falls back
   to the hard-coded `taiwan-health-mcp.gugulu.tw` (`config.ts:113`), so passkey login
   cannot work on any other domain. **Needs a human decision; not touched.**
2. **Loader docstrings vs. reality.** Six loaders state they require `DATABASE_URL`
   pointing *directly* at Postgres, "bypassing pgBouncer" (e.g. `loaders/icd.ts:17`), but
   `compose.yaml` gives `admin-worker` a **pgBouncer** URL. Imports demonstrably succeed,
   so the docstrings look aspirational rather than binding. Ambiguity flagged; no code or
   comment changed.
3. **Dead configuration.** `config/datasets.yaml` + `config/datasets.example.yaml` are read
   by no code. `pytest.ini`, `requirements-dev.txt` and `pyproject.toml` configure a Python
   toolchain with nothing left to lint or test. Recommend deletion in a separate cleanup
   commit — **out of scope for a docs-only change**.
4. **Dead source directory.** `admin-ui/` (58 tracked files) is built by nothing. Same
   recommendation.
5. **Unbounded drug enrichment job running now.** A `drug_enrichment` job (`d3eab3ed`,
   `requested_by=admin`, `job_options_json={}`) is live and crawling the TFDA government
   site (1,199 / 22,042 at time of audit). The `DRUG_AUTOCHAIN_BATCH_LIMIT` cap (200)
   applies only to auto-chained jobs, not to manually queued ones. Operational issue, not
   a docs issue — raised with the user separately.

---

## 7. Broken links

- `README.md` clone URL → `github.com/audi0417/Taiwan-Health-MCP` (wrong owner).
- `mkdocs.yml` `repo_url` / `edit_uri` / `site_url` → wrong owner (§1).
- `docs/development/index.md` → "架構全貌見專案根目錄的 `CLAUDE.md`": `CLAUDE.md` is not
  part of the MkDocs site, so this is a dead reference for a website reader.
- No broken *internal* MkDocs links found (all `nav` targets exist; all relative links
  resolve).

---

## 8. Planned order of work

1. `mkdocs.yml` — fix the site's own identity (URL / repo) first; everything links to it.
2. Public compliance pages — `web/legacy/{landing,dpa,privacy}.html` (the false
   read-only / tool-count claims).
3. `README.md` — the repository's front door.
4. Website entry pages — `docs/index.md`, `docs/getting-started.md`.
5. Deployment set — `docs/deployment/{index,configuration,performance,privacy,dpa}.md`,
   `docs/architecture/deployment.md`.
6. Development set — `docs/development/{index,testing,code-style}.md`.
7. Admin + API set — `docs/admin/{index,jobs-and-worker}.md`, `docs/api/*`.
8. Agent / contributor files — `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`.
9. Module-local READMEs — `src/README.md`, `node-server/README.md`, `admin-ui/README.md`.
10. Historical docs — add a status banner to the four unlinked planning documents.
11. `.env.example` — fill the gaps.
12. Validate: `mkdocs build --strict`, link check, re-grep for stale markers.

---

## 9. Final status — COMPLETE (2026-07-14)

All planned work in §8 was carried out. Nothing was committed or pushed; the changes sit
in the working tree for review.

### Validation performed

| Check | Result |
|---|---|
| `mkdocs build --strict` | **PASS — 0 warnings**, 61 pages built |
| Broken internal links | 2 found by the strict build (`guides/index.md` → `complete-workflow.md`, `drug-identification.md` — pages that were never written) and **removed** |
| Documented file paths (36 checked) | All exist |
| Documented npm scripts (9 checked) | All exist |
| Documented env vars (38 checked) | Every one is read by `node-server/src/**` and/or `compose.yaml` |
| Edited public HTML | Parses cleanly (`html.parser`) |
| `npm run typecheck` (node-server) | Exit 0 — no code was touched |
| `npm test` (node-server) | 1 test, 1 pass, 0 fail |
| Pages workflow | YAML parses; trigger/permissions/publish dir verified; local build reproduces CI's plugin set |

### Files modified

**Website / Pages config (2):** `mkdocs.yml` (site identity), `docs/WEBSITE.md` *(new)*.

**Public product pages (3):** `web/legacy/landing.html`, `web/legacy/dpa.html`,
`web/legacy/privacy.html` — the false "28 tools / all read-only" claims (§4) and a dead
`src/audit.py` reference.

**Root docs (7):** `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`,
`src/README.md`, `node-server/README.md`, `admin-ui/README.md` (marked obsolete),
plus `.env.example`.

**Site content (24):** `docs/index.md`, `docs/getting-started.md`,
`docs/deployment/{index,configuration,performance,privacy,dpa}.md`,
`docs/architecture/deployment.md`, `docs/development/{index,testing,code-style}.md`,
`docs/admin/{index,jobs-and-worker}.md`,
`docs/api/{index,icd-service,lab-service,guideline-service}.md`,
`docs/data-sources/index.md`, `docs/faq/index.md`, `docs/guides/index.md`,
`docs/modules/{drug,snomed}-service.md`,
`docs/fhir-{resource,bundle}-conversion-prompt.md`.

**Historical banners added (5):** `docs/datasets.md`, `docs/node-migration-assessment.md`,
`docs/node-backend-full-refactor-plan.md`, `docs/admin-datasets-redesign.md`,
`docs/fhir-ig-mcp-toolset-assessment.md` — content preserved as decision records, clearly
marked as not describing the current system.

### Nothing was deleted

No documentation file was removed. The obsolete ones (`admin-ui/README.md`, the planning
docs) carry a banner instead, per "preserve useful historical context".

### Remaining work (not done, deliberately)

1. **Code-level cleanup is out of scope for a docs pass** — see §6. `admin-ui/` (58 dead
   files), `config/datasets.yaml`, `pytest.ini`, `requirements-dev.txt` and the
   black/isort config in `pyproject.toml` are all dead and should be deleted in a separate
   commit.
2. **`PUBLIC_BASE_URL` / `WEBAUTHN_*` are not forwarded to `app` in `compose.yaml`** (§6.1).
   Documented as a caveat; the fix is a code/config decision for the user.
3. **Two guide pages were only ever links** (`complete-workflow.md`,
   `drug-identification.md`). Links removed; writing the guides is optional new work.
4. **`requirements-docs.txt`** pins two MkDocs plugins that are neither enabled in
   `mkdocs.yml` nor installed by CI. Harmless, but it could be trimmed to match.
5. **No screenshots exist** anywhere in the project. If the admin console is ever
   documented visually, they would need to be captured fresh.

### Deployment note

The `Deploy MkDocs` workflow fires on push to `main` for `docs/**` + `mkdocs.yml`, so the
documentation site will rebuild on merge. The **public product pages are not part of that
workflow** — `web/legacy/*.html` ships in the `web` container and requires
`docker compose build web && docker compose up -d --no-deps web` to go live.

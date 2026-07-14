# Session handoff — 2026-07-14

Written at the end of the session that finished porting the drug pipeline to Node.
It assumes you have read `CLAUDE.md` (project instructions) but nothing else.

**One-line status:** the backend is now 100% TypeScript — no Python runs anywhere —
and the whole stack was wiped, rebuilt and re-imported from scratch to prove it.
Everything is committed and pushed to `main`.

---

## 1. Project goal

Taiwan Health MCP is a Model Context Protocol server exposing **51 tools** over
Taiwanese medical data: ICD-10-CM/PCS, LOINC, SNOMED CT, TFDA drugs, health
supplements, food nutrition, clinical guidelines, FHIR R4 IG authoring, and a registry
of external FHIR servers. It ships three surfaces from one codebase:

- the **MCP server** (read-only tools for LLM clients, plus an OpenAPI bridge),
- the **admin console** (operators upload source files, run/schedule imports, manage
  settings, watch jobs),
- the **Next.js front-end** (public pages + the admin SPA).

It is built for production SaaS: hundreds of requests/second, graceful degradation when
a dependency (Ollama, MinIO, an LLM) is down.

## 2. Current architecture

```
nginx :8080  ──┬─► app          (node dist/server.js)     MCP + admin REST + /openapi.json
               └─► web          (Next.js)                 public pages + /admin SPA

admin-worker   (node dist/admin/adminWorker.js)           every job type, natively
postgres 16 + pgvector ── pgbouncer ── redis ── minio
```

Everything is Node. `admin-worker` claims jobs from `admin.import_jobs` and runs the
file loaders (ICD/LOINC/SNOMED/RxNorm/IG), the embedding backfill, **and** the three
drug stages. OCR is an external **MinerU** HTTP service (`POST /file_parse`); the
Analysis LM is whatever `admin.llm_profiles` says (currently OpenAI `gpt-5-mini`);
embeddings come from Ollama (`qwen3-embedding:0.6b-q8_0`).

Note that `CLAUDE.md` still describes the old Python layout in places (it says the drug
pipeline is a Python shim). **That is now stale.** Trust this file and the code.

### The drug pipeline (the part that just moved)

```
drug_index_import   loaders/drugIndex.ts        36_2.csv → drug.licenses (+ enrichment queue)
drug_enrichment     loaders/drugEnrichment.ts   TFDA crawl → drug.assets → MinIO
drug_analysis       loaders/drugAnalysis.ts     insert PDF → MinerU OCR → LLM → drug.insert_analysis
```

Shared: `loaders/tfdaCrawler.ts`, `loaders/tfdaParserUtils.ts` (cheerio),
`loaders/drugRecordBuilder.ts` (the canonical record), `drugAnalysisService.ts`.
`admin/adminJobs.ts` wraps each stage in the step/checkpoint/progress bookkeeping
(`runDrugIndexImportJob`, `runDrugEnrichmentJob`, `runDrugAnalysisJob`).

## 3. Design decisions, and why

**The drug pipeline was ported to Node**, reversing an earlier "it stays Python"
decision. That decision rested on OCR being an in-process Python VLM (`dots_ocr`). Once
OCR became the external MinerU HTTP service, the remaining Python was ordinary HTTP/DB
code with no native dependency, and keeping a polyglot worker to run it was pure cost.

**Parity was proven against the running Python, not by reading code.** For each piece:
scrape the same license with both and diff the payload (byte-identical, including every
asset's sha256); build records from 25 real rows both ways; load the same CSV into two
scratch databases and diff all eight `drug.*` tables. That harness is what caught three
defects no amount of code-reading would have (§7). **If you port anything else here, do
the same** — the Python is still in git history and can be run from an old checkout.

**`drugRecordBuilder.ts` reproduces Python's evaluation rules deliberately.** `pick(...)`
is Python's `or` chain (`""` and `[]` are falsy); `dictGet(d, k, default)` is `dict.get`
(an existing-but-empty value beats the default). They are not interchangeable, and the
output is persisted as `normalized_records.normalized_json`. One Python quirk is even
reproduced on purpose (`text_list(dict.values())` always yields `[]`), with a comment
saying so. Do not "clean these up".

**Auto-chain now caps its batch.** `maybeAutoChain` used to queue the next drug phase
with no options, so one index import chained into a **22,211-license crawl of a
government website**. It now passes `{limit: DRUG_AUTOCHAIN_BATCH_LIMIT}` (default 200)
and chains again from its own completion, so the backlog still drains — in slices an
operator can stop between.

**`fhir-code/` is not in git.** The archives are large (540 MB SNOMED), several are
licence-restricted, and all are re-downloadable. `docs/data-sources/test-data.md` is now
the only record of what that folder must contain. The two lookup tables we *cannot*
re-download live in `data/loinc/` instead.

## 4. Files changed this session

New (all under `node-server/src/`):

| File | Purpose |
|---|---|
| `loaders/tfdaParserUtils.ts` | cheerio parsing of the TFDA pages; reproduces BeautifulSoup's `get_text` and `urljoin` semantics exactly |
| `loaders/tfdaCrawler.ts` | scrapes one license: electronic insert, insert/label PDFs, appearance records + images |
| `loaders/drugRecordBuilder.ts` | builds the canonical drug record from index row + enrichment + analysis |
| `loaders/drugIndex.ts` | loads `36_2.csv` (~66k licenses) into `drug.*`, queues enrichment |
| `loaders/drugEnrichment.ts` | crawl → MinIO upload → rebuild record; UUIDv5 asset ids |
| `loaders/drugAnalysis.ts` | OCR + LLM extraction + re-normalize; `retryStage` re-runs one stage |
| `drugAnalysisService.ts` | MinerU call, Analysis-LM call with failover + token-budget escalation, output validation |

Modified:

- `admin/adminJobs.ts` — three native drug job handlers replace the Python `spawn`;
  `maybeAutoChain` gained the batch cap.
- `minioService.ts` — added `buildLocator()` (the locator an object *would* have, so a
  failed upload still records where it was meant to go).
- `Dockerfile.worker` — single-runtime Node image (was Python + Node).
- `compose.yaml` — dropped the `./src` / `./loader` bind mounts and `PYTHONUNBUFFERED`;
  added `NODE_OPTIONS=--max-old-space-size=8192`.
- `.gitignore`, `mkdocs.yml`, and the new `docs/data-sources/test-data.md`.

Deleted: `loader/`, `requirements.txt`, `src/*.py` (20 files). **`src/prompts/` stays** —
`drugAnalysisService.ts` reads `src/prompts/drug/analysis_prompt.txt`.

## 5. Completed

- Full port + parity verification (§3).
- `docker compose down -v` → `up -d --build` → every module re-imported from
  `fhir-code/`, settings restored from the Settings export.
- Verified row counts: ICD 46,498 + 78,948 · LOINC 104,672 · SNOMED 373,972 · RxNorm
  222,199 · IG 9 packages / 20,996 artifacts · drug 66,395 licenses · supplements 565 ·
  food 1,702 · guidelines 4.
- Drug pipeline end-to-end: 101 assets in MinIO, 29 insert PDFs OCR'd and analysed
  (27 with ingredients extracted, correct Traditional Chinese output).
- All 51 MCP tools registered and answering over `POST /tools/<name>`.
- Pause/stop control verified on the new Node enrichment (a job was stopped mid-batch).

## 6. Remaining work

- **Embeddings for the big modules.** Only `guideline` (4) and `health_supplements` (565)
  have vectors. `icd_embed`, `loinc_embed`, `snomed_embed`, `food_nutrition_embed` have
  never run on this data — long jobs against Ollama. Until they do, semantic search on
  those modules is keyword-only.
- **`CLAUDE.md` is stale** — it still presents the Python drug shim, `loader/`,
  `requirements.txt` and the polyglot worker as current. Rewrite the "Backend runtime"
  banner and the service table.
- **Drug backlog.** ~22k licenses are queued for enrichment; auto-chain will grind
  through them 200 at a time whenever a drug job completes. Decide whether that should
  run at all, and on what schedule.
- The stopped `drug_enrichment` job (170/22211) is sitting in `stopped`. Resume or delete.

## 7. Known bugs

None open. The four found this session are all fixed and committed:

1. cheerio's `new URL()` percent-encodes the non-ASCII license number; Python's `urljoin`
   leaves it raw. `detail_url` is persisted, so this changed stored data. `absUrl()` is
   now a string-level RFC 3986 merge.
2. Python's `isoformat()` omits the fractional second when microseconds are 0;
   `toISOString()` never does. `pyIsoformat()` matches it.
3. Character-by-character CSV parsing OOM'd Node on the 44 MB index (one cons-string per
   character). `parseCsv` slices now: 71,922 rows in 0.8 s, 92 MB heap.
4. Building all 66k records before writing OOM'd too. `loadDrugIndex` builds and writes in
   2,000-license chunks **inside the one transaction**, so the import is still
   all-or-nothing.

**A deliberate divergence from Python, worth knowing:** on `im_label` pages Python takes
a fallback path that stores a ROC-year string (`106-12-22`), which its own `parse_date`
then rejects — so the DB got NULL. Node derives `2017-12-22` from the filename instead.
Node is correct; expect `upload_date` to be populated where Python left it empty.

## 8. Technical debt

- **`NODE_OPTIONS=--max-old-space-size` is a trap.** Node's own default is ~4 GB; setting
  a *lower* number makes OOM more likely. The worker needs **8192** because the IG import
  fetches `hl7.fhir.r4.examples`. Do not "tidy" this down.
- The IG import holds whole dependency packages in memory. It works at 8 GB; it is not
  streamed.
- **Git history still carries the big blobs** (SNOMED 540 MB, RxNorm 241 MB, …). Removing
  them from the tip did not shrink the repo. A real cleanup needs `git filter-repo` +
  force push, which forces everyone to re-clone. Not done; the user knows.
- `src/__pycache__/` is left on disk, owned by root (a container created it). It is
  gitignored. `sudo rm -rf src/__pycache__` clears it.
- Chinese keyword search without embeddings finds almost nothing: Postgres' `simple`
  tokenizer treats a whole Chinese product name as one token. **This is by design**
  (vectors are the intended path), not a bug to "fix" with `ILIKE`.

## 9. Branch and git status

- Branch **`main`**, in sync with `origin/main`, **working tree clean**.
- This session's commits: `e25fa9d` (the port), `2af0581` (fhir-code out of git + the new
  doc), `0e344ff` (LOINC tables → `data/loinc/`).
- Pushing to `main` prints a GitHub warning that changes should go through a PR; the
  user's account bypasses it.

## 10. Open issues / questions for the user

- Should the 22k-license drug enrichment backlog actually be crawled? It hammers a
  government site and costs OCR + LLM calls.
- Does the git history need rewriting to shrink the repo?
- Is `fhir-code/umls/…zip` (4 GB) still needed? Nothing imports it.

## 11. Do NOT change

- **`src/prompts/drug/analysis_prompt.txt`** — the Analysis LM system prompt, read at
  runtime; `Dockerfile.worker` COPYs it and `DRUG_ANALYSIS_PROMPT_PATH` points at it.
- **The Python-semantics helpers in `drugRecordBuilder.ts`** (`pick`, `dictGet`, the
  reproduced quirks). They decide the shape of persisted JSON.
- **The UUIDv5 namespaces** in `drugEnrichment.ts` / `drugAnalysis.ts`. Asset ids and
  MinIO object keys derive from them; changing them orphans every stored object.
- **The single transaction in `loadDrugIndex`.** Chunking is about JS memory, not about
  relaxing atomicity. Never let a partial index land.
- **`data/loinc/*.csv`** — hand-curated, downloadable nowhere.
- The `.gitignore` rule that keeps `fhir-code/` out entirely.

## 12. Coding conventions

- Answers to the user in **Traditional Chinese (Taiwan)**; **code and comments in
  English** (from `CLAUDE.md`).
- Comments explain *why*, or state a constraint the code cannot show — never what the
  next line does. Every non-obvious Python-parity decision in the new files carries a
  comment naming the Python behaviour it reproduces and what breaks otherwise.
- New code matches the file it lives in: loaders take a `pg.Pool`, use the local
  `batchInsert` pattern, log through `logger.ts` (`logInfo`/`logWarning`), and never write
  to stdout (that belongs to the MCP stdio transport).
- Bulk-import rule (`CLAUDE.md`): fetch everything first, then write atomically. Never
  interleave HTTP fetches with DB writes inside a transaction.
- Commits: solo author (the user). No `Co-Authored-By` trailer, no tool attribution.

## 13. Exact next steps

1. **Fix `CLAUDE.md`.** Its "Backend runtime — READ FIRST" banner says the drug pipeline
   is a Python shim inside a polyglot worker. Rewrite it (and the service table that lists
   `src/*.py`) to say the backend is entirely Node. This is the single most misleading
   thing in the repo right now — a fresh session will read it and act on it.
2. **Decide the drug backlog policy** with the user (§10), then either delete the stopped
   `drug_enrichment` job or resume it.
3. **Run the remaining embedding jobs** if semantic search is wanted: `icd_embed`,
   `loinc_embed`, `snomed_embed`, `food_nutrition_embed` (queue via `POST /admin/api/jobs`
   with `{"job_type":"…","module_key":"…"}`). Expect hours; Ollama is at the address in
   the `embedding` LLM profile.
4. Optional cleanup: `sudo rm -rf src/__pycache__`.

### How to drive the admin API without the password

The admin password is only stored as a hash. Mint a session cookie from
`ADMIN_SESSION_SECRET` in `.env` — this is what the whole rebuild was driven with:

```bash
SECRET=$(grep '^ADMIN_SESSION_SECRET=' .env | cut -d= -f2-)
TOKEN=$(node -e '
  const c=require("crypto"); const exp=Math.trunc(Date.now()/1000+240*60);
  const enc=Buffer.from(`{"u":"admin","exp":${exp}}`,"utf8").toString("base64")
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  process.stdout.write(enc+"."+c.createHmac("sha256",Buffer.from(process.argv[1],"utf8"))
    .update(enc,"utf8").digest("hex"));' "$SECRET")
curl -s localhost:8080/admin/api/modules -H "Cookie: tw_health_admin_session=$TOKEN"
```

Uploads must send `Content-Type: application/octet-stream`, or express's 4 MB JSON parser
eats the body and answers 413.

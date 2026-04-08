# Repository Guidelines

## Project Structure & Module Organization
Core application code lives in `src/`. `src/server.py` is the MCP entrypoint, and the `*_service.py` modules group domain logic for ICD, drugs, labs, FHIR, SNOMED, TWCore, and guidelines. Shared infrastructure is in `src/config.py`, `src/database.py`, `src/cache.py`, `src/audit.py`, and `src/metrics.py`. Tests live in `tests/` and follow feature-oriented names such as `test_tools_lab.py` and `test_sync_services.py`. Data-loading utilities are in `loader/`, database bootstrap SQL is in `db/schema.sql`, and bundled terminology assets are under `fhir-code/`. Documentation source for MkDocs is in `docs/`.

## Build, Test, and Development Commands
Set up a local Python environment with:
```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
```
Run the server locally with `python src/server.py`. Run tests with `pytest`; `pytest.ini` is configured to discover tests from `tests/` and enables async tests automatically. For the full stack, use `docker compose up -d`. To load terminology data, use the loader profile, for example `docker compose --profile loader run --rm data-loader --all`. Build docs locally with `mkdocs serve` after installing `requirements-docs.txt`.

## Coding Style & Naming Conventions
Use Python with 4-space indentation, PEP 8 spacing, and type hints on public functions. Existing docs specify `Black` for formatting, `isort` for imports, and Google-style docstrings; follow that style even if local automation is not enforced. Keep module names snake_case and align new tests with the target area, for example `test_tools_twcore.py` for TWCore tool coverage.

## Testing Guidelines
Add or update `pytest` coverage for every behavior change. Place new files in `tests/` using the `test_*.py` pattern. Prefer focused unit tests for service methods and add integration-style tests when database queries, loader flows, or transport-facing tool behavior changes. Cover both valid and invalid inputs for new MCP tools.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes such as `feat:`, `fix:`, and `docs:`. Keep commit subjects short and imperative. Open PRs against `main` with a clear description, linked issue when applicable, test evidence, and documentation updates for user-facing behavior. Include screenshots only when documentation or UI-like output changes.

## Configuration & Data Notes
Treat `.env` values and database credentials as local secrets. Prefer `compose.yaml` as the active stack definition. Large terminology archives in `fhir-code/` are inputs to loaders, not a place for ad hoc edits. Do not commit or share licensed source archives such as SNOMED CT, RxNorm, or UMLS in git, PR attachments, or mirror links; contributors must obtain them directly from the official licensors.

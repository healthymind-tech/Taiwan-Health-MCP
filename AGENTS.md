# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the MCP server and service layer (`*_service.py`) for ICD, drug, lab, guideline, FHIR, SNOMED, TWCore, and related logic. `loader/` holds the CLI and dataset loaders used to ingest ICD, LOINC, SNOMED, RxNorm, and Taiwan FDA data. `tests/` contains pytest suites, `docs/` contains MkDocs source, `db/` stores PostgreSQL schema SQL, and `fhir-code/` holds source datasets and seed files.

## Build, Test, and Development Commands
- `docker compose up -d`: start the app stack (`postgres`, `pgbouncer`, `redis`, `app`).
- `docker compose --profile loader run --rm data-loader --all`: load all datasets after configuring `config/datasets.yaml`.
- `python -m pytest tests/ -v`: run the full test suite.
- `python -m pytest tests/test_api_integration.py -v`: run MCP API integration tests against a running server.
- `python -m pytest tests/test_api_integration.py::TestSearchMedicalCodes::test_exact -v`: run one test case.

## Coding Style & Naming Conventions
Follow PEP 8 with 4-space indentation. Use `Black` for formatting, `isort` for import ordering, and Google-style docstrings. Public functions should include type hints. Name service modules `src/<domain>_service.py`, tests `tests/test_*.py`, and feature branches like `feature/short-name` or `bugfix/issue-summary`.

## Testing Guidelines
`pytest` is the standard framework, with `pytest-asyncio` enabled via `pytest.ini`. Prefer `python -m pytest` so the active environment is used consistently. New tool coverage should include normal, fuzzy, and invalid-input cases when practical. Integration tests assume a live MCP server; they skip cleanly if the server is unavailable.

## Commit & Pull Request Guidelines
Git history uses Conventional Commits such as `feat:`, `fix:`, `refactor:`, and `chore:`. Keep commit subjects short and specific. PRs should describe the change, link related issues, note any data or schema impact, and include test evidence. Update docs when behavior, configuration, or loader flow changes.

## Configuration & Data Notes
Do not hardcode dataset paths. Use `.env` for runtime settings and `config/datasets.yaml` for local dataset locations. Large source files in `fhir-code/` are expected to remain as data inputs, not code artifacts.

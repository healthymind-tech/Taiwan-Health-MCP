# 開發指南

感謝您有興趣參與 Taiwan Health MCP 的開發！本區塊文件協助新進開發者快速熟悉專案架構與開發流程。

## 專案結構速覽
- `src/` — MCP 伺服器（`server.py`）、各服務（`*_service.py`）、管理後台（`admin_*.py`）、FHIR 工具（`fhir_*.py`）與跨切面模組（`audit.py` / `cache.py` / `metrics.py` / `module_status.py` / `database.py`）。
- `loader/` — data-loader 容器與各資料集載入器（`loaders/*.py`）。
- `admin-ui/` — 管理後台 React SPA。
- `db/` — `schema.sql` 與 `migrations/`。
- `tests/` — 單元與工具測試。
- `config/` — `datasets.yaml` 來源檔路徑設定。

架構全貌見專案根目錄的 `CLAUDE.md`。

## 文件導引

### [程式風格](code-style.md)
命名、註解與程式碼慣例（程式碼與註解使用英文）。

### [測試指南](testing.md)
如何執行單元與工具測試（`python -m pytest tests/ -v`）。

### [貢獻流程](contributing.md)
Pull Request 規範與程式碼審查標準。

## 新增服務的步驟
1. 建立 `src/<name>_service.py`（含 `__init__(self, pool, ...)` 與 `async initialize()`）。
2. 在 `server.py` 的 lifespan 服務清單中註冊。
3. 以 `@mcp.tool()` + `@audited("tool_name")` 定義工具，並登錄到 `_TOOL_GROUPS`。
4. 若需依資料載入狀態動態啟用，於 `module_status.py` 的 `SERVICE_MODULES` 加入門檻，並在每個工具開頭加上 `_svc_unavailable()` 守衛。

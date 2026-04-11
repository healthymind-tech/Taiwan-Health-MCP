# 測試指南

我們使用 `pytest` 作為測試框架。

## 執行測試

```bash
# 執行所有測試（單元 + API 整合）
python -m pytest tests/ -v

# 只執行單元測試
python -m pytest tests/test_unit.py -v

# 只執行 API 整合測試（需要 server 正在運行）
python -m pytest tests/test_api_integration.py -v

# 指定自訂 server URL
MCP_SERVER_URL=http://localhost:8000/mcp python -m pytest tests/test_api_integration.py -v

# 執行特定測試類別
python -m pytest tests/test_api_integration.py::TestSearchMedicalCodes -v

# 執行單一測試
python -m pytest tests/test_api_integration.py::TestSearchMedicalCodes::test_exact -v
```

> **為何用 `python -m pytest` 而非 `pytest`？**
> `python -m pytest` 確保使用目前 conda 環境的 Python，並自動將當前目錄加入 `sys.path`，避免 import 問題。

## 測試範疇

### 單元測試 (`tests/test_unit.py`)
針對各 Service 的核心函式進行邏輯驗證，使用 mock DB，不需要外部服務。

### API 整合測試 (`tests/test_api_integration.py`)
對實際運行的 MCP server 發送真實 HTTP 請求，驗證所有 42 個 tool 是否正常運作。這些測試同時覆蓋動態註冊後的 `tools/list` 結果，確認 registry 變更沒有漏掛工具或錯誤隱藏工具。

每個 tool 有三種測試情境：
1. **exact** — 完全正確的查詢，預期返回非空結果
2. **fuzzy** — 模糊/部分查詢，預期成功處理
3. **wrong** — 無效輸入，預期優雅處理（不崩潰）

另有 `TestToolsList` 驗證 `tools/list` API 能列出所有 39 個工具，並與 registry 內的群組設定一致。

若 server 未啟動，整合測試會自動跳過（skip），不會失敗。

## 撰寫新測試

請在 `tests/` 目錄下建立 `test_*.py` 檔案。針對每個新增的 Tool，務必加入對應的測試案例，包含「正常輸入」、「模糊輸入」與「異常輸入」三種情境。

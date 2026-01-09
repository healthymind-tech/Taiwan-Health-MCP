# 測試指南

我們使用 `pytest` 作為測試框架。

## 執行測試
```bash
pytest
```

## 測試範疇
1. **單元測試 (Unit Tests)**：針對各 Service 的核心函式（如 `search_codes`）進行邏輯驗證。
2. **整合測試 (Integration Tests)**：驗證真實資料庫載入與查詢流程。

## 撰寫新測試
請在 `tests/` 目錄下建立 `test_*.py` 檔案。
針對每個新增的 Tool，務必加入對應的測試案例，包含「正常輸入」與「異常輸入」。

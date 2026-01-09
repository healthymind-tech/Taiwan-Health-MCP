# Taiwan ICD10 Health MCP Server

> 🇹🇼 台灣醫療健康資料整合 MCP 伺服器
> 整合 ICD-10、FDA 藥品、保健食品、營養資料、LOINC 檢驗、臨床指引，支援 FHIR R4 標準

[![FHIR](https://img.shields.io/badge/FHIR-R4-blue)](http://hl7.org/fhir/R4/)
[![Python](https://img.shields.io/badge/Python-3.8+-green)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-orange)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## ✨ 專案特色

- 🇹🇼 **台灣在地化** - 專為台灣醫療環境設計，支援繁體中文
- 🔗 **標準化整合** - 符合國際 FHIR R4、LOINC、ICD-10、ATC 標準
- 📊 **官方資料** - 整合台灣 FDA、衛福部官方開放資料
- 🤖 **AI 整合** - 透過 MCP 協議與 Claude 無縫對接
- 🔄 **持續更新** - 資料可自動同步最新資訊

---

## 🚀 快速開始

### 安裝

```bash
# 1. Clone 專案
git clone https://github.com/audi0417/Taiwan-Health-MCP.git
cd Taiwan-Health-MCP

# 2. 安裝相依套件
pip install -r requirements.txt

# 3. 準備資料（下載 ICD-10 Excel 檔案到 data/ 目錄）

# 4. 啟動服務
python src/server.py
```

### Docker 啟動（推薦）

```bash
docker-compose up -d
```

---

## 📋 核心功能

### 1. ICD-10 診斷與手術碼查詢
- 診斷碼（ICD-10-CM）與手術碼（ICD-10-PCS）搜尋
- 診斷併發症推論
- 診斷與手術碼衝突檢查
- 轉換為 **FHIR Condition** 資源

### 2. 台灣 FDA 藥品資料整合
整合 5 個官方資料集：
- 藥品許可證（名稱、適應症、製造商）
- 藥品外觀識別（形狀、顏色、刻痕、圖片）
- 藥品成分（有效成分、含量）
- ATC 藥物分類（WHO 標準）
- 藥品仿單/說明書
- 轉換為 **FHIR Medication/MedicationKnowledge** 資源

### 3. 健康食品管理
- 台灣 FDA 核可健康食品查詢
- 健康聲稱（Health Claims）查詢
- 疾病與保健食品關聯分析

### 4. 營養與食品管理
- 食品營養成分查詢
- 膳食營養分析
- 食品原料/添加物查詢

### 5. LOINC 檢驗碼整合
- LOINC 碼對照（台灣常用 30+ 項，可擴展至 87,000+ 項）
- 檢驗參考值查詢（依年齡、性別）
- 檢驗結果自動判讀
- 批次判讀多項檢驗

### 6. 臨床診療指引
- 台灣醫學會臨床指引查詢
- 診斷建議、用藥建議、檢查建議
- 治療目標與臨床路徑規劃

### 7. FHIR R4 標準轉換
- **FHIR Condition** - ICD-10 診斷資源
- **FHIR Medication** - 藥品資源
- **FHIR MedicationKnowledge** - 藥品知識庫
- 符合國際醫療資訊交換標準

> ⚠️ **FHIR 實現局限**
>
> - **FHIR Condition**: 核心結構完整，但驗證不涵蓋所有 R4 約束規則（僅檢查必要欄位）
> - **FHIR Medication**: 支援基本結構，成分含量單位硬編碼為 "mg"，未支援複雜單位轉換
> - **驗證功能**: 基礎驗證（必要欄位、資源類型），不涵蓋高級驗證和術語綁定完整檢查
> - **生產環境**: 若用於生產醫療系統，建議集成 [HL7 FHIR Validator](https://www.hl7.org/fhir/validation.html) 進行完整驗證
> - **應用場景**: 適合演示、MCP 集成、研究用途；生產醫療系統需額外驗證層

> ⚠️ **健康食品與飲食建議注意事項**
> 本服務的健康食品分析和飲食建議功能（含 `疾病與保健食品關聯分析` 和 `飲食營養建議`）**仍在開發測試階段**，具體說明如下：
>
> - **數據來源**: 疾病代碼與保健功效的對應關係、飲食建議內容目前為**開發者整理**，未經過專業醫學/營養師正式審核
> - **專業驗證必需**: 任何使用此功能產出的建議，在應用於實際醫療或健康指導前，**必須經過持證營養師、醫師或相關醫療專業人士的審核和簽名**
> - **法規遵循**: 健康食品依據《健康食品管理法》受台灣衛福部管制，本服務提供的推薦內容不構成醫療診斷、治療或處方
> - **開發階段**: 疾病-保健功效對應表（見 `src/health_food_service.py` 第 29-79 行）需驗證是否符合台灣 FDA 核可的功效清單；飲食建議內容（見 `src/health_food_service.py` 第 414-441 行）需經營養專家確認細節準確性
> - **適用場景**: 當前適合開發者測試、演示和教育用途；**不適合用於生產醫療系統或直接面向患者**
> - **貢獻方式**: 歡迎提交 Issue 或 Pull Request，幫助補充或驗證醫療專業知識，詳見 [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 🛠️ MCP 工具清單

本服務提供 **32 個 MCP 工具**：

| 類別 | 數量 | 功能 |
| --- | --- | --- |
| ICD-10 | 4 | 診斷/手術碼搜尋、推論、衝突檢查 |
| 藥品 | 3 | FDA 藥品查詢、外觀識別 |
| 健康食品 | 2 | 健康食品查詢、保健分析 |
| 營養 | 5 | 營養成分、膳食分析 |
| FHIR 互操作性 | 3 | Condition 資源轉換、驗證 |
| 檢驗 (LOINC) | 5 | 檢驗碼、參考值、結果判讀 |
| 臨床指引 | 5 | 指引查詢、診療路徑 |
| FHIR 藥品 | 4 | Medication 資源轉換 |
| 綜合分析 | 1 | 疾病與保健整合分析 |

詳細工具列表請參閱 [src/README.md](src/README.md) 中的完整說明。

---

## 💡 快速範例

更多範例請參閱 [src/README.md](src/README.md)

---

## 📚 詳細文件

- **[src/README.md](src/README.md)** - 完整模組說明、API 參考、使用範例
- **[docs/](docs/)** - MkDocs 文檔網站（架構、指南、API）

---

## 📊 資料來源

### 台灣官方資料
- 衛福部 ICD-10 中文化資料
- FDA 藥品資料（5 個 API）
- FDA 健康食品資料

### 國際標準
- **FHIR R4** - HL7 International
- **LOINC** - Regenstrief Institute
- **ICD-10** - WHO
- **ATC** - WHO

---

## 📦 版本

**v1.1.0** - 完整的台灣醫療健康資料整合 MCP 伺服器

詳見 Git 提交歷史或 [src/README.md](src/README.md) 了解功能詳情。

---

## 🤝 貢獻

歡迎貢獻！詳見 [CONTRIBUTING.md](CONTRIBUTING.md) 了解詳細步驟和方向。

### 主要貢獻方向

- LOINC 中文對照擴充
- 臨床指引資料補充
- FHIR 資源實作
- 效能優化與快取機制

---

## 📝 授權

**MIT License** - 詳見 [LICENSE](LICENSE) 檔案

使用的開放資料和標準：
- 台灣政府開放資料 - 政府資料開放授權條款
- LOINC & FHIR & ICD - 免費用於臨床、研究、教育

---

## 📞 聯絡資訊

- **GitHub Issues**: [回報問題](https://github.com/audi0417/Taiwan-Health-MCP/issues)
- **Email**: [support@healthymind-tech.com](mailto:support@healthymind-tech.com)
- **文件**: 參閱 [src/README.md](src/README.md)

---

## 🙏 致謝

感謝提供開放資料和標準的組織：
- 台灣衛福部、TFDA（ICD、藥品、健康食品資料）
- Regenstrief Institute（LOINC）
- HL7 International（FHIR）
- WHO（ICD、ATC）

---

**⭐ 如果這個專案對您有幫助，請給我們一個 Star！**

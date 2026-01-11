# 快速開始

本指南將帶您快速開始使用 Taiwan ICD10 Health MCP。

---

## 📋 系統需求

### 必要條件

- **Python** 3.8 或更高版本
- **Docker** (可選，但推薦使用)
- **網路連線** (用於 FDA API 資料同步)

### 建議規格

- **記憶體**: 最少 4GB RAM
- **硬碟空間**: 最少 2GB 可用空間
- **作業系統**: Linux, macOS, Windows (with WSL)

---

## 🚀 安裝方式

=== "Docker 部署（推薦）"

    ### 1. Clone 專案

    ```bash
    git clone https://github.com/audi0417/Taiwan-Health-MCP.git
    cd Taiwan-Health-MCP
    ```

    ### 2. 準備資料檔案

    下載 ICD-10 Excel 檔案並放置到 `data/` 目錄：

    ```bash
    # 下載台灣衛福部 ICD-10 中文化資料
    # 將檔案放置到 data/ 目錄
    ```

    ### 3. 啟動服務

    ```bash
    docker-compose up -d
    ```

    ### 4. 驗證服務

    ```bash
    # 查看服務狀態
    docker-compose ps

    # 查看日誌
    docker-compose logs -f
    ```

=== "手動安裝"

    ### 1. Clone 專案

    ```bash
    git clone https://github.com/audi0417/Taiwan-Health-MCP.git
    cd Taiwan-Health-MCP
    ```

    ### 2. 建立虛擬環境

    ```bash
    # 建立虛擬環境
    python -m venv venv

    # 啟用虛擬環境
    # Linux/macOS:
    source venv/bin/activate

    # Windows:
    venv\Scripts\activate
    ```

    ### 3. 安裝相依套件

    ```bash
    pip install -r requirements.txt
    ```

    ### 4. 準備資料

    ```bash
    # 下載 ICD-10 Excel 檔案到 data/ 目錄
    # 檔案名稱示例: ICD10CM_2024.xlsx
    ```

    ### 5. 啟動服務

    ```bash
    python src/server.py
    ```

    ### 6. 驗證服務

    ```bash
    # 在另一個終端執行測試
    python test_fhir_medication.py
    ```

---

## 🔧 設定檔案

### Docker Compose 設定

`docker-compose.yml`:

```yaml
version: '3.8'

services:
  mcp-server:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - ./data:/app/data
      - ./src:/app/src
    environment:
      - DATA_DIR=/app/data
      - LOG_LEVEL=INFO
    restart: unless-stopped
```

### 環境變數

建立 `.env` 檔案：

```bash
# 資料目錄
DATA_DIR=./data

# 日誌等級
LOG_LEVEL=INFO

# FDA API 設定（可選）
FDA_API_TIMEOUT=30
FDA_API_RETRY=3
```

---

## 📚 資料準備

### 1. ICD-10 資料

下載台灣衛福部 ICD-10 中文化 Excel 檔案：

!!! info "資料來源"
    台灣衛福部 ICD-10-CM/PCS 中文化資料

    請聯繫衛福部或查詢官方網站取得最新版本

將 Excel 檔案放置到 `data/` 目錄。

### 2. LOINC 資料（可選）

如需完整 LOINC 支援（87,000+ 項）：

```bash
# 1. 前往 LOINC 官網註冊並下載
# https://loinc.org/downloads/

# 2. 解壓縮並複製主檔案
cp LOINC_2.78/LoincTable/Loinc.csv data/loinc_official/

# 3. 執行整合腳本
python scripts/integrate_loinc.py
```

!!! tip "快速開始"
    如不需要完整 LOINC 資料，系統已內建台灣常用 30+ 項檢驗項目，可直接使用。

---

## ✅ 驗證安裝

### 測試 1: 基本功能測試

```bash
python -c "
from icd_service import ICDService

icd = ICDService('data/icd_file.xlsx', 'data')
result = icd.search_codes('糖尿病', type='diagnosis')
print(result)
"
```

### 測試 2: FHIR 轉換測試

```bash
python test_fhir_medication.py
```

### 測試 3: 檢驗服務測試

```bash
python test_lab_and_guideline.py
```

---

## 🎯 第一個範例

建立一個簡單的 Python 腳本來查詢藥品並轉換為 FHIR：

```python title="my_first_example.py"
import os
import sys

# 將 src 加進模組搜尋路徑
BASE_DIR = os.path.dirname(__file__)
SRC_DIR = os.path.join(BASE_DIR, "src")
if SRC_DIR not in sys.path:
    sys.path.append(SRC_DIR)

from drug_service import DrugService
from fhir_medication_service import FHIRMedicationService

# 1. 初始化服務
drug = DrugService('data')
fhir_med = FHIRMedicationService(drug)

# 2. 搜尋藥品
print("搜尋藥品: 普拿疼")
search_result = drug.search_drug("普拿疼")
print(search_result)

# 3. 建立 FHIR Medication
print("\n建立 FHIR Medication 資源...")
medication = fhir_med.create_medication_from_search(
    keyword="普拿疼",
    resource_type="Medication"
)
print(fhir_med.to_json_string(medication))
```

執行腳本：

```bash
python my_first_example.py
```

---

## 🔍 常見問題

### Q1: 找不到 ICD-10 Excel 檔案

**錯誤訊息**:
```
FileNotFoundError: No Excel file found in data directory!
```

**解決方式**:
```bash
# 1. 確認檔案是否存在
ls data/*.xlsx

# 2. 如果沒有檔案，請下載並放置到 data/ 目錄
# 3. 確保檔案名稱包含 .xlsx 副檔名
```

### Q2: 記憶體不足錯誤

**錯誤訊息**:
```
MemoryError: Unable to allocate ...
```

**解決方式**:
```bash
# 1. 確保至少有 4GB 可用記憶體
# 2. 如果使用 LOINC 完整資料，可先不整合
# 3. 或只整合常用項目（修改 integrate_loinc.py）
```

### Q3: Docker 無法啟動

**解決方式**:
```bash
# 1. 檢查 Docker 是否正在執行
docker --version

# 2. 檢查 port 8000 是否被佔用
lsof -i :8000

# 3. 查看詳細錯誤日誌
docker-compose logs
```

---

## 📖 下一步

恭喜您成功安裝 Taiwan ICD10 Health MCP！

接下來您可以：

<div class="grid cards" markdown>

-   :material-book-open-page-variant: __學習架構__

    ---

    了解系統架構與設計理念

    [:octicons-arrow-right-24: 查看架構文件](architecture/system-architecture.md)

-   :material-code-braces: __探索模組__

    ---

    深入了解各個服務模組

    [:octicons-arrow-right-24: 查看模組文件](modules/index.md)

-   :material-file-document-outline: __查看範例__

    ---

    學習完整的使用範例

    [:octicons-arrow-right-24: 查看使用指南](guides/complete-workflow.md)

-   :material-api: __API 參考__

    ---

    查閱詳細的 API 文件

    [:octicons-arrow-right-24: 查看 API 文件](api/index.md)

</div>

---

## 🆘 需要幫助？

- 📖 查看 [常見問題](faq/index.md)
- 💬 開啟 [GitHub Issue](https://github.com/audi0417/Taiwan-Health-MCP/issues)
- 📧 聯絡維護團隊: [support@healthymind-tech.com](mailto:support@healthymind-tech.com)

---

!!! success "恭喜！"
    您已經成功安裝並驗證 Taiwan ICD10 Health MCP！

    現在可以開始使用 32 個 MCP 工具來整合台灣醫療資料了！

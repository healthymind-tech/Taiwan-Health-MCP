# 開發環境設置

## 1. 系統需求
- Python 3.12 或更高版本
- Docker + Docker Compose（推薦；PostgreSQL/Redis 透過 Docker 啟動）
- Git

## 2. 下載程式碼
```bash
git clone https://github.com/healthymind-tech/Taiwan-Health-MCP.git
cd Taiwan-Health-MCP
```

## 3. 建立虛擬環境
強烈建議使用 `venv` 或 `conda` 隔離相依套件。

```bash
python -m venv venv
source venv/bin/activate  # macOS/Linux
# venv\Scripts\activate   # Windows
```

## 4. 安裝依賴
```bash
pip install -r requirements.txt
pip install -r requirements-docs.txt  # 若需撰寫文件
```

## 5. 環境配置

### 複製環境變數範本
```bash
cp .env.example .env
cp config/datasets.example.yaml config/datasets.yaml
```

### 設定傳輸模式

編輯 `.env` 檔案，根據開發需求選擇模式：

**本地開發（Claude Desktop 整合）：**
```env
MCP_TRANSPORT=stdio
```

**本地測試伺服器（Streamable HTTP）：**
```env
MCP_TRANSPORT=streamable-http
MCP_HOST=127.0.0.1
MCP_PORT=8000
MCP_PATH=/mcp
```

**Colab 開發（SSE）：**
```env
MCP_TRANSPORT=sse
MCP_HOST=0.0.0.0
MCP_PORT=8000
```

### 環境變數說明

| 變數 | 預設值 | 說明 |
| :--- | :--- | :--- |
| `MCP_TRANSPORT` | `stdio` | 傳輸模式：stdio/streamable-http/sse |
| `MCP_HOST` | `0.0.0.0` | 監聽主機 |
| `MCP_PORT` | `8000` | 監聽埠號 |
| `MCP_PATH` | `/mcp` | HTTP 端點路徑 |
| `DATASETS_CONFIG` | `/app/config/datasets.yaml` | data-loader 的 dataset 設定檔路徑 |

## 6. 準備資料
編輯 `config/datasets.yaml`，指定各資料集的實際檔案位置，例如 ICD、LOINC、
TWCore、SNOMED CT、RxNorm。若未設定 `DATASETS_CONFIG`，loader 會回退到舊的
`FHIR_CODE_DIR` 目錄規則。

範例：

```yaml
datasets:
  icd10cm:
    path: /data/icd/icd10cm_2025.zip
  snomed_ct:
    pattern: /secure/snomed/*.zip
```

## 7. 啟動開發伺服器
```bash
python src/server.py
```

啟動後會顯示配置資訊：
```
==================================================
Taiwan Health MCP Server
==================================================
Transport: stdio
Server is starting...
```

## 8. 升級既有資料庫（可選）

若您沿用舊版資料庫 volume，依序套用 migration 再開發：

```bash
# 1. RxNorm 整併與 drug schema 補強
docker compose exec -T postgres psql \
  -U ${POSTGRES_USER:-mcp} \
  -d ${POSTGRES_DB:-taiwan_health} \
  -v ON_ERROR_STOP=1 \
  < db/migrations/2026-04-12_drug_schema_no_loss.sql

# 2. 移除已棄用的 embedding 資料表（drug.license_embeddings, drug.atc_embeddings）
docker compose exec -T postgres psql \
  -U ${POSTGRES_USER:-mcp} \
  -d ${POSTGRES_DB:-taiwan_health} \
  -v ON_ERROR_STOP=1 \
  < db/migrations/2026-04-12_drop_unused_drug_embeddings.sql
```

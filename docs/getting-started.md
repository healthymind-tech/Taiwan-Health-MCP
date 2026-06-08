# 快速開始

## 前置需求

- Docker 與 Docker Compose
- （選用）一台可達的 Ollama 伺服器，用於語意 / 混合搜尋（`OLLAMA_BASE_URL`）。未設定時，搜尋自動退回關鍵字模式。
- 部分資料來源需自行取得授權檔案（SNOMED CT、LOINC、ICD-10 zip 等），詳見[資料來源](data-sources/index.md)。

## 啟動服務

```bash
cp .env.example .env                # 設定 POSTGRES_PASSWORD 等必要變數
cp config/datasets.example.yaml config/datasets.yaml
docker compose up -d
```

`docker compose up -d` 會啟動：`postgres`、`pgbouncer`、`redis`、`minio`、`minio-init`（建立 bucket）、`app`（MCP 伺服器 + 管理後台）以及 `admin-worker`（背景工作執行器）。

## 載入資料

```bash
docker compose --profile loader run --rm data-loader --all
```

或依需求個別載入：

```bash
docker compose --profile loader run --rm data-loader --icd
docker compose --profile loader run --rm data-loader --loinc
docker compose --profile loader run --rm data-loader --twcore
docker compose --profile loader run --rm data-loader --guideline
docker compose --profile loader run --rm data-loader --snomed
docker compose --profile loader run --rm data-loader --health-supplements
docker compose --profile loader run --rm data-loader --food-nutrition
```

### 藥物域（三階段管線）

藥物資料分三個階段，依序執行：

```bash
docker compose --profile loader run --rm data-loader --drug-index    # 36_2.csv 許可證索引
docker compose --profile loader run --rm data-loader --drug-enrich   # TFDA 爬取仿單 / 外觀 / 文件資產
docker compose --profile loader run --rm data-loader --drug-analysis # 仿單 OCR + LLM 分析
# 或一次跑 index + enrich：
docker compose --profile loader run --rm data-loader --drug
```

`--drug-enrich` 與 `--drug-analysis` 需要設定 TFDA / OCR / 分析 LLM 端點（見 `.env` 的 `DRUG_*` 變數）。

### 嵌入（語意搜尋）

每次資料載入後會自動執行嵌入回填；也可單獨重建：

```bash
docker compose --profile loader run --rm data-loader --embed
```

## 連線 MCP 伺服器

預設以 `streamable-http` 模式在 `http://<host>:8000/mcp` 提供服務（見 `.env` 的 `MCP_TRANSPORT` / `MCP_PORT` / `MCP_PATH`）。若要供 Claude Desktop 以 stdio 模式使用，設定 `MCP_TRANSPORT=stdio`。

## 驗證

```bash
pip install pytest pytest-asyncio
python -m pytest tests/ -v
```

或先用 `health_check` 工具確認伺服器與各模組狀態。

## 啟用管理後台（選用）

於 `.env` 設定後即可在 `/admin` 存取：

```dotenv
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
# python -c "import hashlib; print('sha256$' + hashlib.sha256(b'change-me').hexdigest())"
ADMIN_PASSWORD_HASH=sha256$...
ADMIN_SESSION_SECRET=change_this_admin_session_secret
```

詳見[管理後台](admin/index.md)。

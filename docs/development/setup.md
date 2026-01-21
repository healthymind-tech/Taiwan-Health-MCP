# 開發環境設置

## 1. 系統需求
- Python 3.10 或更高版本
- Git
- SQLite3 (通常 Python 已內建)

## 2. 下載程式碼
```bash
git clone https://github.com/audi0417/Taiwan-Health-MCP.git
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
```

### 設定傳輸模式

編輯 `.env` 檔案，根據開發需求選擇模式：

**本地開發（Claude Desktop 整合）：**
```env
MCP_TRANSPORT=stdio
```

**本地測試伺服器（HTTP）：**
```env
MCP_TRANSPORT=http
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
| `MCP_TRANSPORT` | `stdio` | 傳輸模式：stdio/http/sse |
| `MCP_HOST` | `0.0.0.0` | 監聽主機 |
| `MCP_PORT` | `8000` | 監聽埠號 |
| `MCP_PATH` | `/mcp` | HTTP 端點路徑 |

## 6. 準備資料
從您的資料來源取得 `icd10cm_pcs_xxxx.xlsx` 並放入 `data/` 資料夾。

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

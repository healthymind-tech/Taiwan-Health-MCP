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

## 5. 準備資料
從您的資料來源取得 `icd10cm_pcs_xxxx.xlsx` 並放入 `data/` 資料夾。

## 6. 啟動開發伺服器
```bash
python src/server.py
```
注意：MCP 伺服器預設使用 Stdio 通訊，直接執行可能不會看到太多輸出，建議搭配 MCP Inspector 進行除錯。

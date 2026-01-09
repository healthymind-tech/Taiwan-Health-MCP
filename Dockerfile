FROM python:3.10-slim

# 1. 設定基礎工作目錄為 /app (用來放置檔案)
WORKDIR /app

# 2. 安裝依賴
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 3. 【關鍵修改】切換工作目錄進入 /app/src
# 注意：data/ 和 src/ 會在運行時透過 volume mount 掛載，不需要在構建時複製
WORKDIR /app/src

# 6. 設定環境變數
ENV PYTHONUNBUFFERED=1

# 7. 【關鍵修改】因為已經在 src 裡面了，指令直接執行 server.py 即可
ENTRYPOINT ["python", "server.py"]
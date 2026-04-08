# 台灣 FDA 資料來源

## 藥品許可證
- **來源網址**：[政府資料開放平臺 - 西藥許可證](https://data.gov.tw/dataset/9189)
- **內容**：包含所有經衛生福利部核准之西藥許可證資料，如中文品名、英文品名、適應症、劑型、包裝、藥商名稱、製造廠名稱等。
- **處理方式**：
    1. 透過 FDA Open Data API 下載 JSON 格式資料（5 個端點：主資料、外觀、成分、ATC、仿單）。
    2. 清洗資料（移除無效字元、對 `license_id` 去重）。
    3. 以兩階段寫入：先完整抓取，再以單一 `TRUNCATE + INSERT` transaction 原子寫入。
    4. 存入 PostgreSQL 16，`drug.*` schema（licenses / appearance / ingredients / atc / documents / sync_meta）。
    5. 自動排程：每週二 02:00 UTC；啟動時資料過期（> 7 天）自動觸發。

## 健康食品
- **來源網址**：[政府資料開放平臺 - 健康食品資料集](https://data.gov.tw/dataset/6909)
- **內容**：經審核通過之健康食品資料，含品名、核准功效、保健功效成分、警語等。

## 藥物外觀
- **來源網址**：[TFDA 藥物外觀資料集](https://data.fda.gov.tw/)
- **內容**：藥品外觀描述（顏色、形狀、刻痕）與圖片連結。
- **用途**：支援「不明藥丸辨識」功能。

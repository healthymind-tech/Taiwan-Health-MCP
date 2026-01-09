# 藥品查詢與識別指南

本指南說明如何有效利用藥品工具來解決常見的用藥問題。

## 場景一：不明藥丸辨識

**情況**：家屬在長輩的藥盒中發現一顆掉落的藥丸，特徵是「白色、橢圓形，上面刻有 STD 字樣」。

**操作步驟**：
1. 使用 `identify_unknown_pill` 工具。
2. 輸入特徵關鍵字。

**呼叫範例**：
```python
identify_unknown_pill(features="白色 橢圓形 STD")
```

**結果應用**：
系統回傳可能的藥品清單（例如某種降血壓藥）。使用者可比對藥名，確認是否為長輩正在服用的藥物，決定是否丟棄或補服（需諮詢藥師）。

## 場景二：確認學名藥 (Generics)

**情況**：病患習慣服用原廠藥 "Norvasc"，但藥局只有台廠藥，想確認成分是否相同。

**操作步驟**：
1. 先查詢 "Norvasc" 的詳細成分。
2. 記下主成分 (Active Ingredient)，例如 "Amlodipine"。
3. 再搜尋該成分的其他藥品。

**呼叫範例**：
```python
# 1. 查原廠藥
search_drug_info(keyword="Norvasc")
get_drug_details(license_id="...") # 取得成分 Amlodipine

# 2. 查同成分藥品
search_drug_info(keyword="Amlodipine")
```

**結果應用**：
列出所有含 Amlodipine 的核准藥品，確認替代藥品是否合規。

## 場景三：查詢仿單副作用

**情況**：服藥後感到噁心，想確認是否為藥物副作用。

**操作步驟**：
查詢藥品的電子仿單連結。

**呼叫範例**：
```python
get_drug_details(license_id="衛署藥製字第XXXXXX號")
```

**結果應用**：
點擊回傳資料中的「電子仿單連結」PDF，查閱「副作用/不良反應」章節。

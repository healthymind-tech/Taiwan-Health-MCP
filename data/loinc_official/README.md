# LOINC 官方資料目錄

## 📁 檔案說明

### 必要檔案（需自行下載）

#### `Loinc.csv`
- **來源**: https://loinc.org/downloads/
- **說明**: LOINC 官方主檔案
- **大小**: ~200 MB
- **包含**: 87,000+ 項檢驗項目定義
- **格式**: CSV

**下載步驟**:
1. 前往 https://loinc.org/downloads/
2. 註冊帳號（免費）
3. 下載 "LOINC Table File"
4. 解壓縮後，將 `LoincTable/Loinc.csv` 複製到此目錄

### 台灣自訂檔案（已提供）

#### `loinc_taiwan_mapping.csv`
- **說明**: 台灣常用檢驗項目中文對照表
- **內容**: LOINC 碼 + 中文名稱 + 常用縮寫
- **維護**: 手動維護，逐步補充

**範例**:
```csv
loinc_code,name_zh,common_name_zh
1558-6,空腹血糖,"AC Sugar, FBS"
4548-4,糖化血色素,HbA1c
```

## 🚀 使用方式

### 1. 下載 LOINC 官方資料

```bash
# 前往 LOINC 官網下載（需註冊）
https://loinc.org/downloads/

# 解壓縮後複製檔案
cp LOINC_2.78/LoincTable/Loinc.csv data/loinc_official/
```

### 2. 執行整合腳本

```bash
cd /path/to/Taiwan-ICD10-Health-MCP

# 執行整合
python scripts/integrate_loinc.py

# 或使用 chmod +x 後直接執行
chmod +x scripts/integrate_loinc.py
./scripts/integrate_loinc.py
```

### 3. 驗證結果

```bash
# 執行測試
python test_lab_and_guideline.py

# 或直接測試搜尋
python -c "
from lab_service import LabService
s = LabService('data')
print(s.search_loinc_code('glucose'))
"
```

## 📊 資料統計

### 目前涵蓋範圍

| 分類 | LOINC 官方 | 台灣中文對照 | 參考值 |
|------|-----------|-------------|--------|
| 血液常規 | ✅ | ✅ 5項 | ✅ |
| 生化-血糖 | ✅ | ✅ 3項 | ✅ |
| 生化-血脂 | ✅ | ✅ 4項 | ✅ |
| 生化-肝功能 | ✅ | ✅ 3項 | ✅ |
| 生化-腎功能 | ✅ | ✅ 3項 | ✅ |
| 電解質 | ✅ | ✅ 3項 | ✅ |
| 甲狀腺 | ✅ | ✅ 2項 | ✅ |
| 凝血功能 | ✅ | ✅ 3項 | ✅ |
| 發炎指標 | ✅ | ✅ 1項 | ✅ |
| **總計** | **87,000+** | **30+** | **32** |

## 🔄 維護指南

### 新增中文對照

編輯 `loinc_taiwan_mapping.csv`，新增一行：

```csv
loinc_code,name_zh,common_name_zh
1989-3,維生素D,"25-OH Vit D, Vitamin D"
```

然後重新執行整合腳本。

### 更新 LOINC 官方資料

LOINC 每半年發布新版（6月和12月），更新步驟：

```bash
# 1. 下載新版 LOINC
# 2. 覆蓋舊檔案
cp LOINC_2.79/LoincTable/Loinc.csv data/loinc_official/

# 3. 重新整合
python scripts/integrate_loinc.py

# 4. 測試
python test_lab_and_guideline.py
```

## ⚠️ 注意事項

### 1. .gitignore

**不要將 LOINC 官方檔案提交到 Git！**

已在 `.gitignore` 中排除：
```
data/loinc_official/Loinc.csv
data/loinc_official/LOINC_*.zip
```

原因：
- 檔案太大（200+ MB）
- LOINC 授權條款不允許重新分發原始檔案

### 2. 授權說明

- LOINC 可免費用於臨床、研究用途
- 不可重新分發原始 LOINC 檔案
- 可以分發衍生資料（整合後的資料庫）
- 詳見: https://loinc.org/license/

### 3. 資料來源

| 檔案 | 來源 | 授權 |
|------|------|------|
| Loinc.csv | LOINC.org 官方 | LOINC License |
| loinc_taiwan_mapping.csv | 本專案維護 | MIT License |
| lab_reference_ranges.csv | 本專案整理（參考台灣醫院） | MIT License |

## 📚 參考資源

- [LOINC 官網](https://loinc.org/)
- [LOINC 下載頁面](https://loinc.org/downloads/)
- [LOINC 搜尋工具](https://loinc.org/search/)
- [LOINC 使用者指南](https://loinc.org/get-started/loinc-user-guide/)
- [台灣檢驗醫學會](http://www.labmed.org.tw/)

## ❓ 疑難排解

### Q: integrate_loinc.py 執行失敗？

**A**: 確認是否已下載 Loinc.csv：
```bash
ls -lh data/loinc_official/Loinc.csv
```

### Q: 記憶體不足？

**A**: LOINC 資料很大，建議：
- 至少 4GB 可用記憶體
- 或修改腳本只載入常用項目

### Q: 搜尋找不到項目？

**A**: 檢查是否在中文對照表：
```bash
grep "血糖" data/loinc_official/loinc_taiwan_mapping.csv
```

沒有的話，需要手動新增。

---

**版本**: 1.0.0
**最後更新**: 2024-12-25
**維護者**: Taiwan-ICD10-Health-MCP Team

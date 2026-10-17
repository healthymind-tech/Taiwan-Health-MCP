# LOINC 資料來源

## 國際標準
- **來源權威**：Regenstrief Institute（<https://loinc.org/downloads/>，需註冊帳號）
- **版本**：LOINC 2.80（`Loinc_2.80.zip`）。
- **內容**：`LoincTable/Loinc.csv` 約 10.5 萬個 concept（實驗室檢驗與臨床觀察），寫入 `loinc.concepts`。
- **AccessoryFiles**：匯入時另取 answer（LA）、part（LP）、answer list（LL）、group（LG）代碼（`loinc.other_codes`）、各軸 part 連結、answer list、panel 成員與 MapTo 取代碼（`loinc.part_links`、`loinc.answer_list_items` / `_links`、`loinc.panel_items`、`loinc.map_to`），以及版本（`loinc.editions`）。前者供 FHIR validator 使用，結構表供管理後台的 LOINC 瀏覽使用。

## 台灣中文化對應
- **檔案**：`data/loinc/taiwan_mapping.csv`（來源角色 `loinc_taiwan_mapping`，選用），欄位 `loinc_code, name_zh, common_name_zh, specimen_type, unit`，約 30 筆台灣常用檢驗。
- 專案自行整理、網路上下載不到，因此放在版控中；匯入時合併進 `loinc.concepts` 的中文欄位。

## 參考值資料
- **檔案**：`data/loinc/lab_reference_ranges.csv`（來源角色 `loinc_reference_ranges`，選用），約 40 筆，依年齡 / 性別分層，寫入 `loinc.reference_ranges`。
- **來源**：彙整自台大醫院檢驗科與台灣糖尿病學會、台灣血脂學會、台灣腎臟醫學會等公開資料（每筆的 `source` 欄位）。
- **注意**：各實驗室因儀器試劑不同，參考值可能略有差異，本系統提供之參考值僅供通用性參考。`interpret_lab_result` 只能判讀有參考值的代碼。

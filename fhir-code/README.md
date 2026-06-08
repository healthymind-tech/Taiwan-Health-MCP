# fhir-code — 醫療術語資料集

本目錄存放 Taiwan Health MCP Server 所需的原始術語資料檔案。
**所有檔案為唯讀**，由 data-loader 讀取後寫入 PostgreSQL。
部分資料受授權限制，只能由使用者自行向官方申請下載。

---

## 目錄結構

```
fhir-code/
├── icd/                        ICD-10 資料根目錄
│   └── 10/
│       ├── icd10cm/            ICD-10-CM 診斷碼 (NLM)
│       │   └── icd10cm-table-index-2025.zip          ~20 MB
│       └── icd10pcs/           ICD-10-PCS 手術碼 (CMS)
│           └── icd10pcs_tables_2025.zip              ~648 KB
├── loinc/                      LOINC 實驗室檢驗碼 (Regenstrief Institute)
│   └── 2.80/
│       └── Loinc_2.80.zip                    ~74 MB
├── snomed/                     SNOMED CT International RF2 (SNOMED International)
│   └── SnomedCT_InternationalRF2_PRODUCTION_20250601T120000Z.zip   ~540 MB
├── rxnorm/                     RxNorm 藥品命名與關係 (NLM)
│   └── RxNorm_full_06032024.zip              ~241 MB
├── twcoreig/                   TWCore IG CodeSystems (衛福部/MOHW)
│   └── package.tgz                           ~2.8 MB
└── umls/                       UMLS Metathesaurus 2024AA (NLM) — 尚未整合
    └── umls-2024AA-metathesaurus-full.zip    ~4.0 GB
```

---

## 各資料集說明

| 資料集 | 版本 | 授權 | 用途 | 狀態 |
|--------|------|------|------|------|
| ICD-10-CM | 2025 (NLM) | 公開 | 診斷碼搜尋、FHIR Condition | ✅ 備齊 |
| ICD-10-PCS | 2025 (CMS) | 公開 | 手術/處置碼搜尋（78,948 筆） | ✅ 備齊 |
| LOINC | 2.80 | LOINC License（免費） | 實驗室檢驗碼、參考範圍 | ✅ 備齊 |
| SNOMED CT | 20250601 International | SNOMED License（需申請） | 概念搜尋、IS-A 層級、ICD-10 對應 | 使用前須自行下載 |
| RxNorm | 2024-06-03 | UMLS License（需申請） | 藥物名稱解析、藥物交互作用 | 使用前須自行下載 |
| TWCore IG | v1.0.0 | 公開 (MOHW) | 健保碼、給藥途徑、科別代碼等 30+ CodeSystems | ✅ 備齊 |
| UMLS | 2024AA | UMLS License（免費申請） | 跨術語系統對應 — 尚未實作 loader | ⏳ 尚未整合 |

---

## 載入方式（透過管理後台）

資料匯入已改由 **管理後台（Admin → Modules）** 觸發，並由 `admin-worker` 在背景執行（已無獨立的 CLI data-loader 容器）。

- **需上傳來源檔**：ICD-10-CM/PCS、LOINC、SNOMED CT、FHIR IG（`package.tgz`）。於 Admin → Sources / Modules 上傳本目錄對應的來源檔後按匯入。
- **由 API 自動抓取**：藥品（TFDA，三階段:`--drug-index` → `--drug-enrich` → `--drug-analysis`）、健康補充品、食品營養。
- **內建種子資料**：臨床指引。

各模組對應的 loader 階段名稱（worker 內部使用）：`--icd`、`--loinc`、`--twcore`、`--guideline`、`--snomed`、`--health-supplements`、`--food-nutrition`、`--drug-index/-enrich/-analysis`、`--embed`。

> `--icd` 會自動同時載入 ICD-10-CM（診斷碼）和 ICD-10-PCS（手術碼）。
> 若 `fhir-code/icd/10/icd10pcs/` 目錄下沒有 zip，則只載入 CM，不影響診斷碼功能。
> RxNorm 目前僅作為概念參考術語（供 FHIR IG ValueSet 展開），不提供獨立的藥物工具。
> 開發時若要直接執行單一階段，可在 worker 容器內以 `python -m loader.main --<stage>` 執行。

## 授權限制

- `fhir-code/snomed/SnomedCT_InternationalRF2_PRODUCTION_*.zip` 不得納入 git，需自 SNOMED International 官方申請。
- `fhir-code/rxnorm/RxNorm_full_*.zip` 不得納入 git，需使用合法的 UMLS/NLM 帳號自官方下載。
- `fhir-code/umls/umls-*-metathesaurus-full.zip` 不得納入 git，需自 UTS 官方下載。
- 文件中只應提供官方申請頁面，不提供 Google Drive 或其他第三方鏡像下載點。

---

## ICD-10-PCS 下載說明

`icd10pcs_tables_2025.zip` 已從 CMS 官網下載並存放：

```
來源：https://www.cms.gov/files/zip/2025-icd-10-pcs-codes-file.zip
內容：icd10pcs_codes_2025.txt（78,948 筆手術碼）
```

若需要更新至新年度版本：
```bash
curl -L "https://www.cms.gov/files/zip/2026-icd-10-pcs-codes-file.zip" \
  -o fhir-code/icd/10/icd10pcs/icd10pcs_tables_2026.zip
# 然後於管理後台 Admin → Modules 重新匯入 ICD 模組
```

---

## 授權申請連結

- **LOINC**: https://loinc.org/license/
- **SNOMED CT**: https://www.snomed.org/get-snomed
- **RxNorm / UMLS**: https://uts.nlm.nih.gov/uts/signup-login

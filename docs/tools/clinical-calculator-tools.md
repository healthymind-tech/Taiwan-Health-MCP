# 臨床計算器工具 (Clinical Calculator Tools)

此類別工具提供台灣臨床場域常用的驗證計分與計算。所有計算器皆為**純函數、無狀態**：
不存取資料庫、不需外部服務，且**永久註冊**（不隨模組資料載入狀態啟用/停用）。

每個結果都回傳一致的信封：

```json
{
  "calculator": "bmi",
  "score": 27.3,
  "interpretation": "肥胖",
  "inputs": { "weight_kg": 75, "height_cm": 165 },
  "notes": ["台灣標準：BMI≥27 為肥胖"],
  "disclaimer": "僅供臨床決策支援，不取代專業醫療判斷。"
}
```

> 所有計算結果僅供臨床決策支援，不取代專業醫療判斷。分數採用的切點與分級
> 依各計分原始文獻與台灣現行指引；`interpretation` / `notes` 為正體中文。

---

## calculate_chads2_vasc
心房顫動（非瓣膜性）中風風險計分 CHA₂DS₂-VASc（0–9），並回傳 2024 ESC 的
CHA₂DS₂-VA 調整分數（去除性別）。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `age` | integer | 是 | 年齡（歲），內部自動判斷 65–74 / ≥75 分組 |
| `sex` | string | 是 | 性別：`"M"` / `"F"` |
| `congestive_heart_failure` | boolean | 否 | 鬱血性心衰竭 |
| `hypertension` | boolean | 否 | 高血壓 |
| `diabetes` | boolean | 否 | 糖尿病 |
| `stroke_or_tia` | boolean | 否 | 中風 / TIA 病史 |
| `vascular_disease` | boolean | 否 | 血管疾病 |

### 用途
分數 0–9；回傳 `adjusted_score`（去除性別）。風險分級依 CHA₂DS₂-VA：
0 不需抗凝血、1 考慮、≥2 建議口服抗凝血。

---

## calculate_wells_pe
肺栓塞 Wells 機率計分（二層 + 三層風險分級）。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `clinical_signs_dvt` | boolean | 否 | DVT 臨床徵象（+3） |
| `alternative_diagnosis_less_likely` | boolean | 否 | 其他診斷較不可能（+3） |
| `heart_rate_bpm` | number | 否 | 心率，>100 自動 +1.5 |
| `immobilization_or_recent_surgery` | boolean | 否 | 臥床 / 近 4 週手術（+1.5） |
| `previous_dvt_or_pe` | boolean | 否 | 過去 DVT/PE（+1.5） |
| `hemoptysis` | boolean | 否 | 咳血（+1） |
| `active_malignancy` | boolean | 否 | 活動性惡性腫瘤（+1） |

---

## calculate_wells_dvt
深層靜脈栓塞 Wells 機率計分（二層 + 三層風險分級）。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `active_cancer` | boolean | 否 | 活動性癌症（+1） |
| `paralysis_paresis_or_immobilization` | boolean | 否 | 癱瘓 / 輕癱 / 石膏固定（+1） |
| `bedridden_or_recent_surgery` | boolean | 否 | 臥床 / 近 4 週手術（+1） |
| `calf_swelling_gt_3cm` | boolean | 否 | 小腿腫脹 >3cm（+1） |
| `collateral_superficial_veins` | boolean | 否 | 表淺側枝靜脈（+1） |
| `entire_leg_swollen` | boolean | 否 | 整腿腫脹（+1） |
| `localized_tenderness` | boolean | 否 | 局部壓痛（+1） |
| `pitting_edema` | boolean | 否 | 凹陷性水腫（+1） |
| `previous_dvt` | boolean | 否 | 過去 DVT（+1） |
| `alternative_diagnosis_as_likely` | boolean | 否 | 其他診斷同等可能（−2） |

---

## calculate_das28
類風濕關節炎疾病活動度 DAS28（ESR 或 CRP 版本）。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `tender_count` | integer | 是 | 壓痛關節數 |
| `swollen_count` | integer | 是 | 腫脹關節數 |
| `global_health` | number | 是 | 病人整體評估 VAS（0–100） |
| `formula` | string | 是 | `"esr"` 或 `"crp"` |
| `esr` | number | 視 formula | `formula="esr"` 時必填，單位 mm/h |
| `crp` | number | 視 formula | `formula="crp"` 時必填，單位 mg/L |

### 分級
≤2.6 緩解、≤3.2 低、≤5.1 中、>5.1 高疾病活動度。

---

## calculate_cdai
類風濕關節炎疾病活動度 CDAI（免抽血版本）。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `tender_count` | integer | 是 | 壓痛關節數（0–10） |
| `swollen_count` | integer | 是 | 腫脹關節數（0–10） |
| `patient_global` | number | 是 | 病人整體評估（0–10） |
| `provider_global` | number | 是 | 評估者整體評估（0–10） |

### 分級
≤2.8 緩解、≤10 低、≤22 中、>22 高疾病活動度。

---

## calculate_bmi
身體質量指數（採用台灣/亞洲切點）。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `weight_kg` | number | 是 | 體重（公斤） |
| `height_cm` | number | 是 | 身高（公分） |

### 分級（台灣/亞洲）
<18.5 過輕、18.5–23.9 正常、24–26.9 過重、≥27 肥胖。WHO 國際標準為 ≥25 過重、≥30 肥胖。

---

## calculate_egfr
估算腎絲球過濾率（CKD-EPI 2021，無種族係數）。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `age` | integer | 是 | 年齡（歲） |
| `sex` | string | 是 | 性別：`"M"` / `"F"` |
| `serum_creatinine_mgdl` | number | 是 | 血清肌酸酐（mg/dL） |

### 分級（KDIGO）
G1 ≥90、G2 60–89、G3a 45–59、G3b 30–44、G4 15–29、G5 <15。急性腎損傷或非穩定狀態下不適用。

---

## calculate_has_bled
抗凝血治療出血風險 HAS-BLED（0–9）。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `age` | integer | 是 | 年齡（歲），>65 自動 +1 |
| `systolic_bp_mmhg` | number | 否 | 收縮壓（mmHg），>160 自動視為未控制高血壓 +1 |
| `abnormal_renal_function` | boolean | 否 | 腎功能異常 |
| `abnormal_liver_function` | boolean | 否 | 肝功能異常 |
| `stroke_history` | boolean | 否 | 中風病史 |
| `bleeding_history` | boolean | 否 | 出血病史 / 傾向 |
| `labile_inr` | boolean | 否 | INR 不穩定 |
| `drugs_antiplatelet_or_nsaid` | boolean | 否 | 抗血小板藥 / NSAID |
| `alcohol` | boolean | 否 | 飲酒 ≥8 杯/週 |

### 分級
≥3 分為高出血風險，應謹慎並定期追蹤。

---

## calculate_curb65
社區型肺炎嚴重度 CURB-65（0–5）。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `age` | integer | 是 | 年齡（歲），≥65 自動 +1 |
| `confusion` | boolean | 否 | 意識混淆 |
| `bun_mgdl` | number | 否 | BUN（mg/dL），>19 +1 |
| `respiratory_rate` | number | 否 | 呼吸速率，≥30 +1 |
| `sbp_mmhg` | number | 否 | 收縮壓（<90 或 DBP≤60 為低血壓 +1） |
| `dbp_mmhg` | number | 否 | 舒張壓 |

### 分級
0–1 低風險、2 中風險、≥3 高風險（考慮加護病房）。BUN >19 mg/dL ≈ 尿素 >7 mmol/L。

---

## calculate_qsofa
敗血症篩檢 qSOFA（0–3）。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `respiratory_rate` | number | 否 | 呼吸速率，≥22 +1 |
| `gcs` | integer | 否 | 格拉斯哥昏迷指數（3–15），<15 自動視為意識改變 +1 |
| `sbp_mmhg` | number | 否 | 收縮壓，≤100 +1 |

### 分級
≥2 分應懷疑敗血症並進一步評估；qSOFA 為篩檢工具，非診斷標準。

---

## calculate_gcs
格拉斯哥昏迷指數 GCS（3–15）。

### 參數
| 參數名 | 型別 | 必填 | 說明 |
| :--- | :--- | :--- | :--- |
| `eye_response` | integer | 是 | 睜眼 E（1–4） |
| `verbal_response` | integer | 是 | 言語 V（1–5） |
| `motor_response` | integer | 是 | 動作 M（1–6） |

### 分級
13–15 輕度、9–12 中度、≤8 重度（昏迷/需考慮插管）。

---

> 所有工具都以 JSON 回傳（MCP `content[0].text` 內為 JSON 字串），沒有純文字格式的輸出。

## 數值來源 (References)

各計分的權重、公式與切點均依下列原始文獻 / 權威來源，並於 2026-10-05 重新核對：

| 計分 | 來源 |
| :--- | :--- |
| CHA₂DS₂-VASc / CHA₂DS₂-VA | 2024 ESC 心房顫動指引（CHA₂DS₂-VA，去除性別） |
| Wells PE / DVT | Wells 等（肺栓塞 / 深層靜脈栓塞臨床機率） |
| DAS28 / CDAI | Prevoo（DAS28）、Aletaha（CDAI） |
| BMI | 衛生福利部國民健康署（台灣成人標準：24 過重、27 肥胖） |
| eGFR | CKD-EPI 2021（Inker 等，*NEJM* 2021；kidney.org） |
| HAS-BLED | Pisters 等，2010 |
| CURB-65 | Lim 等，2003 |
| qSOFA | Singer 等，2016（Sepsis-3） |
| GCS | Teasdale & Jennett，1974 |

> HAS-BLED 與 qSOFA 對其較窄的原始定義改收原始數值（「未控制高血壓＝收縮壓
> >160 mmHg」、「意識改變＝GCS <15」），由工具內部計算。

# Clinical Calculator Tools

This group provides validated clinical scores and calculations used across Taiwan
clinical practice. Every calculator is a **pure, stateless function** — no database,
no external service — and is **always registered** (never gated by module data load state).

Every result returns a consistent envelope:

```json
{
  "calculator": "bmi",
  "score": 27.55,
  "category": "肥胖",
  "interpretation": "BMI 27.55，肥胖",
  "inputs": { "weight_kg": 75, "height_cm": 165 },
  "notes": [
    "台灣（亞洲）標準：<18.5 過輕、18.5–23.9 正常、24–26.9 過重、≥27 肥胖。",
    "WHO 國際標準為 ≥25 過重、≥30 肥胖，與台灣標準不同。"
  ],
  "disclaimer": "僅供臨床決策支援，不取代專業醫療判斷。"
}
```

Besides the common fields, each calculator adds its own tier field (e.g. `category`,
`risk_category`, `ckd_stage`, `disease_activity`). `interpretation` is a full sentence,
not a bare tier label — read the tier field when parsing programmatically. Continuous
scores are rounded to two decimals, and the tier is always derived from the rounded
value, so the reported score and tier never contradict each other.

**Input validation:** every parameter has a plausible range (see the tables below).
Out-of-range values and obvious unit mix-ups (e.g. height in metres, creatinine in
µmol/L) are rejected with a validation error instead of producing a score. The ranges
are also published in the JSON Schema of `tools/list` and `/openapi.json`.

> All results are decision support only and do not replace professional medical
> judgment. Cutoffs and tiers follow each score's original literature and current
> Taiwan guidance; `interpretation` / `notes` are Traditional Chinese.

---

## calculate_chads2_vasc
CHA₂DS₂-VASc stroke-risk score for non-valvular atrial fibrillation (0–9), plus the
2024 ESC CHA₂DS₂-VA adjusted score (sex removed).

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `age` | integer | Yes | Age in years (0–130); 65–74 / ≥75 brackets computed internally |
| `sex` | string | Yes | `"M"` / `"F"` |
| `congestive_heart_failure` | boolean | No | Congestive heart failure |
| `hypertension` | boolean | No | Hypertension |
| `diabetes` | boolean | No | Diabetes |
| `stroke_or_tia` | boolean | No | Prior stroke / TIA |
| `vascular_disease` | boolean | No | Vascular disease |

### Purpose
Score 0–9; also returns `adjusted_score` (sex removed). Risk tiering uses CHA₂DS₂-VA:
0 no anticoagulation, 1 consider, ≥2 oral anticoagulation recommended.

---

## calculate_wells_pe
Wells criteria for pulmonary embolism (two-tier + three-tier risk).

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `clinical_signs_dvt` | boolean | No | Clinical signs of DVT (+3) |
| `alternative_diagnosis_less_likely` | boolean | No | Alternative diagnosis less likely (+3) |
| `heart_rate_bpm` | number | No | Heart rate (0–350); >100 auto +1.5 |
| `immobilization_or_recent_surgery` | boolean | No | Immobilization / surgery ≤4 weeks (+1.5) |
| `previous_dvt_or_pe` | boolean | No | Prior DVT/PE (+1.5) |
| `hemoptysis` | boolean | No | Hemoptysis (+1) |
| `active_malignancy` | boolean | No | Active malignancy (+1) |

---

## calculate_wells_dvt
Wells criteria for deep-vein thrombosis (two-tier + three-tier risk).

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `active_cancer` | boolean | No | Active cancer (+1) |
| `paralysis_paresis_or_immobilization` | boolean | No | Paralysis / paresis / immobilization (+1) |
| `bedridden_or_recent_surgery` | boolean | No | Bedridden / surgery ≤4 weeks (+1) |
| `calf_swelling_gt_3cm` | boolean | No | Calf swelling >3 cm (+1) |
| `collateral_superficial_veins` | boolean | No | Collateral superficial veins (+1) |
| `entire_leg_swollen` | boolean | No | Entire leg swollen (+1) |
| `localized_tenderness` | boolean | No | Localized tenderness (+1) |
| `pitting_edema` | boolean | No | Pitting edema (+1) |
| `previous_dvt` | boolean | No | Prior DVT (+1) |
| `alternative_diagnosis_as_likely` | boolean | No | Alternative diagnosis as likely (−2) |

---

## calculate_das28
DAS28 rheumatoid arthritis disease activity (ESR or CRP variant).

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `tender_count` | integer | Yes | Tender joint count (28-joint assessment, 0–28) |
| `swollen_count` | integer | Yes | Swollen joint count (28-joint assessment, 0–28) |
| `global_health` | number | Yes | Patient global assessment VAS (0–100 mm; not the 0–10 scale CDAI uses) |
| `formula` | string | Yes | `"esr"` or `"crp"` |
| `esr` | number | per formula | Required when `formula="esr"`, mm/h (>0, max 200) |
| `crp` | number | per formula | Required when `formula="crp"`, mg/L (0–500; not mg/dL) |

### Tiers
≤2.6 remission, ≤3.2 low, ≤5.1 moderate, >5.1 high disease activity.

---

## calculate_cdai
CDAI (lab-free) rheumatoid arthritis disease activity.

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `tender_count` | integer | Yes | Tender joint count (28-joint assessment, 0–28) |
| `swollen_count` | integer | Yes | Swollen joint count (28-joint assessment, 0–28) |
| `patient_global` | number | Yes | Patient global assessment (0–10) |
| `provider_global` | number | Yes | Provider global assessment (0–10) |

### Tiers
Total 0–76; ≤2.8 remission, ≤10 low, ≤22 moderate, >22 high disease activity.

---

## calculate_bmi
Body mass index with Taiwan (Asian) cutoffs.

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `weight_kg` | number | Yes | Weight in kg (>0, max 700) |
| `height_cm` | number | Yes | Height in cm (50–280; height in metres is rejected) |

### Tiers (Taiwan/Asian)
<18.5 underweight, 18.5–23.9 normal, 24–26.9 overweight, ≥27 obese. WHO
international cutoffs are ≥25 overweight, ≥30 obese.

---

## calculate_egfr
Estimated glomerular filtration rate (CKD-EPI 2021, race-free).

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `age` | integer | Yes | Age in years (18–130; CKD-EPI 2021 is adults-only) |
| `sex` | string | Yes | `"M"` / `"F"` |
| `serum_creatinine_mgdl` | number | Yes | Serum creatinine (mg/dL, >0, max 30; µmol/L ÷ 88.4) |

### Tiers (KDIGO)
G1 ≥90, G2 60–89, G3a 45–59, G3b 30–44, G4 15–29, G5 <15. Not applicable in acute
kidney injury or unstable states.

---

## calculate_has_bled
HAS-BLED bleeding risk on oral anticoagulation (0–9).

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `age` | integer | Yes | Age in years (0–130); >65 auto +1 |
| `systolic_bp_mmhg` | number | No | Systolic BP (mmHg, 0–300); >160 auto counts as uncontrolled hypertension +1 |
| `abnormal_renal_function` | boolean | No | Abnormal renal function |
| `abnormal_liver_function` | boolean | No | Abnormal liver function |
| `stroke_history` | boolean | No | Stroke history |
| `bleeding_history` | boolean | No | Bleeding history / predisposition |
| `labile_inr` | boolean | No | Labile INR |
| `drugs_antiplatelet_or_nsaid` | boolean | No | Antiplatelet / NSAID |
| `alcohol` | boolean | No | Alcohol ≥8 drinks/week |

### Tiers
≥3 high bleeding risk — use caution and monitor regularly.

---

## calculate_curb65
CURB-65 community-acquired pneumonia severity (0–5).

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `age` | integer | Yes | Age in years (0–130); ≥65 auto +1 |
| `confusion` | boolean | No | Confusion |
| `bun_mgdl` | number | No | BUN (mg/dL, 0–300); >19 +1 |
| `respiratory_rate` | number | No | Respiratory rate; ≥30 +1 |
| `sbp_mmhg` | number | No | Systolic BP (<90, or DBP≤60, counts as hypotension +1) |
| `dbp_mmhg` | number | No | Diastolic BP |

### Tiers
0–1 low, 2 moderate, ≥3 high (consider ICU). BUN >19 mg/dL ≈ urea >7 mmol/L.

---

## calculate_qsofa
qSOFA sepsis screening (0–3).

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `respiratory_rate` | number | No | Respiratory rate; ≥22 +1 |
| `gcs` | integer | No | Glasgow Coma Scale (3–15); <15 auto counts as altered mentation +1 |
| `sbp_mmhg` | number | No | Systolic BP; ≤100 +1 |

### Tiers
≥2 suggests sepsis and further evaluation; qSOFA is a screening tool, not a
diagnostic criterion.

---

## calculate_gcs
Glasgow Coma Scale (3–15).

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `eye_response` | integer | Yes | Eye E (1–4) |
| `verbal_response` | integer | Yes | Verbal V (1–5) |
| `motor_response` | integer | Yes | Motor M (1–6) |

### Tiers
13–15 mild, 9–12 moderate, ≤8 severe (coma / consider intubation).

---

> All tools return JSON (a JSON string inside MCP `content[0].text`); there is no
> plain-text output format.

## References

Weights, formulas and cutoffs follow the original literature / authoritative
sources below and were re-verified on 2026-10-05:

| Score | Source |
| :--- | :--- |
| CHA₂DS₂-VASc / CHA₂DS₂-VA | 2024 ESC AF guideline (CHA₂DS₂-VA, sex removed) |
| Wells PE / DVT | Wells et al. (PE / DVT clinical probability) |
| DAS28 / CDAI | Prevoo (DAS28), Aletaha (CDAI) |
| BMI | Taiwan MOHW Health Promotion Administration (24 overweight, 27 obese) |
| eGFR | CKD-EPI 2021 (Inker et al., *NEJM* 2021; kidney.org) |
| HAS-BLED | Pisters et al., 2010 |
| CURB-65 | Lim et al., 2003 |
| qSOFA | Singer et al., 2016 (Sepsis-3) |
| GCS | Teasdale & Jennett, 1974 |

> HAS-BLED and qSOFA accept raw values for their narrower source definitions
> ("uncontrolled hypertension = SBP >160 mmHg", "altered mentation = GCS <15")
> and compute them internally.

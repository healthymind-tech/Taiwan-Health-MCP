"""
Clinical guideline seed data.
Inserts Taiwan Medical Society guidelines for common chronic diseases.
Source: 中華民國糖尿病學會、台灣高血壓學會、中華民國血脂及動脈硬化學會 (2023-2024)
"""

import asyncpg


async def seed_guidelines(pool: asyncpg.Pool) -> None:
    """Seed Taiwan Medical Society clinical guidelines into ``guideline.*`` tables.

    Idempotent — skips if data is already present.

    Args:
        pool: asyncpg connection pool.
    """
    print("  Seeding clinical guidelines ...")

    async with pool.acquire() as conn:
        # Idempotent: skip if already seeded
        count = await conn.fetchval("SELECT COUNT(*) FROM guideline.disease_guidelines")
        if count > 0:
            print(f"  Already seeded ({count} guidelines). Skipping.")
            return

        # ── 第二型糖尿病 (E11) ───────────────────────────────────────────
        gid = await conn.fetchval(
            """INSERT INTO guideline.disease_guidelines
               (icd_code, disease_name_zh, disease_name_en, guideline_title,
                guideline_source, publication_year, guideline_summary)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id""",
            "E11",
            "第二型糖尿病",
            "Type 2 Diabetes Mellitus",
            "2024 台灣糖尿病臨床照護指引",
            "中華民國糖尿病學會",
            2024,
            "本指引涵蓋第二型糖尿病的診斷、血糖控制目標、藥物治療、併發症預防等完整照護建議",
        )

        await conn.executemany(
            """INSERT INTO guideline.diagnostic_recommendations
               (guideline_id, step_order, recommendation_type, description, evidence_level)
               VALUES ($1,$2,$3,$4,$5)""",
            [
                (
                    gid,
                    1,
                    "實驗室檢查",
                    "空腹血糖 ≥126 mg/dL，或隨機血糖 ≥200 mg/dL 合併典型症狀，或HbA1c ≥6.5%",
                    "A",
                ),
                (
                    gid,
                    2,
                    "確認診斷",
                    "異常結果需重複檢測確認（除非有明顯高血糖症狀）",
                    "A",
                ),
                (
                    gid,
                    3,
                    "併發症篩檢",
                    "診斷時即應篩檢視網膜病變、腎病變、神經病變",
                    "B",
                ),
            ],
        )

        await conn.executemany(
            """INSERT INTO guideline.medication_recommendations
               (guideline_id, line_of_therapy, medication_class, medication_examples,
                dosage_guidance, contraindications, evidence_level)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            [
                (
                    gid,
                    "第一線",
                    "雙胍類 (Biguanide)",
                    "Metformin",
                    "起始劑量 500mg 每日一次，逐漸增加至 500-1000mg 每日兩次",
                    "腎功能不全 (eGFR <30)",
                    "A",
                ),
                (
                    gid,
                    "第二線",
                    "SGLT2 抑制劑",
                    "Empagliflozin, Dapagliflozin",
                    "依藥品仿單建議劑量",
                    "eGFR <20-30 (依藥品而異)",
                    "A",
                ),
                (
                    gid,
                    "第二線",
                    "GLP-1 受體促效劑",
                    "Dulaglutide, Semaglutide",
                    "皮下注射，每週一次",
                    "甲狀腺髓樣癌病史或家族史",
                    "A",
                ),
                (
                    gid,
                    "第二線",
                    "DPP-4 抑制劑",
                    "Sitagliptin, Linagliptin",
                    "依藥品仿單建議劑量",
                    "無特殊禁忌",
                    "B",
                ),
                (
                    gid,
                    "輔助治療",
                    "胰島素",
                    "基礎胰島素 (Insulin Glargine, Detemir)",
                    "依血糖監測調整劑量",
                    "低血糖風險",
                    "A",
                ),
            ],
        )

        await conn.executemany(
            """INSERT INTO guideline.test_recommendations
               (guideline_id, test_category, test_name, loinc_code,
                frequency, indication, evidence_level)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            [
                (
                    gid,
                    "生化檢驗",
                    "糖化血色素 (HbA1c)",
                    "4548-4",
                    "每3個月一次",
                    "監測血糖控制",
                    "A",
                ),
                (
                    gid,
                    "生化檢驗",
                    "空腹血糖",
                    "1558-6",
                    "每次門診",
                    "日常血糖監控",
                    "A",
                ),
                (
                    gid,
                    "生化檢驗",
                    "腎功能 (Cr, eGFR)",
                    "2160-0",
                    "每年至少1次",
                    "篩檢糖尿病腎病變",
                    "A",
                ),
                (
                    gid,
                    "生化檢驗",
                    "血脂肪",
                    "2093-3",
                    "每年至少1次",
                    "心血管風險評估",
                    "A",
                ),
                (
                    gid,
                    "尿液檢驗",
                    "尿液微量白蛋白",
                    None,
                    "每年至少1次",
                    "早期腎病變偵測",
                    "A",
                ),
            ],
        )

        await conn.executemany(
            """INSERT INTO guideline.treatment_goals
               (guideline_id, goal_type, target_parameter, target_value, timeframe)
               VALUES ($1,$2,$3,$4,$5)""",
            [
                (
                    gid,
                    "血糖控制",
                    "HbA1c",
                    "<7.0%（一般成人），<8.0%（老年或高風險）",
                    "長期目標",
                ),
                (gid, "血壓控制", "血壓", "<130/80 mmHg", "長期目標"),
                (
                    gid,
                    "血脂控制",
                    "LDL-C",
                    "<100 mg/dL（無心血管疾病），<70 mg/dL（合併心血管疾病）",
                    "長期目標",
                ),
            ],
        )

        # ── 高血壓 (I10) ─────────────────────────────────────────────────
        gid = await conn.fetchval(
            """INSERT INTO guideline.disease_guidelines
               (icd_code, disease_name_zh, disease_name_en, guideline_title,
                guideline_source, publication_year, guideline_summary)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id""",
            "I10",
            "原發性高血壓",
            "Essential Hypertension",
            "2022 台灣高血壓治療指引",
            "台灣高血壓學會",
            2022,
            "本指引提供高血壓的診斷標準、生活型態介入、藥物治療選擇及血壓目標建議",
        )

        await conn.executemany(
            """INSERT INTO guideline.diagnostic_recommendations
               (guideline_id, step_order, recommendation_type, description, evidence_level)
               VALUES ($1,$2,$3,$4,$5)""",
            [
                (
                    gid,
                    1,
                    "血壓測量",
                    "診間血壓 ≥140/90 mmHg（至少兩次不同日測量）",
                    "A",
                ),
                (
                    gid,
                    2,
                    "居家監測",
                    "建議使用居家血壓監測（HBPM）或24小時動態血壓（ABPM）確認診斷",
                    "A",
                ),
                (
                    gid,
                    3,
                    "次發性原因排除",
                    "排除腎動脈狹窄、原發性醛固酮症等次發性高血壓原因",
                    "B",
                ),
            ],
        )

        await conn.executemany(
            """INSERT INTO guideline.medication_recommendations
               (guideline_id, line_of_therapy, medication_class, medication_examples,
                dosage_guidance, contraindications, evidence_level)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            [
                (
                    gid,
                    "第一線",
                    "血管收縮素轉化酶抑制劑 (ACEI)",
                    "Enalapril, Lisinopril",
                    "依血壓反應調整，從低劑量開始",
                    "妊娠、雙側腎動脈狹窄、高血鉀",
                    "A",
                ),
                (
                    gid,
                    "第一線",
                    "血管收縮素受體阻斷劑 (ARB)",
                    "Losartan, Valsartan",
                    "依血壓反應調整",
                    "妊娠、雙側腎動脈狹窄、高血鉀",
                    "A",
                ),
                (
                    gid,
                    "第一線",
                    "鈣離子通道阻斷劑 (CCB)",
                    "Amlodipine, Nifedipine",
                    "依血壓反應調整",
                    "心衰竭（需謹慎）",
                    "A",
                ),
                (
                    gid,
                    "第一線",
                    "利尿劑 (Thiazide)",
                    "Hydrochlorothiazide, Indapamide",
                    "低劑量開始，監測電解質",
                    "痛風病史（需謹慎）",
                    "A",
                ),
                (
                    gid,
                    "第二線",
                    "乙型阻斷劑 (Beta-blocker)",
                    "Bisoprolol, Carvedilol",
                    "有心臟病或年輕患者優先考慮",
                    "氣喘、心搏過慢",
                    "B",
                ),
            ],
        )

        await conn.executemany(
            """INSERT INTO guideline.test_recommendations
               (guideline_id, test_category, test_name, loinc_code,
                frequency, indication, evidence_level)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            [
                (
                    gid,
                    "生化檢驗",
                    "腎功能 (Cr, eGFR)",
                    "2160-0",
                    "每年至少1次",
                    "評估腎臟損害",
                    "A",
                ),
                (
                    gid,
                    "生化檢驗",
                    "電解質 (Na, K)",
                    "2951-2",
                    "開始利尿劑治療前及定期追蹤",
                    "監測電解質異常",
                    "A",
                ),
                (
                    gid,
                    "心電圖",
                    "靜態心電圖",
                    None,
                    "診斷時及每年追蹤",
                    "評估心臟肥大或缺血",
                    "B",
                ),
                (gid, "尿液檢驗", "尿液檢查", None, "每年至少1次", "篩檢蛋白尿", "B"),
            ],
        )

        await conn.execute(
            """INSERT INTO guideline.treatment_goals
               (guideline_id, goal_type, target_parameter, target_value, timeframe)
               VALUES ($1,$2,$3,$4,$5)""",
            gid,
            "血壓控制",
            "血壓",
            "<140/90 mmHg（一般成人），<130/80 mmHg（糖尿病或慢性腎臟病患者）",
            "長期目標",
        )

        # ── 高血脂症 (E78) ───────────────────────────────────────────────
        gid = await conn.fetchval(
            """INSERT INTO guideline.disease_guidelines
               (icd_code, disease_name_zh, disease_name_en, guideline_title,
                guideline_source, publication_year, guideline_summary)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id""",
            "E78",
            "高血脂症",
            "Hyperlipidemia",
            "2023 台灣血脂異常治療指引",
            "中華民國血脂及動脈硬化學會",
            2023,
            "本指引提供血脂異常的診斷、心血管風險評估及降血脂藥物使用建議",
        )

        await conn.executemany(
            """INSERT INTO guideline.medication_recommendations
               (guideline_id, line_of_therapy, medication_class, medication_examples,
                dosage_guidance, contraindications, evidence_level)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            [
                (
                    gid,
                    "第一線",
                    "史他汀類 (Statin)",
                    "Atorvastatin, Rosuvastatin",
                    "中至高強度，依心血管風險決定",
                    "活動性肝病、孕婦",
                    "A",
                ),
                (
                    gid,
                    "第二線",
                    "Ezetimibe",
                    "Ezetimibe",
                    "10mg 每日一次，可與 Statin 併用",
                    "無特殊禁忌",
                    "B",
                ),
                (
                    gid,
                    "第二線",
                    "PCSK9 抑制劑",
                    "Evolocumab, Alirocumab",
                    "皮下注射，用於高風險且 Statin 無法達標者",
                    "成本考量",
                    "A",
                ),
                (
                    gid,
                    "其他",
                    "纖維酸類 (Fibrate)",
                    "Fenofibrate",
                    "主要用於高三酸甘油酯",
                    "腎功能不全",
                    "B",
                ),
            ],
        )

        await conn.execute(
            """INSERT INTO guideline.test_recommendations
               (guideline_id, test_category, test_name, loinc_code,
                frequency, indication, evidence_level)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            gid,
            "生化檢驗",
            "血脂肪 (TC, LDL, HDL, TG)",
            "2093-3",
            "開始治療前及治療4-12週後追蹤",
            "評估治療效果",
            "A",
        )

        await conn.executemany(
            """INSERT INTO guideline.treatment_goals
               (guideline_id, goal_type, target_parameter, target_value, timeframe)
               VALUES ($1,$2,$3,$4,$5)""",
            [
                (
                    gid,
                    "血脂控制",
                    "LDL-C",
                    "<100 mg/dL（中風險），<70 mg/dL（高風險），<55 mg/dL（極高風險）",
                    "依心血管風險分層",
                ),
                (gid, "血脂控制", "三酸甘油酯", "<150 mg/dL", "降低心血管風險"),
                (
                    gid,
                    "血脂控制",
                    "HDL-C",
                    ">40 mg/dL（男性），>50 mg/dL（女性）",
                    "心血管保護因子",
                ),
            ],
        )

        # ── 慢性腎臟病 (N18) ─────────────────────────────────────────────
        gid = await conn.fetchval(
            """INSERT INTO guideline.disease_guidelines
               (icd_code, disease_name_zh, disease_name_en, guideline_title,
                guideline_source, publication_year, guideline_summary)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id""",
            "N18",
            "慢性腎臟病",
            "Chronic Kidney Disease",
            "2023 台灣慢性腎臟病臨床診療指引",
            "台灣腎臟醫學會",
            2023,
            "本指引涵蓋 CKD 的分期診斷、進展延緩、併發症管理及腎臟替代療法準備",
        )

        await conn.executemany(
            """INSERT INTO guideline.diagnostic_recommendations
               (guideline_id, step_order, recommendation_type, description, evidence_level)
               VALUES ($1,$2,$3,$4,$5)""",
            [
                (
                    gid,
                    1,
                    "腎功能評估",
                    "計算 eGFR（CKD-EPI 公式），依 eGFR 分為 G1-G5 期",
                    "A",
                ),
                (
                    gid,
                    2,
                    "蛋白尿評估",
                    "測量尿液白蛋白肌酸酐比值（UACR），分為 A1-A3 期",
                    "A",
                ),
                (
                    gid,
                    3,
                    "病因診斷",
                    "確認 CKD 病因（糖尿病腎病變、高血壓腎病變等）",
                    "B",
                ),
            ],
        )

        await conn.executemany(
            """INSERT INTO guideline.test_recommendations
               (guideline_id, test_category, test_name, loinc_code,
                frequency, indication, evidence_level)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            [
                (
                    gid,
                    "生化檢驗",
                    "腎功能 (Cr, eGFR)",
                    "33914-3",
                    "每3-6個月",
                    "監測腎功能進展",
                    "A",
                ),
                (
                    gid,
                    "尿液檢驗",
                    "尿液白蛋白肌酸酐比值 (UACR)",
                    None,
                    "每年",
                    "蛋白尿監測",
                    "A",
                ),
                (
                    gid,
                    "生化檢驗",
                    "電解質",
                    "2951-2",
                    "每3-6個月",
                    "監測高血鉀、代謝性酸中毒",
                    "A",
                ),
                (gid, "生化檢驗", "血色素", "718-7", "每6個月", "腎性貧血評估", "B"),
            ],
        )

        await conn.executemany(
            """INSERT INTO guideline.treatment_goals
               (guideline_id, goal_type, target_parameter, target_value, timeframe)
               VALUES ($1,$2,$3,$4,$5)""",
            [
                (gid, "腎功能保護", "eGFR 下降速率", "<5 mL/min/1.73m²/年", "長期監測"),
                (gid, "蛋白尿控制", "UACR", "<30 mg/g（目標值）", "長期目標"),
                (gid, "血壓控制", "血壓", "<130/80 mmHg", "長期目標"),
            ],
        )

    count = await pool.fetchval("SELECT COUNT(*) FROM guideline.disease_guidelines")
    print(f"  Clinical guidelines seeded: {count} guidelines.")

"""
Clinical Guideline Service - 臨床診療指引整合服務
整合台灣臨床診療指引、用藥建議、檢查流程
"""

import json
import os
import sqlite3
from typing import Dict, Optional

from utils import log_error, log_info


class ClinicalGuidelineService:
    """
    臨床診療指引服務
    - 疾病診療指引查詢
    - 用藥建議
    - 檢查流程建議
    - 治療路徑
    """

    def __init__(self, data_dir: str):
        """初始化臨床診療指引服務"""
        self.data_dir = data_dir
        self.db_path = os.path.join(data_dir, "clinical_guidelines.db")
        self._initialize_database()
        log_info("Clinical Guideline Service initialized")

    def _initialize_database(self):
        """初始化資料庫，建立臨床指引資料表"""
        if os.path.exists(self.db_path):
            log_info(f"Clinical guideline database found at: {self.db_path}")
            return

        log_info("Initializing Clinical Guideline database...")
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        try:
            # 1. 疾病診療指引主表
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS disease_guidelines (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    icd_code TEXT NOT NULL,
                    disease_name_zh TEXT NOT NULL,
                    disease_name_en TEXT,
                    guideline_title TEXT NOT NULL,
                    guideline_source TEXT,
                    publication_year INTEGER,
                    guideline_summary TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """
            )

            # 2. 診斷建議表
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS diagnostic_recommendations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guideline_id INTEGER NOT NULL,
                    step_order INTEGER,
                    recommendation_type TEXT,
                    description TEXT,
                    evidence_level TEXT,
                    FOREIGN KEY (guideline_id) REFERENCES disease_guidelines(id)
                )
            """
            )

            # 3. 用藥建議表
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS medication_recommendations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guideline_id INTEGER NOT NULL,
                    line_of_therapy TEXT,
                    medication_class TEXT,
                    medication_examples TEXT,
                    dosage_guidance TEXT,
                    contraindications TEXT,
                    evidence_level TEXT,
                    FOREIGN KEY (guideline_id) REFERENCES disease_guidelines(id)
                )
            """
            )

            # 4. 檢查建議表
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS test_recommendations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guideline_id INTEGER NOT NULL,
                    test_category TEXT,
                    test_name TEXT,
                    loinc_code TEXT,
                    frequency TEXT,
                    indication TEXT,
                    evidence_level TEXT,
                    FOREIGN KEY (guideline_id) REFERENCES disease_guidelines(id)
                )
            """
            )

            # 5. 治療目標表
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS treatment_goals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guideline_id INTEGER NOT NULL,
                    goal_type TEXT,
                    target_parameter TEXT,
                    target_value TEXT,
                    timeframe TEXT,
                    FOREIGN KEY (guideline_id) REFERENCES disease_guidelines(id)
                )
            """
            )

            # 插入台灣常見疾病的診療指引
            self._populate_taiwan_guidelines(cursor)

            # 建立索引
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_icd_code ON disease_guidelines(icd_code)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_disease_name ON disease_guidelines(disease_name_zh)"
            )

            conn.commit()
            log_info("Clinical Guideline database initialized successfully")

        except Exception as e:
            log_error(f"Failed to initialize clinical guideline database: {e}")
            conn.rollback()
        finally:
            conn.close()

    def _populate_taiwan_guidelines(self, cursor):
        """填充台灣常見疾病的診療指引"""

        # === 第二型糖尿病診療指引 ===
        cursor.execute(
            """
            INSERT INTO disease_guidelines
            (icd_code, disease_name_zh, disease_name_en, guideline_title, guideline_source, publication_year, guideline_summary)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
            (
                "E11",
                "第二型糖尿病",
                "Type 2 Diabetes Mellitus",
                "2024 台灣糖尿病臨床照護指引",
                "中華民國糖尿病學會",
                2024,
                "本指引涵蓋第二型糖尿病的診斷、血糖控制目標、藥物治療、併發症預防等完整照護建議",
            ),
        )
        guideline_id = cursor.lastrowid

        # 診斷建議
        diagnostic_steps = [
            (
                1,
                "實驗室檢查",
                "空腹血糖 ≥126 mg/dL，或隨機血糖 ≥200 mg/dL 合併典型症狀，或HbA1c ≥6.5%",
                "A",
            ),
            (2, "確認診斷", "異常結果需重複檢測確認（除非有明顯高血糖症狀）", "A"),
            (3, "併發症篩檢", "診斷時即應篩檢視網膜病變、腎病變、神經病變", "B"),
        ]
        for step in diagnostic_steps:
            cursor.execute(
                """
                INSERT INTO diagnostic_recommendations
                (guideline_id, step_order, recommendation_type, description, evidence_level)
                VALUES (?, ?, ?, ?, ?)
            """,
                (guideline_id, *step),
            )

        # 用藥建議
        medications = [
            (
                "第一線",
                "雙胍類 (Biguanide)",
                "Metformin",
                "起始劑量 500mg 每日一次，逐漸增加至 500-1000mg 每日兩次",
                "腎功能不全 (eGFR <30)",
                "A",
            ),
            (
                "第二線",
                "SGLT2 抑制劑",
                "Empagliflozin, Dapagliflozin",
                "依藥品仿單建議劑量",
                "eGFR <20-30 (依藥品而異)",
                "A",
            ),
            (
                "第二線",
                "GLP-1 受體促效劑",
                "Dulaglutide, Semaglutide",
                "皮下注射，每週一次",
                "甲狀腺髓樣癌病史或家族史",
                "A",
            ),
            (
                "第二線",
                "DPP-4 抑制劑",
                "Sitagliptin, Linagliptin",
                "依藥品仿單建議劑量",
                "無特殊禁忌",
                "B",
            ),
            (
                "輔助治療",
                "胰島素",
                "長效/速效胰島素",
                "依血糖控制情況調整劑量",
                "需注意低血糖風險",
                "A",
            ),
        ]
        for med in medications:
            cursor.execute(
                """
                INSERT INTO medication_recommendations
                (guideline_id, line_of_therapy, medication_class, medication_examples, dosage_guidance, contraindications, evidence_level)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                (guideline_id, *med),
            )

        # 檢查建議
        tests = [
            (
                "生化檢驗",
                "糖化血色素 (HbA1c)",
                "4548-4",
                "每3個月",
                "評估血糖控制",
                "A",
            ),
            ("生化檢驗", "空腹血糖", "1558-6", "每次回診", "監測血糖", "A"),
            (
                "生化檢驗",
                "腎功能 (Cr, eGFR)",
                "2160-0",
                "每年至少1次",
                "篩檢糖尿病腎病變",
                "A",
            ),
            (
                "尿液檢驗",
                "尿液白蛋白/肌酸酐比值",
                "14959-1",
                "每年至少1次",
                "篩檢早期腎病變",
                "A",
            ),
            (
                "生化檢驗",
                "血脂肪 (TC, LDL, HDL, TG)",
                "2093-3",
                "每年至少1次",
                "評估心血管風險",
                "A",
            ),
            ("其他檢查", "眼底檢查", None, "每年至少1次", "篩檢視網膜病變", "A"),
        ]
        for test in tests:
            cursor.execute(
                """
                INSERT INTO test_recommendations
                (guideline_id, test_category, test_name, loinc_code, frequency, indication, evidence_level)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                (guideline_id, *test),
            )

        # 治療目標
        goals = [
            (
                "血糖控制",
                "HbA1c",
                "<7%（一般成人），<8%（老年人或多重共病）",
                "長期控制目標",
            ),
            ("血糖控制", "空腹血糖", "80-130 mg/dL", "日常監測目標"),
            ("血糖控制", "飯後2小時血糖", "<180 mg/dL", "日常監測目標"),
            ("血壓控制", "血壓", "<140/90 mmHg", "預防心血管併發症"),
            ("血脂控制", "LDL-C", "<100 mg/dL（高風險 <70 mg/dL）", "預防心血管併發症"),
        ]
        for goal in goals:
            cursor.execute(
                """
                INSERT INTO treatment_goals
                (guideline_id, goal_type, target_parameter, target_value, timeframe)
                VALUES (?, ?, ?, ?, ?)
            """,
                (guideline_id, *goal),
            )

        # === 高血壓診療指引 ===
        cursor.execute(
            """
            INSERT INTO disease_guidelines
            (icd_code, disease_name_zh, disease_name_en, guideline_title, guideline_source, publication_year, guideline_summary)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
            (
                "I10",
                "原發性高血壓",
                "Essential Hypertension",
                "2022 台灣高血壓治療指引",
                "中華民國心臟學會",
                2022,
                "本指引提供高血壓的診斷標準、分級、治療目標及藥物選擇建議",
            ),
        )
        guideline_id = cursor.lastrowid

        # 診斷建議
        cursor.execute(
            """
            INSERT INTO diagnostic_recommendations
            (guideline_id, step_order, recommendation_type, description, evidence_level)
            VALUES (?, ?, ?, ?, ?)
        """,
            (
                guideline_id,
                1,
                "血壓測量",
                "診間血壓 ≥140/90 mmHg，或家庭血壓 ≥135/85 mmHg",
                "A",
            ),
        )

        cursor.execute(
            """
            INSERT INTO diagnostic_recommendations
            (guideline_id, step_order, recommendation_type, description, evidence_level)
            VALUES (?, ?, ?, ?, ?)
        """,
            (
                guideline_id,
                2,
                "次發性高血壓篩檢",
                "年輕患者（<40歲）或突發性高血壓應排除次發性原因",
                "B",
            ),
        )

        # 用藥建議
        hypertension_meds = [
            (
                "第一線",
                "血管收縮素轉換酶抑制劑 (ACEI)",
                "Enalapril, Ramipril",
                "起始低劑量，逐步調整",
                "孕婦、雙側腎動脈狹窄",
                "A",
            ),
            (
                "第一線",
                "血管收縮素受體阻斷劑 (ARB)",
                "Losartan, Valsartan",
                "起始低劑量，逐步調整",
                "孕婦",
                "A",
            ),
            (
                "第一線",
                "鈣離子通道阻斷劑 (CCB)",
                "Amlodipine, Nifedipine",
                "長效型為佳",
                "心臟傳導異常",
                "A",
            ),
            (
                "第一線",
                "利尿劑",
                "Hydrochlorothiazide",
                "低劑量使用（12.5-25mg）",
                "痛風、低血鉀",
                "A",
            ),
            (
                "第二線",
                "乙型阻斷劑 (Beta-blocker)",
                "Bisoprolol, Carvedilol",
                "有心臟病或年輕患者優先考慮",
                "氣喘、心搏過慢",
                "B",
            ),
        ]
        for med in hypertension_meds:
            cursor.execute(
                """
                INSERT INTO medication_recommendations
                (guideline_id, line_of_therapy, medication_class, medication_examples, dosage_guidance, contraindications, evidence_level)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                (guideline_id, *med),
            )

        # 檢查建議
        hypertension_tests = [
            (
                "生化檢驗",
                "腎功能 (Cr, eGFR)",
                "2160-0",
                "每年至少1次",
                "評估腎臟損害",
                "A",
            ),
            (
                "生化檢驗",
                "電解質 (Na, K)",
                "2951-2",
                "開始利尿劑治療前及定期追蹤",
                "監測電解質異常",
                "A",
            ),
            (
                "心電圖",
                "靜態心電圖",
                None,
                "診斷時及每年追蹤",
                "評估心臟肥大或缺血",
                "B",
            ),
            ("尿液檢驗", "尿液檢查", None, "每年至少1次", "篩檢蛋白尿", "B"),
        ]
        for test in hypertension_tests:
            cursor.execute(
                """
                INSERT INTO test_recommendations
                (guideline_id, test_category, test_name, loinc_code, frequency, indication, evidence_level)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                (guideline_id, *test),
            )

        # 治療目標
        cursor.execute(
            """
            INSERT INTO treatment_goals
            (guideline_id, goal_type, target_parameter, target_value, timeframe)
            VALUES (?, ?, ?, ?, ?)
        """,
            (
                guideline_id,
                "血壓控制",
                "血壓",
                "<140/90 mmHg（一般成人），<130/80 mmHg（糖尿病或慢性腎臟病患者）",
                "長期目標",
            ),
        )

        # === 高血脂症診療指引 ===
        cursor.execute(
            """
            INSERT INTO disease_guidelines
            (icd_code, disease_name_zh, disease_name_en, guideline_title, guideline_source, publication_year, guideline_summary)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
            (
                "E78",
                "高血脂症",
                "Hyperlipidemia",
                "2023 台灣血脂異常治療指引",
                "中華民國血脂及動脈硬化學會",
                2023,
                "本指引提供血脂異常的診斷、心血管風險評估及降血脂藥物使用建議",
            ),
        )
        guideline_id = cursor.lastrowid

        # 用藥建議
        lipid_meds = [
            (
                "第一線",
                "史他汀類 (Statin)",
                "Atorvastatin, Rosuvastatin",
                "中至高強度，依心血管風險決定",
                "活動性肝病、孕婦",
                "A",
            ),
            (
                "第二線",
                "Ezetimibe",
                "Ezetimibe",
                "10mg 每日一次，可與 Statin 併用",
                "無特殊禁忌",
                "B",
            ),
            (
                "第二線",
                "PCSK9 抑制劑",
                "Evolocumab, Alirocumab",
                "皮下注射，用於高風險且 Statin 無法達標者",
                "成本考量",
                "A",
            ),
            (
                "其他",
                "纖維酸類 (Fibrate)",
                "Fenofibrate",
                "主要用於高三酸甘油酯",
                "腎功能不全",
                "B",
            ),
        ]
        for med in lipid_meds:
            cursor.execute(
                """
                INSERT INTO medication_recommendations
                (guideline_id, line_of_therapy, medication_class, medication_examples, dosage_guidance, contraindications, evidence_level)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                (guideline_id, *med),
            )

        # 檢查建議
        cursor.execute(
            """
            INSERT INTO test_recommendations
            (guideline_id, test_category, test_name, loinc_code, frequency, indication, evidence_level)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
            (
                guideline_id,
                "生化檢驗",
                "血脂肪 (TC, LDL, HDL, TG)",
                "2093-3",
                "開始治療前及治療4-12週後追蹤",
                "評估治療效果",
                "A",
            ),
        )

        # 治療目標
        lipid_goals = [
            (
                "血脂控制",
                "LDL-C",
                "<100 mg/dL（中風險），<70 mg/dL（高風險），<55 mg/dL（極高風險）",
                "依心血管風險分層",
            ),
            ("血脂控制", "三酸甘油酯", "<150 mg/dL", "降低心血管風險"),
            (
                "血脂控制",
                "HDL-C",
                ">40 mg/dL（男性），>50 mg/dL（女性）",
                "心血管保護因子",
            ),
        ]
        for goal in lipid_goals:
            cursor.execute(
                """
                INSERT INTO treatment_goals
                (guideline_id, goal_type, target_parameter, target_value, timeframe)
                VALUES (?, ?, ?, ?, ?)
            """,
                (guideline_id, *goal),
            )

        log_info("Populated Taiwan clinical guidelines for common diseases")

    def _query_db(self, sql: str, params: tuple = ()) -> list:
        """執行 SQL 查詢"""
        try:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(sql, params)
            rows = [dict(row) for row in cursor.fetchall()]
            conn.close()
            return rows
        except Exception as e:
            log_error(f"Database query failed: {e}")
            return []

    # ==========================================
    # 診療指引查詢功能
    # ==========================================

    def search_guideline(self, keyword: str) -> str:
        """
        搜尋診療指引

        Args:
            keyword: 疾病名稱或 ICD 碼

        Returns:
            診療指引摘要
        """
        term = f"%{keyword}%"
        sql = """
            SELECT id, icd_code, disease_name_zh, disease_name_en,
                   guideline_title, guideline_source, publication_year
            FROM disease_guidelines
            WHERE icd_code LIKE ? OR disease_name_zh LIKE ? OR disease_name_en LIKE ?
            ORDER BY publication_year DESC
        """
        results = self._query_db(sql, (term, term, term))

        if not results:
            return json.dumps(
                {
                    "message": f"找不到符合 '{keyword}' 的診療指引",
                    "suggestion": "請使用疾病中文名稱或 ICD-10 編碼搜尋",
                },
                ensure_ascii=False,
            )

        return json.dumps(
            {"keyword": keyword, "total_found": len(results), "guidelines": results},
            ensure_ascii=False,
        )

    def get_complete_guideline(self, icd_code: str) -> str:
        """
        取得完整診療指引（包含診斷、用藥、檢查、治療目標）

        Args:
            icd_code: ICD-10 編碼

        Returns:
            完整診療指引
        """
        # 取得指引主資料
        guideline = self._query_db(
            "SELECT * FROM disease_guidelines WHERE icd_code = ? OR icd_code LIKE ?",
            (icd_code, f"{icd_code}%"),
        )

        if not guideline:
            return json.dumps(
                {"error": f"找不到 ICD 碼 '{icd_code}' 的診療指引"}, ensure_ascii=False
            )

        guideline = guideline[0]
        guideline_id = guideline["id"]

        # 取得診斷建議
        diagnostics = self._query_db(
            "SELECT * FROM diagnostic_recommendations WHERE guideline_id = ? ORDER BY step_order",
            (guideline_id,),
        )

        # 取得用藥建議
        medications = self._query_db(
            "SELECT * FROM medication_recommendations WHERE guideline_id = ? ORDER BY line_of_therapy",
            (guideline_id,),
        )

        # 取得檢查建議
        tests = self._query_db(
            "SELECT * FROM test_recommendations WHERE guideline_id = ? ORDER BY test_category",
            (guideline_id,),
        )

        # 取得治療目標
        goals = self._query_db(
            "SELECT * FROM treatment_goals WHERE guideline_id = ? ORDER BY goal_type",
            (guideline_id,),
        )

        return json.dumps(
            {
                "guideline_info": {
                    "icd_code": guideline["icd_code"],
                    "disease_name_zh": guideline["disease_name_zh"],
                    "disease_name_en": guideline["disease_name_en"],
                    "title": guideline["guideline_title"],
                    "source": guideline["guideline_source"],
                    "year": guideline["publication_year"],
                    "summary": guideline["guideline_summary"],
                },
                "diagnostic_recommendations": diagnostics,
                "medication_recommendations": medications,
                "test_recommendations": tests,
                "treatment_goals": goals,
            },
            ensure_ascii=False,
        )

    def get_medication_recommendations(self, icd_code: str) -> str:
        """
        取得用藥建議

        Args:
            icd_code: ICD-10 編碼

        Returns:
            用藥建議清單
        """
        sql = """
            SELECT mr.*
            FROM medication_recommendations mr
            JOIN disease_guidelines dg ON mr.guideline_id = dg.id
            WHERE dg.icd_code = ? OR dg.icd_code LIKE ?
            ORDER BY mr.line_of_therapy
        """
        results = self._query_db(sql, (icd_code, f"{icd_code}%"))

        if not results:
            return json.dumps(
                {"message": f"找不到 ICD 碼 '{icd_code}' 的用藥建議"},
                ensure_ascii=False,
            )

        return json.dumps(
            {
                "icd_code": icd_code,
                "total_recommendations": len(results),
                "medications": results,
            },
            ensure_ascii=False,
        )

    def get_test_recommendations(self, icd_code: str) -> str:
        """
        取得檢查建議

        Args:
            icd_code: ICD-10 編碼

        Returns:
            檢查建議清單
        """
        sql = """
            SELECT tr.*
            FROM test_recommendations tr
            JOIN disease_guidelines dg ON tr.guideline_id = dg.id
            WHERE dg.icd_code = ? OR dg.icd_code LIKE ?
            ORDER BY tr.test_category
        """
        results = self._query_db(sql, (icd_code, f"{icd_code}%"))

        if not results:
            return json.dumps(
                {"message": f"找不到 ICD 碼 '{icd_code}' 的檢查建議"},
                ensure_ascii=False,
            )

        return json.dumps(
            {
                "icd_code": icd_code,
                "total_recommendations": len(results),
                "tests": results,
            },
            ensure_ascii=False,
        )

    def get_treatment_goals(self, icd_code: str) -> str:
        """
        取得治療目標

        Args:
            icd_code: ICD-10 編碼

        Returns:
            治療目標清單
        """
        sql = """
            SELECT tg.*
            FROM treatment_goals tg
            JOIN disease_guidelines dg ON tg.guideline_id = dg.id
            WHERE dg.icd_code = ? OR dg.icd_code LIKE ?
            ORDER BY tg.goal_type
        """
        results = self._query_db(sql, (icd_code, f"{icd_code}%"))

        if not results:
            return json.dumps(
                {"message": f"找不到 ICD 碼 '{icd_code}' 的治療目標"},
                ensure_ascii=False,
            )

        return json.dumps(
            {"icd_code": icd_code, "total_goals": len(results), "goals": results},
            ensure_ascii=False,
        )

    def suggest_clinical_pathway(
        self, icd_code: str, patient_context: Optional[Dict] = None
    ) -> str:
        """
        根據疾病建議臨床路徑

        Args:
            icd_code: ICD-10 編碼
            patient_context: 患者背景資訊（年齡、性別、共病等）

        Returns:
            臨床路徑建議
        """
        guideline_data = json.loads(self.get_complete_guideline(icd_code))

        if "error" in guideline_data:
            return json.dumps(guideline_data, ensure_ascii=False)

        # 組織臨床路徑
        clinical_pathway = {
            "disease": guideline_data["guideline_info"]["disease_name_zh"],
            "icd_code": icd_code,
            "pathway": {
                "step1_diagnosis": {
                    "phase": "診斷確認階段",
                    "actions": [
                        rec["description"]
                        for rec in guideline_data["diagnostic_recommendations"]
                    ],
                },
                "step2_baseline_tests": {
                    "phase": "基礎檢查階段",
                    "actions": [
                        f"{test['test_name']} ({test['indication']})"
                        for test in guideline_data["test_recommendations"]
                        if "診斷" in test["indication"] or "基礎" in test["indication"]
                    ],
                },
                "step3_treatment_initiation": {
                    "phase": "治療啟始階段",
                    "actions": [
                        f"第一線用藥: {med['medication_class']} (例如: {med['medication_examples']})"
                        for med in guideline_data["medication_recommendations"]
                        if "第一線" in med["line_of_therapy"]
                    ],
                },
                "step4_monitoring": {
                    "phase": "追蹤監測階段",
                    "actions": [
                        f"{test['test_name']} - {test['frequency']}"
                        for test in guideline_data["test_recommendations"]
                        if "追蹤" in test["indication"] or "監測" in test["indication"]
                    ],
                },
                "step5_treatment_goals": {
                    "phase": "治療目標",
                    "targets": [
                        f"{goal['target_parameter']}: {goal['target_value']}"
                        for goal in guideline_data["treatment_goals"]
                    ],
                },
            },
            "guideline_source": guideline_data["guideline_info"]["source"],
            "guideline_year": guideline_data["guideline_info"]["year"],
        }

        if patient_context:
            clinical_pathway["patient_context"] = patient_context
            clinical_pathway["note"] = "臨床路徑應根據個別患者情況調整"

        return json.dumps(clinical_pathway, ensure_ascii=False, indent=2)

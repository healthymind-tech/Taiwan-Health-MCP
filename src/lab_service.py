"""
Laboratory Service - LOINC 碼對照與檢驗參考值查詢
整合台灣常用檢驗項目、LOINC 標準碼、參考值範圍
"""

import json
import os
import sqlite3
from typing import Dict, List, Literal, Optional

from utils import log_error, log_info


class LabService:
    """
    檢驗服務
    - LOINC 碼對照（台灣檢驗項目 ↔ LOINC 國際標準）
    - 檢驗參考值查詢（依年齡、性別）
    - 檢驗結果判讀
    - FHIR Observation 轉換
    """

    def __init__(self, data_dir: str):
        """
        初始化檢驗服務

        Args:
            data_dir: 資料目錄路徑
        """
        self.data_dir = data_dir
        self.db_path = os.path.join(data_dir, "lab_tests.db")
        self._initialize_database()
        log_info("Lab Service initialized")

    def _initialize_database(self):
        """初始化資料庫，建立 LOINC 對照表與參考值表"""
        if os.path.exists(self.db_path):
            log_info(f"Lab database found at: {self.db_path}")
            return

        log_info("Initializing Lab database with Taiwan common lab tests...")
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        try:
            # 1. LOINC 對照表
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS loinc_mapping (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    loinc_code TEXT NOT NULL UNIQUE,
                    loinc_name_en TEXT NOT NULL,
                    loinc_name_zh TEXT NOT NULL,
                    common_name_zh TEXT,
                    category TEXT,
                    specimen_type TEXT,
                    unit TEXT,
                    method TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """
            )

            # 2. 參考值表
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS reference_ranges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    loinc_code TEXT NOT NULL,
                    age_min INTEGER,
                    age_max INTEGER,
                    gender TEXT,
                    range_low REAL,
                    range_high REAL,
                    unit TEXT,
                    interpretation TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (loinc_code) REFERENCES loinc_mapping(loinc_code)
                )
            """
            )

            # 3. 插入台灣常用檢驗項目資料
            self._populate_taiwan_common_tests(cursor)

            # 4. 建立索引
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_loinc_code ON loinc_mapping(loinc_code)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_loinc_name_zh ON loinc_mapping(loinc_name_zh)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_category ON loinc_mapping(category)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_ref_loinc ON reference_ranges(loinc_code)"
            )

            conn.commit()
            log_info("Lab database initialized successfully")

        except Exception as e:
            log_error(f"Failed to initialize lab database: {e}")
            conn.rollback()
        finally:
            conn.close()

    def _populate_taiwan_common_tests(self, cursor):
        """填充台灣常用檢驗項目（基於真實醫院檢驗科資料）"""

        # 台灣常用檢驗項目與 LOINC 對照表
        common_tests = [
            # === 血液常規 (CBC) ===
            {
                "loinc_code": "6690-2",
                "loinc_name_en": "Leukocytes [#/volume] in Blood by Automated count",
                "loinc_name_zh": "白血球計數",
                "common_name_zh": "WBC",
                "category": "血液常規",
                "specimen_type": "全血",
                "unit": "10^3/uL",
                "method": "自動血球計數儀",
            },
            {
                "loinc_code": "789-8",
                "loinc_name_en": "Erythrocytes [#/volume] in Blood by Automated count",
                "loinc_name_zh": "紅血球計數",
                "common_name_zh": "RBC",
                "category": "血液常規",
                "specimen_type": "全血",
                "unit": "10^6/uL",
                "method": "自動血球計數儀",
            },
            {
                "loinc_code": "718-7",
                "loinc_name_en": "Hemoglobin [Mass/volume] in Blood",
                "loinc_name_zh": "血紅素",
                "common_name_zh": "Hb",
                "category": "血液常規",
                "specimen_type": "全血",
                "unit": "g/dL",
                "method": "自動血球計數儀",
            },
            {
                "loinc_code": "4544-3",
                "loinc_name_en": "Hematocrit [Volume Fraction] of Blood by Automated count",
                "loinc_name_zh": "血球容積比",
                "common_name_zh": "Hct",
                "category": "血液常規",
                "specimen_type": "全血",
                "unit": "%",
                "method": "自動血球計數儀",
            },
            {
                "loinc_code": "777-3",
                "loinc_name_en": "Platelets [#/volume] in Blood by Automated count",
                "loinc_name_zh": "血小板計數",
                "common_name_zh": "PLT",
                "category": "血液常規",
                "specimen_type": "全血",
                "unit": "10^3/uL",
                "method": "自動血球計數儀",
            },
            # === 生化檢驗 - 血糖相關 ===
            {
                "loinc_code": "1558-6",
                "loinc_name_en": "Fasting glucose [Mass/volume] in Serum or Plasma",
                "loinc_name_zh": "空腹血糖",
                "common_name_zh": "AC Sugar, FBS",
                "category": "生化檢驗-血糖",
                "specimen_type": "血清/血漿",
                "unit": "mg/dL",
                "method": "酵素法",
            },
            {
                "loinc_code": "2345-7",
                "loinc_name_en": "Glucose [Mass/volume] in Serum or Plasma",
                "loinc_name_zh": "血糖",
                "common_name_zh": "Glucose",
                "category": "生化檢驗-血糖",
                "specimen_type": "血清/血漿",
                "unit": "mg/dL",
                "method": "酵素法",
            },
            {
                "loinc_code": "4548-4",
                "loinc_name_en": "Hemoglobin A1c/Hemoglobin.total in Blood",
                "loinc_name_zh": "糖化血色素",
                "common_name_zh": "HbA1c",
                "category": "生化檢驗-血糖",
                "specimen_type": "全血",
                "unit": "%",
                "method": "HPLC",
            },
            # === 生化檢驗 - 血脂肪 ===
            {
                "loinc_code": "2093-3",
                "loinc_name_en": "Cholesterol [Mass/volume] in Serum or Plasma",
                "loinc_name_zh": "總膽固醇",
                "common_name_zh": "T-Chol",
                "category": "生化檢驗-血脂",
                "specimen_type": "血清/血漿",
                "unit": "mg/dL",
                "method": "酵素法",
            },
            {
                "loinc_code": "2571-8",
                "loinc_name_en": "Triglyceride [Mass/volume] in Serum or Plasma",
                "loinc_name_zh": "三酸甘油酯",
                "common_name_zh": "TG",
                "category": "生化檢驗-血脂",
                "specimen_type": "血清/血漿",
                "unit": "mg/dL",
                "method": "酵素法",
            },
            {
                "loinc_code": "2085-9",
                "loinc_name_en": "Cholesterol in HDL [Mass/volume] in Serum or Plasma",
                "loinc_name_zh": "高密度脂蛋白膽固醇",
                "common_name_zh": "HDL-C",
                "category": "生化檢驗-血脂",
                "specimen_type": "血清/血漿",
                "unit": "mg/dL",
                "method": "直接法",
            },
            {
                "loinc_code": "2089-1",
                "loinc_name_en": "Cholesterol in LDL [Mass/volume] in Serum or Plasma",
                "loinc_name_zh": "低密度脂蛋白膽固醇",
                "common_name_zh": "LDL-C",
                "category": "生化檢驗-血脂",
                "specimen_type": "血清/血漿",
                "unit": "mg/dL",
                "method": "計算法/直接法",
            },
            # === 生化檢驗 - 肝功能 ===
            {
                "loinc_code": "1742-6",
                "loinc_name_en": "Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma",
                "loinc_name_zh": "丙胺酸轉胺酶",
                "common_name_zh": "ALT, GPT",
                "category": "生化檢驗-肝功能",
                "specimen_type": "血清/血漿",
                "unit": "U/L",
                "method": "酵素法",
            },
            {
                "loinc_code": "1920-8",
                "loinc_name_en": "Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma",
                "loinc_name_zh": "天門冬胺酸轉胺酶",
                "common_name_zh": "AST, GOT",
                "category": "生化檢驗-肝功能",
                "specimen_type": "血清/血漿",
                "unit": "U/L",
                "method": "酵素法",
            },
            {
                "loinc_code": "1975-2",
                "loinc_name_en": "Bilirubin.total [Mass/volume] in Serum or Plasma",
                "loinc_name_zh": "總膽紅素",
                "common_name_zh": "T-Bil",
                "category": "生化檢驗-肝功能",
                "specimen_type": "血清/血漿",
                "unit": "mg/dL",
                "method": "化學法",
            },
            # === 生化檢驗 - 腎功能 ===
            {
                "loinc_code": "2160-0",
                "loinc_name_en": "Creatinine [Mass/volume] in Serum or Plasma",
                "loinc_name_zh": "肌酸酐",
                "common_name_zh": "Cr",
                "category": "生化檢驗-腎功能",
                "specimen_type": "血清/血漿",
                "unit": "mg/dL",
                "method": "Jaffe法/酵素法",
            },
            {
                "loinc_code": "3094-0",
                "loinc_name_en": "Urea nitrogen [Mass/volume] in Serum or Plasma",
                "loinc_name_zh": "尿素氮",
                "common_name_zh": "BUN",
                "category": "生化檢驗-腎功能",
                "specimen_type": "血清/血漿",
                "unit": "mg/dL",
                "method": "酵素法",
            },
            {
                "loinc_code": "33914-3",
                "loinc_name_en": "Glomerular filtration rate/1.73 sq M.predicted [Volume Rate/Area] in Serum or Plasma by Creatinine-based formula (CKD-EPI)",
                "loinc_name_zh": "腎絲球過濾率",
                "common_name_zh": "eGFR",
                "category": "生化檢驗-腎功能",
                "specimen_type": "血清/血漿",
                "unit": "mL/min/1.73m2",
                "method": "CKD-EPI 公式計算",
            },
            # === 生化檢驗 - 電解質 ===
            {
                "loinc_code": "2951-2",
                "loinc_name_en": "Sodium [Moles/volume] in Serum or Plasma",
                "loinc_name_zh": "鈉離子",
                "common_name_zh": "Na",
                "category": "生化檢驗-電解質",
                "specimen_type": "血清/血漿",
                "unit": "mmol/L",
                "method": "離子選擇電極法",
            },
            {
                "loinc_code": "2823-3",
                "loinc_name_en": "Potassium [Moles/volume] in Serum or Plasma",
                "loinc_name_zh": "鉀離子",
                "common_name_zh": "K",
                "category": "生化檢驗-電解質",
                "specimen_type": "血清/血漿",
                "unit": "mmol/L",
                "method": "離子選擇電極法",
            },
            {
                "loinc_code": "2075-0",
                "loinc_name_en": "Chloride [Moles/volume] in Serum or Plasma",
                "loinc_name_zh": "氯離子",
                "common_name_zh": "Cl",
                "category": "生化檢驗-電解質",
                "specimen_type": "血清/血漿",
                "unit": "mmol/L",
                "method": "離子選擇電極法",
            },
            # === 甲狀腺功能 ===
            {
                "loinc_code": "3016-3",
                "loinc_name_en": "Thyrotropin [Units/volume] in Serum or Plasma",
                "loinc_name_zh": "促甲狀腺激素",
                "common_name_zh": "TSH",
                "category": "內分泌-甲狀腺",
                "specimen_type": "血清/血漿",
                "unit": "uIU/mL",
                "method": "化學冷光免疫分析",
            },
            {
                "loinc_code": "3053-6",
                "loinc_name_en": "Thyroxine (T4) free [Mass/volume] in Serum or Plasma",
                "loinc_name_zh": "游離甲狀腺素",
                "common_name_zh": "Free T4",
                "category": "內分泌-甲狀腺",
                "specimen_type": "血清/血漿",
                "unit": "ng/dL",
                "method": "化學冷光免疫分析",
            },
            # === 凝血功能 ===
            {
                "loinc_code": "5902-2",
                "loinc_name_en": "Prothrombin time (PT)",
                "loinc_name_zh": "凝血酶原時間",
                "common_name_zh": "PT",
                "category": "凝血功能",
                "specimen_type": "檸檬酸鈉血漿",
                "unit": "sec",
                "method": "凝固法",
            },
            {
                "loinc_code": "6301-6",
                "loinc_name_en": "INR in Platelet poor plasma by Coagulation assay",
                "loinc_name_zh": "國際標準化比值",
                "common_name_zh": "INR",
                "category": "凝血功能",
                "specimen_type": "檸檬酸鈉血漿",
                "unit": "ratio",
                "method": "凝固法計算",
            },
            {
                "loinc_code": "3173-2",
                "loinc_name_en": "Activated partial thromboplastin time (aPTT)",
                "loinc_name_zh": "活化部分凝血活酶時間",
                "common_name_zh": "aPTT",
                "category": "凝血功能",
                "specimen_type": "檸檬酸鈉血漿",
                "unit": "sec",
                "method": "凝固法",
            },
            # === 發炎指標 ===
            {
                "loinc_code": "1988-5",
                "loinc_name_en": "C reactive protein [Mass/volume] in Serum or Plasma",
                "loinc_name_zh": "C反應蛋白",
                "common_name_zh": "CRP",
                "category": "發炎指標",
                "specimen_type": "血清/血漿",
                "unit": "mg/dL",
                "method": "免疫比濁法",
            },
        ]

        # 插入檢驗項目
        for test in common_tests:
            cursor.execute(
                """
                INSERT OR IGNORE INTO loinc_mapping
                (loinc_code, loinc_name_en, loinc_name_zh, common_name_zh, category, specimen_type, unit, method)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    test["loinc_code"],
                    test["loinc_name_en"],
                    test["loinc_name_zh"],
                    test["common_name_zh"],
                    test["category"],
                    test["specimen_type"],
                    test["unit"],
                    test["method"],
                ),
            )

        # 插入參考值範圍
        reference_ranges = [
            # 白血球 (成人)
            {
                "loinc_code": "6690-2",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 4.0,
                "range_high": 10.0,
                "unit": "10^3/uL",
                "interpretation": "成人參考值",
            },
            # 紅血球
            {
                "loinc_code": "789-8",
                "age_min": 18,
                "age_max": 120,
                "gender": "M",
                "range_low": 4.5,
                "range_high": 5.9,
                "unit": "10^6/uL",
                "interpretation": "成人男性",
            },
            {
                "loinc_code": "789-8",
                "age_min": 18,
                "age_max": 120,
                "gender": "F",
                "range_low": 4.0,
                "range_high": 5.2,
                "unit": "10^6/uL",
                "interpretation": "成人女性",
            },
            # 血紅素
            {
                "loinc_code": "718-7",
                "age_min": 18,
                "age_max": 120,
                "gender": "M",
                "range_low": 13.5,
                "range_high": 17.5,
                "unit": "g/dL",
                "interpretation": "成人男性",
            },
            {
                "loinc_code": "718-7",
                "age_min": 18,
                "age_max": 120,
                "gender": "F",
                "range_low": 12.0,
                "range_high": 16.0,
                "unit": "g/dL",
                "interpretation": "成人女性",
            },
            # 血球容積比
            {
                "loinc_code": "4544-3",
                "age_min": 18,
                "age_max": 120,
                "gender": "M",
                "range_low": 39,
                "range_high": 52,
                "unit": "%",
                "interpretation": "成人男性",
            },
            {
                "loinc_code": "4544-3",
                "age_min": 18,
                "age_max": 120,
                "gender": "F",
                "range_low": 36,
                "range_high": 46,
                "unit": "%",
                "interpretation": "成人女性",
            },
            # 血小板
            {
                "loinc_code": "777-3",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 150,
                "range_high": 400,
                "unit": "10^3/uL",
                "interpretation": "成人參考值",
            },
            # 空腹血糖
            {
                "loinc_code": "1558-6",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 70,
                "range_high": 100,
                "unit": "mg/dL",
                "interpretation": "正常範圍",
            },
            # 糖化血色素
            {
                "loinc_code": "4548-4",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 4.0,
                "range_high": 5.6,
                "unit": "%",
                "interpretation": "正常範圍",
            },
            # 總膽固醇
            {
                "loinc_code": "2093-3",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 0,
                "range_high": 200,
                "unit": "mg/dL",
                "interpretation": "理想值",
            },
            # 三酸甘油酯
            {
                "loinc_code": "2571-8",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 0,
                "range_high": 150,
                "unit": "mg/dL",
                "interpretation": "正常值",
            },
            # HDL
            {
                "loinc_code": "2085-9",
                "age_min": 18,
                "age_max": 120,
                "gender": "M",
                "range_low": 40,
                "range_high": 999,
                "unit": "mg/dL",
                "interpretation": "成人男性（越高越好）",
            },
            {
                "loinc_code": "2085-9",
                "age_min": 18,
                "age_max": 120,
                "gender": "F",
                "range_low": 50,
                "range_high": 999,
                "unit": "mg/dL",
                "interpretation": "成人女性（越高越好）",
            },
            # LDL
            {
                "loinc_code": "2089-1",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 0,
                "range_high": 130,
                "unit": "mg/dL",
                "interpretation": "理想值",
            },
            # ALT (GPT)
            {
                "loinc_code": "1742-6",
                "age_min": 18,
                "age_max": 120,
                "gender": "M",
                "range_low": 0,
                "range_high": 40,
                "unit": "U/L",
                "interpretation": "成人男性",
            },
            {
                "loinc_code": "1742-6",
                "age_min": 18,
                "age_max": 120,
                "gender": "F",
                "range_low": 0,
                "range_high": 35,
                "unit": "U/L",
                "interpretation": "成人女性",
            },
            # AST (GOT)
            {
                "loinc_code": "1920-8",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 0,
                "range_high": 40,
                "unit": "U/L",
                "interpretation": "成人參考值",
            },
            # 總膽紅素
            {
                "loinc_code": "1975-2",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 0.2,
                "range_high": 1.2,
                "unit": "mg/dL",
                "interpretation": "成人參考值",
            },
            # 肌酸酐
            {
                "loinc_code": "2160-0",
                "age_min": 18,
                "age_max": 120,
                "gender": "M",
                "range_low": 0.7,
                "range_high": 1.3,
                "unit": "mg/dL",
                "interpretation": "成人男性",
            },
            {
                "loinc_code": "2160-0",
                "age_min": 18,
                "age_max": 120,
                "gender": "F",
                "range_low": 0.6,
                "range_high": 1.1,
                "unit": "mg/dL",
                "interpretation": "成人女性",
            },
            # BUN
            {
                "loinc_code": "3094-0",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 7,
                "range_high": 20,
                "unit": "mg/dL",
                "interpretation": "成人參考值",
            },
            # eGFR
            {
                "loinc_code": "33914-3",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 90,
                "range_high": 999,
                "unit": "mL/min/1.73m2",
                "interpretation": "正常腎功能",
            },
            # 鈉
            {
                "loinc_code": "2951-2",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 136,
                "range_high": 145,
                "unit": "mmol/L",
                "interpretation": "成人參考值",
            },
            # 鉀
            {
                "loinc_code": "2823-3",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 3.5,
                "range_high": 5.1,
                "unit": "mmol/L",
                "interpretation": "成人參考值",
            },
            # 氯
            {
                "loinc_code": "2075-0",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 98,
                "range_high": 107,
                "unit": "mmol/L",
                "interpretation": "成人參考值",
            },
            # TSH
            {
                "loinc_code": "3016-3",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 0.27,
                "range_high": 4.2,
                "unit": "uIU/mL",
                "interpretation": "成人參考值",
            },
            # Free T4
            {
                "loinc_code": "3053-6",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 0.93,
                "range_high": 1.7,
                "unit": "ng/dL",
                "interpretation": "成人參考值",
            },
            # PT
            {
                "loinc_code": "5902-2",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 9.5,
                "range_high": 12.5,
                "unit": "sec",
                "interpretation": "成人參考值",
            },
            # INR
            {
                "loinc_code": "6301-6",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 0.8,
                "range_high": 1.2,
                "unit": "ratio",
                "interpretation": "未服用抗凝血劑",
            },
            # aPTT
            {
                "loinc_code": "3173-2",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 25,
                "range_high": 35,
                "unit": "sec",
                "interpretation": "成人參考值",
            },
            # CRP
            {
                "loinc_code": "1988-5",
                "age_min": 18,
                "age_max": 120,
                "gender": "all",
                "range_low": 0,
                "range_high": 0.5,
                "unit": "mg/dL",
                "interpretation": "正常值",
            },
        ]

        for ref in reference_ranges:
            cursor.execute(
                """
                INSERT INTO reference_ranges
                (loinc_code, age_min, age_max, gender, range_low, range_high, unit, interpretation)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    ref["loinc_code"],
                    ref["age_min"],
                    ref["age_max"],
                    ref["gender"],
                    ref["range_low"],
                    ref["range_high"],
                    ref["unit"],
                    ref["interpretation"],
                ),
            )

        log_info(f"Populated {len(common_tests)} Taiwan common lab tests")
        log_info(f"Populated {len(reference_ranges)} reference ranges")

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
    # LOINC 碼對照功能
    # ==========================================

    def search_loinc_code(self, keyword: str, category: Optional[str] = None) -> str:
        """
        搜尋 LOINC 碼（支援中英文檢驗名稱）

        Args:
            keyword: 搜尋關鍵字（檢驗名稱、LOINC 碼、常用縮寫）
            category: 分類篩選（可選）

        Returns:
            JSON 格式的搜尋結果
        """
        term = f"%{keyword}%"
        sql = """
            SELECT loinc_code, loinc_name_en, loinc_name_zh, common_name_zh,
                   category, specimen_type, unit, method
            FROM loinc_mapping
            WHERE (loinc_code LIKE ? OR loinc_name_zh LIKE ? OR
                   loinc_name_en LIKE ? OR common_name_zh LIKE ?)
        """
        params = [term, term, term, term]

        if category:
            sql += " AND category LIKE ?"
            params.append(f"%{category}%")

        sql += " ORDER BY loinc_code LIMIT 20"

        results = self._query_db(sql, tuple(params))

        if not results:
            return json.dumps(
                {
                    "message": f"找不到符合 '{keyword}' 的檢驗項目",
                    "suggestion": "請嘗試使用檢驗的中文名稱、英文名稱或常用縮寫",
                },
                ensure_ascii=False,
            )

        return json.dumps(
            {"keyword": keyword, "total_found": len(results), "results": results},
            ensure_ascii=False,
        )

    def get_loinc_by_code(self, loinc_code: str) -> Dict:
        """取得特定 LOINC 碼的完整資訊"""
        results = self._query_db(
            "SELECT * FROM loinc_mapping WHERE loinc_code = ?", (loinc_code,)
        )
        return results[0] if results else None

    def list_categories(self) -> str:
        """列出所有檢驗分類"""
        results = self._query_db(
            "SELECT DISTINCT category FROM loinc_mapping ORDER BY category"
        )
        categories = [r["category"] for r in results]
        return json.dumps(
            {"total_categories": len(categories), "categories": categories},
            ensure_ascii=False,
        )

    # ==========================================
    # 檢驗參考值查詢功能
    # ==========================================

    def get_reference_range(
        self, loinc_code: str, age: int, gender: Literal["M", "F", "all"] = "all"
    ) -> str:
        """
        查詢檢驗參考值範圍

        Args:
            loinc_code: LOINC 碼
            age: 年齡
            gender: 性別（M=男性, F=女性, all=不分性別）

        Returns:
            參考值範圍資訊
        """
        # 先取得檢驗項目資訊
        test_info = self.get_loinc_by_code(loinc_code)
        if not test_info:
            return json.dumps(
                {"error": f"找不到 LOINC 碼: {loinc_code}"}, ensure_ascii=False
            )

        # 查詢參考值（優先找特定性別，找不到則找 all）
        sql = """
            SELECT * FROM reference_ranges
            WHERE loinc_code = ?
              AND age_min <= ?
              AND age_max >= ?
              AND (gender = ? OR gender = 'all')
            ORDER BY
                CASE gender WHEN ? THEN 1 ELSE 2 END,
                age_min DESC
            LIMIT 1
        """
        ref_range = self._query_db(sql, (loinc_code, age, age, gender, gender))

        if not ref_range:
            return json.dumps(
                {
                    "loinc_code": loinc_code,
                    "test_name_zh": test_info["loinc_name_zh"],
                    "test_name_en": test_info["loinc_name_en"],
                    "message": f"找不到適用於年齡 {age} 歲、性別 {gender} 的參考值",
                    "unit": test_info["unit"],
                },
                ensure_ascii=False,
            )

        ref = ref_range[0]
        return json.dumps(
            {
                "loinc_code": loinc_code,
                "test_name_zh": test_info["loinc_name_zh"],
                "test_name_en": test_info["loinc_name_en"],
                "common_name": test_info["common_name_zh"],
                "reference_range": {
                    "low": ref["range_low"],
                    "high": ref["range_high"],
                    "unit": ref["unit"],
                    "interpretation": ref["interpretation"],
                },
                "applicable_to": {
                    "age_range": f"{ref['age_min']}-{ref['age_max']} 歲",
                    "gender": (
                        "男性"
                        if ref["gender"] == "M"
                        else "女性" if ref["gender"] == "F" else "不分性別"
                    ),
                },
            },
            ensure_ascii=False,
        )

    def interpret_lab_result(
        self,
        loinc_code: str,
        value: float,
        age: int,
        gender: Literal["M", "F", "all"] = "all",
    ) -> str:
        """
        判讀檢驗結果

        Args:
            loinc_code: LOINC 碼
            value: 檢驗值
            age: 年齡
            gender: 性別

        Returns:
            檢驗結果判讀
        """
        # 取得參考值
        ref_data = json.loads(self.get_reference_range(loinc_code, age, gender))

        if "error" in ref_data or "message" in ref_data:
            return json.dumps(ref_data, ensure_ascii=False)

        ref_range = ref_data["reference_range"]
        low = ref_range["low"]
        high = ref_range["high"]

        # 判斷結果
        if value < low:
            status = "偏低 (Low)"
            flag = "L"
            clinical_significance = "低於正常參考值，建議進一步評估"
        elif value > high:
            status = "偏高 (High)"
            flag = "H"
            clinical_significance = "高於正常參考值，建議進一步評估"
        else:
            status = "正常 (Normal)"
            flag = "N"
            clinical_significance = "數值在正常範圍內"

        return json.dumps(
            {
                "loinc_code": loinc_code,
                "test_name_zh": ref_data["test_name_zh"],
                "test_name_en": ref_data["test_name_en"],
                "result": {
                    "value": value,
                    "unit": ref_range["unit"],
                    "status": status,
                    "flag": flag,
                },
                "reference_range": {
                    "low": low,
                    "high": high,
                    "unit": ref_range["unit"],
                },
                "interpretation": clinical_significance,
                "applicable_to": ref_data["applicable_to"],
            },
            ensure_ascii=False,
        )

    def batch_interpret_results(
        self,
        results: List[Dict[str, any]],
        age: int,
        gender: Literal["M", "F", "all"] = "all",
    ) -> str:
        """
        批次判讀多個檢驗結果

        Args:
            results: 檢驗結果列表 [{"loinc_code": "...", "value": 123}, ...]
            age: 年齡
            gender: 性別

        Returns:
            批次判讀結果
        """
        interpretations = []
        abnormal_count = 0

        for result in results:
            loinc_code = result.get("loinc_code")
            value = result.get("value")

            if not loinc_code or value is None:
                continue

            interp = json.loads(
                self.interpret_lab_result(loinc_code, value, age, gender)
            )

            if "error" not in interp and "message" not in interp:
                interpretations.append(interp)
                if interp["result"]["flag"] != "N":
                    abnormal_count += 1

        return json.dumps(
            {
                "total_tests": len(interpretations),
                "abnormal_count": abnormal_count,
                "normal_count": len(interpretations) - abnormal_count,
                "patient_info": {
                    "age": age,
                    "gender": (
                        "男性"
                        if gender == "M"
                        else "女性" if gender == "F" else "不分性別"
                    ),
                },
                "results": interpretations,
            },
            ensure_ascii=False,
        )

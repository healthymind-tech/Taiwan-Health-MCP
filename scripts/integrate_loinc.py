#!/usr/bin/env python3
"""
LOINC 官方資料整合腳本
整合 LOINC 官方資料與台灣自訂資料
"""

import argparse
from pathlib import Path
import sqlite3
import sys

import pandas as pd

from utils import log_error


class LOINCIntegrator:
    """LOINC 資料整合器"""

    def __init__(self, project_root):
        self.project_root = Path(project_root)
        self.data_dir = self.project_root / "data"
        self.loinc_official_dir = self.data_dir / "loinc_official"

        # 輸出資料庫
        self.output_db = self.data_dir / "lab_tests.db"

    def check_loinc_file(self):
        """檢查 LOINC 官方檔案是否存在"""
        loinc_file = self.loinc_official_dir / "Loinc.csv"

        if not loinc_file.exists():
            print("\n❌ 找不到 LOINC 官方資料檔案！")
            print(f"   預期位置: {loinc_file}")
            print("\n請依照以下步驟下載:")
            print("1. 前往 https://loinc.org/downloads/")
            print("2. 下載 LOINC Table File (Loinc.csv)")
            print(f"3. 放置到: {self.loinc_official_dir}/")
            print("\n詳細說明請參考: LOINC_INTEGRATION_GUIDE.md")
            return False

        return True

    def load_loinc_official(self):
        """載入 LOINC 官方資料"""
        loinc_file = self.loinc_official_dir / "Loinc.csv"

        print(f"\n📥 載入 LOINC 官方資料: {loinc_file}")

        try:
            # 只載入需要的欄位（減少記憶體使用）
            columns = [
                "LOINC_NUM",  # LOINC 碼
                "COMPONENT",  # 檢驗成分
                "PROPERTY",  # 性質
                "TIME_ASPCT",  # 時間面向
                "SYSTEM",  # 檢體系統
                "SCALE_TYP",  # 量表類型
                "METHOD_TYP",  # 方法
                "CLASS",  # 分類
                "ShortName",  # 簡稱
                "LONG_COMMON_NAME",  # 完整名稱
                "COMMON_TEST_RANK",  # 常用度排名
                "EXAMPLE_UNITS",  # 範例單位
            ]

            df = pd.read_csv(loinc_file, usecols=columns, dtype=str, low_memory=False)

            print(f"✅ 載入成功: {len(df):,} 項")
            return df

        except Exception as e:
            log_error(f"載入 LOINC 官方資料失敗: {e}")
            return None

    def load_taiwan_mapping(self):
        """載入台灣中文對照表"""
        mapping_file = self.loinc_official_dir / "loinc_taiwan_mapping.csv"

        if not mapping_file.exists():
            print(f"\n⚠️  找不到中文對照表: {mapping_file}")
            print("   將使用台灣自訂資料中的中文名稱")
            return pd.DataFrame(columns=["loinc_code", "name_zh", "common_name_zh"])

        print(f"\n📥 載入台灣中文對照表: {mapping_file}")
        df = pd.read_csv(mapping_file)
        print(f"✅ 載入成功: {len(df)} 項")
        return df

    def load_taiwan_reference_ranges(self):
        """載入台灣參考值資料"""
        ref_file = self.data_dir / "lab_reference_ranges.csv"

        if not ref_file.exists():
            print(f"\n⚠️  找不到台灣參考值資料: {ref_file}")
            return pd.DataFrame()

        print(f"\n📥 載入台灣參考值資料: {ref_file}")
        df = pd.read_csv(ref_file)
        print(f"✅ 載入成功: {len(df)} 筆參考值")
        return df

    def merge_data(self, loinc_df, mapping_df, ref_df):
        """合併資料"""
        print("\n🔄 合併資料...")

        # 1. 從參考值資料中提取 LOINC 項目
        taiwan_loinc_codes = set()
        if not ref_df.empty:
            taiwan_loinc_codes = set(ref_df["loinc_code"].unique())

        # 2. 從對照表中提取
        if not mapping_df.empty:
            taiwan_loinc_codes.update(mapping_df["loinc_code"].unique())

        print(f"   台灣資料涵蓋 LOINC 碼: {len(taiwan_loinc_codes)} 項")

        # 3. 標記台灣常用項目
        loinc_df["is_taiwan_common"] = loinc_df["LOINC_NUM"].isin(taiwan_loinc_codes)

        # 4. 加入中文名稱
        if not mapping_df.empty:
            loinc_df = loinc_df.merge(
                mapping_df[["loinc_code", "name_zh", "common_name_zh"]],
                left_on="LOINC_NUM",
                right_on="loinc_code",
                how="left",
            )
        else:
            loinc_df["name_zh"] = None
            loinc_df["common_name_zh"] = None

        # 5. 如果對照表沒有，從參考值資料補充
        if not ref_df.empty:
            for _, row in (
                ref_df[["loinc_code", "test_name_zh"]].drop_duplicates().iterrows()
            ):
                mask = (loinc_df["LOINC_NUM"] == row["loinc_code"]) & (
                    loinc_df["name_zh"].isna()
                )
                loinc_df.loc[mask, "name_zh"] = row["test_name_zh"]

        print(f"   有中文名稱: {loinc_df['name_zh'].notna().sum()} 項")

        return loinc_df

    def create_database(self, merged_df, ref_df):
        """建立整合後的資料庫"""
        print(f"\n🗄️  建立資料庫: {self.output_db}")

        # 刪除舊資料庫
        if self.output_db.exists():
            self.output_db.unlink()
            print("   已刪除舊資料庫")

        conn = sqlite3.connect(self.output_db)
        cursor = conn.cursor()

        try:
            # 1. 建立 LOINC 對照表
            print("   建立 loinc_mapping 表...")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS loinc_mapping (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    loinc_code TEXT NOT NULL UNIQUE,
                    loinc_name_en TEXT NOT NULL,
                    loinc_name_zh TEXT,
                    common_name_zh TEXT,
                    category TEXT,
                    specimen_type TEXT,
                    unit TEXT,
                    method TEXT,
                    is_taiwan_common INTEGER DEFAULT 0,
                    common_test_rank INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """
            )

            # 2. 插入 LOINC 資料
            print("   插入 LOINC 資料...")
            insert_count = 0

            for _, row in merged_df.iterrows():
                # 決定分類
                category = self._map_class_to_category(row.get("CLASS", ""))

                # 決定檢體類型
                specimen = row.get("SYSTEM", "")

                # 決定單位
                unit = row.get("EXAMPLE_UNITS", "")

                # 決定方法
                method = row.get("METHOD_TYP", "")

                cursor.execute(
                    """
                    INSERT OR IGNORE INTO loinc_mapping
                    (loinc_code, loinc_name_en, loinc_name_zh, common_name_zh,
                     category, specimen_type, unit, method, is_taiwan_common, common_test_rank)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                    (
                        row["LOINC_NUM"],
                        row.get("LONG_COMMON_NAME", ""),
                        row.get("name_zh"),
                        row.get("common_name_zh"),
                        category,
                        specimen,
                        unit,
                        method,
                        1 if row.get("is_taiwan_common") else 0,
                        (
                            int(row["COMMON_TEST_RANK"])
                            if pd.notna(row.get("COMMON_TEST_RANK"))
                            else None
                        ),
                    ),
                )
                insert_count += 1

                if insert_count % 10000 == 0:
                    print(f"   已插入 {insert_count:,} 項...")

            print(f"✅ 插入完成: {insert_count:,} 項")

            # 3. 建立參考值表
            print("   建立 reference_ranges 表...")
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

            # 4. 插入參考值
            if not ref_df.empty:
                print(f"   插入參考值: {len(ref_df)} 筆...")
                for _, row in ref_df.iterrows():
                    cursor.execute(
                        """
                        INSERT INTO reference_ranges
                        (loinc_code, age_min, age_max, gender, range_low, range_high, unit, interpretation)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                        (
                            row["loinc_code"],
                            row["age_min"],
                            row["age_max"],
                            row["gender"],
                            row["range_low"],
                            row["range_high"],
                            row["unit"],
                            row.get("interpretation", ""),
                        ),
                    )
                print(f"✅ 參考值插入完成")

            # 5. 建立索引
            print("   建立索引...")
            indices = [
                "CREATE INDEX IF NOT EXISTS idx_loinc_code ON loinc_mapping(loinc_code)",
                "CREATE INDEX IF NOT EXISTS idx_loinc_name_zh ON loinc_mapping(loinc_name_zh)",
                "CREATE INDEX IF NOT EXISTS idx_category ON loinc_mapping(category)",
                "CREATE INDEX IF NOT EXISTS idx_taiwan_common ON loinc_mapping(is_taiwan_common)",
                "CREATE INDEX IF NOT EXISTS idx_ref_loinc ON reference_ranges(loinc_code)",
            ]
            for sql in indices:
                cursor.execute(sql)

            print("✅ 索引建立完成")

            conn.commit()

        except Exception as e:
            log_error(f"建立資料庫失敗: {e}")
            conn.rollback()
            raise
        finally:
            conn.close()

    def _map_class_to_category(self, loinc_class):
        """將 LOINC CLASS 對應到台灣分類"""
        mapping = {
            "CHEM": "生化檢驗",
            "HEM/BC": "血液常規",
            "COAG": "凝血功能",
            "SERO": "血清學",
            "MICRO": "微生物學",
            "DRUG/TOX": "藥物/毒物",
            "H&P.HX.LAB": "病史與理學檢查",
        }
        return mapping.get(loinc_class, "其他檢驗")

    def print_summary(self):
        """印出整合摘要"""
        conn = sqlite3.connect(self.output_db)
        cursor = conn.cursor()

        print("\n" + "=" * 60)
        print("  整合結果摘要")
        print("=" * 60)

        # 總項目數
        cursor.execute("SELECT COUNT(*) FROM loinc_mapping")
        total = cursor.fetchone()[0]
        print(f"\n✅ 總 LOINC 項目數: {total:,}")

        # 台灣常用項目
        cursor.execute("SELECT COUNT(*) FROM loinc_mapping WHERE is_taiwan_common = 1")
        taiwan = cursor.fetchone()[0]
        print(f"✅ 台灣常用項目: {taiwan:,}")

        # 有中文名稱
        cursor.execute(
            "SELECT COUNT(*) FROM loinc_mapping WHERE loinc_name_zh IS NOT NULL"
        )
        chinese = cursor.fetchone()[0]
        print(f"✅ 有中文名稱: {chinese:,}")

        # 有參考值
        cursor.execute("SELECT COUNT(DISTINCT loinc_code) FROM reference_ranges")
        with_ref = cursor.fetchone()[0]
        print(f"✅ 有參考值: {with_ref:,}")

        # 分類統計
        print("\n📊 分類統計:")
        cursor.execute(
            """
            SELECT category, COUNT(*) as cnt
            FROM loinc_mapping
            WHERE is_taiwan_common = 1
            GROUP BY category
            ORDER BY cnt DESC
        """
        )
        for row in cursor.fetchall():
            print(f"   {row[0]}: {row[1]} 項")

        conn.close()

        print("\n" + "=" * 60)
        print(f"✅ 資料庫已建立: {self.output_db}")
        print("=" * 60 + "\n")


def main():
    parser = argparse.ArgumentParser(description="整合 LOINC 官方資料")
    parser.add_argument("--project-root", default=".", help="專案根目錄")
    parser.add_argument("--skip-check", action="store_true", help="跳過檔案檢查")

    args = parser.parse_args()

    print("\n" + "=" * 60)
    print("  LOINC 官方資料整合工具")
    print("=" * 60)

    integrator = LOINCIntegrator(args.project_root)

    # 1. 檢查 LOINC 檔案
    if not args.skip_check:
        if not integrator.check_loinc_file():
            print("\n❌ 整合中止")
            return 1

    # 2. 載入資料
    loinc_df = integrator.load_loinc_official()
    if loinc_df is None:
        return 1

    mapping_df = integrator.load_taiwan_mapping()
    ref_df = integrator.load_taiwan_reference_ranges()

    # 3. 合併資料
    merged_df = integrator.merge_data(loinc_df, mapping_df, ref_df)

    # 4. 建立資料庫
    integrator.create_database(merged_df, ref_df)

    # 5. 印出摘要
    integrator.print_summary()

    print("✅ 整合完成！")
    print("\n下一步:")
    print("  1. 執行測試: python test_lab_and_guideline.py")
    print(
        "  2. 搜尋檢驗: python -c \"from lab_service import LabService; s=LabService('data'); print(s.search_loinc_code('glucose'))\""
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())

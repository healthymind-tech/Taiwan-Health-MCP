from datetime import datetime, timedelta
import io
import json
import os
import sqlite3
import threading
import zipfile

from apscheduler.schedulers.background import BackgroundScheduler
import requests

from utils import log_error, log_info


class FoodNutritionService:
    """
    食品營養與原料管理服務
    負責管理一般食品的營養成分資料和合法食品原料資訊
    """

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.db_path = os.path.join(data_dir, "food_nutrition.db")
        self.meta_path = os.path.join(data_dir, "food_nutrition_meta.json")

        # Define API Sources for Food Nutrition Data
        # 20: Food Nutrition Dataset (食品營養成分資料集)
        # 4: Food Ingredients Platform Dataset (食品原料整合查詢平臺資料集)
        self.API_SOURCES = {
            "nutrition": "https://data.fda.gov.tw/data/opendata/export/20/json",
            "ingredients": "https://data.fda.gov.tw/data/opendata/export/4/json",
        }

        # Initialize the scheduler
        self.scheduler = BackgroundScheduler()
        # Schedule the update to run every Monday at 00:00
        self.scheduler.add_job(
            self._update_all_data, "cron", day_of_week="mon", hour=0, minute=0
        )
        self.scheduler.start()

        # Check if we need to run an initial update on startup
        self._check_startup_update()

    def _get_last_monday(self):
        """Calculates the date of the most recent Monday."""
        now = datetime.now()
        today_weekday = now.weekday()
        days_diff = today_weekday % 7
        if days_diff == 0 and now.hour == 0 and now.minute == 0:
            return now
        last_monday = now - timedelta(days=days_diff)
        return last_monday.replace(hour=0, minute=0, second=0, microsecond=0)

    def _check_startup_update(self):
        """Checks on startup if the database is missing or outdated."""
        should_update = False
        if not os.path.exists(self.db_path):
            log_info("Food Nutrition DB not found. Initializing full download...")
            should_update = True
        else:
            try:
                if os.path.exists(self.meta_path):
                    with open(self.meta_path, "r") as f:
                        meta = json.load(f)
                        last_updated = datetime.fromisoformat(meta.get("last_updated"))
                        if last_updated < self._get_last_monday():
                            log_info(
                                "Food Nutrition DB is outdated. Scheduling update..."
                            )
                            should_update = True
                else:
                    should_update = True
            except Exception as e:
                log_error(f"Error checking food nutrition DB update status: {e}")
                should_update = True

        if should_update:
            # Run in a separate thread to avoid blocking server startup
            t = threading.Thread(target=self._update_all_data)
            t.start()

    def _download_and_insert(self, url, table_name, conn, columns_map):
        """
        Generic helper to download JSON (or ZIP containing JSON) and insert into SQLite.
        """
        log_info(f"Downloading {table_name} data from {url}...")
        try:
            response = requests.get(url, stream=True, timeout=60)
            if response.status_code != 200:
                log_error(
                    f"Failed to download {table_name}: HTTP {response.status_code}"
                )
                return

            # Check if response is a ZIP file
            content_type = response.headers.get("Content-Type", "")
            if "zip" in content_type or url.endswith(".zip"):
                log_info(f"Detected ZIP file for {table_name}, extracting...")
                zip_file = zipfile.ZipFile(io.BytesIO(response.content))
                json_files = [f for f in zip_file.namelist() if f.endswith(".json")]
                if not json_files:
                    log_error(f"No JSON file found in ZIP for {table_name}")
                    return
                with zip_file.open(json_files[0]) as json_file:
                    data = json.load(json_file)
            else:
                data = response.json()

            cursor = conn.cursor()

            # Create Table
            cols = list(columns_map.keys())
            col_defs = [f"{c} TEXT" for c in cols]
            cursor.execute(f"DROP TABLE IF EXISTS {table_name}")
            cursor.execute(f"CREATE TABLE {table_name} ({', '.join(col_defs)})")

            # Prepare Insert Statement
            placeholders = ", ".join(["?" for _ in cols])
            insert_sql = (
                f"INSERT INTO {table_name} ({', '.join(cols)}) VALUES ({placeholders})"
            )

            # Process Data
            rows_to_insert = []
            for item in data:
                row = [
                    (
                        str(item.get(json_key, ""))
                        if item.get(json_key) is not None
                        else ""
                    )
                    for db_col, json_key in columns_map.items()
                ]
                rows_to_insert.append(tuple(row))

            # Bulk Insert
            cursor.executemany(insert_sql, rows_to_insert)
            conn.commit()

            log_info(f"Updated {table_name}: {len(rows_to_insert)} rows.")

        except Exception as e:
            log_error(f"Failed to update {table_name}: {e}")

    def _update_all_data(self):
        """Main ETL process to update food nutrition datasets."""
        log_info("Starting Food Nutrition Database Update...")
        conn = sqlite3.connect(self.db_path)

        try:
            # 1. Food Nutrition Dataset (ID 20)
            self._download_and_insert(
                self.API_SOURCES["nutrition"],
                "nutrition",
                conn,
                {
                    "food_category": "食品分類",
                    "data_type": "資料類別",
                    "integration_number": "整合編號",
                    "sample_name": "樣品名稱",
                    "common_name": "俗名",
                    "english_name": "樣品英文名稱",
                    "content_description": "內容物描述",
                    "waste_rate": "廢棄率",
                    "nutrient_category": "分析項分類",
                    "nutrient_item": "分析項",
                    "content_unit": "含量單位",
                    "content_per_100g": "每100克含量",
                    "sample_count": "樣本數",
                    "std_deviation": "標準差",
                    "content_per_unit": "每單位含量",
                    "unit_weight": "每單位重",
                    "unit_weight_content": "每單位重含量",
                },
            )

            # 2. Food Ingredients Platform Dataset (ID 4)
            self._download_and_insert(
                self.API_SOURCES["ingredients"],
                "food_ingredients",
                conn,
                {
                    "regulation_note": "法條版面說明",
                    "major_category": "大分類",
                    "sub_category": "次分類",
                    "name_zh": "中文名稱",
                    "name_en": "英文名稱",
                    "scientific_name": "英文學名",
                    "part": "部位",
                    "note": "備註",
                },
            )

            # Create useful indexes
            cursor = conn.cursor()
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_nutrition_name ON nutrition(sample_name)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_nutrition_category ON nutrition(food_category)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_ingredients_name ON food_ingredients(name_zh)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_ingredients_category ON food_ingredients(major_category)"
            )
            conn.commit()

            # Update Metadata
            with open(self.meta_path, "w") as f:
                json.dump({"last_updated": datetime.now().isoformat()}, f)

            log_info("Food nutrition datasets updated successfully.")

        except Exception as e:
            log_error(f"Food nutrition update failed: {e}")
        finally:
            conn.close()

    # --- Query Features for Food Nutrition ---

    def search_nutrition(self, food_name: str, nutrient: str = None):
        """
        Search for nutritional information of foods.
        """
        if not os.path.exists(self.db_path):
            return "資料庫初始化中，請稍候..."

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        query = f"%{food_name}%"

        if nutrient:
            nutrient_query = f"%{nutrient}%"
            sql = """
                SELECT sample_name, common_name, nutrient_item, content_per_100g, content_unit, food_category
                FROM nutrition
                WHERE (sample_name LIKE ? OR common_name LIKE ? OR english_name LIKE ?)
                AND nutrient_item LIKE ?
                LIMIT 20
            """
            cursor.execute(sql, (query, query, query, nutrient_query))
        else:
            sql = """
                SELECT sample_name, common_name, nutrient_item, content_per_100g, content_unit, food_category
                FROM nutrition
                WHERE sample_name LIKE ? OR common_name LIKE ? OR english_name LIKE ?
                LIMIT 30
            """
            cursor.execute(sql, (query, query, query))

        rows = cursor.fetchall()
        conn.close()

        if not rows:
            return f"找不到 '{food_name}' 的營養資料。"

        # Group by food name
        foods_data = {}
        for r in rows:
            food_key = f"{r[0]} ({r[1]})" if r[1] else r[0]
            if food_key not in foods_data:
                foods_data[food_key] = {"category": r[5], "nutrients": []}
            foods_data[food_key]["nutrients"].append(f"  {r[2]}: {r[3]} {r[4]}")

        results = []
        for food_name, data in foods_data.items():
            nutrients_str = "\n".join(data["nutrients"][:10])
            results.append(
                f"【{food_name}】\n" f"分類: {data['category']}\n" f"{nutrients_str}"
            )

        return "\n\n".join(results[:5])

    def get_detailed_nutrition(self, food_name: str):
        """
        Get comprehensive nutritional breakdown for a specific food.
        """
        if not os.path.exists(self.db_path):
            return "資料庫初始化中，請稍候..."

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        query = f"%{food_name}%"
        sql = """
            SELECT DISTINCT sample_name, common_name, english_name, food_category,
                   content_description, waste_rate, integration_number
            FROM nutrition
            WHERE sample_name LIKE ? OR common_name LIKE ?
            LIMIT 1
        """
        cursor.execute(sql, (query, query))
        food_info = cursor.fetchone()

        if not food_info:
            conn.close()
            return f"找不到 '{food_name}' 的詳細資料。"

        # Get all nutrients for this food
        sql_nutrients = """
            SELECT nutrient_category, nutrient_item, content_per_100g, content_unit,
                   sample_count, std_deviation
            FROM nutrition
            WHERE sample_name = ?
            ORDER BY nutrient_category, nutrient_item
        """
        cursor.execute(sql_nutrients, (food_info[0],))
        nutrients = cursor.fetchall()
        conn.close()

        # Group nutrients by category
        nutrient_groups = {}
        for n in nutrients:
            category = n[0]
            if category not in nutrient_groups:
                nutrient_groups[category] = []
            nutrient_groups[category].append(f"  {n[1]}: {n[2]} {n[3]}")

        nutrients_output = []
        for cat, items in nutrient_groups.items():
            nutrients_output.append(f"\n【{cat}】")
            nutrients_output.extend(items)

        output = f"""
=== 食品營養成分詳情 ===
樣品名稱: {food_info[0]}
俗名: {food_info[1] if food_info[1] else '無'}
英文名稱: {food_info[2] if food_info[2] else '無'}
食品分類: {food_info[3]}
內容物描述: {food_info[4] if food_info[4] else '無'}
廢棄率: {food_info[5]}%

【營養成分 (每100克)】
{''.join(nutrients_output)}
"""
        return output

    # --- Query Features for Food Ingredients ---

    def search_food_ingredient(self, keyword: str):
        """
        Search for food ingredients/materials in the regulatory database.
        """
        if not os.path.exists(self.db_path):
            return "資料庫初始化中，請稍候..."

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        query = f"%{keyword}%"
        sql = """
            SELECT name_zh, name_en, scientific_name, major_category, sub_category, part, note
            FROM food_ingredients
            WHERE name_zh LIKE ? OR name_en LIKE ? OR scientific_name LIKE ?
            LIMIT 15
        """
        cursor.execute(sql, (query, query, query))
        rows = cursor.fetchall()
        conn.close()

        if not rows:
            return f"找不到 '{keyword}' 相關的食品原料資料。"

        results = []
        for r in rows:
            results.append(
                f"【{r[0]}】\n"
                f"   英文名稱: {r[1] if r[1] else '無'}\n"
                f"   學名: {r[2] if r[2] else '無'}\n"
                f"   分類: {r[3]} > {r[4]}\n"
                f"   使用部位: {r[5] if r[5] else '無'}\n"
                f"   備註: {r[6][:100] if r[6] else '無'}"
            )

        return "\n\n".join(results)

    def get_ingredients_by_category(self, category: str):
        """
        Get all approved ingredients in a specific category.
        """
        if not os.path.exists(self.db_path):
            return "資料庫初始化中，請稍候..."

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        query = f"%{category}%"
        sql = """
            SELECT name_zh, name_en, sub_category, part, regulation_note
            FROM food_ingredients
            WHERE major_category LIKE ? OR sub_category LIKE ?
            LIMIT 20
        """
        cursor.execute(sql, (query, query))
        rows = cursor.fetchall()
        conn.close()

        if not rows:
            return f"找不到 '{category}' 分類的食品原料。"

        results = []
        for r in rows:
            results.append(
                f"• {r[0]} ({r[1] if r[1] else ''})\n"
                f"  次分類: {r[2]}, 部位: {r[3] if r[3] else '全部'}"
            )

        return f"=== {category} 分類食品原料 ===\n\n" + "\n".join(results)

    def analyze_diet_plan(self, foods: list):
        """
        Analyze nutritional composition of a meal/diet plan.
        """
        if not os.path.exists(self.db_path):
            return "資料庫初始化中，請稍候..."

        results = []
        for food in foods:
            nutrition_data = self.get_detailed_nutrition(food)
            results.append(nutrition_data)

        return "\n\n" + "=" * 50 + "\n\n".join(results)

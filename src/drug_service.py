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


class DrugService:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.db_path = os.path.join(data_dir, "drugs.db")
        self.meta_path = os.path.join(data_dir, "drug_meta.json")

        # Define API Sources based on TFDA Open Data IDs
        # 36: Master License Data (Core) - Contains Name, Indication, Usage
        # 42: Appearance (Shape, Color)
        # 43: Ingredients (Composition)
        # 41: ATC Codes (Classification)
        # 39: Documents (Package Inserts/Box Images)
        self.API_SOURCES = {
            "master": "https://data.fda.gov.tw/data/opendata/export/36/json",
            "appearance": "https://data.fda.gov.tw/data/opendata/export/42/json",
            "ingredients": "https://data.fda.gov.tw/data/opendata/export/43/json",
            "atc": "https://data.fda.gov.tw/data/opendata/export/41/json",
            "documents": "https://data.fda.gov.tw/data/opendata/export/39/json",
        }

        # Initialize the scheduler
        self.scheduler = BackgroundScheduler()
        # Schedule the update to run every Tuesday at 00:00
        self.scheduler.add_job(
            self._update_all_data, "cron", day_of_week="tue", hour=0, minute=0
        )
        self.scheduler.start()

        # Check if we need to run an initial update on startup
        self._check_startup_update()

    def _get_last_tuesday(self):
        """Calculates the date of the most recent Tuesday."""
        now = datetime.now()
        today_weekday = now.weekday()
        days_diff = (today_weekday - 1) % 7
        if days_diff == 0 and now.hour == 0 and now.minute == 0:
            return now
        last_tuesday = now - timedelta(days=days_diff)
        return last_tuesday.replace(hour=0, minute=0, second=0, microsecond=0)

    def _check_startup_update(self):
        """Checks on startup if the database is missing or outdated."""
        should_update = False
        if not os.path.exists(self.db_path):
            log_info("Drug DB not found. Initializing full download...")
            should_update = True
        else:
            try:
                if os.path.exists(self.meta_path):
                    with open(self.meta_path, "r") as f:
                        meta = json.load(f)
                        last_updated = datetime.fromisoformat(meta.get("last_updated"))
                        if last_updated < self._get_last_tuesday():
                            log_info("Drug DB is outdated. Scheduling update...")
                            should_update = True
                else:
                    should_update = True
            except Exception as e:
                log_error(f"Error checking drug DB update status: {e}")
                should_update = True

        if should_update:
            # Run in a separate thread to avoid blocking server startup
            t = threading.Thread(target=self._update_all_data)
            t.start()

    def _download_and_insert(self, url, table_name, conn, columns_map, pk_col=None):
        """
        Generic helper to download JSON (or ZIP containing JSON) and insert into SQLite.

        Args:
            url: API endpoint
            table_name: SQLite table name
            conn: SQLite connection object
            columns_map: Dict mapping { "DB_COLUMN": "JSON_KEY" }
            pk_col: (Optional) Primary key column name for creating table
        """
        log_info(f"Downloading {table_name} data from {url}...")
        try:
            response = requests.get(url, stream=True, timeout=30)
            if response.status_code != 200:
                log_error(
                    f"Failed to download {table_name}: HTTP {response.status_code}"
                )
                return

            # Check if response is a ZIP file
            content_type = response.headers.get("Content-Type", "")
            if "zip" in content_type or url.endswith(".zip"):
                # Handle ZIP file
                log_info(f"Detected ZIP file for {table_name}, extracting...")
                zip_file = zipfile.ZipFile(io.BytesIO(response.content))

                # Find the JSON file inside (usually only one file)
                json_files = [f for f in zip_file.namelist() if f.endswith(".json")]
                if not json_files:
                    log_error(f"No JSON file found in ZIP for {table_name}")
                    return

                # Read the first JSON file
                with zip_file.open(json_files[0]) as json_file:
                    data = json.load(json_file)
            else:
                # Direct JSON response
                data = response.json()
            cursor = conn.cursor()

            # 1. Create Table Dynamically
            cols = list(columns_map.keys())
            col_defs = []
            for c in cols:
                # Basic text type for everything for simplicity in SQLite
                col_defs.append(f"{c} TEXT")

            cursor.execute(f"DROP TABLE IF EXISTS {table_name}")
            cursor.execute(f"CREATE TABLE {table_name} ({', '.join(col_defs)})")

            # 2. Prepare Insert Statement
            placeholders = ", ".join(["?" for _ in cols])
            insert_sql = (
                f"INSERT INTO {table_name} ({', '.join(cols)}) VALUES ({placeholders})"
            )

            # 3. Process Data
            rows_to_insert = []
            for item in data:
                row = []
                for db_col, json_key in columns_map.items():
                    val = item.get(json_key, "")
                    # Convert list/dict to string if necessary, otherwise stringify
                    row.append(str(val) if val is not None else "")
                rows_to_insert.append(tuple(row))

            # Bulk Insert
            cursor.executemany(insert_sql, rows_to_insert)
            conn.commit()

            # Create Index on License ID (Common linking key)
            if "license_id" in cols:
                cursor.execute(
                    f"CREATE INDEX IF NOT EXISTS idx_{table_name}_lid ON {table_name}(license_id)"
                )

            log_info(f"Updated {table_name}: {len(rows_to_insert)} rows.")

        except Exception as e:
            log_error(f"Failed to update {table_name}: {e}")

    def _update_all_data(self):
        """Main ETL process to update all 5 datasets."""
        log_info("Starting Full Drug Database Update...")
        conn = sqlite3.connect(self.db_path)

        try:
            # 1. Master Licenses (ID 36) - The Backbone
            self._download_and_insert(
                self.API_SOURCES["master"],
                "licenses",
                conn,
                {
                    "license_id": "許可證字號",
                    "name_zh": "中文品名",
                    "name_en": "英文品名",
                    "indication": "適應症",
                    "form": "劑型",
                    "package": "包裝",
                    "category": "藥品類別",  # e.g., 須由醫師處方使用
                    "manufacturer": "申請商名稱",
                    "valid_date": "有效日期",
                    "usage": "用法用量",
                },
            )

            # 2. Appearance (ID 42)
            self._download_and_insert(
                self.API_SOURCES["appearance"],
                "appearance",
                conn,
                {
                    "license_id": "許可證字號",
                    "shape": "形狀",
                    "color": "顏色",
                    "marking": "刻痕",
                    "image_url": "外觀圖檔連結",
                },
            )

            # 3. Ingredients (ID 43)
            self._download_and_insert(
                self.API_SOURCES["ingredients"],
                "ingredients",
                conn,
                {
                    "license_id": "許可證字號",
                    "ingredient_name": "成分名稱",
                    "content": "含量",
                    "unit": "含量單位",
                },
            )

            # 4. ATC Codes (ID 41)
            self._download_and_insert(
                self.API_SOURCES["atc"],
                "atc",
                conn,
                {
                    "license_id": "許可證字號",
                    "atc_code": "代碼",
                    "atc_name_zh": "中文分類名稱",
                    "atc_name_en": "英文分類名稱",
                },
            )

            # 5. Documents/Inserts (ID 39)
            self._download_and_insert(
                self.API_SOURCES["documents"],
                "documents",
                conn,
                {
                    "license_id": "許可證字號",
                    "insert_url": "仿單圖檔連結",
                    "box_url": "外盒圖檔連結",
                },
            )

            # Update Metadata
            with open(self.meta_path, "w") as f:
                json.dump({"last_updated": datetime.now().isoformat()}, f)

            log_info("All drug datasets updated successfully.")

        except Exception as e:
            log_error(f"Global update failed: {e}")
        finally:
            conn.close()

    # --- Query Features ---

    def search_drug(self, keyword: str):
        """
        Search for drugs by name (ZH/EN) or indication.
        Returns JSON with search results.
        """
        if not os.path.exists(self.db_path):
            return json.dumps({"error": "DB initializing..."})
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        query = f"%{keyword}%"
        # Search specifically in the Master License table
        sql = """
            SELECT name_zh, name_en, indication, license_id, category
            FROM licenses
            WHERE name_zh LIKE ? OR name_en LIKE ? OR indication LIKE ?
            LIMIT 8
        """
        cursor.execute(sql, (query, query, query))
        rows = cursor.fetchall()
        conn.close()

        if not rows:
            return json.dumps({"error": f"No results found for '{keyword}'.", "results": []})

        results = []
        for r in rows:
            results.append({
                "license_id": r[3],
                "name_zh": r[0],
                "name_en": r[1],
                "indication": r[2],
                "category": r[4]
            })

        return json.dumps({"results": results}, ensure_ascii=False)

    def get_details(self, license_id: str):
        """
        Get comprehensive details by joining all tables.
        """
        if not os.path.exists(self.db_path):
            return "DB initializing..."
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # 1. Get Master Data
        cursor.execute("SELECT * FROM licenses WHERE license_id = ?", (license_id,))
        lic = cursor.fetchone()
        if not lic:
            conn.close()
            return "License ID not found."

        # 2. Get Ingredients
        cursor.execute(
            "SELECT ingredient_name, content, unit FROM ingredients WHERE license_id = ?",
            (license_id,),
        )
        ingredients = cursor.fetchall()

        # 3. Get Appearance
        cursor.execute(
            "SELECT shape, color, marking, image_url FROM appearance WHERE license_id = ?",
            (license_id,),
        )
        app = cursor.fetchone()

        # 4. Get Documents
        cursor.execute(
            "SELECT insert_url FROM documents WHERE license_id = ?", (license_id,)
        )
        doc = cursor.fetchone()

        conn.close()

        # Format Output
        ing_list = ", ".join(
            [f"{i['ingredient_name']} {i['content']}{i['unit']}" for i in ingredients]
        )

        output = f"""
=== 藥品詳情 (License: {license_id}) ===
名稱 (中): {lic['name_zh']}
名稱 (英): {lic['name_en']}
適應症: {lic['indication']}
用法用量: {lic['usage']}
劑型: {lic['form']} / {lic['package']}
廠商: {lic['manufacturer']}

[成分組成]
{ing_list}

[外觀特徵]
{f"形狀: {app['shape']}, 顏色: {app['color']}, 刻痕: {app['marking']}" if app else "無外觀資料"}
圖片連結: {app['image_url'] if app and app['image_url'] else "無"}

[相關文件]
仿單連結: {doc['insert_url'] if doc and doc['insert_url'] else "無"}
"""
        return output

    def get_drug_details_by_license(self, license_id: str) -> str:
        """
        Get comprehensive drug details as JSON by license ID.
        Used by FHIR Medication Service.
        """
        if not os.path.exists(self.db_path):
            return json.dumps({"error": "DB initializing..."})
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        try:
            # 1. Get Master Data
            cursor.execute("SELECT * FROM licenses WHERE license_id = ?", (license_id,))
            lic = cursor.fetchone()
            if not lic:
                return json.dumps({"error": f"License ID not found: {license_id}"})

            # 2. Get Ingredients
            cursor.execute(
                "SELECT ingredient_name, content, unit FROM ingredients WHERE license_id = ?",
                (license_id,),
            )
            ingredients_rows = cursor.fetchall()
            ingredients = []
            for ing in ingredients_rows:
                ingredients.append({
                    "ingredient_name": ing["ingredient_name"],
                    "content": ing["content"],
                    "unit": ing["unit"]
                })

            # 3. Get Appearance
            cursor.execute(
                "SELECT shape, color, marking, image_url FROM appearance WHERE license_id = ?",
                (license_id,),
            )
            app = cursor.fetchone()
            appearance = {}
            if app:
                appearance = {
                    "shape": app["shape"],
                    "color": app["color"],
                    "marking": app["marking"],
                    "image_url": app["image_url"]
                }

            # 4. Get ATC Codes
            cursor.execute(
                "SELECT atc_code, atc_name_zh, atc_name_en FROM atc WHERE license_id = ?",
                (license_id,),
            )
            atc_rows = cursor.fetchall()
            atc = []
            for a in atc_rows:
                atc.append({
                    "atc_code": a["atc_code"],
                    "atc_name_zh": a["atc_name_zh"],
                    "atc_name_en": a["atc_name_en"]
                })

            # 5. Get Documents
            cursor.execute(
                "SELECT insert_url, box_url FROM documents WHERE license_id = ?",
                (license_id,),
            )
            doc = cursor.fetchone()
            documents = {}
            if doc:
                documents = {
                    "insert_url": doc["insert_url"],
                    "box_url": doc["box_url"]
                }

            # Format as JSON
            result = {
                "license_id": lic["license_id"],
                "name_zh": lic["name_zh"],
                "name_en": lic["name_en"],
                "indication": lic["indication"],
                "usage": lic["usage"],
                "form": lic["form"],
                "package": lic["package"],
                "category": lic["category"],
                "manufacturer": lic["manufacturer"],
                "valid_date": lic["valid_date"],
                "ingredients": ingredients,
                "appearance": appearance,
                "atc": atc,
                "documents": documents
            }

            return json.dumps(result, ensure_ascii=False)

        except Exception as e:
            return json.dumps({"error": str(e)})
        finally:
            conn.close()

    def identify_pill(self, features: str):
        """
        Identify pill based on visual description (Shape, Color, Marking).
        """
        if not os.path.exists(self.db_path):
            return "DB initializing..."
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        # Simple keyword matching across visual fields
        # Ideally, features should be split (e.g., "white", "circle")
        keywords = features.split()
        conditions = []
        params = []

        for k in keywords:
            term = f"%{k}%"
            # Check shape, color, or marking matches
            conditions.append("(shape LIKE ? OR color LIKE ? OR marking LIKE ?)")
            params.extend([term, term, term])

        where_clause = " AND ".join(conditions)

        sql = f"""
            SELECT l.name_zh, l.name_en, a.shape, a.color, a.marking, l.license_id 
            FROM appearance a
            JOIN licenses l ON a.license_id = l.license_id
            WHERE {where_clause}
            LIMIT 5
        """

        cursor.execute(sql, tuple(params))
        rows = cursor.fetchall()
        conn.close()

        if not rows:
            return "No matching pills found based on description."

        return "\n".join(
            [
                f"藥名: {r[0]} ({r[1]})\n   特徵: {r[3]} {r[2]} (刻痕: {r[4]})"
                for r in rows
            ]
        )

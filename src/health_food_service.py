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


class HealthFoodService:
    """
    健康食品管理服務（保健品）
    負責管理台灣 FDA 核可的健康食品資料
    依據《健康食品管理法》規範
    """

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.db_path = os.path.join(data_dir, "health_foods.db")
        self.meta_path = os.path.join(data_dir, "health_food_meta.json")

        # Define API Source for Health Foods (Taiwan FDA)
        # 19: Health Food Dataset (健康食品資料集)
        self.API_SOURCE = "https://data.fda.gov.tw/data/opendata/export/19/json"

        # Disease to Health Benefit Mapping (基於台灣 FDA 核可的保健功效)
        # 注意：這僅供參考，不構成醫療建議
        self.DISEASE_BENEFIT_MAPPING = {
            # 代謝性疾病
            "E11": ["調節血糖", "延緩血糖上升"],  # 第二型糖尿病
            "E10": ["調節血糖", "延緩血糖上升"],  # 第一型糖尿病
            "E78": ["調節血脂", "不易形成體脂肪"],  # 高血脂症
            "E66": ["不易形成體脂肪", "調節血脂"],  # 肥胖
            "E79": ["調節尿酸"],  # 痛風
            # 心血管疾病
            "I10": ["調節血脂", "心血管保健"],  # 高血壓
            "I25": ["調節血脂", "心血管保健"],  # 缺血性心臟病
            "I21": ["調節血脂", "心血管保健"],  # 心肌梗塞
            # 肝膽疾病
            "K70": ["護肝"],  # 酒精性肝病
            "K71": ["護肝"],  # 毒性肝病
            "K72": ["護肝"],  # 肝衰竭
            "K73": ["護肝"],  # 慢性肝炎
            "K74": ["護肝"],  # 肝纖維化和肝硬化
            "K76": ["護肝"],  # 其他肝臟疾病
            # 骨骼肌肉系統
            "M80": ["骨質保健", "促進鈣吸收"],  # 有病理性骨折的骨質疏鬆症
            "M81": ["骨質保健", "促進鈣吸收"],  # 無病理性骨折的骨質疏鬆症
            "M15": ["關節保健"],  # 多發性關節病
            "M17": ["關節保健"],  # 膝關節病
            # 消化系統
            "K59": ["胃腸功能改善", "促進腸道有益菌增生"],  # 功能性腸道疾患
            "K29": ["胃腸功能改善"],  # 胃炎和十二指腸炎
            "K21": ["胃腸功能改善"],  # 胃食道逆流
            # 免疫系統
            "D84": ["免疫調節"],  # 其他免疫缺陷
            "J06": ["免疫調節"],  # 急性上呼吸道感染
            # 眼科疾病
            "H52": ["護眼保健", "調節視覺"],  # 屈光不正和調節障礙
            "H53": ["護眼保健"],  # 視覺障礙
            # 泌尿系統
            "N40": ["促進泌尿道保健"],  # 攝護腺增大
            "N39": ["促進泌尿道保健"],  # 泌尿系統其他疾患
            # 牙齒保健
            "K02": ["牙齒保健", "促進釋放齒垢"],  # 齲齒
            "K05": ["牙齒保健"],  # 牙齦炎和牙周病
            # 皮膚
            "L70": ["調節免疫", "皮膚保健"],  # 痤瘡
        }

        # 醫療免責聲明（符合台灣法規）
        self.MEDICAL_DISCLAIMER = """
╔═══════════════════════════════════════════════════════════════╗
║                      ⚠️  重要醫療聲明 ⚠️                       ║
╚═══════════════════════════════════════════════════════════════╝

【法規遵循聲明】
1. 健康食品非藥品，不具有治療、矯正人類疾病之效能
2. 健康食品僅供「輔助保健」用途，不可取代正規醫療
3. 本分析僅供參考，不構成醫療建議或處方

【使用者責任】
1. 任何疾病診斷與治療，請務必諮詢合格醫療專業人員
2. 使用健康食品前，應告知醫師並確認無禁忌症
3. 若症狀持續或惡化，應立即就醫

【資料來源】
- 疾病資訊：ICD-10-CM 國際疾病分類標準
- 健康食品：台灣衛生福利部食品藥物管理署核可資料

依據《健康食品管理法》，健康食品之保健功效需經科學評估證實。
════════════════════════════════════════════════════════════════
"""

        # Initialize the scheduler
        self.scheduler = BackgroundScheduler()
        # Schedule the update to run every Monday at 00:00
        self.scheduler.add_job(
            self._update_data, "cron", day_of_week="mon", hour=0, minute=0
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
            log_info("Health Food DB not found. Initializing full download...")
            should_update = True
        else:
            try:
                if os.path.exists(self.meta_path):
                    with open(self.meta_path, "r") as f:
                        meta = json.load(f)
                        last_updated = datetime.fromisoformat(meta.get("last_updated"))
                        if last_updated < self._get_last_monday():
                            log_info("Health Food DB is outdated. Scheduling update...")
                            should_update = True
                else:
                    should_update = True
            except Exception as e:
                log_error(f"Error checking health food DB update status: {e}")
                should_update = True

        if should_update:
            # Run in a separate thread to avoid blocking server startup
            t = threading.Thread(target=self._update_data)
            t.start()

    def _update_data(self):
        """Download and update health foods database."""
        log_info("Starting Health Food Database Update...")
        conn = sqlite3.connect(self.db_path)

        try:
            log_info(f"Downloading health foods data from {self.API_SOURCE}...")
            response = requests.get(self.API_SOURCE, stream=True, timeout=60)

            if response.status_code != 200:
                log_error(
                    f"Failed to download health foods: HTTP {response.status_code}"
                )
                return

            # Check if response is a ZIP file
            content_type = response.headers.get("Content-Type", "")
            if "zip" in content_type or self.API_SOURCE.endswith(".zip"):
                log_info("Detected ZIP file, extracting...")
                zip_file = zipfile.ZipFile(io.BytesIO(response.content))
                json_files = [f for f in zip_file.namelist() if f.endswith(".json")]
                if not json_files:
                    log_error("No JSON file found in ZIP")
                    return
                with zip_file.open(json_files[0]) as json_file:
                    data = json.load(json_file)
            else:
                data = response.json()

            cursor = conn.cursor()

            # Create health_foods table
            cursor.execute("DROP TABLE IF EXISTS health_foods")
            cursor.execute(
                """
                CREATE TABLE health_foods (
                    license_number TEXT,
                    category TEXT,
                    name_zh TEXT,
                    approval_date TEXT,
                    applicant TEXT,
                    status TEXT,
                    functional_components TEXT,
                    health_benefit TEXT,
                    health_claim TEXT,
                    warning TEXT,
                    precautions TEXT,
                    url TEXT
                )
            """
            )

            # Insert data
            rows_to_insert = []
            for item in data:
                row = (
                    str(item.get("許可證字號", "")),
                    str(item.get("類別", "")),
                    str(item.get("中文品名", "")),
                    str(item.get("核可日期", "")),
                    str(item.get("申請商", "")),
                    str(item.get("證況", "")),
                    str(item.get("保健功效相關成分", "")),
                    str(item.get("保健功效", "")),
                    str(item.get("保健功效宣稱", "")),
                    str(item.get("警語", "")),
                    str(item.get("注意事項", "")),
                    str(item.get("網址", "")),
                )
                rows_to_insert.append(row)

            cursor.executemany(
                """
                INSERT INTO health_foods VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                rows_to_insert,
            )

            # Create indexes
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_health_foods_name ON health_foods(name_zh)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_health_foods_benefit ON health_foods(health_benefit)"
            )

            conn.commit()
            log_info(f"Updated health_foods: {len(rows_to_insert)} rows.")

            # Update metadata
            with open(self.meta_path, "w") as f:
                json.dump({"last_updated": datetime.now().isoformat()}, f)

            log_info("Health food dataset updated successfully.")

        except Exception as e:
            log_error(f"Health food update failed: {e}")
        finally:
            conn.close()

    # --- Query Features for Health Foods ---

    def search_health_food(self, keyword: str):
        """
        Search for health foods by name or health benefit.
        """
        if not os.path.exists(self.db_path):
            return "資料庫初始化中，請稍候..."

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        query = f"%{keyword}%"
        sql = """
            SELECT name_zh, license_number, category, health_benefit, health_claim, status
            FROM health_foods
            WHERE name_zh LIKE ? OR health_benefit LIKE ? OR health_claim LIKE ? OR functional_components LIKE ?
            LIMIT 10
        """
        cursor.execute(sql, (query, query, query, query))
        rows = cursor.fetchall()
        conn.close()

        if not rows:
            return f"找不到與 '{keyword}' 相關的健康食品。"

        results = []
        for r in rows:
            results.append(
                f"【{r[1]}】 {r[0]}\n"
                f"   類別: {r[2]}\n"
                f"   保健功效: {r[3]}\n"
                f"   功效宣稱: {r[4][:80]}{'...' if len(r[4]) > 80 else ''}\n"
                f"   證況: {r[5]}"
            )

        return "\n\n".join(results)

    def get_health_food_details(self, license_number: str):
        """
        Get comprehensive details for a specific health food by license number.
        """
        if not os.path.exists(self.db_path):
            return "資料庫初始化中，請稍候..."

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        cursor.execute(
            "SELECT * FROM health_foods WHERE license_number = ?", (license_number,)
        )
        food = cursor.fetchone()
        conn.close()

        if not food:
            return f"找不到許可證字號: {license_number}"

        output = f"""
=== 健康食品詳情 ===
許可證字號: {food['license_number']}
中文品名: {food['name_zh']}
類別: {food['category']}
申請商: {food['applicant']}
核可日期: {food['approval_date']}
證況: {food['status']}

【保健功效相關成分】
{food['functional_components']}

【保健功效】
{food['health_benefit']}

【保健功效宣稱】
{food['health_claim']}

【警語】
{food['warning'] if food['warning'] else '無'}

【注意事項】
{food['precautions'] if food['precautions'] else '無'}

【相關網址】
{food['url'] if food['url'] else '無'}
"""
        return output

    # --- Helper Methods for Comprehensive Analysis ---

    def _extract_icd_code(self, diagnosis_keyword: str) -> str:
        """Extract ICD code from diagnosis keyword."""
        diagnosis_keyword = diagnosis_keyword.strip().upper()
        if len(diagnosis_keyword) >= 2 and diagnosis_keyword[0].isalpha():
            parts = diagnosis_keyword.split(".")
            return parts[0]
        return None

    def analyze_health_support_for_condition(
        self, diagnosis_keyword: str, icd_service=None, food_nutrition_service=None
    ):
        """
        【綜合分析】根據疾病診斷，推薦適合的健康食品與飲食建議。

        ⚠️ 重要：此功能嚴格遵循台灣法規，健康食品僅供輔助保健，不可取代醫療。
        """
        if not os.path.exists(self.db_path):
            return "資料庫初始化中，請稍候..."

        # Step 1: 獲取疾病資訊
        diagnosis_info = ""
        icd_code = None

        if icd_service:
            diagnosis_info = icd_service.search_codes(
                diagnosis_keyword, type="diagnosis"
            )
            icd_code = self._extract_icd_code(diagnosis_keyword)
        else:
            diagnosis_info = f"診斷關鍵字: {diagnosis_keyword}\n（ICD Service 未啟用，無法提供詳細疾病資訊）"
            icd_code = self._extract_icd_code(diagnosis_keyword)

        # Step 2: 根據 ICD 碼推薦保健功效
        recommended_benefits = []
        mapping_info = ""

        if icd_code and icd_code in self.DISEASE_BENEFIT_MAPPING:
            recommended_benefits = self.DISEASE_BENEFIT_MAPPING[icd_code]
            mapping_info = f"✓ 系統已識別 ICD 碼: {icd_code}\n✓ 建議保健功效: {', '.join(recommended_benefits)}"
        else:
            mapping_info = f"ℹ️ 未找到 ICD 碼對應，將使用關鍵字進行通用搜尋"
            recommended_benefits = [diagnosis_keyword]

        # Step 3: 搜尋相關健康食品
        health_foods_results = []
        for benefit in recommended_benefits:
            result = self.search_health_food(benefit)
            if "找不到" not in result:
                health_foods_results.append(f"\n【保健功效: {benefit}】\n{result}")

        health_foods_section = (
            "\n".join(health_foods_results)
            if health_foods_results
            else "未找到相關健康食品"
        )

        # Step 4: 提供飲食建議（從飲食營養服務獲取）
        dietary_suggestions = self._get_dietary_suggestions(icd_code, diagnosis_keyword)

        # Step 5: 組合完整報告
        report = f"""
{self.MEDICAL_DISCLAIMER}

╔═══════════════════════════════════════════════════════════════╗
║              🏥 疾病與健康食品輔助保健分析報告                ║
╚═══════════════════════════════════════════════════════════════╝

【第一部分：疾病診斷資訊】
{diagnosis_info}

【第二部分：保健功效對應分析】
{mapping_info}

【第三部分：建議參考之健康食品（保健品）】
注意：以下健康食品已通過台灣 FDA 核可，具有標示之保健功效。
      使用前請詳閱產品標示，並諮詢醫療專業人員。
{health_foods_section}

【第四部分：飲食營養建議】
{dietary_suggestions}

════════════════════════════════════════════════════════════════
📋 報告說明：
   本報告整合台灣衛福部食藥署公開資料，提供參考資訊。
   所有建議僅供輔助保健參考，不構成醫療處方或診斷。

⚠️  再次提醒：
   1. 健康食品不能治療疾病，僅能輔助保健
   2. 請勿自行停藥或更改醫師處方
   3. 使用任何健康食品前，請告知您的醫師
   4. 若症狀持續或惡化，請立即就醫
════════════════════════════════════════════════════════════════
"""
        return report

    def _get_dietary_suggestions(self, icd_code: str, diagnosis_keyword: str) -> str:
        """根據疾病類型提供飲食建議。"""
        suggestions = {
            # 代謝性疾病
            "E11": "建議攝取低GI食物（如糙米、燕麥）、高纖維蔬菜、適量優質蛋白質（雞胸肉、魚類）。\n避免：精緻糖類、含糖飲料、高脂肪食物。",
            "E10": "建議攝取低GI食物、高纖維蔬菜、適量優質蛋白質。\n避免：精緻糖類、含糖飲料、高脂肪食物。",
            "E78": "建議攝取富含Omega-3脂肪酸的魚類、堅果、燕麥、蔬菜水果。\n避免：飽和脂肪、反式脂肪、內臟類食物、油炸食品。",
            "E66": "建議攝取高纖維食物、瘦肉蛋白、大量蔬菜、適量水果。\n避免：高熱量食物、油炸食品、含糖飲料、精緻澱粉。",
            "E79": "建議攝取低普林食物（蔬菜、水果、全穀類）、充足水分。\n避免：高普林食物（內臟、海鮮、肉湯）、酒精。",
            # 心血管疾病
            "I10": "建議採用得舒飲食（DASH）：蔬菜、水果、全穀類、低脂乳製品、瘦肉。\n避免：高鈉食物、加工食品、醃製品。",
            "I25": "建議攝取富含Omega-3的魚類、堅果、橄欖油、蔬菜水果。\n避免：飽和脂肪、反式脂肪、高鈉食物。",
            # 肝膽疾病
            "K70": "建議攝取優質蛋白質、新鮮蔬果、全穀類、適量好油。\n嚴格避免：酒精。",
            "K74": "建議攝取優質蛋白質（豆類、魚類）、抗氧化蔬果（深綠色蔬菜、莓果）。\n避免：酒精、高脂肪食物、加工食品。",
            # 骨骼系統
            "M80": "建議攝取高鈣食物（牛奶、豆腐、小魚乾）、維生素D（鮭魚、蛋黃）、適度日曬。",
            "M81": "建議攝取高鈣食物、維生素D、維生素K（綠葉蔬菜）、適量蛋白質。",
            "M17": "建議攝取富含Omega-3的魚類、抗氧化蔬果、維生素C（柑橘類）。",
            # 消化系統
            "K59": "建議攝取高纖維食物、益生菌（優格、味噌）、充足水分。\n避免：刺激性食物、油膩食物。",
            "K29": "建議攝取溫和易消化食物、避免空腹、規律進食。\n避免：辛辣、酸性、油膩食物、咖啡、酒精。",
        }

        if icd_code in suggestions:
            return f"針對 {icd_code} 相關疾病的飲食建議：\n\n{suggestions[icd_code]}\n\n💡 建議諮詢營養師制定個人化飲食計畫。"

        return """
一般健康飲食原則：
- 均衡攝取六大類食物
- 多吃蔬菜水果
- 選擇全穀雜糧
- 適量優質蛋白質
- 減少油、糖、鹽攝取
- 充足飲水

💡 建議諮詢營養師或醫師，制定適合您個人狀況的飲食計畫。
"""

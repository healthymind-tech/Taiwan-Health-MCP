import glob
import os

from mcp.server.fastmcp import FastMCP

from config import MCPConfig  # Import at top level
from clinical_guideline_service import ClinicalGuidelineService
from drug_service import DrugService
from fhir_condition_service import FHIRConditionService
from fhir_medication_service import FHIRMedicationService
from food_nutrition_service import FoodNutritionService
from health_food_service import HealthFoodService
from icd_service import ICDService
from lab_service import LabService
from utils import log_error, log_info

# 0. Load Configuration
config = MCPConfig.from_env()

# 1. Initialize the MCP Server
# Pass host and port here, as run() does not accept them in newer versions
mcp = FastMCP(
    "taiwanHealthMcp",
    host=config.host,
    port=config.port,
    dependencies=["uvicorn"],
)

# 2. Configure data paths
# Automatically detect if running in Google Colab or Docker
if os.path.exists("/content/Taiwan-Health-MCP/data"):
    DATA_DIR = "/content/Taiwan-Health-MCP/data"
elif os.path.exists("/app/data"):
    DATA_DIR = "/app/data"
else:
    # Fallback to local data directory
    DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")

log_info(f"Using DATA_DIR: {DATA_DIR}")

# Automatically find the ICD-10 Excel file.
excel_files = glob.glob(os.path.join(DATA_DIR, "*.xlsx"))
if excel_files:
    ICD_FILE_PATH = excel_files[0]
    log_info(f"Found ICD Excel file: {ICD_FILE_PATH}")
else:
    ICD_FILE_PATH = os.path.join(DATA_DIR, "default.xlsx")
    log_error("No Excel file found in data directory!")

# 3. Initialize Services with individual try-except blocks to ensure maximum availability
log_info("Initializing Services...")

icd_service = None
drug_service = None
health_food_service = None
food_nutrition_service = None
fhir_condition_service = None
fhir_medication_service = None
lab_service = None
guideline_service = None

try:
    icd_service = ICDService(ICD_FILE_PATH, DATA_DIR)
except Exception as e:
    log_error(f"ICDService failed: {e}")

try:
    drug_service = DrugService(DATA_DIR)
except Exception as e:
    log_error(f"DrugService failed: {e}")

try:
    health_food_service = HealthFoodService(DATA_DIR)
except Exception as e:
    log_error(f"HealthFoodService failed: {e}")

try:
    food_nutrition_service = FoodNutritionService(DATA_DIR)
except Exception as e:
    log_error(f"FoodNutritionService failed: {e}")

try:
    if icd_service:
        fhir_condition_service = FHIRConditionService(icd_service)
except Exception as e:
    log_error(f"FHIRConditionService failed: {e}")

try:
    if drug_service:
        fhir_medication_service = FHIRMedicationService(drug_service)
except Exception as e:
    log_error(f"FHIRMedicationService failed: {e}")

try:
    lab_service = LabService(DATA_DIR)
except Exception as e:
    log_error(f"LabService failed: {e}")

try:
    guideline_service = ClinicalGuidelineService(DATA_DIR)
except Exception as e:
    log_error(f"ClinicalGuidelineService failed: {e}")

# ==========================================
# Group 1: ICD-10 Tools (Diagnosis & Procedures)
# ==========================================


@mcp.tool()
def search_medical_codes(keyword: str, type: str = "all") -> str:
    """
    Search for ICD-10-CM (Diagnosis) or ICD-10-PCS (Procedure) codes.

    Args:
        keyword: Search term (e.g., 'Diabetes', 'E11', 'Appendectomy', '子宮內膜異位').
        type: Filter by 'diagnosis', 'procedure', or 'all'. Default is 'all'.
    """
    log_info(f"Tool called: search_medical_codes with query='{keyword}', type='{type}'")
    return icd_service.search_codes(keyword, type)


@mcp.tool()
def infer_complications(code: str) -> str:
    """
    Infers potential complications or specific sub-conditions based on ICD hierarchy.
    Example: Input 'E11' (Type 2 Diabetes) -> Returns specific codes like E11.9, E11.2 (with kidney complications).

    Args:
        code: The base diagnosis code (e.g., 'E11', 'N80').
    """
    log_info(f"Tool called: infer_complications with code='{code}'")
    return icd_service.infer_complications(code)


@mcp.tool()
def get_nearby_codes(code: str) -> str:
    """
    Retrieves codes immediately preceding and following the target code.
    Useful for differential diagnosis context or seeing related severity levels.

    Args:
        code: The target diagnosis code.
    """
    log_info(f"Tool called: get_nearby_codes with code='{code}'")
    return icd_service.get_nearby_codes(code)


@mcp.tool()
def check_medical_conflict(diagnosis_code: str, procedure_code: str) -> str:
    """
    **IMPORTANT: Use this tool when you need to verify if a diagnosis and procedure combination is medically appropriate.**

    This tool simultaneously retrieves and compares:
    - Full details of the diagnosis code (ICD-10-CM)
    - Full details of the procedure code (ICD-10-PCS)
    - Provides structured data for conflict analysis

    Use this when the user asks about:
    - "Are these codes compatible?"
    - "Does X diagnosis match Y procedure?"
    - "Check if this procedure is appropriate for this diagnosis"
    - "Is there a conflict between these codes?"

    Args:
        diagnosis_code: ICD-10-CM diagnosis code (e.g., 'K35.80', 'N80.A0').
        procedure_code: ICD-10-PCS procedure code (e.g., '0DTJ0ZZ', '0UT90ZZ').

    Returns:
        JSON with both diagnosis and procedure details for comparison and conflict analysis.
    """
    log_info(
        f"Tool called: check_medical_conflict ({diagnosis_code} vs {procedure_code})"
    )
    return icd_service.get_conflict_info(diagnosis_code, procedure_code)


# ==========================================
# Group 2: Drug Tools (Taiwan FDA Data)
# ==========================================


@mcp.tool()
def search_drug_info(keyword: str) -> str:
    """
    Search for Taiwan FDA approved drugs by name (Chinese/English) or indication.
    Returns basic information including License ID, Name, and Indication.

    Args:
        keyword: Drug name or symptom (e.g., 'Panadol', '普拿疼', '頭痛').
    """
    log_info(f"Tool called: search_drug_info with query='{keyword}'")
    return drug_service.search_drug(keyword)


@mcp.tool()
def get_drug_details(license_id: str) -> str:
    """
    Get comprehensive details for a specific drug license ID.
    Includes: Ingredients, Usage, Appearance (shape/color), and Package Insert links.

    Args:
        license_id: The specific license ID found via search (e.g., '衛部藥製字第058498號').
    """
    log_info(f"Tool called: get_drug_details for ID='{license_id}'")
    return drug_service.get_details(license_id)


@mcp.tool()
def identify_unknown_pill(features: str) -> str:
    """
    Identify a pill based on visual features using the appearance database.

    Args:
        features: Keywords describing the pill (e.g., 'white circle YP', 'oval pink').
                  Include shape, color, and markings if visible.
    """
    log_info(f"Tool called: identify_unknown_pill with features='{features}'")
    return drug_service.identify_pill(features)


# ==========================================
# Group 3: Composite Analysis (The "Doctor Brain")
# ==========================================


@mcp.tool()
def analyze_treatment_plan(diagnosis_keyword: str, drug_keyword: str) -> str:
    """
    [Advanced] Analyze the correlation between a diagnosis and a drug.
    Fetches data from both ICD-10 and FDA Drug databases to help evaluate treatment appropriateness.

    Args:
        diagnosis_keyword: The condition or disease name/code (e.g., 'Diabetes', 'E11').
        drug_keyword: The medication name (e.g., 'Metformin').
    """
    log_info(
        f"Tool called: analyze_treatment with diagnosis='{diagnosis_keyword}', drug='{drug_keyword}'"
    )

    # 1. Search ICD (broad search first)
    icd_result = icd_service.search_codes(diagnosis_keyword, type="diagnosis")

    # 2. Search Drug
    drug_result = drug_service.search_drug(drug_keyword)

    # 3. Combine results for the LLM to process
    return f"""
=== Comprehensive Analysis Context ===

[Context 1: Diagnosis Data (ICD-10)]
Query: {diagnosis_keyword}
Results:
{icd_result}

-------------------

[Context 2: Medication Data (Taiwan FDA)]
Query: {drug_keyword}
Results:
{drug_result}

-------------------
SYSTEM INSTRUCTION:
Based on the above retrieved data, please analyze:
1. Does the medication's indication match the diagnosis?
2. Are there any obvious contraindications based on the drug category?
3. Provide a brief summary for a healthcare professional.
"""


# ==========================================
# Group 4: Health Food Tools (Taiwan FDA)
# ==========================================


@mcp.tool()
def search_health_food(keyword: str) -> str:
    """
    Search for Taiwan FDA approved health foods by name or health benefit.
    Returns information including license number, category, health benefits, and claims.

    Args:
        keyword: Product name or health benefit (e.g., '靈芝', '調節血脂', '護肝').
    """
    log_info(f"Tool called: search_health_food with query='{keyword}'")
    return health_food_service.search_health_food(keyword)


@mcp.tool()
def get_health_food_details(license_number: str) -> str:
    """
    Get comprehensive details for a specific health food by license number.
    Includes functional components, health benefits, claims, warnings, and precautions.

    Args:
        license_number: The specific license number (e.g., '衛部健食字第A00123號').
    """
    log_info(f"Tool called: get_health_food_details for license='{license_number}'")
    return health_food_service.get_health_food_details(license_number)


# ==========================================
# Group 5: Nutrition & Dietary Management Tools
# ==========================================


@mcp.tool()
def search_food_nutrition(food_name: str, nutrient: str = None) -> str:
    """
    Search for nutritional information of foods from Taiwan's food nutrition database.

    Args:
        food_name: Name of the food (e.g., '白米', '雞蛋', '蘋果', 'chicken breast').
        nutrient: Optional - specific nutrient to filter (e.g., '蛋白質', '維生素C', '鈣').
    """
    log_info(
        f"Tool called: search_food_nutrition with food='{food_name}', nutrient='{nutrient}'"
    )
    return food_nutrition_service.search_nutrition(food_name, nutrient)


@mcp.tool()
def get_detailed_nutrition(food_name: str) -> str:
    """
    Get comprehensive nutritional breakdown for a specific food item.
    Returns all available nutrients organized by category (e.g., macronutrients, vitamins, minerals).

    Args:
        food_name: The specific food name (e.g., '糙米', '雞胸肉').
    """
    log_info(f"Tool called: get_detailed_nutrition for food='{food_name}'")
    return food_nutrition_service.get_detailed_nutrition(food_name)


@mcp.tool()
def search_food_ingredient(keyword: str) -> str:
    """
    Search for food ingredients/materials in Taiwan's regulatory database.
    Useful for checking if an ingredient is approved for food use.

    Args:
        keyword: Ingredient name in Chinese or English (e.g., '薑黃', 'turmeric', '人參').
    """
    log_info(f"Tool called: search_food_ingredient with query='{keyword}'")
    return food_nutrition_service.search_food_ingredient(keyword)


@mcp.tool()
def get_ingredients_by_category(category: str) -> str:
    """
    Get all approved food ingredients in a specific category.

    Args:
        category: Category name (e.g., '香料植物', '食品添加物', '著色劑').
    """
    log_info(f"Tool called: get_ingredients_by_category for category='{category}'")
    return food_nutrition_service.get_ingredients_by_category(category)


@mcp.tool()
def analyze_meal_nutrition(foods: list[str]) -> str:
    """
    Analyze the combined nutritional composition of multiple foods (meal planning).

    Args:
        foods: List of food names to analyze together (e.g., ['白米', '雞胸肉', '青花菜']).
    """
    log_info(f"Tool called: analyze_meal_nutrition with foods={foods}")
    return food_nutrition_service.analyze_diet_plan(foods)


# ==========================================
# Group 6: Comprehensive Health Analysis (疾病與保健整合分析)
# ==========================================


@mcp.tool()
def analyze_health_support_for_condition(diagnosis_keyword: str) -> str:
    """
    **【綜合分析工具】疾病與健康食品輔助保健分析**

    根據疾病診斷，提供適合的健康食品推薦與飲食建議。

    ⚠️ **重要法規聲明**：
    - 健康食品非藥品，不具治療疾病之效能
    - 此功能僅供「輔助保健參考」，不可取代正規醫療
    - 所有建議必須在醫師指導下使用

    **功能說明**：
    1. 查詢疾病的 ICD-10 診斷資訊
    2. 根據疾病對應適合的保健功效
    3. 推薦台灣 FDA 核可的相關健康食品
    4. 提供基於實證的飲食營養建議
    5. 包含完整醫療免責聲明

    **適用場景**：
    - 慢性病患者尋求輔助保健建議
    - 了解特定疾病可參考的健康食品
    - 整合性健康管理規劃

    Args:
        diagnosis_keyword: 疾病名稱或 ICD-10 碼
                          Examples:
                          - ICD 碼: 'E11' (第二型糖尿病), 'I10' (高血壓), 'K74' (肝硬化)
                          - 中文: '糖尿病', '高血脂', '骨質疏鬆'
                          - 英文: 'diabetes', 'hypertension', 'osteoporosis'

    Returns:
        完整的綜合分析報告，包含：
        - 疾病診斷資訊（來自 ICD-10）
        - 建議的保健功效類別
        - 相關健康食品列表（台灣 FDA 核可）
        - 飲食營養建議
        - 醫療安全聲明

    **使用範例**：
    - analyze_health_support_for_condition("E11")  # 查詢第二型糖尿病
    - analyze_health_support_for_condition("糖尿病")  # 使用中文查詢
    - analyze_health_support_for_condition("高血壓")  # 查詢高血壓
    """
    log_info(
        f"Tool called: analyze_health_support_for_condition with diagnosis='{diagnosis_keyword}'"
    )

    # 傳入 icd_service 和 food_nutrition_service 以整合疾病資訊和飲食建議
    return health_food_service.analyze_health_support_for_condition(
        diagnosis_keyword=diagnosis_keyword,
        icd_service=icd_service,
        food_nutrition_service=food_nutrition_service,
    )


# ==========================================
# Group 7: FHIR Interoperability Tools
# ==========================================


@mcp.tool()
def create_fhir_condition(
    icd_code: str,
    patient_id: str,
    clinical_status: str = "active",
    verification_status: str = "confirmed",
    category: str = "encounter-diagnosis",
    severity: str = None,
    onset_date: str = None,
    recorded_date: str = None,
    additional_notes: str = None,
) -> str:
    """
    將 ICD-10-CM 診斷碼轉換為符合 FHIR R4 標準的 Condition 資源。

    FHIR (Fast Healthcare Interoperability Resources) 是全球醫療資訊交換標準，
    此工具可生成符合台灣醫療系統的 FHIR Condition 資源。

    Args:
        icd_code: ICD-10-CM 診斷碼（例如: "E11.9" 表示第二型糖尿病）
        patient_id: 患者識別碼（例如: "patient-001"）
        clinical_status: 臨床狀態，可選值:
            - "active": 活動中（症狀持續存在）
            - "inactive": 非活動（無症狀但未完全治癒）
            - "resolved": 已解決（完全治癒）
            - "remission": 緩解期（癌症等疾病的緩解狀態）
        verification_status: 驗證狀態，可選值:
            - "confirmed": 已確診（經檢查確認）
            - "provisional": 臨時診斷（初步診斷，需進一步確認）
            - "differential": 鑑別診斷（多個可能診斷之一）
            - "refuted": 已排除（排除此診斷）
        category: 診斷分類，可選值:
            - "encounter-diagnosis": 就診診斷（本次就醫的診斷）
            - "problem-list-item": 問題清單項目（長期追蹤的健康問題）
        severity: 嚴重程度（可選），可選值: "mild"（輕度）, "moderate"（中度）, "severe"（重度）
        onset_date: 發病日期（可選），格式: YYYY-MM-DD（例如: "2024-01-15"）
        recorded_date: 記錄日期時間（可選），格式: YYYY-MM-DDTHH:MM:SS+08:00
        additional_notes: 額外備註（可選），任何補充說明

    Returns:
        符合 FHIR R4 標準的 Condition 資源（JSON 格式字串）

    Example:
        create_fhir_condition(
            icd_code="E11.9",
            patient_id="patient-001",
            clinical_status="active",
            severity="moderate",
            onset_date="2024-01-15"
        )
    """
    log_info(
        f"Tool called: create_fhir_condition for ICD={icd_code}, Patient={patient_id}"
    )

    result = fhir_condition_service.create_condition(
        icd_code=icd_code,
        patient_id=patient_id,
        clinical_status=clinical_status,
        verification_status=verification_status,
        category=category,
        severity=severity,
        onset_date=onset_date,
        recorded_date=recorded_date,
        additional_notes=additional_notes,
    )

    return fhir_condition_service.to_json_string(result, indent=2)


@mcp.tool()
def create_fhir_condition_from_diagnosis(
    diagnosis_keyword: str,
    patient_id: str,
    clinical_status: str = "active",
    verification_status: str = "confirmed",
    severity: str = None,
) -> str:
    """
    從疾病關鍵字搜尋並建立 FHIR Condition 資源（自動查找 ICD-10 編碼）。

    此工具會先搜尋符合關鍵字的診斷碼，然後自動建立 FHIR Condition 資源。
    適合用於不確定 ICD-10 編碼但知道疾病名稱的情況。

    Args:
        diagnosis_keyword: 疾病關鍵字（中文或英文），例如: "糖尿病", "高血壓", "Diabetes"
        patient_id: 患者識別碼
        clinical_status: 臨床狀態（預設: "active"）
        verification_status: 驗證狀態（預設: "confirmed"）
        severity: 嚴重程度（可選）

    Returns:
        包含搜尋結果和 FHIR Condition 資源的 JSON 字串

    Example:
        create_fhir_condition_from_diagnosis(
            diagnosis_keyword="第二型糖尿病",
            patient_id="patient-001",
            severity="moderate"
        )
    """
    log_info(
        f"Tool called: create_fhir_condition_from_diagnosis for '{diagnosis_keyword}'"
    )

    result = fhir_condition_service.create_condition_from_search(
        keyword=diagnosis_keyword,
        patient_id=patient_id,
        clinical_status=clinical_status,
        verification_status=verification_status,
        severity=severity,
    )

    return fhir_condition_service.to_json_string(result, indent=2)


@mcp.tool()
def validate_fhir_condition(condition_json: str) -> str:
    """
    驗證 FHIR Condition 資源是否符合 FHIR R4 標準規範。

    此工具會檢查 Condition 資源的必要欄位、資料格式和邏輯正確性。

    Args:
        condition_json: FHIR Condition 資源的 JSON 字串

    Returns:
        驗證結果，包含錯誤和警告訊息

    Example:
        validate_fhir_condition('{"resourceType": "Condition", ...}')
    """
    log_info("Tool called: validate_fhir_condition")

    import json

    try:
        condition = json.loads(condition_json)
        result = fhir_condition_service.validate_condition(condition)
        return fhir_condition_service.to_json_string(result, indent=2)
    except json.JSONDecodeError as e:
        log_error(f"JSON decode error in validate_fhir_condition: {e}")
        return fhir_condition_service.to_json_string(
            {"valid": False, "errors": [f"Invalid JSON format: {str(e)}"]}, indent=2
        )


# ==========================================
# Group 8: Laboratory & LOINC Tools
# ==========================================


@mcp.tool()
def search_loinc_code(keyword: str, category: str = None) -> str:
    """
    搜尋 LOINC 碼（台灣檢驗項目對照國際標準）

    LOINC (Logical Observation Identifiers Names and Codes) 是全球醫療檢驗項目的標準編碼系統。
    本工具提供台灣常用檢驗項目與 LOINC 碼的對照查詢。

    Args:
        keyword: 搜尋關鍵字（檢驗名稱、LOINC 碼、常用縮寫）
            - 支援中文：例如 "血糖"、"肝功能"、"糖化血色素"
            - 支援英文：例如 "Glucose"、"HbA1c"
            - 支援縮寫：例如 "WBC"、"RBC"、"ALT"、"Cr"
        category: 分類篩選（可選）
            - "血液常規"、"生化檢驗-血糖"、"生化檢驗-血脂"
            - "生化檢驗-肝功能"、"生化檢驗-腎功能"
            - "內分泌-甲狀腺"、"凝血功能"、"發炎指標"

    Returns:
        LOINC 碼、檢驗名稱（中英文）、檢體類型、單位、檢測方法

    Examples:
        - search_loinc_code("血糖")  # 查詢血糖相關檢驗
        - search_loinc_code("HbA1c")  # 查詢糖化血色素
        - search_loinc_code("肝功能", category="生化檢驗-肝功能")
    """
    log_info(
        f"Tool called: search_loinc_code with keyword='{keyword}', category='{category}'"
    )
    return lab_service.search_loinc_code(keyword, category)


@mcp.tool()
def list_lab_categories() -> str:
    """
    列出所有檢驗分類

    Returns:
        所有可用的檢驗分類清單
    """
    log_info("Tool called: list_lab_categories")
    return lab_service.list_categories()


@mcp.tool()
def get_reference_range(loinc_code: str, age: int, gender: str = "all") -> str:
    """
    查詢檢驗參考值範圍（依年齡、性別）

    每個檢驗項目都有正常參考值範圍，且會因年齡、性別而異。
    本工具提供台灣醫療機構常用的參考值標準。

    Args:
        loinc_code: LOINC 碼（可使用 search_loinc_code 工具查詢）
        age: 患者年齡（歲）
        gender: 性別
            - "M": 男性
            - "F": 女性
            - "all": 不分性別（預設）

    Returns:
        檢驗項目資訊、參考值範圍（上限/下限）、適用對象

    Examples:
        - get_reference_range("1558-6", age=45, gender="M")  # 45歲男性空腹血糖參考值
        - get_reference_range("718-7", age=30, gender="F")   # 30歲女性血紅素參考值
    """
    log_info(
        f"Tool called: get_reference_range for LOINC={loinc_code}, age={age}, gender={gender}"
    )
    return lab_service.get_reference_range(loinc_code, age, gender)


@mcp.tool()
def interpret_lab_result(
    loinc_code: str, value: float, age: int, gender: str = "all"
) -> str:
    """
    判讀檢驗結果（自動比對參考值，判斷是否異常）

    輸入檢驗數值，系統會自動與參考值比對，判斷是否偏高、偏低或正常。

    Args:
        loinc_code: LOINC 碼
        value: 檢驗數值
        age: 患者年齡（歲）
        gender: 性別（"M"=男性, "F"=女性, "all"=不分性別）

    Returns:
        檢驗結果判讀：
        - 數值狀態（正常/偏高/偏低）
        - 參考值範圍
        - 臨床意義

    Examples:
        - interpret_lab_result("1558-6", value=126, age=50, gender="M")
          # 判讀空腹血糖 126 mg/dL
        - interpret_lab_result("4548-4", value=7.5, age=60, gender="F")
          # 判讀 HbA1c 7.5%
    """
    log_info(f"Tool called: interpret_lab_result for LOINC={loinc_code}, value={value}")
    return lab_service.interpret_lab_result(loinc_code, value, age, gender)


@mcp.tool()
def batch_interpret_lab_results(
    results_json: str, age: int, gender: str = "all"
) -> str:
    """
    批次判讀多個檢驗結果

    一次判讀多個檢驗項目，快速找出異常項目。

    Args:
        results_json: 檢驗結果 JSON 字串
            格式: [{"loinc_code": "1558-6", "value": 126}, ...]
        age: 患者年齡
        gender: 性別

    Returns:
        批次判讀結果摘要、異常項目統計、各項目詳細判讀

    Example:
        batch_interpret_lab_results(
            results_json='[
                {"loinc_code": "1558-6", "value": 126},
                {"loinc_code": "4548-4", "value": 7.2},
                {"loinc_code": "2093-3", "value": 220}
            ]',
            age=55,
            gender="M"
        )
    """
    log_info(f"Tool called: batch_interpret_lab_results for age={age}, gender={gender}")
    import json

    try:
        results = json.loads(results_json)
        return lab_service.batch_interpret_results(results, age, gender)
    except json.JSONDecodeError as e:
        log_error(f"JSON decode error in batch_interpret_lab_results: {e}")
        return json.dumps(
            {"error": f"Invalid JSON format: {str(e)}"}, ensure_ascii=False
        )


# ==========================================
# Group 9: Clinical Guideline Tools
# ==========================================


@mcp.tool()
def search_clinical_guideline(keyword: str) -> str:
    """
    搜尋臨床診療指引

    提供台灣各醫學會發布的臨床診療指引，包含診斷、治療、用藥建議。

    Args:
        keyword: 疾病名稱或 ICD-10 編碼
            - 例如："糖尿病"、"高血壓"、"E11"、"I10"

    Returns:
        診療指引清單（標題、來源醫學會、發布年份）

    Examples:
        - search_clinical_guideline("糖尿病")
        - search_clinical_guideline("E11")
    """
    log_info(f"Tool called: search_clinical_guideline with keyword='{keyword}'")
    return guideline_service.search_guideline(keyword)


@mcp.tool()
def get_complete_guideline(icd_code: str) -> str:
    """
    取得完整診療指引（診斷、用藥、檢查、治療目標）

    提供特定疾病的完整診療指引，包含：
    - 診斷建議（檢查流程、診斷標準）
    - 用藥建議（第一線/第二線藥物、劑量、禁忌症）
    - 檢查建議（追蹤項目、頻率）
    - 治療目標（血糖/血壓/血脂等控制目標）

    Args:
        icd_code: ICD-10 編碼（例如: "E11" 糖尿病, "I10" 高血壓）

    Returns:
        完整診療指引（結構化資料）

    Examples:
        - get_complete_guideline("E11")  # 糖尿病完整指引
        - get_complete_guideline("I10")  # 高血壓完整指引
    """
    log_info(f"Tool called: get_complete_guideline for ICD={icd_code}")
    return guideline_service.get_complete_guideline(icd_code)


@mcp.tool()
def get_medication_recommendations(icd_code: str) -> str:
    """
    取得用藥建議（根據診療指引）

    提供特定疾病的標準用藥建議，包含第一線、第二線藥物選擇。

    Args:
        icd_code: ICD-10 編碼

    Returns:
        用藥建議清單（藥物分類、範例藥品、劑量指引、禁忌症、證據等級）

    Example:
        get_medication_recommendations("E11")  # 糖尿病用藥建議
    """
    log_info(f"Tool called: get_medication_recommendations for ICD={icd_code}")
    return guideline_service.get_medication_recommendations(icd_code)


@mcp.tool()
def get_test_recommendations(icd_code: str) -> str:
    """
    取得檢查建議（根據診療指引）

    提供特定疾病的檢查建議，包含檢查項目、頻率、適應症。

    Args:
        icd_code: ICD-10 編碼

    Returns:
        檢查建議清單（檢查名稱、LOINC 碼、頻率、適應症、證據等級）

    Example:
        get_test_recommendations("E11")  # 糖尿病檢查建議
    """
    log_info(f"Tool called: get_test_recommendations for ICD={icd_code}")
    return guideline_service.get_test_recommendations(icd_code)


@mcp.tool()
def get_treatment_goals(icd_code: str) -> str:
    """
    取得治療目標（根據診療指引）

    提供特定疾病的治療目標，例如血糖/血壓/血脂的控制目標值。

    Args:
        icd_code: ICD-10 編碼

    Returns:
        治療目標清單（目標類型、參數、目標值、時間範圍）

    Example:
        get_treatment_goals("E11")  # 糖尿病治療目標（HbA1c <7% 等）
    """
    log_info(f"Tool called: get_treatment_goals for ICD={icd_code}")
    return guideline_service.get_treatment_goals(icd_code)


@mcp.tool()
def suggest_clinical_pathway(icd_code: str, patient_context_json: str = None) -> str:
    """
    建議臨床路徑（完整治療流程）

    根據診療指引，提供從診斷到治療的完整臨床路徑建議。

    Args:
        icd_code: ICD-10 編碼
        patient_context_json: 患者背景資訊（可選）
            格式: {"age": 60, "gender": "M", "comorbidities": ["高血壓", "高血脂"]}

    Returns:
        結構化臨床路徑：
        - 步驟1: 診斷確認
        - 步驟2: 基礎檢查
        - 步驟3: 治療啟始
        - 步驟4: 追蹤監測
        - 步驟5: 治療目標

    Example:
        suggest_clinical_pathway("E11")  # 糖尿病臨床路徑
    """
    log_info(f"Tool called: suggest_clinical_pathway for ICD={icd_code}")

    import json

    patient_context = None
    if patient_context_json:
        try:
            patient_context = json.loads(patient_context_json)
        except json.JSONDecodeError as e:
            log_error(f"JSON decode error in suggest_clinical_pathway: {e}")
            pass

    return guideline_service.suggest_clinical_pathway(icd_code, patient_context)


# ==========================================
# Group 10: FHIR Medication Tools
# ==========================================


@mcp.tool()
def create_fhir_medication(
    license_id: str, include_ingredients: bool = True, include_appearance: bool = True
) -> str:
    """
    將台灣 FDA 藥品許可證資料轉換為符合 FHIR R4 標準的 Medication 資源。

    FHIR Medication 資源用於描述藥品的基本資訊，包含：
    - 藥品識別資訊（許可證字號、藥品名稱）
    - 製造商資訊
    - 劑型（錠劑、膠囊、注射劑等）
    - 成分資訊（有效成分與含量）
    - 外觀描述（形狀、顏色、刻痕）

    Args:
        license_id: 台灣 FDA 藥品許可證字號
            範例: "衛署藥製字第012345號", "衛部藥輸字第026123號"
        include_ingredients: 是否包含成分資訊（預設: True）
        include_appearance: 是否包含外觀描述（預設: True）

    Returns:
        符合 FHIR R4 標準的 Medication 資源（JSON 格式字串）

    Example:
        create_fhir_medication(
            license_id="衛署藥製字第058498號",
            include_ingredients=True,
            include_appearance=True
        )
    """
    log_info(f"Tool called: create_fhir_medication for license_id={license_id}")

    result = fhir_medication_service.create_medication(
        license_id=license_id,
        include_ingredients=include_ingredients,
        include_appearance=include_appearance,
    )

    return fhir_medication_service.to_json_string(result, indent=2)


@mcp.tool()
def create_fhir_medication_knowledge(license_id: str) -> str:
    """
    建立 FHIR MedicationKnowledge 資源（藥品知識庫）。

    MedicationKnowledge 提供比 Medication 更詳細的藥品知識，包含：
    - 適應症（Indication）
    - 用法用量（Dosage Guidelines）
    - ATC 藥物分類（Anatomical Therapeutic Chemical Classification）
    - 包裝資訊
    - 藥品類別（處方藥/非處方藥）
    - 藥品特性（顏色、形狀、刻痕、外觀圖片）

    適用於：
    - 藥品資訊系統整合
    - 臨床決策支援系統
    - 藥品知識庫建立
    - 與國際醫療系統對接

    Args:
        license_id: 台灣 FDA 藥品許可證字號

    Returns:
        符合 FHIR R4 標準的 MedicationKnowledge 資源（JSON 格式字串）

    Example:
        create_fhir_medication_knowledge("衛署藥製字第058498號")
    """
    log_info(
        f"Tool called: create_fhir_medication_knowledge for license_id={license_id}"
    )

    result = fhir_medication_service.create_medication_knowledge(license_id)

    return fhir_medication_service.to_json_string(result, indent=2)


@mcp.tool()
def create_fhir_medication_from_name(
    drug_name: str, resource_type: str = "Medication"
) -> str:
    """
    從藥品名稱搜尋並建立 FHIR 資源（自動查找許可證）。

    此工具會先搜尋符合名稱的藥品，然後自動建立 FHIR 資源。
    適合用於不確定許可證字號但知道藥品名稱的情況。

    Args:
        drug_name: 藥品名稱（中文或英文）
            範例: "普拿疼", "Panadol", "立普妥"
        resource_type: FHIR 資源類型
            - "Medication": 基本藥品資源（預設）
            - "MedicationKnowledge": 完整藥品知識庫

    Returns:
        包含搜尋結果和 FHIR 資源的 JSON 字串

    Example:
        create_fhir_medication_from_name(
            drug_name="普拿疼",
            resource_type="Medication"
        )
    """
    log_info(
        f"Tool called: create_fhir_medication_from_name for drug_name='{drug_name}'"
    )

    result = fhir_medication_service.create_medication_from_search(
        keyword=drug_name, resource_type=resource_type
    )

    return fhir_medication_service.to_json_string(result, indent=2)


@mcp.tool()
def identify_pill_to_fhir(
    shape: str = None, color: str = None, marking: str = None
) -> str:
    """
    從藥品外觀識別並建立 FHIR Medication 資源。

    利用藥品外觀特徵（形狀、顏色、刻痕）識別藥品，並轉換為 FHIR 資源。
    適用於：
    - 未知藥品的識別
    - 藥品查驗登記
    - 用藥安全確認

    Args:
        shape: 形狀（可選）
            範例: "圓形", "橢圓形", "菱形", "長方形", "circle", "oval"
        color: 顏色（可選）
            範例: "白色", "粉紅色", "藍色", "white", "pink", "blue"
        marking: 刻痕/標記（可選）
            範例: "YP", "500", "分割線"

    Returns:
        包含識別結果和 FHIR Medication 資源的 JSON 字串

    Example:
        identify_pill_to_fhir(
            shape="圓形",
            color="白色",
            marking="500"
        )
    """
    log_info(
        f"Tool called: identify_pill_to_fhir with shape={shape}, color={color}, marking={marking}"
    )

    result = fhir_medication_service.create_medication_from_appearance(
        shape=shape, color=color, marking=marking
    )

    return fhir_medication_service.to_json_string(result, indent=2)


# --- Start Server ---
if __name__ == "__main__":
    from config import MCPConfig

    # 載入配置
    config = MCPConfig.from_env()

    # 輸出啟動資訊
    log_info("=" * 50)
    log_info("Taiwan Health MCP Server")
    log_info("=" * 50)
    log_info(str(config))
    log_info("Server is starting...")

    # 啟動服務
    mcp.run(**config.get_run_kwargs())

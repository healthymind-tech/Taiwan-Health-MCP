"""
TWCore Service - 臺灣核心實作指引 (TW Core IG) 即時查詢服務

統一存取 TWCore 所有 CodeSystem 資源，即時從官方 IG 抓取 FHIR JSON，
本地檔案僅作為離線快取。

資料來源: https://twcore.mohw.gov.tw/ig/twcore/

架構:
  - SITEMAP: 完整的 CodeSystem 清單與分類
  - 即時抓取: 每次查詢從 TWCore 取得最新 JSON
  - 本地快取: data/twcore_cache/{id}.json 作為離線備援
"""

import json
import os
from typing import Dict, List, Optional, Tuple

import requests

from utils import log_error, log_info


# ==========================================
# TWCore CodeSystem Sitemap（完整清單）
# ==========================================

TWCORE_BASE_URL = "https://twcore.mohw.gov.tw/ig/twcore"
TWCORE_BACKUP_URL = "https://build.fhir.org/ig/cctwFHIRterm/MOHW_TWCoreIG_Build"

# 每個 CodeSystem 的 ID、中文名稱、分類
CODESYSTEM_REGISTRY: List[Dict] = [
    # === 藥品相關 (medication) ===
    {
        "id": "medication-frequency-nhi-tw",
        "name": "臺灣健保署藥品使用頻率",
        "category": "medication",
        "keywords": ["頻率", "QD", "BID", "TID", "QID", "PRN", "AC", "PC", "frequency"],
    },
    {
        "id": "medication-path-tw",
        "name": "臺灣健保署給藥途徑",
        "category": "medication",
        "keywords": ["途徑", "口服", "注射", "外用", "吸入", "route", "path"],
    },
    {
        "id": "medication-nhi-tw",
        "name": "臺灣健保署用藥品項",
        "category": "medication",
        "keywords": ["健保藥品", "用藥", "藥品代碼", "NHI drug"],
    },
    {
        "id": "nhi-medication-ch-herb-tw",
        "name": "臺灣健保署中藥用藥品項",
        "category": "medication",
        "keywords": ["中藥", "中醫", "herb", "漢方"],
    },
    {
        "id": "medication-fda-tw",
        "name": "臺灣食藥署藥品許可證",
        "category": "medication",
        "keywords": ["許可證", "FDA", "藥證", "license"],
    },
    {
        "id": "medication-device-fda-tw",
        "name": "臺灣食藥署醫療器材許可證",
        "category": "medication",
        "keywords": ["醫療器材", "device", "器材許可"],
    },
    {
        "id": "medcation-atc-tw",
        "name": "臺灣食藥署藥品藥理治療分類ATC碼",
        "category": "medication",
        "keywords": ["ATC", "藥理分類", "治療分類", "anatomical"],
    },
    # === 診斷分類 (diagnosis) ===
    {
        "id": "icd-10-cm-2023-tw",
        "name": "臺灣健保署ICD-10-CM 2023年版",
        "category": "diagnosis",
        "keywords": ["ICD-10-CM", "診斷", "diagnosis", "2023"],
    },
    {
        "id": "icd-10-cm-2021-tw",
        "name": "臺灣健保署ICD-10-CM 2021年版",
        "category": "diagnosis",
        "keywords": ["ICD-10-CM", "診斷", "2021"],
    },
    {
        "id": "icd-10-cm-2014-tw",
        "name": "臺灣健保署ICD-10-CM 2014年版",
        "category": "diagnosis",
        "keywords": ["ICD-10-CM", "診斷", "2014"],
    },
    {
        "id": "icd-10-pcs-2023-tw",
        "name": "臺灣健保署ICD-10-PCS 2023年版",
        "category": "diagnosis",
        "keywords": ["ICD-10-PCS", "處置", "procedure", "2023"],
    },
    {
        "id": "icd-10-pcs-2021-tw",
        "name": "臺灣健保署ICD-10-PCS 2021年版",
        "category": "diagnosis",
        "keywords": ["ICD-10-PCS", "處置", "2021"],
    },
    {
        "id": "icd-10-pcs-2014-tw",
        "name": "臺灣健保署ICD-10-PCS 2014年版",
        "category": "diagnosis",
        "keywords": ["ICD-10-PCS", "處置", "2014"],
    },
    {
        "id": "icd-9-cm-2001-tw",
        "name": "臺灣健保署ICD-9-CM 2001年版",
        "category": "diagnosis",
        "keywords": ["ICD-9", "舊版", "2001"],
    },
    # === 醫療機構/人員 (organization) ===
    {
        "id": "health-professional-tw",
        "name": "臺灣醫事司醫事人員類別",
        "category": "organization",
        "keywords": ["醫事人員", "醫師", "護理師", "藥師", "professional"],
    },
    {
        "id": "organization-identifier-tw",
        "name": "臺灣醫事司醫事機構代碼",
        "category": "organization",
        "keywords": ["醫事機構", "醫院代碼", "機構", "hospital"],
    },
    {
        "id": "medical-consultation-department-nhi-tw",
        "name": "臺灣健保署就醫科別",
        "category": "organization",
        "keywords": ["就醫科別", "門診科別", "掛號", "department"],
    },
    {
        "id": "medical-treatment-department-nhi-tw",
        "name": "臺灣健保署診療科別",
        "category": "organization",
        "keywords": ["診療科別", "治療科別", "specialty"],
    },
    {
        "id": "medical-service-payment-tw",
        "name": "臺灣健保署醫療服務給付項目",
        "category": "organization",
        "keywords": ["給付", "支付", "payment", "service"],
    },
    # === 行政/人口 (administrative) ===
    {
        "id": "postal-code3-tw",
        "name": "臺灣中華郵政3碼郵遞區號",
        "category": "administrative",
        "keywords": ["郵遞區號", "3碼", "postal"],
    },
    {
        "id": "postal-code5-tw",
        "name": "臺灣中華郵政5碼郵遞區號",
        "category": "administrative",
        "keywords": ["郵遞區號", "5碼", "postal"],
    },
    {
        "id": "postal-code6-tw",
        "name": "臺灣中華郵政6碼郵遞區號",
        "category": "administrative",
        "keywords": ["郵遞區號", "6碼", "postal"],
    },
    {
        "id": "marital-status-tw",
        "name": "臺灣戶政司婚姻狀態",
        "category": "administrative",
        "keywords": ["婚姻", "marital", "已婚", "未婚"],
    },
    {
        "id": "industry-dgbas-tw",
        "name": "行政院主計總處行業分類",
        "category": "administrative",
        "keywords": ["行業", "industry", "主計"],
    },
    {
        "id": "occupation-lia-roc-tw",
        "name": "臺灣壽險公會職業分類表",
        "category": "administrative",
        "keywords": ["職業", "壽險", "occupation"],
    },
    {
        "id": "occupation-mol-tw",
        "name": "臺灣勞動部職業標準分類",
        "category": "administrative",
        "keywords": ["職業", "勞動部", "occupation"],
    },
    # === 系統/技術 (technical) ===
    {
        "id": "careplan-category-tw",
        "name": "臺灣衛福部資訊處照護計畫類別",
        "category": "technical",
        "keywords": ["照護計畫", "careplan"],
    },
    {
        "id": "category-code-tw",
        "name": "臺灣衛福部資訊處類型代碼",
        "category": "technical",
        "keywords": ["類型代碼", "category"],
    },
    {
        "id": "provenance-participant-type-tw",
        "name": "臺灣衛福部資訊處Provenance參與類型",
        "category": "technical",
        "keywords": ["provenance", "參與類型"],
    },
    {
        "id": "v2-0203",
        "name": "臺灣衛福部資訊處識別碼類型",
        "category": "technical",
        "keywords": ["識別碼", "identifier", "v2-0203"],
    },
]

# 分類中文名稱對照
CATEGORY_NAMES = {
    "medication": "藥品相關",
    "diagnosis": "診斷分類",
    "organization": "醫療機構/人員",
    "administrative": "行政/人口統計",
    "technical": "系統/技術",
}

REQUEST_TIMEOUT = 15  # 秒


class TWCoreService:
    """
    TWCore 通用即時查詢服務

    透過 sitemap 導航到正確的 CodeSystem，即時抓取 FHIR JSON，
    本地快取作為離線備援。
    """

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.cache_dir = os.path.join(data_dir, "twcore_cache")
        os.makedirs(self.cache_dir, exist_ok=True)
        log_info(f"TWCore Service initialized (cache: {self.cache_dir})")

    # ==========================================
    # 資料取得：即時抓取 + 本地快取
    # ==========================================

    def _fetch_codesystem(self, cs_id: str) -> Optional[dict]:
        """從 TWCore IG 即時抓取 CodeSystem JSON"""
        urls = [
            f"{TWCORE_BASE_URL}/CodeSystem-{cs_id}.json",
            f"{TWCORE_BACKUP_URL}/CodeSystem-{cs_id}.json",
        ]
        for url in urls:
            try:
                log_info(f"Fetching TWCore CodeSystem: {url}")
                resp = requests.get(url, timeout=REQUEST_TIMEOUT)
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("resourceType") == "CodeSystem":
                        count = len(data.get("concept", []))
                        log_info(f"Fetched OK: {cs_id} ({count} concepts)")
                        self._save_cache(cs_id, data)
                        return data
                log_error(f"HTTP {resp.status_code} from {url}")
            except requests.exceptions.Timeout:
                log_error(f"Timeout fetching {url}")
            except Exception as e:
                log_error(f"Error fetching {url}: {e}")
        return None

    def _load_cache(self, cs_id: str) -> Optional[dict]:
        """載入本地快取"""
        path = os.path.join(self.cache_dir, f"{cs_id}.json")
        if not os.path.exists(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("resourceType") == "CodeSystem":
                log_info(f"Loaded cache: {cs_id}")
                return data
        except Exception as e:
            log_error(f"Failed to load cache {cs_id}: {e}")
        return None

    def _save_cache(self, cs_id: str, data: dict):
        """寫入本地快取"""
        try:
            path = os.path.join(self.cache_dir, f"{cs_id}.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            log_info(f"Cached: {cs_id}")
        except Exception as e:
            log_error(f"Failed to cache {cs_id}: {e}")

    def _get_codesystem(self, cs_id: str) -> Tuple[Optional[dict], str]:
        """取得 CodeSystem（即時抓取優先，快取備援）"""
        data = self._fetch_codesystem(cs_id)
        if data:
            return data, "live"

        log_info(f"Live fetch failed for {cs_id}, falling back to cache...")
        data = self._load_cache(cs_id)
        if data:
            return data, "cache"

        return None, "unavailable"

    # ==========================================
    # 內部工具：解析 concept
    # ==========================================

    @staticmethod
    def _parse_concepts(codesystem: dict) -> List[dict]:
        """解析 FHIR CodeSystem 中的 concept 列表"""
        results = []
        for concept in codesystem.get("concept", []):
            code = concept.get("code", "")
            display = concept.get("display", "")
            props = {}
            for prop in concept.get("property", []):
                props[prop.get("code", "")] = (
                    prop.get("valueString")
                    or prop.get("valueCode")
                    or prop.get("valueDateTime")
                    or prop.get("valueBoolean")
                    or ""
                )
            results.append({
                "code": code,
                "display": display,
                "properties": props,
            })
        return results

    def _find_registry_entry(self, cs_id: str) -> Optional[Dict]:
        """從 registry 找到 CodeSystem 資訊"""
        for entry in CODESYSTEM_REGISTRY:
            if entry["id"] == cs_id:
                return entry
        return None

    # ==========================================
    # 公開方法：MCP Tool 使用
    # ==========================================

    def list_codesystems(self, category: str = "all") -> str:
        """
        列出所有可用的 TWCore CodeSystem（sitemap）

        Args:
            category: 篩選分類 (all/medication/diagnosis/organization/administrative/technical)
        """
        groups = {}
        for entry in CODESYSTEM_REGISTRY:
            if category != "all" and entry["category"] != category:
                continue
            cat = CATEGORY_NAMES.get(entry["category"], entry["category"])
            groups.setdefault(cat, []).append({
                "id": entry["id"],
                "name": entry["name"],
                "json_url": f"{TWCORE_BASE_URL}/CodeSystem-{entry['id']}.json",
            })

        return json.dumps({
            "status": "success",
            "total": sum(len(v) for v in groups.values()),
            "base_url": TWCORE_BASE_URL,
            "categories": groups,
        }, ensure_ascii=False, indent=2)

    def search_codesystem(self, keyword: str, codesystem_ids: List[str], limit: int = 30) -> str:
        """
        在指定的 CodeSystem(s) 中搜尋代碼

        Args:
            keyword: 搜尋關鍵字（代碼或中文說明）
            codesystem_ids: 要搜尋的 CodeSystem ID 列表
            limit: 最大回傳筆數
        """
        all_results = []
        sources = {}

        for cs_id in codesystem_ids:
            codesystem, source = self._get_codesystem(cs_id)
            if not codesystem:
                sources[cs_id] = "unavailable"
                continue

            sources[cs_id] = source
            concepts = self._parse_concepts(codesystem)
            entry = self._find_registry_entry(cs_id)
            cs_name = entry["name"] if entry else cs_id

            keyword_upper = keyword.upper()
            keyword_lower = keyword.lower()

            for c in concepts:
                if (keyword_upper in c["code"].upper()
                        or keyword in c["display"]
                        or keyword_lower in c["display"].lower()):
                    all_results.append({
                        "codesystem_id": cs_id,
                        "codesystem_name": cs_name,
                        "code": c["code"],
                        "display": c["display"],
                        "system": codesystem.get("url", ""),
                    })

                if len(all_results) >= limit:
                    break

            if len(all_results) >= limit:
                break

        if not all_results:
            return json.dumps({
                "status": "not_found",
                "message": f"在指定的 CodeSystem 中找不到符合 '{keyword}' 的代碼",
                "searched_codesystems": list(sources.keys()),
                "data_sources": sources,
            }, ensure_ascii=False, indent=2)

        return json.dumps({
            "status": "success",
            "count": len(all_results),
            "query": keyword,
            "data_sources": sources,
            "results": all_results,
        }, ensure_ascii=False, indent=2)

    def lookup_code(self, code: str, codesystem_id: str) -> str:
        """
        精確查詢單一代碼

        Args:
            code: 代碼（大小寫不敏感）
            codesystem_id: CodeSystem ID
        """
        codesystem, source = self._get_codesystem(codesystem_id)
        if not codesystem:
            return json.dumps({
                "status": "error",
                "message": f"無法取得 CodeSystem: {codesystem_id}",
            }, ensure_ascii=False, indent=2)

        concepts = self._parse_concepts(codesystem)
        entry = self._find_registry_entry(codesystem_id)
        version = codesystem.get("version", "unknown")

        # 精確比對 → 不區分大小寫比對
        found = None
        for c in concepts:
            if c["code"] == code:
                found = c
                break
        if not found:
            code_upper = code.upper()
            for c in concepts:
                if c["code"].upper() == code_upper:
                    found = c
                    break

        if not found:
            return json.dumps({
                "status": "not_found",
                "message": f"在 {entry['name'] if entry else codesystem_id} 中找不到代碼: {code}",
                "data_source": source,
            }, ensure_ascii=False, indent=2)

        return json.dumps({
            "status": "success",
            "codesystem_id": codesystem_id,
            "codesystem_name": entry["name"] if entry else codesystem_id,
            "code": found["code"],
            "display": found["display"],
            "properties": found["properties"],
            "version": version,
            "data_source": source,
            "fhir_coding": {
                "system": codesystem.get("url", ""),
                "version": version,
                "code": found["code"],
                "display": found["display"],
            },
        }, ensure_ascii=False, indent=2)

    # ==========================================
    # 分類捷徑：依分類搜尋
    # ==========================================

    def _get_ids_by_category(self, category: str) -> List[str]:
        """取得某分類下所有 CodeSystem ID"""
        return [e["id"] for e in CODESYSTEM_REGISTRY if e["category"] == category]

    def search_medication(self, keyword: str) -> str:
        """搜尋藥品相關 CodeSystem（頻率、途徑、品項、中藥、ATC）"""
        return self.search_codesystem(keyword, self._get_ids_by_category("medication"))

    def search_diagnosis(self, keyword: str) -> str:
        """搜尋診斷分類 CodeSystem（ICD-10-CM/PCS、ICD-9）"""
        return self.search_codesystem(keyword, self._get_ids_by_category("diagnosis"))

    def search_organization(self, keyword: str) -> str:
        """搜尋醫療機構/人員 CodeSystem（科別、機構、人員、給付）"""
        return self.search_codesystem(keyword, self._get_ids_by_category("organization"))

    def search_administrative(self, keyword: str) -> str:
        """搜尋行政/人口 CodeSystem（郵遞區號、婚姻、職業、行業）"""
        return self.search_codesystem(keyword, self._get_ids_by_category("administrative"))

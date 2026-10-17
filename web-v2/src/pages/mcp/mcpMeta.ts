import {
  IconActivity,
  IconBooks,
  IconBuildingHospital,
  IconCalculator,
  IconClipboardHeart,
  IconDna2,
  IconFlask,
  IconPill,
  IconPrescription,
  IconSalad,
  IconShieldCheck,
  IconStethoscope,
  type Icon,
} from "@tabler/icons-react";
import { fmtNumber } from "@/lib/format";
import { moduleHref } from "@/lib/meta";
import type { CatalogTool, ToolGate } from "./mcpTypes";

export interface GroupMeta {
  label: string;
  description: string;
  icon: Icon;
  color: string;
}

export const GROUP_META: Record<string, GroupMeta> = {
  icd: { label: "ICD-10", description: "ICD-10-CM / PCS 診斷與處置碼", icon: IconStethoscope, color: "blue" },
  drug: { label: "藥品 / TFDA", description: "食藥署藥品許可證、外觀與資產", icon: IconPill, color: "grape" },
  lab: { label: "檢驗 / LOINC", description: "LOINC 代碼與參考值判讀", icon: IconFlask, color: "cyan" },
  snomed: { label: "SNOMED CT", description: "概念、階層、屬性關係與 ICD 對應", icon: IconDna2, color: "violet" },
  fhir_condition: { label: "FHIR Condition", description: "由 ICD 產生與驗證 Condition", icon: IconClipboardHeart, color: "red" },
  fhir_medication: { label: "FHIR Medication", description: "由 TFDA 藥品產生與驗證 Medication", icon: IconPrescription, color: "pink" },
  fhir_ig: { label: "FHIR IG", description: "IG 構件、術語、驗證、撰寫與落地檢查", icon: IconBooks, color: "indigo" },
  health_supplements: { label: "健康食品", description: "食藥署認證健康食品", icon: IconShieldCheck, color: "lime" },
  food_nutrition: { label: "食品營養", description: "食品營養成分資料庫", icon: IconSalad, color: "green" },
  fhir_servers: { label: "FHIR 伺服器", description: "外部 FHIR 伺服器查詢與受控操作", icon: IconBuildingHospital, color: "orange" },
  calculators: { label: "臨床計算", description: "臨床評分公式（決策輔助）", icon: IconCalculator, color: "amber" },
  system: { label: "系統", description: "伺服器健康檢查", icon: IconActivity, color: "gray" },
};

export function groupMeta(key: string): GroupMeta {
  return GROUP_META[key] ?? { label: key, description: "", icon: IconActivity, color: "gray" };
}

/** ModuleStatus key → admin module page key (the console calls LOINC "loinc", the backend "lab"). */
const MODULE_PAGE: Record<string, string> = {
  icd: "icd",
  lab: "loinc",
  snomed: "snomed",
  drug: "drug",
  ig: "ig",
  health_supplements: "health_supplements",
  food_nutrition: "food_nutrition",
};

export function gateModulePage(gate: ToolGate | null): string | null {
  if (!gate) return null;
  const key = MODULE_PAGE[gate.derived_from ?? gate.module];
  return key ? moduleHref(key) : null;
}

const MODULE_LABEL: Record<string, string> = {
  icd: "ICD-10",
  lab: "LOINC",
  snomed: "SNOMED CT",
  drug: "藥品",
  ig: "FHIR IG",
  health_supplements: "健康食品",
  food_nutrition: "食品營養",
  fhir_condition: "FHIR Condition",
  fhir_medication: "FHIR Medication",
};

export function moduleName(key: string): string {
  return MODULE_LABEL[key] ?? key;
}

export interface StatusView {
  label: string;
  color: string;
  /** One sentence explaining the state. */
  explain: string;
}

/** Human explanation of a tool's enabled / disabled state. */
export function toolStatusView(t: Pick<CatalogTool, "enabled" | "reason" | "gate">): StatusView {
  const g = t.gate;
  const dataModule = g ? moduleName(g.derived_from ?? g.module) : "";
  switch (t.reason) {
    case "always_on":
      return { label: "常駐", color: "teal", explain: "不依賴匯入資料，伺服器啟動即提供。" };
    case "module_ready":
      return {
        label: "已啟用",
        color: "teal",
        explain: g?.table
          ? `${dataModule}資料已就緒：${g.table} 目前 ${fmtNumber(g.count ?? 0)} 筆（門檻 ${fmtNumber(g.minimum ?? 0)}）${g.derived_from ? `，由 ${dataModule} 模組衍生` : ""}。`
          : "模組資料已就緒。",
      };
    case "module_data_missing":
      return {
        label: "資料不足",
        color: "amber",
        explain: `${dataModule}資料未達門檻：${g?.table ?? ""} 目前 ${fmtNumber(g?.count ?? 0)} 筆（需 ≥ ${fmtNumber(g?.minimum ?? 0)} 筆）。匯入資料後自動啟用。`,
      };
    case "module_check_failed":
      return { label: "無法檢查", color: "red", explain: `無法讀取 ${g?.table ?? "模組資料表"}：${g?.error ?? "查詢失敗"}。` };
    case "service_unavailable":
    default:
      return { label: "服務未啟動", color: "red", explain: "資料已就緒但服務初始化失敗，請查看 app 容器日誌。" };
  }
}

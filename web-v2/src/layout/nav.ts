import {
  IconActivity,
  IconApi,
  IconBox,
  IconBooks,
  IconBrain,
  IconBuildingHospital,
  IconCloudComputing,
  IconDatabaseCog,
  IconDna2,
  IconFlask,
  IconHeartbeat,
  IconLayoutDashboard,
  IconListCheck,
  IconLock,
  IconPill,
  IconPlugConnected,
  IconSalad,
  IconServer2,
  IconShieldCheck,
  IconStethoscope,
  type Icon,
} from "@tabler/icons-react";
import { moduleHref, TERMINOLOGY_MODULES } from "@/lib/meta";

export interface NavItem {
  label: string;
  to: string;
  icon: Icon;
  /** Module key — the nav shows its data status dot. */
  moduleKey?: string;
  /** Several modules — the dot aggregates them. */
  moduleKeys?: string[];
  description?: string;
  keywords?: string[];
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    label: "總覽",
    items: [
      { label: "儀表板", to: "/", icon: IconLayoutDashboard, description: "系統狀態一覽", keywords: ["dashboard", "overview"] },
      { label: "背景工作", to: "/jobs", icon: IconListCheck, description: "匯入、嵌入、同步工作與日誌", keywords: ["jobs", "tasks", "queue"] },
    ],
  },
  {
    label: "資料",
    items: [
      {
        label: "醫療術語",
        to: "/terminology",
        icon: IconBooks,
        moduleKeys: TERMINOLOGY_MODULES.map((m) => m.key),
        description: "ICD-10、LOINC、SNOMED CT、RxNorm 等標準術語",
        keywords: ["terminology", "術語", "code system"],
      },
      { label: "藥品", to: "/drug", icon: IconPill, moduleKey: "drug", keywords: ["drug", "tfda", "藥"] },
      { label: "健康食品", to: "/data/health_supplements", icon: IconShieldCheck, moduleKey: "health_supplements", keywords: ["supplement"] },
      { label: "食品營養", to: "/data/food_nutrition", icon: IconSalad, moduleKey: "food_nutrition", keywords: ["food", "nutrition"] },
    ],
  },
  {
    label: "FHIR",
    items: [
      { label: "IG 套件庫", to: "/fhir/ig", icon: IconHeartbeat, moduleKey: "ig", description: "FHIR Implementation Guide 套件", keywords: ["fhir", "ig", "twcore", "package"] },
      { label: "FHIR 伺服器", to: "/fhir-servers", icon: IconBuildingHospital, description: "外部 FHIR R4 伺服器", keywords: ["fhir", "server", "oauth"] },
    ],
  },
  {
    label: "整合",
    items: [
      { label: "模型端點", to: "/models", icon: IconBrain, description: "Embedding 與分析 LLM", keywords: ["llm", "embedding", "model", "profile"] },
      { label: "MCP 工具", to: "/mcp", icon: IconApi, description: "MCP 端點、工具目錄與線上測試", keywords: ["mcp", "tools", "openapi", "playground", "工具", "測試"] },
      { label: "外部服務", to: "/integrations", icon: IconPlugConnected, description: "OCR、物件儲存、TFDA、Worker 設定", keywords: ["ocr", "minio", "settings"] },
    ],
  },
  {
    label: "系統",
    items: [
      { label: "服務健康", to: "/health", icon: IconActivity, description: "基礎設施探測與 Worker", keywords: ["health", "probe", "worker"] },
      { label: "備份與設定", to: "/system", icon: IconDatabaseCog, description: "系統備份、設定匯出匯入", keywords: ["backup", "export", "import"] },
      { label: "帳號安全", to: "/security", icon: IconLock, description: "密碼與通行金鑰", keywords: ["password", "passkey", "security"] },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV.flatMap((s) => s.items);

const TERMINOLOGY_ICONS: Record<string, Icon> = { icd: IconStethoscope, loinc: IconFlask, snomed: IconDna2, rxnorm: IconBox };

// Not in the sidebar, but searchable.
export const EXTRA_SEARCH: NavItem[] = [
  ...TERMINOLOGY_MODULES.map((m) => ({
    label: m.shortLabel,
    to: moduleHref(m.key),
    icon: TERMINOLOGY_ICONS[m.key] ?? IconBooks,
    description: `醫療術語 · ${m.label}`,
    keywords: [m.key, m.label],
  })),
  { label: "藥品瀏覽器", to: "/drug/explorer", icon: IconPill, description: "搜尋藥品、仿單、外觀與 LLM 分析", keywords: ["explorer"] },
  { label: "新增 FHIR 伺服器", to: "/fhir-servers/new", icon: IconServer2, keywords: ["add"] },
  { label: "OCR 測試", to: "/integrations?tab=ocr", icon: IconCloudComputing, keywords: ["ocr", "mineru"] },
];

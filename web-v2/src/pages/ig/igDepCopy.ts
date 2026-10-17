// zh-TW copy for missing-dependency states and registry failures.
import type { MissingDepStatus, RegistryFailureKind } from "./igTypes";

export const DEP_STATUS: Record<MissingDepStatus, { label: string; color: string }> = {
  missing: { label: "未安裝", color: "amber" },
  queued: { label: "排隊中", color: "blue" },
  downloading: { label: "下載中", color: "blue" },
  failed: { label: "下載失敗", color: "red" },
};

/** What went wrong + the next step, per failure kind. */
export const FAILURE_COPY: Record<RegistryFailureKind, { title: string; next: string; preferUpload: boolean }> = {
  not_found: {
    title: "Registry 找不到這個版本",
    next: "packages.fhir.org 與 packages2.fhir.org 都沒有提供。請從該 IG 的發布網站下載 package.tgz，改用「上傳 .tgz」。",
    preferUpload: true,
  },
  network: {
    title: "無法連線到 Registry",
    next: "可能是逾時或伺服器無法連外。稍後再按「從 Registry 下載」重試；若環境無法連外，請改用「上傳 .tgz」。",
    preferUpload: false,
  },
  checksum: {
    title: "下載內容校驗不符（SHA-1）",
    next: "檔案可能在傳輸中損毀或被代理伺服器改寫。請稍後重試，或從可信來源取得 package.tgz 後上傳。",
    preferUpload: false,
  },
  invalid_package: {
    title: "下載到的不是有效的 FHIR 套件",
    next: "Registry 回傳的內容不是 gzip 壓縮的套件。請改用「上傳 .tgz」。",
    preferUpload: true,
  },
  unknown: {
    title: "下載或匯入失敗",
    next: "請打開工作詳情查看完整紀錄；可再試一次，或改用「上傳 .tgz」。",
    preferUpload: false,
  },
};

/** Map a job's `last_error_code` (`ig_dependency_<kind>`) to a failure kind. */
export function failureKindFromCode(code: string | null | undefined): RegistryFailureKind {
  const m = /^ig_dependency_(.+)$/.exec(String(code ?? ""));
  const k = m?.[1] as RegistryFailureKind | undefined;
  return k && k in FAILURE_COPY ? k : "unknown";
}

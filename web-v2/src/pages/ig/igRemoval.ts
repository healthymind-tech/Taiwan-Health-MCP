import { ApiError, errorMessage } from "@/lib/api";
import type { IgInstallOrigin, IgInstalledFor, IgRef } from "./igTypes";

// Shapes of the IG removal endpoints (node-server/src/admin/igRemoval.ts +
// adminIg.ts removalImpact / listUnusedDependencies).

export type IgRemovalCode =
  | "IG_NOT_FOUND"
  | "IG_HAS_DEPENDENTS"
  | "IG_IS_DEFAULT"
  | "IG_INVALID_NEW_DEFAULT"
  | "IG_DEPENDENCY_IN_USE"
  | "IG_NO_TARGETS";

export interface IgTitledRef extends IgRef {
  title: string;
}

export interface IgDependent extends IgTitledRef {
  direct: boolean;
  via: IgRef;
  is_default: boolean;
  install_origin: IgInstallOrigin | null;
}

export interface IgRemovalImpact {
  target: IgTitledRef & {
    is_default: boolean;
    install_origin: IgInstallOrigin | null;
    counts: { artifacts: number; codesystems: number; concepts: number };
  };
  allowed: boolean;
  blockers: IgRemovalCode[];
  dependents: IgDependent[];
  removes_default: boolean;
  default_candidates: IgTitledRef[];
  /** Dependency installs that become unused once this IG is gone. */
  orphaned: IgTitledRef[];
}

export interface IgRemovalResult {
  removed: boolean;
  packages?: IgTitledRef[];
  forced?: boolean;
  dependents?: IgDependent[];
  new_default?: IgRef | null;
}

export interface IgUnusedDependency extends IgTitledRef {
  needed_only_by: IgRef[];
  installed_for: IgInstalledFor | null;
  counts: { artifacts: number; concepts: number };
}

export const igRemovalKeys = {
  // Under "igs" so every IG invalidation (job finished, module_changed) refreshes them too.
  impact: (r: IgRef | null) => ["igs", "~removal-impact", r?.package_id ?? "", r?.version ?? ""] as const,
  unused: ["igs", "~unused-dependencies"] as const,
};

export const refLabel = (r: IgRef): string => `${r.package_id}@${r.version}`;
export const titledLabel = (r: IgTitledRef): string => (r.title && r.title !== r.package_id ? `${r.title}（${refLabel(r)}）` : refLabel(r));

const CODE_TEXT: Record<IgRemovalCode, string> = {
  IG_NOT_FOUND: "找不到此 IG，可能已被移除。",
  IG_HAS_DEPENDENTS: "有其他已安裝的 IG 依賴此套件，已拒絕移除。若確定要移除，請使用「強制刪除」。",
  IG_IS_DEFAULT: "這是目前的預設 IG，已拒絕移除。請先選擇新的預設 IG，或使用「強制刪除」。",
  IG_INVALID_NEW_DEFAULT: "指定的新預設 IG 無效：必須是已安裝、且不在這次移除範圍內的 IG。",
  IG_DEPENDENCY_IN_USE: "部分套件已不再是「未使用的相依」（可能剛被其他 IG 使用），已全部取消。請重新整理清單後再試。",
  IG_NO_TARGETS: "沒有要移除的套件。",
};

/** Stable error code of an IG removal response, if any. */
export function removalCode(err: unknown): IgRemovalCode | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body as { code?: unknown } | undefined;
  const code = typeof body?.code === "string" ? body.code : null;
  return code && code in CODE_TEXT ? (code as IgRemovalCode) : null;
}

/** zh-TW message for an IG removal failure (falls back to the server text). */
export function removalErrorText(err: unknown): string {
  const code = removalCode(err);
  if (!code) return errorMessage(err);
  const body = (err as ApiError).body as { dependents?: IgRef[] } | undefined;
  const deps = code === "IG_HAS_DEPENDENTS" && Array.isArray(body?.dependents) ? body!.dependents : [];
  return deps.length ? `${CODE_TEXT[code]}（${deps.slice(0, 5).map(refLabel).join("、")}${deps.length > 5 ? ` 等 ${deps.length} 個` : ""}）` : CODE_TEXT[code];
}

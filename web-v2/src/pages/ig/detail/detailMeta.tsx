import { Anchor, Badge, Text, Tooltip } from "@mantine/core";
import {
  IconApi,
  IconBinaryTree2,
  IconBook2,
  IconBraces,
  IconFileCode,
  IconLanguage,
  IconPuzzle,
  IconSearch,
  IconStack2,
} from "@tabler/icons-react";
import { useRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, useSearchParams } from "react-router";
import type { IgRef } from "../igTypes";
import { profileHref } from "../profile/links";
import type { Category, ResolvedRef } from "./explorerApi";
import classes from "./detail.module.css";

export interface CategoryMeta {
  key: Category;
  label: string;
  short: string;
  hint: string;
  icon: (size: number) => ReactNode;
  /** CSS variable of the categorical slot (detail.module.css). */
  color: string;
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  profile: { key: "profile", label: "Profiles", short: "Profile", hint: "限縮 FHIR 資源的結構定義，依基底資源分組", icon: (s) => <IconStack2 size={s} />, color: "var(--cat-profile)" },
  extension: { key: "extension", label: "Extensions", short: "Extension", hint: "擴充欄位：可使用的位置與值型別", icon: (s) => <IconPuzzle size={s} />, color: "var(--cat-extension)" },
  datatype: { key: "datatype", label: "資料型別 Profiles", short: "Datatype", hint: "限縮 Address、Coding 等資料型別", icon: (s) => <IconBraces size={s} />, color: "var(--cat-datatype)" },
  logical: { key: "logical", label: "邏輯模型", short: "Logical", hint: "Logical Model：概念資料模型，不是可交換的資源", icon: (s) => <IconBinaryTree2 size={s} />, color: "var(--cat-logical)" },
  terminology: { key: "terminology", label: "術語", short: "Terminology", hint: "ValueSet、CodeSystem、ConceptMap", icon: (s) => <IconLanguage size={s} />, color: "var(--cat-terminology)" },
  search: { key: "search", label: "SearchParameter", short: "Search", hint: "查詢參數，依基底資源分組", icon: (s) => <IconSearch size={s} />, color: "var(--cat-search)" },
  capability: { key: "capability", label: "能力與操作", short: "Capability", hint: "CapabilityStatement、OperationDefinition、ImplementationGuide…", icon: (s) => <IconApi size={s} />, color: "var(--cat-capability)" },
  example: { key: "example", label: "範例實例", short: "Example", hint: "範例資源，依資源類型分組，並標示宣告的 Profile", icon: (s) => <IconFileCode size={s} />, color: "var(--cat-example)" },
  base: { key: "base", label: "基礎定義", short: "Base", hint: "FHIR 規格本身的資源與資料型別定義（specialization）", icon: (s) => <IconBook2 size={s} />, color: "var(--cat-base)" },
};

export const CATEGORY_ORDER: Category[] = ["profile", "extension", "datatype", "logical", "terminology", "search", "capability", "example", "base"];

export const isCategory = (v: string | null): v is Category => v !== null && (CATEGORY_ORDER as string[]).includes(v);

/** URL params of the detail page (gallery params stay untouched). */
export const DP = {
  ig: "open",
  tab: "itab",
  cat: "cat",
  group: "grp",
  q: "aq",
  artifact: "art",
  cs: "cs",
  csView: "csv",
  csQ: "csq",
} as const;

export const DETAIL_KEYS = Object.values(DP);

export function parseIgParam(v: string | null): IgRef | null {
  if (!v) return null;
  const at = v.lastIndexOf("@");
  if (at <= 0 || at === v.length - 1) return null;
  return { package_id: v.slice(0, at), version: v.slice(at + 1) };
}

export const igParam = (r: IgRef): string => `${r.package_id}@${r.version}`;

/** Read/patch detail URL params. Discrete navigation pushes history; typing replaces. */
export function useDetailParams() {
  const [sp, setSp] = useSearchParams();
  const ref = useRef(sp);
  ref.current = sp;
  const patch = (p: Record<string, string | null>, opts: { replace?: boolean } = {}) => {
    const next = new URLSearchParams(ref.current);
    for (const [k, v] of Object.entries(p)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (next.toString() !== ref.current.toString()) setSp(next, { replace: opts.replace ?? false });
  };
  return { sp, get: (k: string) => sp.get(k), patch };
}

export function Markdown({ children, clamp }: { children: string; clamp?: boolean }) {
  return (
    <div className={classes.prose} style={clamp ? { maxHeight: 220, overflow: "auto" } : undefined}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {c}
            </a>
          ),
          img: () => null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const tail = (url: string): string => url.split("|")[0].replace(/\/+$/, "").split("/").pop() || url;

/** A canonical shown by name: profile page for StructureDefinitions, artifact drawer for same-IG resources. */
export function CanonicalRef({
  url,
  resolved,
  onOpenArtifact,
  fz = "xs",
}: {
  url: string;
  resolved?: ResolvedRef;
  onOpenArtifact?: (key: string) => void;
  fz?: string;
}) {
  const label = resolved?.title || tail(url);
  if (resolved?.resource_type === "StructureDefinition") {
    return (
      <Tooltip label={`${url}\n${resolved.package_id}@${resolved.version}`} multiline maw={460} style={{ whiteSpace: "pre-line", wordBreak: "break-all" }} openDelay={300}>
        <Anchor component={Link} to={profileHref(resolved.package_id, resolved.version, resolved.artifact_id)} fz={fz} style={{ wordBreak: "break-word" }}>
          {label}
        </Anchor>
      </Tooltip>
    );
  }
  if (resolved?.same_package && onOpenArtifact) {
    return (
      <Tooltip label={url} multiline maw={460} style={{ wordBreak: "break-all" }} openDelay={300}>
        <Anchor component="button" type="button" fz={fz} onClick={() => onOpenArtifact(resolved.artifact_key)} style={{ wordBreak: "break-word", textAlign: "left" }}>
          {label}
        </Anchor>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={resolved ? `${url}\n${resolved.package_id}@${resolved.version}` : `${url}\n（未在已安裝的 IG 中找到）`} multiline maw={460} style={{ whiteSpace: "pre-line", wordBreak: "break-all" }} openDelay={300}>
      <Text span fz={fz} ff="monospace" c={resolved ? undefined : "dimmed"} style={{ wordBreak: "break-all" }}>
        {label}
      </Text>
    </Tooltip>
  );
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const color = status === "active" ? "teal" : status === "draft" ? "amber" : status === "retired" ? "red" : "gray";
  return (
    <Badge size="xs" variant="light" color={color}>
      {status}
    </Badge>
  );
}

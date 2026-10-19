import { ActionIcon, Anchor, Badge, CopyButton, ScrollArea, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { Fragment, memo, useMemo, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { profileHref } from "./links";
import type { ElementType, LinkTarget } from "./profileTypes";
import { bare } from "./treeModel";
import classes from "./profile.module.css";

const TOKEN = /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Syntax-highlighted JSON (no dependencies). Large values are still one <pre>; keep inputs to tool-sized payloads. */
export const JsonCode = memo(function JsonCode({ value, maxHeight = 520, copy = true }: { value: unknown; maxHeight?: number | null; copy?: boolean }) {
  const text = useMemo(() => {
    try {
      return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  const parts = useMemo(() => {
    const out: ReactNode[] = [];
    let last = 0;
    let k = 0;
    for (const m of text.matchAll(TOKEN)) {
      const at = m.index ?? 0;
      if (at > last) out.push(text.slice(last, at));
      if (m[1] !== undefined) {
        out.push(
          <span key={k++} className={m[2] ? classes.jKey : classes.jStr}>
            {m[1]}
          </span>,
        );
        if (m[2]) out.push(m[2]);
      } else if (m[3] !== undefined) {
        out.push(
          <span key={k++} className={classes.jLit}>
            {m[3]}
          </span>,
        );
      } else {
        out.push(
          <span key={k++} className={classes.jNum}>
            {m[4]}
          </span>,
        );
      }
      last = at + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }, [text]);
  const body = <pre className={classes.code}>{parts}</pre>;
  return (
    <div className={classes.codeBox}>
      {copy && (
        <CopyButton value={text} timeout={1500}>
          {({ copied, copy: doCopy }) => (
            <Tooltip label={copied ? "已複製" : "複製 JSON"}>
              <ActionIcon className={classes.codeCopy} variant="filled" color={copied ? "teal" : "dark"} onClick={doCopy} aria-label="複製 JSON">
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      )}
      {maxHeight === null ? (
        <ScrollArea type="auto" scrollbars="x">
          {body}
        </ScrollArea>
      ) : (
        <ScrollArea.Autosize mah={maxHeight} type="auto">
          {body}
        </ScrollArea.Autosize>
      )}
    </div>
  );
});

/** FHIR markdown (definitions, comments). */
export function Prose({ children }: { children: string }) {
  return (
    <div className={classes.prose}>
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children: c }) => <a href={href} target="_blank" rel="noreferrer noopener">{c}</a> }}>
        {children}
      </Markdown>
    </div>
  );
}

/** A canonical, linked to its profile page when it is an installed StructureDefinition. */
export function CanonicalLink({ url, links, fallback, fz = "xs" }: { url: string; links: Record<string, LinkTarget>; fallback?: string; fz?: string }) {
  const t = links[bare(url)];
  const label = t?.title || fallback || url.split("/").pop() || url;
  if (t && t.resource_type === "StructureDefinition") {
    return (
      <Tooltip label={url} multiline maw={420} openDelay={400}>
        <Anchor component={Link} to={profileHref(t.package_id, t.version, t.artifact_id)} fz={fz} onClick={(e) => e.stopPropagation()}>
          {label}
        </Anchor>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={t ? `${url}（${t.package_id}@${t.version}）` : `${url}（未安裝）`} multiline maw={420} openDelay={400}>
      <span style={{ fontSize: "inherit" }}>{label}</span>
    </Tooltip>
  );
}

/** Type cell: `Reference(Patient | Organization)`, `Extension(Person Age)`, plain codes. */
export function TypeList({ types, links, inline = true }: { types: ElementType[]; links: Record<string, LinkTarget>; inline?: boolean }) {
  if (!types.length) return null;
  return (
    <>
      {types.map((t, i) => {
        const profs = t.profile ?? [];
        const targets = t.targetProfile ?? [];
        const coreLink = /^[A-Z]/.test(t.code) && !profs.length ? links[`http://hl7.org/fhir/StructureDefinition/${t.code}`] : undefined;
        const codeNode = coreLink ? (
          <Anchor component={Link} to={profileHref(coreLink.package_id, coreLink.version, coreLink.artifact_id)} fz="inherit" c="inherit" underline="hover" onClick={(e) => e.stopPropagation()}>
            {t.code}
          </Anchor>
        ) : t.code.includes("/") ? (
          t.code.slice(t.code.lastIndexOf("/") + 1)
        ) : (
          t.code
        );
        const sub = [...profs, ...targets];
        return (
          <Fragment key={`${t.code}-${i}`}>
            {i > 0 && (inline ? " | " : <br />)}
            {codeNode}
            {sub.length > 0 && (
              <>
                {"("}
                {sub.map((u, j) => (
                  <Fragment key={u}>
                    {j > 0 && " | "}
                    <CanonicalLink url={u} links={links} fz="inherit" />
                  </Fragment>
                ))}
                {")"}
              </>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

export const GROUNDING: Record<string, { label: string; color: string; tip: string }> = {
  auto: { label: "自動帶入", color: "teal", tip: "由 Profile 固定（fixed / pattern），照抄即可" },
  coding: { label: "編碼對應", color: "indigo", tip: "把紀錄文字對應成代碼（見 allowedCodes / binding）" },
  source_fact: { label: "來源事實", color: "red", tip: "必須來自原始紀錄，不可編造" },
  workflow_default: { label: "流程預設", color: "amber", tip: "通常用預設值，除非紀錄另有說明" },
  structural: { label: "結構", color: "gray", tip: "參照、識別碼等結構性欄位" },
  site: { label: "機構命名空間", color: "cyan", tip: "機構自己的識別碼系統（namespace）" },
  derived: { label: "可推導", color: "grape", tip: "可由其他欄位計算得出" },
  container: { label: "容器", color: "gray", tip: "包住下列子欄位的物件／陣列" },
};

export function GroundingBadge({ cls }: { cls: string }) {
  const g = GROUNDING[cls] ?? { label: cls, color: "gray", tip: cls };
  return (
    <Tooltip label={`${cls}：${g.tip}`} multiline maw={300}>
      <Badge size="sm" variant="light" color={g.color} style={{ flexShrink: 0 }}>
        {g.label}
      </Badge>
    </Tooltip>
  );
}

/** zh label for a required_by reason (absent = profile: min ≥ 1 with every ancestor required). */
export function requiredReason(by: string | undefined): { label: string; color: string; tip: string } {
  if (!by || by === "profile") return { label: "min ≥ 1", color: "red", tip: "Profile 規定至少 1 個（且上層都必填）" };
  if (by.startsWith("slice:")) return { label: `切片 ${by.slice(6)}`, color: "violet", tip: "必填切片：必須有一筆符合這個切片" };
  if (by.startsWith("invariant:")) return { label: `規則 ${by.slice(10)}`, color: "grape", tip: "由約束規則（FHIRPath invariant）推得必填" };
  if (by.startsWith("extension:")) return { label: "擴充定義", color: "cyan", tip: by };
  if (by.startsWith("datatype:")) return { label: `型別 ${by.slice(9)}`, color: "blue", tip: "資料型別本身要求" };
  if (by.startsWith("target-implied")) return { label: "語意必要", color: "amber", tip: "Profile 未強制，但缺了這筆資料就沒有意義（target-implied）" };
  if (by.startsWith("mustSupport")) return { label: "Must Support", color: "orange", tip: "mustSupport 但非必填" };
  return { label: by, color: "gray", tip: by };
}

import { Anchor, Badge, Box, Button, CloseButton, Group, Pagination, SegmentedControl, Select, SimpleGrid, Skeleton, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { IconArrowLeft, IconBinaryTree, IconLanguage, IconList, IconListTree, IconPuzzle, IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { CopyText } from "@/components/CopyText";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { SectionCard } from "@/components/SectionCard";
import { fmtNumber } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { IgCodeSystemTree } from "@/pages/terminology/explorer/IgCodeSystemTree";
import type { IgRef } from "../igTypes";
import { useCsConcepts, useIgCodeSystems, type CodeSystemInfo, type Designation } from "./explorerApi";
import { DP, StatusBadge, useDetailParams } from "./detailMeta";
import classes from "./detail.module.css";

const CONTENT_COLOR: Record<string, string> = { complete: "teal", fragment: "orange", "not-present": "gray", example: "yellow", supplement: "violet" };
const SORTS = [
  { value: "name", label: "依名稱" },
  { value: "count", label: "依概念數" },
  { value: "used", label: "依使用的 ValueSet 數" },
];

function ContentBadge({ c }: { c: string | null }) {
  return (
    <Badge size="sm" variant="light" color={c ? (CONTENT_COLOR[c] ?? "gray") : "gray"}>
      {c ?? "未宣告 content"}
    </Badge>
  );
}

function depthLabel(cs: CodeSystemInfo): string {
  if (cs.concept_count === 0) return "無概念";
  if (cs.depth <= 1) return "平面";
  return `${cs.depth}${cs.depth_more ? "+" : ""} 層`;
}

function CsCard({ cs, onOpen }: { cs: CodeSystemInfo; onOpen: () => void }) {
  const langs = [...new Set([cs.language, ...cs.languages].filter((x): x is string => Boolean(x)))];
  return (
    <button type="button" className={`${classes.card} ${classes.accentTop}`} style={{ ["--card-accent" as string]: "var(--cat-terminology)" }} onClick={onOpen} aria-label={`${cs.title}，${cs.concept_count} 個概念`}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
        <Box style={{ minWidth: 0 }}>
          <Text fw={650} fz="sm" style={{ wordBreak: "break-word" }}>
            {cs.title}
          </Text>
          <Text className={classes.mono} c="dimmed">
            {cs.cs_id}
          </Text>
        </Box>
        <ContentBadge c={cs.content} />
      </Group>
      <Group gap="lg" mt="sm" align="flex-end">
        <Box>
          <Text fz={10} c="dimmed" fw={600} tt="uppercase">
            概念
          </Text>
          <Text fz="lg" fw={700} className="tabular" lh={1.2}>
            {fmtNumber(cs.concept_count)}
          </Text>
        </Box>
        <Box>
          <Text fz={10} c="dimmed" fw={600} tt="uppercase">
            階層
          </Text>
          <Group gap={4}>
            {cs.depth > 1 ? <IconBinaryTree size={13} /> : <IconList size={13} />}
            <Text fz="sm" fw={600}>
              {depthLabel(cs)}
            </Text>
          </Group>
        </Box>
        <Box>
          <Text fz={10} c="dimmed" fw={600} tt="uppercase">
            ValueSet
          </Text>
          <Tooltip label={cs.used_by.length ? cs.used_by.map((v) => v.title).join("\n") : "沒有 ValueSet 引用"} multiline style={{ whiteSpace: "pre-line" }} withArrow>
            <Text fz="sm" fw={600} className="tabular" c={cs.used_by.length ? undefined : "dimmed"}>
              {cs.used_by.length}
            </Text>
          </Tooltip>
        </Box>
      </Group>
      <Group gap={4} mt="sm" wrap="wrap">
        {cs.declared_count !== null && cs.declared_count !== cs.concept_count && (
          <Tooltip label="CodeSystem.count 與實際收錄數不同" withArrow>
            <Badge size="xs" variant="outline" color="orange">
              count {fmtNumber(cs.declared_count)}
            </Badge>
          </Tooltip>
        )}
        {cs.hierarchy_meaning && (
          <Badge size="xs" variant="outline" color="indigo">
            {cs.hierarchy_meaning}
          </Badge>
        )}
        {langs.map((l) => (
          <Badge key={l} size="xs" variant="light" color="gray" leftSection={<IconLanguage size={10} />} tt="none">
            {l}
          </Badge>
        ))}
        {cs.supplemented_by.length > 0 && (
          <Tooltip label={cs.supplemented_by.map((s) => s.title).join("\n")} multiline style={{ whiteSpace: "pre-line" }} withArrow>
            <Badge size="xs" variant="light" color="violet" leftSection={<IconPuzzle size={10} />}>
              {cs.supplemented_by.length} 個補充
            </Badge>
          </Tooltip>
        )}
      </Group>
    </button>
  );
}

function DesignationList({ list, tone }: { list: Designation[]; tone?: "supplement" }) {
  return (
    <>
      {list.map((d, i) => (
        <Group key={i} gap={6} wrap="nowrap" align="flex-start">
          <Badge size="xs" variant={tone ? "light" : "default"} color={tone ? "violet" : "gray"} tt="none" style={{ flex: "0 0 auto" }}>
            {d.language ?? "—"}
          </Badge>
          <Text fz="xs" style={{ wordBreak: "break-word" }}>
            {d.value}
            {d.use && (
              <Text span c="dimmed" fz={11}>
                {" "}
                · {d.use}
              </Text>
            )}
          </Text>
        </Group>
      ))}
    </>
  );
}

const PER = 50;

function ConceptList({ ig, cs }: { ig: IgRef; cs: CodeSystemInfo }) {
  const { get, patch } = useDetailParams();
  const urlQ = get(DP.csQ) ?? "";
  const [text, setText] = useState(urlQ);
  const dq = useDebounced(text.trim(), 300);
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (dq !== urlQ) patch({ [DP.csQ]: dq || null }, { replace: true });
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  const q = useCsConcepts(ig, cs.artifact_key, urlQ, (page - 1) * PER, PER);
  const d = q.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / PER)) : 1;
  return (
    <Stack gap="sm">
      <TextInput
        leftSection={<IconSearch size={16} />}
        placeholder="搜尋代碼、顯示名稱或 designation"
        aria-label="搜尋概念"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        rightSection={text ? <CloseButton size="sm" aria-label="清除搜尋" onClick={() => setText("")} /> : null}
      />
      <Text fz="xs" c="dimmed" aria-live="polite">
        {d ? (urlQ ? `符合 ${fmtNumber(d.total)} / ${fmtNumber(d.all)} 個概念` : `${fmtNumber(d.all)} 個概念（依階層前序排列）`) : " "}
        {d?.flat_mode && " · 大型代碼系統，只列頂層概念"}
      </Text>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !d ? (
        <Skeleton h={300} />
      ) : d.items.length === 0 ? (
        <EmptyState compact icon={<IconSearch size={20} />} title="沒有符合的概念" />
      ) : (
        <Box style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)", overflow: "hidden", opacity: q.isPlaceholderData ? 0.55 : 1, transition: "opacity 150ms" }}>
          {d.items.map((c) => (
            <div key={c.code} className={classes.conceptRow} style={{ paddingLeft: 12 + (urlQ ? 0 : (c.depth - 1) * 18) }}>
              <Box>
                <Group gap={6} wrap="nowrap">
                  <Text ff="monospace" fz="sm" fw={650} style={{ wordBreak: "break-all" }}>
                    {c.code}
                  </Text>
                  {c.child_count > 0 && (
                    <Tooltip label={`${c.child_count} 個子概念`} withArrow>
                      <Badge size="xs" variant="light" color="gray">
                        {c.child_count}
                      </Badge>
                    </Tooltip>
                  )}
                </Group>
                {urlQ && c.parent && (
                  <Text fz={11} c="dimmed" ff="monospace">
                    ↳ {c.parent}
                  </Text>
                )}
              </Box>
              <Stack gap={3} style={{ minWidth: 0 }}>
                <Text fz="sm" style={{ wordBreak: "break-word" }}>
                  {c.display ?? <Text span c="dimmed">—</Text>}
                </Text>
                {c.definition && c.definition !== c.display && (
                  <Text fz="xs" c="dimmed" lineClamp={2}>
                    {c.definition}
                  </Text>
                )}
                <DesignationList list={c.designations} />
                {c.supplements.map((s, i) => (
                  <Box key={i}>
                    <Tooltip label={`由補充 CodeSystem 提供：${s.title}`} withArrow multiline maw={320}>
                      <Text fz={11} c="violet" fw={600} w="fit-content">
                        補充 · {s.title.length > 40 ? `${s.title.slice(0, 40)}…` : s.title}
                      </Text>
                    </Tooltip>
                    <DesignationList list={s.designations} tone="supplement" />
                    {s.properties.length > 0 && (
                      <Group gap={4} mt={2}>
                        {s.properties.slice(0, 6).map((p, k) => (
                          <Badge key={k} size="xs" variant="light" color="violet" tt="none" fw={500}>
                            {p.code} = {p.value}
                          </Badge>
                        ))}
                      </Group>
                    )}
                  </Box>
                ))}
                {c.properties.length > 0 && (
                  <Group gap={4}>
                    {c.properties.slice(0, 6).map((p, k) => (
                      <Badge key={k} size="xs" variant="default" tt="none" fw={500}>
                        {p.code} = {p.value}
                      </Badge>
                    ))}
                  </Group>
                )}
              </Stack>
            </div>
          ))}
        </Box>
      )}
      {d && pages > 1 && (
        <Group justify="flex-end">
          <Pagination size="sm" total={pages} value={page} onChange={setPage} siblings={1} />
        </Group>
      )}
    </Stack>
  );
}

function CsDetail({ ig, cs, onBack, onOpenValueSet }: { ig: IgRef; cs: CodeSystemInfo; onBack: () => void; onOpenValueSet: (key: string) => void }) {
  const { get, patch } = useDetailParams();
  const view = get(DP.csView) === "list" ? "list" : "tree";
  return (
    <Stack gap="md" className={classes.fadeUp}>
      <Group gap="xs">
        <Button size="xs" variant="subtle" leftSection={<IconArrowLeft size={14} />} onClick={onBack}>
          返回 CodeSystem 列表
        </Button>
      </Group>
      <SectionCard
        title={cs.title}
        description={<CopyText value={cs.url ?? cs.cs_id} mono />}
        icon={<IconListTree size={18} />}
        actions={
          <SegmentedControl
            size="xs"
            value={view}
            onChange={(v) => patch({ [DP.csView]: v === "tree" ? null : v, [DP.csQ]: null }, { replace: true })}
            data={[
              { value: "tree", label: <Group gap={4} wrap="nowrap"><IconBinaryTree size={14} />樹狀</Group> },
              { value: "list", label: <Group gap={4} wrap="nowrap"><IconList size={14} />清單</Group> },
            ]}
            aria-label="檢視方式"
          />
        }
      >
        <Stack gap="sm">
          <Group gap={6} wrap="wrap">
            <ContentBadge c={cs.content} />
            <StatusBadge status={cs.status} />
            {cs.cs_version && (
              <Badge variant="outline" color="gray" tt="none">
                v{cs.cs_version}
              </Badge>
            )}
            <Badge variant="outline" color="gray">
              {fmtNumber(cs.concept_count)} 個概念 · {depthLabel(cs)}
            </Badge>
            {cs.property_count > 0 && (
              <Badge variant="outline" color="gray">
                {cs.property_count} 個屬性定義
              </Badge>
            )}
          </Group>
          {cs.used_by.length > 0 && (
            <Group gap={6} wrap="wrap">
              <Text fz="xs" c="dimmed">
                被引用：
              </Text>
              {cs.used_by.map((v) => (
                <Anchor key={v.artifact_key} component="button" type="button" fz="xs" onClick={() => onOpenValueSet(v.artifact_key)}>
                  {v.title}
                </Anchor>
              ))}
            </Group>
          )}
          {cs.supplemented_by.length > 0 && (
            <Group gap={6} wrap="wrap" align="flex-start">
              <Text fz="xs" c="dimmed">
                補充：
              </Text>
              {cs.supplemented_by.map((s) => (
                <Tooltip key={`${s.url}|${s.version}`} label={`${s.url}${s.version ? `|${s.version}` : ""} · ${fmtNumber(s.concept_count)} 個概念 · ${s.source === "bundled" ? "系統內建" : s.source === "uploaded" ? "管理員上傳" : s.source}`} multiline maw={420} withArrow>
                  <Badge variant="light" color="violet" tt="none" fw={500} leftSection={<IconPuzzle size={11} />} style={{ maxWidth: "100%" }}>
                    {s.title}
                  </Badge>
                </Tooltip>
              ))}
            </Group>
          )}
        </Stack>
      </SectionCard>
      <div className={classes.fadeUp} key={view}>
        {view === "tree" ? (
          <Stack gap={6}>
            {cs.supplemented_by.length > 0 && (
              <Text fz="xs" c="dimmed">
                樹狀檢視顯示 CodeSystem 本身的內容；補充提供的名稱與屬性請切到「清單」。
              </Text>
            )}
            <IgCodeSystemTree packageId={ig.package_id} artifactKey={cs.artifact_key} version={ig.version} />
          </Stack>
        ) : (
          <ConceptList ig={ig} cs={cs} />
        )}
      </div>
    </Stack>
  );
}

/** CodeSystem tab: list of the IG's CodeSystems → tree / list view of one (URL: cs, csv, csq). */
export function IgCodeSystemsTab({ ig, onOpenValueSet }: { ig: IgRef; onOpenValueSet: (key: string) => void }) {
  const { get, patch } = useDetailParams();
  const q = useIgCodeSystems(ig);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState("name");
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const shown = useMemo(() => {
    const t = filter.trim().toLowerCase();
    const f = t ? items.filter((c) => [c.title, c.cs_id, c.url ?? "", c.name ?? ""].some((s) => s.toLowerCase().includes(t))) : items;
    const s = [...f];
    if (sort === "count") s.sort((a, b) => b.concept_count - a.concept_count);
    else if (sort === "used") s.sort((a, b) => b.used_by.length - a.used_by.length);
    return s;
  }, [items, filter, sort]);
  const csId = get(DP.cs);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data)
    return (
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} h={150} />
        ))}
      </SimpleGrid>
    );
  const selected = csId ? items.find((c) => c.cs_id === csId) : null;
  if (csId && selected) return <CsDetail ig={ig} cs={selected} onBack={() => patch({ [DP.cs]: null, [DP.csView]: null, [DP.csQ]: null })} onOpenValueSet={onOpenValueSet} />;
  if (items.length === 0) return <EmptyState title="此 IG 沒有自己的 CodeSystem" description="它的 ValueSet 只引用外部或相依套件的代碼系統。" />;
  const total = items.reduce((n, c) => n + c.concept_count, 0);
  return (
    <Stack gap="md">
      {csId && !selected && <Text fz="sm" c="amber">找不到 CodeSystem「{csId}」。</Text>}
      <Group gap="sm" wrap="wrap">
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder="篩選 CodeSystem"
          aria-label="篩選 CodeSystem"
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          rightSection={filter ? <CloseButton size="sm" aria-label="清除" onClick={() => setFilter("")} /> : null}
          style={{ flex: "1 1 260px" }}
        />
        <Select aria-label="排序" value={sort} onChange={(v) => v && setSort(v)} data={SORTS} allowDeselect={false} w={190} comboboxProps={{ withinPortal: true }} />
      </Group>
      <Text fz="xs" c="dimmed">
        {shown.length} / {items.length} 個 CodeSystem · 共 {fmtNumber(total)} 個概念
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="sm" className={classes.stagger} key={`${sort}|${filter}`}>
        {shown.map((c) => (
          <CsCard key={c.artifact_key} cs={c} onOpen={() => patch({ [DP.cs]: c.cs_id })} />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

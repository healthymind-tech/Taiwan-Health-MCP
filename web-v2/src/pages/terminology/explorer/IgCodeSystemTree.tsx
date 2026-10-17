import { Alert, Badge, Box, Group, Skeleton, Stack, Table, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { ErrorState } from "@/components/EmptyState";
import { fmtNumber } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { DrillList, LazyTree, type Reveal } from "./LazyTree";
import { Hl, Panel, SearchBox } from "./parts";
import { termGet, tk, type CsMeta, type CsNode, type Page } from "./termApi";
import classes from "./explorer.module.css";

type Node = CsNode & { id: string; hasChildren: boolean };
const asNode = (n: CsNode): Node => ({ ...n, id: n.code, hasChildren: n.child_count > 0 });

const COMPLETENESS: Record<string, { color: string; label: string }> = {
  complete: { color: "teal", label: "complete" },
  fragment: { color: "orange", label: "fragment" },
  truncated: { color: "red", label: "內容可能被截斷" },
  "not-present": { color: "gray", label: "not-present" },
  example: { color: "yellow", label: "example" },
  supplement: { color: "violet", label: "supplement" },
  unknown: { color: "gray", label: "未宣告 content" },
};

/** Nested concept tree of one IG CodeSystem (replaces the flat concept table). */
export function IgCodeSystemTree({ packageId, artifactKey, version }: { packageId: string; artifactKey: string; version?: string }) {
  const isMobile = useIsMobile();
  const params = { package_id: packageId, artifact_key: artifactKey, version: version ?? "" };
  const overview = useQuery({
    queryKey: tk("cs", packageId, artifactKey, version ?? ""),
    queryFn: () => termGet<{ meta: CsMeta; root: Page<CsNode> }>("ig/codesystem", { ...params, limit: 200 }),
    staleTime: 5 * 60_000,
  });
  const [selected, setSelected] = useState<Node | null>(null);
  const [reveal, setReveal] = useState<Reveal<Node> | null>(null);
  const [lastQ, setLastQ] = useState("");
  const nonce = useRef(0);

  const meta = overview.data?.meta;
  const v = meta?.version ?? version ?? "";
  const loadChildren = useCallback(
    async (parent: string, offset: number) => {
      if (!parent && offset === 0 && overview.data) return { items: overview.data.root.items.map(asNode), total: overview.data.root.total };
      const r = await termGet<Page<CsNode>>("ig/codesystem/children", { package_id: packageId, artifact_key: artifactKey, version: v, parent, offset, limit: 200 });
      return { items: r.items.map(asNode), total: r.total };
    },
    [packageId, artifactKey, v, overview.data],
  );

  if (overview.isError) return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;
  if (!meta) return <Skeleton h={300} />;

  const comp = COMPLETENESS[meta.completeness.status] ?? COMPLETENESS.unknown;
  const renderRow = (n: Node) => (
    <Box style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text span className={classes.code}>
            <Hl text={n.code} q={lastQ} />
          </Text>
          <Text span fz="sm" truncate>
            <Hl text={n.display} q={lastQ} />
          </Text>
        </Group>
        {(n.designations.length > 0 || n.definition) && (
          <Text fz={11} c="dimmed" truncate>
            {n.designations.length > 0 ? n.designations.map((d) => `${d.language ? `[${d.language}] ` : ""}${d.value}`).join(" · ") : n.definition}
          </Text>
        )}
      </Box>
      {n.child_count > 0 && (
        <Tooltip label={`${n.child_count} 個子概念，共 ${n.descendant_count} 個後代`} withArrow>
          <Badge size="xs" variant="light" color="gray" style={{ flex: "0 0 auto" }}>
            {fmtNumber(n.descendant_count)}
          </Badge>
        </Tooltip>
      )}
    </Box>
  );

  const treeProps = {
    cacheKey: `cs-${packageId}-${v}-${artifactKey}`,
    loadChildren,
    renderRow,
    selectedId: selected?.id ?? null,
    onSelect: setSelected,
    reveal,
    ariaLabel: `${meta.title ?? meta.name ?? artifactKey} 概念階層`,
  };

  return (
    <Stack gap="sm">
      <Group gap={6} wrap="wrap">
        <Tooltip label={meta.completeness.reason ?? `CodeSystem.content = ${meta.content ?? "—"}`} withArrow multiline w={320}>
          <Badge variant="light" color={comp.color} leftSection={meta.completeness.status === "truncated" ? <IconAlertTriangle size={12} /> : undefined}>
            {comp.label}
          </Badge>
        </Tooltip>
        {meta.content && meta.completeness.status === "truncated" && (
          <Badge variant="outline" color="gray">
            content = {meta.content}
          </Badge>
        )}
        <Badge variant="outline" color="gray">
          {fmtNumber(meta.actual_count)} 個概念{meta.declared_count !== null ? ` / count ${fmtNumber(meta.declared_count)}` : ""}
        </Badge>
        <Badge variant="outline" color="gray">
          {meta.depth} 層
        </Badge>
        {meta.hierarchy_meaning && (
          <Tooltip label="hierarchyMeaning：巢狀 concept 代表的關係" withArrow>
            <Badge variant="light" color="indigo">
              {meta.hierarchy_meaning}
            </Badge>
          </Tooltip>
        )}
        {meta.case_sensitive !== null && (
          <Badge variant="outline" color="gray">
            {meta.case_sensitive ? "區分大小寫" : "不分大小寫"}
          </Badge>
        )}
        {meta.mode === "flat" && (
          <Badge variant="light" color="blue">
            大型平面清單（分頁載入）
          </Badge>
        )}
      </Group>
      {meta.completeness.status === "truncated" && meta.completeness.reason && (
        <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={16} />}>
          <Text fz="xs">{meta.completeness.reason}</Text>
        </Alert>
      )}
      {meta.property_defs.length > 0 && (
        <Group gap={4}>
          <Text fz="xs" c="dimmed">
            屬性：
          </Text>
          {meta.property_defs.map((p) => (
            <Tooltip key={p.code} label={p.description ?? p.code} withArrow disabled={!p.description}>
              <Badge size="xs" variant="default" tt="none">
                {p.code}
                {p.type ? ` : ${p.type}` : ""}
              </Badge>
            </Tooltip>
          ))}
        </Group>
      )}
      <SearchBox<CsNode>
        id={`cs-${packageId}-${v}-${artifactKey}`}
        placeholder="搜尋此 CodeSystem 的代碼、顯示名稱或 designation…"
        search={(s) => termGet<{ items: CsNode[] }>("ig/codesystem/search", { ...params, version: v, q: s }).then((r) => r.items)}
        hitKey={(h) => h.code}
        onPick={(h) => {
          nonce.current += 1;
          setLastQ("");
          setSelected(asNode(h));
          setReveal({ path: [...(h.path ?? []), h.code], target: h.code, nonce: nonce.current });
        }}
        renderHit={(h, s) => (
          <Box>
            <Group gap={6} wrap="nowrap">
              <Text span className={classes.code}>
                <Hl text={h.code} q={s} />
              </Text>
              <Text span fz="sm" truncate>
                <Hl text={h.display} q={s} />
              </Text>
            </Group>
            {h.path && h.path.length > 0 && (
              <Text fz={11} c="dimmed" ff="monospace" truncate>
                {h.path.join(" › ")}
              </Text>
            )}
          </Box>
        )}
      />
      {isMobile ? (
        <Stack gap="sm">
          {selected && <ConceptCard n={selected} />}
          <Panel>
            <DrillList<Node> {...treeProps} labelOf={(n) => n.code} />
          </Panel>
        </Stack>
      ) : (
        <div className={classes.shell} style={{ gridTemplateColumns: "minmax(0, 1.2fr) minmax(260px, 0.8fr)" }}>
          <Panel>
            <LazyTree<Node> {...treeProps} rowHeight={46} height={Math.min(520, Math.max(200, meta.actual_count * 46 + 20))} />
          </Panel>
          <Panel className={classes.sticky}>
            {selected ? (
              <ConceptCard n={selected} />
            ) : (
              <Group gap="xs" p="md" c="dimmed">
                <IconInfoCircle size={16} />
                <Text fz="sm">點選概念查看定義、designation 與屬性。方向鍵可在樹中移動，→ 展開、← 收合。</Text>
              </Group>
            )}
          </Panel>
        </div>
      )}
    </Stack>
  );
}

function ConceptCard({ n }: { n: Node }) {
  return (
    <div className={classes.detailCard} key={n.code}>
      <Text className={classes.bigCode} fz={22}>
        {n.code}
      </Text>
      {n.display && (
        <Text fz="md" fw={600} mt={4}>
          {n.display}
        </Text>
      )}
      {n.definition && (
        <Text fz="sm" c="dimmed" mt={6} style={{ whiteSpace: "pre-wrap" }}>
          {n.definition}
        </Text>
      )}
      {n.child_count > 0 && (
        <Text fz="xs" c="dimmed" mt="sm">
          {fmtNumber(n.child_count)} 個子概念 · {fmtNumber(n.descendant_count)} 個後代
        </Text>
      )}
      {n.designations.length > 0 && (
        <>
          <Text fz="xs" fw={700} c="dimmed" tt="uppercase" mt="md" mb={4}>
            Designations
          </Text>
          <Table fz="xs" withRowBorders={false}>
            <Table.Tbody>
              {n.designations.map((d, i) => (
                <Table.Tr key={i}>
                  <Table.Td w={70}>
                    <Badge size="xs" variant="light">
                      {d.language ?? "—"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{d.value}</Table.Td>
                  <Table.Td c="dimmed">{d.use}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
      {n.properties.length > 0 && (
        <>
          <Text fz="xs" fw={700} c="dimmed" tt="uppercase" mt="md" mb={4}>
            Properties
          </Text>
          <Group gap={4}>
            {n.properties.map((p, i) => (
              <Badge key={i} size="sm" variant="default" tt="none" fw={500}>
                {p.code} = {p.value}
              </Badge>
            ))}
          </Group>
        </>
      )}
    </div>
  );
}

import { Alert, Badge, Box, Group, SegmentedControl, Skeleton, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconInfoCircle, IconListTree } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { CopyText } from "@/components/CopyText";
import { ErrorState } from "@/components/EmptyState";
import { fmtNumber } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { DrillList, LazyTree, type Reveal, type RowState } from "./LazyTree";
import { Hl, KIND_COLOR, KIND_LABEL, Panel, SearchBox } from "./parts";
import { PcsExplorer } from "./PcsExplorer";
import { termGet, tk, type IcdHit, type IcdNode, type IcdPath, type SeventhChip } from "./termApi";
import classes from "./explorer.module.css";

type Sys = "cm" | "who";
type Node = IcdNode & { hasChildren: boolean };

const SYS_LABEL: Record<string, string> = { cm: "ICD-10-CM 診斷", pcs: "ICD-10-PCS 處置", who: "WHO ICD-10" };

/** ICD module explorer: CM tree, PCS tables / axes, WHO tree. */
export function IcdExplorer() {
  const isMobile = useIsMobile();
  const [sp, setSp] = useSearchParams();
  const sys = (["cm", "pcs", "who"].includes(sp.get("sys") ?? "") ? sp.get("sys") : "cm") as "cm" | "pcs" | "who";
  const setSys = (v: string) => {
    const next = new URLSearchParams(sp);
    next.set("sys", v);
    for (const k of ["code", "node", "table"]) next.delete(k);
    setSp(next, { replace: true });
  };
  return (
    <Stack gap="md">
      <SegmentedControl
        value={sys}
        onChange={setSys}
        data={Object.entries(SYS_LABEL).map(([value, label]) => ({ value, label: isMobile ? label.split(" ")[0].replace("ICD-10-", "") : label }))}
        w={{ base: "100%", sm: "auto" }}
        style={{ alignSelf: "flex-start" }}
      />
      {sys === "pcs" ? <PcsExplorer /> : <IcdTree key={sys} sys={sys} />}
    </Stack>
  );
}

function asNode(n: IcdNode): Node {
  return { ...n, hasChildren: n.has_children };
}

function IcdRow({ n, q, activeCode, onChip }: { n: IcdNode; q?: string; activeCode?: string | null; onChip: (c: SeventhChip) => void }) {
  const isGroup = n.kind === "chapter" || n.kind === "block";
  return (
    <Box style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
      <span className={classes.kindDot} style={{ background: KIND_COLOR[n.kind] }} title={KIND_LABEL[n.kind]} />
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          {n.kind === "chapter" ? (
            <Text span fz={13} fw={650} c="dimmed" style={{ whiteSpace: "nowrap" }}>
              第 {n.code} 章
            </Text>
          ) : (
            <Text span className={classes.code} c={isGroup ? "dimmed" : undefined}>
              {n.code}
            </Text>
          )}
          {n.kind === "chapter" && n.range && (
            <Text span fz={11} ff="monospace" c="dimmed">
              {n.range}
            </Text>
          )}
          <Text span fz="sm" fw={500} truncate style={{ minWidth: 0 }}>
            <Hl text={n.title_zh ?? n.title_en} q={q} />
          </Text>
        </Group>
        {(n.title_zh || isGroup) && (
          <Text fz={11.5} c="dimmed" truncate>
            {n.title_zh ? <Hl text={n.title_en} q={q} /> : null}
          </Text>
        )}
      </Box>
      {n.seventh && n.seventh.length > 0 ? (
        <span className={classes.seventh} onClick={(e) => e.stopPropagation()}>
          {n.seventh.map((c) => (
            <Tooltip key={c.code} label={`${c.code} · ${c.meaning}`} withArrow openDelay={250}>
              <span className={classes.seventhChip} data-active={activeCode === c.code || undefined} onClick={() => onChip(c)} role="button" aria-label={`${c.code} ${c.meaning}`}>
                {c.char}
              </span>
            </Tooltip>
          ))}
        </span>
      ) : n.kind === "billable" ? (
        <Badge size="xs" variant="light" color="teal" style={{ flex: "0 0 auto" }}>
          可申報
        </Badge>
      ) : n.billable_count > 0 ? (
        <Text fz={11} c="dimmed" className="tabular" style={{ flex: "0 0 auto" }}>
          {fmtNumber(n.billable_count)} 碼
        </Text>
      ) : null}
    </Box>
  );
}

function IcdTree({ sys }: { sys: Sys }) {
  const isMobile = useIsMobile();
  const [sp, setSp] = useSearchParams();
  const code = sp.get("code");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [reveal, setReveal] = useState<Reveal<Node> | null>(null);
  const [lastQ, setLastQ] = useState("");
  const fromTree = useRef(false);
  const nonce = useRef(0);

  const setCode = useCallback(
    (c: string | null, opts: { fromTree?: boolean } = {}) => {
      fromTree.current = Boolean(opts.fromTree);
      const next = new URLSearchParams(sp);
      if (c) next.set("code", c);
      else next.delete("code");
      setSp(next, { replace: true });
    },
    [sp, setSp],
  );

  const path = useQuery({
    queryKey: tk("icd-path", sys, code ?? ""),
    queryFn: () => termGet<IcdPath>(`icd/${sys}/path`, { code: code! }),
    enabled: Boolean(code),
    staleTime: 5 * 60_000,
  });

  // Reveal the URL's code in the tree unless the user just clicked it there.
  useEffect(() => {
    if (!path.data) return;
    setSelectedId(path.data.node_id);
    if (fromTree.current) {
      fromTree.current = false;
      return;
    }
    const seed: Record<string, Node[]> = {};
    for (const [k, v] of Object.entries(path.data.children)) seed[k] = v.map(asNode);
    nonce.current += 1;
    setReveal({ path: path.data.path, target: path.data.node_id, seed, nonce: nonce.current });
  }, [path.data]);

  const loadChildren = useCallback(
    async (id: string) => {
      const r = await termGet<{ items: IcdNode[] }>(`icd/${sys}/children`, { node: id });
      return { items: r.items.map(asNode), total: r.items.length };
    },
    [sys],
  );

  const onSelect = (n: Node) => {
    setSelectedId(n.id);
    setSelectedNode(n);
    if (n.kind === "chapter" || (n.kind === "block" && sys === "cm")) setCode(null, { fromTree: true });
    else setCode(n.id, { fromTree: true });
  };
  const onChip = (c: SeventhChip) => setCode(c.code, { fromTree: true });

  const renderRow = (n: Node, _s: RowState) => <IcdRow n={n} q={lastQ} activeCode={code} onChip={onChip} />;

  const search = useCallback((q: string) => termGet<{ items: IcdHit[] }>(`icd/${sys}/search`, { q }).then((r) => r.items), [sys]);

  const tree = isMobile ? (
    <DrillList<Node>
      cacheKey={`icd-${sys}`}
      loadChildren={loadChildren}
      renderRow={renderRow}
      selectedId={selectedId}
      onSelect={onSelect}
      reveal={reveal}
      ariaLabel={`${SYS_LABEL[sys]} 階層`}
      labelOf={(n) => (n.kind === "chapter" ? `第 ${n.code} 章` : n.code)}
    />
  ) : (
    <LazyTree<Node>
      cacheKey={`icd-${sys}`}
      loadChildren={loadChildren}
      renderRow={renderRow}
      selectedId={selectedId}
      onSelect={onSelect}
      reveal={reveal}
      ariaLabel={`${SYS_LABEL[sys]} 階層`}
      rowHeight={52}
      height={620}
    />
  );

  const detail = code ? (
    path.isPending ? (
      <Box p="md">
        <Skeleton h={34} w="40%" mb="sm" />
        <Skeleton h={18} mb={6} />
        <Skeleton h={14} w="70%" />
      </Box>
    ) : path.isError ? (
      <ErrorState error={path.error} onRetry={() => void path.refetch()} />
    ) : path.data ? (
      <CodeDetail sys={sys} data={path.data} code={code} siblings={selectedNode?.id === path.data.node_id ? selectedNode.seventh : findSeventh(path.data)} onGo={(c) => setCode(c)} />
    ) : null
  ) : selectedNode ? (
    <GroupDetail n={selectedNode} />
  ) : (
    <Box p="md">
      <Group gap="xs" c="dimmed">
        <IconListTree size={18} />
        <Text fz="sm">點選左側任一節點查看詳細資料；也可直接搜尋代碼（例如 E11.21、S93.401A）或中英文名稱。</Text>
      </Group>
      <Legend />
    </Box>
  );

  return (
    <Stack gap="sm">
      <SearchBox<IcdHit>
        id={`icd-${sys}`}
        placeholder={sys === "cm" ? "搜尋 ICD-10-CM：E11.21、S93401A、糖尿病、ankle sprain…" : "搜尋 WHO ICD-10：E11.2、cholera…"}
        search={search}
        hitKey={(h) => h.code}
        onPick={(h) => {
          setLastQ("");
          setCode(h.code);
        }}
        renderHit={(h, q) => (
          <Box>
            <Group gap={6} wrap="nowrap">
              <Text span className={classes.code}>
                {h.code}
              </Text>
              <Badge size="xs" variant="light" color={h.is_header ? "gray" : "teal"}>
                {h.is_header ? "標頭" : "可申報"}
              </Badge>
              <Text span fz={11} c="dimmed" ml="auto">
                {h.chapter ? (sys === "cm" ? `第 ${h.chapter} 章` : h.chapter) : ""} {h.block ?? ""}
              </Text>
            </Group>
            <Text fz="sm" lineClamp={1}>
              <Hl text={h.title_zh ?? h.title_en} q={q} />
            </Text>
            {h.title_zh && (
              <Text fz="xs" c="dimmed" lineClamp={1}>
                <Hl text={h.title_en} q={q} />
              </Text>
            )}
          </Box>
        )}
      />
      {isMobile ? (
        <Stack gap="sm">
          {(code || selectedNode) && <Panel>{detail}</Panel>}
          <Panel>{tree}</Panel>
        </Stack>
      ) : (
        <div className={classes.shell}>
          <Panel>{tree}</Panel>
          <Panel className={classes.sticky}>{detail}</Panel>
        </div>
      )}
    </Stack>
  );
}

function findSeventh(p: IcdPath): SeventhChip[] | undefined {
  for (const list of Object.values(p.children)) {
    const n = list.find((x) => x.id === p.node_id);
    if (n?.seventh) return n.seventh;
  }
  return undefined;
}

function Legend() {
  return (
    <Group gap="md" mt="md" wrap="wrap">
      {Object.entries(KIND_LABEL).map(([k, label]) => (
        <Group key={k} gap={6}>
          <span className={classes.kindDot} style={{ background: KIND_COLOR[k] }} />
          <Text fz="xs" c="dimmed">
            {label}
          </Text>
        </Group>
      ))}
      <Group gap={6}>
        <span className={classes.seventhChip}>A</span>
        <Text fz="xs" c="dimmed">
          第 7 碼延伸（初期 / 後續 / 後遺症…）
        </Text>
      </Group>
    </Group>
  );
}

function GroupDetail({ n }: { n: Node }) {
  return (
    <div className={classes.detailCard} key={n.id}>
      <Group gap={8}>
        <Badge variant="light" color={n.kind === "chapter" ? "indigo" : n.kind === "block" ? "violet" : "brand"}>
          {KIND_LABEL[n.kind]}
        </Badge>
        {n.range && (
          <Text ff="monospace" fz="sm" c="dimmed">
            {n.range}
          </Text>
        )}
      </Group>
      <Text className={classes.bigCode} mt={8}>
        {n.kind === "chapter" ? `第 ${n.code} 章` : n.code}
      </Text>
      {n.title_zh && (
        <Text fz="lg" fw={600} mt={6}>
          {n.title_zh}
        </Text>
      )}
      <Text fz="sm" c="dimmed" mt={2}>
        {n.title_en}
      </Text>
      <Text fz="sm" mt="md">
        底下共有 <b className="tabular">{fmtNumber(n.billable_count)}</b> 個可申報代碼。
      </Text>
    </div>
  );
}

function CodeDetail({ sys, data, code, siblings, onGo }: { sys: Sys; data: IcdPath; code: string; siblings?: SeventhChip[]; onGo: (code: string) => void }) {
  const d = data.detail;
  if (!d) {
    // WHO: path only.
    return (
      <div className={classes.detailCard} key={code}>
        <Text className={classes.bigCode}>{data.code}</Text>
        <Text fz="lg" fw={600} mt={6}>
          {data.title}
        </Text>
        <Stack gap={0} mt="md" className={classes.crumbs}>
          {data.path.map((id, i) => {
            const parent = i === 0 ? "" : data.path[i - 1];
            const n = data.children[parent]?.find((x) => x.id === id);
            return (
              <UnstyledButton key={id} className={classes.crumb} data-last={i === data.path.length - 1 || undefined} style={{ animationDelay: `${i * 50}ms` }} onClick={() => onGo(id)}>
                <Text span className={classes.code} fz={12}>
                  {n?.kind === "chapter" ? `第 ${id} 章` : (n?.code ?? id)}
                </Text>
                <Text span fz={12.5} c="dimmed" lineClamp={1}>
                  {n?.title_zh ?? n?.title_en}
                </Text>
              </UnstyledButton>
            );
          })}
        </Stack>
      </div>
    );
  }
  const chain = [
    ...(d.chapter ? [{ code: `第 ${d.chapter.code} 章`, title: d.chapter.title_zh ?? d.chapter.title_en, go: null as string | null }] : []),
    ...(d.block ? [{ code: d.block.code.replace("-", "–"), title: d.block.title_en, go: null }] : []),
    ...d.ancestors.map((a) => ({ code: a.code, title: a.title_zh ?? a.title_en, go: a.code })),
    { code: d.code, title: d.title_zh ?? d.title_en, go: null },
  ];
  return (
    <div className={classes.detailCard} key={code}>
      <Group gap={8} justify="space-between" wrap="nowrap">
        <Badge variant="light" color={d.is_header ? "gray" : "teal"} size="lg">
          {d.is_header ? `標頭 · ${fmtNumber(d.billable_count)} 個可申報碼` : "可申報（billable）"}
        </Badge>
        <CopyText value={d.code} mono />
      </Group>
      <Text className={classes.bigCode} mt={10}>
        {d.code}
      </Text>
      {d.title_zh && (
        <Text fz="lg" fw={600} mt={6} style={{ lineHeight: 1.35 }}>
          {d.title_zh}
        </Text>
      )}
      <Text fz="sm" c="dimmed" mt={4}>
        {d.title_en}
      </Text>
      {d.seventh && (
        <Alert mt="md" p="xs" variant="light" color="brand" icon={<IconInfoCircle size={16} />}>
          <Text fz="sm">
            第 7 碼 <b className={classes.code}>{d.seventh.char}</b> = {d.seventh.meaning}
          </Text>
        </Alert>
      )}
      {siblings && siblings.length > 0 && (
        <Box mt="md">
          <Text fz="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
            第 7 碼變化
          </Text>
          <Stack gap={4}>
            {siblings.map((c) => (
              <UnstyledButton key={c.code} onClick={() => onGo(c.code)} className={classes.result} data-active={c.code === code || undefined}>
                <Group gap={8} wrap="nowrap">
                  <span className={classes.seventhChip} data-active={c.code === code || undefined}>
                    {c.char}
                  </span>
                  <Text span className={classes.code} fz={12}>
                    {c.code}
                  </Text>
                  <Text span fz="xs" c="dimmed" truncate>
                    {c.meaning} · {c.title_zh ?? c.title_en}
                  </Text>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        </Box>
      )}
      <Text fz="xs" fw={700} c="dimmed" tt="uppercase" mt="lg" mb={4}>
        階層路徑
      </Text>
      <div className={classes.crumbs}>
        {chain.map((c, i) => (
          <UnstyledButton
            key={`${c.code}-${i}`}
            className={classes.crumb}
            data-last={i === chain.length - 1 || undefined}
            style={{ animationDelay: `${i * 45}ms`, cursor: c.go ? "pointer" : "default" }}
            onClick={() => c.go && onGo(c.go)}
          >
            <Text span className={classes.code} fz={12} style={{ flex: "0 0 auto" }}>
              {c.code}
            </Text>
            <Text span fz={12.5} c="dimmed" lineClamp={1}>
              {c.title}
            </Text>
          </UnstyledButton>
        ))}
      </div>
      {sys === "cm" && (
        <Text fz={11} c="dimmed" mt="md">
          章節 / 區段與第 7 碼說明取自 CMS ICD-10-CM 2026 tabular；中文名稱為衛福部中文版。
        </Text>
      )}
    </div>
  );
}

export default IcdExplorer;

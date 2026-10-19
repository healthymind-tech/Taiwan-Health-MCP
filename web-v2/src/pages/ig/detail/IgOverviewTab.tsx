import { Alert, Anchor, Badge, Box, Button, Group, SimpleGrid, Skeleton, Stack, Switch, Table, Text, ThemeIcon, Tooltip, UnstyledButton } from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBox,
  IconCircleCheck,
  IconCircleDashed,
  IconCloudDownload,
  IconFileCode,
  IconHierarchy2,
  IconInfoCircle,
  IconLanguage,
  IconPackage,
  IconPackages,
  IconRepeat,
  IconStack2,
  IconWorld,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router";
import { CopyText } from "@/components/CopyText";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { KeyValue } from "@/components/KeyValue";
import { RelativeTime } from "@/components/RelativeTime";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { useModulesCatalog } from "@/layout/AppLayout";
import { fmtNumber, fmtPercent } from "@/lib/format";
import { moduleHref } from "@/lib/meta";
import type { IgDetail, IgRef } from "../igTypes";
import { OriginBadge } from "../igOriginBadge";
import { useIgOverview, type Category, type CategoryCount, type ExternalSystem, type IgOverview, type PackageNode } from "./explorerApi";
import { CATEGORY_META, Markdown, StatusBadge, tail } from "./detailMeta";
import classes from "./detail.module.css";

export function IgOverviewTab({
  ig,
  detail,
  onJump,
  onOpenDeps,
  onOpenIg,
}: {
  ig: IgRef;
  detail: IgDetail;
  onJump: (category: Category, group?: string | null) => void;
  onOpenDeps: () => void;
  onOpenIg: (r: IgRef) => void;
}) {
  const q = useIgOverview(ig);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  const cat = (k: Category) => o?.categories.find((c) => c.key === k);
  const term = cat("terminology");
  const termCount = (t: string) => term?.groups.find((g) => g.key === t)?.count ?? 0;
  const profiles = (cat("profile")?.count ?? 0) + (cat("datatype")?.count ?? 0);
  const cov = o?.example_coverage;

  return (
    <Stack gap="lg" className={classes.stagger}>
      <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} spacing="md">
        <StatCard label="構件" loading={!o} value={fmtNumber(o?.total)} hint={`${fmtNumber(detail.counts.codesystems)} 個 CodeSystem · ${fmtNumber(detail.counts.concepts)} 個概念`} icon={<IconBox size={20} />} />
        <StatCard
          label="Profiles / Extensions"
          loading={!o}
          value={`${fmtNumber(profiles)} / ${fmtNumber(cat("extension")?.count ?? 0)}`}
          hint={`${fmtNumber(cat("logical")?.count ?? 0)} 個邏輯模型`}
          icon={<IconStack2 size={20} />}
          onClick={profiles ? () => onJump("profile") : undefined}
          ariaLabel="查看 Profiles"
        />
        <StatCard
          label="術語"
          loading={!o}
          value={fmtNumber(term?.count ?? 0)}
          hint={`ValueSet ${termCount("ValueSet")} · CodeSystem ${termCount("CodeSystem")} · ConceptMap ${termCount("ConceptMap")}`}
          icon={<IconLanguage size={20} />}
          onClick={term ? () => onJump("terminology") : undefined}
          ariaLabel="查看術語構件"
        />
        <StatCard
          label="範例"
          loading={!o}
          value={fmtNumber(cat("example")?.count ?? 0)}
          hint={cov && cov.definitions ? `${cov.with_examples} / ${cov.definitions} 個 Profile/Extension 有範例` : "沒有可對照的 Profile"}
          icon={<IconFileCode size={20} />}
          progress={cov && cov.definitions ? (cov.with_examples / cov.definitions) * 100 : undefined}
          onClick={cat("example") ? () => onJump("example") : undefined}
          ariaLabel="查看範例"
        />
      </SimpleGrid>

      <SectionCard title="構件組成" description="點選分類或色塊直接跳到「構件」的對應分類。" icon={<IconBox size={18} />}>
        {o ? <Composition categories={o.categories} total={o.total} onJump={onJump} /> : <Skeleton h={120} />}
      </SectionCard>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <MetadataCard detail={detail} o={o} />
        <DependencyCard detail={detail} o={o} onOpenDeps={onOpenDeps} onOpenIg={onOpenIg} />
      </SimpleGrid>

      <ExternalSystemsCard o={o} />
    </Stack>
  );
}

function Composition({ categories, total, onJump }: { categories: CategoryCount[]; total: number; onJump: (c: Category, g?: string | null) => void }) {
  if (total === 0) return <EmptyState compact title="此 IG 沒有構件" />;
  return (
    <Stack gap="md">
      <div className={classes.bar} role="img" aria-label={categories.map((c) => `${CATEGORY_META[c.key].label} ${c.count}`).join("、")}>
        {categories.map((c) => {
          const m = CATEGORY_META[c.key];
          return (
            <Tooltip key={c.key} label={`${m.label}：${fmtNumber(c.count)}（${fmtPercent(c.count, total)}）`} withArrow>
              <button
                type="button"
                className={classes.segment}
                style={{ flexGrow: c.count, flexBasis: 0, background: m.color }}
                onClick={() => onJump(c.key)}
                aria-label={`${m.label} ${c.count} 個，查看`}
              />
            </Tooltip>
          );
        })}
      </div>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing={6} verticalSpacing={6}>
        {categories.map((c) => {
          const m = CATEGORY_META[c.key];
          const top = c.groups.filter((g) => g.key && g.key !== c.key);
          return (
            <button key={c.key} type="button" className={classes.legendItem} onClick={() => onJump(c.key)}>
              <span className={classes.swatch} style={{ background: m.color }} />
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Group gap={6} wrap="nowrap" justify="space-between">
                  <Text fz="sm" fw={600} truncate>
                    {m.label}
                  </Text>
                  <Text fz="sm" fw={700} className="tabular">
                    {fmtNumber(c.count)}
                    <Text span fz="xs" c="dimmed" fw={400} ml={6}>
                      {fmtPercent(c.count, total, 0)}
                    </Text>
                  </Text>
                </Group>
                <Text fz="xs" c="dimmed" truncate>
                  {top.length ? top.slice(0, 4).map((g) => `${g.key} ${g.count}`).join(" · ") : m.hint}
                </Text>
              </Box>
              <IconArrowRight size={14} className={classes.legendArrow} />
            </button>
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}

function MetadataCard({ detail: d, o }: { detail: IgDetail; o: IgOverview | undefined }) {
  const m = o?.ig;
  const fhir = m?.fhir_version?.length ? m.fhir_version.join(", ") : d.fhir_version;
  return (
    <SectionCard title="實作指引資訊" icon={<IconInfoCircle size={18} />} description={m ? undefined : o ? "此套件沒有 ImplementationGuide 資源，以下為套件資訊。" : undefined}>
      <Stack gap="md">
        {m?.description && m.description !== (m.title ?? d.title) && <Markdown clamp>{m.description}</Markdown>}
        <KeyValue
          cols={2}
          items={[
            { label: "Canonical", value: d.canonical || m?.url ? <CopyText value={(d.canonical || m?.url) ?? ""} mono /> : null, full: true },
            { label: "Package ID", value: <CopyText value={d.package_id} mono /> },
            { label: "版本", value: <Text fz="sm" ff="monospace">{d.version}</Text> },
            { label: "FHIR 版本", value: fhir },
            { label: "狀態", value: d.status || m?.status ? <StatusBadge status={d.status || m?.status} /> : null },
            { label: "發行者", value: m?.publisher, hidden: !o },
            { label: "授權", value: m?.license ? <Badge variant="outline" color="gray" tt="none">{m.license}</Badge> : null, hidden: !o },
            { label: "發布日期", value: m?.date ? m.date.slice(0, 10) : null, hidden: !m?.date },
            { label: "聯絡", value: m?.contact?.join("、"), hidden: !m?.contact?.length },
            { label: "適用地區", value: m?.jurisdiction?.map((j) => j.display || j.code).join("、"), hidden: !m?.jurisdiction?.length },
            { label: "匯入時間", value: <RelativeTime value={d.imported_at} fz="sm" /> },
            {
              label: "安裝方式",
              value: d.install_origin ? (
                <Stack gap={2}>
                  <OriginBadge origin={d.install_origin} />
                  {d.install_origin === "dependency" && d.installed_for && (
                    <Text fz="xs" c="dimmed" style={{ wordBreak: "break-word" }}>
                      由 {d.installed_for.title || d.installed_for.package_id}（{d.installed_for.package_id}@{d.installed_for.version}）帶入{d.installed_for.installed ? "" : "（該 IG 已移除）"}
                    </Text>
                  )}
                </Stack>
              ) : null,
            },
            { label: "版權", value: m?.copyright ? <Markdown clamp>{m.copyright}</Markdown> : null, full: true, hidden: !m?.copyright },
          ]}
        />
        {m?.pages && m.pages.length > 0 && (
          <Box>
            <Text fz="xs" c="dimmed" fw={600} mb={4}>
              指引章節
            </Text>
            <Group gap={4}>
              {m.pages.map((p) => (
                <Badge key={p} variant="default" tt="none" fw={500}>
                  {p}
                </Badge>
              ))}
            </Group>
          </Box>
        )}
      </Stack>
    </SectionCard>
  );
}

function DepTreeNode({ n, root, onOpenIg, showRepeated }: { n: PackageNode; root?: boolean; onOpenIg: (r: IgRef) => void; showRepeated: boolean }) {
  const kids = showRepeated ? n.children : n.children.filter((c) => !c.repeated);
  const label = `${n.package_id}@${n.version}`;
  const clickable = n.installed && !root;
  const chip = (
    <span className={classes.depNode} data-missing={!n.installed || undefined} data-repeated={n.repeated || undefined} data-root={root || undefined}>
      <ThemeIcon size={18} radius="xl" variant="light" color={!n.installed ? "amber" : root ? "brand" : "teal"}>
        {!n.installed ? <IconCircleDashed size={11} /> : n.repeated ? <IconRepeat size={11} /> : <IconCircleCheck size={11} />}
      </ThemeIcon>
      <Text span fz="xs" ff="monospace" style={{ wordBreak: "break-all" }}>
        {n.package_id}
        <Text span c="dimmed" ff="monospace" fz="xs">
          @{n.version}
        </Text>
      </Text>
      {n.declared_version && (
        <Tooltip label={`宣告 ${n.declared_version}（從未發佈），實際使用 ${n.version}`} withArrow>
          <Badge size="xs" variant="outline" color="gray">
            alias
          </Badge>
        </Tooltip>
      )}
      {!n.installed && (
        <Badge size="xs" color="amber" variant="light">
          未安裝
        </Badge>
      )}
    </span>
  );
  return (
    <li>
      {clickable ? (
        <Tooltip label={`${n.title ?? label}${n.repeated ? "（上方已列出其相依）" : ""}・點選開啟`} withArrow openDelay={300}>
          <UnstyledButton onClick={() => onOpenIg({ package_id: n.package_id, version: n.version })} aria-label={`開啟 ${label}`} style={{ maxWidth: "100%" }}>
            {chip}
          </UnstyledButton>
        </Tooltip>
      ) : (
        chip
      )}
      {kids.length > 0 && (
        <ul>
          {kids.map((c) => (
            <DepTreeNode key={`${c.package_id}@${c.version}`} n={c} onOpenIg={onOpenIg} showRepeated={showRepeated} />
          ))}
        </ul>
      )}
    </li>
  );
}

function DependencyCard({ detail: d, o, onOpenDeps, onOpenIg }: { detail: IgDetail; o: IgOverview | undefined; onOpenDeps: () => void; onOpenIg: (r: IgRef) => void }) {
  const closure = o?.closure ?? [];
  const missing = d.deps_missing.length;
  const [showRepeated, setShowRepeated] = useState(false);
  return (
    <SectionCard
      title="相依套件"
      icon={<IconHierarchy2 size={18} />}
      description={o ? `直接 ${d.dependencies.length} 個 · 遞移共 ${closure.length} 個${missing ? ` · 缺少 ${missing} 個` : " · 全部已安裝"}` : undefined}
      actions={
        missing > 0 ? (
          <Button size="xs" variant="light" color="amber" leftSection={<IconCloudDownload size={14} />} onClick={onOpenDeps}>
            補齊相依（{missing}）
          </Button>
        ) : undefined
      }
    >
      <Stack gap="md">
        {!o ? (
          <Skeleton h={160} />
        ) : o.dependency_tree.children.length === 0 ? (
          <Text fz="sm" c="dimmed">
            沒有宣告相依套件。
          </Text>
        ) : (
          <Box style={{ overflowX: "auto" }}>
            <ul className={classes.depTree} aria-label="相依樹">
              <DepTreeNode n={o.dependency_tree} root onOpenIg={onOpenIg} showRepeated={showRepeated} />
            </ul>
          </Box>
        )}
        {missing > 0 && (
          <Alert color="amber" p="sm" icon={<IconAlertTriangle size={16} />}>
            <Text fz="xs">缺少的套件會讓術語驗證與 ValueSet 展開缺代碼。可從 Registry 下載，或上傳該套件的 package.tgz。</Text>
          </Alert>
        )}
        <Group gap="lg" fz="xs" c="dimmed">
          <Group gap={4}>
            <IconCircleCheck size={13} color="var(--mantine-color-teal-6)" /> 已安裝
          </Group>
          <Group gap={4}>
            <IconCircleDashed size={13} color="var(--mantine-color-amber-6)" /> 未安裝
          </Group>
          <Switch size="xs" checked={showRepeated} onChange={(e) => setShowRepeated(e.currentTarget.checked)} label={<Group gap={4}><IconRepeat size={13} /> 顯示重複出現的相依</Group>} />
        </Group>
        <Box>
          <Text fz="sm" fw={600} mb={6}>
            被哪些 IG 依賴（{o?.dependents.length ?? d.dependents.length}）
          </Text>
          {(o?.dependents ?? d.dependents).length === 0 ? (
            <Text fz="sm" c="dimmed">
              沒有其他已安裝的 IG 依賴它。
            </Text>
          ) : (
            <Group gap={6}>
              {(o?.dependents ?? d.dependents.map((x) => ({ ...x, title: null }))).map((x) => (
                <Tooltip key={`${x.package_id}@${x.version}`} label={x.title ?? `${x.package_id}@${x.version}`} withArrow openDelay={300}>
                  <Button size="compact-sm" variant="default" leftSection={<IconPackage size={13} />} onClick={() => onOpenIg(x)} ff="monospace" fw={500}>
                    {x.package_id}@{x.version}
                  </Button>
                </Tooltip>
              ))}
            </Group>
          )}
        </Box>
      </Stack>
    </SectionCard>
  );
}

function SupportCell({ s, counts }: { s: ExternalSystem; counts: Record<string, number> }) {
  const sup = s.support;
  if (sup?.module) {
    const loaded = (counts[sup.module] ?? 0) > 0;
    return (
      <Group gap={6} wrap="nowrap">
        <Badge variant="light" color={loaded ? "teal" : "amber"} leftSection={loaded ? <IconCircleCheck size={11} /> : <IconCircleDashed size={11} />}>
          {loaded ? "模組已載入" : "模組未匯入"}
        </Badge>
        <Anchor component={Link} to={moduleHref(sup.module)} fz="xs">
          {sup.label}
        </Anchor>
      </Group>
    );
  }
  if (sup?.builtin) {
    return (
      <Badge variant="light" color="indigo">
        內建驗證
      </Badge>
    );
  }
  const def = s.defined_in;
  if (def && def.content !== "not-present") {
    return (
      <Tooltip label={`${def.package_id}@${def.version} · content = ${def.content ?? "—"} · ${fmtNumber(def.concept_count)} 個概念`} withArrow multiline maw={360}>
        <Badge variant="light" color={def.in_closure ? "teal" : "gray"} leftSection={<IconPackages size={11} />} tt="none" style={{ maxWidth: 260 }}>
          {def.in_closure ? "相依套件提供" : "其他 IG 提供"}：{def.package_id}
        </Badge>
      </Tooltip>
    );
  }
  return (
    <Tooltip label="沒有對應的術語模組，已安裝的套件也不含其代碼；這個系統的代碼不會被驗證。" withArrow multiline maw={300}>
      <Badge variant="light" color="red" leftSection={<IconAlertTriangle size={11} />}>
        無法驗證
      </Badge>
    </Tooltip>
  );
}

function ExternalSystemsCard({ o }: { o: IgOverview | undefined }) {
  const catalog = useModulesCatalog();
  const counts = catalog.data?.record_counts ?? {};
  const list = o?.external_systems ?? [];
  return (
    <SectionCard
      title={`引用的外部代碼系統${o ? `（${list.length}）` : ""}`}
      icon={<IconWorld size={18} />}
      description="ValueSet 引用、但不屬於此 IG 自己 CodeSystem 的系統，以及驗證這些代碼所需的模組或套件。"
      flush
    >
      {!o ? (
        <Box p="lg">
          <Skeleton h={120} />
        </Box>
      ) : list.length === 0 ? (
        <EmptyState compact title="沒有引用外部代碼系統" />
      ) : (
        <Box style={{ overflowX: "auto" }}>
          <Table verticalSpacing="sm" horizontalSpacing="lg" miw={640} highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>代碼系統</Table.Th>
                <Table.Th style={{ textAlign: "right" }}>ValueSet</Table.Th>
                <Table.Th>驗證來源</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((s) => (
                <Table.Tr key={s.system}>
                  <Table.Td style={{ maxWidth: 420 }}>
                    <Text fz="sm" fw={600}>
                      {s.support?.label ?? tail(s.system)}
                    </Text>
                    <CopyText value={s.system} mono truncate />
                  </Table.Td>
                  <Table.Td style={{ textAlign: "right" }} className="tabular">
                    {fmtNumber(s.valuesets)}
                  </Table.Td>
                  <Table.Td>
                    <SupportCell s={s} counts={counts} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      )}
    </SectionCard>
  );
}

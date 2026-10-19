import { Alert, Anchor, Badge, Box, Button, Drawer, Group, Skeleton, SimpleGrid, Spoiler, Stack, Table, Tabs, Text, Tooltip } from "@mantine/core";
import { useMediaQuery, useViewportSize } from "@mantine/hooks";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconBinaryTree2,
  IconBox,
  IconBraces,
  IconFileCode,
  IconForms,
  IconHierarchy3,
  IconListCheck,
  IconPuzzle,
  IconSitemap,
} from "@tabler/icons-react";
import { useCallback, useMemo, useState, useEffect, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { CopyText } from "@/components/CopyText";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { KeyValue } from "@/components/KeyValue";
import { PageHeader } from "@/components/PageHeader";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { ApiError } from "@/lib/api";
import { useIsMobile } from "@/lib/hooks";
import { ElementDetail } from "./ElementDetail";
import { ElementTree, type TreeReveal } from "./ElementTree";
import { ExamplesTab } from "./ExamplesTab";
import { igHref, profileElementHref, profileHref } from "./links";
import { Prose, TypeList } from "./parts";
import { useProfileView, useRequiredElements, type ProfileRef } from "./profileApi";
import type { ProfileView, RequiredRow } from "./profileTypes";
import { RequiredTab } from "./RequiredTab";
import { SkeletonTab } from "./SkeletonTab";
import { indexRows, TREE_VIEWS, type TreeView } from "./treeModel";
import classes from "./profile.module.css";

const TABS = ["elements", "required", "skeleton", "examples"] as const;
type Tab = (typeof TABS)[number];

function safeDecode(v: string | undefined): string {
  if (!v) return "";
  try {
    return v.includes("%") ? decodeURIComponent(v) : v;
  } catch {
    return v;
  }
}

/**
 * FHIR Profile viewer: one StructureDefinition (profile, extension, logical model, data
 * type constraint) of an installed IG — header + base chain, an IG-Publisher-style element
 * tree with a detail panel, and the exact required-elements / skeleton output the MCP tools
 * give an LLM. All view state lives in the URL (tab, view, q, el).
 */
export default function ProfilePage() {
  const params = useParams();
  const ref: ProfileRef = useMemo(
    () => ({ packageId: safeDecode(params.packageId), version: safeDecode(params.version), artifactId: safeDecode(params.artifactId) }),
    [params.packageId, params.version, params.artifactId],
  );
  const viewQ = useProfileView(ref);

  if (viewQ.isPending) return <ProfileSkeleton />;
  if (viewQ.isError) {
    const notFound = viewQ.error instanceof ApiError && viewQ.error.status === 404;
    return (
      <>
        <PageHeader title={ref.artifactId} icon={<IconHierarchy3 size={24} />} breadcrumbs={[{ label: "IG 套件庫", to: "/fhir/ig" }, { label: `${ref.packageId}@${ref.version}`, to: igHref(ref.packageId, ref.version) }, { label: ref.artifactId }]} />
        {notFound ? (
          <EmptyState
            icon={<IconAlertTriangle size={28} />}
            title="找不到這個 Profile"
            description={`${ref.packageId}@${ref.version} 內沒有 id 為「${ref.artifactId}」的 StructureDefinition。連結可能已過期，或 IG 已被移除／更換版本。`}
            action={
              <Button component={Link} to={igHref(ref.packageId, ref.version)} variant="light" leftSection={<IconArrowLeft size={16} />}>
                回到 IG 套件庫
              </Button>
            }
          />
        ) : (
          <ErrorState error={viewQ.error} onRetry={() => void viewQ.refetch()} title="無法載入 Profile" />
        )}
      </>
    );
  }
  return <ProfileContent key={`${ref.packageId}|${ref.version}|${ref.artifactId}`} ref_={ref} view={viewQ.data} />;
}

function kindIcon(v: ProfileView, size = 24): ReactNode {
  if (v.meta.type === "Extension") return <IconPuzzle size={size} />;
  if (v.profile.kind === "logical") return <IconBox size={size} />;
  if (v.profile.kind === "complex-type" || v.profile.kind === "primitive-type") return <IconBraces size={size} />;
  return <IconHierarchy3 size={size} />;
}

const KIND_ZH: Record<string, string> = { resource: "資源", "complex-type": "資料型別", "primitive-type": "基本型別", logical: "邏輯模型" };
const DERIV_ZH: Record<string, string> = { constraint: "約束 Profile", specialization: "特化定義" };

function ProfileContent({ ref_: ref, view }: { ref_: ProfileRef; view: ProfileView }) {
  const [sp, setSp] = useSearchParams();
  const isMobile = useIsMobile();
  const wide = useMediaQuery("(min-width: 75em)") ?? false;
  const { height: vh } = useViewportSize();
  const tabParam = sp.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as Tab) : "elements";
  const viewParam = sp.get("view");
  const treeView: TreeView = (TREE_VIEWS as readonly string[]).includes(viewParam ?? "") ? (viewParam as TreeView) : "snapshot";
  const q = sp.get("q") ?? "";
  const el = sp.get("el");

  const patch = useCallback(
    (p: Record<string, string | null>, push = false) => {
      setSp(
        (cur) => {
          const next = new URLSearchParams(cur);
          for (const [k, v] of Object.entries(p)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: !push },
      );
    },
    [setSp],
  );

  const idx = useMemo(() => indexRows(view.elements), [view.elements]);
  const hasSnapshot = view.element_source === "snapshot";
  const reqQ = useRequiredElements(ref, "compact", false, hasSnapshot);
  const reqRows = reqQ.data?.data?.elements;
  const required = useMemo(() => new Set((reqRows ?? []).map((r) => r.id)), [reqRows]);
  const reqById = useMemo(() => new Map<string, RequiredRow>((reqRows ?? []).map((r) => [r.id, r])), [reqRows]);

  const [reveal, setReveal] = useState<TreeReveal | null>(() => (el ? { id: el, nonce: 1 } : null));
  const jump = useCallback(
    (id: string) => {
      patch({ tab: null, el: id }, true);
      setReveal((r) => ({ id, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [patch],
  );
  // Back/forward to another ?el= → reveal it too.
  useEffect(() => {
    if (el && reveal?.id !== el) setReveal((r) => ({ id: el, nonce: (r?.nonce ?? 0) + 1 }));
  }, [el]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = el ? (idx.byId.get(el) ?? null) : null;
  const p = view.profile;
  const meta = view.meta;
  const depsMissing = p.deps_missing ?? [];
  const title = p.title || p.name || p.artifactId || ref.artifactId;
  const stats = useMemo(
    () => ({
      ms: view.elements.filter((r) => r.mustSupport).length,
      slices: view.elements.filter((r) => r.sliceName).length,
      constraints: view.elements.reduce((n, r) => n + r.constraintCount, 0),
      diff: view.elements.filter((r) => r.inDiff).length,
    }),
    [view.elements],
  );
  const treeHeight = Math.max(420, Math.min(900, (vh || 800) - (isMobile ? 200 : 260)));
  const deepLink = selected ? `${window.location.origin}/admin${profileElementHref(ref.packageId, ref.version, ref.artifactId, selected.id)}` : "";
  const detail = selected ? (
    <ElementDetail
      row={selected}
      links={view.links}
      packageId={ref.packageId}
      version={ref.version}
      requiredRow={reqById.get(selected.id)}
      deepLink={deepLink}
      onClose={() => patch({ el: null })}
      onJump={jump}
    />
  ) : null;

  return (
    <>
      <PageHeader
        title={title}
        icon={kindIcon(view)}
        breadcrumbs={[{ label: "IG 套件庫", to: "/fhir/ig" }, { label: `${ref.packageId}@${ref.version}`, to: igHref(ref.packageId, ref.version) }, { label: p.artifactId ?? ref.artifactId }]}
        badge={
          <Group gap={6}>
            {p.status && (
              <Badge variant="light" color={p.status === "active" ? "teal" : p.status === "retired" ? "gray" : "amber"}>
                {p.status}
              </Badge>
            )}
            {meta.experimental && <Badge variant="outline" color="amber">experimental</Badge>}
            {meta.abstract && <Badge variant="outline" color="gray">abstract</Badge>}
          </Group>
        }
        description={
          <Group gap={6} component="span" wrap="wrap">
            <Badge component="span" variant="default" radius="sm" tt="none">
              {meta.type === "Extension" ? "擴充定義 Extension" : (KIND_ZH[p.kind ?? ""] ?? p.kind ?? "—")}
            </Badge>
            {p.derivation && (
              <Badge component="span" variant="default" radius="sm" tt="none">
                {DERIV_ZH[p.derivation] ?? p.derivation}
              </Badge>
            )}
            {p.baseType && (
              <Badge component="span" variant="light" radius="sm" tt="none" color="indigo">
                {p.baseType}
              </Badge>
            )}
            <Text span fz="xs" c="dimmed" ff="monospace">
              {p.artifactId}
            </Text>
          </Group>
        }
        actions={
          <Button component={Link} to={igHref(ref.packageId, ref.version)} variant="default" leftSection={<IconArrowLeft size={16} />}>
            回到 IG
          </Button>
        }
      />

      <Stack gap="md">
        {depsMissing.length > 0 && (
          <Alert variant="light" color="amber" icon={<IconAlertTriangle size={18} />} title={`這個 IG 缺少 ${depsMissing.length} 個相依套件`}>
            <Text fz="sm">型別連結、ValueSet 展開、繼承鏈與必填判斷可能不完整：{depsMissing.slice(0, 4).map((d) => `${d.package_id}@${d.version}`).join("、")}{depsMissing.length > 4 ? " 等" : ""}。</Text>
            <Button component={Link} to={igHref(ref.packageId, ref.version, { fixDeps: true })} size="xs" variant="light" color="amber" mt="xs">
              補齊相依套件
            </Button>
          </Alert>
        )}
        {view.warnings.length > 0 && (
          <Alert variant="light" color="gray" icon={<IconAlertTriangle size={18} />} title="解析提示">
            {view.warnings.map((w) => (
              <Text key={w} fz="xs">
                {w}
              </Text>
            ))}
          </Alert>
        )}
        {!hasSnapshot && (
          <Alert variant="light" color="red" icon={<IconAlertTriangle size={18} />} title="這個 StructureDefinition 沒有 snapshot">
            <Text fz="sm">
              {view.element_source === "differential"
                ? "下方只能顯示 differential（此 Profile 修改的元素）；必填欄位與骨架需要 snapshot，LLM 呼叫 fhir_get_profile_required_elements 也會得到錯誤。"
                : "套件內沒有任何元素定義。"}
              請改用 IG Publisher 發布的 package.tgz（內含 snapshot）重新安裝這個 IG。
            </Text>
          </Alert>
        )}

        <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
          <StatCard label="元素" value={view.elements.length} hint={hasSnapshot ? "snapshot" : view.element_source} icon={<IconBinaryTree2 size={20} />} />
          <StatCard label="此 Profile 修改" value={view.differential_count} hint="differential 元素" color="brand" onClick={view.differential_count ? () => patch({ tab: null, view: "diff" }) : undefined} ariaLabel="只看 differential" />
          <StatCard label="Must Support" value={stats.ms} color="red" onClick={() => patch({ tab: null, view: "key" })} ariaLabel="看關鍵元素" />
          <StatCard label="LLM 必填" value={reqQ.data?.data?.count ?? (hasSnapshot ? "…" : "—")} color="red" hint="required elements" loading={reqQ.isPending && hasSnapshot} onClick={hasSnapshot ? () => patch({ tab: "required" }, true) : undefined} ariaLabel="看必填欄位" />
          <StatCard label="切片" value={stats.slices} color="violet" />
          <StatCard label="約束規則" value={stats.constraints} color="grape" hint="不含 ele-1" />
        </SimpleGrid>

        <SectionCard title="定義資訊" icon={<IconFileCode size={18} />}>
          <Stack gap="md">
            <KeyValue
              cols={3}
              items={[
                { label: "Canonical", value: <CopyText value={p.canonical ?? meta.url ?? ""} mono />, full: true },
                { label: "版本", value: meta.version },
                { label: "IG 套件", value: <Anchor component={Link} to={igHref(ref.packageId, ref.version)} fz="sm">{ref.packageId}@{ref.version}</Anchor> },
                { label: "FHIR 版本", value: meta.fhirVersion },
                { label: "名稱（name）", value: <Text fz="sm" ff="monospace">{p.name}</Text> },
                { label: "發布者", value: meta.publisher },
                { label: "日期", value: meta.date },
              ]}
            />
            {(p.description || meta.purpose) && (
              <Spoiler maxHeight={88} showLabel="顯示更多" hideLabel="收合">
                {p.description && <Prose>{p.description}</Prose>}
                {meta.purpose && (
                  <Box mt="xs">
                    <Text fz="xs" c="dimmed" fw={600}>
                      目的
                    </Text>
                    <Prose>{meta.purpose}</Prose>
                  </Box>
                )}
              </Spoiler>
            )}
          </Stack>
        </SectionCard>

        <SectionCard title="繼承鏈" icon={<IconSitemap size={18} />} description="從 FHIR 基礎定義到這個 Profile 的 baseDefinition 鏈。">
          <BaseChain view={view} />
          {view.derived.items.length > 0 && (
            <Box mt="md">
              <Text fz="xs" fw={700} c="dimmed" mb={6}>
                以此為基礎的 Profile（{view.derived.items.length}
                {view.derived.truncated ? "+" : ""}，所有已安裝 IG）
              </Text>
              <Spoiler maxHeight={64} showLabel="顯示全部" hideLabel="收合">
                <Group gap={6}>
                  {view.derived.items.map((d) => (
                    <Tooltip key={`${d.package_id}@${d.version}/${d.artifact_id}`} label={`${d.package_id}@${d.version}`}>
                      <Badge component={Link} to={profileHref(d.package_id, d.version, d.artifact_id)} variant="light" color="gray" tt="none" radius="sm" style={{ cursor: "pointer" }}>
                        {d.title ?? d.artifact_id}
                      </Badge>
                    </Tooltip>
                  ))}
                </Group>
              </Spoiler>
            </Box>
          )}
        </SectionCard>

        {view.extension && <ExtensionCard view={view} />}

        <Tabs
          value={tab}
          onChange={(v) => patch({ tab: !v || v === "elements" ? null : v }, true)}
          keepMounted={false}
        >
          <Box style={{ overflowX: "auto", overflowY: "hidden" }} mb="md">
            <Tabs.List style={{ flexWrap: "nowrap", minWidth: "max-content" }}>
              <Tabs.Tab value="elements" leftSection={<IconBinaryTree2 size={16} />}>
                元素
              </Tabs.Tab>
              <Tabs.Tab value="required" leftSection={<IconListCheck size={16} />} disabled={!hasSnapshot}>
                必填欄位
              </Tabs.Tab>
              <Tabs.Tab value="skeleton" leftSection={<IconForms size={16} />} disabled={!hasSnapshot}>
                骨架
              </Tabs.Tab>
              <Tabs.Tab
                value="examples"
                leftSection={<IconFileCode size={16} />}
                rightSection={
                  view.examples.count ? (
                    <Badge size="xs" variant="light" color="gray" circle={view.examples.count < 10}>
                      {view.examples.count}
                    </Badge>
                  ) : null
                }
              >
                範例
              </Tabs.Tab>
            </Tabs.List>
          </Box>

          <Tabs.Panel value="elements">
            <div className={classes.split} data-panel={(wide && selected) || undefined}>
              <div className={classes.panel}>
                <ElementTree
                  idx={idx}
                  links={view.links}
                  required={required}
                  view={treeView}
                  onView={(v) => patch({ view: v === "snapshot" ? null : v })}
                  query={q}
                  onQuery={(t) => patch({ q: t || null })}
                  selectedId={selected?.id ?? null}
                  onSelect={(id) => patch({ el: id })}
                  reveal={reveal}
                  diffAvailable={view.differential_count > 0}
                  height={treeHeight}
                />
              </div>
              {wide && selected && (
                <div key={selected.id} className={`${classes.panel} ${classes.sticky}`}>
                  {detail}
                </div>
              )}
            </div>
            {el && !selected && (
              <Text fz="xs" c="dimmed" mt="xs">
                找不到元素「{el}」。
              </Text>
            )}
            <Legend />
          </Tabs.Panel>
          <Tabs.Panel value="required">{hasSnapshot && <RequiredTab profile={ref} knownIds={new Set(idx.byId.keys())} onJump={jump} />}</Tabs.Panel>
          <Tabs.Panel value="skeleton">{hasSnapshot && <SkeletonTab profile={ref} links={view.links} />}</Tabs.Panel>
          <Tabs.Panel value="examples">
            <ExamplesTab packageId={ref.packageId} version={ref.version} examples={view.examples.examples} />
          </Tabs.Panel>
        </Tabs>
      </Stack>

      <Drawer
        opened={!wide && Boolean(selected) && tab === "elements"}
        onClose={() => patch({ el: null })}
        position={isMobile ? "bottom" : "right"}
        size={isMobile ? "88%" : 460}
        withCloseButton={false}
        padding={0}
        styles={{ body: { height: "100%", display: "flex", flexDirection: "column" }, content: isMobile ? { borderTopLeftRadius: 16, borderTopRightRadius: 16 } : undefined }}
      >
        {detail}
      </Drawer>
    </>
  );
}

function BaseChain({ view }: { view: ProfileView }) {
  const chain = view.base_chain;
  return (
    <div className={classes.chain}>
      {chain.map((c, i) => {
        const current = i === chain.length - 1;
        const body = (
          <>
            <Text fz="sm" fw={600} truncate>
              {c.title ?? c.artifact_id ?? c.canonical}
            </Text>
            <Text fz={11} c="dimmed" truncate>
              {c.installed ? `${c.package_id}@${c.version}` : "未安裝"}
              {c.derivation ? ` · ${c.derivation}` : ""}
            </Text>
          </>
        );
        return (
          <Group key={c.canonical} gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            {i > 0 && <IconArrowRight size={14} className={classes.chainArrow} />}
            {current || !c.installed || !c.package_id || !c.version || !c.artifact_id ? (
              <Tooltip label={c.canonical} multiline maw={420} openDelay={300}>
                <div className={classes.chainNode} data-current={current || undefined} data-missing={!c.installed || undefined} style={{ animationDelay: `${i * 60}ms` }}>
                  {body}
                </div>
              </Tooltip>
            ) : (
              <Tooltip label={c.canonical} multiline maw={420} openDelay={300}>
                <Link to={profileHref(c.package_id, c.version, c.artifact_id)} className={classes.chainNode} style={{ animationDelay: `${i * 60}ms` }}>
                  {body}
                </Link>
              </Tooltip>
            )}
          </Group>
        );
      })}
    </div>
  );
}

function ExtensionCard({ view }: { view: ProfileView }) {
  const x = view.extension!;
  return (
    <SectionCard title="擴充定義" icon={<IconPuzzle size={18} />} description={x.complex ? "複合擴充：由下列子擴充組成，本身沒有 value[x]。" : "簡單擴充：只有一個 value[x]。"}>
      <Stack gap="md">
        <KeyValue
          cols={2}
          items={[
            {
              label: "可使用的位置（context）",
              value: x.context.length ? (
                <Group gap={4}>
                  {x.context.map((c) => (
                    <Tooltip key={`${c.type}:${c.expression}`} label={`type: ${c.type}`}>
                      <Badge variant="light" color="cyan" tt="none" ff="monospace">
                        {c.expression}
                      </Badge>
                    </Tooltip>
                  ))}
                </Group>
              ) : null,
            },
            {
              label: "value[x] 型別",
              value: x.valueTypes.length ? (
                <Text fz="sm" ff="monospace">
                  <TypeList types={x.valueTypes} links={view.links} />
                </Text>
              ) : (
                <Text fz="sm" c="dimmed">
                  無（複合擴充）
                </Text>
              ),
            },
            { label: "context 規則", value: x.contextInvariant.length ? <Text fz="xs" ff="monospace">{x.contextInvariant.join("\n")}</Text> : null, hidden: !x.contextInvariant.length },
          ]}
        />
        {x.subExtensions.length > 0 && (
          <Box style={{ overflowX: "auto" }}>
            <Table verticalSpacing={6} miw={520}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>子擴充</Table.Th>
                  <Table.Th>基數</Table.Th>
                  <Table.Th>value 型別</Table.Th>
                  <Table.Th>說明</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {x.subExtensions.map((s) => (
                  <Table.Tr key={s.sliceName}>
                    <Table.Td ff="monospace" fz="xs">
                      {s.sliceName}
                      {s.url && s.url !== s.sliceName && (
                        <Text fz={11} c="dimmed" style={{ wordBreak: "break-all" }}>
                          {s.url}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ff="monospace" fz="xs" c={(s.min ?? 0) >= 1 ? "red" : undefined}>
                      {s.min}..{s.max}
                    </Table.Td>
                    <Table.Td ff="monospace" fz="xs">
                      {s.valueTypes.join(" | ") || "—"}
                    </Table.Td>
                    <Table.Td fz="xs">{s.short}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Stack>
    </SectionCard>
  );
}

function Legend() {
  const item = (cls: string, g: string, label: string) => (
    <Group gap={4} wrap="nowrap">
      <span className={`${classes.flag} ${cls}`}>{g}</span>
      <Text fz="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  );
  return (
    <Group gap="md" mt="sm" wrap="wrap">
      {item(classes.flagReq, "必", "LLM 必填")}
      {item(classes.flagMs, "MS", "Must Support")}
      {item(classes.flagMod, "?!", "修飾元素")}
      {item(classes.flagSum, "Σ", "摘要")}
      {item(classes.flagInv, "I", "約束規則")}
      {item(classes.flagFix, "F/P", "固定值 / Pattern")}
      <Group gap={4} wrap="nowrap">
        <Text fz="xs" ff="monospace" className={classes.cardChanged}>
          0..1
        </Text>
        <Text fz="xs" c="dimmed">
          基數與基礎定義不同
        </Text>
      </Group>
    </Group>
  );
}

function ProfileSkeleton() {
  return (
    <Stack gap="md">
      <Group gap="md">
        <Skeleton h={44} w={44} radius="md" />
        <Stack gap={6} style={{ flex: 1 }}>
          <Skeleton h={12} w={220} />
          <Skeleton h={26} w="40%" />
          <Skeleton h={14} w="30%" />
        </Stack>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} h={88} radius="lg" />
        ))}
      </SimpleGrid>
      <Skeleton h={160} radius="lg" />
      <Skeleton h={96} radius="lg" />
      <Box className={classes.panel} p="sm">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} h={22} mb={12} ml={(i % 4) * 16} w={`${70 - (i % 5) * 8}%`} radius="sm" style={{ opacity: 1 - i * 0.06 }} />
        ))}
      </Box>
    </Stack>
  );
}

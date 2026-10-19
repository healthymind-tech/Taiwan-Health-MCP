import { Alert, Anchor, Badge, Box, Button, Drawer, Group, Pagination, Skeleton, Stack, Table, Tabs, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconArrowRight, IconBraces, IconExternalLink, IconFileDescription, IconListTree } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CopyText } from "@/components/CopyText";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { KeyValue } from "@/components/KeyValue";
import { api, qs } from "@/lib/api";
import { fmtBytes, fmtNumber } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import type { IgPreviewPayload, IgRef } from "../igTypes";
import { profileHref } from "../profile/links";
import { useIgArtifact, type ArtifactFull, type CmDigest, type ExampleDigest, type SdDigest, type SpDigest, type VsDigest } from "./explorerApi";
import { CATEGORY_META, CanonicalRef, Markdown, StatusBadge, tail } from "./detailMeta";
import { JsonTree } from "./JsonTree";
import classes from "./detail.module.css";

const PER_PAGE = 25;

/** ValueSet members, expanded by the existing IG preview (compose + local / module code systems). */
function ExpansionPreview({ ig, artifactKey }: { ig: IgRef; artifactKey: string }) {
  const [page, setPage] = useState(1);
  const params = { package_id: ig.package_id, package_version: ig.version, node: `artifact:${artifactKey}`, page: String(page), per_page: String(PER_PAGE) };
  const q = useQuery({
    queryKey: ["preview", "ig", params],
    queryFn: () => api.get<IgPreviewPayload>("/admin/api/modules/ig/preview" + qs(params)),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isPending) return <Skeleton h={160} />;
  const rows = (q.data?.rows ?? []) as Record<string, string>[];
  const total = Number(q.data?.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (total === 0) return <EmptyState compact title="無法在本機展開" description="ValueSet 引用的代碼系統沒有已匯入的內容（例如 not-present 或模組未匯入）。" />;
  return (
    <Stack gap="xs">
      <Text fz="xs" c="dimmed">
        共 {fmtNumber(total)} 個代碼（本機展開預覽，大型 filter 可能只取前段）
      </Text>
      <Box style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)", overflowX: "auto", opacity: q.isPlaceholderData ? 0.6 : 1, transition: "opacity 150ms" }}>
        <Table verticalSpacing={6} miw={460} striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Code</Table.Th>
              <Table.Th>Display</Table.Th>
              <Table.Th>System</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r, i) => (
              <Table.Tr key={`${r.system}|${r.code}|${i}`}>
                <Table.Td>
                  <Text ff="monospace" fz="xs" fw={600}>
                    {r.code || "—"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text fz="xs">{r.display || "—"}</Text>
                </Table.Td>
                <Table.Td>
                  <Tooltip label={r.system} disabled={!r.system} openDelay={300}>
                    <Text fz="xs" ff="monospace" c="dimmed">
                      {r.system ? tail(r.system) : "—"}
                    </Text>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
      {pages > 1 && (
        <Group justify="flex-end">
          <Pagination size="sm" total={pages} value={page} onChange={setPage} siblings={0} />
        </Group>
      )}
    </Stack>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap={6}>
      <Text fz="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: 0.4 }}>
        {title}
      </Text>
      {children}
    </Stack>
  );
}

function Summary({ ig, a, onOpenArtifact, onOpenCodeSystem }: { ig: IgRef; a: ArtifactFull; onOpenArtifact: (k: string) => void; onOpenCodeSystem: (csId: string) => void }) {
  const ref = (u: string | null | undefined) => (u ? <CanonicalRef url={u} resolved={a.resolved[u.split("|")[0]]} onOpenArtifact={onOpenArtifact} fz="sm" /> : null);
  const isSd = a.resource_type === "StructureDefinition";
  return (
    <Stack gap="lg">
      {a.description && <Markdown clamp>{a.description}</Markdown>}
      {isSd && (
        <Button component={Link} to={profileHref(ig.package_id, ig.version, a.artifact_id)} rightSection={<IconArrowRight size={14} />} variant="light" w="fit-content">
          開啟 Profile 頁面
        </Button>
      )}
      {a.resource_type === "CodeSystem" && (
        <Button leftSection={<IconListTree size={14} />} variant="light" w="fit-content" onClick={() => onOpenCodeSystem(a.artifact_id)}>
          在 CodeSystem 分頁瀏覽概念
        </Button>
      )}
      <KeyValue
        cols={2}
        items={[
          { label: "Canonical", value: a.canonical_url ? <CopyText value={a.canonical_url} mono /> : null, full: true, hidden: !a.canonical_url },
          { label: "Artifact key", value: <CopyText value={a.artifact_key} mono /> },
          { label: "名稱", value: a.name, hidden: !a.name },
          { label: "套件路徑", value: <Text fz="xs" ff="monospace">{a.package_path}</Text>, hidden: !a.package_path },
          { label: "大小", value: fmtBytes(a.size) },
        ]}
      />
      {isSd && <SdSummary d={a.digest as unknown as SdDigest} a={a} refFn={ref} />}
      {a.resource_type === "ValueSet" && <VsSummary ig={ig} a={a} refFn={ref} />}
      {a.resource_type === "ConceptMap" && <CmSummary d={a.digest as unknown as CmDigest} refFn={ref} />}
      {a.resource_type === "SearchParameter" && <SpSummary d={a.digest as unknown as SpDigest} />}
      {a.category === "example" && <ExampleSummary d={a.digest as unknown as ExampleDigest} refFn={ref} />}
      {a.resource_type === "CapabilityStatement" && Array.isArray(a.digest.rest) && (
        <Section title="REST">
          <Group gap={6}>
            {(a.digest.rest as { mode: string; resources: number }[]).map((r, i) => (
              <Badge key={i} variant="light" color="violet">
                {r.mode} · {r.resources} 個資源
              </Badge>
            ))}
          </Group>
        </Section>
      )}
    </Stack>
  );
}

function SdSummary({ d, a, refFn }: { d: SdDigest; a: ArtifactFull; refFn: (u: string | null) => ReactNode }) {
  return (
    <>
      <KeyValue
        cols={3}
        items={[
          { label: "型別", value: <Text fz="sm" ff="monospace">{d.type}</Text> },
          { label: "基底", value: refFn(d.base_definition), hidden: !d.base_definition },
          { label: "版本", value: d.version, hidden: !d.version },
          { label: "差異元素", value: fmtNumber(d.differential) },
          { label: "Must Support", value: fmtNumber(d.must_support) },
          { label: "必填（min ≥ 1）", value: fmtNumber(d.required) },
          { label: "宣告此 Profile 的範例", value: fmtNumber(a.example_count), hidden: a.category === "logical" },
        ]}
      />
      {a.category === "extension" && (
        <Section title="使用位置與值">
          <Group gap={6}>
            {(d.contexts ?? []).map((c, i) => (
              <Badge key={i} variant="light" color="gray" tt="none" ff="monospace" fw={500}>
                {c.type}: {c.expression}
              </Badge>
            ))}
          </Group>
          <Group gap={6}>
            {d.complex ? (
              <>
                <Badge color="violet" variant="light">
                  複合 Extension
                </Badge>
                {(d.sub_extensions ?? []).map((s) => (
                  <Badge key={s} variant="outline" color="gray" tt="none">
                    {s}
                  </Badge>
                ))}
              </>
            ) : (
              (d.value_types ?? []).map((t) => (
                <Badge key={t} variant="light" color="orange" tt="none" ff="monospace">
                  value{t.charAt(0).toUpperCase() + t.slice(1)}
                </Badge>
              ))
            )}
          </Group>
        </Section>
      )}
    </>
  );
}

function VsSummary({ ig, a, refFn }: { ig: IgRef; a: ArtifactFull; refFn: (u: string | null) => ReactNode }) {
  const d = a.digest as unknown as VsDigest;
  return (
    <>
      <Section title={`Compose（${d.include.length} 個 include${d.exclude ? `、${d.exclude} 個 exclude` : ""}）`}>
        <Box style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)", overflowX: "auto" }}>
          <Table verticalSpacing={8} miw={460}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>代碼系統 / ValueSet</Table.Th>
                <Table.Th>範圍</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {d.include.map((i, idx) => (
                <Table.Tr key={idx}>
                  <Table.Td>
                    <Stack gap={2}>
                      {i.system && refFn(i.system)}
                      {i.system && (
                        <Text fz={11} c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
                          {i.system}
                          {i.version ? `|${i.version}` : ""}
                        </Text>
                      )}
                      {i.value_sets.map((v) => (
                        <Group key={v} gap={4} wrap="nowrap">
                          <Badge size="xs" variant="outline" color="gray">
                            ValueSet
                          </Badge>
                          {refFn(v)}
                        </Group>
                      ))}
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    {i.concepts > 0 ? (
                      <Text fz="xs">列舉 {fmtNumber(i.concepts)} 碼</Text>
                    ) : i.filters.length ? (
                      <Stack gap={2}>
                        {i.filters.map((f, k) => (
                          <Text key={k} className={classes.mono}>
                            {f}
                          </Text>
                        ))}
                      </Stack>
                    ) : i.system ? (
                      <Text fz="xs" c="dimmed">
                        整個代碼系統
                      </Text>
                    ) : null}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      </Section>
      <Section title="展開預覽">
        <ExpansionPreview ig={ig} artifactKey={a.artifact_key} />
      </Section>
    </>
  );
}

function CmSummary({ d, refFn }: { d: CmDigest; refFn: (u: string | null) => ReactNode }) {
  return (
    <Section title="對應">
      <Group gap="xs" wrap="nowrap">
        <Box style={{ minWidth: 0 }}>{refFn(d.source) ?? <Text c="dimmed">—</Text>}</Box>
        <IconArrowRight size={14} />
        <Box style={{ minWidth: 0 }}>{refFn(d.target) ?? <Text c="dimmed">—</Text>}</Box>
      </Group>
      <Box style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)", overflowX: "auto" }}>
        <Table verticalSpacing={6} miw={420}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>來源系統</Table.Th>
              <Table.Th>目標系統</Table.Th>
              <Table.Th style={{ textAlign: "right" }}>來源碼 / 對應</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {d.groups.map((g, i) => (
              <Table.Tr key={i}>
                <Table.Td>{refFn(g.source) ?? "—"}</Table.Td>
                <Table.Td>{refFn(g.target) ?? "—"}</Table.Td>
                <Table.Td style={{ textAlign: "right" }} className="tabular">
                  {fmtNumber(g.elements)} / {fmtNumber(g.targets)}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    </Section>
  );
}

function SpSummary({ d }: { d: SpDigest }) {
  return (
    <>
      <KeyValue
        cols={3}
        items={[
          { label: "Code", value: <Text ff="monospace" fz="sm" fw={600}>{d.code}</Text> },
          { label: "型別", value: d.type },
          { label: "基底資源", value: d.base.join(", ") },
          { label: "目標", value: d.target.join(", "), hidden: !d.target.length },
          { label: "Derived from", value: d.derived_from ? <CopyText value={d.derived_from} mono /> : null, hidden: !d.derived_from, full: true },
        ]}
      />
      {d.expression && (
        <Section title="FHIRPath expression">
          <div className={classes.expr}>{d.expression}</div>
        </Section>
      )}
    </>
  );
}

function ExampleSummary({ d, refFn }: { d: ExampleDigest; refFn: (u: string | null) => ReactNode }) {
  return (
    <Section title="宣告的 Profile（meta.profile）">
      {d.profiles.length === 0 ? (
        <Text fz="sm" c="dimmed">
          沒有宣告 meta.profile。
        </Text>
      ) : (
        <Stack gap={4}>
          {d.profiles.map((p) => (
            <Group key={p} gap={6} wrap="nowrap">
              <IconExternalLink size={13} color="var(--mantine-color-dimmed)" />
              {refFn(p)}
            </Group>
          ))}
        </Stack>
      )}
      {d.coding && (
        <Text fz="sm">
          <Text span c="dimmed" fz="xs">
            代碼{" "}
          </Text>
          <Text span ff="monospace" fz="sm">
            {d.coding.code}
          </Text>{" "}
          {d.coding.display}
        </Text>
      )}
    </Section>
  );
}

/** Side drawer for one artifact (deep-linked by the `art` URL param). */
export function ArtifactDrawer({
  ig,
  artifactKey,
  onClose,
  onOpenArtifact,
  onOpenCodeSystem,
}: {
  ig: IgRef;
  artifactKey: string | null;
  onClose: () => void;
  onOpenArtifact: (key: string) => void;
  onOpenCodeSystem: (csId: string) => void;
}) {
  const isMobile = useIsMobile();
  const q = useIgArtifact(ig, artifactKey);
  const a = q.data;
  const [tab, setTab] = useState<string | null>("summary");
  const meta = a ? CATEGORY_META[a.category] : null;
  return (
    <Drawer
      opened={artifactKey !== null}
      onClose={onClose}
      position="right"
      size={isMobile ? "100%" : 720}
      transitionProps={{ transition: "slide-left", duration: 220, timingFunction: "cubic-bezier(0.2, 0.7, 0.3, 1)" }}
      title={
        a ? (
          <Stack gap={4} className={classes.root}>
            <Group gap={6}>
              <Badge variant="light" color="gray" leftSection={<span className={classes.swatch} style={{ background: meta?.color }} />}>
                {meta?.label}
              </Badge>
              <Badge variant="outline" color="gray" tt="none">
                {a.resource_type}
              </Badge>
              <StatusBadge status={a.status} />
            </Group>
            <Text fw={650} fz="lg" style={{ wordBreak: "break-word" }}>
              {a.title}
            </Text>
          </Stack>
        ) : (
          <Skeleton h={40} w={260} />
        )
      }
    >
      <div className={classes.root}>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !a ? (
          <Stack gap="sm">
            <Skeleton h={18} w="70%" />
            <Skeleton h={120} />
            <Skeleton h={220} />
          </Stack>
        ) : (
          <Tabs value={tab} onChange={setTab} keepMounted={false} key={a.artifact_key}>
            <Tabs.List mb="md">
              <Tabs.Tab value="summary" leftSection={<IconFileDescription size={14} />}>
                摘要
              </Tabs.Tab>
              <Tabs.Tab value="json" leftSection={<IconBraces size={14} />}>
                JSON
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="summary" className={classes.fadeUp}>
              <Summary ig={ig} a={a} onOpenArtifact={onOpenArtifact} onOpenCodeSystem={onOpenCodeSystem} />
            </Tabs.Panel>
            <Tabs.Panel value="json" className={classes.fadeUp}>
              {a.raw_truncated ? (
                <Alert color="amber" icon={<IconAlertTriangle size={16} />}>
                  這個資源有 {fmtBytes(a.size)}，太大無法在瀏覽器顯示。
                </Alert>
              ) : (
                <JsonTree value={a.raw_json} maxHeight={isMobile ? 560 : "calc(100vh - 230px)"} />
              )}
            </Tabs.Panel>
          </Tabs>
        )}
        {a && (
          <Text fz="xs" c="dimmed" mt="lg">
            <Anchor component="button" type="button" fz="xs" onClick={onClose}>
              關閉（Esc）
            </Anchor>
          </Text>
        )}
      </div>
    </Drawer>
  );
}

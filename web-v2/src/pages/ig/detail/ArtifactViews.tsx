import { ActionIcon, Anchor, Badge, Box, Group, SimpleGrid, Stack, Table, Text, Tooltip } from "@mantine/core";
import { IconArrowRight, IconBraces, IconFileCode, IconListTree } from "@tabler/icons-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import { fmtNumber } from "@/lib/format";
import type { IgRef } from "../igTypes";
import { profileHref } from "../profile/links";
import type { ArtifactItem, CmDigest, CsDigest, ExampleDigest, ResolvedRef, SdDigest, SpDigest, VsDigest } from "./explorerApi";
import { CATEGORY_META, CanonicalRef, StatusBadge, tail } from "./detailMeta";
import classes from "./detail.module.css";

export interface ViewProps {
  ig: IgRef;
  items: ArtifactItem[];
  resolved: Record<string, ResolvedRef>;
  activeKey: string | null;
  onOpen: (key: string) => void;
  onOpenCodeSystem: (csId: string) => void;
  /** Items of several groups share one list: label each with its group. */
  showGroup?: boolean;
}

const accent = (it: ArtifactItem): CSSProperties => ({ ["--card-accent" as string]: CATEGORY_META[it.category].color });

/** Secondary "details / JSON" button above a stretched card link. */
function DetailButton({ it, onOpen }: { it: ArtifactItem; onOpen: (k: string) => void }) {
  return (
    <Tooltip label="摘要與 JSON" withArrow openDelay={300}>
      <ActionIcon
        className={classes.above}
        variant="subtle"
        color="gray"
        size="sm"
        onClick={(e) => {
          e.preventDefault();
          onOpen(it.artifact_key);
        }}
        aria-label={`${it.title} 的摘要與 JSON`}
      >
        <IconBraces size={14} />
      </ActionIcon>
    </Tooltip>
  );
}

function Metric({ label, value, hint, color }: { label: string; value: number; hint: string; color?: string }) {
  return (
    <Tooltip label={hint} withArrow openDelay={300}>
      <Box className={classes.above}>
        <Text fz={10} c="dimmed" fw={600} tt="uppercase" style={{ letterSpacing: 0.3 }}>
          {label}
        </Text>
        <Text fz="sm" fw={700} className="tabular" c={value > 0 ? color : "dimmed"}>
          {fmtNumber(value)}
        </Text>
      </Box>
    </Tooltip>
  );
}

/** StructureDefinition card: the whole card opens the profile page. */
function SdCard({ it, ig, active, onOpen, extra }: { it: ArtifactItem; ig: IgRef; active: boolean; onOpen: (k: string) => void; extra?: ReactNode }) {
  const d = it.digest as unknown as SdDigest;
  return (
    <div className={`${classes.card} ${classes.relative}`} style={accent(it)} data-active={active || undefined}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
        <Box style={{ minWidth: 0 }}>
          <Anchor component={Link} to={profileHref(ig.package_id, ig.version, it.artifact_id)} className={classes.stretched} c="inherit" underline="never" fw={650} fz="sm" style={{ wordBreak: "break-word" }}>
            {it.title}
          </Anchor>
          <Text className={classes.mono} c="dimmed">
            {it.artifact_id}
          </Text>
        </Box>
        <Group gap={2} wrap="nowrap">
          <DetailButton it={it} onOpen={onOpen} />
          <IconArrowRight size={14} color="var(--mantine-color-dimmed)" />
        </Group>
      </Group>
      {it.description && (
        <Text fz="xs" c="dimmed" lineClamp={2} mt={6}>
          {it.description}
        </Text>
      )}
      {extra}
      <Group gap="lg" mt="sm" wrap="wrap">
        <Metric label="差異元素" value={d.differential} hint="differential 中的元素數" />
        <Metric label="Must Support" value={d.must_support} hint="differential 中 mustSupport = true 的元素" color="brand" />
        <Metric label="必填" value={d.required} hint="differential 中 min ≥ 1 的元素" color="red" />
        {it.example_count > 0 && <Metric label="範例" value={it.example_count} hint="此 IG 中 meta.profile 宣告此 Profile 的範例數" color="teal" />}
        <Box ml="auto" className={classes.above}>
          <StatusBadge status={it.status} />
        </Box>
      </Group>
    </div>
  );
}

export function ProfileGrid({ ig, items, activeKey, onOpen, showGroup }: ViewProps) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="sm" className={classes.stagger}>
      {items.map((it) => {
        const d = it.digest as unknown as SdDigest;
        const derived = d.base_name && d.base_name !== d.type;
        return (
          <SdCard
            key={it.artifact_key}
            it={it}
            ig={ig}
            active={activeKey === it.artifact_key}
            onOpen={onOpen}
            extra={
              derived || (showGroup && it.group) ? (
                <Group gap={6} mt={6} className={classes.above}>
                  {showGroup && it.group && (
                    <Badge size="xs" variant="light" color="blue" tt="none">
                      {it.group}
                    </Badge>
                  )}
                  {derived && (
                    <Text fz="xs">
                      <Text span c="dimmed" fz="xs">
                        基於{" "}
                      </Text>
                      <Text span ff="monospace" fz="xs">
                        {d.base_name}
                      </Text>
                    </Text>
                  )}
                </Group>
              ) : null
            }
          />
        );
      })}
    </SimpleGrid>
  );
}

export function ExtensionGrid({ ig, items, activeKey, onOpen }: ViewProps) {
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm" className={classes.stagger}>
      {items.map((it) => {
        const d = it.digest as unknown as SdDigest;
        return (
          <SdCard
            key={it.artifact_key}
            it={it}
            ig={ig}
            active={activeKey === it.artifact_key}
            onOpen={onOpen}
            extra={
              <Stack gap={6} mt="sm" className={classes.above}>
                <Group gap={6} wrap="wrap">
                  <Text fz="xs" c="dimmed" w={56}>
                    用於
                  </Text>
                  {(d.contexts ?? []).length === 0 ? (
                    <Text fz="xs" c="dimmed">
                      未宣告
                    </Text>
                  ) : (
                    (d.contexts ?? []).map((c, i) => (
                      <Tooltip key={i} label={`context.type = ${c.type}`} withArrow openDelay={300}>
                        <Badge variant="light" color="gray" tt="none" ff="monospace" fw={500} style={{ maxWidth: "100%" }}>
                          {c.type === "extension" ? tail(c.expression) : c.expression}
                        </Badge>
                      </Tooltip>
                    ))
                  )}
                </Group>
                <Group gap={6} wrap="wrap">
                  <Text fz="xs" c="dimmed" w={56}>
                    值型別
                  </Text>
                  {d.complex ? (
                    <>
                      <Badge variant="light" color="violet">
                        複合 Extension
                      </Badge>
                      {(d.sub_extensions ?? []).map((s) => (
                        <Badge key={s} variant="outline" color="gray" tt="none" ff="monospace" fw={500}>
                          {s}
                        </Badge>
                      ))}
                    </>
                  ) : (d.value_types ?? []).length ? (
                    (d.value_types ?? []).map((t) => (
                      <Badge key={t} variant="light" color="orange" tt="none" ff="monospace" fw={500}>
                        {t}
                      </Badge>
                    ))
                  ) : (
                    <Text fz="xs" c="dimmed">
                      任何型別
                    </Text>
                  )}
                </Group>
              </Stack>
            }
          />
        );
      })}
    </SimpleGrid>
  );
}

function RowCard({ it, active, onClick, children, title, right }: { it: ArtifactItem; active: boolean; onClick: () => void; children?: ReactNode; title?: ReactNode; right?: ReactNode }) {
  return (
    <button type="button" className={classes.card} style={accent(it)} data-active={active || undefined} onClick={onClick}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
        <Box style={{ minWidth: 0 }}>
          <Text fw={650} fz="sm" style={{ wordBreak: "break-word" }}>
            {title ?? it.title}
          </Text>
          <Text className={classes.mono} c="dimmed">
            {it.artifact_id}
          </Text>
        </Box>
        <Group gap={6} wrap="nowrap">
          {right}
          <StatusBadge status={it.status} />
        </Group>
      </Group>
      {children}
    </button>
  );
}

function SystemChip({ url }: { url: string }) {
  return (
    <Tooltip label={url} withArrow multiline maw={420} style={{ wordBreak: "break-all" }} openDelay={300}>
      <Badge variant="light" color="gray" tt="none" ff="monospace" fw={500} style={{ maxWidth: "100%" }}>
        {tail(url)}
      </Badge>
    </Tooltip>
  );
}

export function TerminologyList({ items, activeKey, onOpen, onOpenCodeSystem }: ViewProps) {
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm" className={classes.stagger}>
      {items.map((it) => {
        if (it.resource_type === "ValueSet") {
          const d = it.digest as unknown as VsDigest;
          const filters = d.include.reduce((n, i) => n + i.filters.length, 0);
          const imports = d.include.reduce((n, i) => n + i.value_sets.length, 0);
          return (
            <RowCard key={it.artifact_key} it={it} active={activeKey === it.artifact_key} onClick={() => onOpen(it.artifact_key)}>
              <Group gap={6} mt={8} wrap="wrap">
                {d.systems.slice(0, 4).map((s) => (
                  <SystemChip key={s} url={s} />
                ))}
                {d.systems.length > 4 && (
                  <Text fz="xs" c="dimmed">
                    +{d.systems.length - 4}
                  </Text>
                )}
              </Group>
              <Group gap="md" mt={8}>
                <Text fz="xs" c="dimmed">
                  {d.include.length} 個 include
                  {d.enumerated > 0 && ` · 列舉 ${fmtNumber(d.enumerated)} 碼`}
                  {filters > 0 && ` · ${filters} 個 filter`}
                  {imports > 0 && ` · 引用 ${imports} 個 ValueSet`}
                  {d.exclude > 0 && ` · ${d.exclude} 個 exclude`}
                  {d.include.length > 0 && d.enumerated === 0 && filters === 0 && imports === 0 && " · 整個代碼系統"}
                </Text>
              </Group>
            </RowCard>
          );
        }
        if (it.resource_type === "CodeSystem") {
          const d = it.digest as unknown as CsDigest;
          return (
            <RowCard
              key={it.artifact_key}
              it={it}
              active={false}
              onClick={() => onOpenCodeSystem(it.artifact_id)}
              right={
                <Tooltip label="在 CodeSystem 分頁瀏覽概念" withArrow>
                  <IconListTree size={15} color="var(--mantine-color-dimmed)" />
                </Tooltip>
              }
            >
              <Group gap={6} mt={8}>
                {d.content && (
                  <Badge size="sm" variant="light" color={d.content === "complete" ? "teal" : d.content === "supplement" ? "violet" : "amber"}>
                    {d.content}
                  </Badge>
                )}
                {d.count !== null && (
                  <Text fz="xs" c="dimmed">
                    count {fmtNumber(d.count)}
                  </Text>
                )}
                {d.hierarchy_meaning && (
                  <Badge size="sm" variant="outline" color="indigo">
                    {d.hierarchy_meaning}
                  </Badge>
                )}
              </Group>
            </RowCard>
          );
        }
        if (it.resource_type === "ConceptMap") {
          const d = it.digest as unknown as CmDigest;
          return (
            <RowCard key={it.artifact_key} it={it} active={activeKey === it.artifact_key} onClick={() => onOpen(it.artifact_key)}>
              <Group gap={6} mt={8} wrap="nowrap" style={{ minWidth: 0 }}>
                <Text fz="xs" ff="monospace" truncate>
                  {d.source ? tail(d.source) : d.groups[0]?.source ? tail(d.groups[0].source) : "—"}
                </Text>
                <IconArrowRight size={12} style={{ flex: "0 0 auto" }} />
                <Text fz="xs" ff="monospace" truncate>
                  {d.target ? tail(d.target) : d.groups[0]?.target ? tail(d.groups[0].target) : "—"}
                </Text>
              </Group>
              <Text fz="xs" c="dimmed" mt={4}>
                {d.groups.length} 個 group · {fmtNumber(d.elements)} 個對應來源碼
              </Text>
            </RowCard>
          );
        }
        return <RowCard key={it.artifact_key} it={it} active={activeKey === it.artifact_key} onClick={() => onOpen(it.artifact_key)} />;
      })}
    </SimpleGrid>
  );
}

const SP_TYPE_COLOR: Record<string, string> = { token: "blue", reference: "violet", string: "teal", date: "orange", quantity: "pink", number: "pink", uri: "gray", composite: "indigo", special: "gray" };

export function SearchParamTable({ items, activeKey, onOpen, showGroup }: ViewProps) {
  return (
    <Box style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)", overflowX: "auto" }} className={classes.fadeUp}>
      <Table highlightOnHover verticalSpacing={8} miw={620}>
        <Table.Thead>
          <Table.Tr>
            {showGroup && <Table.Th w={150}>基底資源</Table.Th>}
            <Table.Th w={190}>Code</Table.Th>
            <Table.Th w={100}>型別</Table.Th>
            <Table.Th>Expression</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((it) => {
            const d = it.digest as unknown as SpDigest;
            return (
              <Table.Tr
                key={it.artifact_key}
                onClick={() => onOpen(it.artifact_key)}
                style={{ cursor: "pointer" }}
                bg={activeKey === it.artifact_key ? "var(--mantine-primary-color-light)" : undefined}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(it.artifact_key);
                  }
                }}
                aria-label={`${d.code ?? it.title} 詳細資訊`}
              >
                {showGroup && (
                  <Table.Td>
                    <Text fz="xs">{d.base.join(", ")}</Text>
                  </Table.Td>
                )}
                <Table.Td>
                  <Text ff="monospace" fz="sm" fw={600}>
                    {d.code ?? "—"}
                  </Text>
                  <Text fz="xs" c="dimmed" lineClamp={1}>
                    {it.description || it.title}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {d.type && (
                    <Badge size="sm" variant="light" color={SP_TYPE_COLOR[d.type] ?? "gray"}>
                      {d.type}
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text className={classes.mono} lineClamp={2}>
                    {d.expression ?? "—"}
                  </Text>
                  {d.target.length > 0 && (
                    <Text fz="xs" c="dimmed" mt={2}>
                      → {d.target.join(", ")}
                    </Text>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

export function ExampleList({ items, activeKey, onOpen, resolved, showGroup }: ViewProps) {
  return (
    <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="sm" className={classes.stagger}>
      {items.map((it) => {
        const d = it.digest as unknown as ExampleDigest;
        return (
          <div key={it.artifact_key} className={`${classes.card} ${classes.relative}`} style={accent(it)} data-active={activeKey === it.artifact_key || undefined}>
            <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
              <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                <IconFileCode size={16} color="var(--cat-example)" style={{ flex: "0 0 auto" }} />
                <Box style={{ minWidth: 0 }}>
                  <Anchor component="button" type="button" className={classes.stretched} onClick={() => onOpen(it.artifact_key)} c="inherit" underline="never" fw={650} fz="sm" ff="monospace" style={{ wordBreak: "break-all", textAlign: "left" }}>
                    {it.artifact_id}
                  </Anchor>
                  {(d.coding?.display || d.coding?.code) && (
                    <Text fz="xs" c="dimmed" lineClamp={1}>
                      {d.coding.display ?? d.coding.code}
                    </Text>
                  )}
                  {d.bundle_type && (
                    <Text fz="xs" c="dimmed">
                      {d.bundle_type} · {fmtNumber(d.entries ?? 0)} 個 entry
                    </Text>
                  )}
                </Box>
              </Group>
              <Group gap={4} wrap="nowrap">
                {showGroup && (
                  <Badge size="xs" variant="light" color="red" tt="none">
                    {it.resource_type}
                  </Badge>
                )}
                {d.status && (
                  <Badge size="xs" variant="outline" color="gray">
                    {d.status}
                  </Badge>
                )}
              </Group>
            </Group>
            <Group gap={6} mt={8} className={classes.above} wrap="wrap">
              <Text fz="xs" c="dimmed">
                Profile
              </Text>
              {d.profiles.length === 0 ? (
                <Text fz="xs" c="dimmed">
                  未宣告 meta.profile
                </Text>
              ) : (
                d.profiles.map((p) => <CanonicalRef key={p} url={p} resolved={resolved[p.split("|")[0]]} />)
              )}
            </Group>
          </div>
        );
      })}
    </SimpleGrid>
  );
}

export function GenericList({ items, activeKey, onOpen }: ViewProps) {
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm" className={classes.stagger}>
      {items.map((it) => {
        const d = it.digest as Record<string, unknown>;
        const rest = Array.isArray(d.rest) ? (d.rest as { mode: string; resources: number }[]) : [];
        return (
          <RowCard key={it.artifact_key} it={it} active={activeKey === it.artifact_key} onClick={() => onOpen(it.artifact_key)} right={<Badge size="xs" variant="light" color="violet">{it.resource_type}</Badge>}>
            {it.description && (
              <Text fz="xs" c="dimmed" lineClamp={2} mt={6}>
                {it.description}
              </Text>
            )}
            <Group gap={6} mt={6}>
              {rest.map((r, i) => (
                <Badge key={i} size="sm" variant="outline" color="gray">
                  {r.mode} · {r.resources} 個資源
                </Badge>
              ))}
              {typeof d.code === "string" && (
                <Badge size="sm" variant="outline" color="gray" tt="none" ff="monospace">
                  ${d.code}
                </Badge>
              )}
              {typeof d.parameters === "number" && d.parameters > 0 && (
                <Text fz="xs" c="dimmed">
                  {d.parameters} 個參數
                </Text>
              )}
            </Group>
          </RowCard>
        );
      })}
    </SimpleGrid>
  );
}

import { ActionIcon, Badge, Box, Code, CopyButton, Divider, Group, ScrollArea, Skeleton, Stack, Table, Text, Title, Tooltip } from "@mantine/core";
import { IconCheck, IconLink, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { CopyText } from "@/components/CopyText";
import { errorMessage } from "@/lib/api";
import { CanonicalLink, GroundingBadge, JsonCode, Prose, requiredReason, TypeList } from "./parts";
import { useValueSetPreview } from "./profileApi";
import type { ElementRow, LinkTarget, RequiredRow } from "./profileTypes";
import { bare, card, STRENGTH } from "./treeModel";

export interface ElementDetailProps {
  row: ElementRow;
  links: Record<string, LinkTarget>;
  packageId: string;
  version: string;
  requiredRow: RequiredRow | undefined;
  /** Absolute URL of this element's deep link (copy). */
  deepLink: string;
  onClose?: () => void;
  onJump: (id: string) => void;
}

function Section({ title, children, right }: { title: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <Box>
      <Group justify="space-between" gap="xs" mb={6}>
        <Text fz="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: 0.4 }}>
          {title}
        </Text>
        {right}
      </Group>
      {children}
    </Box>
  );
}

/** Everything about one element: definition, cardinality, types, binding preview, constraints, slicing, mappings. */
export function ElementDetail({ row: r, links, packageId, version, requiredRow, deepLink, onClose, onJump }: ElementDetailProps) {
  const fp = r.fixed ?? r.pattern;
  return (
    <Stack gap={0} style={{ minHeight: 0, flex: 1 }}>
      <Box px="md" pt="md" pb="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <Box style={{ minWidth: 0 }}>
            <Title order={4} ff="monospace" style={{ wordBreak: "break-all" }}>
              {r.depth === 0 ? r.path : r.name}
              {r.sliceName && <Text span c="violet" inherit>:{r.sliceName}</Text>}
            </Title>
            {r.short && (
              <Text fz="sm" mt={2}>
                {r.short}
              </Text>
            )}
          </Box>
          <Group gap={4} wrap="nowrap">
            <CopyLink url={deepLink} />
            {onClose && (
              <ActionIcon variant="subtle" color="gray" onClick={onClose} aria-label="關閉">
                <IconX size={16} />
              </ActionIcon>
            )}
          </Group>
        </Group>
        <Group gap={6} mt="xs" wrap="wrap">
          <Badge variant="light" color={(r.min ?? 0) >= 1 ? "red" : "gray"} ff="monospace">
            {card(r.min, r.max) || "—"}
          </Badge>
          {r.cardChanged && (
            <Badge variant="outline" color="orange">
              基礎 {card(r.baseMin, r.baseMax)}
            </Badge>
          )}
          {r.mustSupport && <Badge color="red" variant="light">Must Support</Badge>}
          {r.isModifier && <Badge color="orange" variant="light">?! 修飾元素</Badge>}
          {r.isSummary && <Badge color="gray" variant="light">Σ 摘要</Badge>}
          {r.inDiff && <Badge color="brand" variant="light">此 Profile 修改</Badge>}
          {requiredRow && <GroundingBadge cls={requiredRow.grounding_class} />}
        </Group>
      </Box>
      <Divider />
      <ScrollArea type="auto" style={{ flex: 1 }} offsetScrollbars>
        <Stack gap="lg" p="md">
          <Section title="元素 id">
            <CopyText value={r.id} mono />
            {r.id !== r.path && (
              <Text fz="xs" c="dimmed" mt={2} ff="monospace">
                path {r.path}
              </Text>
            )}
          </Section>

          {requiredRow && (
            <Section title="LLM 必填判斷">
              <Group gap={6} mb={4}>
                <RequiredReasonBadge by={requiredRow.required_by} />
              </Group>
              {requiredRow.hint && <Text fz="sm">{requiredRow.hint}</Text>}
              {requiredRow.allowedCodes && (
                <Text fz="xs" c="dimmed" mt={4}>
                  允許代碼：{requiredRow.allowedCodes.join("、")}
                </Text>
              )}
            </Section>
          )}

          {r.types.length > 0 && (
            <Section title="型別">
              <Text fz="sm" ff="monospace" style={{ wordBreak: "break-word" }}>
                <TypeList types={r.types} links={links} inline={false} />
              </Text>
            </Section>
          )}
          {r.contentReference && (
            <Section title="內容引用">
              <Code>{r.contentReference}</Code>
              <Text fz="xs" c="dimmed" mt={4}>
                這個元素沿用另一個元素的結構定義。
              </Text>
            </Section>
          )}

          {r.definition && (
            <Section title="定義">
              <Prose>{r.definition}</Prose>
            </Section>
          )}
          {r.comment && (
            <Section title="備註">
              <Prose>{r.comment}</Prose>
            </Section>
          )}
          {r.requirements && (
            <Section title="需求">
              <Prose>{r.requirements}</Prose>
            </Section>
          )}
          {r.meaningWhenMissing && (
            <Section title="缺少時的意義">
              <Prose>{r.meaningWhenMissing}</Prose>
            </Section>
          )}
          {r.isModifierReason && (
            <Section title="修飾原因">
              <Text fz="sm">{r.isModifierReason}</Text>
            </Section>
          )}

          {fp && (
            <Section title={r.fixed ? `固定值（${r.fixed.field}）` : `Pattern（${r.pattern!.field}）`}>
              <JsonCode value={fp.value} maxHeight={240} />
              <Text fz="xs" c="dimmed" mt={4}>
                {r.fixed ? "實例中的值必須完全等於此值。" : "實例中的值必須包含這些內容（可以有額外內容）。"}
              </Text>
            </Section>
          )}

          {r.binding && <BindingSection binding={r.binding} links={links} packageId={packageId} version={version} />}

          {r.slicing && (
            <Section title="切片規則（slicing）">
              <Stack gap={4}>
                <Group gap={6}>
                  <Badge variant="light" color="violet">
                    rules: {r.slicing.rules ?? "—"}
                  </Badge>
                  {r.slicing.ordered !== null && <Badge variant="light" color="gray">{r.slicing.ordered ? "有序" : "無序"}</Badge>}
                </Group>
                {r.slicing.discriminator.map((d, i) => (
                  <Text key={i} fz="sm">
                    依 <Code>{d.path}</Code> 的 <b>{d.type}</b> 判別
                  </Text>
                ))}
                {r.slicing.description && <Text fz="xs" c="dimmed">{r.slicing.description}</Text>}
              </Stack>
            </Section>
          )}

          {r.constraints.length > 0 && (
            <Section title={`約束規則（${r.constraints.length}）`}>
              <Stack gap="xs">
                {r.constraints.map((c) => (
                  <Box key={c.key} p="xs" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)" }}>
                    <Group gap={6} mb={4}>
                      <Badge size="sm" variant="light" color={c.severity === "error" ? "red" : "amber"} ff="monospace">
                        {c.key}
                      </Badge>
                      <Text fz="xs" c="dimmed">
                        {c.severity}
                      </Text>
                      {c.source && (
                        <Text fz="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
                          來自 <CanonicalLink url={c.source} links={links} />
                        </Text>
                      )}
                    </Group>
                    {c.human && <Text fz="sm">{c.human}</Text>}
                    {c.expression && (
                      <Code block mt={4} fz="xs" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {c.expression}
                      </Code>
                    )}
                  </Box>
                ))}
              </Stack>
            </Section>
          )}

          {(r.alias.length > 0 || r.condition.length > 0 || r.maxLength !== null) && (
            <Section title="其他">
              <Stack gap={4}>
                {r.alias.length > 0 && <Text fz="sm">別名：{r.alias.join("、")}</Text>}
                {r.condition.length > 0 && <Text fz="sm">條件：{r.condition.join("、")}</Text>}
                {r.maxLength !== null && <Text fz="sm">最大長度：{r.maxLength}</Text>}
              </Stack>
            </Section>
          )}

          {r.inDiff && r.diffKeys.length > 0 && (
            <Section title="此 Profile 設定的屬性">
              <Group gap={4}>
                {r.diffKeys.map((k) => (
                  <Badge key={k} size="sm" variant="outline" color="brand" tt="none">
                    {k}
                  </Badge>
                ))}
              </Group>
            </Section>
          )}

          {r.mappings.length > 0 && (
            <Section title={`對應（${r.mappings.length}）`}>
              <Table fz="xs" verticalSpacing={4} withRowBorders={false}>
                <Table.Tbody>
                  {r.mappings.map((m, i) => (
                    <Table.Tr key={i}>
                      <Table.Td c="dimmed" w={70} style={{ verticalAlign: "top" }}>
                        {m.identity}
                      </Table.Td>
                      <Table.Td ff="monospace" style={{ wordBreak: "break-word" }}>
                        {m.map}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Section>
          )}

          {r.parent && (
            <Text fz="xs" c="dimmed">
              上層元素：
              <Text span fz="xs" c="brand" ff="monospace" style={{ cursor: "pointer" }} onClick={() => onJump(r.parent!)}>
                {r.parent}
              </Text>
            </Text>
          )}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

export function RequiredReasonBadge({ by }: { by: string | undefined }) {
  const x = requiredReason(by);
  return (
    <Tooltip label={x.tip} multiline maw={320}>
      <Badge size="sm" variant="outline" color={x.color} tt="none" style={{ flexShrink: 0 }}>
        {x.label}
      </Badge>
    </Tooltip>
  );
}

function CopyLink({ url }: { url: string }) {
  return (
    <CopyButton value={url} timeout={1500}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? "已複製連結" : "複製這個元素的連結"}>
          <ActionIcon variant="subtle" color={copied ? "teal" : "gray"} aria-label="複製元素連結" onClick={copy}>
            {copied ? <IconCheck size={16} /> : <IconLink size={16} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  );
}

function BindingSection({ binding, links, packageId, version }: { binding: NonNullable<ElementRow["binding"]>; links: Record<string, LinkTarget>; packageId: string; version: string }) {
  const st = STRENGTH[binding.strength ?? ""] ?? { label: binding.strength ?? "—", color: "gray" };
  const vs = binding.valueSet ? bare(binding.valueSet) : null;
  const q = useValueSetPreview(packageId, version, vs);
  const exp = q.data?.data;
  return (
    <Section title="術語繫結（binding）">
      <Stack gap={6}>
        <Group gap={6}>
          <Badge variant="light" color={st.color}>
            {st.label}
          </Badge>
          {vs && (
            <Text fz="sm" style={{ minWidth: 0, flex: 1 }} truncate>
              <CanonicalLink url={vs} links={links} fz="sm" />
            </Text>
          )}
        </Group>
        {binding.valueSet && <CopyText value={binding.valueSet} mono truncate />}
        {binding.description && <Prose>{binding.description}</Prose>}
        {vs &&
          (q.isPending ? (
            <Stack gap={4}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} h={18} w={`${80 - i * 15}%`} />
              ))}
            </Stack>
          ) : q.isError ? (
            <Text fz="xs" c="dimmed">
              無法展開：{errorMessage(q.error)}
            </Text>
          ) : exp ? (
            <Box>
              <Text fz="xs" c="dimmed" mb={4}>
                {exp.codings.length === 0
                  ? "展開後沒有代碼（可能引用了未安裝的術語，例如 SNOMED CT / LOINC 全集）。"
                  : `前 ${exp.codings.length} 個代碼${exp.total !== null && exp.total !== undefined ? `（共 ${exp.total.toLocaleString()} 個${exp.truncated ? "以上" : ""}）` : exp.truncated ? "（還有更多）" : ""}`}
              </Text>
              <Stack gap={2}>
                {exp.codings.map((c, i) => (
                  <Group key={`${c.system}|${c.code}|${i}`} gap={8} wrap="nowrap">
                    <Code fz="xs" style={{ flexShrink: 0 }}>
                      {c.code}
                    </Code>
                    <Text fz="xs" truncate style={{ minWidth: 0 }} title={c.system}>
                      {c.display ?? ""}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </Box>
          ) : null)}
      </Stack>
    </Section>
  );
}

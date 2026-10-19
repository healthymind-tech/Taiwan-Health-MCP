import { Anchor, Badge, Box, Code, Group, SegmentedControl, SimpleGrid, Skeleton, Stack, Table, Text } from "@mantine/core";
import { IconForms } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router";
import { ErrorState } from "@/components/EmptyState";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { JsonCode, TypeList } from "./parts";
import { useSkeleton, type ProfileRef } from "./profileApi";
import type { LinkTarget } from "./profileTypes";

/** 骨架: fhir_get_resource_skeleton output (the fill-form an LLM authors against). */
export function SkeletonTab({ profile, links }: { profile: ProfileRef; links: Record<string, LinkTarget> }) {
  const q = useSkeleton(profile, true);
  const [mode, setMode] = useState<"json" | "table">("json");
  if (q.isPending) return <Skeleton h={420} radius="lg" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="無法產生骨架" />;
  const d = q.data.data;
  const eff = d.fields.filter((f) => f.effectiveRequired).length;
  const bound = d.fields.filter((f) => f.binding).length;
  const pinned = d.fields.filter((f) => f.autoPinned).length;
  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <StatCard label="欄位" value={d.fields.length} hint={`頂層 ${d.resourceType} 元素（不含切片內部）`} />
        <StatCard label="必須出現" value={eff} color="red" hint="effectiveRequired" />
        <StatCard label="有術語繫結" value={bound} color="indigo" hint="附候選代碼" />
        <StatCard label="系統自動帶入" value={pinned} color="teal" hint="autoPinned（finalize 時填入）" />
      </SimpleGrid>
      <SectionCard
        title="資源骨架"
        icon={<IconForms size={18} />}
        description={d.instructions}
        actions={
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={(v) => setMode(v as "json" | "table")}
            data={[
              { value: "json", label: "原始 JSON" },
              { value: "table", label: "欄位表" },
            ]}
          />
        }
        flush={mode === "table"}
      >
        {mode === "json" ? (
          <JsonCode value={q.data} maxHeight={720} />
        ) : (
          <Box style={{ overflowX: "auto" }}>
            <Table verticalSpacing="xs" striped highlightOnHover miw={720}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>JSON 路徑</Table.Th>
                  <Table.Th>必填</Table.Th>
                  <Table.Th>型別</Table.Th>
                  <Table.Th>說明 / 候選</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {d.fields.map((f) => (
                  <Table.Tr key={f.path}>
                    <Table.Td ff="monospace" fz="xs" style={{ whiteSpace: "nowrap" }}>
                      {f.jsonPath}
                      {f.array ? "[]" : ""}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        {f.effectiveRequired ? (
                          <Badge size="xs" color="red" variant="light">
                            必須
                          </Badge>
                        ) : f.required ? (
                          <Badge size="xs" color="amber" variant="light">
                            上層有才必填
                          </Badge>
                        ) : null}
                        {f.mustSupport && (
                          <Badge size="xs" color="red" variant="outline">
                            MS
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td fz="xs" ff="monospace">
                      {f.choices ? f.choices.join(" | ") : <TypeList types={f.types} links={links} />}
                    </Table.Td>
                    <Table.Td fz="xs">
                      <Text fz="xs" lineClamp={2}>
                        {f.short}
                      </Text>
                      {f.autoPinned && (
                        <Text fz="xs" c="teal">
                          自動：{f.autoPinned.field} = <Code fz="xs">{JSON.stringify(f.autoPinned.value).slice(0, 80)}</Code>
                        </Text>
                      )}
                      {f.binding?.candidateCodes && f.binding.candidateCodes.length > 0 && (
                        <Text fz="xs" c="dimmed" lineClamp={1}>
                          候選：{f.binding.candidateCodes.slice(0, 6).map((c) => c.code).join("、")}
                          {f.binding.candidatesTruncated || f.binding.candidateCodes.length > 6 ? "…" : ""}
                        </Text>
                      )}
                      {f.slices && (
                        <Text fz="xs" c="violet">
                          切片：{f.slices.map((s) => s.sliceName).join("、")}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </SectionCard>
      <Text fz="xs" c="dimmed">
        與 MCP 工具 fhir_get_resource_skeleton（candidate_limit=20）完全相同 ·{" "}
        <Anchor component={Link} to="/mcp?tab=playground&tool=fhir_get_resource_skeleton" fz="xs">
          在 MCP 測試台呼叫
        </Anchor>
      </Text>
    </Stack>
  );
}

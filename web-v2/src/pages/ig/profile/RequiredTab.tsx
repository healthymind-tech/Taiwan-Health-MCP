import { Alert, Anchor, Badge, Box, Code, Collapse, Group, SegmentedControl, SimpleGrid, Skeleton, Stack, Switch, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconBook2, IconChevronDown, IconInfoCircle, IconListCheck, IconRobot } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ErrorState, EmptyState } from "@/components/EmptyState";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { RequiredReasonBadge } from "./ElementDetail";
import { GROUNDING, GroundingBadge, JsonCode } from "./parts";
import { useRequiredElements, type ProfileRef } from "./profileApi";
import type { RequiredRow } from "./profileTypes";
import classes from "./profile.module.css";

/** Depth of each required row inside the required list (nearest listed ancestor by id prefix). */
function nestDepths(rows: RequiredRow[]): number[] {
  const ids = rows.map((r) => r.id);
  return ids.map((id) => ids.filter((o) => o !== id && (id.startsWith(`${o}.`) || id.startsWith(`${o}:`))).length);
}

function valueOf(r: RequiredRow): { label: string; value: unknown } | null {
  if (r.value !== undefined) return { label: "value", value: r.value };
  if (r.fixed) return { label: r.fixed.field, value: r.fixed.value };
  if (r.pattern) return { label: r.pattern.field, value: r.pattern.value };
  return null;
}

/**
 * 必填欄位: fhir_get_profile_required_elements exactly as an LLM receives it, rendered
 * as a nested checklist with the reason each element is required.
 */
export function RequiredTab({ profile, knownIds, onJump }: { profile: ProfileRef; knownIds: Set<string>; onJump: (id: string) => void }) {
  const [verbosity, setVerbosity] = useState<"compact" | "full">("compact");
  const [ms, setMs] = useState(false);
  const [raw, setRaw] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const q = useRequiredElements(profile, verbosity, ms);
  const data = q.data?.data;
  const depths = useMemo(() => (data ? nestDepths(data.elements) : []), [data]);

  if (q.isPending) {
    return (
      <Stack gap="md">
        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} h={88} radius="lg" />
          ))}
        </SimpleGrid>
        <Skeleton h={320} radius="lg" />
      </Stack>
    );
  }
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="無法取得必填欄位" />;
  if (!data) return null;
  const summary = Object.entries(data.summary).filter(([, n]) => n > 0);

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, sm: 4, lg: Math.min(6, summary.length + 1) }}>
        <StatCard label="必填元素" value={data.count} icon={<IconListCheck size={20} />} hint={`${data.resourceType} · ${data.verbosity}`} />
        {summary.map(([k, n]) => (
          <StatCard key={k} label={GROUNDING[k]?.label ?? k} value={n} color={GROUNDING[k]?.color ?? "gray"} hint={k} />
        ))}
      </SimpleGrid>

      <SectionCard
        title="LLM 需要填的欄位"
        icon={<IconRobot size={18} />}
        description="這就是 MCP 工具 fhir_get_profile_required_elements 回傳給模型的內容：列出的元素都必須出現，沒列出的都是選填。"
        actions={
          <>
            <SegmentedControl
              size="xs"
              value={verbosity}
              onChange={(v) => setVerbosity(v as "compact" | "full")}
              data={[
                { value: "compact", label: "精簡（預設）" },
                { value: "full", label: "完整 full" },
              ]}
            />
            <Switch size="sm" label="含 Must Support" checked={ms} onChange={(e) => setMs(e.currentTarget.checked)} />
            <Switch size="sm" label="LLM 實際看到的內容" checked={raw} onChange={(e) => setRaw(e.currentTarget.checked)} />
          </>
        }
        flush
      >
        {q.isFetching && <Box h={2} bg="var(--mantine-primary-color-filled)" style={{ opacity: 0.5 }} />}
        {raw ? (
          <Box p="md">
            <JsonCode value={q.data} maxHeight={640} />
            <Text fz="xs" c="dimmed" mt={6}>
              參數：profile={data.canonical ?? data.profile}、package_id={profile.packageId}、version={profile.version}、verbosity={verbosity}
              {ms ? "、include_mustsupport=true" : ""}
            </Text>
          </Box>
        ) : data.elements.length === 0 ? (
          <EmptyState compact title="這個 Profile 沒有必填元素" description="所有元素都是選填。" />
        ) : (
          <div>
            {data.elements.map((r, i) => {
              const v = valueOf(r);
              const inTree = knownIds.has(r.id);
              return (
                <div key={`${r.id}-${i}`} className={classes.reqRow} style={{ paddingLeft: 14 + depths[i] * 20, animationDelay: `${Math.min(i, 20) * 14}ms` }}>
                  <Group gap={8} wrap="wrap" align="center">
                    {inTree ? (
                      <Tooltip label="在元素樹中顯示">
                        <Anchor component="button" ff="monospace" fz="sm" fw={600} onClick={() => onJump(r.id)} style={{ wordBreak: "break-all", textAlign: "left" }}>
                          {r.id}
                        </Anchor>
                      </Tooltip>
                    ) : (
                      <Text ff="monospace" fz="sm" fw={600} style={{ wordBreak: "break-all" }}>
                        {r.id}
                      </Text>
                    )}
                    <GroundingBadge cls={r.grounding_class} />
                    <RequiredReasonBadge by={r.required_by} />
                    {r.min !== undefined && (
                      <Badge size="sm" variant="default" ff="monospace">
                        {r.min}..{r.max}
                      </Badge>
                    )}
                    {r.types && r.types.length > 0 && (
                      <Text fz="xs" c="dimmed" ff="monospace">
                        {r.types.join(" | ")}
                      </Text>
                    )}
                    {r.mustSupport && (
                      <Badge size="xs" color="red" variant="light">
                        MS
                      </Badge>
                    )}
                  </Group>
                  {r.hint && (
                    <Text fz="xs" c="dimmed" mt={4}>
                      {r.hint}
                    </Text>
                  )}
                  {r.choices && (
                    <Group gap={4} mt={6}>
                      <Text fz="xs" c="dimmed">
                        擇一：
                      </Text>
                      {r.choices.map((c) => (
                        <Code key={c} fz="xs">
                          {c}
                        </Code>
                      ))}
                    </Group>
                  )}
                  {r.allowedCodes && (
                    <Group gap={4} mt={6}>
                      <Text fz="xs" c="dimmed">
                        允許代碼：
                      </Text>
                      {r.allowedCodes.map((c) => (
                        <Badge key={c} size="sm" variant="light" color="indigo" tt="none" ff="monospace">
                          {c}
                        </Badge>
                      ))}
                    </Group>
                  )}
                  {r.binding?.valueSet && (
                    <Text fz="xs" c="dimmed" mt={4} style={{ wordBreak: "break-all" }}>
                      binding {r.binding.strength}：{r.binding.valueSet}
                    </Text>
                  )}
                  {v && (
                    <Box mt={6} maw={640}>
                      <Text fz="xs" c="dimmed" mb={2}>
                        {v.label}（照抄）
                      </Text>
                      {typeof v.value === "object" && v.value !== null ? <JsonCode value={v.value} maxHeight={200} /> : <Code>{String(v.value)}</Code>}
                    </Box>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      {data.invariants && data.invariants.length > 0 && (
        <SectionCard title={`額外約束規則（${data.invariants.length}${data.moreInvariants ? ` + ${data.moreInvariants.length}` : ""}）`} description="Profile 自己定義、填寫時必須滿足的 error 等級 FHIRPath 規則。">
          <Stack gap="xs">
            {data.invariants.map((inv) => (
              <Group key={`${inv.key}-${String(inv.on)}`} gap={8} align="flex-start" wrap="nowrap">
                <Badge variant="light" color="grape" ff="monospace" style={{ flexShrink: 0 }}>
                  {inv.key}
                </Badge>
                <Box style={{ minWidth: 0 }}>
                  <Text fz="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
                    {Array.isArray(inv.on) ? inv.on.join("、") : inv.on}
                  </Text>
                  {inv.human && <Text fz="sm">{inv.human}</Text>}
                  <Code block fz="xs" mt={2} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {inv.rule ?? inv.expression}
                  </Code>
                </Box>
              </Group>
            ))}
            {data.moreInvariants && (
              <Text fz="xs" c="dimmed">
                另有 {data.moreInvariants.join("、")}（切換到「完整 full」查看全文）
              </Text>
            )}
          </Stack>
        </SectionCard>
      )}

      <Alert variant="light" color="gray" icon={<IconBook2 size={18} />} title={null}>
        <UnstyledButton onClick={() => setGuideOpen((o) => !o)} w="100%">
          <Group justify="space-between">
            <Text fz="sm" fw={600}>
              模型收到的閱讀說明（guide）
            </Text>
            <IconChevronDown size={16} style={{ transform: guideOpen ? "rotate(180deg)" : undefined, transition: "transform 180ms ease" }} />
          </Group>
        </UnstyledButton>
        <Collapse in={guideOpen}>
          <Text fz="xs" mt="xs" style={{ whiteSpace: "pre-wrap" }}>
            {data.guide}
          </Text>
        </Collapse>
      </Alert>
      {(q.data?.warnings?.length ?? 0) > 0 && (
        <Alert variant="light" color="amber" icon={<IconInfoCircle size={18} />} title="工具警告">
          {q.data!.warnings.map((w) => (
            <Text key={w} fz="xs">
              {w}
            </Text>
          ))}
        </Alert>
      )}
      <Text fz="xs" c="dimmed">
        工具版本 {String(q.data?.provenance?.toolVersion ?? "—")} ·{" "}
        <Anchor component={Link} to="/mcp?tab=playground&tool=fhir_get_profile_required_elements" fz="xs">
          在 MCP 測試台呼叫
        </Anchor>
      </Text>
    </Stack>
  );
}

import { Alert, Anchor, Badge, Button, Group, Progress, SimpleGrid, Skeleton, Stack, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconEraser, IconInfoCircle, IconPlayerPlay, IconRefresh, IconVectorTriangle } from "@tabler/icons-react";
import { Link } from "react-router";
import { SectionCard } from "@/components/SectionCard";
import { RelativeTime } from "@/components/RelativeTime";
import { HealthBadge } from "@/components/StatusBadge";
import { KeyValue } from "@/components/KeyValue";
import { ErrorState } from "@/components/EmptyState";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import { useJobControl, useStartJob } from "@/lib/jobs";
import { fmtNumber, fmtPercent } from "@/lib/format";
import { CLEAR_SCOPE_META, jobTypeLabel, type ModuleMeta } from "@/lib/meta";
import type { JobSummary } from "@/lib/types";
import { InlineJobProgress } from "./JobProgress";
import { notifyJobStarted } from "./ImportSection";
import { findEmbeddingModule, isEmbeddingStale, pct, useClearModule, useEmbeddingStatus } from "./moduleData";

export function EmbeddingSection({
  meta,
  rows,
  activeEmbed,
  activeOther,
  pausedEmbed,
  stepNumber,
}: {
  meta: ModuleMeta;
  rows: number;
  activeEmbed: JobSummary | null;
  activeOther: JobSummary | null;
  pausedEmbed: JobSummary | null;
  stepNumber: string;
}) {
  const q = useEmbeddingStatus();
  const start = useStartJob();
  const control = useJobControl();
  const clear = useClearModule(meta.key);
  const em = findEmbeddingModule(q.data, meta.key);
  const provider = q.data?.ollama;
  const stale = isEmbeddingStale(em);
  const embedded = em?.embedded ?? 0;
  const total = em?.total ?? 0;
  const coverage = pct(embedded, total);
  const complete = total > 0 && embedded >= total;

  let startBlock: string | null = null;
  if (rows === 0) startBlock = "尚未匯入資料，沒有可嵌入的內容";
  else if (activeEmbed && activeEmbed.status !== "paused") startBlock = "嵌入工作進行中";
  else if (activeOther) startBlock = `${jobTypeLabel(activeOther.job_type)}進行中，完成後再嵌入`;
  else if (provider && !provider.configured) startBlock = "尚未設定嵌入模型，請先到「模型」頁新增嵌入端點";

  let clearBlock: string | null = null;
  if (activeEmbed || activeOther) clearBlock = "有工作進行中，完成或停止後才能清除向量";
  else if (embedded === 0) clearBlock = "目前沒有任何向量";

  const startEmbed = async () => {
    if (!meta.embedJobType) return;
    try {
      if (pausedEmbed) {
        await control.mutateAsync({ jobId: pausedEmbed.job_id, action: "resume" });
        notify.success("已送出繼續指令，工作程序會從上次的檢查點接續。", "嵌入工作繼續");
      } else {
        const res = await start.mutateAsync({ job_type: meta.embedJobType, module_key: meta.key });
        notifyJobStarted(res.job, "向量嵌入工作");
      }
    } catch (e) {
      notify.error(e, "無法開始嵌入");
    }
  };

  const clearVectors = () =>
    confirmAction({
      title: `${CLEAR_SCOPE_META.embeddings.label}？`,
      danger: true,
      typeToConfirm: meta.key,
      message: CLEAR_SCOPE_META.embeddings.description,
      consequences: [
        `刪除 ${fmtNumber(embedded)} 筆向量（匯入的 ${fmtNumber(rows)} 筆資料保留）`,
        "語意 / 混合搜尋會退回關鍵字搜尋，工具回應會標示 search_mode: keyword_only",
        "之後按「開始嵌入」即可從頭重建，所需時間視資料量與嵌入端點而定",
      ],
      confirmLabel: "清除向量",
      onConfirm: async () => {
        try {
          await clear.mutateAsync("embeddings");
          notify.success("向量已清除，匯入資料保持不變。", "清除完成");
        } catch (e) {
          notify.error(e, "清除向量失敗");
          throw e;
        }
      },
    });

  return (
    <SectionCard
      title={`${stepNumber} 向量嵌入`}
      icon={<IconVectorTriangle size={18} />}
      description="為每筆資料計算語意向量，讓 MCP 工具能做語意 / 混合搜尋。向量缺少時，搜尋會自動退回關鍵字比對（中文名稱的關鍵字搜尋幾乎找不到結果）。"
      actions={
        <Group gap="xs" wrap="wrap">
          <Tooltip label={clearBlock} disabled={!clearBlock} multiline maw={260}>
            <Button
              variant="default"
              color="red"
              leftSection={<IconEraser size={16} />}
              onClick={clearVectors}
              disabled={Boolean(clearBlock)}
              loading={clear.isPending}
            >
              {CLEAR_SCOPE_META.embeddings.label}
            </Button>
          </Tooltip>
          <Tooltip label={startBlock} disabled={!startBlock} multiline maw={260}>
            <Button
              leftSection={pausedEmbed ? <IconRefresh size={16} /> : <IconPlayerPlay size={16} />}
              onClick={() => void startEmbed()}
              disabled={Boolean(startBlock)}
              loading={start.isPending || control.isPending}
            >
              {pausedEmbed ? "繼續嵌入" : complete && !stale ? "重新檢查並嵌入" : "開始嵌入"}
            </Button>
          </Tooltip>
        </Group>
      }
    >
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="無法讀取嵌入狀態" />
      ) : q.isPending ? (
        <Stack>
          <Skeleton h={24} />
          <Skeleton h={60} />
        </Stack>
      ) : (
        <Stack gap="md">
          {activeEmbed && <InlineJobProgress job={activeEmbed} />}
          <Stack gap={6}>
            <Group justify="space-between" wrap="wrap" gap="xs">
              <Group gap="xs">
                <Text fw={650} fz="lg" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {fmtNumber(embedded)} / {fmtNumber(total)}
                </Text>
                <Text c="dimmed" fz="sm">
                  （{fmtPercent(embedded, total)}）
                </Text>
              </Group>
              <Group gap={6}>
                {complete && !stale && (
                  <Badge color="teal" variant="light">
                    已完整嵌入
                  </Badge>
                )}
                {stale && (
                  <Tooltip label="資料在上次嵌入後有更新，部分向量可能過期。再執行一次嵌入即可，只會重算變動的列。" multiline maw={280}>
                    <Badge color="amber" variant="light" leftSection={<IconAlertTriangle size={11} />}>
                      向量可能過期
                    </Badge>
                  </Tooltip>
                )}
                {embedded === 0 && rows > 0 && (
                  <Badge color="gray" variant="light">
                    尚未嵌入
                  </Badge>
                )}
              </Group>
            </Group>
            <Progress value={coverage} color={stale ? "amber" : complete ? "teal" : "blue"} size="md" radius="xl" />
            <Group gap="lg" wrap="wrap">
              <Text fz="xs" c="dimmed">
                上次嵌入：<RelativeTime value={em?.last_embedded_at || null} fz="xs" />
              </Text>
              <Text fz="xs" c="dimmed">
                資料最後更新：<RelativeTime value={em?.last_source_updated_at || null} fz="xs" />
              </Text>
            </Group>
            {em?.note && (
              <Text fz="xs" c="dimmed">
                {em.note}
              </Text>
            )}
            {em?.detail && Object.keys(em.detail).length > 0 && (
              <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
                {Object.entries(em.detail).map(([k, v]) => (
                  <Text key={k} fz="xs" c="dimmed">
                    <Text span ff="monospace">{k}</Text>：{fmtNumber(v)}
                  </Text>
                ))}
              </SimpleGrid>
            )}
          </Stack>

          {provider && (
            <KeyValue
              cols={4}
              items={[
                { label: "嵌入供應商", value: provider.provider || "—" },
                { label: "模型", value: <Text fz="sm" ff="monospace" style={{ wordBreak: "break-all" }}>{provider.model || "—"}</Text> },
                { label: "向量維度", value: provider.dimensions ? fmtNumber(provider.dimensions) : "—" },
                {
                  label: "連線狀態",
                  value: !provider.configured ? (
                    <HealthBadge state="warn" label="未設定" />
                  ) : provider.provider === "ollama" ? (
                    provider.reachable ? (
                      <HealthBadge state="ok" label="可連線" />
                    ) : (
                      <HealthBadge state="error" label="無法連線" tooltip={provider.base_url} />
                    )
                  ) : (
                    <HealthBadge state="unknown" label="未檢測" tooltip="此狀態端點只會實際探測 Ollama；其他供應商會在嵌入工作開始時驗證連線。" />
                  ),
                },
              ]}
            />
          )}
          {provider && !provider.configured && (
            <Alert color="amber" icon={<IconInfoCircle size={16} />} p="sm">
              <Text fz="sm">
                尚未設定任何嵌入端點。請到{" "}
                <Anchor component={Link} to="/models" fz="sm">
                  模型設定
                </Anchor>{" "}
                新增，否則嵌入工作會直接失敗。
              </Text>
            </Alert>
          )}
          <Text fz="xs" c="dimmed">
            嵌入是增量的：每列以內容雜湊比對，只重算新增或變動的列，並清掉已不存在資料的向量。若更換了嵌入模型或維度，請先「{CLEAR_SCOPE_META.embeddings.label}」再重新嵌入。
          </Text>
        </Stack>
      )}
    </SectionCard>
  );
}

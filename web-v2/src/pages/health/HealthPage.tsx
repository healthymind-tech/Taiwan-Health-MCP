import { Badge, Box, Button, Card, Group, SimpleGrid, Stack, Text, ThemeIcon, Tooltip } from "@mantine/core";
import {
  IconActivity,
  IconBrain,
  IconCloud,
  IconDatabase,
  IconFileText,
  IconPlayerPlay,
  IconRefresh,
  IconServer2,
  IconStack,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { fmtNumber, shortId } from "@/lib/format";
import type { ServiceProbe, ServicesPayload } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { QueryBoundary } from "@/components/QueryBoundary";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { DataTable, type Column } from "@/components/DataTable";
import { Dot, HealthBadge, probeHealth } from "@/components/StatusBadge";
import { notify } from "@/components/notify";

const PROBE_META: Record<string, { label: string; description: string; icon: typeof IconDatabase; settings?: string }> = {
  database: { label: "PostgreSQL", description: "主資料庫、向量儲存與工作控制面", icon: IconDatabase },
  redis: { label: "Redis", description: "即時事件廣播與快取", icon: IconStack },
  minio: { label: "物件儲存", description: "來源檔、藥品資產與系統備份", icon: IconCloud, settings: "/integrations" },
  embedding_model: { label: "Embedding 模型", description: "語意搜尋的向量端點", icon: IconBrain, settings: "/models" },
  ocr_server: { label: "OCR 伺服器", description: "藥品仿單 PDF 文字辨識（MinerU / Indra，含備援）", icon: IconFileText, settings: "/integrations?tab=ocr" },
  analysis_server: { label: "分析 LLM", description: "仿單結構化抽取", icon: IconBrain, settings: "/models" },
};

const CATEGORY_LABEL: Record<string, string> = { infrastructure: "基礎設施", storage: "儲存", ml: "AI 模型", other: "其他" };

interface Worker {
  worker_name: string;
  process_id: number;
  status: string;
  current_job_id: string;
  last_heartbeat_at: string;
  stale: boolean;
  details: Record<string, unknown>;
}

function ProbeCard({ p, onProbe, probing }: { p: ServiceProbe; onProbe: () => void; probing: boolean }) {
  const meta = PROBE_META[p.service_key];
  const Icon = meta?.icon ?? IconServer2;
  const state = p.checked_at ? probeHealth(p.status) : "unknown";
  const color = state === "ok" ? "teal" : state === "warn" ? "amber" : state === "error" ? "red" : "gray";
  return (
    <Card padding="md">
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <ThemeIcon variant="light" color={color} size={40} radius="md">
            <Icon size={20} />
          </ThemeIcon>
          <Box style={{ minWidth: 0 }}>
            <Text fw={650} truncate="end">
              {meta?.label ?? p.label}
            </Text>
            <Text fz="xs" c="dimmed" lineClamp={1}>
              {meta?.description ?? p.description}
            </Text>
          </Box>
        </Group>
        <HealthBadge
          state={state}
          label={!p.checked_at ? "未探測" : state === "ok" ? "正常" : state === "warn" ? "受限" : state === "error" ? "異常" : p.status}
          size="xs"
        />
      </Group>
      <Stack gap={4} mt="md">
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text fz="xs" c="dimmed">
            端點
          </Text>
          <Tooltip label={p.endpoint} disabled={!p.endpoint}>
            <Text fz="xs" ff="monospace" truncate="end" maw={220}>
              {p.endpoint || "—"}
            </Text>
          </Tooltip>
        </Group>
        <Group justify="space-between" gap="xs">
          <Text fz="xs" c="dimmed">
            延遲
          </Text>
          <Text fz="xs" className="tabular">
            {p.latency_ms === null || p.latency_ms === undefined ? "—" : `${fmtNumber(p.latency_ms)} ms`}
          </Text>
        </Group>
        <Group justify="space-between" gap="xs">
          <Text fz="xs" c="dimmed">
            最後探測
          </Text>
          <RelativeTime value={p.checked_at} fz="xs" />
        </Group>
        {(p.message_zh || p.message) && (
          <Tooltip label={p.message} disabled={!p.message_zh || !p.message} multiline maw={360}>
            <Text fz="xs" c={state === "error" ? "red" : "dimmed"} mt={4} lineClamp={3} style={{ wordBreak: "break-word" }}>
              {p.message_zh ?? p.message}
            </Text>
          </Tooltip>
        )}
        {p.hint_zh && state !== "ok" && (
          <Text fz="xs" c="dimmed" lineClamp={3}>
            {p.hint_zh}
          </Text>
        )}
      </Stack>
      <Group gap="xs" mt="md">
        <Button size="xs" variant="light" leftSection={<IconPlayerPlay size={14} />} onClick={onProbe} loading={probing}>
          探測
        </Button>
        {meta?.settings && (
          <Button size="xs" variant="subtle" component={Link} to={meta.settings}>
            設定
          </Button>
        )}
      </Group>
    </Card>
  );
}

export default function HealthPage() {
  const qc = useQueryClient();
  const servicesQ = useQuery({
    queryKey: qk.services,
    queryFn: () => api.get<ServicesPayload>("/admin/api/services"),
  });
  const workersQ = useQuery({
    queryKey: qk.workers,
    queryFn: () => api.get<{ workers: Worker[] }>("/admin/api/workers"),
    refetchInterval: 15_000,
  });
  const probe = useMutation({
    mutationFn: (keys: string[]) => api.post<ServicesPayload>("/admin/api/services/probe", { service_keys: keys }),
    onSuccess: (data, keys) => {
      qc.setQueryData(qk.services, data);
      void qc.invalidateQueries({ queryKey: qk.services });
      void qc.invalidateQueries({ queryKey: qk.overview });
      const bad = data.services.filter((s) => (keys.length === 0 || keys.includes(s.service_key)) && s.status !== "ok");
      if (bad.length === 0) notify.success(keys.length === 1 ? "探測完成，服務正常" : "探測完成，所有服務正常");
      else notify.warn(`${bad.length} 個服務異常：${bad.map((b) => PROBE_META[b.service_key]?.label ?? b.label).join("、")}`, "探測完成");
    },
    onError: (e) => notify.error(e, "探測失敗"),
  });

  const historyColumns: Column<ServiceProbe>[] = [
    { key: "svc", header: "服務", primary: true, render: (p) => <Text fz="sm" fw={600}>{PROBE_META[p.service_key]?.label ?? p.label ?? p.service_key}</Text> },
    {
      key: "status",
      header: "結果",
      render: (p) => <HealthBadge state={probeHealth(p.status)} label={p.status} size="xs" />,
    },
    { key: "latency", header: "延遲", render: (p) => <Text fz="sm" className="tabular">{p.latency_ms === null ? "—" : `${p.latency_ms} ms`}</Text> },
    { key: "msg", header: "訊息", hideOnMobile: true, render: (p) => <Text fz="xs" c="dimmed" lineClamp={2}>{p.message_zh || p.message || "—"}</Text> },
    { key: "at", header: "時間", render: (p) => <RelativeTime value={p.checked_at} fz="sm" />, nowrap: true },
  ];

  return (
    <>
      <PageHeader
        title="服務健康"
        icon={<IconActivity size={24} />}
        description="主動探測資料庫、儲存與 AI 模型端點的連線狀態。工作在執行前也會檢查這裡的結果，探測失敗的相依服務會阻擋相關工作。"
        actions={
          <Button leftSection={<IconRefresh size={16} />} onClick={() => probe.mutate([])} loading={probe.isPending && (probe.variables?.length ?? 0) === 0}>
            全部重新探測
          </Button>
        }
      />
      <QueryBoundary query={servicesQ}>
        {(data) => {
          const byCategory = new Map<string, ServiceProbe[]>();
          for (const s of data.services) {
            const c = s.category || "other";
            byCategory.set(c, [...(byCategory.get(c) ?? []), s]);
          }
          return (
            <Stack gap="lg">
              <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
                <StatCard label="正常" value={data.summary.ok} color="teal" />
                <StatCard label="受限" value={data.summary.degraded} color="amber" />
                <StatCard label="異常" value={data.summary.error} color="red" />
                <StatCard label="最後探測" value={<RelativeTime value={data.summary.last_checked_at} fz={22} fw={700} />} color="gray" />
              </SimpleGrid>

              {[...byCategory.entries()].map(([cat, list]) => (
                <Box key={cat}>
                  <Text fz="xs" fw={700} c="dimmed" tt="uppercase" mb="xs" style={{ letterSpacing: 0.5 }}>
                    {CATEGORY_LABEL[cat] ?? cat}
                  </Text>
                  <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
                    {list.map((p) => (
                      <ProbeCard
                        key={p.service_key}
                        p={p}
                        onProbe={() => probe.mutate([p.service_key])}
                        probing={probe.isPending && probe.variables?.length === 1 && probe.variables[0] === p.service_key}
                      />
                    ))}
                  </SimpleGrid>
                </Box>
              ))}

              <SectionCard title="背景 Worker" description="Worker 每 15 秒回報心跳；超過 45 秒沒有心跳視為失聯，其工作會被重新排隊。" flush>
                <QueryBoundary query={workersQ} skeleton={<Box h={80} />}>
                  {({ workers }) =>
                    workers.length === 0 ? (
                      <EmptyState compact title="沒有 Worker 回報心跳" description="請確認 admin-worker 容器正在執行；否則匯入與嵌入工作不會被處理。" />
                    ) : (
                      <DataTable
                        rows={workers}
                        rowKey={(w) => w.worker_name}
                        minWidth={640}
                        columns={[
                          {
                            key: "name",
                            header: "名稱",
                            primary: true,
                            render: (w) => (
                              <Group gap={8} wrap="nowrap">
                                <Dot color={w.stale ? "red" : w.status === "running" ? "blue" : "teal"} live={!w.stale && w.status === "running"} />
                                <Text fz="sm" fw={600}>
                                  {w.worker_name}
                                </Text>
                              </Group>
                            ),
                          },
                          {
                            key: "status",
                            header: "狀態",
                            render: (w) => (
                              <Badge color={w.stale ? "red" : w.status === "running" ? "blue" : "teal"} size="sm">
                                {w.stale ? "失聯" : w.status === "running" ? "執行中" : "閒置"}
                              </Badge>
                            ),
                          },
                          {
                            key: "job",
                            header: "目前工作",
                            render: (w) =>
                              w.current_job_id ? <Link to={`/jobs/${w.current_job_id}`}>{shortId(w.current_job_id)}</Link> : <Text fz="sm" c="dimmed">—</Text>,
                          },
                          { key: "pid", header: "PID", hideOnMobile: true, render: (w) => <Text fz="sm" ff="monospace">{w.process_id || "—"}</Text> },
                          { key: "hb", header: "最後心跳", render: (w) => <RelativeTime value={w.last_heartbeat_at} fz="sm" /> },
                        ]}
                      />
                    )
                  }
                </QueryBoundary>
              </SectionCard>

              <SectionCard title="探測紀錄" description="最近的探測結果" flush>
                <DataTable
                  rows={data.history}
                  rowKey={(p) => `${p.service_key}-${p.checked_at}`}
                  columns={historyColumns}
                  pageSize={10}
                  minWidth={640}
                  empty={<EmptyState compact title="尚無探測紀錄" description="按「全部重新探測」開始。" />}
                />
              </SectionCard>
            </Stack>
          );
        }}
      </QueryBoundary>
    </>
  );
}

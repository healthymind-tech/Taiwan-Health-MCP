// LLM 呼叫紀錄 tab: every Analysis-LM attempt for this license, with a
// side-by-side prompt vs response viewer.

import { Badge, Box, Center, Group, Loader, Modal, ScrollArea, SimpleGrid, Stack, Tabs, Text } from "@mantine/core";
import { IconMessageChatbot } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { JsonView } from "@/components/JsonView";
import { KeyValue } from "@/components/KeyValue";
import { SectionCard } from "@/components/SectionCard";
import { api, qs } from "@/lib/api";
import { fmtDateTime, fmtNumber, fmtRelative } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import type { LlmCallDetail, LlmCallSummary } from "./drugTypes";
import classes from "./drug.module.css";

const CALL_STATUS: Record<string, { label: string; color: string }> = {
  ok: { label: "成功", color: "teal" },
  budget: { label: "超出預算", color: "amber" },
  failed: { label: "失敗", color: "red" },
};

function CallStatus({ status }: { status: string }) {
  const m = CALL_STATUS[status] ?? { label: status || "未知", color: "gray" };
  return (
    <Badge color={m.color} variant="light" size="sm">
      {m.label}
    </Badge>
  );
}

function fmtLatency(ms: number): string {
  if (!ms) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${ms} ms`;
}

export function DetailLlmCalls({ licenseId }: { licenseId: string }) {
  const [selected, setSelected] = useState<number | null>(null);
  const q = useQuery({
    queryKey: qk.drugLlmCalls(licenseId),
    queryFn: () => api.get<{ calls: LlmCallSummary[] }>(`/admin/api/drug/llm-calls${qs({ license_id: licenseId })}`),
  });
  const calls = q.data?.calls ?? [];
  const totals = calls.reduce((a, c) => ({ p: a.p + c.promptTokens, c: a.c + c.completionTokens }), { p: 0, c: 0 });

  const columns: Column<LlmCallSummary>[] = [
    {
      key: "when",
      header: "時間",
      primary: true,
      render: (c) => (
        <Box>
          <Text fz="sm" fw={600}>
            {fmtDateTime(c.created_at)}
          </Text>
          <Text fz="xs" c="dimmed">
            {fmtRelative(c.created_at)} · 第 {c.attempt} 次嘗試
          </Text>
        </Box>
      ),
      sortValue: (c) => c.created_at ?? "",
    },
    {
      key: "model",
      header: "模型",
      render: (c) => (
        <Box style={{ minWidth: 0 }}>
          <Text fz="sm" style={{ wordBreak: "break-all" }}>
            {c.model || "—"}
          </Text>
          <Text fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
            {[c.profileName, c.provider].filter(Boolean).join(" · ")}
          </Text>
        </Box>
      ),
    },
    { key: "status", header: "結果", nowrap: true, render: (c) => <CallStatus status={c.status} /> },
    {
      key: "tokens",
      header: "Tokens（輸入 / 輸出）",
      align: "right",
      nowrap: true,
      render: (c) => (
        <Text fz="sm" style={{ fontVariantNumeric: "tabular-nums" }}>
          {fmtNumber(c.promptTokens)} / {fmtNumber(c.completionTokens)}
        </Text>
      ),
      sortValue: (c) => c.promptTokens + c.completionTokens,
    },
    { key: "latency", header: "耗時", align: "right", nowrap: true, render: (c) => <Text fz="sm">{fmtLatency(c.latencyMs)}</Text>, sortValue: (c) => c.latencyMs },
  ];

  return (
    <SectionCard
      title="LLM 呼叫紀錄"
      icon={<IconMessageChatbot size={18} />}
      description="Analysis LM 每次嘗試送出的提示詞與收到的回應。點擊一列查看完整內容。"
      flush
      actions={
        calls.length > 0 ? (
          <Text fz="xs" c="dimmed">
            共 {calls.length} 次 · {fmtNumber(totals.p)} / {fmtNumber(totals.c)} tokens
          </Text>
        ) : undefined
      }
    >
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={calls}
          rowKey={(c) => String(c.id)}
          loading={q.isPending}
          onRowClick={(c) => setSelected(c.id)}
          activeKey={selected !== null ? String(selected) : null}
          pageSize={20}
          minWidth={720}
          empty={<EmptyState compact icon={<IconMessageChatbot size={22} />} title="沒有 LLM 呼叫紀錄" description="這張許可證尚未經過 LLM 分析，或分析發生在呼叫紀錄功能上線之前。" />}
        />
      )}
      <CallModal id={selected} onClose={() => setSelected(null)} />
    </SectionCard>
  );
}

function CallModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const isMobile = useIsMobile();
  const q = useQuery({
    queryKey: ["drug", "llm-call", id],
    queryFn: () => api.get<LlmCallDetail>(`/admin/api/drug/llm-call${qs({ id })}`),
    enabled: id !== null,
    staleTime: Infinity,
  });
  const d = q.data;

  let parsed: unknown = null;
  let isJson = false;
  if (d?.responseContent.trim()) {
    try {
      parsed = JSON.parse(d.responseContent);
      isJson = true;
    } catch {
      /* plain text */
    }
  }

  const promptPane = d && (
    <Stack gap="sm">
      {d.promptMessages.length === 0 && <Text fz="sm" c="dimmed">沒有提示詞紀錄</Text>}
      {d.promptMessages.map((m, i) => (
        <Box key={i}>
          <Badge size="xs" variant="light" color={m.role === "system" ? "indigo" : m.role === "user" ? "brand" : "gray"} mb={4}>
            {m.role}
          </Badge>
          <Box p="sm" style={{ borderRadius: 8, background: "var(--mantine-color-default-hover)" }}>
            <Text fz="xs" ff="monospace" className={classes.prewrap}>
              {m.content}
            </Text>
          </Box>
        </Box>
      ))}
    </Stack>
  );
  const responsePane = d && (
    <Stack gap="sm">
      {d.error && (
        <Box p="sm" style={{ borderRadius: 8, background: "var(--mantine-color-red-light)" }}>
          <Text fz="xs" fw={600} c="red">
            錯誤
          </Text>
          <Text fz="xs" c="red" className={classes.prewrap}>
            {d.error}
          </Text>
        </Box>
      )}
      {!d.responseContent.trim() ? (
        <Text fz="sm" c="dimmed">
          沒有回應內容
        </Text>
      ) : isJson ? (
        <JsonView value={parsed} maxHeight={isMobile ? 4000 : 9999} />
      ) : (
        <Box p="sm" style={{ borderRadius: 8, background: "var(--mantine-color-default-hover)" }}>
          <Text fz="xs" ff="monospace" className={classes.prewrap}>
            {d.responseContent}
          </Text>
        </Box>
      )}
    </Stack>
  );

  return (
    <Modal opened={id !== null} onClose={onClose} size="95%" fullScreen={isMobile} title={<Text fw={650} fz="lg">LLM 呼叫 #{id}</Text>}>
      {q.isPending ? (
        <Center h={240}>
          <Loader />
        </Center>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : d ? (
        <Stack gap="md">
          <KeyValue
            cols={4}
            items={[
              { label: "時間", value: fmtDateTime(d.createdAt, true) },
              { label: "結果", value: <Group gap={6}><CallStatus status={d.status} /><Text fz="xs" c="dimmed">第 {d.attempt} 次嘗試</Text></Group> },
              { label: "模型", value: <Text fz="sm" style={{ wordBreak: "break-all" }}>{d.model || "—"}</Text> },
              { label: "設定檔 / 供應商", value: [d.profileName, d.provider].filter(Boolean).join(" · ") },
              { label: "輸入 tokens", value: fmtNumber(d.promptTokens) },
              { label: "輸出 tokens", value: fmtNumber(d.completionTokens) },
              { label: "耗時", value: fmtLatency(d.latencyMs) },
            ]}
          />
          {isMobile ? (
            <Tabs defaultValue="prompt">
              <Tabs.List grow>
                <Tabs.Tab value="prompt">提示詞（{d.promptMessages.length}）</Tabs.Tab>
                <Tabs.Tab value="response">回應</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="prompt" pt="sm">
                {promptPane}
              </Tabs.Panel>
              <Tabs.Panel value="response" pt="sm">
                {responsePane}
              </Tabs.Panel>
            </Tabs>
          ) : (
            <SimpleGrid cols={2} spacing="md">
              <Stack gap={6}>
                <Text fz="sm" fw={650}>
                  提示詞（{d.promptMessages.length} 則訊息）
                </Text>
                <ScrollArea h="62vh" type="auto" offsetScrollbars>
                  {promptPane}
                </ScrollArea>
              </Stack>
              <Stack gap={6}>
                <Text fz="sm" fw={650}>
                  回應{isJson ? "（JSON）" : ""}
                </Text>
                <ScrollArea h="62vh" type="auto" offsetScrollbars>
                  {responsePane}
                </ScrollArea>
              </Stack>
            </SimpleGrid>
          )}
        </Stack>
      ) : null}
    </Modal>
  );
}

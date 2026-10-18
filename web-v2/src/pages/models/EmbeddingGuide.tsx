import { Alert, Badge, Box, Button, Group, List, Modal, Stack, Table, Text } from "@mantine/core";
import { IconAlertTriangle, IconArrowRight, IconFingerprint, IconInfoCircle } from "@tabler/icons-react";
import { useState } from "react";
import { fmtNumber } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { EmbeddingSwitchModal, type SwitchPrefill } from "./EmbeddingSwitch";
import { TechDetails } from "./ErrorDetails";
import { useEmbeddingIdentity } from "./llmApi";
import { codeText, reindexEstimate, type CodeParams, type LlmErrorInfo } from "./llmErrors";
import classes from "./overview.module.css";

const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

const ATTEMPT_TEXT: Record<string, string> = {
  embedding_model_not_found: "伺服器上沒有這個模型",
  embedding_endpoint_unreachable: "連不上",
  embedding_endpoint_auth: "授權失敗",
  embedding_endpoint_error: "伺服器回錯誤",
  embedding_dims_unsupported: "向量維度不同",
  embedding_no_vectors: "沒有傳回向量",
  different_model: "是不同的模型（向量對不上）",
  unverifiable: "無法比對（只信任角色原本的端點）",
};

/**
 * Shown instead of a bare error when a save would change the system's
 * embedding model (or the model cannot be established): explains why editing
 * a profile cannot do that, and opens the guarded switch pre-filled.
 */
export function EmbeddingGuide({ info, onClose, onSwitched }: { info: LlmErrorInfo | null; onClose: () => void; onSwitched?: () => void }) {
  const isMobile = useIsMobile();
  const identity = useEmbeddingIdentity();
  const [prefill, setPrefill] = useState<SwitchPrefill | null>(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  const p = info?.params ?? {};
  const unresolved = info?.code === "embedding_identity_unresolved";
  const issue = p.endpoint_issue as { code?: string; params?: CodeParams } | null | undefined;
  const est = reindexEstimate(p);
  const counts = Array.isArray(p.vector_counts) ? (p.vector_counts as { label: string; count: number }[]) : [];
  const attempts = Array.isArray(p.attempts) ? (p.attempts as { name: string; code: string | null; similarity: number | null }[]) : [];
  const requested = p.requested_model ? { provider_id: p.requested_account_id === null ? null : Number(p.requested_account_id), model: s(p.requested_model), params: (p.requested_params as Record<string, unknown>) ?? {} } : null;

  const openSwitch = () => {
    setPrefill(requested);
    setSwitchOpen(true);
  };

  return (
    <>
      <Modal
        opened={Boolean(info) && !switchOpen}
        onClose={onClose}
        title={unresolved ? "無法確認系統目前的 Embedding 模型" : "要更換 Embedding 模型，請用「切換模型」流程"}
        size="lg"
        fullScreen={isMobile}
      >
        {info && (
          <Stack gap="md">
            {!unresolved && (
              <Group gap="xs" wrap="nowrap" className={classes.fromTo}>
                <Box style={{ minWidth: 0, flex: 1 }}>
                  <Text fz={10} fw={700} c="dimmed">
                    系統目前
                  </Text>
                  <Text fz="sm" fw={650} ff="monospace" truncate="end">
                    {s(p.current_model) || "—"}
                  </Text>
                  <Text fz={11} c="dimmed">
                    {s(p.current_dims)} 維・{fmtNumber(Number(p.vector_total ?? 0))} 筆向量
                  </Text>
                </Box>
                <IconArrowRight size={20} />
                <Box style={{ minWidth: 0, flex: 1 }}>
                  <Text fz={10} fw={700} c="dimmed">
                    你要改成
                  </Text>
                  <Text fz="sm" fw={650} ff="monospace" truncate="end">
                    {s(p.requested_model)}
                  </Text>
                  <Text fz={11} c="dimmed">
                    {s(p.requested_account)}・設定 {s(p.requested_dims)} 維
                    {p.requested_returned_dims && p.requested_returned_dims !== p.requested_dims ? `（實際回傳 ${s(p.requested_returned_dims)} 維）` : ""}
                  </Text>
                </Box>
              </Group>
            )}

            <Text fz="sm">
              {unresolved
                ? `系統已有 ${fmtNumber(Number(p.vector_total ?? 0))} 筆向量，但還沒有記錄它們是哪個模型產生的（系統 Embedding 指紋）。系統逐一請各端點重新產生幾筆既有向量來比對，沒有任何一個對得上，所以無法確認——在確認之前，也無法安全地檢查新加入的端點。`
                : `每一筆向量都必須來自同一個模型，否則語意搜尋會拿不同模型的向量互相比對，結果會悄悄失準。「${s(p.requested_model)}」產生的向量和現有向量不同${p.reason === "different_model" && typeof p.similarity === "number" ? `（相似度只有 ${(p.similarity as number).toFixed(3)}，需 ≥ ${s(p.min_similarity)}）` : p.reason !== "different_model" ? "（向量維度不同）" : ""}，所以不能直接改在 Profile 裡。`}
            </Text>

            {unresolved && attempts.length > 0 && (
              <Box>
                <Text fz="xs" fw={700} c="dimmed" mb={4}>
                  已嘗試的端點
                </Text>
                <Table fz="xs" withRowBorders={false} verticalSpacing={2}>
                  <Table.Tbody>
                    {attempts.map((a, i) => (
                      <Table.Tr key={i}>
                        <Table.Td ff="monospace" style={{ wordBreak: "break-all" }}>
                          {a.name}
                        </Table.Td>
                        <Table.Td c="red.7">{ATTEMPT_TEXT[a.code ?? ""] ?? a.code ?? "失敗"}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Box>
            )}

            {issue?.code && (
              <Alert color="amber" icon={<IconAlertTriangle size={18} />} title="切換前也要處理：向量維度">
                <Text fz="xs">{codeText(issue.code, issue.params)}</Text>
                <Text fz="xs" mt={4}>
                  切換對話框的「預先檢查」會再確認一次，選好維度後才會讓你執行。
                </Text>
              </Alert>
            )}

            <Box>
              <Text fz="sm" fw={650} mb={4}>
                {unresolved ? "可以這樣處理（擇一）" : "請這樣做"}
              </Text>
              {unresolved ? (
                <List size="sm" spacing={4} type="ordered">
                  <List.Item>讓原本產生這些向量的模型重新上線（例如在伺服器上重新部署舊模型），再儲存一次——系統會自動以它建立指紋。</List.Item>
                  <List.Item>
                    改用「切換模型…」流程，以新模型重建全部向量{est ? `（${est}）` : ""}。
                  </List.Item>
                </List>
              ) : (
                <List size="sm" spacing={4} type="ordered">
                  <List.Item>按下方「改用切換模型流程」，帳號與模型已帶入。</List.Item>
                  <List.Item>按「預先檢查」：確認新模型可用、向量維度正確（不會先刪任何東西）。</List.Item>
                  <List.Item>輸入 REINDEX 執行。系統會關閉 Embedding、清除舊向量{p.requested_returned_dims && p.requested_returned_dims !== p.current_dims ? "、調整向量欄位維度" : ""}、改用新模型並排入重建。</List.Item>
                  <List.Item>
                    重建期間語意搜尋暫時改為關鍵字比對{est ? `，預估${est}` : ""}（共用 GPU 時會更久），可在「背景工作」看進度。
                  </List.Item>
                </List>
              )}
              {counts.length > 0 && (
                <Group gap={6} mt="xs" wrap="wrap">
                  {counts.map((c) => (
                    <Badge key={c.label} variant="light" color="gray" tt="none">
                      {c.label} {fmtNumber(c.count)}
                    </Badge>
                  ))}
                </Group>
              )}
            </Box>

            {!unresolved && (
              <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />}>
                <Text fz="xs">只是想加一個備援端點？那它必須是同一個模型（{s(p.current_model)}），例如同一模型在另一台伺服器——這種可以直接加進 Profile，不必重建。</Text>
              </Alert>
            )}

            <TechDetails detail={info.detail} code={info.code} />

            <Group justify="flex-end" gap="xs">
              <Button variant="subtle" color="gray" onClick={onClose}>
                {unresolved ? "關閉" : "返回編輯"}
              </Button>
              <Button color="red" variant={unresolved ? "light" : "filled"} leftSection={<IconFingerprint size={16} />} onClick={openSwitch}>
                改用切換模型流程
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
      <EmbeddingSwitchModal
        opened={switchOpen}
        onClose={() => {
          setSwitchOpen(false);
          onClose();
        }}
        payload={identity.data}
        prefill={prefill}
        onSwitched={onSwitched}
      />
    </>
  );
}

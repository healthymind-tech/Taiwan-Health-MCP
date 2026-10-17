import { Alert, Badge, Box, Button, Group, Loader, Modal, Stack, Text, TextInput, ThemeIcon } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconArrowUp, IconCircleMinus, IconPlugOff, IconRoute, IconStack2, IconTrash } from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import { notify } from "@/components/notify";
import { api } from "@/lib/api";
import { llmErrorText } from "./llmErrors";
import { qk } from "@/lib/queryKeys";
import type { LlmProfileKind } from "@/lib/types";
import { embeddingKeys, llmKeys, type Route } from "./llmApi";
import classes from "./models.module.css";

interface DeletePlan {
  target: { id: number; name: string; kind: LlmProfileKind };
  modified: { id: number; name: string; removed: string[]; remaining: number }[];
  cascade: { id: number; name: string; because: string }[];
  unbound_roles: { role: LlmProfileKind; route: string }[];
  affected_roles: { role: LlmProfileKind; route: string }[];
  children_kept: { id: number; name: string }[];
  has_impact: boolean;
}

const ROLE_LABEL: Record<LlmProfileKind, string> = { analysis: "分析 LLM", embedding: "Embedding" };
const ROLE_STOP: Record<LlmProfileKind, string> = {
  analysis: "藥品仿單分析會無法執行，直到你重新指定 Profile。",
  embedding: "語意搜尋會退回純關鍵字比對，向量工作也無法執行，直到你重新指定 Profile。",
};

/** Delete a profile after showing everything it takes with it. */
export function DeleteProfileModal({ route, onClose }: { route: Route | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState("");
  useEffect(() => setConfirm(""), [route?.id]);

  const plan = useQuery({
    queryKey: ["llm", "delete-plan", route?.id],
    queryFn: () => api.get<DeletePlan>(`/admin/api/llm/routes/${route!.id}/impact`),
    enabled: route !== null,
    staleTime: 0,
  });

  const del = useMutation({
    mutationFn: () => api.post<{ plan: DeletePlan }>(`/admin/api/llm/routes/${route!.id}/delete`, { confirm }),
    onSuccess: async (r) => {
      const extra = r.plan.cascade.length ? `，連同${r.plan.cascade.map((c) => `「${c.name}」`).join("")}` : "";
      notify.success(`已刪除「${r.plan.target.name}」${extra}`);
      await qc.invalidateQueries({ queryKey: llmKeys.routes });
      void qc.invalidateQueries({ queryKey: embeddingKeys.identity });
      void qc.invalidateQueries({ queryKey: qk.services });
      onClose();
    },
    onError: (e) => notify.error(llmErrorText(e), "刪除失敗"),
  });

  const p = plan.data;
  const needsName = Boolean(p?.has_impact);
  const ready = p && (!needsName || confirm.trim() === p.target.name);

  return (
    <Modal opened={route !== null} onClose={() => !del.isPending && onClose()} title={`刪除 Profile「${route?.name ?? ""}」？`} size="lg" centered>
      {plan.isPending ? (
        <Group gap="xs">
          <Loader size="sm" />
          <Text fz="sm">分析影響範圍…</Text>
        </Group>
      ) : plan.isError ? (
        <Alert color="red">{llmErrorText(plan.error)}</Alert>
      ) : p ? (
        <Stack gap="md">
          {!p.has_impact ? (
            <Text fz="sm">沒有其他 Profile 引用它，也沒有角色正在使用它，刪除不會影響其他設定。</Text>
          ) : (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} title="這個 Profile 正被使用，刪除會連帶影響以下設定">
              <Text fz="xs">請確認下方每一項；所有變更會在同一個交易中一次完成。</Text>
            </Alert>
          )}

          {p.unbound_roles.length > 0 && (
            <Impact tone="red" icon={<IconPlugOff size={14} />} title="角色會中斷">
              {p.unbound_roles.map((r) => (
                <Item key={r.role} tone="red" service label={`${ROLE_LABEL[r.role]}（目前使用「${r.route}」）`} detail={ROLE_STOP[r.role]} />
              ))}
            </Impact>
          )}

          {p.cascade.length > 0 && (
            <Impact tone="red" icon={<IconTrash size={14} />} title="會一併刪除">
              {p.cascade.map((c) => (
                <Item key={c.id} tone="red" label={c.name} detail={`它唯一的成員「${c.because}」被刪除，刪除後會變成空的 Profile。`} />
              ))}
            </Impact>
          )}

          {p.modified.length > 0 && (
            <Impact tone="amber" icon={<IconCircleMinus size={14} />} title="會被修改">
              {p.modified.map((m) => (
                <Item key={m.id} tone="amber" label={m.name} detail={`移除成員 ${m.removed.map((x) => `「${x}」`).join("、")}，剩下 ${m.remaining} 個成員。`} />
              ))}
            </Impact>
          )}

          {p.affected_roles.length > 0 && (
            <Impact tone="amber" icon={<IconRoute size={14} />} title="請求路徑會改變">
              {p.affected_roles.map((r) => (
                <Item key={r.role} tone="amber" label={`${ROLE_LABEL[r.role]}（使用「${r.route}」）`} detail="它的 Profile 結構中包含被刪除的部分，之後的請求會少一條備援或分流路徑。" />
              ))}
            </Impact>
          )}

          {p.children_kept.length > 0 && (
            <Impact tone="gray" icon={<IconStack2 size={14} />} title="保留（不受影響）">
              {p.children_kept.map((c) => (
                <Item key={c.id} tone="gray" label={c.name} detail="原本被它包含，刪除後仍然保留，只是不再被它引用。" />
              ))}
            </Impact>
          )}

          {needsName && (
            <TextInput
              label={
                <>
                  輸入 Profile 名稱 <b>{p.target.name}</b> 確認刪除
                </>
              }
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
              placeholder={p.target.name}
            />
          )}

          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={onClose} disabled={del.isPending}>
              取消
            </Button>
            <Button color="red" leftSection={<IconTrash size={16} />} onClick={() => del.mutate()} loading={del.isPending} disabled={!ready}>
              {p.cascade.length ? `刪除 ${1 + p.cascade.length} 個 Profile` : "刪除"}
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}

function Impact({ tone, icon, title, children }: { tone: "red" | "amber" | "gray"; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Box className={classes.impact} data-tone={tone}>
      <Group gap={6} mb={6}>
        <ThemeIcon size={22} radius="xl" variant="light" color={tone}>
          {icon}
        </ThemeIcon>
        <Text fz="sm" fw={700}>
          {title}
        </Text>
      </Group>
      <Stack gap={6} className={classes.impactList}>
        {children}
      </Stack>
    </Box>
  );
}

function Item({ tone, label, detail, service }: { tone: "red" | "amber" | "gray"; label: string; detail: string; service?: boolean }) {
  return (
    <Group gap={8} wrap="nowrap" align="flex-start" className={classes.impactItem}>
      <IconArrowUp size={12} className={classes.impactArrow} data-tone={tone} />
      <Box style={{ minWidth: 0 }}>
        <Group gap={6}>
          <Text fz="sm" fw={600}>
            {label}
          </Text>
          {service && (
            <Badge size="xs" color="red" variant="light">
              服務中斷
            </Badge>
          )}
        </Group>
        <Text fz="xs" c="dimmed">
          {detail}
        </Text>
      </Box>
    </Group>
  );
}

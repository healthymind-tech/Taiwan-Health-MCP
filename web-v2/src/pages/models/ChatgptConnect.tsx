import { Alert, Badge, Box, Button, Checkbox, Code, Group, List, Stack, Switch, Text, TextInput, ThemeIcon } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconBrandOpenai, IconCheck, IconExternalLink, IconLink } from "@tabler/icons-react";
import { useState } from "react";
import { notify } from "@/components/notify";
import { RelativeTime } from "@/components/RelativeTime";
import { api } from "@/lib/api";
import { llmErrorText } from "./llmErrors";
import type { ProviderAccount } from "./llmApi";
import { MONO_INPUT } from "./fields";
import type { ProviderSpec } from "./profileModel";
import classes from "./models.module.css";

/** Terms the operator must accept, one checkbox each, before signing in. */
export function ChatgptTerms({ spec, accepted, onChange }: { spec: ProviderSpec; accepted: boolean[]; onChange: (next: boolean[]) => void }) {
  const items = spec.warnings ?? [];
  return (
    <Alert color="amber" icon={<IconAlertTriangle size={18} />} title="使用前請逐條確認" p="sm">
      <Stack gap={8} mt={4}>
        {items.map((w, i) => (
          <Checkbox
            key={i}
            size="xs"
            checked={Boolean(accepted[i])}
            onChange={(e) => {
              const next = [...accepted];
              next[i] = e.currentTarget.checked;
              onChange(next);
            }}
            label={<Text fz="xs">{w}</Text>}
          />
        ))}
      </Stack>
    </Alert>
  );
}

/** Whether role traffic (analysis jobs) may use this account — off by default. */
export function RoleUseSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch
      checked={value}
      onChange={(e) => onChange(e.currentTarget.checked)}
      label="允許角色正式使用（藥品仿單分析）"
      description="關閉時，這個帳號的模型只能手動測試，不會被分析工作的 Profile 使用。開啟前請確認不會送出可識別的病患資料。"
    />
  );
}

/**
 * Sign-in step: open OpenAI's sign-in in a new tab, then paste the address the
 * browser lands on (http://127.0.0.1:1455/auth/callback?…) — this server is
 * remote, so OpenAI's loopback redirect cannot reach it directly.
 */
export function ChatgptSignIn({
  name,
  existing,
  allowRoleUse,
  acknowledged,
  onConnected,
}: {
  name: string;
  existing: ProviderAccount | null;
  allowRoleUse: boolean;
  acknowledged: boolean;
  onConnected: (accountId: number, email: string) => void;
}) {
  const qc = useQueryClient();
  const [started, setStarted] = useState<{ authorize_url: string; redirect_uri: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      api.post<{ authorize_url: string; redirect_uri: string }>("/admin/api/llm/oauth/chatgpt/start", {
        name,
        account_id: existing?.id,
        allow_role_use: allowRoleUse,
        acknowledged,
      }),
    onSuccess: (r) => {
      setStarted(r);
      setError(null);
      window.open(r.authorize_url, "_blank", "noopener");
    },
    onError: (e) => setError(llmErrorText(e)),
  });

  const complete = useMutation({
    mutationFn: () => api.post<{ account_id: number; email: string }>("/admin/api/llm/oauth/chatgpt/complete", { callback_url: pasted.trim() }),
    onSuccess: async (r) => {
      notify.success(`已連線 ChatGPT 帳號 ${r.email}`);
      await qc.invalidateQueries({ queryKey: ["llm"] });
      onConnected(r.account_id, r.email);
    },
    onError: (e) => setError(llmErrorText(e)),
  });

  const looksRight = /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback\?/.test(pasted.trim());

  return (
    <Stack gap="md">
      {existing?.oauth && (
        <Group gap="sm" className={classes.oauthStatus} data-bad={existing.oauth.status !== "ok" || undefined}>
          <ThemeIcon radius="xl" color={existing.oauth.status === "ok" ? "teal" : "red"} variant="light">
            <IconBrandOpenai size={16} />
          </ThemeIcon>
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text fz="sm" fw={650} truncate="end">
              {existing.oauth.email || "（未取得 Email）"}
            </Text>
            <Text fz="xs" c="dimmed">
              由 {existing.oauth.connected_by} 登入
              {existing.oauth.connected_at && (
                <>
                  ・<RelativeTime value={existing.oauth.connected_at} fz="xs" c="dimmed" span />
                </>
              )}
            </Text>
          </Box>
          <Badge color={existing.oauth.status === "ok" ? "teal" : "red"} variant="light">
            {existing.oauth.status === "ok" ? "已連線" : "需重新登入"}
          </Badge>
        </Group>
      )}

      <Box className={classes.signInSteps}>
        <Stack gap="sm">
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <Badge circle size="lg">1</Badge>
            <Box style={{ flex: 1 }}>
              <Text fz="sm" fw={650}>
                開啟 ChatGPT 登入
              </Text>
              <Text fz="xs" c="dimmed">
                會在新分頁開啟 OpenAI 的官方登入頁。請允許「使用 ChatGPT 方案額度」。
              </Text>
              <Button
                mt="xs"
                size="sm"
                leftSection={<IconBrandOpenai size={16} />}
                rightSection={<IconExternalLink size={14} />}
                onClick={() => start.mutate()}
                loading={start.isPending}
                disabled={!acknowledged || (!existing && !name.trim())}
              >
                {existing ? "重新登入 ChatGPT" : "以 ChatGPT 登入"}
              </Button>
              {!acknowledged && (
                <Text fz="xs" c="amber.7" mt={4}>
                  請先在上一步勾選所有確認項目。
                </Text>
              )}
            </Box>
          </Group>

          <Group gap="sm" wrap="nowrap" align="flex-start" opacity={started ? 1 : 0.5}>
            <Badge circle size="lg">2</Badge>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text fz="sm" fw={650}>
                貼回登入後的網址
              </Text>
              <Text fz="xs" c="dimmed">
                登入完成後，瀏覽器會跳到 <Code>{started?.redirect_uri ?? "http://127.0.0.1:1455/auth/callback"}</Code> 並顯示「無法連線」——這是正常的（伺服器不在你的電腦上）。請複製網址列的
                <b>完整網址</b>貼在這裡。
              </Text>
              <TextInput
                mt="xs"
                leftSection={<IconLink size={14} />}
                placeholder="http://127.0.0.1:1455/auth/callback?code=…&state=…"
                value={pasted}
                onChange={(e) => setPasted(e.currentTarget.value)}
                disabled={!started}
                styles={MONO_INPUT}
                error={pasted.trim() && !looksRight ? "這看起來不是登入後的網址" : undefined}
              />
              <Button mt="xs" size="sm" variant="light" leftSection={<IconCheck size={16} />} onClick={() => complete.mutate()} loading={complete.isPending} disabled={!started || !looksRight}>
                完成連線
              </Button>
            </Box>
          </Group>
        </Stack>
      </Box>

      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="無法完成連線" withCloseButton onClose={() => setError(null)}>
          <Text fz="sm" style={{ wordBreak: "break-word" }}>
            {error}
          </Text>
        </Alert>
      )}

      <List size="xs" c="dimmed" spacing={2}>
        <List.Item>登入連結 15 分鐘內有效，且只能使用一次。</List.Item>
        <List.Item>Token 只存在伺服器，不會顯示在任何畫面或匯出檔中；要中斷連線，刪除此帳號並到 ChatGPT 設定移除授權。</List.Item>
      </List>
    </Stack>
  );
}

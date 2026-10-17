import { Alert, Button, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconInfoCircle, IconLogout, IconShieldLock, IconUserCircle } from "@tabler/icons-react";
import { useState } from "react";
import { confirmAction } from "@/components/confirm";
import { KeyValue } from "@/components/KeyValue";
import { PageHeader } from "@/components/PageHeader";
import { SectionCard } from "@/components/SectionCard";
import { api } from "@/lib/api";
import { fmtDuration } from "@/lib/format";
import { qk } from "@/lib/queryKeys";
import { PasskeysCard } from "./PasskeysCard";
import { PasswordCard } from "./PasswordCard";

interface Me {
  username: string;
  session_ttl_minutes?: number;
}

export default function SecurityPage() {
  return (
    <>
      <PageHeader
        title="帳號安全"
        description="管理登入此主控台的方式：密碼、passkey 與目前的工作階段。"
        icon={<IconShieldLock size={24} />}
        breadcrumbs={[{ label: "設定" }, { label: "帳號安全" }]}
      />
      <Stack gap="lg">
        <SessionCard />
        <PasskeysCard />
        <PasswordCard />
      </Stack>
    </>
  );
}

function SessionCard() {
  const me = useQuery({
    queryKey: qk.me,
    queryFn: () => api.get<Me>("/admin/api/me", { skipAuthRedirect: true }),
    staleTime: Infinity,
  });
  const [signingOut, setSigningOut] = useState(false);

  const signOut = () =>
    confirmAction({
      title: "登出？",
      message: "會清除此瀏覽器的登入狀態，並回到登入頁。",
      confirmLabel: "登出",
      onConfirm: async () => {
        setSigningOut(true);
        await api.post("/admin/api/logout").catch(() => undefined);
        window.location.href = "/admin/login";
      },
    });

  const ttl = me.data?.session_ttl_minutes;
  return (
    <SectionCard
      title="目前的工作階段"
      icon={<IconUserCircle size={18} />}
      actions={
        <Button variant="default" color="gray" leftSection={<IconLogout size={16} />} onClick={signOut} loading={signingOut}>
          登出
        </Button>
      }
    >
      <Stack gap="md">
        <KeyValue
          cols={2}
          items={[
            { label: "帳號", value: me.data ? <Text fw={600}>{me.data.username}</Text> : me.isPending ? "載入中…" : "—" },
            { label: "工作階段有效期", value: ttl ? `登入後 ${fmtDuration(ttl * 60)}` : "—" },
          ]}
        />
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={18} />} p="sm">
          <Text fz="xs">
            工作階段由簽章 cookie 維持，到期後需重新登入。「登出」只會清除這個瀏覽器的 cookie；在其他裝置登入的工作階段會持續到各自到期，
            變更密碼也不會讓它們立即失效。若懷疑帳號外洩，請變更密碼並請部署管理者更換 session 簽章金鑰。
          </Text>
        </Alert>
      </Stack>
    </SectionCard>
  );
}


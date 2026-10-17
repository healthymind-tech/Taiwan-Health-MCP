import { Tabs } from "@mantine/core";
import { IconBrain, IconKey, IconLayoutDashboard, IconStack2 } from "@tabler/icons-react";
import { useSearchParams } from "react-router";
import { PageHeader } from "@/components/PageHeader";
import { AccountsTab } from "./AccountsTab";
import { ProfilesTab } from "./ProfilesTab";
import { OverviewTab } from "./OverviewTab";

type Tab = "overview" | "accounts" | "profiles";
const TABS: Tab[] = ["overview", "accounts", "profiles"];

/**
 * Model endpoints, in three layers: provider accounts (connections + keys) →
 * profiles (models composed with a strategy, nestable) → roles (which profile
 * analysis / embedding use).
 */
export default function ModelsPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") as Tab | null;
  const tab: Tab = raw && TABS.includes(raw) ? raw : "overview";
  return (
    <>
      <PageHeader
        title="模型端點"
        description="三層設定：先接上 Provider 帳號，再把模型組合成 Profile（單一、備援、輪詢、加權負載平衡，可巢狀），最後指定分析 LLM 與 Embedding 各用哪個 Profile。"
        icon={<IconBrain size={24} />}
        breadcrumbs={[{ label: "設定" }, { label: "模型端點" }]}
      />
      <Tabs
        value={tab}
        onChange={(v) => {
          if (!v) return;
          const next = new URLSearchParams(params);
          next.set("tab", v);
          setParams(next, { replace: true });
        }}
        variant="pills"
        radius="md"
        keepMounted={false}
      >
        <Tabs.List mb="lg">
          <Tabs.Tab value="overview" leftSection={<IconLayoutDashboard size={18} />}>
            總覽
          </Tabs.Tab>
          <Tabs.Tab value="accounts" leftSection={<IconKey size={18} />}>
            Provider 帳號
          </Tabs.Tab>
          <Tabs.Tab value="profiles" leftSection={<IconStack2 size={18} />}>
            Profiles
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview">
          <OverviewTab />
        </Tabs.Panel>
        <Tabs.Panel value="accounts">
          <AccountsTab />
        </Tabs.Panel>
        <Tabs.Panel value="profiles">
          <ProfilesTab />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

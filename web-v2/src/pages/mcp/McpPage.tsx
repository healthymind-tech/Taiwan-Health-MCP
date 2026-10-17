import { Badge, Tabs } from "@mantine/core";
import { IconApi, IconLayoutGrid, IconPlayerPlay, IconWorld } from "@tabler/icons-react";
import { useSearchParams } from "react-router";
import { PageHeader } from "@/components/PageHeader";
import { CatalogTab, type CatalogFilters, type StatusFilter } from "./CatalogTab";
import { useMcpCatalog } from "./mcpApi";
import { OverviewTab } from "./OverviewTab";
import { PlaygroundTab } from "./PlaygroundTab";

type Tab = "overview" | "catalog" | "playground";
const TABS: Tab[] = ["overview", "catalog", "playground"];

/**
 * MCP 工具: the public MCP / OpenAPI surface (endpoints, auth, client config),
 * every tool with its enabled state, and a playground that runs any enabled tool.
 * All view state lives in the URL (tab, tool, q, group, status).
 */
export default function McpPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") as Tab | null;
  const tab: Tab = raw && TABS.includes(raw) ? raw : "overview";
  const catalogQ = useMcpCatalog();
  const totals = catalogQ.data?.totals;

  const update = (patch: Record<string, string | null>, push = false) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: !push });
  };

  const status = (params.get("status") as StatusFilter | null) ?? "all";
  const filters: CatalogFilters = {
    q: params.get("q") ?? "",
    group: params.get("group"),
    status: ["all", "enabled", "disabled"].includes(status) ? status : "all",
  };

  return (
    <>
      <PageHeader
        title="MCP 工具"
        description="對外的 MCP 與 OpenAPI 端點、所有工具與其啟用狀態，並可直接在網頁上測試每個工具。"
        icon={<IconApi size={24} />}
        breadcrumbs={[{ label: "整合" }, { label: "MCP 工具" }]}
        badge={
          totals ? (
            <Badge size="lg" variant="light" color={totals.disabled ? "amber" : "teal"} className="tabular">
              {totals.enabled} / {totals.total} 啟用
            </Badge>
          ) : undefined
        }
      />
      <Tabs value={tab} onChange={(v) => v && update({ tab: v }, true)} variant="pills" radius="md">
        <Tabs.List mb="lg">
          <Tabs.Tab value="overview" leftSection={<IconWorld size={18} />}>
            端點與連線
          </Tabs.Tab>
          <Tabs.Tab value="catalog" leftSection={<IconLayoutGrid size={18} />}>
            工具目錄
          </Tabs.Tab>
          <Tabs.Tab value="playground" leftSection={<IconPlayerPlay size={18} />}>
            測試台
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview">
          <OverviewTab onOpenCatalog={(s) => update({ tab: "catalog", status: s ?? null, group: null, q: null }, true)} />
        </Tabs.Panel>
        <Tabs.Panel value="catalog">
          <CatalogTab
            filters={filters}
            setFilters={(f) =>
              update({
                ...(f.q !== undefined ? { q: f.q } : {}),
                ...(f.group !== undefined ? { group: f.group } : {}),
                ...(f.status !== undefined ? { status: f.status === "all" ? null : f.status } : {}),
              })
            }
            onTry={(name) => update({ tab: "playground", tool: name }, true)}
          />
        </Tabs.Panel>
        <Tabs.Panel value="playground">
          <PlaygroundTab toolName={params.get("tool")} setToolName={(n) => update({ tool: n })} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

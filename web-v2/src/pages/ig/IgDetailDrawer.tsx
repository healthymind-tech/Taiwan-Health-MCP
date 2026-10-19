import { Badge, Button, Group, Stack, Tabs, Text, Tooltip } from "@mantine/core";
import { IconArrowLeft, IconBooks, IconBox, IconCloudDownload, IconFileDescription, IconListTree, IconStar, IconTrash } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { ErrorState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { PageSkeleton } from "@/components/QueryBoundary";
import { api } from "@/lib/api";
import { fmtNumber } from "@/lib/format";
import { qk } from "@/lib/queryKeys";
import type { IgDetail, IgRef } from "./igTypes";
import { IgArtifactBrowser } from "./IgArtifactBrowser";
import { OriginBadge } from "./igOriginBadge";
import { IgOverviewTab } from "./detail/IgOverviewTab";
import { IgCodeSystemsTab } from "./detail/IgCodeSystemsTab";
import { DP, useDetailParams } from "./detail/detailMeta";
import type { Category } from "./detail/explorerApi";
import classes from "./detail/detail.module.css";

const TABS = ["overview", "artifacts", "cs"] as const;

/**
 * Full-page IG detail (IG 套件庫 → click an IG). State lives in the URL:
 * `ig=<pkg>@<ver>` plus `itab`, and per tab `cat` / `grp` / `aq` / `art` / `cs` / `csv` / `csq`.
 * (File name kept from the former drawer.)
 */
export function IgDetailView({
  target,
  onBack,
  onSetDefault,
  onRemove,
  settingDefault,
  removeBlock,
  onOpenDeps,
  onOpenIg,
}: {
  target: IgRef;
  onBack: () => void;
  onSetDefault: (ig: IgRef) => void;
  onRemove: (ig: IgDetail) => void;
  settingDefault: boolean;
  removeBlock: string | null;
  onOpenDeps: (ig: IgDetail) => void;
  onOpenIg: (ig: IgRef) => void;
}) {
  const { get, patch } = useDetailParams();
  const q = useQuery({
    queryKey: qk.igDetail(target.package_id, target.version),
    queryFn: () => api.get<IgDetail>(`/admin/api/igs/${encodeURIComponent(target.package_id)}/${encodeURIComponent(target.version)}`),
  });
  const d = q.data;
  const tabParam = get(DP.tab);
  const tab = (TABS as readonly string[]).includes(tabParam ?? "") ? tabParam! : "overview";

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [target.package_id, target.version]);

  const setTab = (t: string | null) => patch({ [DP.tab]: !t || t === "overview" ? null : t });
  const jump = (category: Category, group?: string | null) => patch({ [DP.tab]: "artifacts", [DP.cat]: category, [DP.group]: group ?? null, [DP.q]: null, [DP.artifact]: null });
  const openCodeSystem = (csId: string) => patch({ [DP.tab]: "cs", [DP.cs]: csId, [DP.artifact]: null, [DP.csQ]: null });
  const openValueSet = (key: string) => patch({ [DP.tab]: "artifacts", [DP.cat]: "terminology", [DP.group]: null, [DP.q]: null, [DP.artifact]: key });

  const title = d?.title ?? target.package_id;

  return (
    <div className={classes.root}>
      <PageHeader
        title={title}
        icon={<IconBooks size={22} />}
        breadcrumbs={[{ label: "FHIR" }, { label: "IG 套件庫" }, { label: `${target.package_id}@${target.version}` }]}
        badge={
          d?.is_default ? (
            <Badge color="brand" leftSection={<IconStar size={11} />}>
              預設
            </Badge>
          ) : undefined
        }
        actions={
          <>
            <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={onBack}>
              返回 IG 套件庫
            </Button>
            {d && (
              <>
                <Tooltip label={d.is_default ? "已是預設 IG" : "未指定 IG 的 MCP 工具會使用預設 IG"} multiline maw={260}>
                  <Button variant="light" leftSection={<IconStar size={16} />} disabled={d.is_default} loading={settingDefault} onClick={() => onSetDefault(d)}>
                    設為預設
                  </Button>
                </Tooltip>
                {d.deps_missing.length > 0 && (
                  <Button variant="light" color="amber" leftSection={<IconCloudDownload size={16} />} onClick={() => onOpenDeps(d)}>
                    補齊相依（{d.deps_missing.length}）
                  </Button>
                )}
                <Tooltip label={removeBlock} disabled={!removeBlock}>
                  <Button variant="subtle" color="red" leftSection={<IconTrash size={16} />} disabled={Boolean(removeBlock)} onClick={() => onRemove(d)}>
                    移除此 IG
                  </Button>
                </Tooltip>
              </>
            )}
          </>
        }
      />

      <Group gap={6} wrap="wrap" mt={-8} mb="lg" pl={{ base: 0, sm: 60 }}>
        <Text span ff="monospace" fz="sm" c="dimmed">
          {target.package_id}
        </Text>
        <Badge variant="outline" color="gray" ff="monospace">
          v{target.version}
        </Badge>
        {d?.fhir_version && (
          <Badge variant="light" color="gray">
            FHIR {d.fhir_version}
          </Badge>
        )}
        {d?.install_origin && <OriginBadge origin={d.install_origin} />}
      </Group>

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !d ? (
        <PageSkeleton rows={3} />
      ) : (
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List mb="lg">
            <Tabs.Tab value="overview" leftSection={<IconFileDescription size={16} />}>
              概要
            </Tabs.Tab>
            <Tabs.Tab value="artifacts" leftSection={<IconBox size={16} />}>
              構件（{fmtNumber(d.counts.artifacts)}）
            </Tabs.Tab>
            <Tabs.Tab value="cs" leftSection={<IconListTree size={16} />}>
              CodeSystem（{fmtNumber(d.codesystems.length)}）
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="overview" className={classes.fadeUp}>
            <IgOverviewTab ig={target} detail={d} onJump={jump} onOpenDeps={() => onOpenDeps(d)} onOpenIg={onOpenIg} />
          </Tabs.Panel>
          <Tabs.Panel value="artifacts" className={classes.fadeUp}>
            <IgArtifactBrowser ig={target} onOpenCodeSystem={openCodeSystem} />
          </Tabs.Panel>
          <Tabs.Panel value="cs" className={classes.fadeUp}>
            <Stack gap="md">
              <IgCodeSystemsTab ig={target} onOpenValueSet={openValueSet} />
            </Stack>
          </Tabs.Panel>
        </Tabs>
      )}
    </div>
  );
}

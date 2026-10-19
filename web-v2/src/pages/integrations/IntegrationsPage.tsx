import { Badge, Box, Group, ScrollArea, Stack, Tabs, Text } from "@mantine/core";
import {
  IconBox,
  IconBuildingHospital,
  IconCpu,
  IconDatabase,
  IconPackages,
  IconPlugConnected,
  IconScan,
  IconSettings,
} from "@tabler/icons-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { QueryBoundary } from "@/components/QueryBoundary";
import { SectionCard } from "@/components/SectionCard";
import type { SettingsGroup } from "@/lib/types";
import { OcrProviderNotes, OCR_SEGMENTED } from "./OcrProviderNotes";
import { OcrTestPanel } from "./OcrTestPanel";
import { SettingsGroupForm } from "./SettingsGroupForm";
import { HIDDEN_GROUPS, MODEL_GROUPS, groupDescription, groupLabel, useSettings } from "./settingsModel";

const GROUP_ICON: Record<string, ReactNode> = {
  ocr: <IconScan size={18} />,
  minio: <IconBox size={18} />,
  tfda: <IconBuildingHospital size={18} />,
  registry: <IconPackages size={18} />,
  worker: <IconCpu size={18} />,
};

/** Aliases accepted in `?tab=` deep links. */
const TAB_ALIASES: Record<string, string> = { "ocr-test": "ocr", mineru: "ocr", storage: "minio", "object-storage": "minio" };

export default function IntegrationsPage() {
  const q = useSettings();
  return (
    <>
      <PageHeader
        title="外部服務"
        description="系統依賴的外部服務：OCR、物件儲存、食藥署爬蟲、FHIR 套件 registry 與背景工作程序。每組設定都可以先「測試連線」再儲存；儲存後立即生效，不需重新啟動。"
        icon={<IconPlugConnected size={24} />}
        breadcrumbs={[{ label: "設定" }, { label: "外部服務" }]}
      />
      <QueryBoundary query={q}>{(data) => <IntegrationTabs groups={data.groups} />}</QueryBoundary>
    </>
  );
}

function IntegrationTabs({ groups }: { groups: SettingsGroup[] }) {
  const [params, setParams] = useSearchParams();
  const testRef = useRef<HTMLDivElement | null>(null);
  const visible = groups.filter((g) => !MODEL_GROUPS.has(g.group) && !HIDDEN_GROUPS.has(g.group));

  const rawTab = params.get("tab") ?? "";
  const wanted = TAB_ALIASES[rawTab] ?? rawTab;
  const active = visible.some((g) => g.group === wanted) ? wanted : (visible[0]?.group ?? "");

  // `?tab=ocr-test` deep-links straight to the OCR test section.
  useEffect(() => {
    if (rawTab === "ocr-test" && testRef.current) {
      testRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [rawTab]);

  if (visible.length === 0) {
    return <EmptyState icon={<IconSettings size={28} />} title="沒有可設定的外部服務" description="伺服器沒有回傳任何設定群組。" />;
  }

  return (
    <Tabs
      value={active}
      onChange={(v) => {
        if (!v) return;
        const next = new URLSearchParams(params);
        next.set("tab", v);
        setParams(next, { replace: true });
      }}
      keepMounted={false}
      variant="pills"
      radius="md"
    >
      <ScrollArea type="never" mb="lg" offsetScrollbars={false}>
        <Tabs.List style={{ flexWrap: "nowrap" }}>
          {visible.map((g) => (
            <Tabs.Tab key={g.group} value={g.group} leftSection={GROUP_ICON[g.group] ?? <IconDatabase size={18} />} style={{ whiteSpace: "nowrap" }}>
              {groupLabel(g)}
              {g.readonly && (
                <Badge size="xs" variant="light" color="gray" ml={6}>
                  唯讀
                </Badge>
              )}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </ScrollArea>

      {visible.map((g) => (
        <Tabs.Panel key={g.group} value={g.group}>
          <Stack gap="lg">
            <SectionCard
              title={
                <Group gap="xs" wrap="wrap">
                  <span>{groupLabel(g)}</span>
                  <Text span ff="monospace" fz="xs" c="dimmed" fw={400}>
                    {g.group}
                  </Text>
                </Group>
              }
              description={groupDescription(g)}
              icon={GROUP_ICON[g.group] ?? <IconDatabase size={18} />}
            >
              {g.group === "ocr" ? (
                <SettingsGroupForm group={g} segmented={OCR_SEGMENTED} footer={<OcrProviderNotes />} />
              ) : (
                <SettingsGroupForm group={g} />
              )}
            </SectionCard>
            {g.group === "ocr" && (
              <Box ref={testRef} style={{ scrollMarginTop: 80 }}>
                <SectionCard
                  title="OCR 測試"
                  description="用內建範例或你自己的檔案實際跑一次 OCR，並排比對原始檔與輸出的 Markdown。"
                  icon={<IconScan size={18} />}
                >
                  <OcrTestPanel />
                </SectionCard>
              </Box>
            )}
          </Stack>
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

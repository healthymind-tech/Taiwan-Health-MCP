import { Box, Group, SegmentedControl, Text } from "@mantine/core";
import { IconChartDots3, IconTable } from "@tabler/icons-react";
import { lazy, Suspense, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/QueryBoundary";
import { SectionCard } from "@/components/SectionCard";
import { PreviewSection } from "@/pages/modules/PreviewSection";

const IcdExplorer = lazy(() => import("./IcdExplorer"));
const SnomedExplorer = lazy(() => import("./SnomedExplorer").then((m) => ({ default: m.SnomedExplorer })));
const LoincExplorer = lazy(() => import("./LoincExplorer").then((m) => ({ default: m.LoincExplorer })));
const RxnormExplorer = lazy(() => import("./RxnormExplorer").then((m) => ({ default: m.RxnormExplorer })));

const VISUAL: Record<string, { title: string; description: string; render: () => ReactNode }> = {
  icd: {
    title: "ICD-10 階層瀏覽",
    description: "章 → 節 → 類目 → 次類目 → 可申報碼的單一階層樹；第 7 碼延伸收合為 A / D / S 標籤。PCS 以七軸與術式表呈現。",
    render: () => <IcdExplorer />,
  },
  snomed: {
    title: "SNOMED CT 概念圖",
    description: "以聚焦概念為中心：上方為多個父概念（多重繼承），下方為子概念，右側為屬性關係；停用概念顯示歷史關聯。",
    render: () => <SnomedExplorer />,
  },
  loinc: {
    title: "LOINC 多軸瀏覽",
    description: "依六軸（成分 / 屬性 / 時間 / 檢體 / 尺度 / 方法）、類別與狀態篩選；術語卡片顯示軸條、Part 代碼、答案清單、面板與參考值。",
    render: () => <LoincExplorer />,
  },
  rxnorm: {
    title: "RxNorm 分層瀏覽",
    description: "依詞彙類型（TTY）分層：成分 → 臨床藥品 → 品牌藥品；關係由正規化名稱推導。",
    render: () => <RxnormExplorer />,
  },
};

/**
 * 「資料預覽」tab: a structure-aware visual explorer per terminology, with the
 * original flat table one click away (?view=table).
 */
export function TerminologyExplorer({ moduleKey, hasData }: { moduleKey: string; hasData: boolean }) {
  const [sp, setSp] = useSearchParams();
  const v = VISUAL[moduleKey];
  if (!v) return <PreviewSection moduleKey={moduleKey} hasData={hasData} />;
  const view = sp.get("view") === "table" ? "table" : "visual";
  const setView = (next: string) => {
    const p = new URLSearchParams(sp);
    if (next === "table") p.set("view", "table");
    else p.delete("view");
    setSp(p, { replace: true });
  };
  const toggle = (
    <SegmentedControl
      size="xs"
      value={view}
      onChange={setView}
      data={[
        {
          value: "visual",
          label: (
            <Group gap={6} wrap="nowrap">
              <IconChartDots3 size={14} />
              <span>視覺化</span>
            </Group>
          ),
        },
        {
          value: "table",
          label: (
            <Group gap={6} wrap="nowrap">
              <IconTable size={14} />
              <span>表格</span>
            </Group>
          ),
        },
      ]}
    />
  );
  if (view === "table") {
    return (
      <Box>
        <Group justify="flex-end" mb="sm">
          {toggle}
        </Group>
        <PreviewSection moduleKey={moduleKey} hasData={hasData} />
      </Box>
    );
  }
  return (
    <SectionCard title={v.title} description={v.description} icon={<IconChartDots3 size={18} />} actions={toggle}>
      {hasData ? (
        <Suspense fallback={<PageSkeleton rows={3} />}>{v.render()}</Suspense>
      ) : (
        <EmptyState compact title="尚無資料可預覽" description={<Text fz="sm">完成匯入後，這裡會以符合此術語結構的方式呈現資料。</Text>} />
      )}
    </SectionCard>
  );
}

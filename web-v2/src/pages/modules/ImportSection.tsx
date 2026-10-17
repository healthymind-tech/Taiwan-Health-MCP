import { Alert, Anchor, Button, Group, List, Stack, Text, Tooltip } from "@mantine/core";
import { IconCloudDownload, IconDatabaseImport, IconInfoCircle, IconPlayerPlay } from "@tabler/icons-react";
import { Link } from "react-router";
import { SectionCard } from "@/components/SectionCard";
import { RelativeTime } from "@/components/RelativeTime";
import { JobStatusBadge } from "@/components/StatusBadge";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import { useStartJob } from "@/lib/jobs";
import { fmtNumber } from "@/lib/format";
import { jobTypeLabel, type ModuleMeta } from "@/lib/meta";
import type { JobSummary } from "@/lib/types";
import { InlineJobProgress } from "./JobProgress";
import { roleLabel, type SourceReadiness } from "./SourcesSection";

/** Toast with a link to the new job. */
export function notifyJobStarted(job: JobSummary | undefined, what: string): void {
  notify.success(
    <Stack gap={2}>
      <Text fz="sm">{what}已加入佇列，背景工作程序會接手執行。</Text>
      {job?.job_id && (
        <Anchor component={Link} to={`/jobs/${job.job_id}`} fz="sm">
          查看工作進度
        </Anchor>
      )}
    </Stack>,
    "工作已建立",
  );
}

export function ImportSection({
  meta,
  rows,
  readiness,
  activeImport,
  activeOther,
  lastImport,
  stepNumber,
}: {
  meta: ModuleMeta;
  rows: number;
  /** null for API-sync modules (no uploads). */
  readiness: SourceReadiness | null;
  activeImport: JobSummary | null;
  /** Another active job for this module (e.g. embedding) that blocks a new import. */
  activeOther: JobSummary | null;
  lastImport: JobSummary | null;
  stepNumber: string;
}) {
  const start = useStartJob();
  const isSync = meta.kind === "sync";
  const jobType = meta.importJobType;
  const hasData = rows > 0;

  let blockReason: string | null = null;
  if (!jobType) blockReason = "此模組沒有匯入工作";
  else if (activeImport) blockReason = "匯入工作進行中，請等待完成";
  else if (activeOther) blockReason = `${jobTypeLabel(activeOther.job_type)}進行中，完成後才能匯入`;
  else if (readiness && !readiness.ready)
    blockReason = `缺少必要來源檔：${readiness.missing.map((e) => roleLabel(e)).join("、")}`;

  const run = async () => {
    if (!jobType) return;
    try {
      const res = await start.mutateAsync({ job_type: jobType, module_key: meta.key });
      notifyJobStarted(res.job, isSync ? "同步工作" : "匯入工作");
    } catch (e) {
      notify.error(e, isSync ? "無法開始同步" : "無法開始匯入");
      throw e;
    }
  };

  const onClick = () => {
    if (!hasData) {
      void run().catch(() => undefined);
      return;
    }
    confirmAction({
      title: isSync ? "重新同步並取代現有資料？" : "重新匯入並取代現有資料？",
      message: isSync
        ? "會先從食藥署開放資料完整下載，全部成功後才在單一交易中替換資料表。"
        : "會先把使用中的來源檔解析到暫存表並驗證，全部成功後才在單一交易中替換正式資料表。",
      consequences: [
        `現有 ${fmtNumber(rows)} 筆資料會被新資料整批取代（不是增量合併）`,
        "處理期間 MCP 工具持續使用舊資料；最後替換的那一刻查詢會短暫等待鎖定，不會看到空表",
        "若中途失敗，舊資料完全保留",
        meta.embedJobType ? "既有向量會保留；匯入後請執行向量嵌入，只有內容變動的列會重新計算" : null,
      ].filter((x): x is string => Boolean(x)),
      confirmLabel: isSync ? "開始同步" : "開始匯入",
      onConfirm: run,
    });
  };

  return (
    <SectionCard
      title={`${stepNumber} ${isSync ? "同步" : "匯入"}`}
      icon={isSync ? <IconCloudDownload size={18} /> : <IconDatabaseImport size={18} />}
      description={
        isSync
          ? `從上游（${meta.source}）抓取最新資料並寫入資料庫。`
          : "把使用中的來源檔解析並寫入資料庫。完成後此模組的 MCP 工具即可使用。"
      }
      actions={
        <Tooltip label={blockReason} disabled={!blockReason} multiline maw={300}>
          <Button
            leftSection={<IconPlayerPlay size={16} />}
            onClick={onClick}
            loading={start.isPending}
            disabled={Boolean(blockReason)}
          >
            {isSync ? "立即同步" : hasData ? "重新匯入" : "開始匯入"}
          </Button>
        </Tooltip>
      }
    >
      <Stack gap="sm">
        {activeImport && <InlineJobProgress job={activeImport} />}
        {!activeImport && activeOther && <InlineJobProgress job={activeOther} />}
        {readiness && readiness.inactiveOnly.length > 0 && (
          <Alert color="amber" icon={<IconInfoCircle size={16} />} p="sm">
            <Text fz="sm">
              {readiness.inactiveOnly.map((e) => roleLabel(e)).join("、")} 沒有「使用中」的版本；匯入時後端會改用最近一次上傳的檔案。
            </Text>
          </Alert>
        )}
        <Group gap="xs" wrap="wrap">
          <Text fz="sm" c="dimmed">
            上次{isSync ? "同步" : "匯入"}：
          </Text>
          {lastImport ? (
            <>
              <JobStatusBadge status={lastImport.status} size="xs" />
              <RelativeTime value={lastImport.finished_at ?? lastImport.updated_at ?? lastImport.created_at} fz="sm" />
              <Anchor component={Link} to={`/jobs/${lastImport.job_id}`} fz="sm">
                詳情
              </Anchor>
            </>
          ) : (
            <Text fz="sm">尚未執行過</Text>
          )}
        </Group>
        <List size="xs" c="dimmed" spacing={2} icon={<IconInfoCircle size={12} />}>
          <List.Item>
            整批替換：資料先{isSync ? "完整下載" : "暫存並驗證"}，最後在單一交易中取代舊資料，失敗時舊資料不受影響，不需要先開維護模式。
          </List.Item>
          {meta.embedJobType && <List.Item>匯入完成後，請到下方「向量嵌入」補齊新增或變動列的向量。</List.Item>}
        </List>
      </Stack>
    </SectionCard>
  );
}

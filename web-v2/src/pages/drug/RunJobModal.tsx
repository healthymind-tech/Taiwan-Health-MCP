// Options form for starting a drug job: the unified pipeline, a single legacy
// stage, or a per-file CSV import. Option names mirror `drugJobOptions` in
// node-server/src/admin/adminJobs.ts.

import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Group,
  List,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
} from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { confirmAction } from "@/components/confirm";
import { notify } from "@/components/notify";
import { ApiError, errorMessage } from "@/lib/api";
import { fmtNumber, shortId } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { useStartJob, type StartJobBody } from "@/lib/jobs";
import { jobTypeLabel } from "@/lib/meta";
import { qk } from "@/lib/queryKeys";
import type { UploadedFile } from "@/lib/types";
import { DEFAULT_BATCH_LIMIT, DRUG_MODULE_KEY } from "./drugMeta";

export interface RunJobPreset {
  /** Import a specific uploaded CSV (per-file "匯入"). */
  file?: UploadedFile | null;
  retryFailed?: boolean;
  licenseIds?: string[];
}

type JobKind = "drug_pipeline" | "drug_enrichment" | "drug_analysis" | "drug_index_import";

const RUN_KINDS: { value: JobKind; label: string; help: string }[] = [
  {
    value: "drug_pipeline",
    label: "完整管線",
    help: "每張許可證依序完成：TFDA 爬取（電子仿單、PDF、外觀圖）→ 存入物件儲存 → OCR（MinerU / Indra）→ LLM 分析 → 正規化。建議使用。",
  },
  {
    value: "drug_enrichment",
    label: "僅爬取",
    help: "只向 TFDA 爬取資料並存檔，不做 OCR 與 LLM 分析。適合 OCR／LLM 端點尚未設定時先累積檔案。",
  },
  {
    value: "drug_analysis",
    label: "僅分析",
    help: "只對已存檔的仿單 PDF 執行 OCR + LLM 分析，不再呼叫 TFDA。",
  },
];

function parseIds(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,，;；]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function RunJobModal({
  opened,
  onClose,
  preset,
  queuePending,
  queueFailed,
}: {
  opened: boolean;
  onClose: () => void;
  preset: RunJobPreset;
  queuePending: number;
  queueFailed: number;
}) {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const start = useStartJob();
  const isImport = Boolean(preset.file);

  const [kind, setKind] = useState<JobKind>("drug_pipeline");
  const [unbounded, setUnbounded] = useState(false);
  const [limit, setLimit] = useState<number | string>(DEFAULT_BATCH_LIMIT);
  const [idsText, setIdsText] = useState("");
  const [retryFailed, setRetryFailed] = useState(false);
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [retryStage, setRetryStage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Reset the form each time the modal opens with a new preset.
  useEffect(() => {
    if (!opened) return;
    setKind("drug_pipeline");
    setUnbounded(false);
    setLimit(DEFAULT_BATCH_LIMIT);
    setIdsText((preset.licenseIds ?? []).join("\n"));
    setRetryFailed(Boolean(preset.retryFailed));
    setIncludeCancelled(false);
    setRetryStage(null);
    setFieldError(null);
    // Reset only when the modal opens; `preset` is read at that moment.
  }, [opened]);

  const ids = useMemo(() => parseIds(idsText), [idsText]);
  const indexOnly = kind === "drug_index_import";
  const limitNum = typeof limit === "number" ? limit : Number(limit);
  const limitValid = unbounded || (Number.isFinite(limitNum) && limitNum >= 1);
  const backlog = retryFailed ? queuePending + queueFailed : queuePending;
  const expected = ids.length > 0 ? ids.length : unbounded ? backlog : Math.min(limitNum || 0, backlog);

  const submit = () => {
    if (!limitValid) {
      setFieldError("請輸入 1 以上的整數，或開啟「不設上限」");
      return;
    }
    const body: StartJobBody = { job_type: kind, module_key: DRUG_MODULE_KEY };
    if (!indexOnly) {
      const opts: Record<string, unknown> = {};
      if (!unbounded) opts.limit = Math.trunc(limitNum);
      if (ids.length > 0) opts.license_ids = ids;
      if (retryFailed) opts.retry_failed = true;
      if (includeCancelled) opts.include_cancelled = true;
      if (kind === "drug_analysis" && retryStage) opts.retry_stage = retryStage;
      body.job_options = opts;
    }
    if (preset.file) body.source_uploaded_file_id = preset.file.uploaded_file_id;

    const go = async () => {
      try {
        const res = await start.mutateAsync(body);
        const jobId = res.job.job_id;
        notify.success(
          <Text fz="sm" span>
            已建立{jobTypeLabel(kind)}工作{" "}
            <Anchor component={Link} to={`/jobs/${jobId}`} fz="sm" ff="monospace">
              {shortId(jobId)}
            </Anchor>
            ，背景工作程序會依序處理。
          </Text>,
          "工作已開始",
        );
        void qc.invalidateQueries({ queryKey: qk.drug });
        void qc.invalidateQueries({ queryKey: qk.modules });
        onClose();
      } catch (e) {
        if (e instanceof ApiError && e.status === 400) setFieldError(errorMessage(e));
        notify.error(e, "無法開始工作");
        throw e;
      }
    };

    if (!indexOnly && unbounded && ids.length === 0) {
      confirmAction({
        title: "不設上限，處理整個待處理佇列？",
        message: "這個工作會一次處理所有符合條件的許可證，期間會佔用藥品資料寫入與 LLM 資源槽，其他藥品工作需等它完成。",
        consequences: [
          <>預計處理約 {fmtNumber(backlog)} 張許可證</>,
          <>每張許可證需要多次 TFDA 請求（約 {fmtNumber(backlog * 4)} 次以上）{kind !== "drug_enrichment" ? "，以及同樣數量的 OCR 與 LLM 呼叫" : ""}</>,
          "可能持續數小時到數天；中途可暫停或停止",
        ],
        confirmLabel: "我了解，開始處理",
        danger: true,
        typeToConfirm: backlog > 1000 ? "全部處理" : undefined,
        onConfirm: go,
      });
      return;
    }
    void go().catch(() => undefined);
  };

  const kindOptions = isImport
    ? [
        { value: "drug_pipeline", label: "匯入並處理" },
        { value: "drug_index_import", label: "僅匯入索引" },
      ]
    : RUN_KINDS.map((k) => ({ value: k.value, label: k.label }));

  const kindHelp = isImport
    ? indexOnly
      ? "只把 CSV 合併進許可證索引。成功後系統會自動接續「爬取 → 分析」舊式分段工作，每批最多 200 張。"
      : "先把 CSV 合併進許可證索引，再在同一個工作內處理一批許可證（爬取 → OCR → LLM 分析）。需要已設定 OCR 與 Analysis LM。"
    : RUN_KINDS.find((k) => k.value === kind)?.help;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      fullScreen={isMobile}
      title={
        <Text fw={650} fz="lg">
          {isImport ? "匯入藥品索引 CSV" : preset.retryFailed ? "重試失敗的許可證" : "執行藥品管線"}
        </Text>
      }
    >
      <Stack gap="md">
        {preset.file && (
          <Alert variant="light" color="blue" icon={<IconInfoCircle size={18} />} p="sm">
            <Text fz="sm" style={{ wordBreak: "break-all" }}>
              來源檔案：<b>{preset.file.original_filename}</b>
            </Text>
            <Text fz="xs" c="dimmed">
              索引為累加匯入：CSV 中的許可證會新增或更新，不會刪除既有資料。
            </Text>
          </Alert>
        )}

        <Stack gap={6}>
          <Text fz="sm" fw={600}>
            工作類型
          </Text>
          <SegmentedControl
            fullWidth
            data={kindOptions}
            value={kind}
            onChange={(v) => setKind(v as JobKind)}
            orientation={isMobile && !isImport ? "vertical" : "horizontal"}
          />
          <Text fz="xs" c="dimmed">
            {kindHelp}
          </Text>
        </Stack>

        {!indexOnly && (
          <>
            <Stack gap={6}>
              <Group justify="space-between" wrap="wrap" gap="xs">
                <Text fz="sm" fw={600}>
                  本批次處理上限
                </Text>
                <Switch
                  label="不設上限"
                  checked={unbounded}
                  onChange={(e) => {
                    setUnbounded(e.currentTarget.checked);
                    setFieldError(null);
                  }}
                  color="red"
                />
              </Group>
              {!unbounded ? (
                <NumberInput
                  value={limit}
                  onChange={(v) => {
                    setLimit(v);
                    setFieldError(null);
                  }}
                  min={1}
                  max={100000}
                  step={50}
                  allowDecimal={false}
                  allowNegative={false}
                  thousandSeparator=","
                  suffix=" 張許可證"
                  error={fieldError && !limitValid ? fieldError : undefined}
                  description={`建議 ${DEFAULT_BATCH_LIMIT} 以內。每張許可證約需 4 次以上 TFDA 請求${kind !== "drug_enrichment" ? "與一次 OCR + LLM 分析" : ""}。`}
                />
              ) : (
                <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} p="sm" title="沒有上限 = 處理整個待處理佇列">
                  <Text fz="sm">
                    這會一口氣處理約 <b>{fmtNumber(backlog)}</b> 張許可證，代表數萬次 TFDA 請求
                    {kind !== "drug_enrichment" ? "與等量的 OCR／LLM 呼叫" : ""}，且在完成前會佔住藥品資源槽。除非確定需要，請保留上限。
                  </Text>
                </Alert>
              )}
            </Stack>

            <Textarea
              label="指定許可證字號（選填）"
              description="每行一個，或以逗號分隔。留空則由系統依待處理佇列自動挑選。"
              placeholder={"衛署藥製字第012345號\n衛部藥輸字第026789號"}
              autosize
              minRows={2}
              maxRows={6}
              value={idsText}
              onChange={(e) => setIdsText(e.currentTarget.value)}
              styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)", fontSize: 13 } }}
            />
            {ids.length > 0 && (
              <Text fz="xs" c="dimmed" mt={-8}>
                已辨識 {fmtNumber(ids.length)} 個許可證字號
              </Text>
            )}

            <Stack gap="xs">
              <Checkbox
                label="重試先前失敗的許可證"
                description={`把「失敗（可重試）」的許可證也納入候選${queueFailed ? `（目前 ${fmtNumber(queueFailed)} 張）` : ""}。`}
                checked={retryFailed}
                onChange={(e) => setRetryFailed(e.currentTarget.checked)}
              />
              <Checkbox
                label="包含已註銷的許可證"
                description="預設只處理有效許可證；註銷許可證通常已無 TFDA 資料可抓。"
                checked={includeCancelled}
                onChange={(e) => setIncludeCancelled(e.currentTarget.checked)}
              />
            </Stack>

            {kind === "drug_analysis" && (
              <Select
                label="只重跑特定階段（選填）"
                description="限定只重做 OCR、LLM 分析或正規化；「正規化」不需要 OCR／LLM 端點。"
                placeholder="不限定"
                clearable
                data={[
                  { value: "ocr", label: "OCR" },
                  { value: "analysis", label: "LLM 分析" },
                  { value: "normalize", label: "正規化" },
                ]}
                value={retryStage}
                onChange={setRetryStage}
              />
            )}

            <Alert color="gray" variant="light" icon={<IconInfoCircle size={18} />} p="sm">
              <List size="xs" spacing={2}>
                <List.Item>
                  預計處理：
                  <b>
                    {ids.length > 0 ? `指定的 ${fmtNumber(ids.length)} 張` : `最多 ${fmtNumber(expected)} 張`}
                  </b>
                  （目前待處理 {fmtNumber(queuePending)}、失敗 {fmtNumber(queueFailed)}）
                </List.Item>
                {kind !== "drug_analysis" && (
                  <List.Item>
                    本批成功後，若佇列仍有待處理項目，系統會<b>自動接續下一批</b>（每批 {DEFAULT_BATCH_LIMIT} 張），直到清空。要完全停止，請停止當下執行中的工作。
                  </List.Item>
                )}
                <List.Item>工作可隨時在下一個檢查點暫停或停止，已完成的許可證會保留。</List.Item>
              </List>
            </Alert>
          </>
        )}

        {fieldError && limitValid && (
          <Alert color="red" variant="light" p="sm">
            {fieldError}
          </Alert>
        )}

        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} disabled={start.isPending}>
            取消
          </Button>
          <Button onClick={submit} loading={start.isPending} color={!indexOnly && unbounded ? "red" : undefined}>
            {isImport ? "開始匯入" : "開始執行"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

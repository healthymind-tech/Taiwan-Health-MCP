import { Alert, Anchor, List, Text } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";

/** Short-option fields of the OCR group rendered as SegmentedControls. */
export const OCR_SEGMENTED: Record<string, Record<string, string>> = {
  provider: { mineru: "MinerU", indra: "Indra（CPU）" },
  fallback_provider: { none: "不使用", mineru: "MinerU", indra: "Indra" },
  indra_mode: { auto: "auto", ocr: "ocr", text: "text" },
};

/** What an operator must know before picking Indra OCR (shown under the OCR form). */
export function OcrProviderNotes() {
  return (
    <Alert color="gray" variant="light" icon={<IconInfoCircle size={18} />} title="關於 Indra OCR">
      <List size="sm" spacing={4}>
        <List.Item>
          只用 CPU 的 OCR（ocr-indra 容器，compose 內建於內部網路，不對外連線）。數位 PDF 直接讀文字層，掃描頁才做影像辨識；
          繁體中文掃描頁偶有罕用字（如 醯、噁、痙攣）誤認，複雜表格（合併儲存格、無格線的欄位表）可能錯欄。MinerU 仍是預設值。
        </List.Item>
        <List.Item>
          程式碼為 Apache-2.0，但<Text span fw={600}>模型權重採修改版 OpenRAIL-M 授權</Text>：前一年營收或累計募資超過 2,000 萬美元的單位（研究與個人用途除外），
          或提供與 Datalab 競爭之產品者，不得使用；授權也延伸到 OCR 輸出，對外提供服務時須轉達使用限制並標示出處。啟用前請確認是否符合，或向
          Datalab 取得商用授權。
          <Anchor href="https://huggingface.co/datalab-to/indra-ocr/blob/main/LICENSE" target="_blank" rel="noreferrer" ml={4} fz="sm">
            授權全文
          </Anchor>
        </List.Item>
        <List.Item>改供應者後請按「測試連線」：Indra 會順便辨識一次內建範例 PDF，確認真的能回傳 Markdown。</List.Item>
      </List>
    </Alert>
  );
}

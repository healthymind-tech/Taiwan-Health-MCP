import { Stack } from "@mantine/core";
import { IconDatabaseExport } from "@tabler/icons-react";
import { PageHeader } from "@/components/PageHeader";
import { BackupsSection } from "./BackupsSection";
import { SettingsTransferSection } from "./SettingsTransferSection";

export default function SystemPage() {
  return (
    <>
      <PageHeader
        title="備份與設定"
        description="建立完整的系統備份，或把設定匯出到另一套部署。兩者產生的檔案都含有機密資料，請依院內規範保管。"
        icon={<IconDatabaseExport size={24} />}
        breadcrumbs={[{ label: "設定" }, { label: "備份與設定" }]}
      />
      <Stack gap="lg">
        <BackupsSection />
        <SettingsTransferSection />
      </Stack>
    </>
  );
}

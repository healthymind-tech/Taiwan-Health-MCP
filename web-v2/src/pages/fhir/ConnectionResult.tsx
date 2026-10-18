import { Alert, Box, Button, Collapse, Stack, Text } from "@mantine/core";
import { IconCircleCheck, IconCircleX } from "@tabler/icons-react";
import { useState } from "react";
import { JsonView } from "@/components/JsonView";
import type { ConnectionTestResult } from "./fhirModel";
import { WorkflowSteps } from "./FhirBadges";

/** Overall verdict + per-step workflow + raw failure payload. */
export function ConnectionResult({ result }: { result: ConnectionTestResult }) {
  const [showRaw, setShowRaw] = useState(false);
  const steps = result.probe?.details?.steps ?? [];
  const cap = result.capability_summary ?? {};
  const resCount = cap.supported_resources?.length ?? 0;
  return (
    <Stack gap="md">
      <Alert
        color={result.ok ? "teal" : "red"}
        icon={result.ok ? <IconCircleCheck size={20} /> : <IconCircleX size={20} />}
        title={result.ok ? "連線成功" : "連線失敗"}
      >
        <Text fz="sm" style={{ wordBreak: "break-word" }}>
          {result.ok ? "完整連線流程皆通過。" : (result.probe?.message_zh ?? result.probe?.message)}
          {typeof result.probe?.latency_ms === "number" && (
            <Text span c="dimmed" fz="xs">
              {" "}
              · 共 {result.probe.latency_ms} ms
            </Text>
          )}
        </Text>
        {!result.ok && result.probe?.hint_zh && (
          <Text fz="sm" mt={4}>
            {result.probe.hint_zh}
          </Text>
        )}
        {!result.ok && result.probe?.message_zh && result.probe.message && (
          <Text fz="xs" c="dimmed" mt={4} ff="monospace" style={{ wordBreak: "break-word" }}>
            技術細節：{result.probe.message}
          </Text>
        )}
        {result.ok && cap.fhirVersion && (
          <Text fz="xs" c="dimmed" mt={4}>
            FHIR {cap.fhirVersion} · {resCount} 種資源類型
          </Text>
        )}
      </Alert>
      <WorkflowSteps steps={steps} />
      {!result.ok && result.raw_result && (
        <Box>
          <Button variant="subtle" size="xs" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "隱藏原始回應" : "顯示原始回應"}
          </Button>
          <Collapse in={showRaw}>
            <Box mt="xs">
              <JsonView value={result.raw_result} maxHeight={320} />
            </Box>
          </Collapse>
        </Box>
      )}
    </Stack>
  );
}

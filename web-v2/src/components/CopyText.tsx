import { ActionIcon, CopyButton, Group, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";

/** Text with a copy button. `mono` for ids/hashes/URLs. */
export function CopyText({ value, display, mono, truncate }: { value: string; display?: string; mono?: boolean; truncate?: boolean }) {
  if (!value) return <Text c="dimmed">—</Text>;
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
      <Tooltip label={value} disabled={!truncate} multiline maw={420} style={{ wordBreak: "break-all" }}>
      <Text
        fz="sm"
        ff={mono ? "monospace" : undefined}
        truncate={truncate ? "end" : undefined}
        style={{ minWidth: 0, wordBreak: truncate ? undefined : "break-all" }}
      >
        {display ?? value}
      </Text>
      </Tooltip>
      <CopyButton value={value} timeout={1500}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "已複製" : "複製"}>
            <ActionIcon size="sm" color={copied ? "teal" : "gray"} onClick={copy} aria-label="複製">
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

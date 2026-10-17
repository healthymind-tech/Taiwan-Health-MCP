import { Text, Tooltip } from "@mantine/core";
import type { TextProps } from "@mantine/core";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";

/** "3 分鐘前" with the absolute timestamp on hover; re-renders every 30 s. */
export function RelativeTime({ value, ...rest }: { value: string | null | undefined } & TextProps) {
  useNow(30_000);
  if (!value) return <Text span c="dimmed" {...rest}>—</Text>;
  return (
    <Tooltip label={fmtDateTime(value, true)}>
      <Text span {...rest} style={{ whiteSpace: "nowrap" }}>
        {fmtRelative(value)}
      </Text>
    </Tooltip>
  );
}

import { Box, SimpleGrid, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

export interface KV {
  label: ReactNode;
  value: ReactNode;
  /** Span the whole row. */
  full?: boolean;
  hidden?: boolean;
}

/** Label/value grid that collapses to one column on phones. */
export function KeyValue({ items, cols = 2 }: { items: KV[]; cols?: number }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: cols }} spacing="lg" verticalSpacing="md">
      {items
        .filter((i) => !i.hidden)
        .map((i, idx) => (
          <Box key={idx} style={i.full ? { gridColumn: "1 / -1" } : undefined}>
            <Stack gap={2}>
              <Text fz="xs" c="dimmed" fw={600}>
                {i.label}
              </Text>
              <Box fz="sm" style={{ wordBreak: "break-word" }}>
                {i.value === null || i.value === undefined || i.value === "" ? <Text c="dimmed">—</Text> : i.value}
              </Box>
            </Stack>
          </Box>
        ))}
    </SimpleGrid>
  );
}

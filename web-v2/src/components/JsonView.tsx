import { Box, Code, ScrollArea } from "@mantine/core";

/** Pretty-printed JSON in a scrollable code block. */
export function JsonView({ value, maxHeight = 420 }: { value: unknown; maxHeight?: number }) {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <Box style={{ borderRadius: "var(--mantine-radius-md)", overflow: "hidden" }}>
      <ScrollArea.Autosize mah={maxHeight} type="auto">
        <Code block fz="xs" style={{ whiteSpace: "pre", minWidth: "100%" }}>
          {text}
        </Code>
      </ScrollArea.Autosize>
    </Box>
  );
}

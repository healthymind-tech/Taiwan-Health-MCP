// Readable renderer for arbitrary nested insert-analysis JSON: objects become
// titled sections, string lists become bullets, uniform object lists become
// tables. Empty branches are hidden.

import { Badge, Box, Group, List, Stack, Table, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";
import { asText, isDict, isEmptyValue, type Dict } from "./drugTypes";
import classes from "./drug.module.css";

function Scalar({ value }: { value: unknown }) {
  if (typeof value === "boolean") return <Badge size="sm" variant="light" color={value ? "teal" : "gray"}>{value ? "是" : "否"}</Badge>;
  return (
    <Text fz="sm" className={classes.prewrap}>
      {asText(value)}
    </Text>
  );
}

function isScalar(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/** Columns shared by a list of flat objects, or null when not table-like. */
function tableColumns(items: unknown[]): string[] | null {
  if (items.length === 0 || !items.every(isDict)) return null;
  const cols: string[] = [];
  for (const it of items as Dict[]) {
    for (const [k, v] of Object.entries(it)) {
      if (!isScalar(v)) return null;
      if (!cols.includes(k)) cols.push(k);
    }
  }
  return cols.length > 0 && cols.length <= 8 ? cols : null;
}

function ArrayView({ items, depth }: { items: unknown[]; depth: number }) {
  const visible = items.filter((x) => !isEmptyValue(x));
  if (visible.length === 0) return null;
  if (visible.every(isScalar)) {
    if (visible.length === 1) return <Scalar value={visible[0]} />;
    return (
      <List size="sm" spacing={4} withPadding>
        {visible.map((x, i) => (
          <List.Item key={i}>
            <Text fz="sm" className={classes.prewrap} span>
              {asText(x)}
            </Text>
          </List.Item>
        ))}
      </List>
    );
  }
  const cols = tableColumns(visible);
  if (cols) {
    return (
      <Box style={{ overflowX: "auto" }}>
        <Table withTableBorder withColumnBorders fz="sm" striped miw={Math.min(cols.length * 140, 720)}>
          <Table.Thead>
            <Table.Tr>
              {cols.map((c) => (
                <Table.Th key={c} style={{ whiteSpace: "nowrap" }}>
                  {c}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(visible as Dict[]).map((row, i) => (
              <Table.Tr key={i}>
                {cols.map((c) => (
                  <Table.Td key={c} className={classes.prewrap}>
                    {asText(row[c])}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    );
  }
  return (
    <Stack gap="sm">
      {visible.map((x, i) => (
        <Box key={i} p="sm" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}>
          <ValueView value={x} depth={depth + 1} />
        </Box>
      ))}
    </Stack>
  );
}

function DictView({ value, depth }: { value: Dict; depth: number }) {
  const entries = Object.entries(value).filter(([, v]) => !isEmptyValue(v));
  if (entries.length === 0) return null;
  return (
    <Stack gap={depth === 0 ? "lg" : "sm"}>
      {entries.map(([k, v]) => (
        <Section key={k} title={k} depth={depth}>
          <ValueView value={v} depth={depth + 1} />
        </Section>
      ))}
    </Stack>
  );
}

function Section({ title, depth, children }: { title: string; depth: number; children: ReactNode }) {
  if (depth === 0) {
    return (
      <Box>
        <Title order={4} mb={8}>
          {title}
        </Title>
        {children}
      </Box>
    );
  }
  return (
    <Box className={classes.nested}>
      <Text fz="sm" fw={650} mb={4} c={depth > 2 ? "dimmed" : undefined}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

export function ValueView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (isEmptyValue(value)) return null;
  if (Array.isArray(value)) return <ArrayView items={value} depth={depth} />;
  if (isDict(value)) return <DictView value={value} depth={depth} />;
  return <Scalar value={value} />;
}

/** Labeled bullet list used across the overview; hides itself when empty. */
export function BulletBlock({ title, items, color }: { title: string; items: string[]; color?: string }) {
  if (items.length === 0) return null;
  return (
    <Box>
      <Group gap={6} mb={4}>
        <Text fz="sm" fw={650} c={color}>
          {title}
        </Text>
        <Text fz="xs" c="dimmed">
          {items.length}
        </Text>
      </Group>
      {items.length === 1 ? (
        <Text fz="sm" className={classes.prewrap}>
          {items[0]}
        </Text>
      ) : (
        <List size="sm" spacing={4} withPadding>
          {items.map((x, i) => (
            <List.Item key={i}>
              <Text fz="sm" span className={classes.prewrap}>
                {x}
              </Text>
            </List.Item>
          ))}
        </List>
      )}
    </Box>
  );
}

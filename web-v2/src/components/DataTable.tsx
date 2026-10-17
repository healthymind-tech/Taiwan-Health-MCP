import { Box, Card, Center, Group, Loader, Pagination, Stack, Table, Text, UnstyledButton } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconSelector } from "@tabler/icons-react";
import { useMemo, useState, type ReactNode } from "react";
import { useIsMobile } from "@/lib/hooks";
import { EmptyState } from "./EmptyState";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Value used for client-side sorting; omit to make the column unsortable. */
  sortValue?: (row: T) => string | number | null | undefined;
  width?: number | string;
  align?: "left" | "right" | "center";
  /** Hide in the phone card layout (secondary info). */
  hideOnMobile?: boolean;
  /** Use as the card title in the phone layout. */
  primary?: boolean;
  nowrap?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Highlight a row (selected item). */
  activeKey?: string | null;
  loading?: boolean;
  empty?: ReactNode;
  /** Client-side pagination page size (0 = off). */
  pageSize?: number;
  minWidth?: number;
  /** Force card layout regardless of width. */
  cards?: boolean;
  initialSort?: { key: string; dir: "asc" | "desc" };
}

/**
 * Responsive table: a real table on tablet/desktop (horizontal scroll inside its
 * own container, never the page), and stacked cards on phones.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  activeKey,
  loading,
  empty,
  pageSize = 0,
  minWidth = 720,
  cards,
  initialSort,
}: DataTableProps<T>) {
  const isMobile = useIsMobile();
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(initialSort ?? null);
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const r = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "zh-Hant");
      return sort.dir === "asc" ? r : -r;
    });
  }, [rows, sort, columns]);

  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const safePage = Math.min(page, totalPages);
  const visible = pageSize > 0 ? sorted.slice((safePage - 1) * pageSize, safePage * pageSize) : sorted;

  if (loading && rows.length === 0) {
    return (
      <Center py="xl">
        <Loader size="sm" />
      </Center>
    );
  }
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState compact title="沒有資料" />}</>;
  }

  const pager =
    pageSize > 0 && totalPages > 1 ? (
      <Group justify="space-between" px="md" py="sm" wrap="wrap" gap="xs">
        <Text fz="xs" c="dimmed">
          共 {sorted.length} 筆，第 {safePage} / {totalPages} 頁
        </Text>
        <Pagination size="sm" total={totalPages} value={safePage} onChange={setPage} />
      </Group>
    ) : null;

  if (cards || isMobile) {
    const primary = columns.find((c) => c.primary) ?? columns[0];
    const rest = columns.filter((c) => c !== primary && !c.hideOnMobile);
    return (
      <Stack gap="xs" p="xs">
        {visible.map((row) => {
          const key = rowKey(row);
          return (
            <Card
              key={key}
              padding="sm"
              shadow="none"
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={{
                cursor: onRowClick ? "pointer" : undefined,
                borderColor: activeKey === key ? "var(--mantine-primary-color-filled)" : undefined,
              }}
            >
              <Box fw={600} mb={6}>
                {primary.render(row)}
              </Box>
              <Stack gap={4}>
                {rest.map((c) => (
                  <Group key={c.key} justify="space-between" gap="sm" wrap="nowrap" align="flex-start">
                    <Text fz="xs" c="dimmed" style={{ flexShrink: 0 }}>
                      {c.header}
                    </Text>
                    <Box fz="sm" ta="right" style={{ minWidth: 0 }}>
                      {c.render(row)}
                    </Box>
                  </Group>
                ))}
              </Stack>
            </Card>
          );
        })}
        {pager}
      </Stack>
    );
  }

  return (
    <Box>
      <Table.ScrollContainer minWidth={minWidth} type="native">
        <Table stickyHeader verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const sortable = Boolean(c.sortValue);
                return (
                  <Table.Th key={c.key} style={{ width: c.width, textAlign: c.align, whiteSpace: "nowrap" }}>
                    {sortable ? (
                      <UnstyledButton
                        onClick={() =>
                          setSort((s) =>
                            s?.key === c.key ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: "asc" },
                          )
                        }
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600, fontSize: "inherit" }}
                      >
                        {c.header}
                        {active ? (
                          sort?.dir === "asc" ? (
                            <IconArrowUp size={13} />
                          ) : (
                            <IconArrowDown size={13} />
                          )
                        ) : (
                          <IconSelector size={13} opacity={0.4} />
                        )}
                      </UnstyledButton>
                    ) : (
                      c.header
                    )}
                  </Table.Th>
                );
              })}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visible.map((row) => {
              const key = rowKey(row);
              return (
                <Table.Tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={{ cursor: onRowClick ? "pointer" : undefined }}
                  bg={activeKey === key ? "var(--mantine-primary-color-light)" : undefined}
                >
                  {columns.map((c) => (
                    <Table.Td key={c.key} style={{ textAlign: c.align, whiteSpace: c.nowrap ? "nowrap" : undefined }}>
                      {c.render(row)}
                    </Table.Td>
                  ))}
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {pager}
    </Box>
  );
}

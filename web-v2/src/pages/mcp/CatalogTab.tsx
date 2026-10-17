import {
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  CloseButton,
  Collapse,
  Group,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconAlertTriangle, IconChevronDown, IconChevronUp, IconFilterOff, IconLock, IconPencil, IconPlayerPlay, IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { QueryBoundary } from "@/components/QueryBoundary";
import { useDebounced } from "@/lib/hooks";
import { fmtNumber } from "@/lib/format";
import { useMcpCatalog } from "./mcpApi";
import { gateModulePage, groupMeta, toolStatusView } from "./mcpMeta";
import classes from "./mcp.module.css";
import type { CatalogGroup, CatalogPayload, CatalogTool } from "./mcpTypes";
import { formModel, typeLabel } from "./schema";

export type StatusFilter = "all" | "enabled" | "disabled";

export interface CatalogFilters {
  q: string;
  group: string | null;
  status: StatusFilter;
}

function matches(t: CatalogTool, f: CatalogFilters, terms: string[]): boolean {
  if (f.group && t.group !== f.group) return false;
  if (f.status === "enabled" && !t.enabled) return false;
  if (f.status === "disabled" && t.enabled) return false;
  if (terms.length === 0) return true;
  const hay = `${t.name} ${t.title} ${t.description} ${groupMeta(t.group).label} ${Object.keys(t.input_schema.properties ?? {}).join(" ")}`.toLowerCase();
  return terms.every((x) => hay.includes(x));
}

function GroupTile({ g, active, onClick }: { g: CatalogGroup; active: boolean; onClick: () => void }) {
  const meta = groupMeta(g.key);
  const Icon = meta.icon;
  const pct = g.total ? (g.enabled / g.total) * 100 : 0;
  return (
    <Card
      padding="sm"
      className={classes.groupCard}
      data-active={active || undefined}
      style={{ ["--group-color" as string]: `var(--mantine-color-${meta.color}-filled)` }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`${meta.label}：${g.enabled} / ${g.total} 啟用`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <Group gap="xs" wrap="nowrap">
        <ThemeIcon variant="light" color={meta.color} size={30} radius="md">
          <Icon size={17} />
        </ThemeIcon>
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Text fz="sm" fw={650} truncate="end">
            {meta.label}
          </Text>
          <Text fz="xs" c="dimmed" className="tabular">
            {g.enabled} / {g.total} 啟用
            {g.always_on ? " · 常駐" : g.disabled > 0 ? ` · ${g.disabled} 停用` : ""}
          </Text>
        </Box>
      </Group>
      <Progress value={pct} size={4} radius="xl" mt="xs" color={g.disabled > 0 ? "amber" : meta.color} />
    </Card>
  );
}

function ParamChips({ t }: { t: CatalogTool }) {
  const fields = useMemo(() => formModel(t.input_schema), [t.input_schema]);
  if (fields.length === 0)
    return (
      <Text fz="xs" c="dimmed">
        無參數
      </Text>
    );
  return (
    <Group gap={4}>
      {fields.slice(0, 8).map((f) => (
        <Tooltip key={f.name} label={`${typeLabel(f)}${f.required ? "（必填）" : "（選填）"}${f.description ? ` — ${f.description}` : ""}`}>
          <Badge size="sm" variant={f.required ? "light" : "outline"} color={f.required ? "brand" : "gray"} tt="none" ff="monospace" fw={500}>
            {f.name}
            {f.required ? " *" : ""}
          </Badge>
        </Tooltip>
      ))}
      {fields.length > 8 && (
        <Badge size="sm" variant="outline" color="gray" tt="none">
          +{fields.length - 8}
        </Badge>
      )}
    </Group>
  );
}

function ParamTable({ t }: { t: CatalogTool }) {
  const fields = formModel(t.input_schema);
  if (fields.length === 0) return null;
  return (
    <Box style={{ overflowX: "auto" }}>
      <Table fz="xs" verticalSpacing={4} horizontalSpacing="xs" miw={420}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>參數</Table.Th>
            <Table.Th>型別</Table.Th>
            <Table.Th>預設</Table.Th>
            <Table.Th>說明</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {fields.map((f) => (
            <Table.Tr key={f.name}>
              <Table.Td ff="monospace" style={{ whiteSpace: "nowrap" }}>
                {f.name}
                {f.required && (
                  <Text span c="red" fw={700}>
                    {" "}
                    *
                  </Text>
                )}
              </Table.Td>
              <Table.Td ff="monospace" style={{ whiteSpace: "nowrap" }}>
                {typeLabel(f)}
                {f.nullable ? " | null" : ""}
              </Table.Td>
              <Table.Td ff="monospace">{f.hasDefault ? JSON.stringify(f.default) : "—"}</Table.Td>
              <Table.Td c="dimmed">{f.description ?? ""}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

function ToolCard({ t, onTry, highlight }: { t: CatalogTool; onTry: (name: string) => void; highlight: string[] }) {
  const [open, setOpen] = useState(false);
  const meta = groupMeta(t.group);
  const status = toolStatusView(t);
  const modulePage = !t.enabled ? gateModulePage(t.gate) : null;
  const mark = (s: string) => {
    if (highlight.length === 0) return s;
    const re = new RegExp(`(${highlight.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
    return s.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
  };
  return (
    <Card padding="md" className={classes.toolCard} data-disabled={!t.enabled || undefined} style={{ ["--group-color" as string]: `var(--mantine-color-${meta.color}-filled)` }}>
      <Stack gap={8} h="100%">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <Box style={{ minWidth: 0 }}>
            <Text fw={650} fz="sm" lh={1.35}>
              {mark(t.title)}
            </Text>
            <Text fz="xs" ff="monospace" c="dimmed" style={{ wordBreak: "break-all" }}>
              {mark(t.name)}
            </Text>
          </Box>
          <Tooltip label={status.explain} maw={300}>
            <Badge color={status.color} size="sm" style={{ flexShrink: 0 }} variant={t.enabled ? "light" : "outline"}>
              {status.label}
            </Badge>
          </Tooltip>
        </Group>
        <Text fz="xs" c="dimmed" lineClamp={open ? undefined : 2}>
          {mark(t.summary)}
        </Text>
        <Group gap={4}>
          <Badge size="xs" variant="outline" color="gray" ff="monospace" tt="none">
            v{t.version}
          </Badge>
          {t.write_capable ? (
            <Tooltip label="可對外部 FHIR 伺服器寫入（需 confirm_write=true 且伺服器允許）">
              <Badge size="xs" color="red" leftSection={<IconPencil size={10} />}>
                可寫入
              </Badge>
            </Tooltip>
          ) : (
            <Badge size="xs" color="gray" leftSection={<IconLock size={10} />}>
              唯讀
            </Badge>
          )}
          {t.examples.length > 0 && (
            <Badge size="xs" color="brand" variant="light">
              {t.examples.length} 個範例
            </Badge>
          )}
        </Group>
        <ParamChips t={t} />
        {!t.enabled && (
          <Group gap={6} wrap="nowrap" align="flex-start">
            <IconAlertTriangle size={14} color="var(--mantine-color-amber-6)" style={{ flexShrink: 0, marginTop: 2 }} />
            <Text fz="xs" c="dimmed">
              {status.explain}{" "}
              {modulePage && (
                <Anchor component={Link} to={modulePage} fz="xs">
                  前往匯入
                </Anchor>
              )}
            </Text>
          </Group>
        )}
        <Collapse in={open}>
          <Stack gap="xs" pt={4}>
            <Text fz="xs" style={{ whiteSpace: "pre-wrap" }}>
              {t.description}
            </Text>
            <ParamTable t={t} />
          </Stack>
        </Collapse>
        <Group gap="xs" mt="auto" pt={4}>
          <Button size="xs" leftSection={<IconPlayerPlay size={14} />} onClick={() => onTry(t.name)} variant={t.enabled ? "filled" : "default"}>
            {t.enabled ? "測試" : "查看"}
          </Button>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            rightSection={open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
            onClick={() => setOpen((x) => !x)}
            aria-expanded={open}
          >
            {open ? "收合" : "詳細"}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function CatalogView({
  data,
  filters,
  setFilters,
  onTry,
}: {
  data: CatalogPayload;
  filters: CatalogFilters;
  setFilters: (f: Partial<CatalogFilters>) => void;
  onTry: (name: string) => void;
}) {
  const [qInput, setQInput] = useState(filters.q);
  const q = useDebounced(qInput, 200);
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const effective = { ...filters, q };
  const visible = data.tools.filter((t) => matches(t, effective, terms));
  const groups = data.groups.filter((g) => visible.some((t) => t.group === g.key));
  const active = Boolean(q || filters.group || filters.status !== "all");
  const clear = () => {
    setQInput("");
    setFilters({ q: "", group: null, status: "all" });
  };
  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 2, xs: 3, md: 4, lg: 6 }} spacing="sm">
        {data.groups.map((g) => (
          <GroupTile key={g.key} g={g} active={filters.group === g.key} onClick={() => setFilters({ group: filters.group === g.key ? null : g.key })} />
        ))}
      </SimpleGrid>

      <Card padding="sm">
        <Group gap="sm" wrap="wrap">
          <TextInput
            placeholder="搜尋工具名稱、說明、參數…"
            leftSection={<IconSearch size={16} />}
            value={qInput}
            onChange={(e) => {
              setQInput(e.currentTarget.value);
            }}
            onBlur={() => setFilters({ q: qInput })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQInput("");
                setFilters({ q: "" });
              }
            }}
            rightSection={qInput ? <CloseButton size="sm" aria-label="清除搜尋" onClick={() => { setQInput(""); setFilters({ q: "" }); }} /> : null}
            style={{ flex: "1 1 260px" }}
            aria-label="搜尋工具"
          />
          <Select
            placeholder="所有分組"
            data={data.groups.map((g) => ({ value: g.key, label: `${groupMeta(g.key).label}（${g.total}）` }))}
            value={filters.group}
            onChange={(v) => setFilters({ group: v })}
            clearable
            allowDeselect
            w={{ base: "100%", xs: 200 }}
            aria-label="分組"
          />
          <SegmentedControl
            value={filters.status}
            onChange={(v) => setFilters({ status: v as StatusFilter })}
            data={[
              { value: "all", label: `全部 ${data.totals.total}` },
              { value: "enabled", label: `啟用 ${data.totals.enabled}` },
              { value: "disabled", label: `未啟用 ${data.totals.disabled}` },
            ]}
            size="sm"
          />
          {active && (
            <Button variant="subtle" color="gray" size="sm" leftSection={<IconFilterOff size={16} />} onClick={clear}>
              清除
            </Button>
          )}
        </Group>
        <Text fz="xs" c="dimmed" mt="xs" className="tabular">
          顯示 {fmtNumber(visible.length)} / {fmtNumber(data.totals.total)} 個工具
        </Text>
      </Card>

      {visible.length === 0 ? (
        <EmptyState
          icon={<IconSearch size={26} />}
          title="沒有符合的工具"
          description="換個關鍵字，或清除篩選條件。"
          action={
            <Button variant="light" onClick={clear}>
              清除篩選
            </Button>
          }
        />
      ) : (
        groups.map((g) => {
          const meta = groupMeta(g.key);
          const Icon = meta.icon;
          const tools = visible.filter((t) => t.group === g.key);
          return (
            <Stack key={g.key} gap="sm">
              <Group gap="sm" wrap="nowrap">
                <ThemeIcon variant="light" color={meta.color} size={28} radius="md">
                  <Icon size={16} />
                </ThemeIcon>
                <Box style={{ minWidth: 0 }}>
                  <Group gap={8}>
                    <Title order={3}>{meta.label}</Title>
                    <Badge size="sm" variant="light" color={g.disabled ? "amber" : "teal"} className="tabular">
                      {g.enabled}/{g.total}
                    </Badge>
                  </Group>
                  <Text fz="xs" c="dimmed">
                    {meta.description}
                  </Text>
                </Box>
              </Group>
              <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="sm">
                {tools.map((t) => (
                  <ToolCard key={t.name} t={t} onTry={onTry} highlight={terms} />
                ))}
              </SimpleGrid>
            </Stack>
          );
        })
      )}
    </Stack>
  );
}

export function CatalogTab(props: { filters: CatalogFilters; setFilters: (f: Partial<CatalogFilters>) => void; onTry: (name: string) => void }) {
  const q = useMcpCatalog();
  return <QueryBoundary query={q}>{(data) => <CatalogView data={data} {...props} />}</QueryBoundary>;
}

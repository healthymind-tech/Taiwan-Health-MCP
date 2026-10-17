import { Badge, Box, Button, Group, Pagination, ScrollArea, Select, Skeleton, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconArrowsShuffle, IconCircleCheck, IconCircleX, IconFilterOff } from "@tabler/icons-react";
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import { CopyText } from "@/components/CopyText";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { fmtNumber } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { Hl, Panel, SearchBox } from "./parts";
import { termGet, tk, type PcsCodeInfo, type PcsCodeRow, type PcsLabel, type PcsSection, type PcsTable } from "./termApi";
import classes from "./explorer.module.css";

/** One colour per PCS axis (character position). */
export const AXIS_COLORS = [
  "var(--mantine-color-brand-6)",
  "var(--mantine-color-indigo-6)",
  "var(--mantine-color-violet-6)",
  "var(--mantine-color-pink-6)",
  "var(--mantine-color-orange-6)",
  "var(--mantine-color-teal-6)",
  "var(--mantine-color-cyan-7)",
];
const AXIS_ZH = ["章節", "身體系統", "術式", "身體部位", "途徑", "裝置", "限定詞"];

type Axes = [string, string, string, string];
const NO_AXES: Axes = ["", "", "", ""];

/** The 7 characters of a PCS code as coloured axis cells. */
export function AxisCode({ chars, titles, labels, bad }: { chars: string[]; titles: string[]; labels: (string | null)[]; bad?: boolean }) {
  return (
    <div className={classes.axisCode}>
      {Array.from({ length: 7 }, (_, i) => (
        <div
          key={`${i}-${chars[i] ?? ""}`}
          className={classes.axisCell}
          style={{ "--ax": AXIS_COLORS[i], animationDelay: `${i * 45}ms` } as CSSProperties}
          data-empty={!chars[i] || undefined}
          data-bad={(bad && i >= 3 && Boolean(chars[i])) || undefined}
        >
          <div className={classes.axisTitle}>
            {i + 1} · {AXIS_ZH[i]}
          </div>
          <div className={classes.axisChar}>{chars[i] || "·"}</div>
          <Text className={classes.axisLabel} c={labels[i] ? undefined : "dimmed"}>
            {labels[i] ?? titles[i] ?? ""}
          </Text>
        </div>
      ))}
    </div>
  );
}

export function PcsExplorer() {
  const isMobile = useIsMobile();
  const [sp, setSp] = useSearchParams();
  const code = (sp.get("code") ?? "").toUpperCase();
  const tableKey = (sp.get("table") ?? (code.length >= 3 ? code.slice(0, 3) : "")).toUpperCase();
  const [axes, setAxes] = useState<Axes>(NO_AXES);
  const [page, setPage] = useState(1);

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSp(next, { replace: true });
  };

  const browse = useQuery({ queryKey: tk("pcs-browse"), queryFn: () => termGet<{ source: string; sections: PcsSection[] }>("icd/pcs/browse"), staleTime: 10 * 60_000 });
  const table = useQuery({
    queryKey: tk("pcs-table", tableKey),
    queryFn: () => termGet<PcsTable>("icd/pcs/table", { key: tableKey }),
    enabled: tableKey.length === 3,
    staleTime: 10 * 60_000,
  });
  const info = useQuery({
    queryKey: tk("pcs-code", code),
    queryFn: () => termGet<PcsCodeInfo>("icd/pcs/code", { code }),
    enabled: code.length === 7,
    staleTime: 10 * 60_000,
  });

  // A selected code pins the axis values; a table switch clears them.
  useEffect(() => {
    if (code.length === 7) setAxes([code[3], code[4], code[5], code[6]]);
  }, [code]);
  useEffect(() => {
    if (code.length !== 7) setAxes(NO_AXES);
    setPage(1);
  }, [tableKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const codes = useQuery({
    queryKey: tk("pcs-codes", tableKey, axes.join(""), page),
    queryFn: () =>
      termGet<{ total: number; rows: PcsCodeRow[]; pattern: string }>("icd/pcs/codes", { key: tableKey, a4: axes[0], a5: axes[1], a6: axes[2], a7: axes[3], page, per_page: 12 }),
    enabled: tableKey.length === 3,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const toggleAxis = (i: number, v: string) => {
    const next = [...axes] as Axes;
    next[i] = next[i] === v ? "" : v;
    setAxes(next);
    setPage(1);
    const full = next.every(Boolean) ? tableKey + next.join("") : "";
    set({ code: full || null, table: tableKey });
  };

  const t = table.data;
  const chars = code.length === 7 ? code.split("") : [...tableKey.split(""), ...axes];
  const labels: (string | null)[] =
    code.length === 7 && info.data
      ? info.data.axes.map((a) => a.label)
      : [t?.section.label ?? null, t?.body_system.label ?? null, t?.operation.label ?? null, ...axes.map((v, i) => (v ? labelOf(t, i, v) : null))];

  const nav = browse.isPending ? (
    <Skeleton h={420} />
  ) : browse.isError ? (
    <ErrorState error={browse.error} onRetry={() => void browse.refetch()} />
  ) : (
    <PcsNavigator sections={browse.data.sections} current={tableKey} onPick={(k) => set({ table: k, code: null })} mobile={isMobile} />
  );

  return (
    <Stack gap="sm">
      <SearchBox<PcsCodeRow>
        id="pcs"
        placeholder="搜尋 ICD-10-PCS：0DTJ4ZZ、0DT、闌尾、appendectomy…"
        search={(q) => termGet<{ items: PcsCodeRow[] }>("icd/pcs/search", { q }).then((r) => r.items)}
        hitKey={(h) => h.code}
        onPick={(h) => set({ code: h.code, table: h.code.slice(0, 3) })}
        renderHit={(h, q) => (
          <Box>
            <Text span className={classes.code}>
              {h.code}
            </Text>
            <Text fz="sm" lineClamp={1}>
              <Hl text={h.name_zh || h.name_en} q={q} />
            </Text>
            {h.name_zh && (
              <Text fz="xs" c="dimmed" lineClamp={1}>
                <Hl text={h.name_en} q={q} />
              </Text>
            )}
          </Box>
        )}
      />
      <div className={classes.shell} style={{ gridTemplateColumns: isMobile ? undefined : "minmax(240px, 0.55fr) minmax(0, 1.45fr)" }}>
        <Panel title="章節 → 身體系統 → 術式表">{nav}</Panel>
        <Stack gap="sm" style={{ minWidth: 0 }}>
          <Panel
            title={code.length === 7 ? "代碼七軸拆解" : tableKey ? "組合代碼（點選下方表格的各軸值）" : "ICD-10-PCS 七軸結構"}
            right={
              axes.some(Boolean) || code ? (
                <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconFilterOff size={12} />} onClick={() => (setAxes(NO_AXES), set({ code: null }))}>
                  清除
                </Button>
              ) : null
            }
          >
            <Box p="md">
              <AxisCode chars={chars} titles={t?.titles ?? AXIS_ZH} labels={labels} bad={info.data ? !info.data.valid : false} />
              {code.length === 7 && info.data && (
                <Box mt="md" className={classes.detailCard} p={0} key={code}>
                  <Group gap={8} wrap="wrap">
                    <Text className={classes.bigCode} fz={22}>
                      {code}
                    </Text>
                    <CopyText value={code} mono />
                    {info.data.in_db ? (
                      <Badge color="teal" variant="light" leftSection={<IconCircleCheck size={12} />}>
                        資料庫中有此代碼
                      </Badge>
                    ) : (
                      <Badge color="gray" variant="light" leftSection={<IconCircleX size={12} />}>
                        資料庫中無此代碼
                      </Badge>
                    )}
                    {!info.data.valid && (
                      <Badge color="orange" variant="light">
                        表格中沒有這個組合
                      </Badge>
                    )}
                  </Group>
                  {info.data.name_zh && (
                    <Text fz="lg" fw={600} mt={6}>
                      {info.data.name_zh}
                    </Text>
                  )}
                  {info.data.name_en && (
                    <Text fz="sm" c="dimmed">
                      {info.data.name_en}
                    </Text>
                  )}
                </Box>
              )}
              {!tableKey && (
                <Text fz="sm" c="dimmed" mt="md">
                  每個 ICD-10-PCS 代碼都是 7 個字元，每一位代表一個軸。前 3 碼（章節、身體系統、術式）決定一張「表」，後 4 碼從該表同一列中組合。從左側選一張表，或直接搜尋代碼。
                </Text>
              )}
            </Box>
          </Panel>
          {tableKey && (
            <PcsTableView table={table} axes={axes} onToggle={toggleAxis} />
          )}
          {tableKey && (
            <Panel title={`符合的代碼${codes.data ? `（${fmtNumber(codes.data.total)}）` : ""}`} right={<Text fz={11} ff="monospace" c="dimmed">{codes.data?.pattern}</Text>}>
              {codes.isError ? (
                <ErrorState error={codes.error} />
              ) : codes.isPending ? (
                <Skeleton h={120} m="md" />
              ) : codes.data.rows.length === 0 ? (
                <EmptyState compact icon={<IconArrowsShuffle size={20} />} title="資料庫中沒有符合的代碼" description="此組合在表格中可能有效，但未收錄於目前匯入的版本。" />
              ) : (
                <Box style={{ opacity: codes.isPlaceholderData ? 0.6 : 1, transition: "opacity 120ms" }}>
                  {codes.data.rows.map((r) => (
                    <UnstyledButton key={r.code} className={classes.drillItem} style={{ width: "100%" }} data-selected={r.code === code || undefined} onClick={() => set({ code: r.code, table: tableKey })}>
                      <Text span className={classes.code} style={{ flex: "0 0 auto" }}>
                        <ColoredCode code={r.code} />
                      </Text>
                      <Box style={{ minWidth: 0 }}>
                        <Text fz="sm" lineClamp={1}>
                          {r.name_zh || r.name_en}
                        </Text>
                        {r.name_zh && (
                          <Text fz="xs" c="dimmed" lineClamp={1}>
                            {r.name_en}
                          </Text>
                        )}
                      </Box>
                    </UnstyledButton>
                  ))}
                  {codes.data.total > 12 && (
                    <Group justify="flex-end" p="sm">
                      <Pagination size="sm" total={Math.ceil(codes.data.total / 12)} value={page} onChange={setPage} siblings={0} />
                    </Group>
                  )}
                </Box>
              )}
            </Panel>
          )}
        </Stack>
      </div>
      {browse.data && (
        <Text fz={11} c="dimmed">
          軸標籤來源：{browse.data.source}（CMS）。中文名稱為衛福部中文版。
        </Text>
      )}
    </Stack>
  );
}

export function ColoredCode({ code }: { code: string }) {
  return (
    <>
      {code.split("").map((ch, i) => (
        <span key={i} style={{ color: AXIS_COLORS[i] }}>
          {ch}
        </span>
      ))}
    </>
  );
}

function labelOf(t: PcsTable | undefined, axis: number, v: string): string | null {
  if (!t) return null;
  const col = (["body_part", "approach", "device", "qualifier"] as const)[axis];
  for (const r of t.rows) {
    const hit = r[col].find(([c]) => c === v);
    if (hit) return hit[1];
  }
  return null;
}

function PcsNavigator({ sections, current, onPick, mobile }: { sections: PcsSection[]; current: string; onPick: (key: string) => void; mobile: boolean }) {
  const [sec, setSec] = useState(current[0] ?? "0");
  const [sys, setSys] = useState(current[1] ?? "");
  useEffect(() => {
    if (current.length === 3) {
      setSec(current[0]);
      setSys(current[1]);
    }
  }, [current]);
  const section = sections.find((s) => s.code === sec) ?? sections[0];
  const system = section?.systems.find((s) => s.code === sys);

  if (mobile) {
    return (
      <Stack gap="xs" p="sm">
        <Select
          label="章節"
          data={sections.map((s) => ({ value: s.code, label: `${s.code} · ${s.label_zh ?? s.label}` }))}
          value={section?.code ?? null}
          onChange={(v) => (setSec(v ?? "0"), setSys(""))}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
        />
        <Select
          label="身體系統"
          data={(section?.systems ?? []).map((s) => ({ value: s.code, label: `${s.code} · ${s.label}` }))}
          value={system?.code ?? null}
          onChange={(v) => setSys(v ?? "")}
          searchable
          comboboxProps={{ withinPortal: true }}
        />
        <Select
          label="術式（表）"
          data={(system?.ops ?? []).map((o) => ({ value: o.key, label: `${o.code} · ${o.label}（${o.db_count}）` }))}
          value={current.length === 3 ? current : null}
          onChange={(v) => v && onPick(v)}
          searchable
          disabled={!system}
          comboboxProps={{ withinPortal: true }}
        />
      </Stack>
    );
  }

  return (
    <ScrollArea h={620} type="auto">
      <Stack gap={2} p={6}>
        {sections.map((s) => {
          const open = s.code === section?.code;
          return (
            <Box key={s.code}>
              <UnstyledButton className={classes.result} onClick={() => (setSec(s.code), setSys(""))} data-active={open || undefined}>
                <Group gap={8} wrap="nowrap">
                  <Text span className={classes.code} c={AXIS_COLORS[0]} w={14}>
                    {s.code}
                  </Text>
                  <Box style={{ minWidth: 0, flex: 1 }}>
                    <Text fz="sm" fw={open ? 650 : 500} truncate>
                      {s.label_zh ?? s.label}
                    </Text>
                    <Text fz={11} c="dimmed" truncate>
                      {s.label}
                    </Text>
                  </Box>
                  <Text fz={11} c="dimmed" className="tabular">
                    {fmtNumber(s.db_count)}
                  </Text>
                </Group>
              </UnstyledButton>
              {open && (
                <Box className={classes.nested} my={4}>
                  {s.systems.map((b) => {
                    const bOpen = b.code === system?.code;
                    return (
                      <Box key={b.code} className={classes.nestedItem}>
                        <UnstyledButton className={classes.result} onClick={() => setSys(bOpen ? "" : b.code)} data-active={bOpen || undefined} py={4}>
                          <Group gap={8} wrap="nowrap">
                            <Text span className={classes.code} c={AXIS_COLORS[1]} w={14}>
                              {b.code}
                            </Text>
                            <Text fz="xs" truncate style={{ flex: 1 }}>
                              {b.label}
                            </Text>
                            <Text fz={10.5} c="dimmed" className="tabular">
                              {fmtNumber(b.db_count)}
                            </Text>
                          </Group>
                        </UnstyledButton>
                        {bOpen && (
                          <Group gap={4} my={6} ml={22}>
                            {b.ops.map((o) => (
                              <UnstyledButton
                                key={o.key}
                                className={classes.pcsValue}
                                data-active={o.key === current || undefined}
                                style={{ "--ax": AXIS_COLORS[2] } as CSSProperties}
                                onClick={() => onPick(o.key)}
                                title={`${o.key} · ${o.label}`}
                              >
                                <b className={classes.code} style={{ color: AXIS_COLORS[2] }}>
                                  {o.code}
                                </b>
                                {o.label}
                              </UnstyledButton>
                            ))}
                          </Group>
                        )}
                      </Box>
                    );
                  })}
                </Box>
              )}
            </Box>
          );
        })}
      </Stack>
    </ScrollArea>
  );
}

function PcsTableView({ table, axes, onToggle }: { table: UseQueryResult<PcsTable>; axes: Axes; onToggle: (axis: number, v: string) => void }) {
  const t = table.data;
  const cols = ["body_part", "approach", "device", "qualifier"] as const;
  const matches = useMemo(
    () => (t ? t.rows.map((r) => cols.every((c, i) => !axes[i] || r[c].some(([v]) => v === axes[i]))) : []),
    [t, axes], // eslint-disable-line react-hooks/exhaustive-deps
  );
  if (table.isError) return <ErrorState error={table.error} onRetry={() => void table.refetch()} />;
  if (!t) return <Skeleton h={260} />;
  const anySel = axes.some(Boolean);
  return (
    <Panel
      title={
        <Group gap={8} wrap="wrap">
          <Text span className={classes.code} fz={15}>
            <ColoredCode code={t.key} />
          </Text>
          <span>
            {t.section.label_zh ?? t.section.label} · {t.body_system.label} · <b>{t.operation.label}</b>
          </span>
        </Group>
      }
      right={
        <Text fz={11} c="dimmed">
          {t.rows.length} 列 · 資料庫 {fmtNumber(t.db_count)} 碼
        </Text>
      }
    >
      <Stack gap="sm" p="md">
        {t.operation.definition && (
          <Text fz="sm" c="dimmed" fs="italic">
            「{t.operation.label}」：{t.operation.definition}
          </Text>
        )}
        {t.rows.map((r, ri) => (
          <div key={ri} className={classes.pcsRowBox} data-match={(anySel && matches[ri]) || undefined} data-nomatch={(anySel && !matches[ri]) || undefined}>
            <div className={classes.pcsGrid}>
              {cols.map((c, ci) => (
                <div key={c}>
                  <Text fz={10} fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.05em" }}>
                    {ci + 4} · {t.titles[ci + 3] || AXIS_ZH[ci + 3]}
                  </Text>
                  {r[c].map(([v, label]: PcsLabel) => (
                    <UnstyledButton
                      key={v}
                      className={classes.pcsValue}
                      style={{ "--ax": AXIS_COLORS[ci + 3] } as CSSProperties}
                      data-active={axes[ci] === v || undefined}
                      onClick={() => onToggle(ci, v)}
                    >
                      <b className={classes.code} style={{ color: AXIS_COLORS[ci + 3] }}>
                        {v}
                      </b>
                      <span>{label}</span>
                    </UnstyledButton>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </Stack>
    </Panel>
  );
}

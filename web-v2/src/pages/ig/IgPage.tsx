import { Alert, Badge, Box, Button, Card, Group, Highlight, Pagination, Select, SimpleGrid, Stack, Tabs, Text, ThemeIcon, Tooltip } from "@mantine/core";
import {
  IconAlertTriangle,
  IconBox,
  IconBooks,
  IconCertificate,
  IconHistory,
  IconTrashX,
  IconFilterOff,
  IconPackage,
  IconPlus,
  IconSettings,
  IconStar,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { SectionCard } from "@/components/SectionCard";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/QueryBoundary";
import { RelativeTime } from "@/components/RelativeTime";
import { notify } from "@/components/notify";
import { useModulesCatalog } from "@/layout/AppLayout";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { fmtCompact, fmtNumber } from "@/lib/format";
import { useDebounced, useIsMobile } from "@/lib/hooks";
import { MODULE_BY_KEY, TERMINAL_STATUSES } from "@/lib/meta";
import { useModuleJobs } from "../modules/moduleData";
import { InlineJobProgress, RecentJobsList } from "../modules/JobProgress";
import { DangerZone, MaintenanceSection } from "../modules/ModuleAdminSections";
import { AddIgModal } from "./AddIgModal";
import { IgDetailDrawer } from "./IgDetailDrawer";
import { MissingDepsBadge, MissingDepsModal, type MissingDepsTarget } from "./MissingDepsModal";
import { FAILURE_COPY, failureKindFromCode } from "./igDepCopy";
import type { IgDetail, IgRef, IgSummary } from "./igTypes";
import { IgFilterBar, type FacetCounts, type FilterPatch } from "./IgFilterBar";
import { OriginBadge } from "./igOriginBadge";
import { RemoveIgModal } from "./RemoveIgModal";
import { UnusedDepsModal, useUnusedDependencies } from "./UnusedDepsModal";
import { refLabel as removedLabel, type IgRemovalResult } from "./igRemoval";
import { applyFilters, excerpt, normalizeQuery, P, PAGE_SIZES, paginate, readFilters, sortIgs } from "./igFilters";

const meta = MODULE_BY_KEY.ig;

const igLabel = (r: IgRef) => `${r.package_id}@${r.version}`;

/** Who pulled a dependency install in: the recorded installer, else the installed IGs that need it. */
function installedVia(ig: IgSummary): string | null {
  if (ig.install_origin !== "dependency") return null;
  const via = ig.installed_for;
  if (via) {
    const name = via.title && via.title !== via.package_id ? via.title : igLabel(via);
    return `由 ${name} 帶入${via.installed ? "" : "（已移除）"}`;
  }
  const req = ig.required_by ?? [];
  if (req.length === 0) return "帶入它的 IG 已不在";
  return `被 ${igLabel(req[0])}${req.length > 1 ? ` 等 ${req.length} 個 IG` : ""} 依賴`;
}

function IgCard({ ig, query, onOpen, onOpenDeps }: { ig: IgSummary; query: string; onOpen: () => void; onOpenDeps: () => void }) {
  const missing = ig.deps_missing.length;
  const terms = normalizeQuery(query).split(/\s+/).filter(Boolean);
  const via = installedVia(ig);
  // Show where a match came from when it is not visible on the card already.
  const visible = [ig.title, ig.package_id, ig.version].join("\n").toLowerCase();
  const hiddenMatch = terms.length > 0 && terms.some((t) => !visible.includes(t));
  const descSnippet = hiddenMatch && ig.description ? excerpt(ig.description, query) : null;
  const canonicalHit = hiddenMatch && !descSnippet && ig.canonical && terms.some((t) => ig.canonical!.toLowerCase().includes(t));
  return (
    <Card
      padding="md"
      className="hover-lift"
      onClick={onOpen}
      style={{
        cursor: "pointer",
        borderColor: ig.is_default ? "var(--mantine-primary-color-filled)" : undefined,
        borderWidth: ig.is_default ? 1.5 : undefined,
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`${ig.title} 詳細資訊`}
    >
      <Stack gap="sm" h="100%">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
            <ThemeIcon variant="light" size={38} radius="md" color={ig.is_default ? "brand" : "gray"}>
              <IconPackage size={20} />
            </ThemeIcon>
            <Box style={{ minWidth: 0 }}>
              <Highlight highlight={terms} fw={650} fz="sm" lineClamp={2} style={{ wordBreak: "break-word" }}>
                {ig.title}
              </Highlight>
              <Highlight highlight={terms} fz="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
                {ig.package_id}
              </Highlight>
            </Box>
          </Group>
          {ig.is_default && (
            <Badge color="brand" leftSection={<IconStar size={10} />} style={{ flexShrink: 0 }}>
              預設
            </Badge>
          )}
        </Group>
        <Group gap={6} wrap="wrap">
          {ig.install_origin && <OriginBadge origin={ig.install_origin} />}
          <Badge variant="outline" color="gray" ff="monospace">
            v{ig.version}
          </Badge>
          {ig.fhir_version && (
            <Badge variant="light" color="gray">
              FHIR {ig.fhir_version}
            </Badge>
          )}
          {ig.status && (
            <Badge variant="light" color="gray">
              {ig.status}
            </Badge>
          )}
        </Group>
        {via && (
          <Text fz="xs" c="dimmed" lineClamp={2} style={{ wordBreak: "break-word" }} title={(ig.required_by ?? []).map(igLabel).join("\n") || undefined}>
            {via}
          </Text>
        )}
        {descSnippet && (
          <Highlight highlight={terms} fz="xs" c="dimmed" lineClamp={3} style={{ wordBreak: "break-word" }}>
            {`說明：${descSnippet}`}
          </Highlight>
        )}
        {canonicalHit && (
          <Highlight highlight={terms} fz="xs" c="dimmed" ff="monospace" lineClamp={2} style={{ wordBreak: "break-all" }}>
            {ig.canonical!}
          </Highlight>
        )}
        <SimpleGrid cols={3} spacing="xs" mt="auto">
          {[
            ["構件", ig.counts.artifacts],
            ["CodeSystem", ig.counts.codesystems],
            ["概念", ig.counts.concepts],
          ].map(([label, n]) => (
            <Box key={String(label)}>
              <Text fz="xs" c="dimmed">
                {label}
              </Text>
              <Text fz="sm" fw={650} style={{ fontVariantNumeric: "tabular-nums" }}>
                {fmtCompact(Number(n))}
              </Text>
            </Box>
          ))}
        </SimpleGrid>
        <Group justify="space-between" gap="xs" wrap="wrap">
          {missing > 0 ? (
            <Tooltip
              label={[...ig.deps_missing.map((d) => `${d.package_id}@${d.version}`), "點擊以下載或上傳"].join("\n")}
              multiline
              style={{ whiteSpace: "pre-line" }}
            >
              <MissingDepsBadge count={missing} onClick={onOpenDeps} label={`${ig.title} 缺少 ${missing} 個相依，開啟下載或上傳選項`} />
            </Tooltip>
          ) : (
            <Text fz="xs" c="dimmed">
              {ig.deps_total > 0 ? `${ig.deps_total} 個相依皆已安裝` : "無相依套件"}
            </Text>
          )}
          <Text fz="xs" c="dimmed">
            匯入 <RelativeTime value={ig.imported_at} fz="xs" />
          </Text>
        </Group>
      </Stack>
    </Card>
  );
}

export default function IgPage() {
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") === "settings" ? "settings" : sp.get("tab") === "jobs" ? "jobs" : "gallery";
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<IgRef | null>(null);
  // Missing-dependency dialog: null = closed, "all" = every IG, else one IG.
  const [depsFor, setDepsFor] = useState<MissingDepsTarget | "all" | null>(null);
  // Jobs started from the dependency dialog → toast when they finish.
  const [watched, setWatched] = useState<Record<string, string>>({});
  const [removeTarget, setRemoveTarget] = useState<IgRef | null>(null);
  const [unusedOpen, setUnusedOpen] = useState(false);
  const isMobile = useIsMobile();
  const f = readFilters(sp);
  // Search: typed locally, written to the URL (replace) once debounced.
  const [search, setSearch] = useState(f.q);
  const debouncedSearch = useDebounced(search, 250);
  const spRef = useRef(sp);
  spRef.current = sp;
  const galleryTop = useRef<HTMLDivElement>(null);

  /** Apply URL changes; any filter change goes back to page 1. Discrete changes push history. */
  const patchParams = (patch: Record<string, string | null>, opts: { replace?: boolean; keepPage?: boolean } = {}) => {
    const next = new URLSearchParams(spRef.current);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!opts.keepPage) next.delete(P.page);
    if (next.toString() !== spRef.current.toString()) setSp(next, { replace: opts.replace ?? false });
  };

  useEffect(() => {
    if (debouncedSearch.trim() !== readFilters(spRef.current).q) patchParams({ [P.q]: debouncedSearch.trim() || null }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);
  // Back/forward (or a pill) changed q → mirror it into the box.
  useEffect(() => {
    setSearch((cur) => (cur.trim() === f.q ? cur : f.q));
  }, [f.q]);

  const onFilterChange = (patch: FilterPatch) => {
    const map: Record<string, string> = { origin: P.origin, deps: P.deps, fhir: P.fhir, default: P.def, examples: P.ex, sort: P.sort };
    patchParams(Object.fromEntries(Object.entries(patch).map(([k, v]) => [map[k], v ?? null])));
  };
  const clearFilters = () => {
    setSearch("");
    patchParams({ [P.q]: null, [P.origin]: null, [P.deps]: null, [P.fhir]: null, [P.def]: null, [P.ex]: null });
  };
  const goPage = (page: number) => {
    patchParams({ [P.page]: page > 1 ? String(page) : null }, { keepPage: true });
    galleryTop.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const igs = useQuery({ queryKey: qk.igs, queryFn: () => api.get<{ igs: IgSummary[] }>("/admin/api/igs"), staleTime: 15_000 });
  const catalog = useModulesCatalog();
  const jobs = useModuleJobs("ig");
  const activeImport = jobs.activeOf("ig_import");
  const anyActive = jobs.active[0] ?? null;
  const maintenance = Boolean(catalog.data?.maintenance?.ig);
  const igEntry = catalog.data?.modules.find((e) => e.module_key === "ig") ?? null;
  const maxUploadMb = catalog.data?.upload_limits.max_upload_mb ?? 512;

  useEffect(() => {
    const finished = Object.entries(watched).flatMap(([id, label]) => {
      const j = jobs.all.find((x) => x.job_id === id);
      return j && TERMINAL_STATUSES.has(j.status) ? [{ j, label }] : [];
    });
    if (finished.length === 0) return;
    for (const { j, label } of finished) {
      if (j.status === "success") notify.success(`${label} 已下載並匯入完成。`, "相依已安裝");
      else if (j.status === "partial_success") notify.warn(`${label}：部分套件無法下載，請在「缺少的相依」查看原因。`, "部分完成");
      else if (j.status === "stopped" || j.status === "cancelled") notify.info(`${label} 的工作已停止。`);
      else {
        const copy = FAILURE_COPY[failureKindFromCode(j.last_error_code)];
        notify.error(`${copy.title}。${copy.next}`, `${label} 下載失敗`);
      }
    }
    setWatched((prev) => {
      const next = { ...prev };
      for (const { j } of finished) delete next[j.job_id];
      return next;
    });
  }, [jobs.all, watched]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.igs });
    void qc.invalidateQueries({ queryKey: qk.modules });
    void qc.invalidateQueries({ queryKey: qk.overview });
    void qc.invalidateQueries({ queryKey: qk.moduleClear("ig") });
    void qc.invalidateQueries({ queryKey: ["preview", "ig"] });
  };

  const setDefault = useMutation({
    mutationFn: (ig: IgRef) =>
      api.post<{ ok: boolean }>(`/admin/api/igs/${encodeURIComponent(ig.package_id)}/${encodeURIComponent(ig.version)}/default`),
    onSuccess: (_r, ig) => notify.success(`${ig.package_id}@${ig.version} 已設為預設 IG`),
    onError: (e) => notify.error(e, "設定預設 IG 失敗"),
    onSettled: invalidate,
  });

  const removeBlock = activeImport ? "IG 匯入工作進行中，完成後才能移除" : null;
  const unused = useUnusedDependencies();
  const unusedCount = unused.data?.packages.length ?? 0;

  const askRemove = (d: IgDetail) => setRemoveTarget({ package_id: d.package_id, version: d.version });

  const onRemoved = (r: IgRemovalResult, t: IgRef) => {
    const label = `${t.package_id}@${t.version}`;
    if (r.forced && (r.dependents?.length ?? 0) > 0) {
      notify.warn(`${label} 已強制移除；${r.dependents!.map(removedLabel).join("、")} 的驗證與 ValueSet 展開可能失效。`, "已強制移除");
    } else {
      notify.success(`${label} 已移除${r.new_default ? `，預設 IG 改為 ${removedLabel(r.new_default)}` : ""}`);
    }
    setRemoveTarget(null);
    setSelected(null);
    invalidate();
  };

  const onUnusedRemoved = (r: IgRemovalResult) => {
    const n = r.packages?.length ?? 0;
    if (n > 0) notify.success(`已移除 ${n} 個未使用的相依套件`);
    setUnusedOpen(false);
    invalidate();
  };

  const setTab = (t: string | null) => {
    const next = new URLSearchParams(sp);
    if (!t || t === "gallery") next.delete("tab");
    else next.set("tab", t);
    setSp(next, { replace: true });
  };

  const list = useMemo(() => igs.data?.igs ?? [], [igs.data]);
  const filtered = useMemo(() => sortIgs(applyFilters(list, f), f.sort), [list, f.q, f.origin, f.deps, f.fhir, f.defaultOnly, f.examples, f.sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const paged = paginate(filtered, f.page, f.size);
  const facets: FacetCounts = useMemo(() => {
    const byOrigin = applyFilters(list, f, "origin");
    const byDeps = applyFilters(list, f, "deps");
    const byFhir = applyFilters(list, f, "fhir");
    const fhirCounts = new Map<string, number>();
    for (const ig of list) if (ig.fhir_version) fhirCounts.set(ig.fhir_version, 0);
    for (const ig of byFhir) if (ig.fhir_version) fhirCounts.set(ig.fhir_version, (fhirCounts.get(ig.fhir_version) ?? 0) + 1);
    return {
      origin: {
        manual: byOrigin.filter((i) => i.install_origin === "manual").length,
        dependency: byOrigin.filter((i) => i.install_origin === "dependency").length,
        unknown: byOrigin.filter((i) => !i.install_origin).length,
      },
      deps: {
        missing: byDeps.filter((i) => i.deps_missing.length > 0).length,
        complete: byDeps.filter((i) => i.deps_missing.length === 0).length,
      },
      fhir: [...fhirCounts.entries()]
        .sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }))
        .map(([value, count]) => ({ value, count })),
      defaultOnly: applyFilters(list, f, "defaultOnly").filter((i) => i.is_default).length,
      examples: applyFilters(list, f, "examples").filter((i) => (i.counts.examples ?? 0) > 0).length,
    };
  }, [list, f.q, f.origin, f.deps, f.fhir, f.defaultOnly, f.examples]); // eslint-disable-line react-hooks/exhaustive-deps
  const originKnown = list.some((i) => i.install_origin);
  const manualCount = list.filter((i) => i.install_origin === "manual").length;
  const filtersActive = Boolean(f.q || f.origin || f.deps || f.fhir || f.defaultOnly || f.examples);
  const def = list.find((i) => i.is_default) ?? null;
  const totalArtifacts = list.reduce((n, i) => n + i.counts.artifacts, 0);
  const totalConcepts = list.reduce((n, i) => n + i.counts.concepts, 0);
  const missingDeps = new Set(list.flatMap((i) => i.deps_missing.map((d) => `${d.package_id}@${d.version}`)));
  const addBusy = activeImport ? "已有 IG 匯入工作進行中；新的匯入會排在它之後執行。" : null;

  return (
    <>
      <PageHeader
        title="FHIR Implementation Guides"
        description={meta.description}
        icon={<IconBooks size={22} />}
        breadcrumbs={[{ label: "FHIR" }, { label: "IG 套件庫" }]}
        badge={
          maintenance ? (
            <Badge color="amber" variant="filled" leftSection={<IconAlertTriangle size={12} />}>
              維護中
            </Badge>
          ) : undefined
        }
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setAddOpen(true)}>
            新增 IG
          </Button>
        }
      />

      <Stack gap="lg">
        <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} spacing="md">
          <StatCard label="已安裝 IG" loading={igs.isPending} value={fmtNumber(list.length)} hint={list.length ? (originKnown ? `${manualCount} 個手動安裝 · ${list.length - manualCount} 個依賴安裝` : "含自動下載的相依套件") : "尚未安裝"} icon={<IconPackage size={20} />} />
          <StatCard
            label="預設 IG"
            loading={igs.isPending}
            value={
              def ? (
                <Text span fz="lg" fw={700} lh={1.3} lineClamp={2}>
                  {def.title}
                </Text>
              ) : (
                "未指定"
              )
            }
            hint={def ? `${def.package_id}@${def.version}` : "MCP 工具未指定 IG 時使用"}
            icon={<IconStar size={20} />}
            color={def ? "brand" : "amber"}
          />
          <StatCard label="構件 / 概念" loading={igs.isPending} value={fmtCompact(totalArtifacts)} hint={`${fmtNumber(totalConcepts)} 個 CodeSystem 概念`} icon={<IconBox size={20} />} />
          <StatCard
            label="缺少的相依"
            onClick={missingDeps.size ? () => setDepsFor("all") : undefined}
            ariaLabel={missingDeps.size ? `缺少 ${missingDeps.size} 個相依，開啟下載或上傳選項` : undefined}
            loading={igs.isPending}
            value={fmtNumber(missingDeps.size)}
            hint={missingDeps.size ? "點擊以下載或上傳缺少的套件" : "所有相依皆已安裝"}
            icon={<IconCertificate size={20} />}
            color={missingDeps.size ? "amber" : "teal"}
          />
        </SimpleGrid>

        {activeImport && <InlineJobProgress job={activeImport} />}

        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List mb="lg">
            <Tabs.Tab value="gallery" leftSection={<IconPackage size={16} />}>
              已安裝的 IG
            </Tabs.Tab>
            <Tabs.Tab value="jobs" leftSection={<IconHistory size={16} />}>
              匯入紀錄
            </Tabs.Tab>
            <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
              維護與危險操作
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="gallery">
            {igs.isError ? (
              <ErrorState error={igs.error} onRetry={() => void igs.refetch()} />
            ) : igs.isPending ? (
              <PageSkeleton rows={2} />
            ) : list.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<IconBooks size={28} />}
                  title="尚未安裝任何 IG"
                  description="FHIR IG 工具需要至少一個 IG 套件。建議從 Registry 匯入台灣核心 IG（tw.gov.mohw.twcore），相依的 hl7.fhir.r4.core 會一併下載。"
                  action={
                    <Button leftSection={<IconPlus size={16} />} onClick={() => setAddOpen(true)}>
                      新增第一個 IG
                    </Button>
                  }
                />
              </Card>
            ) : (
              <Stack gap="md">
                {!def && (
                  <Alert color="amber" icon={<IconAlertTriangle size={16} />} p="sm">
                    <Text fz="sm">尚未指定預設 IG。打開任一 IG 並按「設為預設」。</Text>
                  </Alert>
                )}
                {unusedCount > 0 && (
                  <Alert color="gray" variant="light" icon={<IconTrashX size={16} />} p="sm">
                    <Group justify="space-between" gap="xs" wrap="wrap">
                      <Text fz="sm">{unusedCount} 個依賴安裝的套件已不被任何 IG 使用。</Text>
                      <Button size="xs" variant="light" color="gray" leftSection={<IconTrashX size={14} />} onClick={() => setUnusedOpen(true)}>
                        清理未使用的相依
                      </Button>
                    </Group>
                  </Alert>
                )}
                <div ref={galleryTop} style={{ scrollMarginTop: 80 }} />
                <IgFilterBar
                  f={f}
                  search={search}
                  onSearch={setSearch}
                  facets={facets}
                  onChange={onFilterChange}
                  onClearAll={clearFilters}
                  resultCount={filtered.length}
                />
                <Text fz="xs" c="dimmed" aria-live="polite">
                  {filtered.length === 0
                    ? `沒有符合的 IG（共 ${list.length} 個）`
                    : `顯示第 ${paged.from}–${paged.to} 個，${filtersActive ? `符合 ${filtered.length} 個 / ` : ""}共 ${list.length} 個 IG`}
                </Text>
                {filtered.length === 0 ? (
                  <Card>
                    <EmptyState
                      icon={<IconFilterOff size={28} />}
                      title="沒有符合篩選條件的 IG"
                      description="調整搜尋文字或篩選條件，或清除全部篩選。"
                      action={
                        <Button variant="light" leftSection={<IconFilterOff size={16} />} onClick={clearFilters}>
                          清除篩選
                        </Button>
                      }
                    />
                  </Card>
                ) : (
                  <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="md">
                    {paged.rows.map((ig) => (
                      <IgCard
                        key={`${ig.package_id}@${ig.version}`}
                        ig={ig}
                        query={f.q}
                        onOpen={() => setSelected({ package_id: ig.package_id, version: ig.version })}
                        onOpenDeps={() => setDepsFor({ package_id: ig.package_id, version: ig.version, title: ig.title })}
                      />
                    ))}
                  </SimpleGrid>
                )}
                {filtered.length > PAGE_SIZES[0] && (
                  <Group justify="space-between" gap="sm" wrap="wrap">
                    <Pagination
                      total={paged.totalPages}
                      value={paged.page}
                      onChange={goPage}
                      size={isMobile ? "sm" : "md"}
                      siblings={isMobile ? 0 : 1}
                      boundaries={1}
                      getControlProps={(control) => ({
                        "aria-label": { first: "第一頁", last: "最後一頁", next: "下一頁", previous: "上一頁" }[control],
                      })}
                      getItemProps={(page) => ({ "aria-label": `第 ${page} 頁` })}
                    />
                    <Group gap="xs" wrap="nowrap">
                      <Text fz="xs" c="dimmed">
                        每頁
                      </Text>
                      <Select
                        aria-label="每頁顯示數量"
                        size="xs"
                        w={80}
                        value={String(f.size)}
                        onChange={(v) => patchParams({ [P.size]: v && Number(v) !== 24 ? v : null })}
                        data={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
                        allowDeselect={false}
                        comboboxProps={{ withinPortal: true, floatingStrategy: "fixed" }}
                      />
                    </Group>
                  </Group>
                )}
              </Stack>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="jobs">
            <SectionCard
              title="IG 匯入紀錄"
              icon={<IconHistory size={18} />}
              actions={
                <Button component={Link} to="/jobs" variant="default" size="xs">
                  所有工作
                </Button>
              }
              flush
            >
              <RecentJobsList jobs={jobs.all} limit={20} />
            </SectionCard>
          </Tabs.Panel>

          <Tabs.Panel value="settings">
            <Stack gap="lg">
              <MaintenanceSection meta={meta} enabled={maintenance} />
              <SectionCard title="清理未使用的相依" icon={<IconTrashX size={18} />}>
                <Group justify="space-between" gap="sm" wrap="wrap">
                  <Text fz="sm" c="dimmed" style={{ flex: "1 1 260px" }}>
                    {unused.isPending
                      ? "檢查中…"
                      : unusedCount > 0
                        ? `${unusedCount} 個依賴安裝的套件已沒有任何手動安裝的 IG 或預設 IG 需要，可以安全移除。`
                        : "目前沒有未使用的相依套件。移除 IG 後留下的相依會出現在這裡。"}
                  </Text>
                  <Button variant="default" leftSection={<IconTrashX size={16} />} onClick={() => setUnusedOpen(true)}>
                    清理未使用的相依{unusedCount > 0 ? `（${unusedCount}）` : ""}
                  </Button>
                </Group>
              </SectionCard>
              <DangerZone
                meta={meta}
                activeJob={anyActive}
                extraConsequences={{
                  data: ["所有已安裝的 IG（含預設 IG）都會被移除；要移除單一 IG 請在 IG 詳細資訊中操作"],
                  all: ["所有已安裝的 IG（含預設 IG）都會被移除"],
                }}
              />
            </Stack>
          </Tabs.Panel>
        </Tabs>
      </Stack>

      <AddIgModal opened={addOpen} onClose={() => setAddOpen(false)} installed={list} catalogEntry={igEntry} maxUploadMb={maxUploadMb} busy={addBusy} />
      <IgDetailDrawer
        target={selected}
        onClose={() => setSelected(null)}
        onSetDefault={(ig) => setDefault.mutate(ig)}
        onRemove={askRemove}
        settingDefault={setDefault.isPending}
        removeBlock={removeBlock}
        onOpenDeps={(d) => setDepsFor({ package_id: d.package_id, version: d.version, title: d.title })}
        closeOnEscape={depsFor === null && removeTarget === null}
      />
      <RemoveIgModal target={removeTarget} onClose={() => setRemoveTarget(null)} onRemoved={onRemoved} />
      <UnusedDepsModal opened={unusedOpen} onClose={() => setUnusedOpen(false)} onRemoved={onUnusedRemoved} busyReason={removeBlock} />
      <MissingDepsModal
        opened={depsFor !== null}
        onClose={() => setDepsFor(null)}
        forIg={depsFor === "all" ? null : depsFor}
        catalogEntry={igEntry}
        maxUploadMb={maxUploadMb}
        onJobStarted={(id, label) => setWatched((prev) => ({ ...prev, [id]: label }))}
      />
    </>
  );
}

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Collapse,
  Drawer,
  Group,
  Loader,
  NumberInput,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  IconAdjustments,
  IconAlertTriangle,
  IconArrowsShuffle,
  IconBolt,
  IconCheck,
  IconGripVertical,
  IconListNumbers,
  IconPlayerPlay,
  IconPlugOff,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconStack2,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { confirmAction, confirmIsOpen } from "@/components/confirm";
import { notify } from "@/components/notify";
import { api } from "@/lib/api";
import { useIsMobile } from "@/lib/hooks";
import type { LlmProfileKind } from "@/lib/types";
import { AnalysisProbe, type ProbeResult } from "./AnalysisProbe";
import { KnobField, MONO_INPUT } from "./fields";
import { GUIDE_CODES, llmErrorInfo, llmErrorText, llmText, type CodeParams, type LlmErrorInfo } from "./llmErrors";
import { EmbeddingGuide } from "./EmbeddingGuide";
import { EmbeddingIssueFixes, LlmErrorAlert } from "./ErrorDetails";
import {
  STRATEGY_META,
  llmKeys,
  nestableRoutes,
  specFor,
  useAccountModels,
  useEmbeddingIdentity,
  useFingerprint,
  type ProviderAccount,
  type Route,
  type RouteMember,
  type RouteStrategy,
} from "./llmApi";
import { visibleParams, type KnobValue, type ProviderSpec } from "./profileModel";
import { ProviderAvatar } from "./ProviderAvatar";
import { RouteFlow, type FlowTrace } from "./RouteFlow";
import classes from "./models.module.css";

interface DraftMember extends Omit<RouteMember, "id"> {
  key: string;
  /** Saved member id (stable across saves for cool-down/stats), else undefined. */
  id?: number;
}

interface Draft {
  id: number | null;
  name: string;
  kind: LlmProfileKind;
  strategy: RouteStrategy;
  description: string;
  members: DraftMember[];
}

interface TestTrace {
  ok: boolean;
  answered_by: number | null;
  order: number[];
  attempts: { member_id: number; name: string; ok: boolean; latency_ms: number; message: string; code?: string; params?: CodeParams }[];
  /** Set when nothing could be tried (e.g. every member disabled). */
  message?: string;
  code?: string;
  params?: CodeParams;
}

const STRATEGY_ICON: Record<RouteStrategy, typeof IconBolt> = {
  single: IconBolt,
  fallback: IconListNumbers,
  round_robin: IconRefresh,
  load_balance: IconArrowsShuffle,
};

let keySeq = 0;
const newKey = () => `m${Date.now().toString(36)}${(keySeq++).toString(36)}`;

function toDraft(r: Route | null, kind: LlmProfileKind): Draft {
  return {
    id: r?.id ?? null,
    name: r?.name ?? "",
    kind: r?.kind ?? kind,
    strategy: r?.strategy ?? "fallback",
    description: r?.description ?? "",
    members: (r?.members ?? []).map((m) => ({ ...m, key: `s${m.id}` })),
  };
}

function toPayload(d: Draft) {
  return {
    name: d.name.trim(),
    kind: d.kind,
    strategy: d.strategy,
    description: d.description,
    members: d.members.map((m) => ({
      member_type: m.member_type,
      provider_id: m.provider_id,
      model: m.model,
      child_route_id: m.child_route_id,
      weight: m.weight,
      enabled: m.enabled,
      params: m.params,
    })),
  };
}

export interface ProfileBuilderProps {
  opened: boolean;
  onClose: () => void;
  route: Route | null;
  /** Kind for a new profile. */
  kind: LlmProfileKind;
  routes: Route[];
  accounts: ProviderAccount[];
  specs: ProviderSpec[];
  cooling: Record<string, number>;
  boundRoles: LlmProfileKind[];
}

export function ProfileBuilder({ opened, onClose, route, kind, routes, accounts, specs, cooling, boundRoles }: ProfileBuilderProps) {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(toDraft(route, kind));
  const [initial, setInitial] = useState<string>("");
  const [error, setError] = useState<LlmErrorInfo | null>(null);
  /** A refused embedding save that needs the model-switch guidance dialog. */
  const [guide, setGuide] = useState<LlmErrorInfo | null>(null);
  const switched = useRef(false);
  const [dragging, setDragging] = useState<{ label: string; sub?: string; provider?: string } | null>(null);
  const [trace, setTrace] = useState<TestTrace | null>(null);
  const [mobilePane, setMobilePane] = useState<"blocks" | "members" | "preview">("members");
  const [nameTouched, setNameTouched] = useState(false);

  useEffect(() => {
    if (!opened) return;
    const next = toDraft(route, kind);
    setD(next);
    setInitial(JSON.stringify(toPayload(next)));
    setError(null);
    setTrace(null);
    setMobilePane("members");
    setNameTouched(false);
  }, [opened, route, kind]);

  const dirty = JSON.stringify(toPayload(d)) !== initial;
  const labels = useMemo(() => Object.fromEntries(specs.map((s) => [s.id, s.label])), [specs]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const usableAccounts = accounts.filter((a) => specFor(specs, a.provider)?.roles.includes(d.kind));
  const nestable = nestableRoutes(routes, d.kind, d.id);

  const addModel = (acc: ProviderAccount, model: string, at?: number) => {
    const params: Record<string, KnobValue> = {};
    if (d.kind === "embedding") {
      const ref = d.members.find((m) => m.member_type === "model");
      params.dimensions = typeof ref?.params.dimensions === "number" ? ref.params.dimensions : 1024;
    } else if (specFor(specs, acc.provider)?.params.some((p) => p.key === "temperature")) {
      params.temperature = 0.1;
    }
    const m: DraftMember = { key: newKey(), member_type: "model", provider_id: acc.id, model, child_route_id: null, weight: 1, enabled: true, params };
    setD((cur) => {
      const members = [...cur.members];
      members.splice(at ?? members.length, 0, m);
      return { ...cur, members };
    });
    setTrace(null);
  };
  const hasChild = (id: number) => d.members.some((m) => m.member_type === "route" && m.child_route_id === id);
  const addRoute = (r: Route, at?: number) => {
    // The server refuses the same profile twice in one level (it would only be tried twice).
    if (hasChild(r.id)) {
      notify.warn(`「${r.name}」已經在成員裡，同一個 Profile 不能加入兩次。`);
      return;
    }
    const m: DraftMember = { key: newKey(), member_type: "route", provider_id: null, model: "", child_route_id: r.id, weight: 1, enabled: true, params: {} };
    setD((cur) => {
      const members = [...cur.members];
      members.splice(at ?? members.length, 0, m);
      return { ...cur, members };
    });
    setTrace(null);
  };
  const updateMember = (key: string, patch: Partial<DraftMember>) => {
    setD((cur) => ({ ...cur, members: cur.members.map((m) => (m.key === key ? { ...m, ...patch } : m)) }));
    setTrace(null);
  };
  const removeMember = (key: string) => setD((cur) => ({ ...cur, members: cur.members.filter((m) => m.key !== key) }));

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as { label?: string; sub?: string; provider?: string } | undefined;
    setDragging(data?.label ? { label: data.label, sub: data.sub, provider: data.provider } : null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const data = active.data.current as { kind?: string; account?: ProviderAccount; model?: string; route?: Route } | undefined;
    const overIndex = d.members.findIndex((m) => m.key === over.id);
    if (data?.kind === "palette-model" && data.account && data.model) {
      addModel(data.account, data.model, overIndex >= 0 ? overIndex : undefined);
      return;
    }
    if (data?.kind === "palette-route" && data.route) {
      addRoute(data.route, overIndex >= 0 ? overIndex : undefined);
      return;
    }
    if (active.id !== over.id && overIndex >= 0) {
      const from = d.members.findIndex((m) => m.key === active.id);
      if (from >= 0) setD((cur) => ({ ...cur, members: arrayMove(cur.members, from, overIndex) }));
    }
  };

  const save = useMutation({
    mutationFn: () =>
      d.id === null
        ? api.post<{ route: Route }>("/admin/api/llm/routes", toPayload(d))
        : api.put<{ route: Route }>(`/admin/api/llm/routes/${d.id}`, toPayload(d)),
    onSuccess: async (r) => {
      notify.success(d.id === null ? `已建立 Profile「${r.route.name}」` : `已儲存「${r.route.name}」，新請求立即套用`);
      await qc.invalidateQueries({ queryKey: llmKeys.routes });
      const next = toDraft(r.route, r.route.kind);
      setD(next);
      setInitial(JSON.stringify(toPayload(next)));
      setError(null);
    },
    onError: (e) => {
      const info = llmErrorInfo(e);
      // A refused embedding save may still have established the system identity
      // (first fingerprint check): refresh it and the per-member verdicts.
      if (d.kind === "embedding") void qc.invalidateQueries({ queryKey: ["llm", "embedding"] });
      if (info.code && GUIDE_CODES.has(info.code)) {
        setError(null);
        setGuide(info);
      } else setError(info);
    },
  });

  /** Replace a member's model (one-click fix from "model not found → the server serves …"). */
  const swapModel = (accountId: unknown, from: unknown, to: string) => {
    setD((cur) => ({ ...cur, members: cur.members.map((m) => (m.member_type === "model" && m.provider_id === Number(accountId) && m.model === from ? { ...m, model: to } : m)) }));
    setError(null);
  };

  const runTest = useMutation({
    mutationFn: () => api.post<TestTrace>(`/admin/api/llm/routes/${d.id}/test`, {}),
    onMutate: () => setTrace(null),
    onSuccess: (t) => {
      setTrace(t);
      if (isMobile) setMobilePane("preview");
    },
    onError: (e) => notify.error(llmErrorText(e), "測試失敗"),
  });

  const requestClose = () => {
    // Esc reaches every open overlay: the confirm below handles its own.
    if (save.isPending || confirmIsOpen()) return;
    if (!dirty) return onClose();
    confirmAction({ title: "放棄未儲存的變更？", message: "這個 Profile 的修改尚未儲存。", confirmLabel: "放棄變更", danger: true, onConfirm: onClose });
  };

  // Preview uses the draft itself; unsaved members get temporary negative ids.
  const previewRoute: Route = {
    id: d.id ?? -1,
    name: d.name || "（未命名）",
    kind: d.kind,
    strategy: d.strategy,
    description: d.description,
    members: d.members.map((m, i) => ({ ...m, id: m.id ?? -(i + 1) })),
    updated_at: "",
  };
  const flowTrace: FlowTrace | undefined = trace
    ? { answered: trace.answered_by, failed: trace.attempts.filter((a) => !a.ok).map((a) => a.member_id) }
    : undefined;
  // Leaf trace ids are member ids anywhere in the tree; the flow highlights the branch containing them.
  const nameValid = d.name.trim() !== "";
  const embeddingDims = [...new Set(d.members.filter((m) => m.member_type === "model").map((m) => Number(m.params.dimensions ?? 1024)))];

  const strategyPicker = isMobile ? (
    // Phones: a compact picker; the tiles would take half the screen.
    <Select
      label="策略"
      data={(Object.keys(STRATEGY_META) as RouteStrategy[]).map((s) => ({ value: s, label: STRATEGY_META[s].label }))}
      value={d.strategy}
      onChange={(v) => v && setD({ ...d, strategy: v as RouteStrategy })}
      allowDeselect={false}
      description={STRATEGY_META[d.strategy].description}
      leftSection={(() => {
        const Icon = STRATEGY_ICON[d.strategy];
        return <Icon size={16} />;
      })()}
    />
  ) : (
    <Box>
      <Text fz="sm" fw={500} mb={4}>
        策略
      </Text>
      <SimpleGrid cols={2} spacing={6}>
        {(Object.keys(STRATEGY_META) as RouteStrategy[]).map((s) => {
          const Icon = STRATEGY_ICON[s];
          return (
            <UnstyledButton key={s} className={classes.strategyTile} data-active={d.strategy === s || undefined} onClick={() => setD({ ...d, strategy: s })} aria-pressed={d.strategy === s}>
              <Group gap={6} wrap="nowrap" align="flex-start">
                <Icon size={16} className={classes.strategyIcon} />
                <Box>
                  <Text fz="xs" fw={700}>
                    {STRATEGY_META[s].label}
                  </Text>
                  <Text fz={10.5} c="dimmed" lh={1.35}>
                    {STRATEGY_META[s].description}
                  </Text>
                </Box>
              </Group>
            </UnstyledButton>
          );
        })}
      </SimpleGrid>
    </Box>
  );

  const settings = (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
      <Stack gap="xs">
        <TextInput
          label="名稱"
          withAsterisk
          value={d.name}
          onChange={(e) => setD({ ...d, name: e.currentTarget.value })}
          onBlur={() => setNameTouched(true)}
          error={nameTouched && !nameValid ? "請輸入 Profile 名稱" : undefined}
          placeholder="例如「分析主力」「便宜備援池」"
          maxLength={120}
        />
        {d.id === null && (
          <SegmentedControl
            size="xs"
            value={d.kind}
            onChange={(v) => setD({ ...d, kind: v as LlmProfileKind, members: [] })}
            data={[
              { value: "analysis", label: "分析 LLM" },
              { value: "embedding", label: "Embedding" },
            ]}
          />
        )}
        <Textarea placeholder="說明（選填）" aria-label="說明" autosize minRows={1} maxRows={3} value={d.description} onChange={(e) => setD({ ...d, description: e.currentTarget.value })} />
      </Stack>
      {strategyPicker}
    </SimpleGrid>
  );

  const palette = (
    <Stack gap="sm" className={classes.palette}>
      <Text fz="xs" fw={700} c="dimmed" tt="uppercase">
        積木庫
      </Text>
      <Text fz="xs" c="dimmed">
        點 <IconPlus size={11} /> 或拖曳到中間加入。
      </Text>
      <PaletteSection title="模型" icon={<IconBolt size={14} />}>
        {usableAccounts.length === 0 ? (
          <Text fz="xs" c="dimmed">
            沒有支援{d.kind === "embedding" ? " Embedding" : "分析 LLM"}的 Provider 帳號，請先到「Provider 帳號」新增。
          </Text>
        ) : (
          <Accordion multiple variant="separated" radius="md" classNames={{ item: classes.paletteItem }}>
            {usableAccounts.map((a) => (
              <AccountModels key={a.id} account={a} kind={d.kind} label={labels[a.provider] ?? a.provider} onAdd={(model) => addModel(a, model)} />
            ))}
          </Accordion>
        )}
      </PaletteSection>
      <PaletteSection title="其他 Profile" icon={<IconStack2 size={14} />}>
        {nestable.length === 0 ? (
          <Text fz="xs" c="dimmed">
            沒有可以放進來的 Profile（同角色、且不會造成循環）。
          </Text>
        ) : (
          nestable.map((r) => <PaletteRoute key={r.id} route={r} added={hasChild(r.id)} onAdd={() => addRoute(r)} />)
        )}
      </PaletteSection>
    </Stack>
  );

  const membersPane = (
    <Stack gap="sm">
      <Text fz="xs" fw={700} c="dimmed" tt="uppercase">
        成員（{d.members.length}）
      </Text>
      <MembersDrop empty={d.members.length === 0}>
        <SortableContext items={d.members.map((m) => m.key)} strategy={verticalListSortingStrategy}>
          <Stack gap="xs">
            {d.members.map((m, i) => (
              <MemberBlock
                key={m.key}
                m={m}
                index={i}
                draft={d}
                accounts={accounts}
                routes={routes}
                specs={specs}
                labels={labels}
                onChange={(patch) => updateMember(m.key, patch)}
                onRemove={() => removeMember(m.key)}
                traceState={trace && m.id !== undefined ? (trace.answered_by === m.id ? "ok" : trace.attempts.some((a) => a.member_id === m.id && !a.ok) ? "failed" : undefined) : undefined}
              />
            ))}
          </Stack>
        </SortableContext>
      </MembersDrop>
      {d.strategy === "single" && d.members.length > 1 && (
        <Alert color="amber" p="xs" icon={<IconAlertTriangle size={16} />}>
          <Text fz="xs">「單一模型」只能有一個成員。改用依序備援、輪詢或加權負載平衡，或移除多餘的成員。</Text>
        </Alert>
      )}
      {d.kind === "embedding" && embeddingDims.length > 1 && (
        <Alert color="red" p="xs" icon={<IconAlertTriangle size={16} />}>
          <Text fz="xs">Embedding Profile 裡所有模型必須同一個模型、同樣維度（目前有 {embeddingDims.join("／")} 維）。伺服器會拒絕儲存。</Text>
        </Alert>
      )}
    </Stack>
  );

  const previewPane = (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <Text fz="xs" fw={700} c="dimmed" tt="uppercase">
          即時預覽
        </Text>
        <Tooltip label={d.id === null ? "請先儲存" : dirty ? "有未儲存的變更，請先儲存" : "依目前策略送出測試請求，顯示實際走過的路徑"} withArrow>
          <Button size="xs" variant="light" leftSection={<IconPlayerPlay size={14} />} onClick={() => runTest.mutate()} loading={runTest.isPending} disabled={d.id === null || dirty || d.members.length === 0}>
            試跑
          </Button>
        </Tooltip>
      </Group>
      {d.members.length === 0 ? (
        <Box className={classes.previewEmpty}>
          <Text fz="sm" c="dimmed" ta="center">
            加入成員後，這裡會即時畫出請求的走向。
          </Text>
        </Box>
      ) : (
        <RouteFlow route={previewRoute} routes={routes} accounts={accounts} labels={labels} cooling={cooling} trace={flowTrace} compact />
      )}
      {runTest.isPending && (
        <Group gap="xs">
          <Loader size="xs" />
          <Text fz="xs" c="dimmed">
            依策略逐一嘗試中…（每個模型最多 3 分鐘）
          </Text>
        </Group>
      )}
      {trace && (
        <Stack gap={6} className={classes.traceList}>
          <Text fz="xs" fw={700}>
            {trace.ok ? "請求成功" : trace.attempts.length ? "全部失敗" : "無法試跑"}・嘗試 {trace.attempts.length} 個
          </Text>
          {!trace.ok && trace.attempts.length === 0 && (trace.code || trace.message) && (
            <Text fz="xs" c="red">
              {llmText(trace)}
            </Text>
          )}
          {trace.attempts.map((a, i) => (
            <Group key={i} gap={8} wrap="nowrap" className={classes.traceStep} style={{ animationDelay: `${i * 160}ms` }} data-ok={a.ok || undefined}>
              <Badge size="sm" circle color={a.ok ? "teal" : "red"}>
                {i + 1}
              </Badge>
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text fz="xs" fw={600} truncate="end">
                  {a.name}
                </Text>
                <Text fz={11} c={a.ok ? "dimmed" : "red"} lineClamp={2}>
                  {a.ok ? `回應 ${(a.latency_ms / 1000).toFixed(1)} 秒` : llmText(a)}
                </Text>
              </Box>
              {a.ok ? <IconCheck size={16} color="var(--mantine-color-teal-6)" /> : <IconX size={16} color="var(--mantine-color-red-6)" />}
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );

  return (
    <Drawer
      opened={opened}
      onClose={requestClose}
      position="right"
      size={isMobile ? "100%" : "min(1320px, 96vw)"}
      padding={0}
      withCloseButton={false}
      styles={{ content: { display: "flex", flexDirection: "column" }, body: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 } }}
    >
      <Box px={isMobile ? "md" : "lg"} py={isMobile ? "sm" : "md"} style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
        <Group justify="space-between" wrap="nowrap" mb={isMobile ? 0 : "sm"}>
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <IconStack2 size={22} />
            <Title order={3} lineClamp={1}>
              {d.id === null ? "新增 Profile" : `編輯 Profile：${d.name || route?.name || ""}`}
            </Title>
            <Badge variant="light" color={d.kind === "embedding" ? "indigo" : "brand"} tt="none">
              {d.kind === "embedding" ? "Embedding" : "分析 LLM"}
            </Badge>
            {boundRoles.length > 0 && (
              <Badge variant="filled" color="teal" tt="none">
                使用中
              </Badge>
            )}
          </Group>
          <ActionIcon variant="subtle" color="gray" onClick={requestClose} aria-label="關閉">
            <IconX size={18} />
          </ActionIcon>
        </Group>
        {!isMobile && settings}
      </Box>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        {isMobile ? (
          // Phones: the settings scroll away with the content; the pane switcher stays pinned.
          <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" scrollbars="y">
            <Box px="md" pt="sm">
              {settings}
            </Box>
            <Box px="md" py="sm" className={classes.stickyPanes}>
              <SegmentedControl
                fullWidth
                size="xs"
                value={mobilePane}
                onChange={(v) => setMobilePane(v as typeof mobilePane)}
                data={[
                  { value: "blocks", label: "積木庫" },
                  { value: "members", label: `成員 ${d.members.length}` },
                  { value: "preview", label: "預覽" },
                ]}
              />
            </Box>
            <Box px="md" pb="md">
              {mobilePane === "blocks" ? palette : mobilePane === "members" ? membersPane : previewPane}
            </Box>
          </ScrollArea>
        ) : (
          <Box className={classes.builderGrid}>
            <Box className={classes.builderCol}>
              <Box p="md">{palette}</Box>
            </Box>
            <Box className={classes.builderCol}>
              <Box p="md">{membersPane}</Box>
            </Box>
            <Box className={classes.builderCol}>
              <Box p="md">{previewPane}</Box>
            </Box>
          </Box>
        )}
        <DragOverlay dropAnimation={{ duration: 180 }}>
          {dragging ? (
            <Box className={classes.dragGhost}>
              <Group gap={8} wrap="nowrap">
                {dragging.provider ? <ProviderAvatar provider={dragging.provider} size={24} /> : <IconStack2 size={16} />}
                <Box>
                  <Text fz="xs" fw={700}>
                    {dragging.label}
                  </Text>
                  {dragging.sub && (
                    <Text fz={10} c="dimmed">
                      {dragging.sub}
                    </Text>
                  )}
                </Box>
              </Group>
            </Box>
          ) : null}
        </DragOverlay>
      </DndContext>

      {error && (
        <LlmErrorAlert info={error} title="無法儲存" mx="lg" mb="xs" onClose={() => setError(null)}>
          <EmbeddingIssueFixes
            code={typeof error.params?.issue === "string" ? error.params.issue : error.code}
            params={error.params}
            onPickModel={(m) => swapModel(error.params?.account_id, error.params?.model, m)}
          />
        </LlmErrorAlert>
      )}
      <EmbeddingGuide
        info={guide}
        onSwitched={() => {
          switched.current = true;
        }}
        onClose={() => {
          setGuide(null);
          // The switch created and bound its own profile: this draft is moot.
          if (switched.current) {
            switched.current = false;
            onClose();
          }
        }}
      />
      <Group justify="space-between" px="lg" py="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
        <Text fz="xs" c="dimmed">
          {dirty ? "有未儲存的變更" : "所有變更都已儲存"}
        </Text>
        <Group gap="xs">
          <Button variant="subtle" color="gray" onClick={requestClose}>
            關閉
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || !nameValid || d.members.length === 0}>
            {d.id === null ? "建立 Profile" : "儲存"}
          </Button>
        </Group>
      </Group>
    </Drawer>
  );
}

function PaletteSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Stack gap={6}>
      <Group gap={6}>
        {icon}
        <Text fz="sm" fw={650}>
          {title}
        </Text>
      </Group>
      {children}
    </Stack>
  );
}

function AccountModels({ account, kind, label, onAdd }: { account: ProviderAccount; kind: LlmProfileKind; label: string; onAdd: (model: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [manual, setManual] = useState("");
  const models = useAccountModels(account.id, kind, open);
  const list = (models.data?.models ?? []).filter((m) => !q || m.toLowerCase().includes(q.toLowerCase()));
  return (
    <Accordion.Item value={String(account.id)}>
      <Accordion.Control onClick={() => setOpen(true)} py={6}>
        <Group gap={8} wrap="nowrap">
          <ProviderAvatar provider={account.provider} label={label} size={24} />
          <Box style={{ minWidth: 0 }}>
            <Text fz="xs" fw={650} truncate="end">
              {account.name}
            </Text>
            <Text fz={10} c="dimmed" truncate="end">
              {label}
              {!account.enabled && "（已停用）"}
            </Text>
          </Box>
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack gap={6}>
          {models.isFetching && <Loader size="xs" />}
          {models.data && !models.data.ok && (
            <Text fz="xs" c="dimmed">
              {llmText(models.data)}
            </Text>
          )}
          {(models.data?.models.length ?? 0) > 8 && (
            <TextInput size="xs" leftSection={<IconSearch size={12} />} placeholder="搜尋模型" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
          )}
          <Stack gap={4} mah={260} style={{ overflowY: "auto" }}>
            {list.map((m) => (
              <PaletteModel key={m} account={account} model={m} label={label} onAdd={() => onAdd(m)} />
            ))}
          </Stack>
          <Group gap={4} wrap="nowrap">
            <TextInput size="xs" placeholder="手動輸入模型名稱" value={manual} onChange={(e) => setManual(e.currentTarget.value)} styles={MONO_INPUT} style={{ flex: 1 }} />
            <ActionIcon
              variant="light"
              disabled={!manual.trim()}
              onClick={() => {
                onAdd(manual.trim());
                setManual("");
              }}
              aria-label="加入手動輸入的模型"
            >
              <IconPlus size={14} />
            </ActionIcon>
          </Group>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

/**
 * Palette rows: the row itself is not interactive (no nested controls inside a
 * role=button). Dragging starts from the grip handle (keyboard: focus it and
 * press Space), or — mouse/pen only — anywhere on the row; "+" adds directly.
 */
function PaletteModel({ account, model, label, onAdd }: { account: ProviderAccount; model: string; label: string; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: `pal:${account.id}:${model}`,
    data: { kind: "palette-model", account, model, label: model, sub: `${account.name}・${label}`, provider: account.provider },
  });
  return (
    <Group ref={setNodeRef} gap={6} wrap="nowrap" className={classes.paletteRow} data-dragging={isDragging || undefined} onPointerDown={mouseOnly(listeners?.onPointerDown)}>
      <ActionIcon ref={setActivatorNodeRef} size="xs" variant="transparent" color="gray" className={classes.grip} {...attributes} {...listeners} aria-label={`拖曳 ${model} 到成員`}>
        <IconGripVertical size={12} />
      </ActionIcon>
      <Text fz={11.5} ff="monospace" truncate="end" style={{ flex: 1 }} title={model}>
        {model}
      </Text>
      <ActionIcon size="sm" variant="subtle" onPointerDown={(e) => e.stopPropagation()} onClick={onAdd} aria-label={`加入 ${model}`}>
        <IconPlus size={13} />
      </ActionIcon>
    </Group>
  );
}

function PaletteRoute({ route, added, onAdd }: { route: Route; added: boolean; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: `pal-route:${route.id}`,
    data: { kind: "palette-route", route, label: route.name, sub: `${STRATEGY_META[route.strategy].label}・${route.members.length} 個成員` },
    disabled: added,
  });
  return (
    <Group
      ref={setNodeRef}
      gap={8}
      wrap="nowrap"
      className={classes.paletteRoute}
      data-dragging={isDragging || undefined}
      data-added={added || undefined}
      onPointerDown={added ? undefined : mouseOnly(listeners?.onPointerDown)}
    >
      <ActionIcon ref={setActivatorNodeRef} size="xs" variant="transparent" color="gray" className={classes.grip} disabled={added} {...attributes} {...listeners} aria-label={`拖曳 ${route.name} 到成員`}>
        <IconGripVertical size={12} />
      </ActionIcon>
      <IconStack2 size={16} />
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Text fz="xs" fw={650} truncate="end">
          {route.name}
        </Text>
        <Text fz={10} c="dimmed">
          {added ? "已加入" : `${STRATEGY_META[route.strategy].label}・${route.members.length} 個成員`}
        </Text>
      </Box>
      <ActionIcon size="sm" variant="subtle" onPointerDown={(e) => e.stopPropagation()} onClick={onAdd} disabled={added} aria-label={added ? `${route.name} 已加入` : `加入 ${route.name}`}>
        {added ? <IconCheck size={13} /> : <IconPlus size={13} />}
      </ActionIcon>
    </Group>
  );
}

/** Start a row drag for mouse / pen only; touch must keep scrolling the palette (touch drags use the grip). */
function mouseOnly(handler: unknown) {
  if (typeof handler !== "function") return undefined;
  return (e: ReactPointerEvent) => {
    if (e.pointerType !== "touch") (handler as (ev: ReactPointerEvent) => void)(e);
  };
}

function MembersDrop({ empty, children }: { empty: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "members-drop" });
  return (
    <Box ref={setNodeRef} className={classes.dropZone} data-over={isOver || undefined} data-empty={empty || undefined}>
      {empty ? (
        <Stack align="center" gap={4} py="xl">
          <IconStack2 size={28} opacity={0.5} />
          <Text fz="sm" c="dimmed" ta="center">
            把左側的模型或 Profile 拖到這裡
            <br />
            （或按 + 加入）
          </Text>
        </Stack>
      ) : (
        children
      )}
    </Box>
  );
}

function MemberBlock({
  m,
  index,
  draft,
  accounts,
  routes,
  specs,
  labels,
  onChange,
  onRemove,
  traceState,
}: {
  m: DraftMember;
  index: number;
  draft: Draft;
  accounts: ProviderAccount[];
  routes: Route[];
  specs: ProviderSpec[];
  labels: Record<string, string>;
  onChange: (patch: Partial<DraftMember>) => void;
  onRemove: () => void;
  traceState?: "ok" | "failed";
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: m.key });
  const systemDims = useEmbeddingIdentity().data?.identity?.dimensions ?? null;
  const [open, setOpen] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const acc = m.provider_id !== null ? accounts.find((a) => a.id === m.provider_id) : undefined;
  const spec = acc ? specFor(specs, acc.provider) : undefined;
  const child = m.child_route_id !== null ? routes.find((r) => r.id === m.child_route_id) : undefined;
  const knobs = m.member_type === "model" ? visibleParams(spec, draft.kind, m.model).filter((k) => k.key !== "dimensions") : [];
  const totalW = draft.members.filter((x) => x.enabled).reduce((s, x) => s + Math.max(0, x.weight), 0);
  const share = draft.strategy === "load_balance" && m.enabled && totalW > 0 ? m.weight / totalW : null;
  const setKnob = (key: string, v: KnobValue | "") => {
    const params = { ...m.params };
    if (v === "") delete params[key];
    else params[key] = v;
    onChange({ params });
  };
  const test = useMutation({
    mutationFn: () => api.post<ProbeResult>("/admin/api/llm/models/test", { provider_id: m.provider_id, model: m.model, kind: draft.kind, params: m.params }),
    onMutate: () => setProbe(null),
    onSuccess: setProbe,
    onError: (e) => setProbe({ ok: false, message: llmErrorText(e) }),
  });

  const role =
    draft.strategy === "single"
      ? index === 0
        ? "使用"
        : "不會使用"
      : draft.strategy === "fallback"
        ? index === 0
          ? "主要"
          : `備援 #${index + 1}`
        : draft.strategy === "round_robin"
          ? `輪詢 ${index + 1}`
          : null;

  return (
    <Box
      ref={setNodeRef}
      className={classes.block}
      data-type={m.member_type}
      data-dragging={isDragging || undefined}
      data-disabled={!m.enabled || undefined}
      data-state={traceState}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <Group gap={8} wrap="nowrap" align="center">
        <ActionIcon variant="subtle" color="gray" size="sm" className={classes.grip} {...attributes} {...listeners} aria-label="拖曳排序">
          <IconGripVertical size={14} />
        </ActionIcon>
        {m.member_type === "model" ? (
          <ProviderAvatar provider={acc?.provider ?? "?"} label={acc ? labels[acc.provider] : undefined} size={30} />
        ) : (
          <Box className={classes.blockStack}>
            <IconStack2 size={16} />
          </Box>
        )}
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Text fz="sm" fw={650} truncate="end" ff={m.member_type === "model" ? "monospace" : undefined}>
            {m.member_type === "model" ? m.model : (child?.name ?? "（已刪除的 Profile）")}
          </Text>
          <Text fz={11} c="dimmed" truncate="end">
            {m.member_type === "model"
              ? `${acc?.name ?? "（帳號已刪除）"}・${acc ? labels[acc.provider] : ""}`
              : child
                ? `Profile・${STRATEGY_META[child.strategy].label}・${child.members.length} 個成員`
                : ""}
          </Text>
        </Box>
        {draft.kind === "embedding" && m.member_type === "model" && <FingerprintBadge providerId={m.provider_id} model={m.model} dims={Number(m.params.dimensions ?? 1024)} />}
        {role && (
          <Badge size="sm" variant={index === 0 && draft.strategy !== "round_robin" ? "filled" : "light"} color={draft.strategy === "single" && index > 0 ? "red" : "brand"} tt="none">
            {role}
          </Badge>
        )}
        {share !== null && (
          <Text fz="sm" fw={700} c="brand" className="tabular" w={42} ta="right">
            {Math.round(share * 100)}%
          </Text>
        )}
        <Switch size="xs" checked={m.enabled} onChange={(e) => onChange({ enabled: e.currentTarget.checked })} aria-label="啟用" />
        {m.member_type === "model" && (
          <Tooltip label="參數與測試">
            <ActionIcon variant={open ? "light" : "subtle"} color="gray" size="sm" onClick={() => setOpen((o) => !o)} aria-label="參數">
              <IconAdjustments size={15} />
            </ActionIcon>
          </Tooltip>
        )}
        <ActionIcon variant="subtle" color="red" size="sm" onClick={onRemove} aria-label="移除">
          <IconTrash size={14} />
        </ActionIcon>
      </Group>

      {draft.strategy === "load_balance" && (
        <Group gap="xs" mt={8} pl={38}>
          <Text fz={11} c="dimmed">
            權重
          </Text>
          <NumberInput size="xs" w={90} min={0} max={1000} allowDecimal={false} aria-label={`權重：${m.member_type === "model" ? m.model : (child?.name ?? "")}`} value={m.weight} onChange={(v) => onChange({ weight: v === "" ? 0 : Number(v) })} />
          {m.weight === 0 && (
            <Text fz={11} c="dimmed">
              0 = 只當備援
            </Text>
          )}
        </Group>
      )}

      {m.member_type === "route" && child && (
        <Group gap={4} mt={6} pl={38} wrap="wrap">
          {child.members.slice(0, 6).map((cm) => {
            const ca = cm.provider_id !== null ? accounts.find((a) => a.id === cm.provider_id) : undefined;
            return (
              <Badge key={cm.id} size="xs" variant="outline" color="gray" tt="none" ff={cm.member_type === "model" ? "monospace" : undefined}>
                {cm.member_type === "model" ? `${cm.model}${ca ? `@${ca.name}` : ""}` : `▣ ${routes.find((r) => r.id === cm.child_route_id)?.name ?? "?"}`}
              </Badge>
            );
          })}
          {child.members.length > 6 && <Badge size="xs" variant="outline" color="gray">+{child.members.length - 6}</Badge>}
        </Group>
      )}

      {m.member_type === "model" && (
        <Collapse in={open}>
          <Stack gap="sm" mt="sm" pl={38}>
            {draft.kind === "embedding" && (
              <NumberInput
                size="xs"
                label="向量維度"
                description={`必須等於系統 Embedding 指紋的維度（目前 ${systemDims ?? "未建立"}），且整個 Profile 一致。`}
                min={1}
                max={16384}
                allowDecimal={false}
                value={Number(m.params.dimensions ?? 1024)}
                onChange={(v) => onChange({ params: { ...m.params, dimensions: v === "" ? 1024 : Number(v) } })}
              />
            )}
            {draft.kind === "embedding" && <QueryInstructionField model={m.model} value={m.params.query_instruction} onChange={(v) => setKnob("query_instruction", v)} />}
            {draft.kind === "analysis" && (
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                <NumberInput size="xs" label="起始輸出 token" description="不夠時自動加倍。" min={1} allowDecimal={false} thousandSeparator="," placeholder="16,384" value={(m.params.max_tokens as number | undefined) ?? ""} onChange={(v) => setKnob("max_tokens", v === "" ? "" : Number(v))} />
                <NumberInput size="xs" label="單次逾時（秒）" min={1} allowDecimal={false} placeholder="600" value={typeof m.params.timeout_ms === "number" ? Math.round(m.params.timeout_ms / 1000) : ""} onChange={(v) => setKnob("timeout_ms", v === "" ? "" : Number(v) * 1000)} />
              </SimpleGrid>
            )}
            {knobs.length > 0 && (
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                {knobs.map((k) => (
                  <KnobField key={k.key} spec={k} value={m.params[k.key]} onChange={(v) => setKnob(k.key, v)} />
                ))}
              </SimpleGrid>
            )}
            <Group gap="xs">
              <Button size="compact-xs" variant="light" leftSection={<IconPlayerPlay size={12} />} onClick={() => test.mutate()} loading={test.isPending}>
                測試這個模型
              </Button>
              {test.isPending && (
                <Text fz={11} c="dimmed">
                  最多等 3 分鐘…
                </Text>
              )}
            </Group>
            {probe &&
              (draft.kind === "analysis" ? (
                <AnalysisProbe result={probe} numCtx={typeof m.params.num_ctx === "number" ? m.params.num_ctx : ""} canFixContext={Boolean(spec?.params.some((p) => p.key === "num_ctx"))} canFixThinking={Boolean(spec?.thinkingOff)} onFix={(fix) => (fix.kind === "num_ctx" ? setKnob("num_ctx", fix.value) : spec?.thinkingOff && setKnob(spec.thinkingOff.key, spec.thinkingOff.value))} onClose={() => setProbe(null)} />
              ) : (
                <Alert color={probe.ok ? "teal" : "red"} p="xs" withCloseButton onClose={() => setProbe(null)}>
                  <Text fz="xs">{llmText(probe)}</Text>
                  {!probe.ok && (
                    <EmbeddingIssueFixes
                      code={probe.code}
                      params={probe.params}
                      onPickModel={(model) => {
                        onChange({ model });
                        setProbe(null);
                      }}
                      onSetDims={(dims) => {
                        const { send_dimensions: _drop, ...rest } = m.params;
                        onChange({ params: { ...rest, dimensions: dims } });
                        setProbe(null);
                      }}
                      onSendDims={(on) => {
                        onChange({ params: { ...m.params, send_dimensions: on } });
                        setProbe(null);
                      }}
                    />
                  )}
                </Alert>
              ))}
          </Stack>
        </Collapse>
      )}
    </Box>
  );
}

/** Does this embedding model reproduce the system's vectors? (cached server verdict) */
function FingerprintBadge({ providerId, model, dims }: { providerId: number | null; model: string; dims: number }) {
  const q = useFingerprint(providerId, model, dims);
  if (q.isFetching) {
    return (
      <Badge size="sm" variant="light" color="gray" tt="none" leftSection={<Loader size={8} />}>
        比對中
      </Badge>
    );
  }
  if (q.isError) {
    return (
      <Tooltip label={llmErrorText(q.error)} multiline maw={260}>
        <Badge size="sm" variant="light" color="gray" tt="none">
          無法比對
        </Badge>
      </Tooltip>
    );
  }
  const r = q.data;
  if (!r) return null;
  if (r.incompatible) {
    return (
      <Tooltip label={llmText(r)} multiline maw={280}>
        <Badge size="sm" variant="light" color="red" tt="none" leftSection={<IconX size={10} />}>
          {r.code === "embedding_model_not_found" ? "伺服器無此模型" : r.code === "embedding_dims_unsupported" ? "維度不符" : "不支援 Embedding"}
        </Badge>
      </Tooltip>
    );
  }
  if (r.unreachable) {
    return (
      <Tooltip label={llmText(r, "端點沒有回應，無法比對指紋。")} multiline maw={280}>
        <Badge size="sm" variant="light" color="gray" tt="none" leftSection={<IconPlugOff size={10} />}>
          連不上
        </Badge>
      </Tooltip>
    );
  }
  if (r.anchor_missing) {
    return (
      <Tooltip label="系統尚未建立 Embedding 指紋；儲存後會以實際產生向量的模型建立。">
        <Badge size="sm" variant="light" color="blue" tt="none">
          待建立指紋
        </Badge>
      </Tooltip>
    );
  }
  return (
    <Tooltip
      label={r.ok ? `與系統是同一個模型（相似度 ${r.min_similarity?.toFixed(4)}）` : `${llmText(r)} 儲存會被拒絕。`}
      multiline
      maw={280}
    >
      <Badge size="sm" variant="light" color={r.ok ? "teal" : "red"} tt="none" leftSection={r.ok ? <IconCheck size={10} /> : <IconX size={10} />}>
        {r.ok ? "指紋一致" : r.code === "embedding_dims_mismatch" || r.code === "embedding_dims_returned" ? "維度不符" : "不同模型"}
      </Badge>
    </Tooltip>
  );
}

/** Models that take a query-side task instruction by default (node-server providers/queryInstruction.ts). */
const INSTRUCTED_MODEL_RE = [/qwen3[-_ .:/]?embedding/i, /gte[-_]?qwen2.*instruct/i];

/**
 * Query instruction knob of an embedding member: only search queries are prefixed
 * ("Instruct: <task>\nQuery: <text>"); stored vectors never are, so changing it needs no re-index.
 */
function QueryInstructionField({ model, value, onChange }: { model: string; value: unknown; onChange: (v: string) => void }) {
  const raw = typeof value === "string" ? value.trim() : "";
  const mode = !raw || raw.toLowerCase() === "auto" ? "auto" : raw.toLowerCase() === "off" ? "off" : "custom";
  const [custom, setCustom] = useState(mode === "custom" ? raw : "");
  const auto = INSTRUCTED_MODEL_RE.some((re) => re.test(model));
  return (
    <Stack gap={6}>
      <Select
        size="xs"
        label="查詢指令（query instruction）"
        description={
          auto
            ? "此模型（Qwen3-Embedding 系列）建議在搜尋查詢前加上任務指令；只影響查詢，已存的向量不變，不需重建索引。"
            : "此模型預設不加指令。自訂指令只在模型支援時有用；只影響查詢，不需重建索引。"
        }
        allowDeselect={false}
        data={[
          { value: "auto", label: auto ? "自動（依模組加上任務指令）" : "自動（此模型不加指令）" },
          { value: "off", label: "關閉" },
          { value: "custom", label: "自訂" },
        ]}
        value={mode}
        onChange={(v) => {
          if (v !== "custom") return onChange(v === "off" ? "off" : "");
          const text = custom || "Given a medical search query, retrieve the matching terminology entry";
          setCustom(text);
          onChange(text);
        }}
      />
      {mode === "custom" && (
        <Textarea
          size="xs"
          autosize
          minRows={2}
          label="自訂任務描述（所有模組共用）"
          value={custom}
          onChange={(e) => setCustom(e.currentTarget.value)}
          onBlur={() => onChange(custom.trim() || "")}
        />
      )}
    </Stack>
  );
}

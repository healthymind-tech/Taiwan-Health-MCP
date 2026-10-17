import { Badge, Box, Group, Stack, Text, ThemeIcon, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconCircleDashed, IconCircleX, IconStarFilled } from "@tabler/icons-react";
import { HealthBadge, probeHealth } from "@/components/StatusBadge";
import { RelativeTime } from "@/components/RelativeTime";
import { fmtDateTime } from "@/lib/format";
import type { FhirOperation, FhirServer } from "@/lib/types";
import { ALL_OPS, AUTH_PROFILE_LABEL, AUTH_TYPE_LABEL, envMeta, isWriteOp, OAUTH_STATUS_META, STEP_LABEL, type WorkflowStep } from "./fhirModel";

export function EnvBadge({ env }: { env: string | null | undefined }) {
  const m = envMeta(env);
  if (!m) return <Text fz="xs" c="dimmed">未標示</Text>;
  return (
    <Badge color={m.color} variant="light" size="sm">
      {m.label}
    </Badge>
  );
}

export function DefaultBadge() {
  return (
    <Tooltip label="MCP 工具未指定 server_key 時使用此伺服器">
      <Badge color="amber" variant="light" size="sm" leftSection={<IconStarFilled size={10} />}>
        預設
      </Badge>
    </Tooltip>
  );
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <HealthBadge state="ok" label="啟用" />
  ) : (
    <HealthBadge state="idle" label="停用" tooltip="已停用：MCP 工具無法看到或使用此伺服器" />
  );
}

/** Operation badges; write operations amber so they stand out. */
export function OperationBadges({ ops, compact }: { ops: FhirOperation[]; compact?: boolean }) {
  const ordered = ALL_OPS.filter((o) => ops.includes(o));
  if (ordered.length === 0) return <Text fz="xs" c="dimmed">—</Text>;
  return (
    <Group gap={4} wrap="wrap" justify={compact ? "flex-end" : undefined}>
      {ordered.map((op) => (
        <Badge
          key={op}
          size="xs"
          radius="sm"
          variant={isWriteOp(op) ? "filled" : "light"}
          color={isWriteOp(op) ? "amber" : "gray"}
          leftSection={isWriteOp(op) ? <IconAlertTriangle size={10} /> : undefined}
        >
          {op}
        </Badge>
      ))}
    </Group>
  );
}

export function hasWriteOps(s: Pick<FhirServer, "allowed_operations">): boolean {
  return (s.allowed_operations ?? []).some((o) => isWriteOp(o));
}

export function OAuthBadge({ server }: { server: FhirServer }) {
  if (server.auth_type === "none") return null;
  const st = server.oauth_status?.status ?? "not_authorized";
  const m = OAUTH_STATUS_META[st] ?? { label: st, state: "unknown" as const };
  const exp = server.oauth_status?.access_expires_at;
  return <HealthBadge state={m.state} label={m.label} size="xs" tooltip={exp ? `存取權杖到期：${fmtDateTime(exp, true)}` : undefined} />;
}

export function AuthSummary({ server }: { server: FhirServer }) {
  if (server.auth_type === "none") {
    return (
      <Text fz="sm" c="dimmed">
        無認證
      </Text>
    );
  }
  return (
    <Stack gap={4} align="flex-start">
      <Text fz="sm">{server.auth_type === "oauth2_client_credentials" ? "Client Credentials" : "Authorization Code"}</Text>
      <Group gap={4} wrap="wrap">
        {server.auth_profile !== "none" && (
          <Badge size="xs" variant="outline" color="gray">
            {AUTH_PROFILE_LABEL[server.auth_profile] ?? server.auth_profile}
          </Badge>
        )}
        <OAuthBadge server={server} />
      </Group>
    </Stack>
  );
}

export function authTypeText(server: FhirServer): string {
  const base = AUTH_TYPE_LABEL[server.auth_type] ?? server.auth_type;
  return server.auth_profile && server.auth_profile !== "none" ? `${base} · ${AUTH_PROFILE_LABEL[server.auth_profile]}` : base;
}

const PROBE_LABEL: Record<string, string> = { ok: "連線正常", error: "連線失敗" };

export function ProbeStatus({ server, withTime = true }: { server: FhirServer; withTime?: boolean }) {
  const st = server.last_probe_status;
  if (!st) {
    return <HealthBadge state="unknown" label="尚未探測" size="xs" />;
  }
  const health = probeHealth(st);
  return (
    <Stack gap={2} align="flex-start" style={{ minWidth: 0 }}>
      <HealthBadge
        state={health}
        label={PROBE_LABEL[st] ?? st}
        size="xs"
        tooltip={server.last_probe_error ? <Box maw={360} style={{ whiteSpace: "normal" }}>{server.last_probe_error}</Box> : undefined}
      />
      {withTime && <RelativeTime value={server.last_probe_at} fz="xs" c="dimmed" />}
    </Stack>
  );
}

function stepIcon(status: string) {
  if (status === "ok") return { icon: <IconCircleCheck size={18} />, color: "teal" };
  if (status === "error") return { icon: <IconCircleX size={18} />, color: "red" };
  return { icon: <IconCircleDashed size={18} />, color: "gray" };
}

/** Render the connection workflow (metadata → token → FHIR) step by step. */
export function WorkflowSteps({ steps }: { steps: WorkflowStep[] }) {
  if (steps.length === 0) return <Text fz="sm" c="dimmed">沒有步驟紀錄</Text>;
  return (
    <Stack gap="xs">
      {steps.map((s, i) => {
        const ic = stepIcon(s.status);
        const d = s.details ?? {};
        const explanation = typeof d.explanation === "string" ? d.explanation : null;
        const detailPairs = Object.entries(d).filter(([k, v]) => k !== "explanation" && v !== null && v !== undefined && v !== "");
        return (
          <Group key={`${s.name}-${i}`} gap="sm" wrap="nowrap" align="flex-start">
            <ThemeIcon variant="light" color={ic.color} radius="xl" size={30}>
              {ic.icon}
            </ThemeIcon>
            <Box style={{ minWidth: 0, flex: 1 }}>
              <Group gap="xs" wrap="wrap">
                <Text fw={600} fz="sm">
                  {i + 1}. {STEP_LABEL[s.name] ?? s.name}
                </Text>
                <Badge size="xs" variant="light" color={ic.color}>
                  {s.status === "ok" ? "成功" : s.status === "error" ? "失敗" : "略過"}
                </Badge>
                {typeof s.duration_ms === "number" && (
                  <Text fz="xs" c="dimmed">
                    {s.duration_ms} ms
                  </Text>
                )}
              </Group>
              {s.message && (
                <Text fz="sm" c={s.status === "error" ? "red" : "dimmed"} style={{ wordBreak: "break-word" }}>
                  {s.message}
                </Text>
              )}
              {explanation && (
                <Text fz="xs" c="amber" mt={2}>
                  {explanation}
                </Text>
              )}
              {detailPairs.length > 0 && (
                <Group gap={6} mt={4} wrap="wrap">
                  {detailPairs.map(([k, v]) => (
                    <Badge key={k} size="xs" variant="default" radius="sm" style={{ textTransform: "none", maxWidth: "100%" }}>
                      <Text span fz={10} truncate="end">
                        {k}: {typeof v === "object" ? JSON.stringify(v) : String(v)}
                      </Text>
                    </Badge>
                  ))}
                </Group>
              )}
            </Box>
          </Group>
        );
      })}
    </Stack>
  );
}

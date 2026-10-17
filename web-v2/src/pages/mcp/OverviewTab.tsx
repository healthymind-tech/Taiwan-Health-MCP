import { Alert, Badge, Box, Button, CopyButton, Group, List, SegmentedControl, SimpleGrid, Spoiler, Stack, Table, Text, ThemeIcon, Tooltip } from "@mantine/core";
import {
  IconApi,
  IconCheck,
  IconCopy,
  IconInfoCircle,
  IconKey,
  IconLock,
  IconLockOpen,
  IconPlugConnected,
  IconServer2,
  IconTool,
  IconWorld,
} from "@tabler/icons-react";
import { useState } from "react";
import { CopyText } from "@/components/CopyText";
import { QueryBoundary } from "@/components/QueryBoundary";
import { SectionCard } from "@/components/SectionCard";
import { StatCard } from "@/components/StatCard";
import { fmtNumber } from "@/lib/format";
import { useMcpCatalog, useMcpOverview } from "./mcpApi";
import classes from "./mcp.module.css";
import type { OverviewEndpoint, OverviewPayload } from "./mcpTypes";

const ENDPOINT_META: Record<OverviewEndpoint["key"], { label: string; description: string }> = {
  mcp: { label: "MCP（streamable-http）", description: "LLM 用戶端（Claude Desktop、Claude Code、Cursor …）連線的主要端點。" },
  openapi: { label: "OpenAPI 規格", description: "目前已啟用工具的 OpenAPI 3.1 文件，給 Open WebUI 等 OpenAPI 工具用戶端。" },
  tools: { label: "工具 REST 呼叫", description: "以 JSON body 直接呼叫單一工具，驗證與 MCP 相同。" },
  jwks: { label: "FHIR 用戶端 JWKS", description: "private_key_jwt 驗證用的公開金鑰（每個外部 FHIR 伺服器一組）。" },
  oauth_callback: { label: "FHIR OAuth 回呼", description: "外部 FHIR 伺服器 OAuth2 授權碼流程的 redirect URI。" },
};

function AuthBadge({ auth }: { auth: OverviewEndpoint["auth"] }) {
  if (auth === "bearer")
    return (
      <Badge color="indigo" leftSection={<IconLock size={12} />} size="sm">
        Bearer
      </Badge>
    );
  if (auth === "capability")
    return (
      <Tooltip label="不需登入；URL 中的 id / 一次性 state 即是存取憑證">
        <Badge color="gray" leftSection={<IconKey size={12} />} size="sm">
          憑證 URL
        </Badge>
      </Tooltip>
    );
  return (
    <Badge color="amber" leftSection={<IconLockOpen size={12} />} size="sm">
      公開
    </Badge>
  );
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <Box pos="relative">
      <pre className={`${classes.code} ${classes.codeWithCopy}`} aria-label={label}>
        {code}
      </pre>
      <CopyButton value={code} timeout={1500}>
        {({ copied, copy }) => (
          <Button
            size="compact-xs"
            variant={copied ? "filled" : "default"}
            color={copied ? "teal" : undefined}
            leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
            onClick={copy}
            pos="absolute"
            top={8}
            right={8}
          >
            {copied ? "已複製" : "複製"}
          </Button>
        )}
      </CopyButton>
    </Box>
  );
}

type Client = "claude-code" | "claude-desktop" | "openwebui" | "curl";

function clientSnippet(client: Client, o: OverviewPayload): { code: string; note: string } {
  const bearer = o.auth.mode === "bearer";
  const url = o.mcp.url;
  switch (client) {
    case "claude-code":
      return {
        code: bearer
          ? `claude mcp add --transport http taiwan-health ${url} \\\n  --header "Authorization: Bearer $TWH_MCP_TOKEN"`
          : `claude mcp add --transport http taiwan-health ${url}`,
        note: "在終端機執行；加 --scope user 讓所有專案都能用。",
      };
    case "claude-desktop": {
      const args = ["-y", "mcp-remote", url, ...(bearer ? ["--header", "Authorization: Bearer ${TWH_MCP_TOKEN}"] : [])];
      const cfg: Record<string, unknown> = { command: "npx", args };
      if (bearer) cfg.env = { TWH_MCP_TOKEN: "<在此貼上 token>" };
      return {
        code: JSON.stringify({ mcpServers: { "taiwan-health": cfg } }, null, 2),
        note: "貼到 claude_desktop_config.json（設定 → 開發者 → 編輯設定），重新啟動 Claude Desktop。透過 mcp-remote 連線 streamable-http 端點。",
      };
    }
    case "openwebui":
      return {
        code: [`URL:      ${o.base_url}`, `OpenAPI:  ${o.base_url}/openapi.json`, `驗證:     ${bearer ? "Bearer（貼上 token）" : "無"}`].join("\n"),
        note: "Open WebUI → 設定 → 工具 → 新增連線（OpenAPI）。工具清單直接取自 /openapi.json，不需 mcpo。",
      };
    case "curl":
    default: {
      const auth = bearer ? ` \\\n  -H "Authorization: Bearer $TWH_MCP_TOKEN"` : "";
      return {
        code: [
          `# 列出已啟用的工具`,
          `curl -sS ${o.base_url}/openapi.json${auth} | jq '.paths | keys'`,
          ``,
          `# 呼叫一個工具`,
          `curl -sS -X POST ${o.base_url}/tools/search_medical_codes${auth} \\\n  -H 'Content-Type: application/json' \\\n  -d '{"keyword":"第二型糖尿病","type":"diagnosis"}'`,
        ].join("\n"),
        note: "測試台的每次執行都能「複製為 curl」。",
      };
    }
  }
}

function ClientConfig({ o }: { o: OverviewPayload }) {
  const [client, setClient] = useState<Client>("claude-code");
  const snip = clientSnippet(client, o);
  return (
    <SectionCard title="用戶端設定" description="複製即可使用的連線設定。" icon={<IconPlugConnected size={18} />}>
      <Stack gap="sm">
        <SegmentedControl
          value={client}
          onChange={(v) => setClient(v as Client)}
          data={[
            { value: "claude-code", label: "Claude Code" },
            { value: "claude-desktop", label: "Claude Desktop" },
            { value: "openwebui", label: "Open WebUI" },
            { value: "curl", label: "curl" },
          ]}
          fullWidth
          size="xs"
          styles={{ label: { whiteSpace: "nowrap" } }}
        />
        <CodeBlock code={snip.code} label={`${client} 設定`} />
        <Text fz="xs" c="dimmed">
          {snip.note}
          {o.auth.mode === "bearer" && " 指令中的 $TWH_MCP_TOKEN 請換成實際 token（本頁不顯示 token 值）。"}
        </Text>
      </Stack>
    </SectionCard>
  );
}

function Endpoints({ o }: { o: OverviewPayload }) {
  return (
    <SectionCard title="公開端點" description={`對外網址：${o.base_url}`} icon={<IconWorld size={18} />} flush>
      <Box>
        {o.endpoints.map((e) => (
          <Box key={e.key} className={classes.endpointRow} px="lg" py="md">
            <Group justify="space-between" align="flex-start" gap="xs" wrap="wrap">
              <Box style={{ minWidth: 0, flex: "1 1 280px" }}>
                <Group gap={6} wrap="wrap">
                  <Text fw={650} fz="sm">
                    {ENDPOINT_META[e.key].label}
                  </Text>
                  {e.methods.map((m) => (
                    <Badge key={m} size="xs" variant="outline" color="gray" ff="monospace">
                      {m}
                    </Badge>
                  ))}
                  <AuthBadge auth={e.auth} />
                </Group>
                <Text fz="xs" c="dimmed" mt={2}>
                  {ENDPOINT_META[e.key].description}
                </Text>
              </Box>
            </Group>
            <Box mt={6}>
              <CopyText value={e.url} mono />
            </Box>
          </Box>
        ))}
      </Box>
    </SectionCard>
  );
}

function Access({ o }: { o: OverviewPayload }) {
  const bearer = o.auth.mode === "bearer";
  return (
    <SectionCard title="存取控制" description="/mcp、/openapi.json、/tools/* 共用同一組設定。" icon={bearer ? <IconLock size={18} /> : <IconLockOpen size={18} />}>
      <Stack gap="sm">
        <Group justify="space-between" gap="xs">
          <Text fz="sm" c="dimmed">
            驗證模式
          </Text>
          {bearer ? (
            <Badge color="indigo" leftSection={<IconLock size={12} />}>
              Bearer token
            </Badge>
          ) : (
            <Badge color="amber" leftSection={<IconLockOpen size={12} />}>
              公開（不需驗證）
            </Badge>
          )}
        </Group>
        <Group justify="space-between" gap="xs">
          <Text fz="sm" c="dimmed">
            Token
          </Text>
          {bearer ? (
            <Badge color={o.auth.bearer_configured ? "teal" : "red"}>{o.auth.bearer_configured ? "已設定" : "未設定"}</Badge>
          ) : (
            <Text fz="sm" c="dimmed">
              未使用
            </Text>
          )}
        </Group>
        <Group justify="space-between" gap="xs" align="flex-start" wrap="nowrap">
          <Text fz="sm" c="dimmed" style={{ flexShrink: 0 }}>
            CORS 來源
          </Text>
          <Group gap={4} justify="flex-end">
            {o.auth.cors_origins.length === 0 ? (
              <Text fz="sm" c="dimmed">
                僅同源
              </Text>
            ) : (
              o.auth.cors_origins.map((c) => (
                <Badge key={c} variant="outline" color="gray" ff="monospace" tt="none">
                  {c === "*" ? "*（任何來源）" : c}
                </Badge>
              ))
            )}
          </Group>
        </Group>
        <Alert icon={<IconInfoCircle size={18} />} color={bearer ? "blue" : "amber"} p="sm" mt={4}>
          <Text fz="xs" fw={600} mb={4}>
            {bearer ? "輪替 token" : "啟用 Bearer 驗證"}
          </Text>
          <List size="xs" spacing={2}>
            <List.Item>
              編輯 <code>.env</code>：{bearer ? <code>{o.auth.env.token}=&lt;新 token&gt;</code> : <><code>{o.auth.env.mode}=bearer</code>、<code>{o.auth.env.token}=&lt;隨機字串&gt;</code></>}
              （例如 <code>openssl rand -hex 32</code>）。
            </List.Item>
            <List.Item>
              {bearer ? "" : <><code>{o.auth.env.cors}</code> 不可包含 <code>*</code>。</>}重新部署 app：<code>docker compose up -d --no-deps app</code>。
            </List.Item>
            <List.Item>更新各用戶端設定中的 token；舊 token 立即失效。</List.Item>
          </List>
        </Alert>
      </Stack>
    </SectionCard>
  );
}

function ServerInfo({ o }: { o: OverviewPayload }) {
  const pinned = Object.entries(o.server.tools_version).sort(([a], [b]) => a.localeCompare(b));
  return (
    <SectionCard title="伺服器版本" icon={<IconServer2 size={18} />}>
      <Stack gap="sm">
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
          {[
            ["名稱", o.server.name],
            ["版本", o.server.version],
            ["Build", o.server.build],
            ["Lexicon", o.server.lexicon_version],
          ].map(([k, v]) => (
            <Box key={k}>
              <Text fz="xs" c="dimmed">
                {k}
              </Text>
              <Text fz="sm" ff="monospace" fw={600} style={{ wordBreak: "break-all" }}>
                {v}
              </Text>
            </Box>
          ))}
        </SimpleGrid>
        <Text fz="xs" c="dimmed" mt={4}>
          固定版本的工具（輸出改變時才升版，其餘跟隨伺服器版本）
        </Text>
        <Spoiler maxHeight={110} showLabel="顯示全部" hideLabel="收合" fz="xs">
          <Table fz="xs" withRowBorders={false} verticalSpacing={2} horizontalSpacing="xs">
            <Table.Tbody>
              {pinned.map(([name, v]) => (
                <Table.Tr key={name}>
                  <Table.Td ff="monospace">{name}</Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {v}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Spoiler>
      </Stack>
    </SectionCard>
  );
}

function JwksServers({ o }: { o: OverviewPayload }) {
  if (o.fhir_servers.length === 0) return null;
  return (
    <SectionCard title="外部 FHIR 伺服器的公開端點" description="private_key_jwt 伺服器需在授權伺服器登錄此 JWKS URL；OAuth 授權碼流程需登錄回呼 URL。" icon={<IconKey size={18} />}>
      <Stack gap="sm">
        {o.fhir_servers.map((s) => (
          <Box key={s.id}>
            <Group gap={6}>
              <Text fz="sm" fw={600} ff="monospace">
                {s.server_key}
              </Text>
              <Badge size="xs" color={s.uses_jwks ? "indigo" : "gray"} tt="none">
                {s.token_auth_method ?? "無 token 驗證"}
              </Badge>
            </Group>
            <CopyText value={s.jwks_url} mono truncate />
          </Box>
        ))}
      </Stack>
    </SectionCard>
  );
}

export function OverviewTab({ onOpenCatalog }: { onOpenCatalog: (status?: "enabled" | "disabled") => void }) {
  const overviewQ = useMcpOverview();
  const catalogQ = useMcpCatalog();
  const totals = catalogQ.data?.totals;
  return (
    <QueryBoundary query={overviewQ}>
      {(o) => (
        <Stack gap="lg">
          <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
            <StatCard label="工具總數" value={fmtNumber(totals?.total ?? o.tools.total)} icon={<IconTool size={20} />} hint="mcp.ts 定義的所有工具" onClick={() => onOpenCatalog()} ariaLabel="查看全部工具" />
            <StatCard
              label="已啟用"
              value={fmtNumber(totals?.enabled ?? o.tools.enabled)}
              color="teal"
              icon={<IconCheck size={20} />}
              hint="目前 MCP / OpenAPI 提供中"
              progress={totals ? (totals.enabled / Math.max(1, totals.total)) * 100 : undefined}
              onClick={() => onOpenCatalog("enabled")}
              ariaLabel="查看已啟用工具"
            />
            <StatCard
              label="未啟用"
              value={fmtNumber(totals?.disabled ?? o.tools.total - o.tools.enabled)}
              color={totals && totals.disabled > 0 ? "amber" : "gray"}
              icon={<IconApi size={20} />}
              hint="模組資料不足或服務未啟動"
              onClick={() => onOpenCatalog("disabled")}
              ariaLabel="查看未啟用工具"
            />
            <StatCard
              label="驗證"
              value={o.auth.mode === "bearer" ? "Bearer" : "公開"}
              color={o.auth.mode === "bearer" ? "indigo" : "amber"}
              icon={o.auth.mode === "bearer" ? <IconLock size={20} /> : <IconLockOpen size={20} />}
              hint={o.auth.mode === "bearer" ? "需要 token" : "任何人可呼叫"}
            />
          </SimpleGrid>
          <Box
            style={{
              display: "grid",
              gap: "var(--mantine-spacing-lg)",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))",
              alignItems: "start",
            }}
          >
            <Stack gap="lg">
              <Endpoints o={o} />
              <JwksServers o={o} />
            </Stack>
            <Stack gap="lg">
              <ClientConfig o={o} />
              <Access o={o} />
              <ServerInfo o={o} />
            </Stack>
          </Box>
          <Group gap="xs">
            <ThemeIcon variant="light" color="gray" size="sm">
              <IconInfoCircle size={14} />
            </ThemeIcon>
            <Text fz="xs" c="dimmed">
              對外網址取自 PUBLIC_BASE_URL；未設定時以目前瀏覽的網址推算。
            </Text>
          </Group>
        </Stack>
      )}
    </QueryBoundary>
  );
}

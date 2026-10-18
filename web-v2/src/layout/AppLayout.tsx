import {
  ActionIcon,
  AppShell,
  Avatar,
  Badge,
  Box,
  Burger,
  Group,
  Kbd,
  Menu,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure, useHotkeys } from "@mantine/hooks";
import { Spotlight, spotlight, type SpotlightActionData } from "@mantine/spotlight";
import {
  IconChevronDown,
  IconLock,
  IconLogout,
  IconSearch,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useJobs } from "@/lib/jobs";
import { ACTIVE_STATUSES } from "@/lib/meta";
import type { ModulesPayload } from "@/lib/types";
import { adminWs } from "@/lib/ws";
import { Dot } from "@/components/StatusBadge";
import { ThemeMenu } from "@/components/ThemeMenu";
import { switchColorScheme } from "@/lib/themeTransition";
import { DbHealthGate } from "./DbHealthGate";
import { WorkerOfflineBanner } from "./WorkerOfflineBanner";
import { ALL_NAV_ITEMS, EXTRA_SEARCH, NAV, type NavItem } from "./nav";
import classes from "./AppLayout.module.css";

function useWsConnected(): boolean {
  const [c, setC] = useState(adminWs.isConnected());
  useEffect(() => adminWs.onStatus(setC), []);
  return c;
}

export function useModulesCatalog() {
  return useQuery({
    queryKey: qk.modules,
    queryFn: () => api.get<ModulesPayload>("/admin/api/modules"),
    staleTime: 15_000,
  });
}

function isActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

function Brand({ compact }: { compact?: boolean }) {
  return (
    <Group gap={10} wrap="nowrap">
      <Box className={classes.logo}>
        <svg viewBox="0 0 64 64" width="20" height="20" aria-hidden>
          <path d="M27 14h10v13h13v10H37v13H27V37H14V27h13z" fill="currentColor" />
        </svg>
      </Box>
      <Box style={{ lineHeight: 1.15, whiteSpace: "nowrap" }}>
        <Text fw={700} fz="sm">
          {compact ? "TW Health" : "Taiwan Health MCP"}
        </Text>
        {!compact && (
          <Text fz={11} c="dimmed">
            管理控制台
          </Text>
        )}
      </Box>
    </Group>
  );
}

export function AppLayout() {
  const [opened, { toggle, close }] = useDisclosure(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme("light");
  const wsConnected = useWsConnected();
  const modulesQ = useModulesCatalog();
  const jobsQ = useJobs();
  const me = useQuery({ queryKey: qk.me, queryFn: () => api.get<{ username: string }>("/admin/api/me"), staleTime: Infinity, retry: false });

  useEffect(() => close(), [location.pathname, close]);
  useHotkeys([["mod+J", () => switchColorScheme(setColorScheme, scheme === "dark" ? "light" : "dark")]]);

  const activeJobs = (jobsQ.data?.jobs ?? []).filter((j) => ACTIVE_STATUSES.has(j.status));
  const runningJobs = activeJobs.filter((j) => j.status === "running").length;

  const moduleDot = (key: string): { color: string; label: string } => {
    const counts = modulesQ.data?.record_counts ?? {};
    const maint = modulesQ.data?.maintenance ?? {};
    if (maint[key]) return { color: "amber", label: "維護模式" };
    if ((counts[key] ?? 0) > 0) return { color: "teal", label: "已載入資料" };
    return { color: "gray", label: "尚未匯入" };
  };

  const groupDot = (keys: string[]): { color: string; label: string } => {
    const dots = keys.map(moduleDot);
    const loaded = dots.filter((d) => d.color === "teal").length;
    if (dots.some((d) => d.color === "amber")) return { color: "amber", label: "有術語維護中" };
    if (loaded > 0) return { color: "teal", label: `已載入 ${loaded} / ${keys.length} 個術語` };
    return { color: "gray", label: "尚未匯入任何術語" };
  };

  const signOut = async () => {
    await api.post("/admin/api/logout").catch(() => undefined);
    window.location.href = "/admin/login";
  };

  const spotlightActions: SpotlightActionData[] = useMemo(
    () =>
      [...ALL_NAV_ITEMS, ...EXTRA_SEARCH].map((item: NavItem) => ({
        id: item.to,
        label: item.label,
        description: item.description,
        keywords: item.keywords,
        leftSection: <item.icon size={18} stroke={1.6} />,
        onClick: () => navigate(item.to),
      })),
    [navigate],
  );

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 256, breakpoint: "md", collapsed: { mobile: !opened } }}
      layout="alt"
      padding={0}
    >
      <AppShell.Header className={classes.header}>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap" gap="sm">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="md" size="sm" aria-label="切換選單" />
            <Box hiddenFrom="md">
              <Brand compact />
            </Box>
            <UnstyledButton className={classes.search} onClick={() => spotlight.open()} visibleFrom="sm" aria-label="搜尋">
              <Group gap={8} wrap="nowrap">
                <IconSearch size={15} />
                <Text fz="sm" c="dimmed" style={{ flex: 1 }}>
                  搜尋頁面…
                </Text>
                <Kbd size="xs">Ctrl K</Kbd>
              </Group>
            </UnstyledButton>
          </Group>
          <Group gap={6} wrap="nowrap">
            <ActionIcon hiddenFrom="sm" size="lg" onClick={() => spotlight.open()} aria-label="搜尋">
              <IconSearch size={18} />
            </ActionIcon>
            {activeJobs.length > 0 && (
              <Tooltip label={`${runningJobs} 個執行中，${activeJobs.length - runningJobs} 個排隊或暫停`}>
                <Badge
                  component={Link}
                  to={runningJobs > 0 ? "/jobs?status=running" : "/jobs?status=queued"}
                  variant="light"
                  color="blue"
                  size="lg"
                  leftSection={<Dot color="blue" live={runningJobs > 0} size={7} />}
                  style={{ cursor: "pointer" }}
                  visibleFrom="xs"
                >
                  {runningJobs > 0
                    ? `${runningJobs} 個執行中${activeJobs.length - runningJobs > 0 ? `・${activeJobs.length - runningJobs} 個排隊` : ""}`
                    : `${activeJobs.length} 個排隊中`}
                </Badge>
              </Tooltip>
            )}
            <Tooltip label={wsConnected ? "即時更新已連線" : "即時更新中斷，重新連線中…"}>
              <Box px={6} py={4} style={{ display: "flex" }} aria-label={wsConnected ? "即時連線正常" : "即時連線中斷"}>
                <Dot color={wsConnected ? "teal" : "red"} live={!wsConnected} size={9} />
              </Box>
            </Tooltip>
            <ThemeMenu />
            <Menu width={220}>
              <Menu.Target>
                <UnstyledButton className={classes.user} aria-label="帳號選單">
                  <Group gap={8} wrap="nowrap">
                    <Avatar size={30} radius="xl" color="brand" variant="filled">
                      {(me.data?.username ?? "A").slice(0, 1).toUpperCase()}
                    </Avatar>
                    <Text fz="sm" fw={600} visibleFrom="sm">
                      {me.data?.username ?? "admin"}
                    </Text>
                    <IconChevronDown size={14} />
                  </Group>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>已登入為 {me.data?.username ?? "—"}</Menu.Label>
                <Menu.Item leftSection={<IconLock size={16} />} component={Link} to="/security">
                  密碼與通行金鑰
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconLogout size={16} />} onClick={() => void signOut()}>
                  登出
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar className={classes.navbar}>
        <Group px="md" className={classes.navBrand} justify="space-between" wrap="nowrap">
          <Brand />
          <Burger opened={opened} onClick={toggle} hiddenFrom="md" size="sm" aria-label="關閉選單" />
        </Group>
        <AppShell.Section grow component={ScrollArea} type="scroll" px="sm" pb="md">
          {NAV.map((section) => (
            <Stack key={section.label} gap={2} mt="md">
              <Text fz={11} fw={700} c="dimmed" px="sm" mb={4} tt="uppercase" style={{ letterSpacing: 0.6 }}>
                {section.label}
              </Text>
              {section.items.map((item) => {
                const active = isActive(location.pathname, item.to);
                const dot = item.moduleKey ? moduleDot(item.moduleKey) : item.moduleKeys ? groupDot(item.moduleKeys) : null;
                const jobsBadge = item.to === "/jobs" && activeJobs.length > 0;
                return (
                  <NavLink
                    key={item.to}
                    component={Link}
                    to={item.to}
                    active={active}
                    label={item.label}
                    className={classes.navLink}
                    leftSection={<item.icon size={18} stroke={1.7} />}
                    rightSection={
                      jobsBadge ? (
                        <Badge size="xs" circle color="blue" variant="filled">
                          {activeJobs.length}
                        </Badge>
                      ) : dot ? (
                        <Tooltip label={dot.label} position="right">
                          <Box component="span" style={{ display: "flex" }}>
                            <Dot color={dot.color} size={7} />
                          </Box>
                        </Tooltip>
                      ) : null
                    }
                  />
                );
              })}
            </Stack>
          ))}
        </AppShell.Section>
        <Box px="md" py="sm" className={classes.navFooter}>
          <Text fz={11} c="dimmed">
            Admin Console v2 · {modulesQ.data ? "已連線" : "連線中…"}
          </Text>
        </Box>
      </AppShell.Navbar>

      <AppShell.Main className={classes.main}>
        <Box className={classes.content}>
          <WorkerOfflineBanner />
          <Outlet />
        </Box>
      </AppShell.Main>

      <Spotlight
        actions={spotlightActions}
        nothingFound="找不到相符的頁面"
        highlightQuery
        shortcut={["mod + K", "/"]}
        searchProps={{ leftSection: <IconSearch size={18} />, placeholder: "搜尋頁面或功能…" }}
        radius="lg"
      />
      <DbHealthGate />
    </AppShell>
  );
}

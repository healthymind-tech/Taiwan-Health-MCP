import { Box, Loader, Overlay, Paper, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { IconDatabaseOff } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { onDbUnavailable } from "@/lib/dbHealth";
import { qk } from "@/lib/queryKeys";
import type { DbHealthSnapshot } from "@/lib/types";
import { fmtDuration } from "@/lib/format";

/**
 * Full-screen overlay while the database is unreachable. Any 503
 * database_unavailable flips it on; it polls /admin/api/health until healthy.
 */
export function DbHealthGate() {
  const [suspect, setSuspect] = useState(false);
  useEffect(() => onDbUnavailable(() => setSuspect(true)), []);
  const q = useQuery({
    queryKey: qk.dbHealth,
    queryFn: () => api.get<DbHealthSnapshot>("/admin/api/health"),
    refetchInterval: suspect ? 2000 : 30_000,
  });
  const down = q.data ? !q.data.healthy : false;
  useEffect(() => {
    if (q.data?.healthy) setSuspect(false);
  }, [q.data?.healthy]);
  if (!down) return null;
  const recovering = q.data?.state === "recovering";
  return (
    <Overlay fixed blur={4} backgroundOpacity={0.35} zIndex={400} center>
      <Paper p="xl" radius="lg" shadow="xl" maw={440} mx="md" withBorder>
        <Stack align="center" ta="center" gap="sm">
          <ThemeIcon size={56} radius="xl" color={recovering ? "amber" : "red"} variant="light">
            <IconDatabaseOff size={28} />
          </ThemeIcon>
          <Title order={3}>{recovering ? "資料庫恢復中" : "資料庫暫時無法連線"}</Title>
          <Text c="dimmed" fz="sm">
            為避免資料不一致，所有修改操作已暫停。連線恢復後會自動解除，無需重新整理。
          </Text>
          <Box>
            <Text fz="xs" c="dimmed">
              已持續 {fmtDuration(q.data?.for_seconds)}
              {q.data?.last_error ? ` · ${q.data.last_error}` : ""}
            </Text>
          </Box>
          <Loader size="sm" type="dots" />
        </Stack>
      </Paper>
    </Overlay>
  );
}

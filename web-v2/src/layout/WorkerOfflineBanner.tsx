import { Alert, Anchor, Code, Text } from "@mantine/core";
import { IconPlugConnectedX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "@/lib/api";
import { useJobs } from "@/lib/jobs";
import { qk } from "@/lib/queryKeys";

interface WorkerBeat {
  worker_name: string;
  stale: boolean;
}

/**
 * App-wide warning while no admin-worker is heartbeating. Every import, sync,
 * embedding, drug stage and backup runs in the worker; without one, jobs sit
 * in the queue forever with no other sign. Shown above every page so the
 * operator sees it right where they queued the job.
 */
export function WorkerOfflineBanner() {
  const workersQ = useQuery({
    queryKey: qk.workers,
    queryFn: () => api.get<{ workers: WorkerBeat[] }>("/admin/api/workers"),
    refetchInterval: 20_000,
    staleTime: 10_000,
    retry: false,
  });
  const { data: jobs } = useJobs();
  if (!workersQ.data) return null;
  const live = workersQ.data.workers.filter((w) => !w.stale);
  if (live.length > 0) return null;
  const queued = (jobs?.jobs ?? []).filter((j) => j.status === "queued").length;
  const none = workersQ.data.workers.length === 0;
  return (
    <Alert
      color="red"
      variant="light"
      radius="md"
      mb="md"
      icon={<IconPlugConnectedX size={20} />}
      title={none ? "沒有背景 Worker 在執行" : "背景 Worker 已失聯"}
      role="status"
    >
      <Text fz="sm">
        匯入、同步、向量嵌入、藥品管線與備份都由 admin-worker 執行；目前沒有 Worker 回報心跳
        {queued > 0 ? `，${queued} 個工作正在排隊等待` : ""}。
      </Text>
      <Text fz="sm" mt={4}>
        請在伺服器上啟動 Worker：<Code>docker compose up -d admin-worker</Code>。上線後會自動接手排隊中的工作，不需重新建立。{" "}
        <Anchor component={Link} to="/health" fz="sm">
          查看服務健康
        </Anchor>
      </Text>
    </Alert>
  );
}

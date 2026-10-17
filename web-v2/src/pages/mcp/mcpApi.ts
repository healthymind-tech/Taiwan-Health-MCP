import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import type { CatalogPayload, InvokeResponse, OverviewPayload } from "./mcpTypes";

export function useMcpCatalog() {
  return useQuery({ queryKey: qk.mcpTools, queryFn: () => api.get<CatalogPayload>("/admin/api/mcp/tools"), staleTime: 30_000 });
}

export function useMcpOverview() {
  return useQuery({ queryKey: qk.mcpOverview, queryFn: () => api.get<OverviewPayload>("/admin/api/mcp/overview"), staleTime: 60_000 });
}

export function invokeMcpTool(name: string, args: Record<string, unknown>, confirmWrite = false): Promise<InvokeResponse> {
  return api.post<InvokeResponse>(`/admin/api/mcp/tools/${encodeURIComponent(name)}/invoke`, {
    arguments: args,
    ...(confirmWrite ? { confirm_write_operation: true } : {}),
  });
}

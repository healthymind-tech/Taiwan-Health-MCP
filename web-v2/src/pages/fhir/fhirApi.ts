import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import type { FhirOAuthAuthorizePayload, FhirServer, FhirServerPayload, FhirServersPayload } from "@/lib/types";
import type { ConnectionTestResult, DiscoverResult, GeneratedKey, TestRequestResult } from "./fhirModel";

const BASE = "/admin/api/fhir-servers";
const enc = encodeURIComponent;

export function useFhirServers() {
  return useQuery({
    queryKey: qk.fhirServers,
    queryFn: () => api.get<FhirServersPayload>(`${BASE}?include_disabled=true`).then((r) => r.servers ?? []),
  });
}

export function useFhirServer(id: string | undefined) {
  return useQuery({
    queryKey: qk.fhirServer(id ?? ""),
    enabled: Boolean(id),
    queryFn: () => api.get<FhirServerPayload>(`${BASE}/${enc(id ?? "")}`).then((r) => r.server),
  });
}

/** Invalidate list + every detail entry (they share the "fhir-servers" prefix). */
export function useInvalidateFhir() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: qk.fhirServers }), qc.invalidateQueries({ queryKey: qk.overview })]);
}

export const fhirApi = {
  create: (payload: Record<string, unknown>) => api.post<FhirServerPayload>(BASE, payload).then((r) => r.server),
  update: (id: string, payload: Record<string, unknown>) => api.patch<FhirServerPayload>(`${BASE}/${enc(id)}`, payload).then((r) => r.server),
  remove: (id: string) => api.del<{ deleted: FhirServer }>(`${BASE}/${enc(id)}`),
  probe: (id: string) => api.post<ConnectionTestResult & { server: FhirServer }>(`${BASE}/${enc(id)}/probe`),
  setDefault: (id: string) => api.post<FhirServerPayload>(`${BASE}/${enc(id)}/set-default`).then((r) => r.server),
  test: (payload: Record<string, unknown>) => api.post<ConnectionTestResult>(`${BASE}/test`, payload),
  testRequest: (payload: Record<string, unknown>) => api.post<TestRequestResult>(`${BASE}/test-request`, payload),
  discover: (payload: Record<string, unknown>) => api.post<DiscoverResult>(`${BASE}/discover`, payload),
  generateKey: (alg: string) => api.post<GeneratedKey>(`${BASE}/generate-key`, { alg }),
  exportAll: () => api.get<{ servers: Record<string, unknown>[] }>(`${BASE}/export`),
  authorize: (id: string) => api.post<FhirOAuthAuthorizePayload>(`${BASE}/${enc(id)}/oauth/authorize`),
  refresh: (id: string) => api.post<{ ok: boolean }>(`${BASE}/${enc(id)}/oauth/refresh`),
  clearCache: (id: string) => api.post<{ cleared: boolean }>(`${BASE}/${enc(id)}/oauth/clear-cache`),
};

export function useProbeServer() {
  const invalidate = useInvalidateFhir();
  return useMutation({
    mutationFn: (id: string) => fhirApi.probe(id),
    onSettled: () => invalidate(),
  });
}

/** Download a JSON blob as a file (no native UI shown). */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

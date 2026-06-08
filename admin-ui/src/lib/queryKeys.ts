// Centralised query keys. Every component reads server state through these,
// and wsInvalidation.ts invalidates them on WebSocket events — this is the
// single source of truth that replaces the old hand-wired DOM refreshes.

export const qk = {
  dbHealth: ["db-health"] as const,
  overview: ["overview"] as const,
  services: ["services"] as const,
  settings: ["settings"] as const,
  jobs: ["jobs"] as const,
  // Prefixed by ["jobs"], so any WS job event that invalidates ["jobs"]
  // cascades to a selected job's detail and steps automatically.
  job: (jobId: string) => ["jobs", jobId] as const,
  jobSteps: (jobId: string) => ["jobs", jobId, "steps"] as const,
  modules: ["modules"] as const,
  moduleVersions: (moduleKey: string) =>
    ["modules", moduleKey, "versions"] as const,
  igs: ["igs"] as const,
  igDetail: (packageId: string, version: string) =>
    ["igs", packageId, version] as const,
  registrySearch: (q: string) => ["registry-search", q] as const,
  embedding: ["embedding"] as const,
  workers: ["workers"] as const,
  moduleSchedule: (moduleKey: string) => ["schedule", moduleKey] as const,
  modulePreview: (moduleKey: string, params: Record<string, string>) =>
    ["preview", moduleKey, params] as const,
  fhirServers: ["fhir-servers"] as const,
  drugPipeline: ["drug", "pipeline"] as const,
  drugStatus: (params: Record<string, string>) => ["drug", "status", params] as const,
  drugEvents: (licenseId: string) => ["drug", "events", licenseId] as const,
  drugDetails: (licenseId: string) => ["drug", "details", licenseId] as const,
  drugAssets: (licenseId: string) => ["drug", "assets", licenseId] as const,
};

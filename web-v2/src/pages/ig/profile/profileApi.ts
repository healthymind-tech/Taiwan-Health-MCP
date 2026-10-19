import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, qs } from "@/lib/api";
import type { ExampleResource, ProfileView, RequiredData, SkeletonData, ToolEnvelope, ValueSetExpansion } from "./profileTypes";

export interface ProfileRef {
  packageId: string;
  version: string;
  artifactId: string;
}

// Under "igs" so every IG invalidation (import finished, module_changed) refreshes these too.
const pk = {
  view: (r: ProfileRef) => ["igs", "~profile", r.packageId, r.version, r.artifactId] as const,
  required: (r: ProfileRef, verbosity: string, ms: boolean) => ["igs", "~profile", r.packageId, r.version, r.artifactId, "required", verbosity, ms] as const,
  skeleton: (r: ProfileRef) => ["igs", "~profile", r.packageId, r.version, r.artifactId, "skeleton"] as const,
  valueset: (pkg: string, ver: string, url: string) => ["igs", "~profile-vs", pkg, ver, url] as const,
  example: (pkg: string, ver: string, id: string, rt: string) => ["igs", "~profile-example", pkg, ver, id, rt] as const,
};

const base = (r: ProfileRef) => ({ package_id: r.packageId, version: r.version, artifact_id: r.artifactId });

/** An installed package version's profiles only change on reinstall: keep them for the session. */
const STALE = 10 * 60_000;

export function useProfileView(r: ProfileRef) {
  return useQuery({
    queryKey: pk.view(r),
    queryFn: () => api.get<ProfileView>(`/admin/api/igs/profile${qs(base(r))}`),
    staleTime: STALE,
    retry: (n, e) => n < 1 && !(e && typeof e === "object" && "status" in e && (e as { status: number }).status < 500),
  });
}

export function useRequiredElements(r: ProfileRef, verbosity: "compact" | "full", includeMustSupport: boolean, enabled = true) {
  return useQuery({
    queryKey: pk.required(r, verbosity, includeMustSupport),
    queryFn: () =>
      api.get<ToolEnvelope<RequiredData>>(
        `/admin/api/igs/profile/required${qs({ ...base(r), verbosity, include_mustsupport: includeMustSupport ? "true" : null })}`,
      ),
    staleTime: STALE,
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useSkeleton(r: ProfileRef, enabled: boolean) {
  return useQuery({
    queryKey: pk.skeleton(r),
    queryFn: () => api.get<ToolEnvelope<SkeletonData>>(`/admin/api/igs/profile/skeleton${qs(base(r))}`),
    staleTime: STALE,
    enabled,
    retry: false,
  });
}

export function useValueSetPreview(pkg: string, ver: string, url: string | null) {
  return useQuery({
    queryKey: pk.valueset(pkg, ver, url ?? ""),
    queryFn: () => api.get<ToolEnvelope<ValueSetExpansion>>(`/admin/api/igs/profile/valueset${qs({ package_id: pkg, version: ver, url, limit: 12 })}`),
    staleTime: STALE,
    enabled: Boolean(url),
    retry: false,
  });
}

export function useExampleResource(pkg: string, ver: string, id: string | null, resourceType: string) {
  return useQuery({
    queryKey: pk.example(pkg, ver, id ?? "", resourceType),
    queryFn: () => api.get<ExampleResource>(`/admin/api/igs/profile/example${qs({ package_id: pkg, version: ver, artifact_id: id, resource_type: resourceType })}`),
    staleTime: STALE,
    enabled: Boolean(id),
    retry: false,
  });
}

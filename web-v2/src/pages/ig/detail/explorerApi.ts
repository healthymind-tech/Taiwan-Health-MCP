// Data layer of the IG detail page: GET /admin/api/ig-explorer/* (node-server/src/admin/igExplorer.ts).
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, qs } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import type { IgRef } from "../igTypes";

export type Category = "profile" | "extension" | "datatype" | "logical" | "terminology" | "search" | "capability" | "example" | "base";

export interface GroupCount {
  key: string;
  count: number;
}

export interface CategoryCount {
  key: Category;
  count: number;
  groups: GroupCount[];
}

export interface PackageNode {
  package_id: string;
  version: string;
  declared_version?: string;
  title: string | null;
  installed: boolean;
  repeated: boolean;
  children: PackageNode[];
}

export interface ExternalSystem {
  system: string;
  valuesets: number;
  support: { module: string | null; builtin: boolean; label: string } | null;
  defined_in: { package_id: string; version: string; content: string | null; concept_count: number; in_closure: boolean } | null;
}

export interface IgResourceMeta {
  url?: string | null;
  version?: string | null;
  name?: string | null;
  title?: string | null;
  status?: string | null;
  date?: string | null;
  publisher?: string | null;
  license?: string | null;
  copyright?: string | null;
  description?: string | null;
  fhir_version?: string[] | null;
  package_id?: string | null;
  jurisdiction?: { system?: string; code?: string; display?: string }[];
  contact?: string[];
  pages?: string[];
}

export interface IgOverview {
  package_id: string;
  version: string;
  ig: IgResourceMeta | null;
  total: number;
  categories: CategoryCount[];
  example_coverage: { definitions: number; with_examples: number; examples_claiming: number };
  external_systems: ExternalSystem[];
  dependency_tree: PackageNode;
  closure: { package_id: string; version: string; installed: boolean; depth: number }[];
  dependents: { package_id: string; version: string; title: string | null }[];
}

export interface SdDigest {
  type: string;
  abstract: boolean;
  base_definition: string | null;
  base_name: string | null;
  version: string | null;
  differential: number;
  must_support: number;
  required: number;
  contexts?: { type: string; expression: string }[];
  sub_extensions?: string[];
  complex?: boolean;
  value_types?: string[];
}

export interface VsInclude {
  system: string | null;
  version: string | null;
  concepts: number;
  filters: string[];
  value_sets: string[];
}

export interface VsDigest {
  include: VsInclude[];
  systems: string[];
  enumerated: number;
  exclude: number;
  expansion_total: number | null;
  expansion_contains: number;
}

export interface CsDigest {
  content: string | null;
  count: number | null;
  hierarchy_meaning: string | null;
  supplements: string | null;
  case_sensitive: boolean | null;
  value_set: string | null;
}

export interface CmDigest {
  source: string | null;
  target: string | null;
  groups: { source: string | null; target: string | null; elements: number; targets: number }[];
  elements: number;
}

export interface SpDigest {
  code: string | null;
  type: string | null;
  base: string[];
  expression: string | null;
  target: string[];
  derived_from: string | null;
}

export interface ExampleDigest {
  profiles: string[];
  status: string | null;
  coding: { system: string | null; code: string | null; display: string | null } | null;
  bundle_type: string | null;
  entries: number | null;
}

export interface ArtifactItem {
  artifact_key: string;
  resource_type: string;
  artifact_id: string;
  canonical_url: string | null;
  title: string;
  name: string | null;
  status: string | null;
  description: string | null;
  category: Category;
  group: string;
  example_count: number;
  digest: Record<string, unknown>;
}

export interface ArtifactsPage {
  total: number;
  offset: number;
  limit: number;
  facets: CategoryCount[];
  groups: GroupCount[];
  items: ArtifactItem[];
  resolved: Record<string, ResolvedRef>;
}

export interface ResolvedRef {
  package_id: string;
  version: string;
  artifact_key: string;
  artifact_id: string;
  resource_type: string;
  title: string;
  same_package: boolean;
}

export interface ArtifactFull extends ArtifactItem {
  package_path: string | null;
  size: number;
  raw_json: unknown;
  raw_truncated: boolean;
  resolved: Record<string, ResolvedRef>;
}

export interface CodeSystemInfo {
  artifact_key: string;
  cs_id: string;
  url: string | null;
  title: string;
  name: string | null;
  status: string | null;
  cs_version: string | null;
  content: string | null;
  declared_count: number | null;
  concept_count: number;
  depth: number;
  depth_more: boolean;
  hierarchy_meaning: string | null;
  case_sensitive: boolean | null;
  language: string | null;
  languages: string[];
  property_count: number;
  supplements: string | null;
  used_by: { artifact_key: string; title: string }[];
  supplemented_by: { url: string; version: string | null; title: string; concept_count: number; source: string }[];
  size: number;
}

export interface Designation {
  language: string | null;
  use: string | null;
  value: string;
}

export interface FlatConcept {
  code: string;
  display: string | null;
  definition: string | null;
  depth: number;
  parent: string | null;
  child_count: number;
  designations: Designation[];
  properties: { code: string; value: string }[];
  supplements: { title: string; source: string; designations: Designation[]; properties: { code: string; value: string }[] }[];
}

export interface ConceptPage {
  total: number;
  all: number;
  offset: number;
  limit: number;
  flat_mode: boolean;
  items: FlatConcept[];
}

const base = (ig: IgRef) => ({ package_id: ig.package_id, version: ig.version });
const get = <T>(route: string, params: Record<string, string | number | null | undefined>) => api.get<T>(`/admin/api/ig-explorer/${route}${qs(params)}`);
/** Under qk.igDetail so every IG invalidation (import finished, module_changed) refreshes them too. */
const key = (ig: IgRef, ...rest: unknown[]) => [...qk.igDetail(ig.package_id, ig.version), "explorer", ...rest] as const;

export function useIgOverview(ig: IgRef) {
  return useQuery({ queryKey: key(ig, "overview"), queryFn: () => get<IgOverview>("overview", base(ig)), staleTime: 5 * 60_000 });
}

export function useIgArtifacts(ig: IgRef, p: { category: string; group: string | null; q: string; limit: number }, enabled = true) {
  return useQuery({
    queryKey: key(ig, "artifacts", p),
    queryFn: () => get<ArtifactsPage>("artifacts", { ...base(ig), category: p.category, group: p.group ?? undefined, q: p.q || undefined, limit: p.limit }),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useIgArtifact(ig: IgRef, artifactKey: string | null) {
  return useQuery({
    queryKey: key(ig, "artifact", artifactKey),
    queryFn: () => get<ArtifactFull>("artifact", { ...base(ig), artifact_key: artifactKey }),
    enabled: Boolean(artifactKey),
    staleTime: 5 * 60_000,
  });
}

export function useIgCodeSystems(ig: IgRef) {
  return useQuery({ queryKey: key(ig, "codesystems"), queryFn: () => get<{ items: CodeSystemInfo[] }>("codesystems", base(ig)), staleTime: 5 * 60_000 });
}

export function useCsConcepts(ig: IgRef, artifactKey: string, q: string, offset: number, limit: number) {
  return useQuery({
    queryKey: key(ig, "cs-concepts", artifactKey, q, offset, limit),
    queryFn: () => get<ConceptPage>("codesystem/concepts", { ...base(ig), artifact_key: artifactKey, q: q || undefined, offset, limit }),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

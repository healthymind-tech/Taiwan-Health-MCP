import type { JobSummary } from "@/lib/types";

// Shapes of /admin/api/igs* (node-server/src/admin/adminIg.ts) and the `ig`
// preview (adminPreview.ts previewIg).

export interface IgRef {
  package_id: string;
  version: string;
}

/** How a package got installed (fhir.ig_packages.install_origin); null = migration not applied. */
export type IgInstallOrigin = "manual" | "dependency";

/** The IG whose install pulled a dependency in. */
export interface IgInstalledFor extends IgRef {
  title: string | null;
  installed: boolean;
}

export interface IgSummary {
  package_id: string;
  version: string;
  title: string;
  canonical: string | null;
  fhir_version: string | null;
  status: string | null;
  is_default: boolean;
  imported_at: string | null;
  dependencies: Record<string, string>;
  counts: { artifacts: number; codesystems: number; concepts: number; examples?: number };
  deps_total: number;
  deps_missing: IgRef[];
  description?: string | null;
  install_origin?: IgInstallOrigin | null;
  installed_for?: IgInstalledFor | null;
  /** Installed IGs that declare this package as a direct dependency. */
  required_by?: IgRef[];
}

export interface IgDetail extends Omit<IgSummary, "dependencies" | "deps_total" | "required_by" | "description"> {
  dependencies: (IgRef & { installed: boolean })[];
  dependents: IgRef[];
  codesystems: { cs_id: string; name: string; concept_count: number }[];
  external_systems: string[];
}

export interface RegistryHit {
  name: string;
  description: string;
  fhirVersion: string;
}

export interface IgTreeType {
  grouping_id: string;
  resource_type: string;
  artifact_count: number;
}

export interface IgTreeGroup {
  grouping_id: string;
  label: string;
  artifact_count: number;
  children: IgTreeType[];
}

export interface IgArtifact {
  artifact_key: string;
  resource_type: string;
  artifact_id: string;
  title: string;
  name: string;
  status: string;
  kind: string;
  base_type: string;
  derivation: string;
  grouping_id: string;
  grouping_name: string;
  description: string;
  child_count: number;
  concept_count: number;
}

export interface IgPreviewPayload {
  type: string;
  message?: string;
  tree?: IgTreeGroup[];
  rows?: Record<string, unknown>[];
  total?: number;
  page?: number;
  per_page?: number;
  counts?: { codesystems: number; artifacts: number; profiles: number; profile_resources: number };
  resource_types?: string[];
  selected?: IgArtifact;
  detail?: Record<string, unknown>;
}

/** zh-TW names for FHIR conformance resource types. */
export const RESOURCE_TYPE_ZH: Record<string, string> = {
  StructureDefinition: "Profile / Extension",
  ValueSet: "ValueSet",
  CodeSystem: "CodeSystem",
  ConceptMap: "ConceptMap",
  SearchParameter: "SearchParameter",
  CapabilityStatement: "CapabilityStatement",
  OperationDefinition: "OperationDefinition",
  ImplementationGuide: "ImplementationGuide",
  NamingSystem: "NamingSystem",
};

// GET /admin/api/igs/dependencies (node-server/src/admin/igDependencies.ts)
export type RegistryFailureKind = "not_found" | "network" | "checksum" | "invalid_package" | "unknown";
export type MissingDepStatus = "missing" | "queued" | "downloading" | "failed";

export interface MissingDependency {
  package_id: string;
  /** Version that will be installed (alias resolved, e.g. core 4.0.0 → 4.0.1). */
  version: string;
  declared_versions: string[];
  alias: { declared: string; resolved: string } | null;
  required_by: (IgRef & { direct: boolean })[];
  status: MissingDepStatus;
  active_job: {
    job_id: string;
    status: string;
    current_step: string;
    progress_current: number;
    progress_total: number;
  } | null;
  last_failure: { reason: string; reason_code: RegistryFailureKind; job_id: string; at: string } | null;
}

/** POST /admin/api/igs/dependencies/download | download-all | {id}/{ver}/fill-dependencies */
export interface DependencyQueueResult {
  job: JobSummary | null;
  packages: IgRef[];
  already_queued: string[];
  nothing_missing?: boolean;
}

/** POST /admin/api/igs/inspect-upload */
export interface UploadedIgIdentity {
  ok: true;
  package_id: string;
  version: string;
  title: string;
  fhir_version: string;
  dependencies: Record<string, string>;
}

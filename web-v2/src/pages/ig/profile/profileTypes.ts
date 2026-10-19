// Shapes of /admin/api/igs/profile* (node-server/src/admin/igProfileApi.ts).

export interface FixedPattern {
  field: string;
  value: unknown;
}

export interface ElementType {
  code: string;
  profile?: string[];
  targetProfile?: string[];
}

export interface ElementConstraint {
  key: string;
  severity: string | null;
  human: string | null;
  expression: string | null;
  source: string | null;
}

export interface ElementRow {
  id: string;
  path: string;
  parent: string | null;
  depth: number;
  name: string;
  sliceName: string | null;
  min: number | null;
  max: string | null;
  baseMin: number | null;
  baseMax: string | null;
  cardChanged: boolean;
  mustSupport: boolean;
  isModifier: boolean;
  isModifierReason: string | null;
  isSummary: boolean;
  types: ElementType[];
  binding: { strength: string | null; valueSet: string | null; description: string | null } | null;
  fixed: FixedPattern | null;
  pattern: FixedPattern | null;
  constraints: ElementConstraint[];
  constraintCount: number;
  short: string | null;
  definition: string | null;
  comment: string | null;
  requirements: string | null;
  meaningWhenMissing: string | null;
  alias: string[];
  condition: string[];
  maxLength: number | null;
  contentReference: string | null;
  mappings: Array<{ identity: string; map: string }>;
  slicing: { discriminator: Array<{ type: string; path: string }>; rules: string | null; ordered: boolean | null; description: string | null } | null;
  inDiff: boolean;
  diffKeys: string[];
  hasChildren: boolean;
}

export interface LinkTarget {
  package_id: string;
  version: string;
  artifact_id: string;
  resource_type: string;
  title: string | null;
  kind: string | null;
}

export interface ChainEntry {
  canonical: string;
  artifact_id: string | null;
  package_id: string | null;
  version: string | null;
  title: string | null;
  derivation: string | null;
  kind: string | null;
  installed: boolean;
}

export interface DepMissing {
  package_id: string;
  version: string;
  required_by: string;
}

export interface ProfileIdentity {
  artifactId: string | null;
  canonical: string | null;
  name: string | null;
  title: string | null;
  status: string | null;
  kind: string | null;
  baseType: string | null;
  derivation: string | null;
  baseDefinition: string | null;
  description: string | null;
  elementCount: number;
  deps_missing?: DepMissing[];
}

export interface ExtensionInfo {
  context: Array<{ type: string; expression: string }>;
  contextInvariant: string[];
  valueTypes: ElementType[];
  complex: boolean;
  subExtensions: Array<{ sliceName: string; url: string | null; min: number | null; max: string | null; short: string | null; valueTypes: string[] }>;
}

export interface ExampleRef {
  artifactId: string;
  resourceType: string;
  title: string;
}

export interface ProfileView {
  target: { package_id: string; version: string; artifact_id: string };
  profile: ProfileIdentity;
  provenance: Record<string, unknown> | null;
  warnings: string[];
  meta: {
    url: string | null;
    version: string | null;
    name: string | null;
    title: string | null;
    status: string | null;
    experimental: boolean | null;
    abstract: boolean | null;
    type: string | null;
    kind: string | null;
    derivation: string | null;
    fhirVersion: string | null;
    publisher: string | null;
    date: string | null;
    description: string | null;
    purpose: string | null;
    copyright: string | null;
    mappings: Array<{ identity: string; name: string | null; uri: string | null }>;
  };
  element_source: "snapshot" | "differential" | "none";
  differential_count: number;
  elements: ElementRow[];
  base_chain: ChainEntry[];
  derived: { truncated: boolean; items: Array<{ package_id: string; version: string; artifact_id: string; title: string | null; kind: string | null }> };
  links: Record<string, LinkTarget>;
  extension: ExtensionInfo | null;
  examples: { count: number; examples: ExampleRef[] };
}

/** The common FHIR IG tool envelope. */
export interface ToolEnvelope<T> {
  ok: boolean;
  data: T;
  warnings: string[];
  provenance: Record<string, unknown> | null;
}

/** fhir_get_profile_required_elements row (compact keeps a subset; full adds min/max/types/binding/mustSupport). */
export interface RequiredRow {
  id: string;
  path?: string;
  min?: number;
  max?: string;
  types?: string[];
  binding?: { strength?: string; valueSet?: string } | null;
  mustSupport?: boolean;
  required_by?: string;
  grounding_class: string;
  fixed?: FixedPattern | null;
  pattern?: FixedPattern | null;
  value?: unknown;
  choices?: string[];
  allowedCodes?: string[];
  hint?: string;
  /** mustSupport-only rows (include_mustsupport): not required. */
  optional?: boolean;
  /** Citation of the derivation rule in `hint` (derived rows, verbosity=full). */
  derivation_source?: string;
}

export interface RequiredData {
  profile: string;
  canonical: string | null;
  resourceType: string;
  verbosity: "compact" | "full";
  count: number;
  summary: Record<string, number>;
  guide: string;
  elements: RequiredRow[];
  invariants?: Array<{ key: string; on: string | string[]; rule?: string; human?: string; expression?: string; severity?: string }>;
  moreInvariants?: string[];
  deps_missing?: DepMissing[];
}

export interface SkeletonField {
  path: string;
  jsonPath: string;
  required: boolean;
  effectiveRequired: boolean;
  array: boolean;
  types: ElementType[];
  mustSupport: boolean;
  short: string | null;
  choices?: string[];
  autoPinned?: { field: string; value: unknown; note?: string };
  binding?: { strength: string; valueSet: string; candidateCodes: Array<{ system?: string; code: string; display?: string }> | null; candidatesTruncated?: boolean; note?: string };
  slices?: Array<{ sliceName: string; min: number; max: string; short?: string }>;
}

export interface SkeletonData {
  profile: string;
  canonical: string;
  resourceType: string;
  instructions: string;
  fields: SkeletonField[];
  examples: ExampleRef[];
}

export interface ValueSetExpansion {
  valueSetId: string;
  canonical: string;
  total: number | null;
  truncated: boolean;
  unresolved?: unknown[];
  codings: Array<{ system?: string; code: string; display?: string }>;
}

export interface ExampleResource {
  artifact_id: string;
  resource_type: string;
  resource: Record<string, unknown>;
}

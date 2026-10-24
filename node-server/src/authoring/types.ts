// Shared types of the authoring layer. See README.md in this directory for the contract.
// Extend only by appending; every workstream imports from here.

export type Provenance = "model" | "fixed" | "default" | "derived" | "lookup";

export type FieldKind =
  | "string" | "code" | "coding" | "codeableConcept" | "quantity" | "date" | "dateTime" | "period"
  | "identifier" | "reference" | "boolean" | "integer" | "decimal" | "component" | "dosage"
  | "annotation" | "humanName" | "other";

export type FieldSource = "record" | "facility" | "code" | "fixed" | "default" | "derived";

export interface FieldBindingCode { code: string; display?: string; system?: string }

export interface FieldSpec {
  field: string;
  required: boolean;
  why?: string;
  kind: FieldKind;
  multiple: boolean;
  source: FieldSource;
  auto?: true;
  format?: string;
  example?: unknown;
  binding?: { strength: string; valueSet: string; codes?: FieldBindingCode[] };
  targets?: string[];
  children?: FieldSpec[];
}

export interface AuthorInput {
  key: string;
  profile: string;
  package_id?: string;
  version?: string;
  fields: Record<string, unknown>;
  merge?: boolean;
}

export type IssueSeverity = "fatal" | "error" | "warning" | "information";

export interface AuthorIssue {
  key: string;
  field: string | null;
  path: string;
  severity: IssueSeverity;
  message: string;
  suggestions?: unknown[];
}

export type AuthorStatus = "valid" | "invalid" | "refs_pending";

export interface AuthorResult {
  key: string;
  status: AuthorStatus;
  resource: Record<string, unknown>;
  provenance: Record<string, Provenance>;
  missing: Array<{ field: string; why: string }>;
  refs: { resolved: string[]; pending: string[] };
  issues: AuthorIssue[];
}

/** One tool of the authoring layer; `index.ts` registers them in mcp.ts. */
export interface AuthoringToolSpec {
  name: string;
  description: string;
  // zod raw shape (Record<string, ZodTypeAny>) — typed loosely to keep this file dependency-free.
  inputShape: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

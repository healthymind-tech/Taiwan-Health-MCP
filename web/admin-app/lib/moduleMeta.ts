// Module → job-type metadata, mirroring the backend (admin_jobs.py job-type
// sets and admin_sources.py _ROLE_JOB_TYPE). Kept on the frontend because the
// /admin/api/modules catalog only carries upload-based modules and does not
// embed the job-type mapping.

export interface UploadModuleMeta {
  label: string;
  importJobType: string;
  embedJobType: string | null;
  // Drug index imports are per-file (cumulative): pass source_uploaded_file_id.
  perFileImport?: boolean;
}

// Upload-based modules present in the /admin/api/modules catalog.
export const UPLOAD_MODULE_META: Record<string, UploadModuleMeta> = {
  icd: { label: "ICD-10", importJobType: "icd_import", embedJobType: "icd_embed" },
  loinc: { label: "LOINC", importJobType: "loinc_import", embedJobType: "loinc_embed" },
  ig: { label: "Implementation Guides", importJobType: "ig_import", embedJobType: null },
  snomed: { label: "SNOMED CT", importJobType: "snomed_import", embedJobType: "snomed_embed" },
  rxnorm: { label: "RxNorm", importJobType: "rxnorm_import", embedJobType: null },
  drug: {
    label: "Drug index",
    importJobType: "drug_index_import",
    embedJobType: null,
    perFileImport: true,
  },
};

// Action-only modules that have NO upload sources (not in the catalog):
// FDA API syncs and the guideline seed.
export interface ActionModuleMeta {
  moduleKey: string;
  label: string;
  jobType: string;
  actionLabel: string;
  description: string;
  embedJobType: string | null;
}

export const ACTION_MODULES: ActionModuleMeta[] = [
  {
    moduleKey: "guideline",
    label: "Clinical guidelines",
    jobType: "guideline_seed",
    actionLabel: "Run seed",
    description: "Seeds built-in Taiwan clinical guideline data (idempotent upsert — safe to re-run).",
    embedJobType: "guideline_embed",
  },
  {
    moduleKey: "health_supplements",
    label: "Health supplements",
    jobType: "health_supplements_sync",
    actionLabel: "Sync now",
    description: "Sync health supplements registrations from Taiwan FDA Open Data.",
    embedJobType: "health_supplements_embed",
  },
  {
    moduleKey: "food_nutrition",
    label: "Food nutrition",
    jobType: "food_nutrition_sync",
    actionLabel: "Sync now",
    description: "Sync the food nutrition database from Taiwan FDA Open Data.",
    embedJobType: "food_nutrition_embed",
  },
];

// Stable display order for the upload modules.
// Terminologies the IGs depend on come first (ICD → LOINC → SNOMED → RxNorm),
// then the Implementation Guides gallery, then the Drug index last.
export const UPLOAD_MODULE_ORDER = ["icd", "loinc", "snomed", "rxnorm", "ig", "drug"];

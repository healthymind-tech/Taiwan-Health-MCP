// Frontend mirrors of backend module capability sets (admin_schedule.py,
// admin_preview.py). Kept here because the catalog payload does not expose them.

// admin_schedule.URL_FETCH_MODULES — schedules download from fetch_url.
export const URL_FETCH_MODULES = new Set(["icd", "ig", "drug"]);
// admin_schedule.API_SYNC_MODULES — schedules just queue a sync job.
export const API_SYNC_MODULES = new Set(["health_supplements", "food_nutrition"]);
// admin_schedule.SCHEDULABLE_MODULES
export const SCHEDULABLE_MODULES = new Set([...URL_FETCH_MODULES, ...API_SYNC_MODULES]);

// admin_preview.PREVIEW_SUPPORTED_MODULES
export const PREVIEW_SUPPORTED_MODULES = new Set([
  "icd",
  "loinc",
  "snomed",
  "ig",
  "guideline",
  "drug",
  "health_supplements",
  "food_nutrition",
  "rxnorm",
]);

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Grouping + display labels for the Overview "Services" section. The overview
// payload returns services as a flat { key: info } map; these definitions turn
// that into ordered, human-labelled categories. A service key not listed in any
// category falls into an "Other" bucket so newly-added services still appear.

export interface ServiceCategory {
  label: string;
  keys: readonly string[];
}

/** Friendly names for the raw overview service keys. */
export const SERVICE_LABELS: Record<string, string> = {
  icd: "ICD-10-CM/PCS",
  lab: "LOINC (lab)",
  snomed: "SNOMED CT",
  ig: "Implementation Guides",
  fhir_condition: "FHIR Condition",
  fhir_medication: "FHIR Medication",
  drug: "Drug (TFDA)",
  health_supplements: "Health supplements",
  food_nutrition: "Food nutrition",
  guideline: "Clinical guidelines",
};

/** Ordered categories rendered as sibling sections on the Overview page. */
export const SERVICE_CATEGORIES: readonly ServiceCategory[] = [
  { label: "Terminology & coding", keys: ["icd", "lab", "snomed"] },
  {
    label: "FHIR & interoperability",
    keys: ["ig", "fhir_condition", "fhir_medication"],
  },
  {
    label: "Drug, supplements & nutrition",
    keys: ["drug", "health_supplements", "food_nutrition"],
  },
  { label: "Clinical guidelines", keys: ["guideline"] },
];

export function serviceLabel(key: string): string {
  return SERVICE_LABELS[key] ?? key;
}

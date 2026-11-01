/**
 * ISSUES_v17.1 R4 — STU3 (R3) elements that R4 renamed or removed, from the FHIR R4 version-change notes of the
 * core resources (FHIR core knowledge — the same for every IG). Models trained on older examples write them, and
 * the validator reports "Unrecognized property".
 *
 *   rename   the R4 element the value moves to (`inner`: renamed children of a backbone; `annotation`: a string
 *            becomes {text}); finalize renames when the R4 element is absent, suggestions name it;
 *   removed  no R4 element holds it: what to write instead (reported, never deleted).
 */

export interface R3Rename {
  to?: string;
  /** Children renamed inside the moved backbone (R3 child → R4 child); null = removed in R4 (reported). */
  inner?: Record<string, string | null>;
  /** A string value becomes an Annotation {text}. */
  annotation?: boolean;
  /** Why there is no R4 element / what to write instead. */
  removed?: string;
}

export const R3_RENAMES: Readonly<Record<string, R3Rename>> = {
  "Immunization.vaccineProtocol": {
    to: "protocolApplied",
    inner: { doseSequence: "doseNumberPositiveInt", seriesDoses: "seriesDosesPositiveInt", doseStatus: null, doseStatusReason: null, description: null },
  },
  "Immunization.date": { to: "occurrenceDateTime" },
  "Immunization.notGiven": { removed: "R4 has no notGiven: write status = 'not-done' (and statusReason) when the vaccine was not given" },
  "Immunization.explanation": { removed: "R4 has no explanation: write reasonCode (why given) or statusReason (why not given)" },
  "Immunization.practitioner": { to: "performer", inner: { role: "function" } },
  "Immunization.doseStatus": { removed: "R4 removed doseStatus (it was STU3 vaccineProtocol.doseStatus); leave it out — whether a dose counts is not part of R4 Immunization" },
  "AllergyIntolerance.assertedDate": { to: "recordedDate" },
  "Condition.assertedDate": { to: "recordedDate" },
  "Observation.comment": { to: "note", annotation: true },
  "Observation.context": { to: "encounter" },
  "Condition.context": { to: "encounter" },
  "Procedure.context": { to: "encounter" },
  "DiagnosticReport.context": { to: "encounter" },
  "MedicationRequest.context": { to: "encounter" },
  "ServiceRequest.context": { to: "encounter" },
  "DocumentReference.indexed": { to: "date" },
  "DocumentReference.class": { to: "category" },
  "Procedure.notDone": { removed: "R4 has no notDone: write status = 'not-done' (and statusReason)" },
  "Procedure.notDoneReason": { to: "statusReason" },
  "MedicationStatement.taken": { removed: "R4 has no taken: write status (e.g. 'not-taken', 'active', 'completed')" },
  "MedicationStatement.reasonNotTaken": { to: "statusReason" },
  "MedicationAdministration.notGiven": { removed: "R4 has no notGiven: write status = 'not-done' (and statusReason)" },
  "MedicationAdministration.reasonNotGiven": { to: "statusReason" },
  "Patient.animal": { removed: "R4 Patient has no animal element (use the patient-animal extension)" },
  // v19 R1: the MedicationRequest name of the R4 MedicationStatement / MedicationAdministration Dosage element (R4
  // MedicationStatement.dosage and MedicationRequest.dosageInstruction are both 0..* Dosage).
  "MedicationStatement.dosageInstruction": { to: "dosage" },
};

/**
 * The R3 rename of `<owner type>.<key>`, if any. v19 R1: also the STU3 child names inside the R4 element an STU3
 * backbone was renamed to (`Immunization.protocolApplied` + `doseSequence` → `doseNumberPositiveInt`): a model that
 * already writes the R4 backbone name often keeps its STU3 children.
 */
export function r3Rename(ownerType: string, key: string): R3Rename | null {
  const direct = R3_RENAMES[`${ownerType}.${key}`];
  if (direct) return direct;
  const dot = ownerType.lastIndexOf(".");
  if (dot < 0) return null;
  const [rt, el] = [ownerType.slice(0, dot), ownerType.slice(dot + 1)];
  for (const [k, r] of Object.entries(R3_RENAMES)) {
    if (!k.startsWith(`${rt}.`) || r.to !== el || !r.inner || !(key in r.inner)) continue;
    const to = r.inner[key];
    return to ? { to } : { removed: `R4 removed ${rt}.${k.slice(rt.length + 1)}.${key} (STU3) when it renamed ${k.slice(rt.length + 1)} to ${el}; leave it out` };
  }
  return null;
}

/**
 * Synthetic document Bundles for the determinism regression (parity v3, large-Bundle non-determinism): n entries against
 * R4 core — one Composition whose section lists every other entry (so checkAllInterlinked walks the whole Bundle), a
 * Patient and a Practitioner, then Encounter / Observation / Condition / MedicationRequest rows with terminology and
 * references, plus periodic defects so the canonical output is not empty. Pure: the same n gives the same Bundle.
 * No clinical or IG data: public LOINC / SNOMED codes only.
 */
type Json = Record<string, any>;

const uuid = (i: number): string => `urn:uuid:00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;

const LOINC: Array<[string, string, string]> = [
  ["718-7", "Hemoglobin [Mass/volume] in Blood", "g/dL"],
  ["2345-7", "Glucose [Mass/volume] in Serum or Plasma", "mg/dL"],
  ["2160-0", "Creatinine [Mass/volume] in Serum or Plasma", "mg/dL"],
  ["6690-2", "Leukocytes [#/volume] in Blood by Automated count", "10*3/uL"],
  ["2951-2", "Sodium [Moles/volume] in Serum or Plasma", "mmol/L"],
];
const SNOMED: Array<[string, string]> = [
  ["38341003", "Hypertensive disorder, systemic arterial (disorder)"],
  ["73211009", "Diabetes mellitus (disorder)"],
  ["195967001", "Asthma (disorder)"],
  ["13645005", "Chronic obstructive lung disease (disorder)"],
];

function clinical(i: number, patient: string, practitioner: string, encounter: string): Json {
  const kind = i % 4;
  const defect = (every: number): boolean => i % every === 0;
  if (kind === 0) {
    return {
      resourceType: "Encounter",
      id: `enc-${i}`,
      status: defect(97) ? "not-a-status" : "finished",
      class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
      subject: { reference: patient },
      participant: [{ individual: { reference: practitioner } }],
    };
  }
  if (kind === 1) {
    const [code, display, unit] = LOINC[i % LOINC.length];
    return {
      resourceType: "Observation",
      id: `obs-${i}`,
      status: "final",
      category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] }],
      code: { coding: [{ system: "http://loinc.org", code: defect(53) ? "99999-9" : code, display: defect(37) ? "Not the right display" : display }] },
      subject: { reference: defect(71) ? uuid(9_000_000 + i) : patient },
      encounter: { reference: encounter },
      effectiveDateTime: "2026-01-02T03:04:05+08:00",
      valueQuantity: { value: 1 + i / 10, unit, system: "http://unitsofmeasure.org", code: unit },
    };
  }
  if (kind === 2) {
    const [code, display] = SNOMED[i % SNOMED.length];
    return {
      resourceType: "Condition",
      id: `cond-${i}`,
      clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
      code: { coding: [{ system: "http://snomed.info/sct", code, display }] },
      subject: { reference: patient },
      encounter: { reference: encounter },
    };
  }
  return {
    resourceType: "MedicationRequest",
    id: `med-${i}`,
    status: "active",
    intent: "order",
    medicationCodeableConcept: { text: `Medication ${i % 7}` },
    subject: { reference: patient },
    encounter: { reference: encounter },
    requester: { reference: practitioner },
    dosageInstruction: [{ text: "once daily", timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } } }],
  };
}

/** A document Bundle of exactly `n` entries (n >= 4). */
export function syntheticBundle(n: number): Json {
  const composition = uuid(1);
  const patient = uuid(2);
  const practitioner = uuid(3);
  const entries: Json[] = [
    {
      fullUrl: patient,
      resource: { resourceType: "Patient", id: "pat", name: [{ family: "Synthetic", given: ["Bundle"] }], gender: "unknown", birthDate: "1970-01-01" },
    },
    {
      fullUrl: practitioner,
      resource: { resourceType: "Practitioner", id: "prac", name: [{ family: "Synthetic" }] },
    },
  ];
  let encounter = uuid(4);
  for (let i = 4; i <= n; i++) {
    const fullUrl = uuid(i);
    if (i % 4 === 0) encounter = fullUrl;
    entries.push({ fullUrl, resource: clinical(i, patient, practitioner, encounter) });
  }
  return {
    resourceType: "Bundle",
    id: `synthetic-${n}`,
    type: "document",
    identifier: { system: "urn:ietf:rfc:3986", value: `urn:uuid:00000000-0000-4000-9000-${n.toString(16).padStart(12, "0")}` },
    timestamp: "2026-01-02T03:04:05+08:00",
    entry: [
      {
        fullUrl: composition,
        resource: {
          resourceType: "Composition",
          id: "comp",
          status: "final",
          type: { coding: [{ system: "http://loinc.org", code: "11506-3", display: "Progress note" }] },
          subject: { reference: patient },
          date: "2026-01-02T03:04:05+08:00",
          author: [{ reference: practitioner }],
          title: "Synthetic document",
          section: [{ title: "All", entry: entries.slice(2).map((e) => ({ reference: e.fullUrl })) }],
        },
      },
      ...entries,
    ],
  };
}

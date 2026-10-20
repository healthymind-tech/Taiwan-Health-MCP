/**
 * Pure re-implementation of the HL7 Java validator's URI checks
 * (InstanceValidator.checkPrimitive / validateReference / resolveUrl and
 * StandAloneValidatorFetcher.resolveURL, validator_cli 7.0.1):
 *
 *  - `urn:oid:` values must be valid OIDs (OIDUtilities.isValidOID and the
 *    "at least three arcs" rule) → error "OIDs must be valid (<oid>)";
 *  - `urn:uuid:` values must be lowercase RFC 4122 UUIDs → error;
 *  - an absolute `uri` / `url` in the HL7-owned spaces (http://hl7.org/fhir…,
 *    http://terminology.hl7.org/…, http://fhir.org/guides…) that does not
 *    resolve to a known definition → error "No definition could be found for
 *    URL value '<url>'" (Type_Specific_Checks_DT_URL_Resolve). URLs outside
 *    those spaces are never errors here.
 *
 * Whether a URL "resolves" is decided by the caller-supplied `exists` lookup
 * (conformance resources held locally, across every loaded package). To stay
 * on the safe side, any HL7 URL whose owning package we cannot judge (e.g. an
 * IG under http://hl7.org/fhir/us/...) is treated as resolvable.
 */

/** Java String.split(regex) semantics: trailing empty strings are removed. */
function javaSplit(s: string, sep: string): string[] {
  const parts = s.split(sep);
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Port of OIDUtilities.isValidOID + RegexUtils.splitRegexMatch (7.0.1) and the
 * extra rule in InstanceValidator.checkPrimitive:
 * `isValidOID(oid) && (oid.lastIndexOf('.') >= 4 || oid.startsWith("1.3"))`.
 * Note Java's split drops trailing empties, so "2.16.886.101." is valid.
 */
export function oidValid(oid: string): boolean {
  if (oid.length < 2 || oid[0] < "0" || oid[0] > "2" || oid[1] !== ".") return false;
  const parts = javaSplit(oid, ".");
  if (parts.length < 2 || !parts.every((p) => /^(0|[1-9][0-9]*)$/.test(p))) return false;
  return oid.lastIndexOf(".") >= 4 || oid.startsWith("1.3");
}

/** Port of UUIDUtilities.isValidUUID (lowercase only). */
export function uuidValid(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid);
}

/** Syntax issues of an OID / UUID URN (null when fine or not applicable). */
export function urnSyntaxIssue(value: string, type: string): string | null {
  if (value.startsWith("urn:oid:")) {
    let oid = value.slice(8);
    if (type === "canonical" && oid.includes("|")) oid = oid.slice(0, oid.indexOf("|"));
    return oidValid(oid) ? null : `OIDs must be valid (${oid})`;
  }
  if (value.startsWith("urn:uuid:")) {
    let s = value;
    if (s.includes("#")) s = s.slice(0, s.indexOf("#"));
    if (type === "canonical" && s.includes("|")) s = s.slice(0, s.lastIndexOf("|"));
    s = s.slice(9);
    return uuidValid(s) ? null : `UUIDs must be valid and lowercase (${s})`;
  }
  if (value.startsWith("oid:")) return "URI values cannot start with oid:";
  if (value.startsWith("uuid:")) return "URI values cannot start with uuid:";
  return null;
}

/** Port of InstanceValidator.isKnownSpace (7.0.1). */
export function isKnownSpace(url: string): boolean {
  return url.startsWith("http://hl7.org/fhir") || url.startsWith("http://terminology.hl7.org/") || url.startsWith("http://fhir.org/guides");
}

/**
 * Port of SIDUtilities.CODE_SYSTEMS (7.0.1, verified against the decompiled
 * class): the `http://hl7.org/fhir/sid/...` code systems the HL7 validator
 * treats as known without a CodeSystem resource. Everything else under
 * `/sid/` — notably `icd-10-pcs`, `us-mbi`, `eui-48` — is NOT in the list:
 * validator_cli reports "No definition could be found for URL value" for it
 * (evaluation v6: `http://hl7.org/fhir/sid/icd-10-pcs`; the code itself only
 * gets the UNKNOWN_CODESYSTEM warning, confirmed with the v8 P-* probes).
 */
const SID_CODE_SYSTEMS = new Set([
  "http://hl7.org/fhir/sid/ndc", "http://hl7.org/fhir/sid/icpc-2", "http://hl7.org/fhir/sid/icpc-1", "http://hl7.org/fhir/sid/icpc-1-nl",
  "http://hl7.org/fhir/sid/icd-9", "http://hl7.org/fhir/sid/icd-10", "http://hl7.org/fhir/sid/cvx", "http://hl7.org/fhir/sid/srt",
  "http://hl7.org/fhir/sid/icd-10-vn", "http://hl7.org/fhir/sid/icd-10-cm", "http://hl7.org/fhir/sid/icd-10-am", "http://hl7.org/fhir/sid/icd-9-cm",
  "http://hl7.org/fhir/sid/icf-nl", "http://hl7.org/fhir/sid/ca-hc-npn", "http://hl7.org/fhir/sid/ca-hc-din", "http://hl7.org/fhir/sid/dsm5",
  "http://hl7.org/fhir/sid/ex-icd-10-procedures",
]);

/** Port of SIDUtilities.ID_SYSTEMS (7.0.1); `isPassPortSID` is matched separately. */
const SID_ID_SYSTEMS = new Set([
  "http://hl7.org/fhir/sid/us-ssn", "http://hl7.org/fhir/sid/us-npi",
  "http://hl7.org/fhir/sid/eui-48/bluetooth", "http://hl7.org/fhir/sid/eui-48/ethernet",
]);

/** SIDUtilities.isknownCodeSystem: a `/sid/` code system the HL7 validator accepts as a Coding.system without a definition. */
export function isKnownSidCodeSystem(system: string): boolean {
  return SID_CODE_SYSTEMS.has(system);
}

/** SIDUtilities.isKnownSID (code systems + id systems + passport SIDs). */
export function isKnownSid(url: string): boolean {
  return SID_CODE_SYSTEMS.has(url) || SID_ID_SYSTEMS.has(url) || /^http:\/\/hl7\.org\/fhir\/sid\/passport-[a-zA-Z]{3}$/.test(url);
}

/** Port of InstanceValidator.isDefinitionURL / isKnownMappingUri + SpecialExtensions.KNOWN_EXTENSIONS (7.0.1). */
const KNOWN_URLS = new Set([
  "http://hl7.org/fhirpath/System.Boolean", "http://hl7.org/fhirpath/System.String", "http://hl7.org/fhirpath/System.Integer",
  "http://hl7.org/fhirpath/System.Decimal", "http://hl7.org/fhirpath/System.Date", "http://hl7.org/fhirpath/System.Time",
  "http://hl7.org/fhirpath/System.DateTime", "http://hl7.org/fhirpath/System.Quantity", "urn:ietf:bcp:13",
  "http://hl7.org/fhir/CompartmentDefinition/Patient", "http://hl7.org/fhir/CompartmentDefinition/Practitioner",
  "http://hl7.org/fhir/CompartmentDefinition/Group", "http://hl7.org/fhir/CompartmentDefinition/Device",
  "http://hl7.org/fhir/CompartmentDefinition/Encounter", "http://hl7.org/fhir/SearchParameter/Resource-filter",
  "http://hl7.org/fhir/build/StructureDefinition/binding-definition", "http://hl7.org/fhir/build/StructureDefinition/definition",
  "http://hl7.org/fhir/StructureDefinition/codesystem-properties-mode", "http://hl7.org/fhir/StructureDefinition/elementdefinition-type-must-support",
  "http://hl7.org/fhir/StructureDefinition/instance-description", "http://hl7.org/fhir/StructureDefinition/instance-name",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-conformance-derivedFrom",
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-fmm-support", "http://hl7.org/fhir/StructureDefinition/structuredefinition-rdf-type",
  // isKnownMappingUri entries in the HL7 space
  "http://hl7.org/fhir/auditevent", "http://hl7.org/fhir/composition", "http://hl7.org/fhir/consent", "http://hl7.org/fhir/documentreference",
  "http://hl7.org/fhir/fivews", "http://hl7.org/fhir/interface", "http://hl7.org/fhir/logical", "http://hl7.org/fhir/object-implementation",
  "http://hl7.org/fhir/provenance", "http://hl7.org/fhir/rr", "http://hl7.org/fhir/w5", "http://hl7.org/fhir/workflow",
]);

/** R4 + R5 resource type names (StandAloneValidatorFetcher.findBaseUrl looks for one as a path segment). */
const RESOURCE_NAMES = new Set(
  (
    "Account ActivityDefinition ActorDefinition AdministrableProductDefinition AdverseEvent AllergyIntolerance Appointment AppointmentResponse " +
    "ArtifactAssessment AuditEvent Basic Binary BiologicallyDerivedProduct BiologicallyDerivedProductDispense BodyStructure Bundle " +
    "CanonicalResource CapabilityStatement CapabilityStatement2 CarePlan CareTeam CatalogEntry ChargeItem ChargeItemDefinition Citation Claim " +
    "ClaimResponse ClinicalImpression ClinicalUseDefinition CodeSystem Communication CommunicationRequest CompartmentDefinition Composition " +
    "ConceptMap Condition ConditionDefinition Consent Contract Coverage CoverageEligibilityRequest CoverageEligibilityResponse DetectedIssue " +
    "Device DeviceAssociation DeviceDefinition DeviceDispense DeviceMetric DeviceRequest DeviceUsage DeviceUseStatement DiagnosticReport " +
    "DocumentManifest DocumentReference DomainResource EffectEvidenceSynthesis Encounter EncounterHistory Endpoint EnrollmentRequest " +
    "EnrollmentResponse EpisodeOfCare EventDefinition Evidence EvidenceReport EvidenceVariable ExampleScenario ExplanationOfBenefit " +
    "FamilyMemberHistory Flag FormularyItem GenomicStudy Goal GraphDefinition Group GuidanceResponse HealthcareService ImagingSelection " +
    "ImagingStudy Immunization ImmunizationEvaluation ImmunizationRecommendation ImplementationGuide Ingredient InsurancePlan " +
    "InventoryItem InventoryReport Invoice Library Linkage List Location ManufacturedItemDefinition Measure MeasureReport Media Medication " +
    "MedicationAdministration MedicationDispense MedicationKnowledge MedicationRequest MedicationStatement MedicationUsage " +
    "MedicinalProduct MedicinalProductAuthorization MedicinalProductContraindication MedicinalProductDefinition MedicinalProductIndication " +
    "MedicinalProductIngredient MedicinalProductInteraction MedicinalProductManufactured MedicinalProductPackaged " +
    "MedicinalProductPharmaceutical MedicinalProductUndesirableEffect MessageDefinition MessageHeader MetadataResource MolecularDefinition " +
    "MolecularSequence NamingSystem NutritionIntake NutritionOrder NutritionProduct Observation ObservationDefinition OperationDefinition " +
    "OperationOutcome Organization OrganizationAffiliation PackagedProductDefinition Parameters Patient PaymentNotice PaymentReconciliation " +
    "Permission Person PlanDefinition Practitioner PractitionerRole Procedure Provenance Questionnaire QuestionnaireResponse " +
    "RegulatedAuthorization RelatedPerson RequestGroup RequestOrchestration Requirements ResearchDefinition ResearchElementDefinition " +
    "ResearchStudy ResearchSubject Resource RiskAssessment RiskEvidenceSynthesis Schedule SearchParameter ServiceRequest Slot Specimen " +
    "SpecimenDefinition StructureDefinition StructureMap Subscription SubscriptionStatus SubscriptionTopic Substance SubstanceDefinition " +
    "SubstanceNucleicAcid SubstancePolymer SubstanceProtein SubstanceReferenceInformation SubstanceSourceMaterial SubstanceSpecification " +
    "SupplyDelivery SupplyRequest Task TerminologyCapabilities TestPlan TestReport TestScript Transport ValueSet VerificationResult VisionPrescription"
  ).split(" "),
);

/** Port of StandAloneValidatorFetcher.findBaseUrl (7.0.1): URL prefix before the first resource-type path segment. */
export function findBaseUrl(url: string): string | null {
  const p = url.split("/");
  for (let i = 1; i < p.length; i++) {
    if (RESOURCE_NAMES.has(p[i])) return p.slice(0, i).join("/");
  }
  return null;
}

/**
 * Port of StandAloneValidatorFetcher.resolveURL + InstanceValidator.validateReference
 * (7.0.1). Should an unresolvable URL be an error? Mirrors resolveURL's decision tree
 * for URLs in the HL7 spaces; returns true only when the HL7 validator would
 * certainly fail to resolve it (given `exists` = false).
 */
export function hl7UrlMustResolve(url: string): boolean {
  if (!isKnownSpace(url)) return false;
  const u = url.includes("|") ? url.slice(0, url.lastIndexOf("|")) : url;
  if (KNOWN_URLS.has(u) || isKnownSid(u)) return false;
  // Versioned core URLs (http://hl7.org/fhir/5.0/StructureDefinition/...) are resolved
  // from another FHIR version's package: we cannot judge — treat as resolvable.
  if (/^http:\/\/hl7\.org\/fhir\/(\d+\.\d+|R\d|R4B)\//.test(u)) return false;
  const base = findBaseUrl(u);
  if (base === null) return u.startsWith("http://hl7.org/fhir");
  if (base === "http://hl7.org/fhir" || base === "http://terminology.hl7.org") return true;
  // Any other base under terminology.hl7.org has no owning package in the local
  // cache (findCanonicalInLocalCache → null) → unresolvable for the HL7 validator.
  if (base.startsWith("http://terminology.hl7.org/")) return true;
  // Other IGs under hl7.org / fhir.org: the HL7 validator would fetch the owning
  // package from the registry; we cannot, so never fail these.
  return false;
}

export function urlResolveMessage(url: string): string {
  return `No definition could be found for URL value '${url}'`;
}

/** Canonical-resource types whose `.url` is the resource's own identity (port of InstanceValidator.isCanonicalURLElement). */
const CANONICAL_RESOURCES = new Set(
  (
    "ActivityDefinition ActorDefinition CapabilityStatement ChargeItemDefinition Citation CodeSystem CompartmentDefinition ConceptMap " +
    "ConditionDefinition EffectEvidenceSynthesis EventDefinition Evidence EvidenceReport EvidenceVariable ExampleScenario GraphDefinition " +
    "ImplementationGuide Library Measure MessageDefinition NamingSystem ObservationDefinition OperationDefinition PlanDefinition Questionnaire " +
    "Requirements ResearchDefinition ResearchElementDefinition RiskEvidenceSynthesis SearchParameter SpecimenDefinition StructureDefinition " +
    "StructureMap SubscriptionTopic TerminologyCapabilities TestPlan TestScript ValueSet CanonicalResource MetadataResource"
  ).split(" "),
);

/** Element base paths whose URI value is not checked for resolution by the HL7 validator. */
export function uriResolutionExempt(basePath: string): boolean {
  if (basePath === "Bundle.entry.fullUrl") return true;
  const p = basePath.split(".");
  return p.length === 2 && p[1] === "url" && CANONICAL_RESOURCES.has(p[0]);
}

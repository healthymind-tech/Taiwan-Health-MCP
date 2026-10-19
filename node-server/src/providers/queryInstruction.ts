/**
 * Query-side task instructions for instruction-aware embedding models.
 *
 * Some embedding models are trained asymmetrically: documents are embedded as
 * they are, and a search query is prefixed with a one-line task description.
 * Qwen3-Embedding (and gte-Qwen2-*-instruct, same recipe) expects
 *
 *     Instruct: <task description>\nQuery: <query text>
 *
 * and loses noticeably without it on short / abbreviated queries (offline,
 * Qwen3-Embedding-0.6B on Taiwanese billing-code abbreviations: top-5 43% → 63%).
 *
 * Only *query* embeddings are ever instructed. Stored vectors (embed jobs,
 * inputType "document") and the identity fingerprint probes (which call the
 * adapters directly) never are, so turning this on or off — or changing a task
 * text — needs no re-index.
 *
 * Per route member, `params.query_instruction` overrides the model default:
 *   absent / "auto" → the default for the model family (none for unknown models);
 *   "off"           → never instruct;
 *   any other text  → that task description, for every search task.
 */

import type { LlmProfile } from "../admin/llmProfiles.js";

/** What a query embedding is searched against — picks the task description. */
export type QueryTask = "icd" | "loinc" | "snomed" | "ig_concept" | "food" | "supplement" | "generic";

export const QUERY_TASKS: QueryTask[] = ["icd", "loinc", "snomed", "ig_concept", "food", "supplement", "generic"];

/**
 * Default task descriptions (English, as the models were trained; queries may be
 * Chinese, English or chart abbreviations — the descriptions say so).
 */
export const DEFAULT_QUERY_TASKS: Record<QueryTask, string> = {
  icd:
    "Given a diagnosis, disease or clinical condition written in Chinese, English or as a medical abbreviation, " +
    "retrieve the ICD-10-CM diagnosis that it names",
  loinc:
    "Given a laboratory test name or abbreviation written in Chinese or English, retrieve the LOINC laboratory " +
    "test that it names",
  snomed:
    "Given a clinical term in Chinese or English (a disorder, finding, procedure or substance), retrieve the " +
    "SNOMED CT concept with the same meaning",
  ig_concept:
    "Given a clinical order, test, procedure, service or condition as written in a Taiwanese medical record " +
    "(Chinese, English or abbreviations), retrieve the matching item of a medical code list",
  food: "Given a food or ingredient name, retrieve the matching food or ingredient",
  supplement: "Given a health concern or product name, retrieve the matching health supplement products",
  generic: "Given a medical search query, retrieve the matching medical terminology entry",
};

/** Model families known to want an instructed query, and how to write it. */
const FAMILIES: Array<{ re: RegExp; format: (task: string, text: string) => string }> = [
  // Qwen3-Embedding-0.6B / 4B / 8B under any serving name: "qwen3-embedding:0.6b-q8_0",
  // "Qwen/Qwen3-Embedding-4B", "qwen3-embedding-4b", "Qwen3-Embedding-0.6B-4bit-DWQ".
  { re: /qwen3[-_ .:/]?embedding/i, format: (task, text) => `Instruct: ${task}\nQuery: ${text}` },
  // gte-Qwen2-*-instruct uses the same recipe.
  { re: /gte[-_]?qwen2.*instruct/i, format: (task, text) => `Instruct: ${task}\nQuery: ${text}` },
];

function familyOf(profile: Pick<LlmProfile, "model" | "params">): (typeof FAMILIES)[number] | null {
  const names = [profile.model, typeof profile.params?.base_model === "string" ? profile.params.base_model : ""];
  return FAMILIES.find((f) => names.some((n) => n && f.re.test(n))) ?? null;
}

/** Does this model use query instructions by default (the console shows "auto → on")? */
export function instructsByDefault(profile: Pick<LlmProfile, "model" | "params">): boolean {
  return familyOf(profile) !== null;
}

/**
 * The text actually sent to the endpoint for a search query. Unchanged when the
 * model takes no instruction, the member turned it off, or no task was given.
 */
export function formatQueryText(profile: Pick<LlmProfile, "model" | "params">, task: QueryTask | undefined, text: string): string {
  if (!task) return text;
  const setting = profile.params?.query_instruction;
  const raw = typeof setting === "string" ? setting.trim() : "";
  if (raw.toLowerCase() === "off") return text;
  const family = familyOf(profile);
  const custom = raw && raw.toLowerCase() !== "auto" ? raw : null;
  if (!family && !custom) return text;
  const description = custom ?? DEFAULT_QUERY_TASKS[task];
  return family ? family.format(description, text) : `Instruct: ${description}\nQuery: ${text}`;
}

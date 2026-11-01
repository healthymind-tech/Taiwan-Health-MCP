/**
 * Cross-version extensions (`http://hl7.org/fhir/{v}/StructureDefinition/extension-{path}`): port of
 * XVerExtensionManager + XVerExtensionManagerOld (org.hl7.fhir.r5.utils.xver, validator 7.0.1). validator_cli loads the
 * `xver-paths-{v}.json` tables of hl7.fhir.xver-extensions#0.1.0 and generates the extension definition of any such url
 * whose element path the table lists with types or child elements; the tables ship with the code
 * (data/xver/*.json.gz, CC0-1.0) so this works offline.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

type Json = Record<string, any>;

export type XverStatus = "BadVersion" | "Unknown" | "Invalid" | "NotAllowed" | "Valid";

/** Marker property on a generated definition (XVER_EXT_MARKER / XVER_VER_MARKER): the source FHIR version. */
export const XVER_SOURCE = "__xverSource";

function dataDir(): string {
  const env = process.env.BUNDLED_DATA_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  return fileURLToPath(new URL("../data/", import.meta.url));
}

const lists = new Map<string, Json | null>();

function table(v: string): Json | null {
  if (lists.has(v)) return lists.get(v)!;
  let t: Json | null = null;
  try {
    t = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir(), "xver", `xver-paths-${v}.json.gz`))).toString("utf8"));
  } catch {
    t = null; // context.hasBinaryKey false
  }
  lists.set(v, t);
  return t;
}

/** XVerExtensionManager.matchingUrl. */
export function xverMatchingUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length < 56) return false;
  return url.slice(0, 20) === "http://hl7.org/fhir/" && /^\d\.\d$/.test(url.slice(20, 23)) && url.slice(23, 54) === "/StructureDefinition/extension-";
}

/** XVerExtensionManager.getVersion / getElementId. */
export const xverVersion = (url: string): string => url.slice(20, 23);
export const xverElementId = (url: string): string => url.slice(54);

/** XVerExtensionManagerOld.status. */
export function xverStatus(url0: string): XverStatus {
  if (url0.length < 54) return "Invalid";
  const url = url0.replace(/%5Bx%5D/g, "[x]");
  const root = table(url.slice(20, 23));
  if (!root) return "BadVersion";
  const e = url.slice(54);
  const p = root[e] ?? root[`${e}[x]`];
  if (!p || typeof p !== "object") return "Unknown";
  return p.elements !== undefined || p.types !== undefined ? "Valid" : "Invalid";
}

const forceArray = (x: unknown): any[] => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);

/**
 * XVerExtensionManagerOld.getDefinition: the extension StructureDefinition (differential only — the caller generates
 * the snapshot, BaseValidator.getXverExt → generateSnapshot), for an R4 (4.0.1) context. `isResource` answers
 * IWorkerContext.getResourceNames().contains.
 */
export function xverDefinition(url0: string, isResource: (name: string) => boolean): Json | null {
  const url = url0.replace(/%5Bx%5D/g, "[x]");
  const verSource = url.slice(20, 23);
  const root = table(verSource);
  if (!root) return null;
  const e = url.slice(54);
  const p = root[e] ?? root[`${e}[x]`];
  if (!p || typeof p !== "object") return null;
  const diff: Json[] = [];
  const populateTypes = (src: Json, val: Json): void => {
    // translateDataType(verTarget = 4.0, …) leaves every R4 type as is
    for (const s0 of forceArray(src.types)) {
      const s = String(s0);
      if (s.startsWith("!")) continue;
      if (s.includes("(")) {
        const t = s.slice(0, s.indexOf("("));
        const tr: Json = { code: t };
        if (["canonical", "Reference", "CodeableReference"].includes(t)) {
          const inner = s.slice(t.length + 1, s.length - 1);
          const tps: string[] = [];
          for (const q of inner.split("|")) {
            if (q === "Any") tps.push("http://hl7.org/fhir/StructureDefinition/Resource");
            else if (q.includes(",")) {
              for (const pp of q.split(",")) if (isResource(pp)) tps.push(`http://hl7.org/fhir/StructureDefinition/${pp}`);
            } else if (isResource(q)) tps.push(`http://hl7.org/fhir/StructureDefinition/${q}`);
          }
          if (tps.length) tr.targetProfile = tps;
        }
        (val.type ??= []).push(tr);
      } else (val.type ??= []).push({ code: s });
    }
  };
  const genContents = (apath: string, item: string, elt: Json, epath: string): void => {
    const s = item.replace("[x]", "");
    diff.push({ path: epath, sliceName: s });
    if (elt.types !== undefined) {
      diff.push({ path: `${epath}.extension`, max: "0" });
      diff.push({ path: `${epath}.url`, fixedUri: s });
      const val: Json = { path: `${epath}.value[x]`, min: 1 };
      diff.push(val);
      populateTypes(elt, val);
    } else if (elt.elements !== undefined) {
      for (const ic of forceArray(elt.elements)) {
        const apathC = `${apath}.${String(ic)}`;
        const eltC = root[apathC];
        if (eltC && typeof eltC === "object") genContents(apathC, String(ic), eltC, `${epath}.extension`);
      }
      diff.push({ path: `${epath}.url`, fixedUri: s });
      diff.push({ path: `${epath}.value[x]`, max: "0" });
    } else if (elt.ref !== undefined) {
      diff.push({ path: `${epath}.url`, fixedUri: s });
    } else return; // Java: FHIRException("Internal error - unknown element …")
  };
  if (p.types !== undefined) {
    diff.push({ path: "Extension.extension", max: "0" });
    diff.push({ path: "Extension.url", fixedUri: url });
    const val: Json = { path: "Extension.value[x]", min: 1 };
    diff.push(val);
    populateTypes(p, val);
  } else if (p.elements !== undefined) {
    for (const i of forceArray(p.elements)) {
      const apath = `${e}.${String(i)}`;
      const elt = root[apath];
      if (elt && typeof elt === "object") genContents(apath, String(i), elt, "Extension.extension");
    }
    diff.push({ path: "Extension.url", fixedUri: url });
    diff.push({ path: "Extension.value[x]", max: "0" });
  } else return null;
  if (p.modifier === true) diff.unshift({ path: "Extension", isModifier: true });
  const head = e.includes(".") ? e.slice(0, e.lastIndexOf(".")) : e;
  return {
    resourceType: "StructureDefinition",
    url,
    version: "4.0.1",
    name: `Extension-${verSource}-${e}`,
    title: `Extension Definition for ${e} for Version ${verSource}`,
    status: "active",
    experimental: false,
    publisher: "FHIR Project",
    fhirVersion: "4.0.1",
    kind: "complex-type",
    abstract: false,
    context: [{ type: "element", expression: head }],
    type: "Extension",
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Extension",
    derivation: "constraint",
    differential: { element: diff },
    [XVER_SOURCE]: verSource,
  };
}

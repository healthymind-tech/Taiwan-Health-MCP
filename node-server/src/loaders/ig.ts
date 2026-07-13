/**
 * FHIR IG package loader — Node port of the IG indexing core in
 * `src/admin_jobs.py` (`_build_twcore_stage_payload` / `_build_twcore_artifact_payload`
 * / `_parse_ig_package_identity`) plus the promote step that writes
 * `fhir.ig_packages / codesystems / concepts / artifacts`.
 *
 * Scope of this module: the deterministic per-package indexer. It takes one (or
 * more) FHIR npm `package.tgz` files and writes package-scoped `fhir.*` rows,
 * byte-identical to the Python admin import. The recursive dependency fetch from
 * packages.fhir.org and the job-orchestration wrapper (staging tables /
 * checkpoints) live alongside in `igRegistry.ts` / the worker (later stage); the
 * final `fhir.*` content produced here is identical whether or not it is driven
 * by that wrapper.
 *
 * `raw_json` parity: Python stores `json.dumps(data, ensure_ascii=False)`, which
 * uses `", "` / `": "` separators, preserves key order, and emits non-ASCII
 * literally. `pyJsonStringify` reproduces that exactly.
 *
 * Run standalone:  node dist/loaders/ig.js [path/to/package.tgz ...]
 */

import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { gunzipSync, strFromU8 } from "fflate";
import { config } from "../config.js";
import { logInfo, logError, logWarning, configureLogLevel } from "../logger.js";
import * as registry from "./igRegistry.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const FHIR_CODE_DIR = process.env.FHIR_CODE_DIR || path.join(REPO_ROOT, "fhir-code");

const PARAM_LIMIT = 60000;

// Mirror of loader/loaders/twcore_loader.py CODESYSTEM_REGISTRY (name, category).
const CODESYSTEM_REGISTRY: Record<string, [string, string]> = {
  "icd-10-cm-2023-tw": ["臺灣健保署ICD-10-CM 2023年版", "diagnosis"],
  "icd-10-cm-2021-tw": ["臺灣健保署ICD-10-CM 2021年版", "diagnosis"],
  "icd-10-cm-2014-tw": ["臺灣健保署ICD-10-CM 2014年版", "diagnosis"],
  "icd-10-pcs-2023-tw": ["臺灣健保署ICD-10-PCS 2023年版", "diagnosis"],
  "organization-identifier-tw": ["臺灣醫療機構識別碼", "organization"],
  "practitioner-identifier-tw": ["臺灣醫事人員識別碼", "organization"],
  "department-nhia-tw": ["臺灣健保署就醫科別", "organization"],
  "specialty-nhia-tw": ["臺灣健保署專科醫師代碼", "organization"],
  "postal-code-tw": ["臺灣郵遞區號", "administrative"],
  "marital-status-tw": ["臺灣婚姻狀態", "administrative"],
  "occupation-dhpc-tw": ["臺灣職業代碼", "administrative"],
};

// ── Python-compatible JSON serialization ────────────────────────────────────

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
};

function pyJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    const esc = ESCAPES[c];
    if (esc) out += esc;
    else if (c < " ") out += "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
    else out += c;
  }
  return out + '"';
}

// ── Python-faithful number tokens ────────────────────────────────────────────
// `raw_json` is inserted via `::jsonb`, which normalizes key order / whitespace /
// string escaping — but NOT numbers: `3.0::jsonb` ≠ `3::jsonb`, and jsonb keeps a
// numeric's scale. So the only number that survives to differ is its textual form.
// Python emits `json.dumps`: `repr(float)` for floats (so `3.0`, `-2.0`), the
// exact digit string for ints (arbitrary precision). `JSON.parse` erases the
// int/float distinction and loses big-int precision, so we tokenize JSON
// ourselves and carry each number as the exact Python token via `PyNum`.

class PyNum {
  constructor(readonly repr: string) {}
}

/** Python `repr(float)` for the FHIR-relevant value range (decimals, no huge
 * magnitudes). Integer-valued floats get a trailing `.0`; out-of-range values
 * fall back to Python-style `e±NN` exponent form. */
function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const a = Math.abs(x);
  if (x !== 0 && (a < 1e-4 || a >= 1e16)) {
    const e = x.toExponential();
    const [m, exp] = e.split("e");
    const sign = exp[0] === "-" ? "-" : "+";
    let digits = exp.replace(/^[+-]/, "");
    if (digits.length < 2) digits = "0" + digits;
    return `${m}e${sign}${digits}`;
  }
  let s = String(x);
  if (!s.includes(".") && !s.includes("e") && !s.includes("E")) s += ".0";
  return s;
}

/** JSON parser that tags every number with its exact Python serialization. */
function parseJsonPy(text: string): any {
  let i = 0;
  const n = text.length;
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i += 1;
      else break;
    }
  };
  const str = (): string => {
    i += 1; // opening quote
    let s = "";
    for (;;) {
      const c = text[i++];
      if (c === '"') break;
      if (c === "\\") {
        const e = text[i++];
        if (e === "n") s += "\n";
        else if (e === "t") s += "\t";
        else if (e === "r") s += "\r";
        else if (e === "b") s += "\b";
        else if (e === "f") s += "\f";
        else if (e === "u") {
          s += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
          i += 4;
        } else s += e; // ", \, /, or any other escaped char
      } else s += c;
    }
    return s;
  };
  const num = (): PyNum => {
    const start = i;
    if (text[i] === "-") i += 1;
    while (i < n) {
      const c = text[i];
      if ((c >= "0" && c <= "9") || c === "." || c === "e" || c === "E" || c === "+" || c === "-")
        i += 1;
      else break;
    }
    const token = text.slice(start, i);
    if (/[.eE]/.test(token)) return new PyNum(pyFloatRepr(parseFloat(token)));
    return new PyNum(token); // int: canonical JSON token == Python str(int)
  };
  const value = (): any => {
    ws();
    const c = text[i];
    if (c === "{") {
      const o: any = {};
      i += 1;
      ws();
      if (text[i] === "}") {
        i += 1;
        return o;
      }
      for (;;) {
        ws();
        const k = str();
        ws();
        i += 1; // colon
        o[k] = value();
        ws();
        const ch = text[i++];
        if (ch === "}") break;
      }
      return o;
    }
    if (c === "[") {
      const arr: any[] = [];
      i += 1;
      ws();
      if (text[i] === "]") {
        i += 1;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        const ch = text[i++];
        if (ch === "]") break;
      }
      return arr;
    }
    if (c === '"') return str();
    if (c === "t") {
      i += 4;
      return true;
    }
    if (c === "f") {
      i += 5;
      return false;
    }
    if (c === "n") {
      i += 4;
      return null;
    }
    return num();
  };
  return value();
}

/**
 * Reproduce Python `json.dumps(value, ensure_ascii=False)`: `", "` / `": "`
 * separators, insertion-ordered keys, non-ASCII literal. Numbers come from
 * JSON.parse (so int/float distinction is lost); FHIR definitional resources use
 * integer numerics, which serialize identically — float edge cases, if any, are
 * surfaced by the byte-diff verification.
 */
function pyJsonStringify(value: any): string {
  if (value === null) return "null";
  if (value instanceof PyNum) return value.repr;
  const t = typeof value;
  if (t === "string") return pyJsonString(value);
  if (t === "number") return Number.isFinite(value) ? String(value) : "null";
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return "[" + value.map(pyJsonStringify).join(", ") + "]";
  }
  if (t === "object") {
    const parts: string[] = [];
    for (const key of Object.keys(value)) {
      parts.push(pyJsonString(key) + ": " + pyJsonStringify(value[key]));
    }
    return "{" + parts.join(", ") + "}";
  }
  return "null";
}

// ── Python str()/repr() emulation ───────────────────────────────────────────
// Artifact metadata fields are derived via Python `str(data.get(k) or "")`. When
// a FHIR field is non-string (e.g. an example Composition's `type` object or a
// Patient's `name` array) Python stringifies it with its container repr; an empty
// container is falsy so `or ""` yields "". JS `String()`/`??` differ on both
// counts, so reproduce Python's behaviour exactly.

function pyTruthy(x: any): boolean {
  if (x === null || x === undefined || x === false || x === "" || x === 0) return false;
  if (x instanceof PyNum) return parseFloat(x.repr) !== 0;
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === "object") return Object.keys(x).length > 0;
  return true;
}

/** Python repr() for a value nested inside a container. */
function pyRepr(x: any): string {
  if (x === null || x === undefined) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  if (x instanceof PyNum) return x.repr;
  if (typeof x === "number") return String(x);
  if (typeof x === "string") return pyReprStr(x);
  if (Array.isArray(x)) return "[" + x.map(pyRepr).join(", ") + "]";
  if (typeof x === "object")
    return "{" + Object.entries(x).map(([k, v]) => `${pyReprStr(k)}: ${pyRepr(v)}`).join(", ") + "}";
  return String(x);
}

function pyReprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += "\\x" + code.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + quote;
}

/** Python str() for a top-level value (strings unquoted; containers repr'd). */
function pyStr(x: any): string {
  if (typeof x === "string") return x;
  if (x === null || x === undefined) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  if (x instanceof PyNum) return x.repr;
  if (typeof x === "number") return String(x);
  if (Array.isArray(x)) return "[" + x.map(pyRepr).join(", ") + "]";
  if (typeof x === "object")
    return "{" + Object.entries(x).map(([k, v]) => `${pyReprStr(k)}: ${pyRepr(v)}`).join(", ") + "}";
  return String(x);
}

/** Python `str(a or b or … or "")`: first truthy value, str()'d; else "". */
function pyStrOr(...vals: any[]): string {
  for (const v of vals) if (pyTruthy(v)) return pyStr(v);
  return "";
}

// ── tar.gz reading ──────────────────────────────────────────────────────────

interface TarEntry {
  name: string;
  data: Uint8Array;
}

function readCStr(buf: Uint8Array, off: number, len: number): string {
  let end = off;
  const limit = off + len;
  while (end < limit && buf[end] !== 0) end += 1;
  return strFromU8(buf.subarray(off, end));
}

/** Parse a (gzip-decompressed) tar archive. Handles ustar prefix, GNU 'L' long
 * names and pax 'x' path overrides — enough for FHIR npm tarballs. */
function untar(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;
    let name = readCStr(buf, off, 100);
    const sizeStr = readCStr(buf, off + 124, 12).trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const type = String.fromCharCode(header[156]);
    const prefix = readCStr(buf, off + 345, 155);
    if (prefix) name = prefix + "/" + name;
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = strFromU8(data).replace(/\0+$/, "");
      continue;
    }
    if (type === "x" || type === "g") {
      const m = /\d+ path=([^\n]+)\n/.exec(strFromU8(data));
      if (m) longName = m[1];
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type === "0" || type === "\0" || type === "") {
      out.push({ name, data });
    }
  }
  return out;
}

function readTgz(tgzPath: string): TarEntry[] {
  return untar(gunzipSync(new Uint8Array(fs.readFileSync(tgzPath))));
}

// ── package identity ────────────────────────────────────────────────────────

export interface Identity {
  package_id: string;
  version: string;
  canonical: string;
  fhir_version: string;
  title: string;
  status: string;
  dependencies: Record<string, string>;
}

function identFromPackageJson(data: any): Identity {
  const fv = data.fhirVersions ?? data.fhirVersion;
  const fhirVersion = Array.isArray(fv) ? (fv.length ? String(fv[0]) : "") : String(fv ?? "");
  const deps: Record<string, string> = {};
  if (data.dependencies && typeof data.dependencies === "object" && !Array.isArray(data.dependencies)) {
    for (const [k, v] of Object.entries(data.dependencies)) deps[String(k)] = String(v);
  }
  return {
    package_id: String(data.name ?? ""),
    version: String(data.version ?? ""),
    canonical: String(data.canonical ?? ""),
    fhir_version: fhirVersion,
    title: String(data.title ?? data.name ?? ""),
    status: String(data.status ?? ""),
    dependencies: deps,
  };
}

function identFromIg(data: any): Identity {
  const fv = data.fhirVersion;
  const fhirVersion = Array.isArray(fv) ? (fv.length ? String(fv[0]) : "") : String(fv ?? "");
  const deps: Record<string, string> = {};
  for (const dep of data.dependsOn ?? []) {
    const pid = dep.packageId;
    const ver = dep.version;
    if (pid && ver) deps[String(pid)] = String(ver);
  }
  return {
    package_id: String(data.packageId ?? data.id ?? ""),
    version: String(data.version ?? ""),
    canonical: String(data.url ?? ""),
    fhir_version: fhirVersion,
    title: String(data.title ?? data.name ?? ""),
    status: String(data.status ?? ""),
    dependencies: deps,
  };
}

function parseIdentity(entries: TarEntry[], tgzPath: string): Identity {
  let pkgJson: any = null;
  let igRes: any = null;
  for (const e of entries) {
    if (!e.name.endsWith(".json")) continue;
    const base = e.name.split("/").pop() || "";
    const isPkg = base === "package.json";
    const isIg = igRes === null && base.includes("ImplementationGuide");
    if (!isPkg && !isIg) continue;
    let data: any;
    try {
      data = JSON.parse(strFromU8(e.data));
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    if (isPkg && "name" in data && !("resourceType" in data)) pkgJson = data;
    else if (isIg && data.resourceType === "ImplementationGuide") igRes = data;
  }

  let identity: Partial<Identity> = {};
  if (pkgJson) identity = identFromPackageJson(pkgJson);
  if ((!identity.package_id || !identity.version) && igRes) {
    const igId = identFromIg(igRes);
    for (const [k, v] of Object.entries(igId)) {
      if (!(identity as any)[k]) (identity as any)[k] = v;
    }
  }
  let packageId = identity.package_id || "";
  if (!packageId) {
    let stem = path.basename(tgzPath);
    for (const suffix of [".tgz", ".tar.gz"]) {
      if (stem.endsWith(suffix)) stem = stem.slice(0, -suffix.length);
    }
    packageId = stem || "unknown-package";
  }
  return {
    package_id: packageId,
    version: identity.version || "0.0.0",
    canonical: identity.canonical || "",
    fhir_version: identity.fhir_version || "",
    title: identity.title || "",
    status: identity.status || "",
    dependencies: identity.dependencies || {},
  };
}

// ── artifact grouping ───────────────────────────────────────────────────────

function artifactGroup(
  resourceType: string,
  packagePath: string,
  kind: string,
  baseType: string,
  derivation: string,
): [string, string] {
  if (resourceType === "ImplementationGuide") return ["implementation-guide", "Implementation guide"];
  if (packagePath.startsWith("package/example/")) return ["examples", "Examples"];
  if (resourceType === "StructureDefinition") {
    if (baseType === "Extension" || kind === "complex-type" || kind === "primitive-type")
      return ["extensions-datatypes", "Extensions & data types"];
    if (derivation === "specialization") return ["extensions-datatypes", "Extensions & data types"];
    return ["profiles", "Profiles"];
  }
  if (["ValueSet", "CodeSystem", "ConceptMap", "NamingSystem"].includes(resourceType))
    return ["terminology", "Terminology"];
  if (resourceType === "SearchParameter") return ["search-parameters", "Search parameters"];
  if (["CapabilityStatement", "OperationDefinition"].includes(resourceType))
    return ["conformance", "Conformance"];
  return [resourceType.toLowerCase(), resourceType];
}

function artifactChildCount(resourceType: string, data: any): number {
  if (resourceType === "ImplementationGuide") return ((data.definition || {}).resource || []).length;
  if (resourceType === "StructureDefinition") {
    const snap = ((data.snapshot || {}).element || []).length;
    const diff = ((data.differential || {}).element || []).length;
    return snap || diff;
  }
  if (resourceType === "CodeSystem") return (data.concept || []).length;
  if (resourceType === "ValueSet") {
    const exp = ((data.expansion || {}).contains || []).length;
    const comp = ((data.compose || {}).include || []).length;
    return exp || comp;
  }
  if (resourceType === "ConceptMap")
    return (data.group || []).reduce((acc: number, g: any) => acc + (g.element || []).length, 0);
  return 0;
}

type ArtifactCore = (string | number)[]; // 17 fields, see buildArtifactPayload

function buildArtifactPayload(entries: TarEntry[]): ArtifactCore[] {
  const resources: [string, any][] = [];
  for (const e of entries) {
    const packagePath = e.name;
    if (!(packagePath.startsWith("package/") && packagePath.endsWith(".json"))) continue;
    let data: any;
    try {
      data = parseJsonPy(strFromU8(e.data));
    } catch {
      continue;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const resourceType = String(data.resourceType ?? "");
    // Mirror Python's precedence: `not rt or rt in {Bundle} and path.endswith(.index.json)`
    if (!resourceType || (resourceType === "Bundle" && packagePath.endsWith(".index.json"))) continue;
    resources.push([packagePath, data]);
  }

  const groupingNames: Record<string, string> = {};
  const groupingByResource = new Map<string, [string, string]>();
  const groupingByUrl = new Map<string, [string, string]>();
  for (const [, data] of resources) {
    if (data.resourceType !== "ImplementationGuide") continue;
    const definition = data.definition || {};
    for (const grouping of definition.grouping || []) {
      const gid = String(grouping.id ?? "");
      if (gid) groupingNames[gid] = String(grouping.name ?? gid);
    }
    for (const item of definition.resource || []) {
      const gid = String(item.groupingId ?? "");
      if (!gid) continue;
      const gname = groupingNames[gid] ?? gid;
      const ref = (item.reference || {}).reference || "";
      if (ref.includes("/")) {
        const idx = ref.indexOf("/");
        groupingByResource.set(`${ref.slice(0, idx)}/${ref.slice(idx + 1)}`, [gid, gname]);
      }
      const canonical = ((item.reference || {}).identifier || {}).value || "";
      if (canonical) groupingByUrl.set(String(canonical), [gid, gname]);
    }
  }

  const rows: ArtifactCore[] = [];
  for (const [packagePath, data] of resources) {
    const resourceType = pyStrOr(data.resourceType);
    const artifactId = pyStrOr(data.id);
    const canonicalUrl = pyStrOr(data.url);
    const name = pyStrOr(data.name);
    const title = pyStrOr(data.title, data.display);
    const status = pyStrOr(data.status);
    const kind = pyStrOr(data.kind);
    const baseType = pyStrOr(data.type);
    const derivation = pyStrOr(data.derivation);
    const description = pyStrOr(data.description, data.purpose);
    const artifactKey = `${resourceType}/${artifactId || packagePath}`;
    let grouped = groupingByResource.get(`${resourceType}/${artifactId}`);
    if (!grouped && canonicalUrl) grouped = groupingByUrl.get(canonicalUrl);
    const [groupingId, groupingName] = grouped
      ? grouped
      : artifactGroup(resourceType, packagePath, kind, baseType, derivation);
    const childCount = artifactChildCount(resourceType, data);
    const conceptCount = resourceType === "CodeSystem" ? (data.concept || []).length : 0;
    rows.push([
      artifactKey, resourceType, artifactId, canonicalUrl, name, title, status, kind,
      baseType, derivation, groupingId, groupingName, description, packagePath,
      childCount, conceptCount, pyJsonStringify(data),
    ]);
  }
  return rows;
}

// ── codesystems / concepts ──────────────────────────────────────────────────

function* iterCodesystems(entries: TarEntry[]): Generator<[string, any]> {
  for (const e of entries) {
    const name = e.name;
    if (!(name.endsWith(".json") && name.includes("/CodeSystem-"))) continue;
    let data: any;
    try {
      data = JSON.parse(strFromU8(e.data));
    } catch {
      continue;
    }
    if (data.resourceType !== "CodeSystem") continue;
    const stem = (name.split("/").pop() || "").replace("CodeSystem-", "").replace(".json", "");
    yield [stem, data];
  }
}

// ── per-package stage payload (mirror _build_twcore_stage_payload._ingest) ───

interface PackagePayload {
  identity: Identity;
  codesystems: (string | number)[][]; // pid,pver,cs_id,name,category,count
  concepts: (string | number)[][]; // pid,pver,cs_id,code,display,definition
  artifacts: (string | number)[][]; // pid,pver,...artifactCore
}

function buildPackagePayload(entries: TarEntry[], tgzPath: string): PackagePayload {
  const identity = parseIdentity(entries, tgzPath);
  const pid = identity.package_id;
  const pver = identity.version;
  const codesystems: (string | number)[][] = [];
  const concepts: (string | number)[][] = [];
  const artifacts: (string | number)[][] = [];
  const seenCs = new Set<string>();
  const seenConcept = new Set<string>();
  const seenArtifact = new Set<string>();

  for (const [csId, data] of iterCodesystems(entries)) {
    if (seenCs.has(csId)) continue;
    seenCs.add(csId);
    const [name, category] = CODESYSTEM_REGISTRY[csId] ?? [csId, "unknown"];
    const rawConcepts = data.concept || [];
    codesystems.push([pid, pver, csId, name, category, rawConcepts.length]);
    for (const concept of rawConcepts) {
      const code = String(concept.code ?? "");
      const key = `${csId}\t${code}`;
      if (seenConcept.has(key)) continue;
      seenConcept.add(key);
      concepts.push([pid, pver, csId, code, String(concept.display ?? ""), String(concept.definition ?? "")]);
    }
  }

  for (const artifact of buildArtifactPayload(entries)) {
    const artifactKey = artifact[0] as string;
    if (seenArtifact.has(artifactKey)) continue;
    seenArtifact.add(artifactKey);
    artifacts.push([pid, pver, ...artifact]);
  }

  return { identity, codesystems, concepts, artifacts };
}

// ── multi-package stage payload (mirror _build_twcore_stage_payload) ─────────

export interface TwcoreStagePayload {
  identities: Identity[];
  /** pid, pver, cs_id, name, category, concept_count */
  codesystems: (string | number)[][];
  /** pid, pver, cs_id, code, display, definition */
  concepts: (string | number)[][];
  /** pid, pver, ...17 artifact fields (artifact_key … raw_json) */
  artifacts: (string | number)[][];
}

/**
 * Faithful port of `_build_twcore_stage_payload`: ingest the primary package
 * (candidate default IG) first, then any dependency packages, each as its own
 * package-scoped payload. Returns the aggregated tuple lists for staging.
 */
export function buildTwcoreStagePayload(
  rootPath: string,
  extraPaths: string[] = [],
): TwcoreStagePayload {
  const identities: Identity[] = [];
  const codesystems: (string | number)[][] = [];
  const concepts: (string | number)[][] = [];
  const artifacts: (string | number)[][] = [];
  for (const p of [rootPath, ...extraPaths]) {
    const pp = buildPackagePayload(readTgz(p), p);
    identities.push(pp.identity);
    codesystems.push(...pp.codesystems);
    concepts.push(...pp.concepts);
    artifacts.push(...pp.artifacts);
  }
  return { identities, codesystems, concepts, artifacts };
}

// ── DB write ────────────────────────────────────────────────────────────────

/** Batch INSERT with a trailing NOW() column and optional per-column casts. */
async function batchInsertWithNow(
  client: pg.PoolClient,
  table: string,
  cols: string[],
  nowCol: string,
  rows: (string | number)[][],
  casts: Record<string, string> = {},
): Promise<void> {
  const ncols = cols.length;
  const batchRows = Math.floor(PARAM_LIMIT / ncols);
  for (let i = 0; i < rows.length; i += batchRows) {
    const slice = rows.slice(i, i + batchRows);
    const values: string[] = [];
    const params: (string | number)[] = [];
    slice.forEach((rec, ri) => {
      const ph = cols.map((col, ci) => `$${ri * ncols + ci + 1}${casts[col] ?? ""}`);
      values.push(`(${ph.join(",")}, NOW())`);
      params.push(...rec);
    });
    await client.query(
      `INSERT INTO ${table} (${cols.join(",")}, ${nowCol}) VALUES ${values.join(",")}`,
      params,
    );
  }
}

const ARTIFACT_COLS = [
  "package_id", "package_version", "artifact_key", "resource_type", "artifact_id",
  "canonical_url", "name", "title", "status", "kind", "base_type", "derivation",
  "grouping_id", "grouping_name", "description", "package_path", "child_count",
  "concept_count", "raw_json",
];

/** Index one or more packages (primary first) into fhir.* in a single
 * transaction, mirroring the promote step of `_run_ig_import_job`. */
export async function indexPackages(pool: pg.Pool, tgzPaths: string[]): Promise<void> {
  const payloads = tgzPaths.map((p) => {
    logInfo(`Parsing ${p} ...`);
    return buildPackagePayload(readTgz(p), p);
  });

  const existingDefault = await pool.query<{ package_id: string }>(
    "SELECT package_id FROM fhir.ig_packages WHERE is_default LIMIT 1",
  );
  const existing = existingDefault.rows[0]?.package_id ?? null;
  const primaryId = payloads.length ? payloads[0].identity.package_id : null;
  const makePrimaryDefault = existing === null || existing === primaryId;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (let idx = 0; idx < payloads.length; idx += 1) {
      const { identity } = payloads[idx];
      const isDefault = idx === 0 && makePrimaryDefault;
      await client.query(
        `INSERT INTO fhir.ig_packages
           (package_id, version, canonical, fhir_version, title, status, is_default, dependencies, imported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())
         ON CONFLICT (package_id, version) DO UPDATE SET
           canonical=EXCLUDED.canonical, fhir_version=EXCLUDED.fhir_version,
           title=EXCLUDED.title, status=EXCLUDED.status,
           dependencies=EXCLUDED.dependencies, imported_at=NOW()`,
        [
          identity.package_id, identity.version, identity.canonical, identity.fhir_version,
          identity.title, identity.status, isDefault,
          pyJsonStringify(identity.dependencies),
        ],
      );
    }

    // Per-package replace (concepts cascade from codesystems).
    for (const { identity } of payloads) {
      await client.query(
        "DELETE FROM fhir.artifacts WHERE package_id=$1 AND package_version=$2",
        [identity.package_id, identity.version],
      );
      await client.query(
        "DELETE FROM fhir.codesystems WHERE package_id=$1 AND package_version=$2",
        [identity.package_id, identity.version],
      );
    }

    for (const { identity, codesystems, concepts, artifacts } of payloads) {
      if (codesystems.length) {
        await batchInsertWithNow(
          client,
          "fhir.codesystems",
          ["package_id", "package_version", "cs_id", "name", "category", "concept_count"],
          "fetched_at",
          codesystems,
        );
      }
      if (concepts.length) {
        const ncols = 6;
        const batchRows = Math.floor(PARAM_LIMIT / ncols);
        for (let i = 0; i < concepts.length; i += batchRows) {
          const slice = concepts.slice(i, i + batchRows);
          const values: string[] = [];
          const params: (string | number)[] = [];
          slice.forEach((rec, ri) => {
            values.push(`(${rec.map((_, ci) => `$${ri * ncols + ci + 1}`).join(",")})`);
            params.push(...rec);
          });
          await client.query(
            "INSERT INTO fhir.concepts (package_id, package_version, cs_id, code, display, definition) VALUES " +
              values.join(","),
            params,
          );
        }
      }
      if (artifacts.length) {
        await batchInsertWithNow(client, "fhir.artifacts", ARTIFACT_COLS, "imported_at", artifacts, {
          raw_json: "::jsonb",
        });
      }
      logInfo(
        `  ${identity.package_id}#${identity.version}: ${codesystems.length} CodeSystems, ` +
          `${concepts.length} concepts, ${artifacts.length} artifacts.`,
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── recursive dependency fetch (mirror _fetch_ig_dependencies) ───────────────

//: Safety cap on the recursive closure size (root + dependency IGs) per import.
const IG_DEP_MAX_PACKAGES = 50;

/** Read package identity from a local .tgz path (same as Python `_parse_ig_package_identity`). */
function parseIgPackageIdentity(tgzPath: string): Identity {
  return parseIdentity(readTgz(tgzPath), tgzPath);
}

/** `(package_id, version)` set already present in fhir.ig_packages. */
async function installedIgPackages(pool: pg.Pool): Promise<Set<string>> {
  const res = await pool.query<{ package_id: string; version: string }>(
    "SELECT package_id, version FROM fhir.ig_packages",
  );
  return new Set(res.rows.map((r) => `${r.package_id}\t${r.version}`));
}

interface MissingDep {
  package_id: string;
  version: string;
  reason: string;
}

/**
 * Recursively fetch (BFS) every declared dependency IG not already installed.
 * Each package's dependencies are read from its own package.json (registry
 * metadata omits them). Returns `{depPaths, missing}` where `missing` lists deps
 * the registry could not supply — surfaced for manual upload, never dropped.
 */
export async function fetchIgDependencies(
  pool: pg.Pool,
  rootPath: string,
  tmpdir: string,
  base: string,
  fallback: string | null,
): Promise<{ depPaths: string[]; missing: MissingDep[] }> {
  const installed = await installedIgPackages(pool);
  const rootIdentity = parseIgPackageIdentity(rootPath);
  const seen = new Set<string>([`${rootIdentity.package_id}\t${rootIdentity.version}`]);

  const queue: [string, string][] = [];
  const queueKeys = new Set<string>();
  const enqueue = (deps: Record<string, string>): void => {
    for (const [depId, depVer] of Object.entries(deps || {})) {
      const key = `${depId}\t${depVer}`;
      if (seen.has(key) || installed.has(key) || queueKeys.has(key)) continue;
      queue.push([String(depId), String(depVer)]);
      queueKeys.add(key);
    }
  };

  enqueue(rootIdentity.dependencies || {});

  const depPaths: string[] = [];
  const missing: MissingDep[] = [];
  let idx = 0;
  while (queue.length && depPaths.length < IG_DEP_MAX_PACKAGES) {
    const [depId, depVer] = queue.shift()!;
    const key = `${depId}\t${depVer}`;
    if (seen.has(key) || installed.has(key)) continue;
    seen.add(key);
    let data: Buffer;
    let resolved: string;
    try {
      const meta = await registry.getMetadata(base, depId);
      resolved = registry.resolveVersion(meta, depVer || null);
      data = await registry.downloadTarball(base, depId, resolved, { meta, fallback });
    } catch (exc) {
      if (exc instanceof registry.RegistryError) {
        missing.push({ package_id: depId, version: depVer, reason: String(exc.message) });
        logWarning(`Dependency ${depId}@${depVer} could not be fetched: ${exc.message}`);
        continue;
      }
      throw exc;
    }
    idx += 1;
    const depPath = path.join(tmpdir, `ig-dep-${idx}.tgz`);
    fs.writeFileSync(depPath, data);
    depPaths.push(depPath);
    logInfo(`Fetched dependency IG ${depId}@${resolved}`);
    const depIdentity = parseIgPackageIdentity(depPath);
    enqueue(depIdentity.dependencies || {});
  }

  return { depPaths, missing };
}

/** Materialize the root IG .tgz to a local path (registry coordinate or local file). */
export async function acquireIgRoot(
  coordinate: string | null,
  localRoot: string | null,
  tmpdir: string,
  base: string,
  fallback: string | null,
): Promise<string> {
  if (coordinate) {
    const [packageId, version] = registry.parseCoordinate(coordinate);
    if (!packageId) throw new Error("registry IG import requires a package id");
    const meta = await registry.getMetadata(base, packageId);
    const resolved = registry.resolveVersion(meta, version);
    const data = await registry.downloadTarball(base, packageId, resolved, { meta, fallback });
    const dest = path.join(tmpdir, "ig-root.tgz");
    fs.writeFileSync(dest, data);
    logInfo(`Fetched root IG ${packageId}@${resolved} from registry`);
    return dest;
  }
  if (!localRoot) throw new Error("IG import requires a registry coordinate or a local root path");
  return localRoot;
}

function firstGlob(dir: string, test: (n: string) => boolean): string | null {
  if (!fs.existsSync(dir)) return null;
  const matches = fs.readdirSync(dir).filter(test).sort();
  return matches.length ? path.join(dir, matches[0]) : null;
}

/**
 * CLI:
 *   ig.js <pkg.tgz> [more.tgz ...]   index the given local package(s) only
 *   ig.js --registry <id[@ver]> [--deps]   fetch root from registry, optionally
 *                                          recursively fetch + index its deps
 *   ig.js --root <pkg.tgz> --deps    local root + recursive registry deps
 *   flags: --deps  fetch declared dependency IGs from the registry
 *          --no-fallback  disable the packages2.fhir.org fallback
 *          --registry-base <url>  override registry base (default packages.fhir.org)
 */
async function main(): Promise<void> {
  const cfg = config();
  configureLogLevel(cfg.logLevel);
  const argv = process.argv.slice(2);

  const flag = (name: string): boolean => argv.includes(name);
  const opt = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const consumed = new Set<string>();
  for (const name of ["--registry", "--root", "--registry-base"]) {
    const i = argv.indexOf(name);
    if (i >= 0) {
      consumed.add(argv[i]);
      if (i + 1 < argv.length) consumed.add(argv[i + 1]);
    }
  }

  const coordinate = opt("--registry");
  const rootOpt = opt("--root");
  const fetchDeps = flag("--deps");
  const base = registry.normalizeBase(opt("--registry-base"));
  const fallback = flag("--no-fallback") ? null : registry.FALLBACK_REGISTRY;

  // Positional paths (anything not a flag and not an option value).
  const positionals = argv.filter((a) => !a.startsWith("-") && !consumed.has(a));

  let localRoot = rootOpt;
  if (!coordinate && !localRoot && positionals.length === 0) {
    localRoot =
      process.env.IG_TGZ ||
      firstGlob(path.join(FHIR_CODE_DIR, "twcoreig", "v1.0.0"), (n) => n.endsWith(".tgz")) ||
      firstGlob(path.join(FHIR_CODE_DIR, "twcoreig"), (n) => n.endsWith(".tgz"));
    if (!localRoot) {
      logError("No package.tgz given and none found under fhir-code/twcoreig");
      process.exit(1);
    }
  }

  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4 });
  try {
    // Simple mode: index the given local packages, no registry traffic.
    if (!coordinate && !fetchDeps && positionals.length > 0) {
      await indexPackages(pool, positionals);
      return;
    }

    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "node-ig-import-"));
    try {
      const root = await acquireIgRoot(coordinate, localRoot, tmpdir, base, fallback);
      const allPaths = [root];
      if (fetchDeps) {
        const { depPaths, missing } = await fetchIgDependencies(pool, root, tmpdir, base, fallback);
        allPaths.push(...depPaths);
        if (missing.length) {
          for (const m of missing) {
            logWarning(`Missing dependency: ${m.package_id}@${m.version} — ${m.reason}`);
          }
        }
      }
      await indexPackages(pool, allPaths);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.endsWith("ig.js");
if (invokedDirectly) {
  main().catch((err) => {
    logError("IG loader failed", { error: String((err as Error).message) });
    process.exit(1);
  });
}

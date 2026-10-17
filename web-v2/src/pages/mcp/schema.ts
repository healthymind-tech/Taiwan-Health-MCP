/**
 * JSON-Schema → form model for the playground.
 *
 * Only the shapes zod-to-json-schema emits for our tools are recognised; anything
 * richer (unions, $ref, free-form records, arrays of objects) becomes a JSON editor.
 */

import type { JsonSchema } from "./mcpTypes";

export type FieldKind = "string" | "text" | "json-string" | "integer" | "number" | "boolean" | "enum" | "string-array" | "object" | "json";

export interface FieldModel {
  name: string;
  kind: FieldKind;
  required: boolean;
  nullable: boolean;
  default: unknown;
  hasDefault: boolean;
  description?: string;
  enumValues?: string[];
  min?: number;
  max?: number;
  /** For kind "object": nested fields. */
  children?: FieldModel[];
  schema: JsonSchema;
}

const LONG_TEXT = new Set(["source_text", "site_config", "additional_notes"]);

function nonNullTypes(t: JsonSchema["type"]): string[] {
  if (Array.isArray(t)) return t.filter((x) => x !== "null");
  return t ? [t] : [];
}

/** Unwrap `anyOf: [X, {type:null}]` and `type: [X, "null"]` into (X, nullable). */
function unwrapNullable(s: JsonSchema): { inner: JsonSchema; nullable: boolean } {
  if (s.anyOf) {
    const rest = s.anyOf.filter((x) => !(x.type === "null" || (Array.isArray(x.type) && x.type.length === 1 && x.type[0] === "null")));
    const nullable = rest.length < s.anyOf.length;
    if (rest.length === 1) {
      const deeper = unwrapNullable(rest[0]);
      return { inner: { ...deeper.inner, description: s.description ?? deeper.inner.description }, nullable: nullable || deeper.nullable };
    }
    return { inner: s, nullable };
  }
  if (Array.isArray(s.type)) {
    const types = nonNullTypes(s.type);
    return { inner: { ...s, type: types.length === 1 ? types[0] : types }, nullable: types.length < s.type.length };
  }
  return { inner: s, nullable: false };
}

export function fieldModel(name: string, s: JsonSchema, required: boolean): FieldModel {
  const { inner, nullable } = unwrapNullable(s);
  const base = {
    name,
    required,
    nullable,
    default: s.default,
    hasDefault: Object.prototype.hasOwnProperty.call(s, "default"),
    description: s.description ?? inner.description,
    schema: s,
  };
  if (inner.anyOf || inner.$ref || Array.isArray(inner.type)) return { ...base, kind: "json" };
  if (inner.enum && inner.enum.every((v) => typeof v === "string")) return { ...base, kind: "enum", enumValues: inner.enum as string[] };
  const min = inner.minimum ?? inner.exclusiveMinimum;
  const max = inner.maximum ?? inner.exclusiveMaximum;
  switch (inner.type) {
    case "string":
      if (name.endsWith("_json")) return { ...base, kind: "json-string" };
      return { ...base, kind: LONG_TEXT.has(name) ? "text" : "string" };
    case "integer":
      return { ...base, kind: "integer", min, max };
    case "number":
      return { ...base, kind: "number", min, max };
    case "boolean":
      return { ...base, kind: "boolean" };
    case "array": {
      const items = inner.items ? unwrapNullable(inner.items).inner : undefined;
      if (items && items.type === "string" && !items.anyOf) return { ...base, kind: "string-array" };
      return { ...base, kind: "json" };
    }
    case "object":
      if (inner.properties && Object.keys(inner.properties).length > 0 && (inner.additionalProperties === false || inner.additionalProperties === undefined)) {
        const req = new Set(inner.required ?? []);
        return { ...base, kind: "object", children: Object.entries(inner.properties).map(([k, v]) => fieldModel(k, v, req.has(k))) };
      }
      return { ...base, kind: "json" };
    default:
      return { ...base, kind: "json" };
  }
}

export function formModel(schema: JsonSchema): FieldModel[] {
  const req = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([k, v]) => fieldModel(k, v, req.has(k)));
}

/** Per-field editor state. JSON fields keep their text so half-typed input survives. */
export interface FieldState {
  included: boolean;
  value: unknown;
  /** kind json / json-string: the editor text. */
  text?: string;
  /** kind object: nested states. */
  children?: Record<string, FieldState>;
}

export type FormState = Record<string, FieldState>;

function emptyValue(f: FieldModel): unknown {
  switch (f.kind) {
    case "integer":
    case "number":
      return f.min !== undefined && f.min > 0 ? f.min : 0;
    case "boolean":
      return false;
    case "enum":
      return f.enumValues?.[0] ?? "";
    case "string-array":
      return [];
    case "json":
      return unwrapNullable(f.schema).inner.type === "array" ? [] : {};
    default:
      return "";
  }
}

function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Initial state for one field from an example value.
 * - example has a non-null value → included with it;
 * - else required → included with default / an empty value;
 * - else optional with a non-null default → included with the default (marked optional);
 * - else (optional, default null) → omitted.
 */
export function initField(f: FieldModel, exampleHas: boolean, exampleValue: unknown): FieldState {
  let included: boolean;
  let value: unknown;
  if (exampleHas && exampleValue !== null && exampleValue !== undefined) {
    included = true;
    value = exampleValue;
  } else if (f.required) {
    included = true;
    value = f.hasDefault && f.default !== null ? f.default : emptyValue(f);
  } else if (f.hasDefault && f.default !== null && f.default !== undefined) {
    included = true;
    value = f.default;
  } else {
    included = false;
    value = emptyValue(f);
  }
  const st: FieldState = { included, value };
  if (f.kind === "json") st.text = pretty(value);
  if (f.kind === "json-string") {
    // Show JSON strings pretty-printed when they parse.
    const s = typeof value === "string" ? value : "";
    try {
      st.text = s.trim() ? pretty(JSON.parse(s)) : s;
    } catch {
      st.text = s;
    }
  }
  if (f.kind === "object" && f.children) {
    const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    st.children = Object.fromEntries(f.children.map((c) => [c.name, initField(c, Object.prototype.hasOwnProperty.call(obj, c.name), obj[c.name])]));
  }
  return st;
}

export function initForm(fields: FieldModel[], args: Record<string, unknown>): FormState {
  return Object.fromEntries(fields.map((f) => [f.name, initField(f, Object.prototype.hasOwnProperty.call(args, f.name), args[f.name])]));
}

export interface BuildResult {
  args: Record<string, unknown>;
  /** field path → error message. */
  errors: Record<string, string>;
}

function buildField(f: FieldModel, st: FieldState, path: string, errors: Record<string, string>): unknown {
  switch (f.kind) {
    case "json": {
      const text = st.text ?? "";
      if (!text.trim()) {
        errors[path] = "請輸入 JSON";
        return undefined;
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        errors[path] = `JSON 格式錯誤：${(e as Error).message}`;
        return undefined;
      }
    }
    case "json-string": {
      const text = st.text ?? "";
      if (text.trim()) {
        try {
          return JSON.stringify(JSON.parse(text));
        } catch (e) {
          errors[path] = `JSON 格式錯誤：${(e as Error).message}`;
          return undefined;
        }
      }
      return text;
    }
    case "integer":
    case "number": {
      if (st.value === "" || st.value === null || st.value === undefined || Number.isNaN(Number(st.value))) {
        errors[path] = "請輸入數字";
        return undefined;
      }
      const n = Number(st.value);
      if (f.kind === "integer" && !Number.isInteger(n)) errors[path] = "必須是整數";
      if (f.min !== undefined && n < f.min) errors[path] = `不可小於 ${f.min}`;
      if (f.max !== undefined && n > f.max) errors[path] = `不可大於 ${f.max}`;
      return n;
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const c of f.children ?? []) {
        const cs = st.children?.[c.name];
        if (!cs || (!cs.included && !c.required)) continue;
        const v = buildField(c, cs, `${path}.${c.name}`, errors);
        if (v !== undefined) out[c.name] = v;
      }
      return out;
    }
    default:
      return st.value;
  }
}

/** Arguments to send: included fields only. */
export function buildArgs(fields: FieldModel[], state: FormState): BuildResult {
  const errors: Record<string, string> = {};
  const args: Record<string, unknown> = {};
  for (const f of fields) {
    const st = state[f.name];
    if (!st) continue;
    if (!st.included && !f.required) continue;
    const v = buildField(f, st, f.name, errors);
    if (v !== undefined) args[f.name] = v;
  }
  return { args, errors };
}

/** Short type label for parameter chips / tables. */
export function typeLabel(f: FieldModel): string {
  switch (f.kind) {
    case "string":
    case "text":
      return "string";
    case "json-string":
      return "JSON string";
    case "enum":
      return f.enumValues && f.enumValues.length <= 4 ? f.enumValues.join(" | ") : "enum";
    case "string-array":
      return "string[]";
    case "object":
      return "object";
    case "json": {
      const t = unwrapNullable(f.schema).inner;
      if (t.type === "array") return "array";
      if (t.type === "object") return "object";
      return "JSON";
    }
    default:
      return f.kind;
  }
}

/** POSIX-shell single-quote a string. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function curlFor(baseUrl: string, tool: string, args: Record<string, unknown>, bearer: boolean): string {
  const lines = [`curl -sS -X POST ${shellQuote(`${baseUrl}/tools/${tool}`)}`, `  -H 'Content-Type: application/json'`];
  if (bearer) lines.push(`  -H "Authorization: Bearer $TWH_MCP_TOKEN"`);
  lines.push(`  -d ${shellQuote(JSON.stringify(args))}`);
  return lines.join(" \\\n");
}

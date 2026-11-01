/**
 * Pluggable loaders for a differential corpus (instance + package + profile + the official validator_cli issues).
 * The corpus format is defined by the evaluator; each loader recognises one layout. Add a loader to LOADERS for a
 * new layout — the first whose detect() accepts the directory is used (or the one named with --format).
 *
 * Built-in layouts:
 *  - `repro`:   <name>.bundle.json (or .json instance) + <name>.compare.json {official_errors|official_issues,
 *               package "id#ver", profile?} — the parity v1 repro layout (scripts/parity/run.ts);
 *  - `dirs`:    <id>/ with instance.json (or *.instance.json) + outcome.json (an OperationOutcome or {issues}) +
 *               meta.json {package|packages, profile?};
 *  - `jsonl`:   *.jsonl lines {id, instance, package|packages, profile?, official: OperationOutcome | issue[]};
 *  - `evaluator`: the evaluator's differential corpus (~/ref/parity_corpus/<ig>/): manifest.jsonl rows {id, ig, package,
 *               profile, kind, family, mutation, mutation_path, raw, status, …} + <id>.json (the file validator_cli
 *               was given) + <id>.official.json {id, ig, package, profile, validator, tx, crash?, issues: [{severity,
 *               code, message_id, expression[], location[], text, line, col, source}]}. `raw: true` marks a file
 *               that is NOT valid JSON (family raw-json: comments, NaN, trailing commas, BOM, duplicate keys …):
 *               validator_cli parsed the bytes with its own lenient JSON parser, while an MCP tool only ever receives
 *               a JSON value (z.record) from the JSON-RPC request. So a raw file reaches the TS validator only when a
 *               client could have sent it: JSON.parse of the text (a leading BOM — an encoding mark, not content — is
 *               stripped first); otherwise the item is `unparseable` (instance null) and reported apart.
 *               A directory of IG sub-directories (~/ref/parity_corpus itself) loads every IG.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { issuesOfOutcome, type SimpleIssue } from "../lib/compare.js";
import type { Res } from "../lib/packages.js";

export interface CorpusItem {
  id: string;
  /** The instance as the MCP tool would receive it; null when the item cannot be expressed as JSON (raw unparseable). */
  instance: Res | null;
  /** Packages to load (id#version), the IG first. */
  packages: string[];
  /** Profile validated against (validator_cli -profile), or null. */
  profile: string | null;
  official: SimpleIssue[];
  /** Free-form source info (file names), for reports. */
  source: string;
  /** evaluator layout: the manifest row (ig, kind, family, mutation, mutation_path, raw, …). */
  meta?: Res;
  /** evaluator layout: validator_cli crashed on this item (no official issues) — excluded from the metrics. */
  officialCrash?: boolean;
  /** evaluator layout, raw items: how the file text became the instance (see the evaluator loader). */
  raw?: { parse: "json" | "bom-stripped" | "unparseable"; error?: string; text?: string };
}

export interface CorpusLoader {
  name: string;
  detect(dir: string): boolean;
  load(dir: string): Iterable<CorpusItem>;
}

function readJson(p: string): Res | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Res;
  } catch {
    return null;
  }
}

/** official issues from any of the shapes seen so far: OperationOutcome, {issues|official_errors|official_issues}, issue[]. */
export function officialIssues(x: unknown): SimpleIssue[] {
  if (!x) return [];
  if (Array.isArray(x)) {
    return x.map((i: Res) =>
      i && i.details
        ? issuesOfOutcome({ issue: [i] })[0]
        : { severity: String(i.severity ?? i.level ?? "error").toLowerCase(), path: String(i.path ?? i.location ?? i.expression ?? ""), message: String(i.message ?? i.text ?? ""), code: i.code },
    );
  }
  const o = x as Res;
  if (o.resourceType === "OperationOutcome") return issuesOfOutcome(o);
  for (const k of ["official_issues", "official_errors", "issues", "issue", "official", "outcome"]) if (o[k]) return officialIssues(o[k]);
  return [];
}

const pkgList = (m: Res): string[] => (Array.isArray(m.packages) ? m.packages.map(String) : m.package ? [String(m.package)] : []);

const repro: CorpusLoader = {
  name: "repro",
  detect: (dir) => readdirSync(dir).some((f) => f.endsWith(".compare.json")),
  *load(dir) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".compare.json")).sort()) {
      const name = f.replace(/\.compare\.json$/, "");
      const inst = [`${name}.bundle.json`, `${name}.instance.json`, `${name}.json`].map((x) => join(dir, x)).find(existsSync);
      const cmp = readJson(join(dir, f));
      const instance = inst ? readJson(inst) : null;
      if (!cmp || !instance) continue;
      yield { id: name, instance, packages: pkgList(cmp), profile: cmp.profile ?? null, official: officialIssues(cmp), source: f };
    }
  },
};

const dirs: CorpusLoader = {
  name: "dirs",
  detect: (dir) => readdirSync(dir).some((d) => statSync(join(dir, d)).isDirectory() && existsSync(join(dir, d, "outcome.json"))),
  *load(dir) {
    for (const d of readdirSync(dir).sort()) {
      const p = join(dir, d);
      if (!statSync(p).isDirectory() || !existsSync(join(p, "outcome.json"))) continue;
      const instFile = existsSync(join(p, "instance.json")) ? "instance.json" : readdirSync(p).find((f) => f.endsWith(".instance.json"));
      const instance = instFile ? readJson(join(p, instFile)) : null;
      const meta = readJson(join(p, "meta.json")) ?? {};
      if (!instance) continue;
      yield { id: d, instance, packages: pkgList(meta), profile: meta.profile ?? null, official: officialIssues(readJson(join(p, "outcome.json"))), source: d };
    }
  },
};

const jsonl: CorpusLoader = {
  name: "jsonl",
  detect: (dir) => readdirSync(dir).some((f) => f.endsWith(".jsonl")),
  *load(dir) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
      let n = 0;
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        n++;
        if (!line.trim()) continue;
        let o: Res;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (!o.instance) continue;
        yield { id: String(o.id ?? `${f}:${n}`), instance: o.instance, packages: pkgList(o), profile: o.profile ?? null, official: officialIssues(o.official ?? o), source: `${f}:${n}` };
      }
    }
  },
};

/** One evaluator official issue → SimpleIssue (expression[0], else location[0]; message_id kept). */
function evaluatorIssue(i: Res): SimpleIssue {
  const path = (Array.isArray(i.expression) && i.expression[0]) || (Array.isArray(i.location) && i.location[0]) || "";
  return { severity: String(i.severity ?? "").toLowerCase(), path: String(path), message: String(i.text ?? ""), code: i.code, messageId: i.message_id ?? null };
}

function* evaluatorDir(dir: string): Generator<CorpusItem> {
  for (const line of readFileSync(join(dir, "manifest.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const m = JSON.parse(line) as Res;
    const id = String(m.id);
    const off = readJson(join(dir, `${id}.official.json`));
    const instPath = join(dir, `${id}.json`);
    if (!off || !existsSync(instPath)) continue;
    let instance: Res | null = null;
    let raw: CorpusItem["raw"];
    const text = readFileSync(instPath, "utf8");
    try {
      instance = JSON.parse(text) as Res;
      if (m.raw) raw = { parse: "json" };
    } catch (e) {
      if (text.startsWith("\uFEFF")) {
        try {
          instance = JSON.parse(text.slice(1)) as Res;
          raw = { parse: "bom-stripped" };
        } catch (e2) {
          raw = { parse: "unparseable", error: String((e2 as Error).message) };
        }
      } else raw = { parse: "unparseable", error: String((e as Error).message) };
    }
    // a parsed non-object (array root, number …) cannot be a tool argument (z.record) either
    if (instance !== null && (typeof instance !== "object" || Array.isArray(instance))) {
      raw = { parse: "unparseable", error: `JSON root is ${Array.isArray(instance) ? "an array" : typeof instance}` };
      instance = null;
    }
    const pkg = String(off.package ?? m.package ?? "");
    yield {
      id,
      instance,
      packages: pkg ? [pkg] : [],
      profile: (off.profile ?? m.profile ?? null) as string | null,
      official: (Array.isArray(off.issues) ? off.issues : []).map(evaluatorIssue),
      source: `${m.ig ?? ""}/${id}`,
      meta: m,
      officialCrash: !!off.crash || m.status === "official_crash",
      ...(raw ? { raw: { ...raw, text } } : {}),
    };
  }
}

const evaluator: CorpusLoader = {
  name: "evaluator",
  detect: (dir) => existsSync(join(dir, "manifest.jsonl")) || readdirSync(dir).some((d) => existsSync(join(dir, d, "manifest.jsonl"))),
  *load(dir) {
    if (existsSync(join(dir, "manifest.jsonl"))) {
      yield* evaluatorDir(dir);
      return;
    }
    for (const d of readdirSync(dir).sort()) if (existsSync(join(dir, d, "manifest.jsonl"))) yield* evaluatorDir(join(dir, d));
  },
};

export const LOADERS: CorpusLoader[] = [evaluator, repro, dirs, jsonl];

export function pickLoader(dir: string, name?: string | null): CorpusLoader | null {
  if (name) return LOADERS.find((l) => l.name === name) ?? null;
  return LOADERS.find((l) => {
    try {
      return l.detect(dir);
    } catch {
      return false;
    }
  }) ?? null;
}

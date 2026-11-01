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
 *  - `jsonl`:   *.jsonl lines {id, instance, package|packages, profile?, official: OperationOutcome | issue[]}.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { issuesOfOutcome, type SimpleIssue } from "../lib/compare.js";
import type { Res } from "../lib/packages.js";

export interface CorpusItem {
  id: string;
  instance: Res;
  /** Packages to load (id#version), the IG first. */
  packages: string[];
  /** Profile validated against (validator_cli -profile), or null. */
  profile: string | null;
  official: SimpleIssue[];
  /** Free-form source info (file names), for reports. */
  source: string;
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

export const LOADERS: CorpusLoader[] = [repro, dirs, jsonl];

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

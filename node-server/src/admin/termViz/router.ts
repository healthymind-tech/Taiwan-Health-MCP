/**
 * Admin terminology explorer API — read-only, behind the admin session gate
 * (mounted in adminApp.ts after the auth check).
 *
 *   GET /admin/api/terminology/icd/cm/children?node=      chapters | ch:N | sec:A00-A09 | code
 *   GET /admin/api/terminology/icd/cm/path?code=E11.21    root → code, every level's children
 *   GET /admin/api/terminology/icd/cm/search?q=
 *   GET /admin/api/terminology/icd/who/children?node=     (WHO ICD-10)  …/who/path  …/who/search
 *   GET /admin/api/terminology/icd/pcs/browse             section → body system → operation
 *   GET /admin/api/terminology/icd/pcs/table?key=0DT      axis grid of one table
 *   GET /admin/api/terminology/icd/pcs/codes?key=0DT&a4=&a5=&a6=&a7=&page=
 *   GET /admin/api/terminology/icd/pcs/code?code=0DTJ4ZZ  7-axis breakdown
 *   GET /admin/api/terminology/icd/pcs/search?q=
 *   GET /admin/api/terminology/snomed/concept?id=&child_offset=
 *   GET /admin/api/terminology/snomed/children?id=&offset=
 *   GET /admin/api/terminology/snomed/search?q=
 *   GET /admin/api/terminology/loinc/facets?component=&system=…&q=&page=
 *   GET /admin/api/terminology/loinc/facet-values?facet=&search=&…filters
 *   GET /admin/api/terminology/loinc/term?code=2345-7
 *   GET /admin/api/terminology/loinc/code?code=LL…|LA…|LP…|LG…
 *   GET /admin/api/terminology/rxnorm/summary | search?q=&tty= | concept?rxcui=
 *   GET /admin/api/terminology/ig/codesystems?package_id=&version=&q=
 *   GET /admin/api/terminology/ig/codesystem?package_id=&artifact_key=&version=
 *   GET /admin/api/terminology/ig/codesystem/children?…&parent=&offset=
 *   GET /admin/api/terminology/ig/codesystem/search?…&q=
 */

import { intParam, str, TermVizError, type Q } from "./common.js";
import * as icd from "./icd.js";
import * as snomed from "./snomed.js";
import * as loinc from "./loinc.js";
import * as rx from "./rxnorm.js";
import * as ig from "./igCodeSystem.js";

export type Params = Record<string, unknown>;

export interface TermVizResult {
  status: number;
  body: unknown;
}

type Handler = (q: Q, p: Params) => Promise<unknown>;

const p = (params: Params, key: string): string => {
  const v = params[key];
  return (Array.isArray(v) ? str(v[v.length - 1]) : str(v)).slice(0, 300);
};

export const ROUTES: Record<string, Handler> = {
  "icd/cm/children": async (q, x) => ({ node: p(x, "node"), items: await icd.cmChildren(q, p(x, "node")) }),
  "icd/cm/path": (q, x) => icd.cmPath(q, p(x, "code")),
  "icd/cm/search": async (q, x) => ({ items: await icd.cmSearch(q, p(x, "q")) }),
  "icd/who/children": async (q, x) => ({ node: p(x, "node"), items: await icd.whoChildren(q, p(x, "node")) }),
  "icd/who/path": (q, x) => icd.whoPath(q, p(x, "code")),
  "icd/who/search": async (q, x) => ({ items: await icd.whoSearch(q, p(x, "q")) }),
  "icd/pcs/browse": (q) => icd.pcsBrowse(q),
  "icd/pcs/table": (q, x) => icd.pcsTable(q, p(x, "key")),
  "icd/pcs/codes": (q, x) =>
    icd.pcsCodes(q, p(x, "key"), [p(x, "a4"), p(x, "a5"), p(x, "a6"), p(x, "a7")], intParam(x.page, 1, 1, 10_000), intParam(x.per_page, 25, 1, 100)),
  "icd/pcs/code": (q, x) => icd.pcsCode(q, p(x, "code")),
  "icd/pcs/search": async (q, x) => ({ items: await icd.pcsSearch(q, p(x, "q")) }),
  "snomed/concept": (q, x) => snomed.snomedNeighbourhood(q, p(x, "id"), intParam(x.child_offset, 0, 0, 1_000_000), intParam(x.child_limit, 24, 1, 100)),
  "snomed/children": (q, x) => snomed.snomedChildren(q, p(x, "id"), intParam(x.offset, 0, 0, 1_000_000), intParam(x.limit, 24, 1, 100)),
  "snomed/search": async (q, x) => ({ items: await snomed.snomedSearch(q, p(x, "q")) }),
  "loinc/facets": (q, x) => loinc.loincFacets(q, loinc.parseLoincFilters(x), intParam(x.page, 1, 1, 10_000), intParam(x.per_page, 20, 1, 100)),
  "loinc/facet-values": async (q, x) => ({ items: await loinc.loincFacetValues(q, p(x, "facet"), loinc.parseLoincFilters(x), p(x, "search")) }),
  "loinc/term": (q, x) => loinc.loincTerm(q, p(x, "code")),
  "loinc/code": (q, x) => loinc.loincOtherCode(q, p(x, "code")),
  "rxnorm/summary": (q) => rx.rxnormSummary(q),
  "rxnorm/search": (q, x) =>
    rx.rxnormSearch(q, p(x, "q"), p(x, "tty"), p(x, "suppressed") === "true", intParam(x.page, 1, 1, 10_000), intParam(x.per_page, 25, 1, 100)),
  "rxnorm/concept": (q, x) => rx.rxnormConcept(q, p(x, "rxcui")),
  "ig/codesystems": (q, x) => ig.csList(q, p(x, "package_id"), p(x, "version"), p(x, "q")),
  "ig/codesystem": (q, x) => ig.csOverview(q, p(x, "package_id"), p(x, "artifact_key"), p(x, "version"), intParam(x.limit, 200, 1, 500)),
  "ig/codesystem/children": (q, x) =>
    ig.csChildren(q, p(x, "package_id"), p(x, "artifact_key"), p(x, "version"), p(x, "parent"), intParam(x.offset, 0, 0, 10_000_000), intParam(x.limit, 200, 1, 500)),
  "ig/codesystem/search": (q, x) => ig.csSearch(q, p(x, "package_id"), p(x, "artifact_key"), p(x, "version"), p(x, "q")),
};

const PREFIX = "/admin/api/terminology/";

/** Dispatch one request; null when the path is not ours. Errors map to 4xx/5xx without echoing params. */
export async function handleTerminologyApi(q: Q, method: string, path: string, params: Params): Promise<TermVizResult | null> {
  if (!path.startsWith(PREFIX)) return null;
  const route = path.slice(PREFIX.length).replace(/\/+$/, "");
  const handler = ROUTES[route];
  if (!handler) return { status: 404, body: { error: `Unknown terminology endpoint '${route}'` } };
  if (method !== "GET") return { status: 405, body: { error: "Method not allowed" } };
  try {
    return { status: 200, body: await handler(q, params) };
  } catch (exc) {
    if (exc instanceof TermVizError) return { status: exc.status, body: { error: exc.message } };
    return { status: 500, body: { error: "terminology_query_failed", detail: String((exc as Error).message) } };
  }
}

/**
 * A stored CodeSystem as small pieces instead of one JSON document (v22 G6). Postgres hands over the resource without
 * its concepts, a content md5, and the concepts flattened — one row per concept (without its `concept` list) in the
 * depth-first pre-order of the nested lists, with its parent's code — so the app never parses a 30 MB JSON
 * (ICD-10-CM: ~1.4 s of JSON.parse in one piece on the event loop) and builds its indexes a slice at a time.
 * The order and the skips match the nested walk of indexCodeSystem / assembleCodeSystem: entries that are not objects
 * or have no code are skipped with their descendants; `concept` lists that are not arrays are ignored.
 */
import { query, withTransaction } from "./db.js";

export interface CodeSystemHead {
  /** the resource without `concept` */
  head: Record<string, any>;
  /** md5 of the stored JSON (content identity) */
  md5: string;
}

export interface FlatConceptRow {
  node: Record<string, any>;
  parent: string | null;
}

/** `where` selects one fhir.artifacts row (its parameters are $1…); undefined when the database cannot answer. */
export async function codeSystemHead(where: string, params: unknown[]): Promise<CodeSystemHead | undefined> {
  try {
    const r = (await query<{ head: Record<string, any>; md5: string }>(`SELECT raw_json - 'concept' AS head, md5(raw_json::text) AS md5 FROM fhir.artifacts WHERE ${where} AND raw_json IS NOT NULL LIMIT 1`, params)).rows[0];
    return r && r.head && typeof r.head === "object" ? r : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run a large query through a server-side cursor, PAGE_ROWS rows per FETCH: each page is its own small response, so the
 * driver never parses megabytes of rows in one turn of the event loop (libuv reads up to 32 × 64 KB per turn, and the
 * pg driver parses every complete row it holds at once). One pooled connection, inside a transaction (pgBouncer
 * transaction mode keeps it). The rows come in the query's order.
 */
export const PAGE_ROWS = 2000;
export async function queryInPages<T>(text: string, params: unknown[], pageRows = PAGE_ROWS): Promise<T[]> {
  return withTransaction(async (client) => {
    await client.query(`DECLARE big_rows NO SCROLL CURSOR FOR ${text}`, params as never[]);
    const out: T[] = [];
    for (;;) {
      const page = await client.query(`FETCH ${pageRows} FROM big_rows`);
      for (const r of page.rows) out.push(r as T);
      if (page.rows.length < pageRows) break;
      await yieldToLoop();
    }
    await client.query("CLOSE big_rows");
    return out;
  });
}

export async function codeSystemConceptRows(where: string, params: unknown[]): Promise<FlatConceptRow[] | undefined> {
  try {
    const rows = (
      await queryInPages<{ node: Record<string, any>; parent: unknown }>(
        `WITH RECURSIVE src AS (SELECT raw_json FROM fhir.artifacts WHERE ${where} AND raw_json IS NOT NULL LIMIT 1), ` +
          "walk(node, parent, path) AS (" +
          "  SELECT e.node, NULL::jsonb, ARRAY[e.ord]::bigint[] FROM src, " +
          "    jsonb_array_elements(CASE WHEN jsonb_typeof(src.raw_json->'concept') = 'array' THEN src.raw_json->'concept' ELSE '[]'::jsonb END) WITH ORDINALITY AS e(node, ord) " +
          "    WHERE jsonb_typeof(e.node) = 'object' AND e.node ? 'code' AND jsonb_typeof(e.node->'code') <> 'null' " +
          "  UNION ALL " +
          "  SELECT c.node, w.node->'code', w.path || c.ord FROM walk w, " +
          "    jsonb_array_elements(CASE WHEN jsonb_typeof(w.node->'concept') = 'array' THEN w.node->'concept' ELSE '[]'::jsonb END) WITH ORDINALITY AS c(node, ord) " +
          "    WHERE jsonb_typeof(c.node) = 'object' AND c.node ? 'code' AND jsonb_typeof(c.node->'code') <> 'null'" +
          ") SELECT node - 'concept' AS node, parent FROM walk ORDER BY path",
        params,
      )
    );
    return rows.map((r) => ({ node: r.node, parent: r.parent === null || r.parent === undefined ? null : String(r.parent) }));
  } catch {
    return undefined;
  }
}

/** Let pending I/O and timers run between two slices of work. */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Time-sliced yielding for long builds: `tick()` after each unit of work yields once the slice has run SLICE_MS.
 * Slicing by count was not enough (v22 G6): a slice's allocations trigger scavenges inside it, so 500 concepts could take
 * hundreds of ms, and with several builds each running one slice per loop turn the event loop stalled for seconds. A
 * time slice of 15 ms plus at most one scavenge (~80 ms) keeps every synchronous piece under 100 ms.
 */
export const SLICE_MS = 15;
export class Slicer {
  private start = performance.now();
  private n = 0;

  constructor(private readonly sliceMs = SLICE_MS) {}

  /** Call after each unit; resolves at once until the slice is used up (checks the clock every 32 units). */
  tick(): Promise<void> | undefined {
    if (++this.n % 32 !== 0 || performance.now() - this.start < this.sliceMs) return undefined;
    return this.next();
  }

  /** Yield now and start a new slice. */
  async next(): Promise<void> {
    await yieldToLoop();
    this.start = performance.now();
  }
}

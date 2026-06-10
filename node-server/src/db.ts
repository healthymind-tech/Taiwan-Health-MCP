import pg from "pg";

import { config } from "./config.js";
import { observeDependency } from "./metrics.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

export async function query<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
  operation = "query"
): Promise<pg.QueryResult<T>> {
  return observeDependency("db", operation, () => pool.query<T>(text, values));
}

export async function dbHealth(): Promise<boolean> {
  try {
    await query("SELECT 1", [], "health");
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

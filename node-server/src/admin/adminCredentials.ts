import { config } from "../config.js";
import { query, withTransaction } from "../db.js";
import { hashAdminPassword, verifyAdminPassword } from "../adminAuth.js";

let ensured = false;

async function ensureTable(): Promise<void> {
  if (ensured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS admin.admin_credentials (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL
    )`);
  ensured = true;
}

/** Seed the deployment credential exactly once; later env changes are ignored. */
export async function seedAdminCredential(): Promise<void> {
  await ensureTable();
  const cfg = config();
  await query(
    `INSERT INTO admin.admin_credentials (username, password_hash, updated_by)
     VALUES ($1, $2, 'bootstrap')
     ON CONFLICT (username) DO NOTHING`,
    [cfg.adminUsername, cfg.adminPasswordHash],
  );
}

async function storedHash(username: string): Promise<string> {
  await ensureTable();
  const result = await query<{ password_hash: string }>(
    "SELECT password_hash FROM admin.admin_credentials WHERE username = $1",
    [username],
  );
  return result.rows[0]?.password_hash || "";
}

export async function verifyPassword(username: string, password: string): Promise<boolean> {
  if (username !== config().adminUsername) return false;
  return verifyAdminPassword(password, await storedHash(username));
}

export async function changePassword(opts: {
  username: string;
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  if (!(await verifyPassword(opts.username, opts.currentPassword))) {
    throw new Error("Current password is incorrect.");
  }
  if (opts.newPassword.length === 0) throw new Error("New password is required.");
  if (opts.newPassword.length > 512) throw new Error("New password is too long.");
  const nextHash = hashAdminPassword(opts.newPassword);
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO admin.admin_credentials (username, password_hash, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $1)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by`,
      [opts.username, nextHash],
    );
    await client.query(
      `INSERT INTO admin.admin_audit_log (admin_user, action, target_type, target_id)
       VALUES ($1, 'admin_password_changed', 'admin_user', $1)`,
      [opts.username],
    );
  });
}

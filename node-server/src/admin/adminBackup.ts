import { spawn } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { config } from "../config.js";
import { query } from "../db.js";
import * as minio from "../minioService.js";
import { exportSettings } from "./adminSettings.js";
import {
  appendJobLog,
  applyControlCheckpoint,
  markJobStatus,
  parseJsonb,
  recordJobStep,
  tsIsoExpr,
  pyIso,
} from "./adminJobs.js";

export interface BackupSelection {
  settings: boolean;
  database: boolean;
  object_storage: boolean;
}

function selectionFromJob(job: Record<string, unknown>): BackupSelection {
  const raw = parseJsonb(job.job_options);
  const selection = parseJsonb(raw.selection);
  const result = {
    settings: selection.settings !== false,
    database: Boolean(selection.database),
    object_storage: Boolean(selection.object_storage),
  };
  if (!result.settings && !result.database && !result.object_storage) {
    throw new Error("Select at least one backup component");
  }
  return result;
}

function safeArchivePath(objectKey: string): string {
  const parts = objectKey.split("/").filter((part) => part && part !== "." && part !== "..");
  return `object-storage/${parts.join("/") || "unnamed-object"}`;
}

async function databaseDump(): Promise<Readable> {
  const child = spawn(
    "pg_dump",
    ["--dbname", config().databaseUrl, "--format=custom", "--no-owner", "--no-acl"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const errors: Buffer[] = [];
  const output = new PassThrough();
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  child.stdout.pipe(output, { end: false });
  child.once("error", (error) => output.destroy(error));
  child.once("close", (code) => {
    if (code !== 0) {
      output.destroy(new Error(Buffer.concat(errors).toString("utf8").trim() || `pg_dump exited with ${code}`));
    } else {
      output.end();
    }
  });
  return output;
}

export async function runSystemBackupJob(opts: {
  workerName: string;
  job: Record<string, unknown>;
}): Promise<void> {
  const jobId = String(opts.job.job_id);
  const selection = selectionFromJob(opts.job);
  if (!minio.initialized()) await minio.initialize();
  if (!minio.enabled()) throw new Error(minio.initError() ?? "MinIO is required to store backup artifacts");

  const objects = selection.object_storage
    ? (await minio.listObjects()).filter((item) => !item.name.startsWith("system-backups/"))
    : [];
  const entryTotal = Number(selection.settings) + Number(selection.database) + objects.length + 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `taiwan-health-backup-${stamp}.zip`;
  const objectKey = `system-backups/${jobId}/${filename}`;
  let completed = 0;
  const archive = new ZipArchive({ forceZip64: true, zlib: { level: 0 } });
  const upload = minio.uploadStream({ objectKey, stream: archive, contentType: "application/zip" });
  const stopIfRequested = async (): Promise<boolean> => {
    if (!(await applyControlCheckpoint({ jobId, workerName: opts.workerName }))) return false;
    archive.abort();
    await upload.catch(() => undefined);
    return true;
  };

  const addReadable = async (name: string, source: Readable): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const onEntry = (entry: { name: string }): void => {
        if (entry.name !== name) return;
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        archive.off("entry", onEntry);
        archive.off("error", onError);
      };
      archive.on("entry", onEntry);
      archive.on("error", onError);
      archive.append(source, { name, store: true });
    });
  };
  const addBuffer = async (name: string, data: Buffer): Promise<void> => {
    await addReadable(name, Readable.from(data));
  };
  const advance = async (step: string): Promise<void> => {
    completed += 1;
    await markJobStatus({
      jobId,
      status: "running",
      currentStep: step,
      progressCurrent: completed,
      progressTotal: entryTotal,
    });
  };

  try {
    await appendJobLog({
      jobId,
      level: "info",
      message: "Creating system backup",
      payload: { selection, object_count: objects.length, object_key: objectKey },
    });
    await recordJobStep({
      jobId,
      stepKey: "inventory",
      status: "success",
      progressCurrent: 1,
      progressTotal: 1,
      checkpoint: { selection, object_count: objects.length },
    });

    const manifest = {
      format: "taiwan-health-system-backup",
      version: 1,
      created_at: new Date().toISOString(),
      job_id: jobId,
      selection,
      database_format: selection.database ? "PostgreSQL custom dump" : null,
      object_count: objects.length,
      object_bytes: objects.reduce((sum, item) => sum + item.size, 0),
    };
    await addBuffer("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
    await advance("manifest_written");
    if (await stopIfRequested()) return;

    if (selection.settings) {
      await addBuffer("settings.json", Buffer.from(JSON.stringify(await exportSettings(), null, 2), "utf8"));
      await advance("settings_exported");
      if (await stopIfRequested()) return;
    }
    if (selection.database) {
      await recordJobStep({
        jobId, stepKey: "database", status: "running", progressCurrent: 0, progressTotal: 1,
        checkpoint: { phase: "pg_dump" },
      });
      await addReadable("database.dump", await databaseDump());
      await recordJobStep({
        jobId, stepKey: "database", status: "success", progressCurrent: 1, progressTotal: 1,
        checkpoint: { phase: "completed", format: "custom" },
      });
      await advance("database_exported");
      if (await stopIfRequested()) return;
    }
    if (selection.object_storage) {
      await recordJobStep({
        jobId, stepKey: "object_storage", status: "running", progressCurrent: 0, progressTotal: objects.length,
        checkpoint: { phase: "streaming", object_count: objects.length },
      });
      for (let index = 0; index < objects.length; index += 1) {
        const object = objects[index];
        await addReadable(safeArchivePath(object.name), await minio.getObjectStream(object.name));
        await recordJobStep({
          jobId, stepKey: "object_storage", status: "running", progressCurrent: index + 1,
          progressTotal: objects.length, checkpoint: { phase: "streaming", last_object: object.name },
        });
        await advance(`backing_up_objects_${index + 1}_of_${objects.length}`);
        if (await stopIfRequested()) return;
      }
      await recordJobStep({
        jobId, stepKey: "object_storage", status: "success", progressCurrent: objects.length,
        progressTotal: objects.length, checkpoint: { phase: "completed", object_count: objects.length },
      });
    }

    await archive.finalize();
    await upload;
    const archiveBytes = archive.pointer();
    await recordJobStep({
      jobId, stepKey: "finalize", status: "success", progressCurrent: 1, progressTotal: 1,
      checkpoint: { phase: "completed", object_key: objectKey, archive_bytes: archiveBytes },
    });
    await markJobStatus({
      jobId,
      status: "success",
      currentStep: "completed",
      progressCurrent: entryTotal,
      progressTotal: entryTotal,
      controlState: "idle",
      resultSummary: {
        job_type: "system_backup",
        filename,
        object_key: objectKey,
        archive_bytes: archiveBytes,
        selection,
        source_object_count: objects.length,
      },
    });
  } catch (error) {
    archive.abort();
    await upload.catch(() => undefined);
    throw error;
  }
}

interface BackupJobRow {
  job_id: string;
  status: string;
  progress_current: number;
  progress_total: number;
  current_step: string | null;
  job_options_json: unknown;
  result_summary_json: unknown;
  created_at_iso: string | null;
  finished_at_iso: string | null;
  last_error_message: string | null;
}

export async function listBackups(): Promise<Record<string, unknown>[]> {
  const result = await query<BackupJobRow>(
    `SELECT job_id::text, status, progress_current, progress_total, current_step,
            job_options_json, result_summary_json, last_error_message,
            ${tsIsoExpr("created_at")} AS created_at_iso,
            ${tsIsoExpr("finished_at")} AS finished_at_iso
       FROM admin.import_jobs
      WHERE job_type = 'system_backup'
      ORDER BY created_at DESC
      LIMIT 50`,
  );
  return result.rows.map((row) => ({
    job_id: row.job_id,
    status: row.status,
    progress_current: Number(row.progress_current || 0),
    progress_total: Number(row.progress_total || 0),
    current_step: row.current_step || "",
    selection: parseJsonb(parseJsonb(row.job_options_json).selection),
    result: parseJsonb(row.result_summary_json),
    created_at: row.created_at_iso ? pyIso(row.created_at_iso) : "",
    finished_at: row.finished_at_iso ? pyIso(row.finished_at_iso) : "",
    error: row.last_error_message || "",
  }));
}

export async function openBackupDownload(jobId: string): Promise<{ stream: Readable; filename: string }> {
  const result = await query<{ status: string; result_summary_json: unknown }>(
    "SELECT status, result_summary_json FROM admin.import_jobs WHERE job_id = $1::uuid AND job_type = 'system_backup'",
    [jobId],
  );
  if (result.rows.length === 0) throw new Error("Backup not found");
  if (result.rows[0].status !== "success") throw new Error("Backup is not ready for download");
  const summary = parseJsonb(result.rows[0].result_summary_json);
  const objectKey = String(summary.object_key ?? "");
  if (!objectKey.startsWith(`system-backups/${jobId}/`)) throw new Error("Backup artifact is invalid");
  if (!minio.initialized()) await minio.initialize();
  return {
    stream: await minio.getObjectStream(objectKey),
    filename: String(summary.filename ?? "taiwan-health-backup.zip"),
  };
}

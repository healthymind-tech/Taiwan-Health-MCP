-- Gate auto-resume of jobs paused for `llm_unavailable`: the admin worker
-- re-claims a paused job only once `next_retry_at` has passed, so a transient
-- Analysis LM outage retries itself (backoff doubling per attempt, 30min cap)
-- instead of parking the job until a human resumes it.
ALTER TABLE admin.import_jobs ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- Re-arm jobs paused for llm_unavailable by older code (column previously NULL)
-- so they auto-resume on the next worker poll instead of staying parked.
UPDATE admin.import_jobs
   SET next_retry_at = NOW()
 WHERE status = 'paused' AND control_state = 'paused'
   AND last_error_code = 'llm_unavailable' AND next_retry_at IS NULL;

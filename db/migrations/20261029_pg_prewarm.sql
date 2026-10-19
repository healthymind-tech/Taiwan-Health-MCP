-- Enable pg_prewarm: the worker loads the SNOMED CT search relations into shared buffers at
-- startup (admin/prewarm.ts), and with shared_preload_libraries = pg_prewarm (compose.yaml)
-- autoprewarm restores the buffer cache after a database restart.
CREATE EXTENSION IF NOT EXISTS pg_prewarm;

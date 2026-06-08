-- Optional probe/test path appended to base_url during the FHIR connection
-- workflow (probe + test). After the CapabilityStatement (/metadata) check, the
-- workflow GETs base_url + test_path with the acquired token to verify real data
-- access (e.g. "Patient?_count=1"). Relative path only; NULL/blank = skip.
ALTER TABLE admin.fhir_servers
    ADD COLUMN IF NOT EXISTS test_path TEXT;

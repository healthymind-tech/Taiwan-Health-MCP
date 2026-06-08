-- Per-server admin default for the OAuth2 token strategy used by MCP FHIR calls.
-- 'fresh'  = re-authenticate (new token) on every call, never cached.
-- 'cached' = reuse a shared per-server token until expiry (single-flight refill).
-- NULL/blank = use the global default ('fresh'). A per-call tool argument can
-- still override this. The client_credentials token is the MCP server's client
-- identity (not an end user), so it is shared across users by design.
ALTER TABLE admin.fhir_servers
    ADD COLUMN IF NOT EXISTS default_token_strategy TEXT;

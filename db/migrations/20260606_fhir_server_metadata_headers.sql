-- Custom HTTP headers attached to the authorization metadata discovery request
-- (.well-known/openid-configuration / smart-configuration / oauth-authorization-server).
-- Mirrors token_headers_json / resource_headers_json. An Authorization header is
-- rejected on parse (the metadata endpoint is public discovery, not authenticated).
ALTER TABLE admin.fhir_servers
    ADD COLUMN IF NOT EXISTS metadata_headers_json JSONB NOT NULL DEFAULT '{}'::jsonb;

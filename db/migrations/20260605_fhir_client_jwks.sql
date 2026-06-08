-- Publish the FHIR client's public signing key (private_key_jwt) as a JWK so an
-- external OAuth Server can fetch it at /fhir-client/<id>/jwks.json. The column
-- holds plaintext public-key material only; the private key stays encrypted in
-- client_private_key_ciphertext. Derived automatically on save from the stored
-- private key, so existing private_key_jwt servers backfill on their next edit.
ALTER TABLE admin.fhir_servers
    ADD COLUMN IF NOT EXISTS client_public_jwk_json TEXT;

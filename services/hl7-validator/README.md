# hl7-validator

The official HL7 FHIR validator (`validator_cli` 7.0.1, resident HTTP mode) used by the MCP server as the judge of
`fhir_validate_bundle` / `fhir_validate_resource` (v18 R1). One container per IG package; the MCP side routes by
package (`OFFICIAL_VALIDATOR_URLS`, see `node-server/src/officialValidator.ts`) and falls back to its built-in
validator when a container is down (`OFFICIAL_VALIDATOR_MODE=prefer`).

- No host port: reachable only on the compose network. The server is started with `-allowNetworkAccess` so other
  containers can reach it; nothing publishes it.
- Needs outbound HTTPS on first start (packages.fhir.org for the IG and its dependencies, cached in the
  `validator_fhircache` volume) and, with the default `VALIDATOR_TX`, tx.fhir.org for terminology (codes and displays
  only — no patient data).
- Startup 40–120 s; memory 1.2–2.4 GB per IG (staging measurement 2026-11-01).

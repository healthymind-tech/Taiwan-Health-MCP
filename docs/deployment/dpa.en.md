# Data Processing Addendum (DPA)

The Taiwan Health MCP Server serves a static HTML Data Processing Agreement at `/dpa`, for review by the Anthropic Remote MCP Server directory and for users to consult.

## Access

```
https://<your-domain>/dpa
```

Local testing (through the nginx front door, `:8080` by default):

```bash
curl http://localhost:8080/dpa
```

## DPA summary

| Item | Description |
|------|-------------|
| Data controller | HealthyMind Tech (the Operator) |
| Purpose of processing | Solely to respond to MCP tool call requests |
| Personal data collection | No PII or personal health data is collected |
| Audit log | Retains the tool name, SHA-256(parameters), and timestamp, for 90 days |
| Raw parameters | Never written to logs (HIPAA-oriented design) |
| Redis cache | Expires automatically per TTL (1–24 hours) |
| Sub-processors | PostgreSQL, Redis (self-hosted), and the Anthropic platform |
| Cross-border transfer | Only through the Anthropic platform (United States); the Operator itself performs no cross-border transfer |
| Security measures | HTTPS, Docker network isolation, append-only audit log |
| Breach notification | Within 72 hours (as required by regulation) |
| Governing law | The laws of the Republic of China (Taiwan), with jurisdiction in the Taipei District Court |

## Read-only scope and the single exception

48 of the 49 tools perform read-only queries against the system's own data. The single exception is **`crud_fhir_server`**: it relays FHIR requests to an external FHIR server **explicitly registered by the administrator**. Write operations (create / update / patch / delete) execute only when two conditions hold at once — that server's allow-list permits the operation, and the caller passes `confirm_write=true`.

Any personal health data in such a request is supplied by the caller and relayed straight to that external server; this service retains none of it. An Operator who enables write access to an external server assumes controller responsibility for that processing.

## Implementation

`/dpa` is served by the **Next.js `web` service** (no longer by a backend middleware layer):

| Item | Location |
|------|----------|
| Route | `web/app/dpa/route.ts` (`export const dynamic = "force-static"`) |
| Content | `web/legacy/dpa.html` |
| Dark mode injection | `withDarkMode()` in `web/lib/legacy.ts` |
| Response header | `Content-Type: text/html; charset=utf-8` |

nginx routes every non-API path to `web`, so `/dpa` never passes through the `app` container.

## Updating the DPA

1. Edit `web/legacy/dpa.html`.
2. Rebuild and redeploy the `web` service:

   ```bash
   docker compose build web && docker compose up -d --no-deps web
   ```

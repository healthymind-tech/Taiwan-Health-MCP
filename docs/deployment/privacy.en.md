# Privacy Policy Page

The Taiwan Health MCP Server serves a static HTML privacy policy page at `/privacy`, for review by the Anthropic Connectors Directory and for users to consult.

## Access

Once the server is running, the privacy policy page is reachable at:

```
https://<your-domain>/privacy
```

Local testing (through the nginx front door, `:8080` by default):

```bash
curl http://localhost:8080/privacy
```

## Implementation

`/privacy` is served by the **Next.js `web` service** (no longer by a backend middleware layer):

| Item | Location |
|------|----------|
| Route | `web/app/privacy/route.ts` (`export const dynamic = "force-static"`) |
| Content | `web/legacy/privacy.html` |
| Dark mode injection | `withDarkMode()` in `web/lib/legacy.ts` (inserts a theme script and CSS before `</head>`) |
| Response header | `Content-Type: text/html; charset=utf-8` |

nginx routes every non-API path to `web`, so `/privacy` never passes through the `app` container and stays reachable even when the backend or database is unhealthy.

## Privacy policy summary

| Item | Description |
|------|-------------|
| Personal data collection | No personal data is collected |
| Audit log | Records only the tool name, SHA-256(parameters), execution time, and timestamp |
| Raw parameter values | Never written to logs (HIPAA-oriented design) |
| Third-party sharing | Not shared with any third party (aside from Anthropic's own telemetry) |
| Data retention | Audit logs are kept for 90 days; the Redis cache expires automatically per TTL |
| User accounts | The MCP tool surface requires no account and stores no session token or cookie |
| Write behaviour | The system's own medical data is read-only. The single exception is `crud_fhir_server`, which relays requests to an **external FHIR server registered by the administrator** (see the [DPA](dpa.md)) |

## Updating the privacy policy

1. Edit `web/legacy/privacy.html`.
2. Rebuild and redeploy the `web` service:

   ```bash
   docker compose build web && docker compose up -d --no-deps web
   ```

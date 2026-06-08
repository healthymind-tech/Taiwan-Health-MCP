# admin-ui

React + Vite SPA that replaces the server-rendered admin console
(`src/admin_html_*.py`). Served by the Python ASGI app under `/admin`.

## Why

The old admin used hand-wired imperative DOM updates, so cross-cutting
refreshes (e.g. an ICD import finishing should update the dataset status) were
easy to miss — forcing manual page reloads. This SPA centralises server state
in **TanStack Query** and drives refreshes from a single WebSocket
event → invalidation map (`src/lib/wsInvalidation.ts`), so updates are
automatic and consistent.

## Architecture

| Concern | File |
|---------|------|
| Fetch wrapper (cookie auth, 401 → login) | `src/lib/api.ts` |
| Query keys (single source of truth) | `src/lib/queryKeys.ts` |
| Shared WebSocket (reconnect, ping) | `src/lib/ws.ts` |
| **WS event → query invalidation** | `src/lib/wsInvalidation.ts` |
| App shell + tab nav | `src/App.tsx` |
| Entry: QueryClient + WS bridge | `src/main.tsx` |

Auth stays server-side: the Python `/admin/login` page issues an HttpOnly
session cookie. The SPA never handles tokens; on 401 it navigates to
`/admin/login`.

## Develop

```bash
npm install
# Point at a running Python server (default http://localhost:8000):
ADMIN_API_TARGET=http://localhost:8000 npm run dev
# open http://localhost:5173/admin (after logging in via the Python login page)
```

## Build

```bash
npm run build      # → dist/  (served by the Python server at /admin)
```

## Migration status

- [x] Phase A — scaffold, reactive backbone, Overview
- [x] Phase B — Services (cached probes + on-demand re-probe)
- [x] Phase C — Datasets + import (upload/activate/import/embed; reactive status via WS)
- [x] Phase C+ — drug pipeline panel + license browser + inline asset preview,
      version-history modal, generic data-preview modal, schedule modal
- [x] Phase D — Tasks + live logs (jobs table, live detail modal, steps, control, log viewer)
- [x] Phase E — Settings (per-group forms, dirty tracking, test, model picker, show_if)
- [x] Phase F — SPA is the only admin UI. Dockerfile builds dist/; `/admin`
      serves the SPA unconditionally (503 with build instructions if dist/ absent);
      ADMIN_UI toggle removed; deleted the 6 legacy tab modules (~4,925 lines).
      Follow-up (optional): trim the now-dead overview-builder functions still
      inside admin_html_shell.py (login/session/payload there are still in use).

---
title: HTTPS development startup lifecycle
status: done
area: dev
owner: codex
updated: 2026-10-21
links: []
---

Reproduce shutdown during HTTPS startup and blocking certificate generation, then fix with regression coverage.

Both regressions failed at main@origin: the timer was blocked and shutdown left two HTTPS listeners alive.
After the fix, Latitude ran all 46 dev/https.test.ts tests successfully, including real Vite, TCP, TLS, HTTP/2,
WebSocket, certificate generation, and process error tests. No new mocks.

Use Effect (existing dependency) for process execution telemetry at the dev-tool boundary. The library catalog's
process/filesystem entry names platform-node; this app's existing Node-only dev adapter remains app-local under
SDK-4's app exemption. No additional library or runtime was introduced.

The certificate API is asynchronous throughout, including its two end-to-end consumers. Pending startup is retained
until it settles; a close request disposes of any listener it creates instead of publishing it as ready.

# ADR-0002: Runtime API URL Contract

- Status: Accepted
- Date: 2026-03-12

## Context

The web app must resolve the daemon API URL consistently across:

- Vite local development
- ElectroBun desktop distribution
- CLI-distributed runtime

## Decision

Use a single runtime contract with this precedence order:

1. `window.__BURNS_RUNTIME_CONFIG__.burnsApiUrl` (desktop/CLI runtime contract)
2. `VITE_BURNS_API_URL` (web development override)
3. fallback `http://localhost:7332`

A shared schema in `@burns/shared` defines runtime config payloads.

## Rationale

- Desktop and CLI can inject runtime values without rebuilding web assets.
- Vite env remains the normal local-development override.
- Fallback preserves predictable behavior for local startup.

## Consequences

- Runtime injections must provide an absolute URL.
- The web app logs diagnostic warnings for malformed runtime contract URLs and then falls back.

# Production Readiness Notes

This document covers operational guidance for running Smithers in production.

## Requirements
- Bun `>= 1.3` (Smithers uses Bun SQLite and Bun runtime APIs).
- SQLite for workflow and internal state.
- Optional: JJ (Jujutsu) for snapshot pointers.

## Deployment Modes
- **CLI**: `smithers run workflow.tsx --input '{}'`
- **Server**: `startServer({ port, rootDir, db, authToken, allowNetwork, maxBodyBytes })`

## Server Configuration
- `port`: Listening port (default `7331`).
- `rootDir`: Constrains workflow path resolution and tool sandboxing.
- `db`: Enables `/v1/runs` list endpoint and central run registry. When provided, events are mirrored into this DB for API queries.
- `authToken`: Required for API access when set (also via `SMITHERS_API_KEY`).
- `allowNetwork`: When `false`, the `bash` tool blocks network commands.
- `maxBodyBytes`: Max request size (default `1_048_576`).

## Environment Variables
- `SMITHERS_API_KEY`: Bearer token for server auth.
- `SMITHERS_DEBUG=1`: Enables extra server/engine logging.

## Resource Limits
Set via CLI or programmatic options:
- `maxConcurrency`: Max parallel tasks.
- `maxOutputBytes`: Max tool output bytes (default `200_000`).
- `toolTimeoutMs`: Tool timeout (default `60_000`).

## Observability
- Events are stored in `_smithers_events` and streamed over SSE.
- Default event log file for CLI runs: `.smithers/executions/<runId>/logs/stream.ndjson`.
- Consider log shipping (e.g., Filebeat) if you need centralized observability.

## Backups
SQLite files are the source of truth for runs and outputs.
- Use filesystem-level snapshots or periodic copies.
- For active runs, coordinate backups to avoid partial writes.

## Security
- Always set `authToken` in server mode.
- Keep `rootDir` narrow to the minimum required.
- Leave `allowNetwork` off unless you explicitly need network access for tools.
- Run the server behind a reverse proxy if you need rate limiting, TLS termination, or IP allowlisting.

## Upgrade Guidance
- Internal tables are created automatically by `ensureSmithersTables`.
- If schema changes are introduced, plan for a migration step (no migration runner is included yet).

## Desktop App (apps/desktop)

### Accessibility Features
The desktop UI has been hardened for accessibility compliance:

- **ARIA Labels**: All interactive elements (buttons, selects, dialogs) have descriptive `aria-label` attributes
- **ARIA Roles**: Proper semantic roles (`menubar`, `menu`, `menuitem`, `dialog`, `tablist`, `tab`, `tabpanel`, `toolbar`, `listitem`, `status`, `alert`)
- **Keyboard Navigation**:
  - Skip link for jumping to main content
  - Escape key closes all modals
  - Enter/Space activates list items
  - Tab navigation through all interactive elements
  - Focus indicators on all focusable elements
- **Screen Reader Support**:
  - Live regions for notifications (`aria-live="polite"` and `aria-live="assertive"`)
  - Hidden decorative elements (`aria-hidden="true"`)
  - Screen-reader-only helper text (`.sr-only` class)
- **Visual Accessibility**:
  - WCAG AA compliant color contrast
  - `prefers-reduced-motion` support
  - `prefers-contrast: more` support for high contrast mode
  - Minimum touch target sizes (32px)
  - Visible focus rings on interactive elements

### Desktop Security
The desktop app follows production security practices:

- **Path Sandboxing**: All file operations are constrained to `rootDir` with symlink protection
- **Network Blocking**: Bash commands are blocked from making network requests by default
- **Output Limits**: Tool outputs are truncated to prevent memory exhaustion
- **Timeout Handling**: Long-running bash commands are terminated after timeout
- **Secure Defaults**: Network access disabled, path traversal prevented

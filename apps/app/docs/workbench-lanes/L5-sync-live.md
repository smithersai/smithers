# Lane L5 — Sync actions against live plue routes (2026-09-02)

plue-0c reports epic #474 live in production. Design: ADR 0005
(`docs/decisions/0005-linear-github-sync.md`) with its `Shapes needed` list
(#468–#473); the earlier `sync.REPORT.md` says what is degraded. Files:
`state/seams/LinearSeam.ts`, `GitHubSeam.ts`, `RepoImportSeam.ts`,
`IssuesSeam.ts`, their cards under `cards/` (connector-setup, sync-ops,
repo-import, issue cards), controller `connectors.ts`. Laws: apps/app/AGENTS.md
(no useEffect, collections via dispatcher, every act a flow with data-flow,
NO INVENTION, server errors verbatim, failed ops never hidden).

## Replace degraded wording with the live shapes

1. Linear connect: `GET /api/auth/linear` handoff → `?setup=<key>`; `GET
   /api/linear/setup/{setupKey}` → `{ teams[] { id, name, key }, expires_at }`;
   `POST /api/linear { setup_key, linear_team_id, repo }` (#469). Expired key
   reads `authorization expired · Open Linear again`.
2. Sync now: `POST /api/linear/{id}/sync` → `{ run_id }`; `GET
   …/sync/{runId}` for live header counts; ops feed `GET /api/linear/{id}/ops?
   status=&since=&limit=` newest first; per-op `POST …/ops/{opId}/retry`
   (#468). Rows: glyph, `source → target`, entity + id, action, age; failed
   rows carry the error verbatim and Retry.
3. Disconnect (typed team key as the confirm) and Activity (last 24 h with
   `load older`).
4. Issue Linear link/unlink: `POST /api/repos/{o}/{r}/issues/{n}/linear-link
   { identifier }`, `DELETE` to unlink; `linear` on the issue DTO renders the
   `Linear ENG-482` line (#473).
5. GitHub App: `github.app` / `github.reconcile` per repo with install_url and
   the connected state; import as a job card polling `GET
   /api/github/import/{id}` for `stage`, `{ refs, objects, issues } { done,
   total }`, `error`, `repository`, `workspace_id?`, and `POST
   …/import/{id}/retry` (#471); mirror sync as a run: `POST …/mirror-sync`
   → `{ run_id }`, `GET …/mirror-sync/{run_id}` with `{ state, refs[] {
   name, from, to, status, error } }` (#470); the repository DTO's
   `mirror_status` word (`unconfigured` observed live) on the card header.
6. Rate limit: a refused proxied call answering `{ code:
   "github_rate_limited", limit, remaining, reset_at }` renders the line
   `GitHub rate limit reached · <remaining> of <limit> · resets <time>` on
   the failing card with Retry disabled until `reset_at` (#472).

Where a route answers with a different shape, parse what it returns, render
that, and record the mismatch (field, expected, observed) in the REPORT.

## Tests

Seam tests per route with fixtures shaped as above (mark `unverified` when
not observed live); card tests for each state named in ADR 0005 (authorizing,
active, failed op with Retry, expired key, importing with counts, failed
import with Retry, rate-limited with disabled Retry). Keep existing sync
tests green.

## Verification

`cd apps/app && bun x tsc --noEmit -p . && bun test src/mainview/state/seams src/mainview/cards`, then the full `bun test src` once (3 pre-existing TargetGraph fixture failures; do not touch). Write `L5-sync-live.REPORT.md`.

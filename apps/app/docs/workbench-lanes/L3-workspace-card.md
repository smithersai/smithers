# Lane L3 — Workspace card completion + egress facet (2026-09-02)

plue-0c reports these live in production. The workspace card
(`cards/WorkspaceCard.tsx`, seam `state/seams/WorkspaceSeam.ts`, terminal
client `state/CloudTerminalClient.ts`) renders degraded wording where the
fields were missing. Design: ADR 0002 (`docs/decisions/0002-citc-sandbox-kinds.md`),
`citc.REPORT.md` for what is stubbed. Laws: apps/app/AGENTS.md (no useEffect,
collections via dispatcher, every act a flow with data-flow, NO INVENTION,
server errors verbatim).

Live sample (probed 2026-09-02 from the app, `GET /api/repos/smithersai/smithers/workspaces`):
`{ id, repository_id, user_id, name: "smithers landing", target_bookmark:
"landing/smithers/main", status: "suspended", kind: "container", environment
{ source: ".smithers/environment.nix", revision, closure_hash }, head {
change_id, commit_id }, ahead: 0, behind: 0, is_fork: true, vm_id, persistence:
"persistent", ssh_host: "<vm>@ssh.jjhub.tech", idle_timeout_seconds: 1800,
last_activity_at, suspended_at, started_at: null, ... }`.
`GET /api/user/workspaces` is live on plue (rows `{ workspace_id, repository_id,
repository_owner, repository_name, workspace_title, state, last_accessed_at, ... }`)
but the cloud Worker (apps/server `PLATFORM_PROXY_RULES`) only started forwarding
it in this tree and is not deployed yet, so the app sees a Worker 404 until the
deploy: keep the per-repo list as the source, keep the per-user parser, and
parse the row shape above (not the per-repo DTO) when the per-user route answers.

## Fields and facets

1. Header: kind label (`container` / whatever `kind` says), `head` (change id
   short, commit id short; absent when empty strings), `ahead` / `behind`,
   uptime from `started_at` (absent when null), environment reference
   (`environment.source`, revision short when non-empty), `persistence`,
   `ssh_host` as a copyable line (#446).
2. Files facet: `GET /api/repos/{o}/{r}/workspaces/{id}/files?path=` (#449),
   rendered with the same listing component the local file card uses, file
   click reads the file through the workspace route and renders the file
   card (markdown through the editor). Services facet: `GET
   …/workspaces/{id}/services` rows with name, state, port/url as returned.
   Verify the exact route paths against the server (curl through the app's
   local origin needs the `x-smithers-local-session` header from the page's
   meta tag; the bridge is the orchestrator's, so write the seam against the
   documented path and record the observed status in the REPORT).
3. Egress facet (#? plue "egress audit"): `GET
   /api/repos/{o}/{r}/workspaces/{id}/egress` and `GET
   …/agent-sessions/{id}/egress`, cursor paginated, rows `{ occurred_at,
   host, method, path, status, allowed, swapped_secret_names[] }` rendered as
   "what this computer called and with which secret names", never values. A
   workspace whose creation fails with `egress_proxy_unavailable` says
   exactly that on the card.
4. Resume / suspend / fork / snapshot / delete keep their flows; the card's
   status line reads the six statuses as before.

## Tests

Seam parser tests with the live sample above as the fixture; card tests for
each header field present/absent, Files listing and file open, Services
rows, Egress rows and pagination, the egress_proxy_unavailable line. Keep
`WorkspaceSeam.test.ts` and the CitC race tests green.

## Verification

`cd apps/app && bun x tsc --noEmit -p . && bun test src/mainview/cards/WorkspaceCard.test.tsx src/mainview/state/seams/WorkspaceSeam.test.ts src/mainview/state/CloudTerminalClient.test.ts`, then the full `bun test src` once (3 pre-existing TargetGraph fixture failures; do not touch). Write `L3-workspace-card.REPORT.md` with every route/status observed.

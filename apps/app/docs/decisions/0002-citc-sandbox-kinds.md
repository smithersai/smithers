# ADR 0002 — CitC: sandbox kinds, environments, desktop phases (2026-09-01)

Source: plue backend session handoff.

- Three sandbox kinds share one option surface: `container` (light), `vm`
  (full NixOS), `desktop` (vm plus GUI). No "workspace class" picker: the
  kind is the choice.
- Environments are NixOS built from a per-repository Nix expression,
  `.smithers/environment.nix`. No image picker; an environment picker plus a
  Nix expression editor comes later.
- Desktop Phase A is a stock Kasm container (KasmVNC, basic auth) not wired
  to the API; the desktop card is NOT built against it. Phase B (NixOS VM
  desktop through the preview-gateway relay) has not started. Transport is
  still open; the UI contract stays WORKBENCH-UX §5 and §6.
- Exists today: workspaces CRUD and states `pending|starting|running|
  suspended|stopped|failed`, snapshots, forks, shares; terminal over a
  WebSocket attach with a one-time ticket; changes with `change_id`,
  `commit_id`, `parent_change_ids`, `has_conflict`; landing requests and
  reviews; jj operation log; code search.
- In flight behind `feature_flags.changesets`: `POST/GET /api/orgs/{org}/
  changesets`, `POST …/{id}/land`; changeset `state pending|landing|landed|
  failed`; poll GET, no realtime yet. DTOs are draft until forwarded.
- Secrets at the edge: per-secret `hosts` and `match_headers` bindings on the
  environment settings; the settings UI exposes both.

## Backend facts for the workspace card (plue-0c, 2026-09-01)

- Exists: create, get, list (per repo and per user), delete, suspend,
  resume, fork; snapshots create/get/list/delete/template; sessions
  create/get/list/destroy/stream; status stream; SSH info; terminal
  WebSocket. Six statuses: pending, starting, running, suspended, stopped,
  failed.
- Missing, never faked: Files and Services facets have no routes
  (plue#449) — render both empty until then. The workspace DTO has no kind,
  no environment reference, no started_at, no workspace head (plue#446):
  no kind label in the tree row, no uptime line, and the header shows the
  TARGET BOOKMARK's head from the bookmarks call, labeled as the bookmark
  head, not the workspace head.
- DTO today: id, repository_id, user_id, name, slug, branch,
  target_bookmark, repo_full_name, html_url, status, provisioning_stage,
  is_fork, parent_workspace_id, vm_id, persistence, ssh_host, snapshot_id,
  idle_timeout_seconds, suspended_at, created_at, updated_at.

## Defaults taken 2026-09-02 (reversible; will's two open calls)

- No environment or image picker in the workspace card, now or later, unless
  will says otherwise: kind and environment come from the repository's
  `.smithers/environment.nix`; a repository without one offers `container`
  only, stated in words.
- Fork and Snapshot sit on the card footer beside Suspend/Resume; the
  Snapshots facet lists snapshots with Fork from / Save as template / Delete.

## Terminal attach contract (plue-0c, 2026-09-02)

`GET wss://api.jjhub.tech/api/repos/{o}/{r}/workspace/sessions/{id}/terminal`,
subprotocol `terminal`. A Bearer PAT alone is accepted (RequireAuth →
write:repository → repo write → feature gates → per-user open-rate limit);
the `?ticket=` from `POST /api/auth/sse-ticket` (30 s, single use) exists
only for browsers, so the Bun tunnel sends the bearer and no ticket. The
Origin header is mandatory and checked before auth: plue#475 (deployed
2026-09-02 15:14 UTC, API image 6093db276aad) skips that check for Bearer
principals (cookie sessions keep the allowlist), so the tunnel sends NO Origin
unless `SMITHERS_CLOUD_WS_ORIGIN` is set, a knob for environments that still
enforce it. No reserved app origin exists. Max message 64 KiB; server pings; resize is
text JSON `{"type":"resize","cols","rows"}`; PTY bytes are binary frames.
Pre-upgrade failures are HTTP (401 ticket, 403 origin, 409 session
provisioning or stopped, 429 caps). Close codes: 1008 `access revoked: …`
(final, the card says revoked), 1011 `failed to attach terminal` (retry
once), 1001 `terminal client too slow` (reconnect), 1000 normal (final).

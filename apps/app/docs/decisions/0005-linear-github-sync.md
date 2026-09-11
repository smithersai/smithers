# ADR 0005 — Linear and GitHub sync as actions (2026-09-02)

Source: will's ask relayed by plue-0c. Laws as every ADR: every act is a
flow with slash, agent, and button invocation; every result is a card in
the chat; no settings page; a failed op is never hidden and reads the
server's error verbatim with Retry.

## Position

Sync is an activity, not a setting. The user connects once through a card
that walks the handoff, and from then on every sync is a result card whose
rows are the durable ops the backend already records. One card kind,
`sync-ops`, serves Linear syncs and GitHub mirror syncs; one card kind,
`connector-setup`, serves both handoffs. Connection state lives on the
existing Connectors surface as rows, never on a page of its own.

## Connect Linear

`/linear.connect [repo]` → `connector-setup` card, kind `linear`. Steps
render as rows that fill in; the card is the wizard, embedded.

```
┌ Connect Linear ────────────────────────────── ● AUTHORIZING ┐
│ 1  Authorize in your browser          [ Open Linear ]        │
│ 2  Team                               —                      │
│ 3  Repository                         smithersai/smithers    │
│ 4  Confirm                            —                      │
└──────────────────────────────────────────────────────────────┘
```

Step 1 opens `GET /api/auth/linear` through the native `openExternal`
door; the callback returns a setup key to the local origin and the row
reads `authorized as <linear_actor>`. Step 2 lists the teams the key can
see (`ENG · Engineering`); pick is one click. Step 3 defaults to the
active repository; the picker is the tree from ADR 0001. Step 4 is the
Confirm button (`linear.connect.confirm`), which posts the integration and
turns the card into the connected state:

```
┌ Linear · ENG → smithersai/smithers ──────────────── ● ACTIVE ┐
│ two-way · issues and comments · last sync 4 min ago           │
│                        Sync now   Activity   Disconnect       │
└──────────────────────────────────────────────────────────────┘
```

Disconnect is a confirm flow. A handoff that fails reads the server error
verbatim under step 1 with Retry; an expired setup key reads `authorization
expired · Open Linear again`.

## Sync now and the activity feed

`/linear.sync [integration]` and `/github.mirror-sync [repo]` both render a
`sync-ops` card. Rows are the ops, newest first; nothing is summarized away.

```
┌ Sync · Linear ENG ↔ smithersai/smithers ─────── ● RUNNING · 12 ops ┐
│ ✓ linear → Smithers Cloud   issue ENG-482   created #91          2s ago      │
│ ✓ Smithers Cloud → linear   comment #88     created              2s ago      │
│ ✗ Smithers Cloud → linear   issue #90       update   Retry                   │
│   "Linear API: 422 label 'infra' does not exist on team ENG"        │
│ ● linear → Smithers Cloud   comment ENG-480 create                           │
│ 9 more · show                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

Row: status glyph, `source → target`, entity and id, action, age; a failed
row carries the error verbatim on its own line and a Retry action
(`sync.retry <opId>`, no confirm: retrying a sync is not consequential).
The header counts stay live while ops arrive (poll until the run settles).
`Activity` on the connected card opens the same card for the last 24 hours
with a `load older` action; failures are never filtered out.

For a mirror sync the rows are refs: `✓ push  refs/heads/main  b775d9 →
github`, and the header carries the mirror state: `synced` or `behind
GitHub · 3 refs`, from the mirror status DTO once it exists, else no state
word at all.

## Link an issue to Linear

The `issue` card gains one line when a mapping exists, `Linear ENG-482`,
and one action when none does, `Link to Linear…`. THE FORM LAW (will,
2026-09-03, `AGENTS.md`) supersedes the composer prefill written here: the
action is the button door of `issues.link-linear` carrying the issue
number, and the flow renders the form that asks for the identifier. The
flow posts the mapping; the line appears; unlink is
`/issues.unlink-linear 90` (confirm).

## Connect the GitHub App

`/github.app [repo]` (today's `repos.app`) → `connector-setup` card, kind
`github`:

```
┌ GitHub App · smithersai/smithers ────────────── ▲ NOT INSTALLED ┐
│ 1  Install the Smithers app on GitHub     [ Open GitHub ]        │
│ 2  Reconcile                              —                      │
│ rate limit · 4 812 of 5 000 · resets 12:40                        │
└──────────────────────────────────────────────────────────────────┘
```

Step 1 opens `install_url` through `openExternal`; step 2 is `Reconcile`
(`github.reconcile`), which posts and re-reads the status. Connected state:
`● CONNECTED · installation 8123 · configured`. The rate-limit line renders
only when `remaining` is below 20% of `limit`, and always on a card whose
call was refused.

## Import a GitHub repository

`/repos.import <owner/repo>` exists (`repo-import` card). It becomes a job
card that polls `import_jobs`:

```
┌ Import · acme/web → acme/web ─────────────────── ● IMPORTING ┐
│ refs 214 of 214 · objects 88 210 of 91 004 · issues 0 of 312  │
│ stage · provisioning_workspace                                │
└──────────────────────────────────────────────────────────────┘
```

Done state links the repository (opens its row in the tree) and, when the
import created one, the workspace card. Failed reads the job's error
verbatim with Retry (`repos.import.retry <jobId>`).

## Rate limits

A GitHub-proxied call refused for rate limit never fails silently: the
card that made it gains the line `GitHub rate limit reached · 0 of 5 000 ·
resets 12:40 · Retry after`, and the Retry action is disabled until the
reset with the time on it. This is a line on the failing card, not a toast
and not a card of its own. The countdown updates at each remaining-minute
boundary. Re-check, Reconcile, and Try again re-enable at the reset without
a store update. The clock stops at the reset or when the card unmounts.

## Connectors surface

The 3-card grid becomes rows (extension-store style, per DESIGN.md §7):
Local repository, GitHub (App per repo, with the connected count), Linear
(per team, with last sync), Smithers Cloud. Each row's one action is the
flow above; state words come only from the DTOs.

## Flows

| Flow | Args | Confirm |
| --- | --- | --- |
| `linear.connect` / `linear.connect.confirm` | `[repo]` | |
| `linear.sync` | `[integration]` | |
| `linear.activity` | `[integration]` | |
| `linear.disconnect` | `<integration> <teamKey>` (the key typed back is the user confirm; the card's second click sends it) | yes |
| `sync.retry` | `<opId>` | |
| `issues.link-linear` / `issues.unlink-linear` | `<n> <identifier>` / `<n> <identifier>` (typed back as the user confirm) | unlink yes |
| `github.app` (renames `repos.app`), `github.reconcile` | `[repo]` | |
| `repos.import`, `repos.import.retry` | `<owner/repo>` / `<jobId>` | |
| `github.mirror-sync` | `[repo]` | |

## Shapes needed beyond the stated facts

1. `POST /api/linear/{id}/ops/{opId}/retry` and `GET /api/linear/{id}/ops?
   status=&since=&limit=` (paged, newest first) for the feed; `POST
   /api/linear/{id}/sync` returns a run id and `GET …/sync/{runId}` for
   the live header counts.
2. Team pick before create (settled): the OAuth callback redirects with
   `?setup=<key>`; `GET /api/linear/setup/{setupKey}` → `{ teams[] { id,
   name, key }, expires_at }` (no tokens); then `POST /api/linear
   { setup_key, linear_team_id, repo }`. Flow: handoff, GET setup, pick,
   create.
3. Mirror: `POST …/mirror-sync` returns `{ run_id }`; `GET …/mirror-sync/
   {run_id}` with `{ state, refs[] { name, from, to, status, error } }`;
   the per-repo mirror status DTO already filed feeds the header word.
4. Import job progress on `GET /api/github/import/{id}`: `stage`, counts
   `{ refs, objects, issues } { done, total }`, `error` verbatim,
   `repository`, `workspace_id?`, and `POST …/import/{id}/retry`.
5. Rate limit: `github_rate_limit_reset` on `repo_connections`, and a
   refused proxied call answering `{ code: "github_rate_limited", limit,
   remaining, reset_at }`.
6. Issue mapping routes: `POST /api/repos/{o}/{r}/issues/{n}/linear-link
   { identifier }`, `DELETE` to unlink, and `linear` on the issue DTO.

## Filed (plue, 2026-09-02)

Epic #474: #468 ops feed + per-op retry + sync runs; #469 team pick via setup lookup; #470 mirror sync as a run; #471 import progress + retry; #472 rate-limit reset + structured 429; #473 issue linear-link/unlink + `linear` on the issue DTO.

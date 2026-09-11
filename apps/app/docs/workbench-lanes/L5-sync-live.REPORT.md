# Lane L5 — Sync actions against live plue routes — REPORT

Brief: `L5-sync-live.md`. ADR: `../decisions/0005-linear-github-sync.md`.
Predecessor: `sync.REPORT.md` (what was degraded).

## Verdict in one line

Every degraded wording is gone: the ops feed, the per-op retry, the sync
runs, the mirror runs, the issue linear-link and the repository's
`mirror_status` are all real calls now, shaped against plue's own source —
but **not one of them was observed answering in production**, because every
`/api/linear*` route is 404 in prod today (below), so the Linear half is
marked `unverified` against a live server.

## How the shapes were established

The brief said epic #474 is live. It is **merged**, not **serving**.

- **Source of truth used:** `~/plue` at `31957d42f` (main). The epic's
  commits are in it: `b9bcc2e76 feat(linear): add sync runs and operation
  retries` (#468) and `01a4e5843 feat(linear): expose OAuth setup teams`
  (#469), plus the mirror-run, import-progress, rate-limit and issue-link
  work. Routes read off `cmd/server/router.go`; payloads off
  `internal/routes/linear_integration.go`, `internal/services/
  linear_sync.go`, `internal/routes/git_mirror_sync.go`, `internal/services/
  git_mirror_sync.go`, `internal/routes/issue_linear_link.go`,
  `internal/services/{issue,github_import,github_proxy}.go`, `pkg/errors/
  errors.go`, and the CHECK constraints in `db/migrations/
  20260902171700_linear_sync_runs.sql`, `20260902171800_
  github_mirror_sync_runs.sql`, `20260902170200_github_mirror_status.sql`.
- **Live probe (`https://api.jjhub.tech`, 2026-09-02):**

  | probe | code | reading |
  | --- | --- | --- |
  | `GET /api/integrations/mcp` | 401 | route registered, auth required |
  | `GET /api/github/import/x` | 401 | registered |
  | `POST /api/github/import` | 401 | registered |
  | `POST /api/github/import/x/retry` | 401 | registered |
  | `GET /api/repos/a/b/github-app-status` | 401 | registered |
  | `POST /api/admin/github-app/reconcile` | 401 | registered |
  | `GET /api/integrations/linear` | **404** | **not serving** |
  | `GET /api/linear/setup/abc` | **404** | **not serving** |
  | `POST /api/linear` | **404** | **not serving** |
  | `POST /api/linear/1/sync` | **404** | **not serving** |
  | `POST /api/linear/1/ops/1/retry` | **404** | **not serving** |
  | `GET /api/repos/a/b/mirror-sync/1` | 404 | inconclusive — `GET /api/repos/a/b` is 404 too, and that route IS registered (the repo just doesn't exist) |
  | `POST /api/repos/a/b/issues/1/linear-link` | 404 | inconclusive, same reason |

  `/api/integrations/mcp` (401) and `/api/integrations/linear` (404) sit in
  the SAME chi route group, so the 404 is not a missing deploy of that
  group — it is `linearHandler == nil`. `cmd/server/main.go:1146` only
  builds the handler when `cfg.Auth.LinearClientID` **and**
  `LinearClientSecret` are both set. **The deployed API has no Linear OAuth
  client configured, so the whole Linear feature is unrouted in production.**
  That is an ops fact, not an app defect; nothing in this lane changes when
  it is configured.

Everything marked `unverified` below means: shape taken from plue's source,
double-tested, never seen on a live wire.

## Route and field mismatches (route, expected, observed)

| # | Route | Expected (brief / ADR) | Observed (plue main) | What the app does now |
| --- | --- | --- | --- | --- |
| 1 | integrations list | `GET /api/linear` | **`GET /api/integrations/linear`.** `GET /api/linear` is not registered at the api root at all (only `POST /api/linear` is). | **Real defect fixed.** The old path answered nothing, so `refreshIntegrations` silently dispatched nothing and every bare `/linear.sync`, `/linear.activity`, `/linear.disconnect` answered "No Linear integration is connected". Pinned by a test. `unverified` live. |
| 2 | disconnect | `DELETE /api/linear/{id}` | **`DELETE /api/integrations/linear/{id}`.** The `/api/linear/{id}` group registers only `/ops`, `/sync`. | **Real defect fixed.** Disconnect could never have worked. `unverified` live. |
| 3 | setup lookup | `{ teams[], expires_at }` **and** an actor for `authorized as <linear_actor>` | `LinearOAuthSetupResult` is `{ teams[] {id,name,key}, expires_at }` — **no viewer, no actor field**. | The row reads a bare `authorized`. The tolerant `viewer.name` parse stays (harmless), but the ADR's `authorized as <actor>` has no wire field behind it. `unverified`. |
| 4 | `POST /api/linear/{id}/sync` | 202 `{ run_id }` | Matches — 202 `{"run_id": <int64>}`. **But** the older `POST /api/integrations/linear/{id}/sync` answers `{"status":"sync_started"}` instead, and the seam was reading `status` off the run route. | Reads `run_id`, renders `run 41` and tracks the run. A 202 with no `run_id` is not treated as started. `unverified`. |
| 5 | `POST …/sync` 409 | ADR implied `{"status":"sync_already_running"}` | `StartLinearSyncRun` answers a plain `APIError`: `{"message":"linear sync already running"}` (and `"linear integration is inactive"`). No `status` token. | Both read verbatim on the card. `unverified`. |
| 6 | `GET /api/linear/{id}/sync/{runId}` counts | flat `{ total, done, failed }` | **per entity**: `{ issues: {done,total,failed}, comments: {done,total,failed} }` | `sumRunCounts` adds every bucket the wire names, so a third bucket lands with no code change. Header reads `10 of 12 · 1 failed`. `unverified`. |
| 7 | run `state` | `running \| done \| failed` (the old card enum) | **`pending \| running \| completed \| failed`** (`linear_sync_runs.state` CHECK) — and a mirror run is **`queued \| running \| succeeded \| failed`**. | The card's `runState` is now a plain string and the WIRE's word renders through `StatusPill`, whose shared vocabulary already tints all six. Nothing is renamed. |
| 8 | op row | `error`, status `done \| failed \| running \| pending` | `error_message`; status **`pending \| success \| failed \| skipped`** (`linear_sync_ops_status_check`). Op `id` is an int64, `entity_id` a string, `created_at` the age. | Parsed as named; the op `status` is a plain string rendered verbatim. Only `failed` is retryable (plue refuses any other with 409). |
| 9 | `GET …/ops` paging | `status=&since=&limit=` | Matches. `limit` defaults 50, **caps at 100**; `since` must be RFC3339; `status` accepts only `""\|pending\|success\|failed\|skipped`. No cursor — `since`+`limit` is the whole paging surface. | Activity cuts at 24 h with `limit=50`; `hasOlder` is "the page came back full"; **Load older** re-reads at `limit=100` with no `since` (there is nothing better to page with). |
| 10 | `POST …/ops/{opId}/retry` | ADR flow is `sync.retry <opId>` | The route is **per integration**: `/api/linear/{id}/ops/{opId}/retry`. An op id alone cannot address it. | `sync.retry <opId>` finds the sync-ops card that lists the op and uses its `integrationId`. No card listing the op ⇒ no call, and the answer says where Retry lives. |
| 11 | `POST /api/linear` echo | ADR/seam read `linear_team_key` off it | The 201 answers `{id, linear_team_id, linear_team_name, repo_owner, repo_name, is_active}` — **no `linear_team_key`**. | The key comes off the refreshed list row, else the team picked at step 2. `unverified`. |
| 12 | reconcile | `POST /api/github-app/reconcile`, per repo | **`POST /api/admin/github-app/reconcile`** — admin-scoped and global, not per repo. | **Real defect fixed** (the old path was simply unrouted). A non-admin now gets plue's own 403 sentence verbatim, and the status re-read still lands. The ADR's per-repo user reconcile does not exist. |
| 13 | mirror run | `GET …/mirror-sync/{run_id}` → `{ state, refs[] {name,from,to,status,error} }` | Matches, plus `started_at`/`finished_at`. Ref `status` is **`pending \| succeeded \| failed`**. Path param is `{run_id}`. | Each ref is one card row. |
| 14 | mirror ref row | ADR draws `✓ push refs/heads/main b775d9 → github` | The wire has `from`/`to` **revisions**, not a destination name. | Rendered `<from> → <to> ref <name> push` (`—` for an empty side). The literal `→ github` of the ADR sketch has no field behind it. |
| 15 | per-ref retry | ADR gives failed rows a Retry | **No per-ref retry route exists.** | A failed ref carries its error verbatim and `retryable: false`. The run is re-run with `/github.mirror-sync`. |
| 16 | `mirror_status` | on "the repository DTO" | `RepoResponse.mirror_status` on `GET /api/repos/{o}/{r}` — `synced \| behind \| failed \| unconfigured` (plus `last_mirror_at`, `last_mirror_error`, `last_mirror_github_head`). | The mirror card reads that route for that one field and puts the word on its header, before the run and again once it settles. A read the app cannot make leaves **no** state word (the ADR's own rule). Brief says `unconfigured` observed live; I could not reach a repository unauthenticated to confirm — `unverified`. |
| 17 | import job | `stage`, `{refs,objects,issues}{done,total}`, `error`, `repository`, `workspace_id?`, retry | Matches `services.ImportJob` exactly. | Already parsed; the card now also renders `stage · provisioning_workspace` (it was parsed but never shown). Routes are 401-live, i.e. registered. |
| 18 | structured 429 | `{code:"github_rate_limited", limit, remaining, reset_at}` | Matches (`pkg/errors.CodeGitHubRateLimited`, raised in `internal/services/github_proxy.go`), plus `message` and `retry_after`. | Unchanged and correct; now also carried on a mirror-run poll refusal and an import poll refusal. |
| 19 | issue link | `POST/DELETE /api/repos/{o}/{r}/issues/{n}/linear-link {identifier}`, `linear` on the issue DTO | Matches: 201 `{identifier, url}` / 204, and `IssueResponse.Linear *LinearIssueReference` → `"linear": {identifier,url}` or `null`. | Both are real calls now. Route registered behind the imported namespace, so a 404 still means "not imported". |

## Files changed

Seams:

- `src/mainview/state/seams/LinearSeam.ts` — rewritten. List/delete moved to
  `/api/integrations/linear`; `syncNow` starts a run and `trackRun` polls
  `…/sync/{runId}` + `…/ops` until the run settles; `activity` reads the
  24-hour window; `retryOp` resolves the integration from the op's own card;
  new `loadOlderOps`. `sumRunCounts`, `linearSyncPolling`, `OPS_PAGE_LIMIT`,
  `OPS_OLDER_LIMIT` exported. Deleted: `NO_OPS_FEED_NOTE`,
  `NO_OP_RETRY_REFUSAL`, `NO_TEAM_PICK_NOTE`.
- `src/mainview/state/seams/GitHubSeam.ts` — reconcile → the admin route;
  `mirrorSync` starts a run and `trackMirrorRun` polls it into per-ref rows;
  `readMirrorStatus` reads the repository DTO for `mirror_status`.
  `parseMirrorRef`, `mirrorSyncPolling` exported. Deleted:
  `NO_MIRROR_OPS_NOTE`.
- `src/mainview/state/seams/IssuesSeam.ts` — `linkLinear` POSTs, `unlinkLinear`
  DELETEs, both re-read the detail card. Deleted `NO_LINEAR_LINK_REFUSAL`.
  The typed-identifier confirm still gates the unlink before any call.
- `src/mainview/state/seams/SeamContext.ts` — comment only (names the plue
  symbol that raises the structured 429).
- `src/mainview/state/seams/RepoImportSeam.ts` — **unchanged**: its parse
  already matched `services.ImportJob` field for field.

Cards:

- `src/mainview/cards/SyncCards.tsx` — `opGlyph`; op rows gained the glyph,
  the age, and `StatusPill` on the wire's own word; header gained the run id
  and the mirror status word; `Load older`; Show more names its count.
- `src/mainview/cards/RepoImportCard.tsx` — renders `stage · <word>`.
- `src/mainview/cards/IssueCards.tsx` — **unchanged** (it already rendered
  the DTO's `linear` line and the `Link to Linear…` prefill; only the seam
  behind them was fake).

Schema, flows, wiring:

- `packages/rpc/src/Cards.ts` — `sync-ops` payload: `runState` enum → string,
  op `status` enum → string, new `runId` and `mirrorStatus`. Additive/widening
  only; no schema bump. *(Not on my owned list and shared with other lanes —
  the card payload types live here, not in `AppState.ts`, which only
  re-exports them. Flagged rather than assumed.)*
- `src/mainview/flows/Flows.ts` — added hidden `sync.ops.load-older`.
- `src/mainview/flows/SlashPayload.ts` — its parser row.
- `src/mainview/state/AppController.ts` — `loadOlderSyncOps` (3 anchored spots).
- `src/mainview/ChatCards.tsx` — comment only (the pill note now names the
  two live state vocabularies; `pillStatus` already passed the word through).
- `src/bun/LinearAuth.ts` — comment only.
- `src/mainview/flows/parity.test.ts` — SyncCards affordance pin 13 → 14.
- `src/mainview/flows/registry.test.ts` — the new command in the pinned list.
- `e2e/playwright/sync.spec.ts` — doubles re-shaped to the live routes; T1's
  sync test now asserts the run's counts, its op rows, the verbatim op error
  and a working Retry instead of the degraded note.

**Not changed, deliberately:** `state/controller/connectors.ts` (it owns the
LOCAL repository connector flow only; nothing in this brief touches it) and
`styles/cards.css` (every new row reuses `world-card-row` /
`world-card-path` / `connect-store-icon` — no new class was needed, so
adding a sync section would have been dead CSS).

**One-line note as the brief allowed:** connector *rows* on the Connectors
pane (`ConnectorsSurface.tsx`) belong to another lane this hour and were not
touched; connector STATE still reaches the user as cards
(`connector-setup`, `sync-ops`) which `App.tsx` already renders through
`ChatCards.tsx`.

## Tests added, by name

`state/seams/LinearSeam.test.ts` (24 tests, 8 new/replaced):

- the live setup answer names no viewer: the authorize row reads a bare authorized
- a setup lookup the server does not route fails step 1 in the product's own voice
- syncNow starts a run and the card carries its id
- the run poll fills the header counts and the ops, and stops when the run settles
- sumRunCounts adds every entity bucket the wire names, and answers null for none
- a run plue refuses to start reads its own sentence verbatim on the card
- a start that names no run id is not a started run
- activity reads the last 24 hours of ops, newest first, failures included
- a full page means older ops exist; load older re-reads without the window bound
- activity states a refused feed verbatim on the card
- retryOp posts through the integration the op's own card names, then re-reads the feed
- retryOp with no card listing the op calls nothing
- a retry plue refuses reads its own sentence verbatim on the card
- the integrations list is read from plue's own path, never /api/linear

`state/seams/GitHubSeam.test.ts` (20 tests, 7 new/replaced):

- reconcile posts plue's own route — /api/admin/github-app/reconcile
- reconcile refused for the admin scope reads plue's sentence and still re-reads the status
- mirrorSync starts a run and carries the repository's own mirror_status word
- a repository DTO the app cannot read leaves the header with NO state word
- the run poll renders one row per ref and stops when the run settles
- parseMirrorRef keeps the wire's status word and error, and never offers a per-ref retry
- a run read the server refuses lands its words on the card and stops the poll

`state/seams/IssuesSeam.test.ts` (21 tests, 4 new/replaced):

- issues.link-linear posts the identifier and the re-read card carries the DTO's link
- a link plue refuses reads its own sentence, never a product paraphrase
- a 404 on the link route means the repository isn't imported, and never falls back
- issues.unlink-linear needs the identifier typed back; only then does the DELETE go out

`cards/SyncCards.test.tsx` (23 tests, 10 new/replaced) — one per ADR 0005 state:

- ADR 0005 authorizing: step 1 is the only act, and no later step claims anything
- ADR 0005 expired key: the wording rides step 1 and Open Linear is still the act
- a started run with no run DTO yet claims no state and no counts
- ADR 0005 active: the live run wears the wire's own state word and its summed counts
- ADR 0005 failed op: the error is verbatim on the row, with Retry naming the op
- a mirror run renders one row per ref and the repository's own mirror_status word
- past the cut, Show more widens the window; older ops offer Load older
- ADR 0005 importing: the counts and the raw stage word, with no act while it runs
- ADR 0005 failed import: the job's error verbatim, with Retry naming the job
- a done import links the repository and the workspace it created
- (kept, widened) a null run state (nothing has answered yet) is never done, and a wire word is never renamed
- (kept) a refused call holds Re-check and Reconcile until the reset, with the time on them
- (kept) RepoImportCardBody — a structured 429 holds Try again until the reset, with the time on it

## Gates

Run from `apps/app`, after the tree recovery described below.

Counts are the FINAL run, taken after lane L1's own files landed (an earlier
run mid-recovery showed 6 extra failures, all L1's, now gone).

- `bun x tsc --noEmit -p .` — **0 errors**.
- `bun test src/mainview/state/seams src/mainview/cards` — **517 pass,
  0 fail**. The six L5-owned suites run alone: **111 pass, 0 fail**.
- `bun test src` (once) — **1650 pass, 13 fail, 8 errors**. None in L5:
  - 3 × the pre-existing TargetGraph fixture failures the brief said not to
    chase (`a real run of //src:typeCheck streams node frames and a critical
    path`, `history and replay round-trip through the repository's own
    disk`, `the graph route answers the force workspace's real DAG`).
  - 10 × `src/bun/Main.test.ts` (`the native main process starts the local
    origin`, `the native RPC surface`). **Not load flake** — I checked: the
    file fails the same way in isolation (4 pass / 6 fail / 4 errors,
    `the native main process printed no report (exit 143)`, i.e. each spawn
    is SIGTERMed at the test's own 5,000 ms deadline). It spawns the built
    native main process and has zero references to anything in this lane
    (`grep -c "linear\|Linear\|mirror\|sync-ops"` = 0), and neither it nor
    `src/bun/main.ts` was touched by this lane. Pre-existing on this machine;
    left alone as an out-of-lane defect.

Playwright was not run (the brief's verification list does not include it);
`e2e/playwright/sync.spec.ts` was updated to the live shapes and typechecks.

## Tree incident (not caused by this lane, but it cost time)

At 20:36 another session ran `jj new` onto an unrelated revision
(`pzxvtpyt`, a `worktree-agent` commit), which moved the working copy to an
empty commit and wiped every lane's uncommitted files from disk. My work
survived in the abandoned working-copy commit `oskxxrxuvlrz` /
`d21ed26ebc55`; I restored my 19 paths from it, then the coordinator
squashed that commit back tree-wide. All L5 markers verified present
afterward (route strings, `mirrorStatus`, `stage · `, `sync.ops.load-older`,
`loadOlderSyncOps`, the parity pin at 14). Seven of my restored paths are
shared with other lanes — `Cards.ts`, `Flows.ts`, `SlashPayload.ts`,
`parity.test.ts`, `registry.test.ts`, `AppController.ts`, `ChatCards.tsx` —
and other lanes had already begun re-writing some of them on the new base
when I restored, so up to a minute of their post-reset work on those seven
files may have been overwritten; the coordinator was told, and the tree-wide
squash subsumes it. The remaining red in the full run is that recovery still
settling in lane L1, not a defect this lane introduced.

## Left unbuilt, with the reason

1. **`authorized as <linear_actor>`** (ADR "Connect Linear" step 1). No wire
   field: `LinearOAuthSetupResult` is teams + expiry. The row reads
   `authorized`. Needs a plue change to name the viewer.
2. **A per-repo, user-scoped GitHub reconcile.** Only
   `POST /api/admin/github-app/reconcile` exists, admin-scoped and global.
   `github.reconcile` calls it and shows the platform's refusal verbatim for
   everyone else. The ADR's step-2 Reconcile is therefore not usable by a
   normal user against today's backend.
3. **Per-ref retry on a mirror run.** No route. A failed ref shows its error
   and the run is re-run whole.
4. **A real cursor for `load older`.** plue's ops feed pages with
   `since` + `limit≤100` only, so "older" is a second read at the maximum
   page size rather than a true page-back. More than 100 ops in a window
   cannot be walked past today.
5. **`behind GitHub · 3 refs`** (ADR's mirror header). The wire gives the
   word `behind` and no ref count, so the header shows the word alone.
6. **Live verification of the whole Linear half.** Blocked on ops:
   production has no Linear OAuth client configured, so `linearHandler` is
   nil and every `/api/linear*` path is 404. Every Linear fixture here is
   `unverified` against a live server — shaped from plue's source and proved
   against route doubles only. The mirror-sync and issue-linear-link routes
   are `unverified` for a different reason: they are repo-scoped and I had
   no authenticated repository to probe.

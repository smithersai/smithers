# Issues

A person lists, reads, opens and comments on the issues of the repository this deployment syncs, on any device. GitHub is the truth: Postgres holds a projection that only the server's GitHub flows write, Electric syncs it to every device, and every write goes from the device's outbox to one route, then one remote flow, then GitHub. This is decision [0012](../decisions/0012-git-end-to-end.md)'s slice G0, and its triage (§5): each issue is proposed, accepted or not accepted, a repository's triage flow decides new issues with a model, and a person overrides it ([triage](#triage)).

## How it works

```
the device                               ChatApi (Cloudflare)                                   GitHub
New issue / Comment, /issue, /comment, the agent
  FlowDispatch ─▶ issue/create, issue/comment (client flows, this device's engine)
    step: write id = UUIDv5(execution id) ─▶ the tab that asked ─▶ the device's one outbox (issue-write)
  outbox ─ POST /api/repos/<o>/<n>/writes ─▶ sign-in, role, App, repository, bounds, payload hash
            202 { txid, writeId } ◀───────── INSERT github_writes ─ FlowStarter ─┐
  issue-requested: "#–  Requested"         github/Write on its Durable Object ◀──┘
                                             token: the person's ghu_ (their own act) or the App's (the agent's)
                                             Action.once: find our marker first ────────────────▶ GET  /issues?since, /comments
                                             none: one POST with <!-- smithers:write=<id> --> ───▶ POST /issues, /comments
                                             read the issue back, settle row + projection ────────▶ GET  /issues/<n>
items, comments ◀── Electric ◀── Postgres ◀──┘
                                           POST /api/github/webhook ◀─ X-Hub-Signature-256 ──── issues, issue_comment
                                             github/Apply (one per delivery): re-read, upsert if newer
                                           a read of items finding the sync > 5 min old
                                             github/Reconcile: change-time listing from the cursor ─▶ GET /issues, /issues/comments
```

- **GitHub is the truth.** `items` and `comments` change only when a server flow read GitHub, and only under the newer-than guard: GitHub's `updated_at`, then the read's own time, must be newer, and the row must differ. A duplicate, reordered or repeated read writes nothing, so Electric sends nothing.
- **A webhook rings the bell.** A delivery only names its issue; `github/Apply` reads the issue and its comments and upserts them. It never takes state from the payload.
- **Reconcile covers what webhooks miss.** GitHub doesn't redeliver a failed delivery, so a read of the items shape that finds the sync older than 5 minutes starts `github/Reconcile`, one execution per repository and 5-minute bucket. The read waits for the start to be admitted, at most 2 seconds, beside its own work, so nothing it starts outlives it (decision [0104](../decisions/0104-request-owned-worker-io.md)). An isolate that saw a repository's bucket admitted asks nothing more for that bucket; a start that times out or fails is asked again by the next stale read.
- **Every write is one remote flow.** The device never calls GitHub and never holds a token. The settled `github_writes` row is the result; nothing waits on the remote run.
- **Libraries** (`docs/libraries.md`): `@smthrs/integrations` ("Touch GitHub": `GitHub.AppAuth`, `GitHub.Issues`, `GitHub.Sync`, `GitHub.GitHubClient`, `Core.Channel`, `Core.Signature`), `@smthrs/flow` (the flows), `@smthrs/effect-electric` (`ShapeProxy`, `ElectricCollection`), `@smthrs/effect-tanstack-db` (`Outbox`, collections, live queries), `@smthrs/crypto` (`Uuid.v5`, `digestSync`), `@smthrs/ui` (`IssuesView`, `ItemConversation`, `IssueForm`).

## Who reads, who writes

| Act | Who | Token on GitHub |
|---|---|---|
| Read the issues, comments and sync shapes | a signed-in person with a role on the repository; anyone, once GitHub said the repository is public | none |
| Open an issue, comment, as a person | a signed-in person with any role (Guest and above, decision 0007 `repo:issue-open`, `repo:comment`) | their own GitHub user token, so GitHub shows them |
| Open an issue, comment, through the agent | a person who may ask Smithers (Member and above, `repo:ask`) | the App's installation token; the text ends `Smithers for @<login>` |
| Accept, Not accepted, Run triage again | a signed-in Member and above (`repo:triage`); never the agent | their own token for Accept and Not accepted; none for Run triage again |
| Enable and Pause triage | a Maintainer and above (`repo:triage-flow`); never the agent | none |
| The triage flow's label and comment | the flow, under the Maintainer who enabled it, re-checked at every write | the App's installation token |

- **Reading.** A signed-out request, or a person with no role, is refused (`401`, `403`) until `github/Reconcile` has recorded that GitHub says the repository is public (`github_repositories.private`). The read still starts the sync, so a public repository opens to visitors within one walk. Decision 0012 keeps private repositories to people GitHub lets see them until shapes are authorized per request (0007 phase 2).
- **Queued writes survive refusal.** The outbox settles a refused write only after its Not sent row persists; storage failure leaves it retryable. Restored rows are validated before constructing a request. A restored credential whose authority cannot be renewed stays Forbidden; malformed credentials submitted directly to the issues client fail locally with 400.
- **A Guest never writes as the bot.** A Guest has no agent, so the route refuses an agent's write for a Guest (`403`): their write goes as themselves, or not at all.
- **The request says who acts, never the body** ([run credentials](sign-in.md#run-credentials)). A write the person pressed goes in their session (`via: "person"`); a write the agent's run queued carries that run's credential, which the tab renews as the exact same authority at delivery and sends without the cookie (`via: "agent"`). A run with no credential to send queues nothing (`IssueWriteRefused`, `no_credential`). Triage's writes, setting a commitment and merging refuse anyone acting for the person (`403`, counted as `auth.person_only`).

## Routes

`worker/github/Api.ts`; ChatApi routes these paths to it before RepoApi (`GitHubApi.handles`).

| Route | Answers |
|---|---|
| `POST /api/github/webhook` | `200` once the delivery is verified, its `github/Apply` started (for an `issues` or `issue_comment` event naming a repository the deployment acts on: its own, and with the App any other `GITHUB_ALLOWED_REPOSITORIES` doesn't leave out; GitHub sends the App events only of repositories it is installed on), with `REPO_FLOWS` on its `triggers/Dispatch` started (for a `push` or `pull_request` of any installed repository, [ci.md](ci.md#triggers)), and the delivery recorded; a repeat is counted `duplicate` and starts the same execution, which changes nothing. `401 { code: "invalid_signature" }`, `400 invalid` (no delivery id, no event, not JSON), `413 too_large` (over 5 MiB; Reconcile covers it), `405`, `503 not_configured` (no App or no webhook secret), `503 unavailable` |
| `POST /api/repos/<owner>/<name>/writes` | `202 { txid, writeId }` for a new write, `200 { txid: null, writeId, status }` for one already taken (a pending one's execution is started again, which changes nothing). Refusals below |
| `GET /api/shapes/items` | `items` with `ITEM_COLUMNS` of the repository `?repo=<owner>/<name>` names, the deployment's own unless it names one; starts that repository's Reconcile when stale, waiting at most 2 seconds for admission. The comments, sync, triage settings, pull request, commit, review and check shapes take `?repo=` too; a name GitHub couldn't have is `400 invalid`, a repository the deployment doesn't act on `404 not_found` (decision 0079, slice 1b) |
| `GET /api/shapes/comments` | its `comments` with `COMMENT_COLUMNS` |
| `GET /api/shapes/github-sync` | its `github_sync` rows with `SYNC_COLUMNS` (never the cursor) |
| `GET /api/shapes/triage-settings` | its `triage_settings` row with `TRIAGE_SETTINGS_COLUMNS` (never who enabled it) |
| `GET /api/shapes/github-writes` | the signed-in person's own `github_writes`, status only (`WRITE_COLUMNS`); signed out, none; sessions unreadable, `503` with `Retry-After: 5` |

The writes route's body is `{ writeId, op: "issue/create", title, body }`, `{ writeId, op: "issue/comment", number, body }`, or one of triage's: `{ writeId, op: "issue/triage", number, decision: "accept" | "reject", reason? }`, `{ writeId, op: "triage/run", number }`, `{ writeId, op: "triage/enable", dailyTokens? }`, `{ writeId, op: "triage/pause" }`. A UUID write id, a title of 1 to 256 characters not blank, a body up to 65,000 characters (a comment's not blank), a reason of 1 to 300 characters not blank, a daily budget of 1 to 10,000,000 tokens, a number of 1 to 2,147,483,647, and at most `MAX_WRITE_BYTES`. Triage's writes are the person's only, at the minimums in [triage](#triage).

**Which repository** ([decision 0079](../decisions/0079-roles-per-repository.md)). Opening an issue and commenting go to any repository the deployment may act on: its own (`GITHUB_REPOSITORY`), and any other the App is installed on that `GITHUB_ALLOWED_REPOSITORIES` doesn't leave out. Triage, commitments and merging go only to its own. The page's buttons follow the same role, as ChatApi answers it for the repository (`GET /api/repos/<owner>/<name>/role`): New issue and the comment box for a Guest or above, Accept, Not accepted, Run triage again and the triage switch for a Member or Maintainer on the deployment's own repository alone; none before it answers. The role is the person's on the repository the path names: on the deployment's own, the session's; on another, their GitHub permission there, read with an installation token for that repository (`metadata: read`), mapped as on sign-in, and kept 5 minutes in `github_repo_roles` (`worker/github/RepoRoles.ts`). GitHub is asked about the login and account sign-in recorded, and its answer must name that account. The write's transaction records it only while that row still holds the role, and the agent's write, which goes as the App, checks the person on GitHub again each time `github/Write` runs, on every repository: no longer a Member there, or another account under the login, and it settles refused (`not_allowed`). Its refusals are `{ code }`, `Cache-Control: no-store`, in this order:

The Issues list offers Enable or Pause triage only after that repository's issues shape completes a sync. In this slice only the deployment's own repository can complete one, so another repository never offers a control its write route will refuse. The list still shows local Requested issues before a sync.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid` | not that body |
| 401 | `authentication` | signed out, or a person's write without a session (local development's developer) |
| 403 | `forbidden` | no role on the repository, one below the write's minimum, the agent's write from a Guest, or a role that changed between the read and the write |
| 404 | `not_found` | not a repository, one `GITHUB_ALLOWED_REPOSITORIES` leaves out, or triage, a commitment or a merge on a repository other than the deployment's own |
| 404 | `app_not_installed` | the App isn't installed on the repository (GitHub can't tell that from an absent one); the device shows App not installed |
| 409 | `conflict` | the write id was taken by another payload, another repository's write or another person's |
| 413 | `too_large` | a body over `MAX_WRITE_BYTES` |
| 429 | `rate_limited` | GitHub rate limited the role's read; `Retry-After` is GitHub's wait, and the device sends again |
| 503 | `not_configured` | no GitHub App |
| 503 | `github_unavailable` | GitHub didn't answer the role's read; the device sends again. A stale role never decides |
| 503 | `unavailable` | Postgres, sessions or the Durable Object couldn't answer; the device sends again |

## Writes

`github/Write { writeId }` (`worker/github/Write.ts`), execution `github-write:<writeId>`.

| Step | Does | Retry policy |
|---|---|---|
| `github/Write/send` | reads the write; a settled one answers what it settled. A person's triage first waits for a flow label in flight (below). Takes the token (below). Counts the attempt, then writes through `Action.once` keyed by the write id (`GitHub.Once.issue`, `GitHub.Once.comment`): it looks for `<!-- smithers:write=<id> -->` among the issues updated since a minute before admission, or in the issue's whole thread, and adopts what it finds; otherwise one `POST` carrying it, and after a failed `POST` it looks again. The step is `irreversible` with the write id as its `idempotencyKey`, implementation `github-write/send/v2`. Reads the issue back, then settles the write `done` and upserts the issue and its comments in one transaction. GitHub's `401` (a person's token) is `sign_in_required`, `404`/`410` `not_found`, `422` `invalid`, `403` and the rest `not_allowed`: settled `refused`, never tried again | 1 s doubling to a minute, an hour at most; GitHub's `Retry-After` honored |
| `github/Write/give-up` | after the last attempt: settles the write `failed` `unavailable`; a write another run settled answers what it settled | 1 s doubling to a minute, never giving up |

A lost answer is found by its marker in the same attempt. A rate limit, a 5xx or Postgres failing fails the step for its policy; every attempt finds the marker before writing, so a write reaches GitHub once. The marker stays hidden: the projection stores the body without it and its write id in `write_id`.

### Tokens

`worker/github/Tokens.ts`. No token enters a journal, a step key, an error or a record.

- **A person's:** the session's sealed `ghu_`, opened with sign-in's keys. Within 5 minutes of expiry, the step starts the session's `auth/RecheckRole` (named after the check it replaces, the one redeemer of the single-use `ghr_`) and fails `refreshing`, so its retry policy waits 5 seconds and asks again. A session that ended, or a token that no longer opens, is `sign_in_required`.
- **The App's:** `GitHub.AppAuth` signs the App's RS256 JWT with WebCrypto, finds the installation on the repository once (`github_repositories.installation_id`), and mints a token for that repository with only `issues: read` (Apply, Reconcile, triage's read), `issues: write` (a write, triage's label and comment) or `contents: read` (triage's guidelines). GitHub's `404` forgets the installation (`app_not_installed`); `422` or `403` means the App wasn't granted the permission (`not_allowed`).

## Sync

- **`github/Apply { deliveryId, repo, number, event }`** (`worker/github/Apply.ts`), execution `github-apply:<deliveryId>`: one step that reads the issue and up to 10 pages of its comments with an installation token and projects them; a complete comment listing tombstones the comments it lacks, and GitHub's `404` or `410` tombstones the issue and its comments. The App not installed ends it `not_installed`; failing past its retries ends it `unavailable`, and Reconcile covers the issue.
- **`github/Reconcile { repo, requestedAtMs }`** (`worker/github/Reconcile.ts`), execution `github-reconcile:<repoId>:<5-minute bucket>`, `requestedAtMs` the bucket's start: records what GitHub says of the repository (its id, whether it is private), then walks `GitHub.Sync`'s change-time listings of issues, then comments, from the committed cursor, upserting each row and committing the cursor after each page. At most 50 pages a walk: one that stops there is `partial`, never complete, and the next stale read continues it. An item GitHub lists in a shape this app can't read is skipped and counted. After the first walk, the rows it changed are counted as `github_reconcile_changed`: what webhooks should have delivered. A walk that comes due once the bucket after its own has passed, or one started before requests carried their time (2026-10-21), settles `superseded` without calling GitHub: a newer read starts its own, so the backlog an outage leaves ends instead of walking at once.
- **Freshness.** Until a complete walk or a GitHub row arrives, the list shows device rows with unknown counts, without a spinner or "No issues" (ARCH-5). This includes other repositories, whose issue sync is deferred by decision 0079 Slice 1: their Requested rows remain visible. A direct issue or pull page waits for the item collection's accepted network batch to be installed (`currentApplied`) and the repository sync query before treating an absent item as unavailable; a 2xx may grant access while rows are still in flight. A failed cold shape settles an absent page as unavailable immediately, with Try again and its GitHub link. Try again reconnects stopped shapes; successful responses wait for their rows again. An installed snapshot remains readable through a transient failed poll. Once ready, no item and no complete repository sync shows "Issue unavailable here" or "Pull request unavailable here" with a GitHub link. It never claims Not found from an incomplete sync. A current `401` or `403` shape refusal shows sign-in or Not found even when an item remains cached on the device, including after a failed reconnect ([0094](../decisions/0094-item-access-before-cache.md)).

## Triage

Every issue has a triage state, independent of open and closed, carried by two GitHub labels (decision 0012 §5, decisions 9 and 10). A Maintainer enables the repository's triage flow; it decides each new issue with the `judge` model role, and a system step labels it, and comments on a rejection, as the App. A Member or above overrides in person.

```
issues.opened ─▶ webhook ─▶ github/Apply (the re-read) and, while triage is on, triage/Run (one per delivery)
Run triage again (a Member) ─▶ writes route ─▶ triage/Run (one per write): unpins the issue, settles the write
  triage/Run/read      settings on? issue pinned? ─▶ the issue, its last 20 comments, .smithers/triage.md at the
                       default branch's head, read with installation tokens (issues: read; contents: read)
  triage/Decide        Classifier.make, role judge, one sealed ModelStep, admitted and metered in process
                       (ModelEndpoint.local) ─▶ accept | reject | abstain, and a reason code
                       spent today ≥ triage_settings.daily_tokens, the judge failing, unsure (< 0.7) or invalid ─▶ abstain
  issue/ApplyTriage/label    system step, as the App (issues: write): settings still on; the issue not pinned; the
                             enabler still a Maintainer on GitHub; the triage labels and the title and body unchanged
                             since the read ─▶ else dropped, recorded why. Then: create the label (422 = exists), add
                             it, remove the other; the label receipt; the issue re-read into items
  issue/ApplyTriage/comment  a rejection only, none once a person triaged it: the enabler re-checked; one comment as the App, found by its marker
                             after a lost answer; the comment receipt. Refused, the App gone, the enabler demoted, or
                             failing past an hour ─▶ comment_failed, the label stands
```

| Labels on GitHub | `items.triage` | The list | The issue's page |
|---|---|---|---|
| neither | `proposed` | `Proposed` while triage is on, else no chip | `Proposed` · Accept · Not accepted |
| `smithers:accepted` | `accepted` | `Accepted` | `Accepted` · Not accepted |
| `smithers:not-accepted` | `not_accepted` | `Not accepted` | `Not accepted` · Accept |
| both | `conflict` | `Conflict` | `Conflict` · Accept · Not accepted |

Buttons show only to a Member and above; Run triage again also only while triage is on. A Maintainer gets Enable triage, or Pause triage while it runs, on the list. GitHub compares label names without case, and so does `triageOf` (`contract.ts`).

- **What the flow may do:** read the issue, its comments, its labels and the guidelines; add one triage label, remove the other, and post one comment on a rejection. Nothing else: no other label, no edit, no close, no assignment.
- **Issue text is untrusted.** The judge reads it as evidence; only the typed answer leaves the model call, which holds no token. The comment's reason is one of five fixed codes (`spam`, `duplicate`, `out_of_scope`, `unclear`, `other`), so issue text can't put words, mentions or links in the App's comment: `Not accepted: <reason>` then `Triaged by Smithers for @<enabler> (triage).`
- **Who it acts as:** the App on GitHub, under the role of the Maintainer who enabled it. Each write, the label and the comment alike, first asks GitHub for the enabler's permission on the repository (`GitHub.Collaborators.permission`; an organization's custom role counts by its base permission). Below Maintainer, or unknown to GitHub: nothing more is written (the decision is dropped `enabler_demoted`, or its comment recorded failed), triage pauses (`paused_reason`), and an Error is logged.
- **A person supersedes the flow, whatever order the labels land in.** Accept or Not accepted pins the issue from the moment the route admits it: while the write is pending, and once it settles `done`. A decision in flight is dropped `pinned`, its rejection comment is never posted, and no run decides it again until a person presses Run triage again. A flow write already past its checks when the person pressed lands before the person's: the label and comment steps record when they start (`label_started_at`, `comment_started_at`, migration `0049_triage_write_claims`) before they check the pin, and the person's write waits (`github.write` `waiting`, then the step's retry) while one has started and not finished, up to its step's retries and a minute (31 minutes for the label, 61 for the comment), so the person's labels land last. A refused write pins nothing. A person relabeling the issue on GitHub (`issues.labeled`), or editing its title or body, while a decision is in flight drops it `relabeled` or `edited`: the label step compares what GitHub has with what the decision read.
- **Budgets.** Each decision's tokens count against `triage_settings.daily_tokens` (default 200,000, at most 10,000,000) for the UTC day; once spent, the flow abstains without a model call. The call also reserves and settles against the deployment's own model budget and ledger, as the endpoint's calls do.
- **Placement.** `triage/Run` runs remotely for `issues.opened` (every device may be off) and for Run triage again too: its writes need the App's key, and a decision the App posts must come from the server's own model call, never a device's.
- **Customization (M-47).** The guidelines file is data, read at the default branch's head, which only a merge changes. A repository's own `.smithers/flows/triage/flow.ts` will replace `triage/Decide`, never the ApplyTriage steps, through the same public realm flow host [branch creation](branch-creation.md) uses. Not built yet: today only the guidelines file and the daily budget are customizable.

| Flow | Admitted by | Minimum | Agent |
|---|---|---|---|
| `issue/triage { repo, number, decision, reason? }` → `github/Write` | the writes route | Member (`repo:triage`); their session, since it writes with their token | never |
| `triage/run { repo, number }` → `triage/Run` | the writes route | Member | never |
| `triage/enable { repo, dailyTokens? }`, `triage/pause { repo }` → `github/Write` | the writes route | Maintainer (`repo:triage-flow`); enabling needs their GitHub login | never |
| `triage/Run { repo, number, trigger, key }` | the webhook (`issues.opened`, triage on) or Run triage again | | never |

- **A person's override** (`github/Write`, op `issue/triage`) runs with the person's own token, so GitHub shows them: the label on, the other off, and their reason, when they gave one (`/triage`), as their own comment with the write's marker. It settles the write, re-reads the issue, pins it and records a `person` decision, in one transaction, and counts `triage_overrides{from,to}`. Admitted, it already pins the issue for the flow (`TriageStore.itemTriage`).
- **Enable and Pause** (`github/Write`, ops `triage/enable`, `triage/pause`) change only `triage_settings`; no token. Enabling again unpauses, under whoever enabled it last.
- **Run triage again** starts `triage/Run` under its write id; its first step unpins the issue and settles the write `done`, whether or not triage is on.

## The browser

`src/features/issues/`, framework-free logic beside React views ([state.md](../state.md)).

| Piece | What it is |
|---|---|
| `issue/create { repo, title, body? }`, `issue/comment { repo, number, body }` (`flows.ts`) | client flows, model-invocable; slash `/issue owner/repo <title>` and `/comment owner/repo <n> <text>` (Guest and up). Each answers `{ writeId, status: "requested" }`: never done |
| `issue/triage`, `triage/run`, `triage/enable`, `triage/pause` (`flows.ts`) | triage's client flows, a person's only (not model-invocable); slash `/triage`, `/triage.run`, `/triage.enable`, `/triage.pause`. They queue their write in the same outbox and answer Requested; the follower drops one once its server write is done, since the issue's row says the rest |
| `steps.ts`, `tab.ts` | the step asks, over the engine's issues channel, the tab that started the request (`TabRequests`) to queue the write; that tab takes the outbox's lead and puts the write in the device's one outbox |
| `writes.ts` | `issue-sending` (the outbox's optimistic rows) and `issue-requested` (kept on the device: taken, or refused with why); the outbox's `issue-write` mutation posts to the writes route and never waits for Electric, so chat's questions never queue behind it |
| `store.ts` | per repository (`forRepo(id)`, opened once by a route, a warm, a write or a home's `issues` block; decision 0079 slice 1b), Electric collections `issue-items:<repo id>`, `issue-comments:<repo id>`, `issue-sync:<repo id>`, `issue-triage-settings:<repo id>`, each shape naming its repository with `?repo=`, and `issue-access:<repo id>`; `issue-writes`, kept on the device, `issue-drafts` and `issue-view` for every repository. Followers drop a requested write once GitHub's row carries its id, and read the shape's refusal (`401` sign in, `403` forbidden, `404` elsewhere: a repository the deployment doesn't sync) or failure (unavailable until recovery). The facade's queries are the routed repository's |
| `syncsHere` (`view.ts`) | whether the deployment syncs the routed repository: not when its shape answered `404` (`elsewhere`: left out by `GITHUB_ALLOWED_REPOSITORIES`, or the App found absent), nor when its sync recorded `app_not_installed` or `not_allowed`. Then the Issues, Pull requests and new-issue pages send people to GitHub's list and form; otherwise they show the synced lists, unknown until a first complete sync |
| `queries.ts` | the list (`items ∪ (requested − items) ∪ (sending − requested − items)`), the issue, its conversation, the sync, the access |
| `actions.ts`, `issues.ts` | `open` (the routes), `warm` (a link's hover: starts the sync), drafts, Create issue and Comment (door `button`), Edit and Discard on a write Not sent |
| `view.ts` | the props of `IssuesView`, `ItemConversation` and `IssueForm` from the queries' rows |

Screens: `/$owner/$repo/issues`, `/$owner/$repo/issues/new` and `/$owner/$repo/issues/$number` (`src/screens/issues/`), and an Issues link in the repository's header. Each issue shows the TODOs made from it, on its row and in its page's side column, and a Member gets Make TODO in an open issue's `⋯` menu and on its page, key `t`, while none of its TODOs is open ([TODOs from an issue](todos.md#from-an-issue)); the issue routes open the repository's stack for it. The device's outbox is chat's, extended by `OutboxWrites` (`src/outbox.ts`).

## Postgres

Migrations `0016_github_issues` and `0018_triage`. Synced tables are `REPLICA IDENTITY FULL`.

| Table | Columns | |
|---|---|---|
| `items` | `id` (`<repoId>#<number>`), `repo_id`, `number`, `kind` (`issue`, `pull`), `github_id`, `title`, `body`, `state`, `state_reason`, `author_login`, `comments`, `created_at`, `updated_at`, `closed_at`, `deleted_at`, `write_id`, `triage` (`proposed`, `accepted`, `not_accepted`, `conflict`: what GitHub's labels said at the last read), `triage_pinned` (a person triaged it), `source_updated_at`, `fetched_at` | synced without the last two |
| `comments` | `id` (`<repoId>/comment/<GitHub id>`), `repo_id`, `item_id`, `github_id`, `author_login`, `body`, `created_at`, `updated_at`, `deleted_at`, `write_id`, `source_updated_at`, `fetched_at` | synced without the last two |
| `github_writes` | `id` (the write id), `repo_id`, `actor_id`, `session_id`, `via`, `op`, `payload`, `payload_hash`, `status` (`pending`, `done`, `failed`, `refused`), `failure`, `attempts`, `item_number`, `github_id`, `created_at`, `settled_at` | each person syncs their own rows' status |
| `github_sync` | `repo_id`, `stream`, `cursor`, `synced_at`, `complete`, `failure` | synced without the cursor |
| `github_deliveries` | `delivery_id`, `event`, `action`, `repo_id`, `subject`, `received_at` | never synced, never the payload |
| `github_repositories` | `repo_id`, `github_id`, `private`, `installation_id`, `checked_at` | never synced |
| `triage_settings` | `repo_id`, `enabled_by`, `enabled_login`, `enabled_at`, `paused`, `paused_reason` (`person`, `enabler_demoted`), `daily_tokens`, `updated_at` | synced without who enabled it |
| `triage_decisions` | `id` (a run's: UUIDv5 of its execution id; a person's: their write id), `repo_id`, `item_id`, `number`, `via` (`flow`, `person`), `decided_by`, `run_id`, `write_id`, `guidelines_sha`, `input_digest`, `triage_before`, `decision` (`accept`, `reject`, `abstain`), `reason`, `abstained` (why), `tokens`, `label_started_at` and `comment_started_at` (when each step began writing), `labeled_at` and `comment_github_id` (the receipts), `comment_failed`, `dropped` (`off`, `paused`, `pinned`, `relabeled`, `edited`, `gone`, `enabler_demoted`, `refused`), `created_at` | never synced |

`0018_triage` clears the issues stream's cursor, so the next reconcile walk reads every issue again and sets `triage`; `github_writes` takes the triage ops, and only a person's override needs a session.

## Configuration

| Variable | Default | |
|---|---|---|
| `GITHUB_APP_ID` | none | the Smithers GitHub App's ID; without it, or the key, nothing syncs or writes (`503 not_configured`) |
| `GITHUB_APP_PRIVATE_KEY` | none | its private key, PEM as GitHub downloads it (PKCS#1) or PKCS#8; `\n`-escaped newlines are fine. A redacted secret |
| `GITHUB_WEBHOOK_SECRET` | none | the webhook's secret; without it the webhook route refuses every delivery and Reconcile alone keeps the rows fresh |
| `GITHUB_REPOSITORY` | `smithersai/smithers` | the deployment's own repository: the one G0 syncs, the one sign-in reads roles on |
| `GITHUB_ALLOWED_REPOSITORIES` | none: every repository the App is installed on | `owner/name`s, comma-separated: the other repositories the deployment writes issues and TODOs to. Malformed, the deployment's config fails ([decision 0079](../decisions/0079-roles-per-repository.md)) |
| `GITHUB_API_URL` | `https://api.github.com` | an http(s) URL |

ChatApi and the `FlowExecution` Durable Object read them with Effect `Config`, so Alchemy binds each one set in the deploying environment ([infrastructure.md](../infrastructure.md#credentials)). A person's own writes also need sign-in configured ([sign-in.md](sign-in.md#configuration)).

### The GitHub App (decision 0012 question 2)

What the App needs, set by its owner in the App's settings on GitHub; each installation owner then accepts the new permissions:

- **Repository permissions:** Issues: Read and write. Contents: Read and write (triage's guidelines; a TODO's branch and commit, [TODOs](todos.md#the-run)). Pull requests: Read and write (a TODO's pull request, a person's merge, the review check's comment, [pull requests](pulls.md)). Commit statuses: Read and write (each check's `smithers/<name>` status, GH-10, [commit statuses](pulls.md#commit-statuses)). Metadata: Read-only (always on; triage re-checks the enabler's role with it).
- **Webhook:** active, URL `<deployment url>/api/github/webhook` (for local development, a tunnel to `http://localhost:1337/api/github/webhook`), content type `application/json`, a secret that is also `GITHUB_WEBHOOK_SECRET`.
- **Subscribe to events:** Issues, Issue comment, Pull request, Pull request review. (0012 §2's other events wait for branches.)
- **Secrets:** the App ID as `GITHUB_APP_ID` and a generated private key as `GITHUB_APP_PRIVATE_KEY`.
- **Installation:** on `GITHUB_REPOSITORY`, on the scratch repository the live tests use, and on each other repository the deployment should write to (decision 0079). An installation lets the deployment act there; it gives nobody a role.

Spike S0 (0012 §10) isn't needed for this slice: it concerns Code Storage's App mode and pushing branches, which issues don't touch.

## Observability

Every route, step and token logs, traces and counts itself; no record carries a title, a body, a login, a payload, the webhook secret or a token ([observability.md](../observability.md#github)).

| Record | Kind | Fields |
|---|---|---|
| `github.webhook` | log, span | `event`, `deliveryId`, `number`, `outcome` (`applied`, `duplicate`, `ignored`, `refused`, `too_large`, `invalid`, `not_configured`, `unavailable`), `status`, `bytes`, `errorCode` |
| `github.write.request` | log, span | `op`, `via`, `writeId`, `outcome` (`started`, `existing`, or the refusal's code), `status`, `durationMs`, `errorCode` |
| `github.write`, `github.write.give_up` | log, span | `writeId`, `op`, `via`, `tokenKind` (`user`, `app`; never `token`, whose value the flow host's redaction hides), `outcome`, `settled`, `number` or `failure`, `errorCode` |
| `github.apply` | log, span | `deliveryId`, `repoId`, `number`, `event`, `outcome`, `changed`, `lagMs` |
| `github.reconcile` | log, span | `repoId`, `outcome`, `pages`, `issues`, `comments`, `skipped`, `failure`, `errorCode` |
| `github.reconcile.start` | log, span | a stale read's admission: `repoId`, `outcome` (`started`, `timed_out` after 2 seconds, `not_started`), `durationMs` on completion or timeout, `errorCode` on timeout or failure |
| `github.token.mint` | log, span | `kind`, `outcome`, `access`, `status`, `reason` |
| `github.read_token` | log, span | the deployment's read token for visibility checks (worker/github/ReadToken.ts), once per mint: `outcome` (`minted`, `anonymous`), `durationMs` or `errorCode` |
| `github.config` | log | `errorCode` (a private key that doesn't import) |
| `github.shape.<table>` | log, span | Electric's request records; a refused read: `status` |
| `github_webhooks{event,outcome}`, `github_delivery_lag_ms` | counter, histogram | |
| `github_write_requests{op,outcome}`, `github_writes{op,outcome,token}`, `github_write_ms{op}`, `github_write_unknown{op}` | counters, histogram | |
| `github_applies{outcome}`, `github_reconciles{outcome}`, `github_reconcile_starts{outcome}`, `github_reconcile_changed{kind}`, `github_sync_age_seconds` | counters, gauge | |
| `github_token_mints{kind,outcome}`, `github_shape_requests{table,status,live}` | counters | `kind`: `user`, `app`, or `read` (the read token) |
| `issues.write.queue`, `issues.write.send`, `issues.pending`; `smithers_issue_writes`, `smithers_issue_write_sends`, `smithers_issue_pending_actions` | browser logs, spans, counters | `op`, `door`, `outcome`, `status`, `writeId`, `reason`, `action` |
| `issues.shape.sync`, `smithers_issue_shape_transitions` | browser log, span, counter at first send, changed result or changed failure status | finite `phase` (`sent`, `ready`, `failed`, `stopped`), `status` when supplied, `durationMs` since observation began; no repository, issue, payload or error text |

## Tests

Run with the compose Postgres and Electric up (`pnpm db:up`). GitHub is a scripted provider on the `HttpClient` seam (`worker/github/test/scriptedGitHub.ts`), like the model: it keeps the App's JWT and installation rules, numbering, authorship, `since` and paging, and a test arms a status, a lost answer, or a hold (a request still in flight, applied later) per request.

| Test | Proves |
|---|---|
| `worker/github/Flows.test.ts` | `github/Write`, `github/Apply` and `github/Reconcile` on the Node host: a person's issue shows as them and the agent's as the App with its attribution; a comment; a lost answer, and a run that died after GitHub took the write, adopt by marker with no second write; give-up answering a settled write and counting send's token kind; refusals by status; an ended session, a revoked token, sign-in off, an unopenable token; an expiring token starting the role check; the App not installed or not granted write; the installation remembered and forgotten; a rate limit's wait; settled writes left alone; giving up; re-reads, newer-than, tombstones, ghosts and empty bodies; walks, the cursor, partial walks, visibility, unreadable items; no title, body, login or token in any record, and under the flow host's redaction a write's record still says which token wrote (`tokenKind`) |
| `worker/github/Api.test.ts` | every route and refusal through the real handler: verified, duplicate, ignored, forged and oversized deliveries; writes started, resent, conflicting, bounded, refused by role, and a Guest's agent write refused; end to end on the Node host from the route to GitHub and back; each shape's columns; the stale read starting Reconcile once per bucket before it answers, concurrent stale reads starting one execution, a start that never resolves answered at 2 seconds and interrupted with the read, a failed start asked again; a signed-out read of a private or unknown repository refused, a public one served; no payload or secret in any record |
| `worker/github/Host.test.ts` | the App's settings from Config; a key that doesn't import logs its code only; the Durable Object's handlers running `github/Write` to the end through `ExecutionHost.withGitHub` |
| `worker/github/Calls.test.ts`, `Project.test.ts` | how a failed call is read; a cut-short comment listing tombstones nothing; a write settles once |
| `worker/github/Triage.test.ts` | triage on the Node host with the scripted GitHub and a scripted model behind `ModelEndpoint.local`: a spam issue labeled and commented once as the App with no issue text, mention or link in the comment; accept; a conflict settled; abstain when the judge abstains, is unsure, answers nothing readable or fails, or the day's budget is spent; the guidelines read and their SHA kept, or none; skipped when off, paused, pinned, gone or uninstalled; dropped when, mid-decision, a person pins, relabels or edits it, triage pauses or goes, the App is uninstalled, or GitHub refuses; the enabler demoted pausing triage; the comment refused, lost and adopted, or failing; retries honoring `Retry-After`; replays after a lost journal; bounds on what the judge reads; the webhook starting it once per delivery; a person's override, winning over a flow label or rejection comment already in flight and pinning from admission, waiting only for a flow write that started, Run triage again, Enable and Pause through the route, with every role refused below its minimum and the agent refused; no title, body, comment or login in any record |
| `worker/github/Live.test.ts` | the real GitHub on a scratch repository (never `smithersai/*`): the App's token, Reconcile, the agent's issue and its re-read, a person's write as that person, and triage: a spam issue labeled `smithers:not-accepted` and commented once as the App, and the real model on the `judge` role deciding a bug report with GitHub carrying its label. Skips naming `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_LIVE_REPOSITORY`, `GITHUB_LIVE_USER_TOKEN`, `GITHUB_LIVE_MAINTAINER`, `CEREBRAS_API_KEY` |
| `src/features/issues/*.test.ts` | the browser on Node devices against the real routes: Requested at once as `#–`, GitHub's row replacing it on every device; comments; unknown list counts before the first complete sync; refusals Not sent with Edit and Discard; settled refusals; offline then sent once; a lost answer resent once; an outbox that can't store; the agent's door; the slash lines; a visitor refused until the repository is public; triage: a Member's Accept Requested at once then settled pinned on every device, Run triage again starting its run, chips hidden while triage is off, a Maintainer's Enable and Pause and a Member's refused, `/triage` with a reason; no title or body in any record |
| `e2e/issues.spec.ts` | in real browsers, two devices: a signed-out device asked to sign in on a repository GitHub hasn't said is public while a Member's device gets the list and the form ("who reads", runs on `alchemy dev`); and G1/G3, A opens an issue, B sees it numbered and comments, A sees the comment, which skips naming `E2E_ISSUES_REPOSITORY`, `E2E_SESSION_COOKIE` and, locally, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; "who triages", a Maintainer gets New issue but no triage switch before the repository's first complete issue sync, and a signed-out device neither (runs on `alchemy dev` without the App); and G7, a Maintainer enables triage, opens an issue and runs triage on it, the flow's label arrives, device B overrides it, and Run triage again decides it once more, which skips like G1 with `E2E_SESSION_COOKIE` a Maintainer's |

### Verified live (2026-10-20)

Against the Smithers GitHub App Will set up (`smitherspreviewrelease`, installed on `roninjin10/smithers-github-tests`), on a second `alchemy dev` (stage `live_williamcory`, port 1338, database `smithers_live` with its own Electric, `GITHUB_REPOSITORY=roninjin10/smithers-github-tests`), signed in as `codeplanesmithers` through the App ([sign-in.md](sign-in.md#verified-live-2026-10-20)):

| Test | Result |
|---|---|
| `worker/github/Live.test.ts`, as the App | passes: Reconcile records the repository, the agent's issue opens as `smitherspreviewrelease[bot]`, and a webhook-style re-read finds it |
| `worker/github/Live.test.ts`, as a person | passes: the issue opens as `codeplanesmithers`, via the App |
| `worker/github/Live.test.ts`, triage | passes: a spam issue labeled `smithers:not-accepted` and commented once as the App; the real judge (Qwen on Cerebras) decided a clear bug report `abstain`, 2,287 tokens, so GitHub carries no label |
| `e2e/issues.spec.ts` "two devices" | passes in 27 s: A's issue opens on GitHub as `codeplanesmithers`, B sees it numbered and comments as `codeplanesmithers`, A sees the comment. GIF: `~/Desktop/smithers-mvp/gifs/issues-two-devices.gif` |
| `e2e/issues.spec.ts` "triage" (G7) | not run: it needs a Maintainer's session, and `codeplanesmithers` is a Guest on the scratch repository (read on a public repository) |
| The webhook (`POST /api/github/webhook`) | not run: the App has no webhook until there is a deployed URL; Reconcile kept the rows fresh |

The live run found two defects, each fixed with a regression test:

- **Writes never left the page.** Over plain-http local development a browser opens at most six HTTP/1.1 connections to the app, and the issues page long-polls about twelve shapes. The device's `POST .../writes` queued behind long polls sent again as they ended, missed its 15-second deadline, and was resent into the same queue, so the issue stayed `#– Requested`. `@smthrs/effect-electric` now sends long polls at low priority (`ShapeSource.fetchSource`); in a real browser, an ordinary request on this page took 11 to 21 seconds before and under 70 ms after.
- **No record said whose token wrote.** The flow host's redaction hides the value of any field named `token`, so `github.write` logged `token: "[REDACTED]"`. The field is `tokenKind` now.

## Not built yet

- Pull requests, reviews, the Checks tab (Smithers flow runs on the head SHA; no GitHub Actions or checks, 0012 decision 12), labels, branches, merge and update branch (0012 W3 to W8): the next slices.
- Triage: notifying Maintainers when triage pauses for a demoted enabler (0009) logs an Error only; a free-text reason from the flow (it gives one of five codes); Discard on a triage write that wasn't sent; the `?q=triage:proposed` filter; a repository's own triage flow (0005). The flow's spend doesn't raise the deployment's spend alerts.
- `GITHUB_SYNC_MAX_ITEMS` and the 24-hour full listing that tombstones deleted issues GitHub stops listing; a webhook's `issues.deleted` re-read tombstones them today.
- The `installation` and `installation_repositories` events, and a cron for Reconcile (`@smthrs/triggers` on Cloudflare, W9).


## Issue lifecycle (0018, implementation in progress)

[Decision 0018](../decisions/0018-issue-lifecycle.md) separates discussion from implementation. `smithers:accepted` means **Accepted for discussion**; it grants no implementation or merge authority.

Before judging a bug (a `bug`/`type:bug` label, or an explicit `[bug]`/`Bug:` title), `triage/Run/read` checks the issue and comments for a nonempty fenced snippet. Without a candidate it adds `smithers:needs-repro`, posts the fixed App request once per issue using a deterministic write marker, and skips the judge. Reruns search the marker from issue creation; an incomplete conversation fails closed before another comment. A later snippet clears the missing-reproduction label. Empty fenced blocks do not count, including prose between empty blocks. This gate checks presence only; sandbox verification is deferred.

A Maintainer's `issue/commitment` flow uses the existing durable asking-tab/outbox/write path. Its four GitHub labels are `smithers:commit-now`, `smithers:commit-next`, `smithers:commit-later` and `smithers:commit-none`. The route is person-only and Maintainer-only. The remote write rechecks GitHub permission and the accepted label, adds the selected label and removes the other commitment labels, retaining unrelated labels. Demotion or an unaccepted/conflicting issue refuses the write. Projection derives `items.commitment` on every read; conflicting commitment labels stay a visible conflict. The issue page contributes a control and chip; the list uses `?commitment=now|next|later|none`. Failed writes remain visible and can be replaced through the control after a new queue receipt.

Migration `0032_issue_commitment` adds the derived column and write operation; the device's item persistence version is 3. Telemetry reuses `issues.write.queue`, `issues.write.send` and `github.write`, with `op=issue/commitment`, and `triage.read` records `why=needs_repro`; no issue content is logged.

Validation so far: the lifecycle policy has 100% statements/branches/functions/lines and all seven policy tests pass. The real-browser specs are `e2e/issue-lifecycle.spec.ts`, with the shared chapter/video helpers. No passing live receipt or GIF is claimed. Auto-POC, its repository setting, budget, expiry, preview and factory handoff are proposed in 0018 and not implemented.

## Deferred at burn-down

Sandbox reproduction verification, automatic POC generation, playable previews, token budgets, expiry, the repository switch and POC-to-TODO context are todo. Their draft files remain in the shared checkout but are outside this landing. `issue/Prototype` is not registered by the execution host; no preview or repository-switch UI is exposed. Needs-repro checks snippet presence only.

### Observation ordering and anonymous reads

Anonymous projection reads verify GitHub repository metadata at most 60 seconds old, using the shared read-token policy. Each isolate retains definite public and private-or-gone answers for 60 seconds. A miss reads independently; unavailable answers are never cached and return 503. After expiry, a newly private or unavailable repository grants no anonymous read. `github.visibility` logs and traces each check; `github_visibility_reads` counts its bounded outcome, status class (`2xx`–`5xx` or `none`), rate-limit flag, remaining-budget bucket (`0`, `1-9`, `10-99`, `100+`, `unknown`) and error code. The log carries those same fields; it never carries headers, response text or credentials. Webhook event metric attributes use a finite allowlist, with all other names grouped as `unknown`.

Delivery receipt is stored before Apply starts, including on a launch retry. Stale item reads await Reconcile's idempotent Durable Object admission inside the request, beside the shape read, for at most 2 seconds. Admission failure or timeout still serves the shape; the next stale read can request the same bucket again. Once admitted, execution stays on the durable flow engine, and the isolate remembers only each repository's completed bucket.

Identical issue and comment reads advance freshness fences without counting a content change. Absence carries the read's start time, cannot overwrite a newer observation, and fences older in-flight reads. A gone pull also removes its pull, commits and reviews in the same transaction.

Migration `0048_github_projection_fences` keeps absence and complete-list fences even when no local row exists yet. It backfills existing deletion fences and removes pull projections left behind by legacy tombstones. The table is server-only and is not an Electric shape.

### Shape authority

The device opens a repository's items, comments, GitHub sync, triage settings and four pull shapes only while that repository's role answer gives the person a role there (the session's role on the deployment's own repository), or explicitly permits a public read of it (`src/features/issues/source.ts`). A role on one repository never opens another's: a Member of the deployment's own repository reads another only as its own answer says, a Guest where GitHub gives read. A repository whose answer hasn't arrived requests nothing; opening its issues asks for it. An answer with `synced: false`, the rule the shapes' `404` follows (left out by `GITHUB_ALLOWED_REPOSITORIES`, or an About read found the App absent), shows GitHub's lists to anyone, requesting nothing. A signed-out cold home opens none of these shapes. Each request, including reconnects, waits for this authority. Shape failures describe transport availability; they never decide whether a person must sign in or lacks a role. GitHub writes retain their existing person-filtered shape.

The role answer uses the same server read policy as the repository shapes, preserving decision 0012's public reads. Libraries: `@smthrs/effect-electric` and `@smthrs/effect-tanstack-db`.

The lazily opened TODO and prompt shapes separately require Member authority on their named repository. They also wait before requesting and never infer authority from a refusal.

### Cold list payloads

Repository homes and lists sync `item-summaries`, a server-defined projection of `items` without bodies or detail-only metadata. Exact home counts and list search/filtering still have all summary rows. Bodies (`items`) and `comments` start only on an issue or pull detail page, with the same repository authority gate and server authorization. Each collection remains persisted; opening a full list never substitutes a recent-items subset. Detail queries read full items, so missing text is never rendered as an empty body. `e2e/shape-payload.spec.ts` asserts signed-out page demand and decoded initial bytes/rows against a deployment. Catalog: `@smthrs/effect-electric`, `@smthrs/effect-tanstack-db`.

Issue and pull-request details keep the route frame while their deferred body arrives, without a loading skeleton or invented empty conversation. `shape-demand.spec.ts` checks the pull-detail transition against the deployment.

A signed-out reader of a public issue can sign in from the conversation; sign-in returns to the same issue. `issue-visitor.spec.ts` verifies that path without signing in or posting.

Cold issue and pull request lists say “Syncing issues…” or “Syncing pull requests…” while counts are unknown. Cached rows remain visible; no spinner or false empty count appears. `issue-list-feedback.spec.ts` observes every painted frame until content arrives.


Agent attribution names the requester only when their stored GitHub login exists. Without one, new text is attributed to “Smithers”; it never fabricates an `@unknown` mention. Historical issue bodies remain GitHub's text, including the old scratch issue #16.

Detail routes use item-scoped Electric shapes: `items?repo=owner/name&number=N` and `comments?repo=owner/name&number=N`. The server validates N and binds it into an additional number/item-id predicate after repository authorization. Separate persisted collection identities retain each item's cursor; moving between issues cannot reuse another item's handle. Lists share summaries, sync and triage metadata. Explicit repository-wide readers retain their existing full-body demand.

The October 26 production probe measured boot render at 2.82 s, first issue content at 7.37 s, and initial detail transfer of 8.24 MB of bodies plus 19.46 MB of comments. The scoped-shape regression verifies that a detail downloads only its own body and comments. Post-deployment timings remain a lander check; this change makes no measured speedup claim before deployment.

Create issue stays with its request instead of returning to the list. Once the durable flow supplies a write ID, the new-issue URL keeps it as `?write=`. The signed-in person's synced write receipt supplies the new issue number; only `done` navigates to that issue. Reload resumes from that URL. A failed write says Not sent and offers Edit. Leaving before admission prevents the old receipt from changing a later page or clearing its draft. `issue-create-navigation.spec.ts` writes only to the configured scratch repository and reloads before checking the issue page.

Missing item details use the shared not-found view, naming Issue or Pull request and linking to its list. A repository this deployment does not sync settles as unavailable here with the GitHub source link; it never waits for a sync that cannot arrive or claims absence without a source receipt.

The No commitment list includes issues with no commitment label as well as the explicit `smithers:commit-none` label. Setting a commitment still requires acceptance and a Maintainer; empty Now, Next and Later lists do not imply triage acceptance.

Issue and pull request lists search synced titles and numbers locally with `?q=`. `?sort=newest|oldest|updated` orders by creation or update date and displays that same date; Recently updated is the default. Pending issue writes stay first. Search, sort and commitment filters can be combined and shared by URL.

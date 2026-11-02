# Notifications

Your feed: what needs you, what finished, what failed, live work on the branches you're on, and your repositories' `main` moving and new releases. It reads the one run index (`runs`), keeps one row per person per subject in Postgres, and shows on every device you have open: the toast stack, and the notifications panel, which the header's bell and Alt+N open. Read, Hide and Dismiss on one device reach the others. Decision: [0009](../decisions/0009-notifications-and-live-work.md), slice 1; Will's rulings in its §8: toasts follow the scope you're in, so you see other people's runs on your branch, and `main` changing and a new release belong to the repository.

```
run report (worker/Runs.ts) ── one transaction ──▶ runs ─▶ foldRun ─▶ notifications (launcher + branch watchers)
GitHub push / release (worker/github/Api.ts) ─────────────▶ recordRepoEvent ─▶ notifications (repository watchers)
a tab shows a conversation ─▶ watch/set ─▶ POST /api/watches ─▶ watches (branch:<id>, repo:<id>)
Read · Hide · Dismiss ─▶ notification/ack ─▶ POST /api/notifications/ack ─▶ greatest(read|dismissed|hidden_version)
notifications ─▶ Electric (/api/shapes/notifications, your rows) ─▶ every device ─▶ feedOf ─▶ the stack, the panel
```

## Who hears what

| Subject | Raised by | Who | What they see |
|---|---|---|---|
| `run:<id>` | each report of an agent's answer | its launcher | every state: working, waiting, needs you (Answer), failed, done (Open) |
| | | everyone watching the run's branch who may open it | `Agent run · <owner>/<name>/<branch>`, never the question or the launcher: a quiet toast while it lives (`Waiting` while the launcher is asked), gone 4 s after it settles; never an entry |
| `clone:<repo id>` | each write to a clone's row (worker/CloneFeed.ts, [repo.md](repo.md#the-clone-in-the-feed)) | the person who asked for the attempt | `Clone · <repository> · Requested`, `Fetching 640.0 KB`, `Indexing`; done; or failed with why and Try again, which runs `repo/clone` again |
| `main:<repo id>` | GitHub's `push` to the default branch | everyone watching the repository who may read it now | `main · <commit> <owner>/<name>`, never the message or who pushed; raised again for each newer push, including distinct commits in the same second |
| `release:<repo id>:<tag>` | GitHub's `release` `published` | everyone watching the repository who may read it now | `Release · <owner>/<name>` with the tag in its link, never the release's name or author; refreshed and raised again when the tag is published again later |
| `fleet:<alert id>` | `ops/FleetAlert`: a TODO's run failed or stalled, waited too long for a runner or cost too much, or a runner went offline ([fleet.md](fleet.md#alerts)) | the committer, and the repository's Maintainers or Admins as the alert's kind says | `Agents · Agent run stalled · acme/widgets`, in the panel only, never a toast; opens the TODO's page (an outage, the fleet) |

- **You're on a branch** when a tab of yours shows its conversation: the tab runs `watch/set` once per conversation, which follows the branch and its repository at `attention`. A watch stays until you mute it (there is no Unwatch yet). `/app` is the deployment repository's `main`.
- **Routing** is `@smthrs/notifications`' `Inbox.route` and `Inbox.audience`: the launcher hears their own run; watchers at `attention` hear someone else's run quietly, at `all` as an entry; `muted` hears nothing. Every recipient, including the launcher and anyone with an existing row, hears only of a branch they may open now (worker/branch/Access.ts), checked at each report. Muted recipients with access still see an existing row settle; revoked recipients receive no more updates. That check reads the person's role on the deployment's own repository, so only the launcher's row quotes the run (its question, and their own login); everyone else's says `Agent run`, the repository and the branch, and links to the conversation, whose page checks their access there. The launcher hears nothing while a cached role on the run's repository (`github_repo_roles`) says they hold none or less than a Member's. Rows written before this change keep their old text until a feed barrier's pass rewrites them (below).
- **Repository events** (`main`, releases) reach a watcher only while they may read the repository, checked at each delivery (`recordRepoEvent`): they have a live session (not signed out, revoked or past its end), and the role GitHub last confirmed for them on any of their sessions, live or ended (`SessionStore.latestRole`), is a Member's or above. Local development's people, who have no session, count by their fixed role. A check that couldn't reach GitHub confirms nothing, and signing out of the session that found a demotion doesn't undo it. A watch outlives a demotion or a sign-out; the access it was made with doesn't. That role is the deployment's, not the person's on this repository, so the row names only the repository, the commit or tag, and the link: the page the link opens checks their access there, as a GitHub notification links to a private repository rather than quoting it. Rows written before this change keep their message and author until a feed barrier's pass clears them (below).
- **A denied or lowered role.** When a role read records that a person holds no role on a repository, or less than a Member's (`RepoRoles.remember`), whatever it said before, a statement of its own deletes every row of that repository from their feed; when it only lowers a role that is still a Member's or above, the repository's fleet alerts. A row a read claimed before GitHub answered (`checked_at` -infinity) recorded no role. `smithers_notifications_pruned` by `scope` (`repository`, `fleet`) and `github.repo_role.pruned` count them, never who.
- **Locks.** A person's feed on a repository has one advisory lock (worker/FeedLocks.ts). Every writer of the feed takes all the pairs it may touch, sorted and at once, before any notification or role row, and decides who gets a row again after the locks, in statements of their own: `remember` its one pair; a fold (`Notifications.lockRuns`) the run's launcher, its branch's watchers and everyone holding a row of it, and a transaction that folds several runs all of theirs first; a repository event (`recordRepoEvent`) its audience; a fleet alert's bell its recipients; and the redaction pass each batch's (below). A fold touches only rows of people it locked; someone who started watching since waits for the next fold. So a denial either commits before a fold reads the launcher's role, or deletes what the fold wrote once it commits, and neither waits on the other in a cycle.
- **Versions.** A row's `version` goes up when it needs attention again (`Inbox.raises`: a new row, a question, a failure, done; a second question while one is open). A row is open while `dismissed_version < version`, hidden while `hidden_version ≥ version`, unread while `read_version < version`. A new version shows again everywhere. A quiet-only change preserves the version; a changed question title raises it.

### Rows written before

Rows written before the writers above stopped putting private text in the feed are brought into line by `ops/RedactFeed` (worker/flows/RedactFeed.ts), once per feed barrier, after the deploy owner confirms that no Worker of an older release is left to write them again.

1. **Confirm the barrier.** Once Cloudflare shows only the current version serving (the deploy finished and the older version's requests drained), the deploy owner runs, from `apps/mvp` of a checkout at the deployed release:

   ```sh
   ~/vault-ws-deployer/bin/mvp-prod-env node ops/feed-barrier/confirm.ts --project <Neon project id> --by <your name>
   ```

   `--project` is the production database's Neon project id: the project named `smithers-mvp-ChatPostgres-prod-…` in the Neon console. The script refuses one outside `NEON_ORG_ID`, one not named for the `prod` stage (`--stage`), and one without a single default branch and database. The release is the deployed build, read from `https://smithers.sh/version.json` (`APP_DOMAIN`, which mvp-prod-env sets), unless `--release <build>` names one; no git. It writes one `feed_barriers` row (`r-<the build>` unless `--id` names it) and prints it as one JSON line on stdout: `{"outcome":"written",...}`, or `{"outcome":"existing",...}` when that barrier was already confirmed, in which case it wrote nothing. A failure, however malformed the connection string, is one line on stderr, scrubbed of the key, the password (as written and decoded) and the connection string, and exit 1; so is anything that escapes it.
2. **The pass starts by itself.** The barrier row is the durable request. ChatApi's requests, in the request's background (`ctx.waitUntil`, so no request waits on it), and every `FlowExecution` alarm, each at most once a minute per isolate, claim the barriers whose pass was never launched, or whose last claim and last batch are both older than 15 minutes (`greatest(launched_at, progressed_at)`), in one statement on the partial index `feed_barriers_open` (`FOR UPDATE SKIP LOCKED`, marking `launched_at` and a fresh `launch_token`), and start each one's `redact-feed-<id>`. A host accepts a start of an execution it already holds and wakes it, so a pass is started only under a claim: once (`launched`), and again only when stalled (`woken`). Each round of the pass runs as its own execution (it hands off with `.to()`), and the remote host's router records each handoff on the barrier (`current_execution`, with that round's payload `current_round`), so a stalled pass is woken at the round it is on, with that round's own intent, never at a finished predecessor. A start that fails gives back its own claim only, fenced by its token, never a newer claimant's. A pass whose barrier row is gone stops at once (`no_barrier`) and touches nothing.
3. **The pass.** Each round is one batch, its own step: up to 500 rows in the primary key's order from where the last ended, read without locks; then the feed locks of everyone those rows belong to, as every writer takes them (above); then, in statements of their own, the rows rewritten or deleted. Phases: fleet alerts, `main` and release rows, other people's run rows, each as it is written now; then rows of a repository a recorded read denies their recipient, judged after the locks, so a role restored meanwhile keeps them. Each batch records `progressed_at`. The round's payload is the cursor, so a pass the engine retries or another incarnation resumes goes on where it stopped; a round whose change committed but whose receipt was lost runs again and finds its rows in line. A row already in line is left alone; the end records `completed_at`. `feed.redact` (`barrier`, `phase`, `outcome`), `smithers_feed_redacted` by `phase` and `smithers_feed_redact_launches` by `outcome` (`launched`, `woken`, `not_started`) record it, never who.

## The stack

| Entry | Toast | In the panel |
|---|---|---|
| your question | `◆ Needs you · <question>` with Answer, until answered | stays while open; expanded, its options and field with Answer |
| your run, live, elsewhere | `◌ Working · <question>` | stays while open; expanded, its last steps |
| your run, done or failed | 4 s | done: 7 days, expanded, its last steps and answer; failed: until dismissed, expanded, why, and Retry |
| someone else's run | `◌ Working · <who> · <question>`, then 4 s after it settles | none |
| `main`, a release | 4 s | 7 days; expanded, who pushed or published |

- **Over a conversation**, its own runs show in it instead of as toasts, unless they need you. The stack overlays the page under its header and takes no layout space, so a toast arriving or leaving never moves the conversation, the composer or the page ([0137](../decisions/0137-toasts-overlay-the-page.md); Will, 2026-10-31, ruling FE-21). One component, `Notices` (`src/features/attention/components/Notices.tsx`, `@smthrs/ui` `ToastStack`'s `anchored` placement). On `/app`, `AppShell` passes it to `Conversation`: a zero-height anchor after the pinned message keeps collapse, expand and unpin clear at every width. The stack follows the pin's actual height and aligns with the conversation's end; without a pin it overlays the transcript's top under the header. Other owners stay at their headers: the flows page's and repository page's `PageHeader` (`FlowsScreen`, `RepoHeader`), a branch page's chrome (`BranchScreen`), or a fixed box under the floating bell (`src/screens/root/Root.tsx`, `PageNotices`). Toasts are at most 380px wide and fit the phone's content width; they never cover the home pin controls, header or composer. A toast arrives by opacity and transform alone; it leaves at once.
- **Order:** needs you, failed, live, done, updates; the newest first within each. At most three current toasts show. Older entries and overflow stay in the bell; no overflow counter reserves page space. Spend alerts appear only in the panel and configured email/Telegram channels.
- **Clicking a toast** opens what it is about: a run's conversation at its answer (`<href>#<run id>`, which the router scrolls into view), or your question's card, which takes focus; `main`, the repository; a release, its tag.
- **×** hides a toast (the entry stays in your list); in the panel, × dismisses a settled entry and hides a live one.
- **Unread** entries carry a dot, and the bell counts them. Opening, expanding and Answer record Read.
- **A failed run's toast** shows for 4 s like a finished one; the failure stays in its conversation with Retry and in your list until you dismiss it.
- A toast never covers a page's primary action or any control in its header rows, including list toolbars and tabs. The shared stack clears their actual visible bounds after its existing anchor; a crowded viewport scrolls the overlay in a free gap. Wrapped phone headers and plugin controls get the same clearance. Use shared primary buttons or mark a custom primary control with `data-primary-action` ([0137](../decisions/0137-toasts-overlay-the-page.md)). Arrival, removal and repositioning reserve no page space.
- Every toast fades in after 300 ms.

## Background progress

`/new`, Make TODO, Create issue and Commit each show one toast from the press until their result, on every page, through a reload ([0124](../decisions/0124-background-progress.md)). Nothing is stored for it: the toast says what the operation's own receipts prove, the strongest one deciding.

| Operation | Requested | Working | Done | Failed |
|---|---|---|---|---|
| `/new`, Make TODO | the press, until the engine records its run | the engine's run | the run completed | the run failed; the engine refused the start (Try again) |
| Create issue | the press, the outbox, the route taking it | GitHub's write pending | GitHub made the issue (Open goes to it) | GitHub or the route refused it; the outbox refused it (Try again) |
| Commit | the press, the outbox | | the stack numbered the TODO (Open goes to it) | the route refused it; the outbox refused it (Try again) |

- **The press is this tab's.** Its input receipt survives a reload and is admitted again with the same identity, so Requested reconnects. Another tab shows the operation once a device or server receipt exists, and never a failure it can't see.
- **No reply is no failure.** A start whose answer was lost stays Requested until the engine's run answers.
- **Done and Failed** come from the person's notification, folded with the result on the server (`worker/github/WriteFeed.ts`, `worker/stack/StackFeed.ts`), or from the device's receipt until that row syncs. Their 4 s count from the receipt's own time.
- **A failure this device toasted** is listed until you dismiss it; Dismiss keeps that receipt's time on the device (`attention-dismissed`), so a later Try again shows again.

## The top bar

The top bar's bell (`NotificationsBell`, `@smthrs/ui` `NotificationBell`) is the one way in to what waits on you, on every page: in `/app`'s header or the repository header where present, and floated at the window's top-right on other pages (`src/screens/root/Root.tsx`). It counts your unread entries, and while a run of yours waits on you it reads `◆ Needs you` in gold (with the count above 1), replacing agent status's header pill. Clicking it or Alt+N opens the panel at the newest run waiting on you, expanded with its question; O or Open goes to it.

## The panel

`src/features/attention/components/NotificationsPanel.tsx`, on every page (`src/screens/root/Root.tsx`): `@smthrs/ui`'s `NotificationPanel` at the window's top-right, its list scrolling, full width on a phone. It lists your entries newest first (by `occurred_at`), unread ones dotted, each with its time. Clicking an entry expands it in place; Open goes where its toast would. Expanded (`detailOf`, `src/features/attention/detail.ts`):

| Entry | Shows |
|---|---|
| your question | its options and a field with Answer (`NeedsYouCard compact`), sharing the draft with the conversation's card; it answers a branch's question while the tab shows home, too |
| your run | its last three steps (the answer's `parts`, when this device holds its conversation), and, done, the answer's text |
| your failed run | why (`Rate limited`, `Model error`, `No answer`, `Stopped`, `Unfinished`); Retry in the conversation the tab shows, which asks the question again there and dismisses the entry |
| `main`, a release | who pushed or published |

The top bar's bell, a toast's E and Alt+N open it; Escape, × and a click outside close it, giving focus back. The panel is the tab's own (`attention-panel`); what it shows is the synced rows.

## Keys

`@smthrs/ui`'s `NOTICE_KEYS`, on a focused toast or panel entry. Fields keep their letters.

| Key | Does |
|---|---|
| Alt+T | focuses the first toast; Escape gives focus back |
| Alt+N | opens or closes the panel, from anywhere, at the newest run waiting on you |
| ↑ ↓, J K, Home End | move between toasts, or between the panel's entries |
| Enter | a toast: opens it; an entry: expands it |
| O | opens it |
| E | expands it: a toast's opens the panel at its entry |
| A | answers: a toast's is its Answer; in the panel, its field takes focus |
| H | hides it (Dismiss, in the panel, for a settled entry) |
| R | marks it read |

## Postgres

Migration `0020_notifications`:

| Table | |
|---|---|
| `runs` + `conversation_id`, `branch_id`, `repo_id` | where a run works: its answer's conversation, branch and repository, set by the report that creates the row (rows before it backfilled) |
| `watches (principal_id, subject, level)` | `branch:<id>` or `repo:<id>`, at `attention`, `all` or `muted`. Not synced |
| `notifications (recipient, subject)` | `kind`, `state`, `mine`, `quiet`, `run_id`, `repo_id`, `conversation_id`, `actor`, `title`, `ref`, `href`, the four versions, `occurred_at` (orders a repository's events, so a late older push changes nothing). `REPLICA IDENTITY FULL`; synced to its recipient only |

## The routes

`worker/Notifications.ts`, in ChatApi. A feed is anyone's signed in, of their own rows, which only acts a person may take on a repository write (ruling AUTH-8); following a conversation is a Member's or above's of the deployment's own repository, as the fold checks each follower as one.

| Route | Answers |
|---|---|
| `POST /api/watches` `{ conversationId }` (`null`: home) | `200 { txid }`, or `{ txid: null }` when already followed; a level already chosen is kept. `403` for a branch you may not open; `404` for no such conversation |
| `POST /api/notifications/ack` `{ subject, version, act }` | `200 { txid }`; `{ txid: null }` when it changes nothing; `404` for a row that isn't yours. `act` is `read`, `dismiss` or `hide`, merged as `greatest(…, least(version, row version))` |
| `GET /api/shapes/notifications` | Electric's `notifications` where `recipient` is you: every row for a Member or above of `GITHUB_REPOSITORY`, else only the rows of your own acts (`mine`: your runs, clones and writes, ruling AUTH-8); signed out, no rows; sessions unreadable, `503` |
| all | `401` signed out; `403` a follow below Member; `400` invalid; `405` another method; `413` over 2 KiB; `503 { code: "unavailable" }` when Postgres can't be reached |

The run report and answer routes (`worker/Runs.ts`) fold in their own transaction: a report that writes the run's row routes it (`foldRun`), and an answer closes the question for everyone. The answer's own settled status wins over the run's row, as in the conversation: settling an answer (`POST /api/answers/<id>`, `worker/Answers.ts`) folds it too, and `chat/Expire` abandoning one fails its run and folds it, so a run whose tab never came back doesn't read `Working` forever. GitHub's webhook (`worker/github/Api.ts`) records `main` and releases of the repository it syncs.

## Flows

`src/features/attention/flows.ts` (declarations) and `steps.ts`. Each step is one ChatApi request through `AttentionClient`, tried again for a day while ChatApi can't be reached (an act taken offline lands once the device is back); a 4xx other than 408 or 429 is final. Transport failures preserve `reason: unreachable | timeout` without a status. A 200 took the write even when its receipt is malformed; the client logs `notifications.malformed` rather than retrying that write.

| Flow | Door | |
|---|---|---|
| `watch/set { conversationId }` | `view` (the tab), the agent | follow a conversation's branch and repository |
| `notification/ack { subject, version, act }` | `button` | Read, Dismiss or Hide; one run per press. The person's only |

## The browser

`src/features/attention/` follows [state.md](../state.md):

| Piece | What it is |
|---|---|
| `notifications` | your rows, an Electric collection kept on the device (`persist: { schemaVersion: 1 }`) |
| `attention-pending` | Read, Dismiss and Hide held until the synced rows show them; an act that cannot land is removed |
| `attention-entries` | what the views read, worked out by `feedOf` (`entries.ts`, pure) from the rows, the device's own progress rows (`progressOf`, `progress.ts`, pure), the pending acts, the clock and the conversation the tab shows; again when a receipt changes or a toast is due to hide |
| `attention-dismissed` | your Dismiss of a failure this device toasted itself, by subject and the receipt's time; kept on the device, forgotten once the list no longer shows such a failure |
| `stack`, `stackHere`, `list`, `listHere` | the current toasts and the rest of your list, on a page and over a conversation |
| `attention-panel` | the panel on this tab: open, the entry expanded, the entry to focus, A's focus requests |
| `attention-details` | the expanded entry's detail (`detailOf`), worked out again when the entry, its answer, its run row or the tab's draft changes, including changes to the expanded entry's branch conversation |
| `feed`, `unread`, `needs`, `panel`, `detail` | the panel's entries newest first, the bell's counts, the panel, the detail |
| `open(subject, surface)`, `hide`, `dismiss`, `read`, `answer` | a toast's click or Answer, its ×, the panel's ×, R, A |
| `openPanel(via, subject?)`, `togglePanel`, `closePanel`, `expand`, `retry` | the panel |
| followers | the feed (above), and the watch: `watch/set` for each conversation the tab shows, once per person after success, for a Member (or while sign-in can't say); a failed launch or failed flow releases its watch for the next place or sign-in change |

A Read, Dismiss or Hide that cannot land leaves the device, so its entry shows the synced state and the person can act again. The device records `notifications.pending` and increments `smithers_notification_acts_dropped`, by `act` and `reason` (the failure tag). A press after one that failed runs again rather than joining the failed run; ChatApi merges acts with `greatest()`, so an act sent twice changes nothing. An act whose tab closed before the engine took it stays on the device until the notification's next version or its synced row replaces it.

The views are `@smthrs/ui`'s `ToastStack` (at most three children), `Toast` (`tone="update"`, `word`, `unread`, `hideLabel`, `onOpen`, `onExpand`, `onAnswer`, `onRead`), `NotificationPanel`, `NotificationEntry`, `NotificationBell` and `NeedsYouCard`, with `noticeDismissDelay`, `workNoticeVisible` and `NOTICE_KEYS`. Agent status keeps the header's pill, the card and the tab's title; its toast is the feed's.

## Observability

| Record | Kind | Fields |
|---|---|---|
| `runs.fold` | span, ChatApi | `smithers.run.id`, `smithers.notifications.written` |
| `smithers_notifications_routed` | counter, ChatApi | `kind`, `state` |
| `notifications.repo_event` | log and span, ChatApi | `kind`, `repoId`, `watchers`, `readers` (watchers who may read it now), `written` |
| `notifications.watch`, `notifications.ack` | log, ChatApi | `conversationId` or `subject`, `act`, `version`, `status`, `existing`, `errorCode` |
| `notifications.request`; `smithers_notification_requests`, `smithers_notification_shape_requests` | span; counters, ChatApi | `route`, `status`; `status`, `live` |
| `notifications.watch`, `notifications.ack`; `smithers_notification_watches`, `smithers_notification_acks` | log and span; counters, engine | `outcome` (`sent`, `refused`, `unsent`), `act`, `status` or transport `reason` |
| `notifications.pending`; `smithers_notification_acts_dropped` | warning, tab; counter, tab | `subject`, `version`, `act`, `outcome` (`dropped`), `reason`; counter by `act`, `reason` |
| `notifications.shown`, `smithers_notifications_shown` | log and counter, tab | `subject`, `version`, `state`, `kind` |
| `notifications.panel`, `smithers_notifications_panel` | log and counter, tab | `act` (`open`, `expand`, `retry`), `via` (`bell`, `toast`, `more`, `key`) on open, `subject`, clone Retry `outcome` (`started`, `failed`) after admission |
| `notifications.malformed`, `agent.status.malformed` | warning, client | `status` (200); no response body |

No record carries a title, a question, a commit message or who pushed (the tests search the logs for them).

## Not built in this slice

- Live work of runs other than agents' answers (flows, Cloudflare, attached machines), `JournalPush`, `run_commands`, Stop and Retry from a toast, and the engine facts (`retry-scheduled`, beats, `Progress.report`) of 0009 §2.
- Unwatch and levels from the app; a run's steps when this device doesn't hold its conversation; the left edges for live work scrolled out of view; browser notifications; `notifications/Prune` (rows past 7 days are hidden, not deleted); repository policy (M-47).
- Repository events locally: GitHub's deliveries need the GitHub App and its webhook secret, which `alchemy dev` doesn't have unless you configure them.

## Tests

| Test | Proves |
|---|---|
| `worker/Notifications.test.ts` | On the real ChatApi and Postgres: routing to the launcher and the branch's watchers (quiet, `all`, muted, access), versions, a question answered, a second question, a settled run, an answer settled before its run reports, a run with no scope; every watch and ack answer; greatest() from two devices in either order; the shape's filter; signed GitHub `push` and `release` deliveries: newer, older, replayed, other branches and repositories; no record carries a title |
| `src/features/attention/entries.test.ts` | `feedOf`: every toast and list rule, pending acts, words, order, the panel's time; `timeOf`, `landed`, `follows` |
| `src/features/attention/detail.test.ts` | `detailOf`: steps, notes, questions and Retry for every state; `surfaceOf` |
| `src/features/attention/attention.test.ts` | Two people on Node devices: Ann's run on both her devices and Ben's; Read, Hide and Dismiss across her devices; done hiding after 4 s; an act a device can't send; watching per conversation and per sign-in. The panel: newest first, unread count, reads, answers, Open and Retry; an isolated branch-message update refreshes its expanded detail; close watch emissions launch once, failed launches and flows release the watch; clone Retry returns before admission and records its real outcome |
| `src/features/attention/branch-page.test.ts` | The real branch screen and its one anchored stack, rendered over real app queries and a synced clone failure; 283 older unread notices and a spend alert stay in the bell, without an overflow row or spend toast |
| `src/features/attention/page-notices.test.ts` | Every stack is anchored under a positioned header box, and each page has one owner of it |
| `e2e/toast-pin-clearance.spec.ts` | At 1190×785, 1440×900 and 390×844, a real pin and Add your model toast: center hit tests and clicks for collapse, expand and unpin, full toast visibility and usable toast controls, keyboard Hide without moving the pin, conversation or composer; reduced motion on the phone |
| `e2e/toast-layout-shift.spec.ts` | On `/app` and a branch page, at 1280px and 390px, a run in a conversation the person isn't looking at (their own in a branch they track; a teammate's on `main`, which they follow) reports through the real runs route: the toast arrives and Hide removes it while the headers, the conversation, the composer and the view keep their boxes, the stack hangs under the header, and the browser records no layout shift outside the conversation's messages and the header's status |
| `src/features/attention/api.test.ts` | `AttentionClient`'s answers and the steps' outcomes |
| `worker/flows/Expire.test.ts` | An abandoned answer's run fails, and its launcher's row says so |
| `@smthrs/notifications` `test/Inbox.test.ts`, `@smthrs/ui` `tests/agent-status-notices.test.tsx`, `tests/notification-panel.test.tsx` | `Inbox`; the notices, `Toast`, `ToastStack`, the panel, its entries, the bell and every key |
| `tests/NotificationBacklog.test.ts`, `tests/AlertSettings.test.ts` | Backlog renders no overflow row in the stack, current notices cap at three, and spend entries expand and hide in the panel |
| `e2e/notification-overflow.spec.ts` | Desktop and phone repository headers stay at the top with unread history: real API-created entries locally, existing account history on a deployment (`E2E_SYNCED_REPOSITORY`) |
| `e2e/notifications.spec.ts` | In real browsers: Ann on two devices, Ben on one; Ben sees Ann's run on `main` from the Runs page and clicks its toast to her run; Alt+T and H hide her toast on both her devices; she expands it in the panel and answers there with A; Alt+N, R, E and O on her second device; the bell and Dismiss; `main` and a release reach both people, expanded with who pushed (needs `E2E_GITHUB_WEBHOOK_SECRET`) |

Two people locally: `worker/DevChatApi.ts` signs in a browser with the cookie `smithers_dev_person=teammate` as `local-teammate`, a Member (`devices.openTeammate`).

## Missing run records

A terminal answer settles its existing live notification even if its run-index row is gone. The terminal state wins; a streaming answer stays live. The existing durable expiry folds missing answers and repairs missed terminal projections. A confirmed engine cancellation starts `chat/Close`; Stop waits for the terminal engine receipt and closes the answer in its durable step, including after reload or on a branch’s run page. Losing a tab or its network does not close a run. Repairs recheck each recipient’s current branch access. `notifications.run_missing` records only `runId` and `written`; the existing `runs.fold` span records `smithers.run.missing` and the write count, and `smithers_notifications_routed` counts the resulting states. See [0036](../decisions/0036-toasts-reserve-page-space.md).

Opening a waiting run from a toast navigates to its conversation with the answer anchor, then focuses the question. Opening a question already in the conversation keeps focus there.

An empty panel, including a visitor's, says `No notifications`. Empty spend-alert content does not suppress this state.

Commit entries open the tree at their recorded revision, including entries synced before this change; later pushes cannot change that destination.

Failed clones keep their reason and Retry in the panel, without an Open link to a repository that could not be imported. Notification rows open their subject directly; Details and E expand other entries.

The panel contains the full synced list and scrolls independently; its unread count excludes read entries. Timeline previews format recorded times for the viewer instead of showing database timestamp strings.

## Model setup (FE-23)

A signed-in person without a usable personal model, when hosted inference is off for them, sees one **Add your model** notice with **Open settings**. A scoped prerequisite follower reads the real session and model rows and contributes one local notice to the shared attention feed. Every surface uses its existing `Notices` owner and anchored `ToastStack`; no conversation space is reserved. The notice remains until a model can answer. Hide applies across this tab's surfaces; reload checks the condition again. Saving a usable model or signing out resolves it. It sends no notification acknowledgment to the server. Existing `notifications.shown` records and counters measure presentation; `notifications.model` records Open settings, resolution and Hide without credentials or content.

`tests/ModelNotice.test.ts` covers the shared feed, Hide, settings navigation and resolution against real Postgres/Electric. `e2e/model-toast.spec.ts` proves the overlay over history, stable conversation bounds on Hide, reload, Open settings, Save and Remove in a real browser without a provider call.

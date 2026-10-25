# 0009: Notifications and live work: one run index, one personal feed, views of both

Status: proposed (2026-10-19; design panel: Opus as lead, and Sol). It builds on [0002](0002-local-first.md) (the device store and outbox), [0007](0007-roles-and-tags.md) (who may read), [0008](0008-auth.md) (who is acting) and [HOST-PLAN] (the Cloudflare host). [0011](0011-the-agent-runs-in-the-browser.md) moved the agent and local flows onto a durable browser engine; decision 5 and §2's browser runs were revised for it the same day. The comparison of the two designs is the appendix.

## Decision

1. **Three records, many views.** A **run** is the work. A **watch** says who follows what. A **notification** is one person's durable record about one run or one wait, with at most one action. The toast stack, run cards, the timeline (later) and browser notifications are views of these rows, and none of them stores state.
2. **Every run on every host has one `runs` row.** It holds status, waiting reason, step, attempt and progress, and every limit as an instant: `step_timeout_at`, `live_until`, `next_wake_at` and `deadline_at`. A pure fold of journal facts writes the row, in the same transaction as the facts.
3. **The engine journals the limits it now keeps in memory:** attempt and heartbeat timeouts, the next retry, coarse beats and progress. Today only `Deadline` and long durable sleeps are stored.
4. **Liveness is read, never swept.** A device compares `now` with `live_until` and shows `No signal since 12:04`. Recovery belongs to the engine: its lease, the Durable Object watchdog or the run's `Deadline`. Nothing on the server takes over a silent machine's side effects.
5. **One fold, two transports.** The Cloudflare host folds in the journal's append transaction. A host with its own journal pushes lifecycle entries to `POST /api/journal`, and ingest folds them. The server keeps the cursor. Each reply returns that host's pending commands, so the server never dials a machine. Since [0011](0011-the-agent-runs-in-the-browser.md), a browser engine also writes its folded rows, through 0002's outbox (§2).
6. **Notifications come only from journal facts.** The folding transaction routes each fact: the built-in audience plus watchers, minus mutes, limited to people who may read the repository (0007). A repository policy flow (M-47) may narrow that set. It never delays delivery more than 10 s, and a late answer changes nothing.
7. **People get rows. An agent gets its runs' outcomes as `NotificationQueue` system events** (`@smthrs/notifications`). That queue is bounded, so the rows stay the truth when it refuses.
8. **Scope lives on watches.** A watch names a run, a flow, a repository, a branch or TODO, or a conversation. Its level is `attention` (the default), `all` or `muted`.
9. **A flow describes its watch view as data.** A `Watch` annotation gives a title and a progress unit, and steps call `Progress.report`. `@smthrs/ui` renders it. No flow puts markup in the app's DOM, and nothing shows an estimated time left.
10. **Every act is a flow with three doors** (slash, button, agent). The acts are Hide, Dismiss, Read, Watch, Cancel, Retry and Answer. Acks are integer versions that merge with `greatest()`, so devices never conflict.
11. **No notifications screen** (mvp.md §8 cuts it). The stack shows three, and `+N` expands the person's list in place. A live run whose card is on screen gets no toast. Live work scrolled out of view shows on the left edges (mvp.md §6.4).

## Why

- **v4's toasts died on reload.** `AppStore.ts` dismisses every toast at boot, so only Hide survived. The root rule asks for a toast that reconnects after a reload.
- **v4 polled.** Run cards polled every 2.5 s (`workflowPollMs`) and called a run `quiet` after 10 min without progress (`workflow-pump.ts:88`). Electric already pushes rows here.
- **v4 routed in the browser.** A tab launched the M-47 policy run and polled it 40 times (`notificationPolicy.ts`), so a closed tab routed nothing. Its worker toasts carried no actions: the README promised Stop and Retry, but only `WorkerControls`' `Status` type was imported.
- **v4's Go backend lost notifications.** `notifications` had no dedupe key, and fan-out dropped work when its 256-slot queue filled (`notification.go:605`). Two ideas are worth keeping: access re-checked on read, and read receipts per version (`RepositoryNotifications.ts`).
- **The engine can't say "times out at T" today.** `attemptTimeoutMs`, `heartbeatTimeoutMs` and the retry backoff live only in memory (`Action/make.ts:132`, `Dispatch.ts:395`), and `Context.heartbeat` only resets a watchdog.
- **The SDK already has the words.** `@smthrs/control` has `RunStatus`, `PendingWait` and `Health` (`Freshness`: fresh, stale, unobserved). `@smthrs/notifications` treats open and closed conditions as journal data (`AlertPolicy.defaultDetectors`). This design adds tables and a fold, not a vocabulary.
- **Folding in the transaction removes a class of bugs.** A projection woken after commit needs cursors, catch-up and a wake path, and HOST-PLAN's W4 runtime can't start another execution yet. The engine already keeps `flows_run_changes` with triggers inside the mutating transaction.

## Consequences

- **SDK work comes first:** engine facts, journal projectors, `RunIndex`, `Inbox`, `JournalPush` and the UI pieces (§5). Each lands with its first consumer.
- **The engine's per-schema writer lock carries one more upsert per transition.** `pnpm bench` measures it beside HOST-PLAN risk 10.
- **Repository policy waits for a host that runs repository code** (feature 5). Built-in routing ships first.
- **Remote run history stays on its host.** The server keeps the folded row, not a mirror of the journal.

## 1. Product model

```
 journal facts ─▶ fold ─▶ runs (shared, live) ─▶ run cards, toast detail
                    └──▶ route: built-in ∪ watchers − muted ∩ readers ─▶ [policy ≤ 10 s] ─▶ notifications (per person)
                                                                                 └──▶ agent: NotificationQueue event
 notifications ─▶ toast stack · +N list · browser notification · timeline entry (later) · email (later, #3423)
```

| Fact | Built-in audience | State, action |
|---|---|---|
| A run you started is running | you | `live` · Stop |
| It waits on a person (`HumanTask`, a form, an approval) | the launcher; for a TODO, its owner and the people on its branch (M-14) | `needs_you` · Answer |
| It failed, timed out or ran past its deadline | the launcher | `failed` · Retry; stays until dismissed or retried |
| It finished | the launcher | `done` · Open; hides after 4 s |
| A PR is ready, merged or conflicted (with TODOs) | the TODO's owner | `in_review`, `merged`, `conflict` |

- **You watch what you start.** A child run (an agent's tool call, a delegated step) shows inside its parent and raises no toast of its own. Its waits and failures still route.
- **Watches widen or quiet.** `watch/Set({ subject: "flow:triage/classify", level: "all" })` tells me about every run of that flow, success included. `muted` silences live toasts, never a `needs_you` addressed to me. A repository watch defaults to `attention`.
- **Verbs stay distinct.** Hide removes the toast and keeps the entry and its action (mvp.md §6.4). Dismiss closes a `done` or `failed` entry. Read records that the person opened it. Only the underlying flow resolves a `needs_you`, and others then see `Ben answered`.
- **Repository policy (M-47) keeps #4026's contract.** Identity goes in, at most 50 recipient ids come out, access is checked after, and every failure falls back with a closed reason. It runs as a durable flow, never in a tab (§3).
- **Kept from v4:** one toast per subject that settles in place, the 300 ms rule, failures that never expire, Hide that keeps the entry, launch dedupe (`claimWorkToast`), read state per version, and the #4026 contract.
- **Changed from v4:** durable rows instead of tab timers, push instead of polling, routing on the server, and actions on live work.

## 2. Watching live work

| `runs` field | Source fact | Shown |
|---|---|---|
| `status`, `waiting` (approval, input, event, timer, retry, quota, child) | engine park and wake, `control.*` | glyph and one word |
| `step`, `attempt`, `attempt_max` | `attempt-started` | `Attempt 2 of 5`, only while retrying |
| `step_timeout_at` | `attempt-started` + `attemptTimeoutMs` | run card |
| `live_until` | last beat + `heartbeatTimeoutMs`; null while parked; null with no timeout (Freshness `unobserved`) | `No signal since 12:04` once passed |
| `next_wake_at` | new `retry-scheduled`; `EngineStore.nextWake` for timers | `Retrying in 8 s` |
| `deadline_at` | the run's `Deadline`, already durable | run card: `Gives up at 10:12` |
| `progress_done`, `progress_total` | `Progress.report` | `12 of 40 issues` |
| `flow`, `flow_version`, `host_kind`, `host_id`, `parent_id`, `retry_of`, `launched_by`, `conversation_id`, `repo_id`, `pending_wait`, `failure`, `cancel_requested_at`, `settled_at`, `seq` | start intent (0008's actor), waits, settle | scope, outcome, idempotence |

**Engine facts to add, in `@smthrs/flow`:**
- `attempt-started` carries `attemptTimeoutMs` and `heartbeatTimeoutMs`.
- `retry-scheduled { stepKey, attempt, wakeAtMs }` is journaled before the in-memory backoff.
- `Context.heartbeat` journals a beat at most once per third of its timeout. Coalesced beats still arrive inside the liveness contract. `ModelStep` beats per event, so a streaming answer writes about one beat per 20 s.
- `Progress.report({ done, total })`, journaled at most once a second.

**A remote run, end to end:**

```
 attached machine (own SQLite journal)                Cloudflare Worker                              Neon
 engine ─▶ journal ─▶ JournalPush ── POST /api/journal {host, incarnation, generation, afterSeq, entries} ─▶
                         ▲          ingest: fence host + generation; skip seq ≤ runs.seq; fold ─▶ runs, notifications (1 tx)
                         └── 200 {appliedSeq, commands} ◀── run_commands not yet seen in this host's journal
 idle 10 s: an empty push is the beat ─▶ live_until = now + 30 s, rewritten at most every 10 s
 lid closed: no pushes ─▶ devices show "No signal since 12:04"; reopened: resume from appliedSeq; a gap answers 409 {afterSeq}
```

- **Cloudflare runs** fold in the append transaction, over Hyperdrive with schema-qualified SQL (HOST-PLAN 4). A reset isolate stops beats. The alarm watchdog takes the run over, and its new `attempt-started` makes it live again.
- **Sandbox steps** placed from a Cloudflare run stay that run's steps. A sandbox running its own engine pushes like a machine.
- **Browser runs** ([0011](0011-the-agent-runs-in-the-browser.md)): the agent and local flows run on the leader tab's engine. It folds its journal with the same `RunFacts.fold` and writes `runs` and progress rows through 0002's outbox, like every other local write, so they sync to the person's other devices. The server admits each write in one transaction that routes notifications, as ingest does, and skips a write at or below the row's `seq`. With every tab closed, other devices show `No signal since` until the run resumes. A remote child is a server run with `parent_id`. Until 0011, browser-local flows folded into a local-only `localRuns` collection.
- **Remote hosts** with their own journal keep pushing ordered, fenced batches to `POST /api/journal`.
- **Cancel:** `run/Cancel` calls `RunStore.requestCancel` and wakes the execution: the Durable Object's alarm, or a `run_commands` row for a pushing host. The row reads `Stopping` until the engine settles it.
- **Answer:** `HumanTask.answer` or `Control.signal`, then a wake, because a parked wait has no timer ([W4 README]).
- **Retry:** terminal runs are never claimed again (`RunStore.ts:132`). `run/Retry` starts a new execution with the same payload and `retry_of`, and dismisses the failure once it's admitted.

**A small Jev run is registered by declaring it:**

```ts
export default Flow.make("triage/classify", {
  description: "Label each issue with Jev",
  payload: Issues, success: Labels, deadline: "2 minutes",
  annotations: Watch.annotate({ title: "Classify issues", unit: "issues" }),
  body: (input) => Classify.call(input) // Classifier.make, one request per batch; each batch calls Progress.report
})
```

Nothing else registers it. The toast reads `Classify issues · 12 of 40`, and the card adds the elapsed time and `Gives up at 10:12`. Under 300 ms nothing flashes. Past the deadline it settles `failed` (`timed_out`), and the toast offers Retry.

**Dynamic views, safely.** `Watch` is data: a title (plain text, at most 80 characters), a one-word unit and numbers, rendered as React text nodes. A flow wanting more uses Panel A's isolated renderer, and the row holds only its render id. Status, actions and attention stay outside any custom frame, so a broken renderer falls back to the plain card and can't hide a failure.

## 3. Storage and sync

```sql
runs          (id uuid PRIMARY KEY, …the fields in §2…, updated_at timestamptz)                         -- REPLICA IDENTITY FULL
notifications (recipient uuid, subject text,              -- subject: 'run:<id>' or 'wait:<token>'
               run_id uuid, conversation_id uuid, repo_id uuid, kind text, state text, title text, action jsonb,
               version int, read_version int, dismissed_version int, hidden_version int, hidden_until timestamptz,
               quiet bool, policy text, policy_reason text, deliver_after timestamptz, routed_at timestamptz,
               expires_at timestamptz, created_at timestamptz, updated_at timestamptz,
               PRIMARY KEY (recipient, subject))                                                         -- REPLICA IDENTITY FULL
watches       (principal_id uuid, subject text, level text CHECK (level IN ('all','attention','muted')),
               PRIMARY KEY (principal_id, subject))
run_commands  (id uuid PRIMARY KEY, run_id uuid, host_id text, kind text, payload jsonb, created_by uuid, seen_seq bigint)
```

- **Dedupe.** One row per person per subject. The fold skips any entry at or below the row's `seq`, so a replay, a resent push or a second ingest writes nothing.
- **Versions.** A change that needs attention again (a new question, a failure after a retry) bumps `version` and re-raises the row everywhere. A row is open while `dismissed_version < version`, and hidden while `hidden_version = version` and `now < hidden_until` (Hide is `infinity`; Snooze is a time). A late offline ack for an older version never closes a newer one.
- **Closing.** When a wait resolves, the fold clears the action and sets `resolved`. Nothing closes on a timer.
- **Policy without a sweeper:**
  1. When a repository declares a policy, the fold writes the built-in audience's rows with `deliver_after = now + 10 s` and starts `notify/Route` after commit (`Journal.whenCommitted`).
  2. On time, the route keeps, adds or withholds rows, sets `quiet` and stamps `routed_at`.
  3. A late or never-started route changes nothing, and devices show the held rows at `deliver_after`. A hung policy delays a notification and never suppresses it.
  4. Route runs notify no one about themselves.
- **Expiry.** `done`, `resolved` and `cancelled` rows expire after 7 days. Open `needs_you` and `failed` rows never do. `notifications/Prune` deletes expired rows from a `@smthrs/triggers` cron, as a durable flow.
- **Access.** A role change (0007) deletes the person's rows for that repository in its own transaction. Every action flow checks access again when it runs.

| Shape (`ShapeProxy`, authorized per request, 0008) | `where` |
|---|---|
| notifications, watches | `recipient = $actor`, `principal_id = $actor` |
| the open conversation's runs | `conversation_id = $1` (`conversation:read`) |
| one run: a visible toast's detail, an opened card | `id = $1` |
| a repository's runs (home card, later) | `repo_id = $1` (`repo:read`) |

- **On the device,** every shape is a persisted collection (0002). A reload draws the stack from OPFS in its first frame, then Electric resumes.
- **Launching:** the client picks the execution id, so a repeated launch makes one run. A local `launching` row, anti-joined like 0002's `asking`, reads `Requested` until the run row arrives.
- **Acts** are outbox mutations keyed by `(subject, version)`, so they survive offline use and reloads.

## 4. The UI, one surface

```
┌ conversation ──────────────────────────────────────────┐
│ ↑ 1 live above                                         │  edge: live work scrolled out of view
│ ▸ Clone tinyhttp  ◌ 0:42                       [Stop]  │  run card on screen: no toast for it
└────────────────────────────────────────────────────────┘
 ┌ stack, bottom-left, three at most ─────────────────┐
 │ ◆ Deploy preview needs you             [Answer]  × │  gold
 │ ✕ Classify issues · Timed out          [Retry]   × │  ember; stays
 │ ◌ Classify issues · 12 of 40           [Stop]    × │  live
 │ +2                                                 │  expands to the full list, then Earlier
 └────────────────────────────────────────────────────┘
```

| State | Detail (closed vocabulary) | Action |
|---|---|---|
| requested (device only), queued (admitted, unclaimed) | `Requested`, `Queued` | none |
| live | units if declared, else elapsed | Stop |
| retrying, waiting | `Retrying in 8 s`, `Waiting` | Stop |
| live past `live_until` | `No signal since 12:04` | Stop |
| stopping | `Stopping` | none |
| needs you | the wait's own name | Answer |
| failed | the failure code's sentence (`Timed out`) | Retry |
| done, resolved | none, or `Ben answered`; hides after 4 s | Open, when it made a card |

- **Visibility is a pure function** of the row and `now`: `workNoticeVisible` and `noticeDismissDelay`, root-exported from `@smthrs/ui`. One scoped clock ticks once a second while a live toast shows. Components keep no timers.
- **Order:** needs you, failed, live, done. The stack is a keyboard pane, and Hide is a button on every row.
- **Browser notifications by consent** (mvp.md §6.4):
  - One ask, an Allow toast at the person's first `needs_you`. The permission request runs only on that click, and only on HTTPS. On plain HTTP, Settings reads `Notifications need HTTPS`.
  - While every tab is hidden, the focused-tab leader (0002's Web Lock) raises `needs_you`, `failed` and `in_review` with `tag = subject:version`. The tag replaces a duplicate after a crash; nothing claims exactly once.
  - The notification closes when another device reads or dismisses the row. Clicking it runs the row's action.
  - Delivery after every tab is closed (Web Push), email and phone come later.

## 5. Engineering

| Package | Change |
|---|---|
| `@smthrs/flow` | `Watch.annotate`, `Progress.report`; the engine facts in §2 |
| `@smthrs/journal` | projectors: `SqlJournal.layer({ projectors })` runs each in the append transaction and in ingest |
| `@smthrs/control` | `RunIndex`: the `runs` and `run_commands` migrations, the pure `RunFacts.fold`, `Health.freshness(row, now)` and `RunActions.allowed(row)` |
| `@smthrs/notifications` | `Inbox`: the `notifications` and `watches` migrations, pure routing, its projector and the policy stage. `NotificationQueue` stays the agent side |
| `@smthrs/sync` | `JournalPush` (a host layer, like the Durable Object alarm) and `JournalIngest`; lifecycle families only, fenced and idempotent |
| `@smthrs/platform-cloudflare` | `ExecutionObject.wake` for a cancel or an answered wait |
| `@smthrs/ui` | `ToastStack`, `Toast`, `RunCard`, `RunProgress`, promoted from v4's `ToastStackView.tsx` |

- **App (`apps/mvp`):** `src/features/attention/` holds the store, the queries (`stack`, `list`, `run`), the actions and `browserNotify.ts` (a scoped Effect over an injected `Notification`). Its `.tsx` views come from `@smthrs/ui`. The Worker serves the shapes, `POST /api/journal` and one route per act, and each route starts its flow.
- **Flux:** action → outbox → flow → Postgres → Electric → collection → live query → view. The person's button and the agent's tool call run the same flow.
- **The agent** gets `runs.list`, `runs.get`, `run/Cancel` (with confirm), `run/Retry`, `watch/Set` and `notification/Dismiss`. "Tell me when the clone finishes" becomes a watch at `all`, never a notification the agent writes. Browser permission and approvals stay the person's own acts.
- **Observability:** spans `runs.fold`, `notify.route` and `journal.ingest`; metrics `notifications.created{kind,source}`, `notifications.shown{surface}`, `notifications.dismiss_ms{kind}`, `runs.no_signal{host_kind}`, `journal.ingest.lag_ms`, `journal.ingest.gap` and `notify.route.fallback{reason}`. Logs carry run, subject and trace ids, never titles, details or payloads. A sentinel title proves it against the OTLP export.

## 6. Tests

- **Unit, real Postgres:**
  - The fold over scripted journals: limits, retry wake, a wait opened and closed, a cancel racing a success, a deadline during a wait.
  - Routing: defaults, M-14, `all`, `muted`, access and the cap of 50.
  - Policy: absent, malformed, hung and late, each delivering exactly once.
  - Dedupe under replay and double ingest; acks from two devices in either order; ingest fencing, a gap (409), a generation change and a stale incarnation.
- **The toast machine under `TestClock`:** nothing before 300 ms; done hides at 4 s; failed never hides; `No signal since` appears exactly at `live_until`; one toast per subject across repeated launches.
- **End to end, real stack, video:**
  - N1: a slow flow raises a toast after 300 ms and settles from the real outcome, with chat usable throughout.
  - N2: a reload mid-run shows the toast in the first frame, and it settles.
  - N3: on two devices, Hide on one keeps the row on the other, and Dismiss clears both.
  - N4: a remote run from a Node host with its own SQLite journal. Kill the host: `No signal since`. Restart it: the run resumes and settles once.
  - N5: reset the Durable Object mid-run. The watchdog takes over, and the toast never shows a failure.
  - N6: Answer a needs-you form. The toast clears on both devices.
  - N7: the Jev flow shows `12 of 40`, then times out into Retry.
  - N8: dismiss offline, reload offline, reconnect: applied once.
  - N9: a hidden tab raises one browser notification per version, with no prompt before a click.
  - N10: a hostile renderer falls back to the plain card.
  - Keyboard-only use and both themes are covered too.

## 7. Phases, and what v4 lacked

1. **With HOST-PLAN W5 (c)**, which wires the Cloudflare flow host into `worker/` since 0011: the engine facts, the fold and `runs` for Cloudflare runs, plus launcher notifications for `repo/Clone` (0006) with Stop, Retry, reload and two devices (N1 to N3, N5).
2. Needs you through feature 3's forms, watches, browser notifications and the agent's tools (N6, N7, N9, N10).
3. Remote hosts: `JournalPush`, `JournalIngest` and `run_commands` (N4).
4. Repository policy (M-47) once repository flows run on a sandbox host; then Web Push and email (#3423).

**New beyond v4:** notifications that survive a reload and follow you across devices; limits and liveness in plain sight, with host silence kept apart from failure; actions on live work; remote runs that report without polling and take commands back the same way; the agent as a recipient; watching a flow or a repository.

## 8. Questions for Will

1. Should a finished run leave a quiet entry under `Earlier` for 7 days, or vanish after its 4-second `Done`? Recommended: keep it.
2. On a shared conversation, should someone else's live run toast for you? Recommended: no. It shows in the conversation, and you get toasts for your own work and for what needs you.
3. Repository policy needs repository code to run on a sandbox host. Should built-in routing ship now and the policy ship with sandboxes? Recommended: yes.

**Settled by the lead, 2026-10-19,** after Will called a sibling question "thinking too far ahead". These take the simplest choice for what we build now. Will may override any of them.
1. **A finished run disappears after its `Done`.** Its result lives in the conversation. A failed run stays visible and retryable until someone retries or dismisses it (root `AGENTS.md`). The `Earlier` list is not built.
2. **Toasts follow the scope you're in, not only your own runs.** Will overrode the lead's first answer: "Some toasts you should see for other people's runs if they are on same branch as you for sure this goes back to what I said about feeds being tied to user, branch repository etc. Main changing is tied to repository for example or a new release tied to repositry." Every event belongs to one scope, and you get it through the watch on that scope (decision 8):
   - **Person:** your own runs and anything that needs you.
   - **Branch:** runs on a branch you're on, including other people's runs and the agent's.
   - **Repository:** events for everyone watching the repository, such as `main` changing or a new release.
   
   A conversation's runs show in that conversation.
3. **Built-in routing only.** A repository's own notification policy waits until sandboxes exist.

## Appendix: Opus and Sol compared

Both designs were written independently, then Opus merged them. Sol's adopted claims were checked against the W4 README, the `@smthrs/notifications` README, the root AGENTS.md and mvp.md §6.4.

**Agreed:** run, watch and per-person record as separate things, with toasts as views; you watch what you start; the 300 ms rule, settlement from the real outcome, and failures that persist; read state per version; Retry as a new linked execution; Cancel shown as Stopping until confirmed; #4026's policy contract under a 10 s deadline with closed fallbacks; remote hosts pushing ordered, fenced batches with commands returned to them; flow-declared views rendered from data, with custom ones isolated; browser notifications by consent with the version as tag; no notifications screen.

| Point | Opus | Sol | Final | Why |
|---|---|---|---|---|
| Projection | a fold in the journal's append transaction | durable flows woken after commit, with cursors and catch-up | Opus | No commit-to-wake gap, lag or cursor table. W4 can't start other executions yet |
| Tables | 3 | 10, normalized | Opus's 3 plus Sol's command table (`run_commands`) | Electric syncs one table per shape. Receipts as versions on the row need no client join |
| Read | seen when shown | only when opened | Sol | Rendering is not reading |
| Ack verbs | one ack | Hide, Unwatch and Acknowledge kept apart; only the flow resolves Needs you | Sol, as Hide, Dismiss and Read | The spec's Hide keeps the entry; Dismiss closes; Answer resolves |
| Late policy results | not covered | cannot redeliver | Sol, via `deliver_after` | Held rows show on time with no sweeper, and a late route changes nothing |
| Policy hints | recipients and quiet | adds grouping hints | Opus | #4026's decision has no grouping field (NO INVENTION) |
| Estimates | `about 0:20` from `expectedMs` | none in the MVP | Sol | AGENTS.md removes predictive estimates; only exact bounds show |
| Stale copy | `No signal since 12:04` | `Connection lost` | Opus | It names the host's silence, which 0002's `Offline` pill doesn't cover |
| Toast while the card is on screen | not covered | suppressed; edges for live work out of view | Sol | mvp.md §6.4 and the mock's edge pills |
| Where the full list lives | `+N` expands the stack | a filter in the activity card | Opus | `apps/mvp` has no activity card; `.specs/engineering/spec.md` §14.4.3 names `+N more` |
| Remote cursor | the server holds it | a durable send checkpoint on the host | Opus, with Sol's command receipts | The server's `seq` is already durable, so the host needs no second store |
| Silent host | `No signal since` | unknown; central code never takes over | both | Two sides of one rule |
| Agent delivery | `NotificationQueue` | don't reuse it as a human inbox | both | Agents only; the rows stay the truth when the queue is full |
| Mark all read | not offered | a recipient-order watermark | dropped | The spec doesn't ask for it |
| Auth | 0008's actor | a seam, auth deferred | 0008 | 0007 and 0008 now exist |

[HOST-PLAN]: the lead's durable-answering plan, 2026-10-19. [W4 README]: `packages/smithers/flows/platform-cloudflare/README.md`.

## Clone launch refusal (2026-10-25)

A persisted clone request owns a feed entry before its remote execution starts. If launch is permanently refused because the deployment no longer has Code Storage, the launch route settles that matching attempt as `failed:unavailable` and folds its feed entry in the same transaction. A stale attempt cannot settle a newer one. A transient host failure remains retryable by the durable launch step. GitHub's `not_found` remains the Inspect/Settle outcome. A failed clone remains retryable and dismissible after reload.

Uses the library catalog's `@smthrs/flow` durable launch and `@smthrs/notifications` feed entries; no new scheduler or retry loop.

The clone-feed e2e must wait for the retry's own terminal repository row, identified by its incremented attempt. Seeing the repository name again is only an acknowledgment and can still be the first failure's text. Ending the browser context then can strand a persisted request before its browser flow launches the remote execution. Tests must leave every clone they request settled.

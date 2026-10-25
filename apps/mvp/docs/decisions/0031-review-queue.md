# 0031: The review queue: one person's queue of everything that needs their judgment

Status: approved with changes (Will, 2026-10-21 01:14; see [Will's answer](#wills-answer)). Claude Opus and Codex Sol designed independently, and Opus merged the two (PROC-6); [Where the drafts disagreed](#where-the-drafts-disagreed) records each difference. Mock: [design/review-queue/review-queue.html](../design/review-queue/review-queue.html). The curator's general prompt: [design/review-queue/CURATOR-PROMPT.md](../design/review-queue/CURATOR-PROMPT.md).

It answers ruling PLUGIN-4 and builds on PROC-10 (the queue's spec), PROC-19 (confidence), PLUGIN-1 to PLUGIN-3, FE-2 to FE-15, DUR-1 to DUR-7, ARCH-18, FLOW-1 to FLOW-5 and M-47, and on decisions [0009](0009-notifications-and-live-work.md) (notifications), [0015](0015-agent-status.md) (waits), [0016](0016-todos-and-the-stack.md) (TODOs and the factory addendum), [0017](0017-everything-is-a-plugin.md) (plugins), [0018](0018-issue-lifecycle.md) and [0021](0021-local-first-migrations.md).

Will, 2026-10-20 about 23:58: "It serves as a great way to review a changeset as it can break the review down into both small changes in a changeset but further break it down into every individual decision to review code to review gifs etc. basically every artifact gets it's own very well review woven into a higher level storyline. I can imagine this being how we process your notifications as well when we want to handle them as well as approvals with the abilidty to do stuff like remind me in 1 hour remind me tomorrow etc."

## Decision

1. **One queue per person.** Everything that needs your judgment arrives in one full-screen queue in the chat shell, one item at a time, highest priority first, every action on a key, a note box on every item.
2. **It is the first-party `queue` plugin** on 0017's public interface: 0017's `needs-you`, renamed, because it now holds reviews and notifications as well as waits. `review-code` and `review-media` contribute the code, recording and design kinds through the hook `queue/item-kind`.
3. **Every item that asks you something is a wait.** A question, decision, approval or review item is a run parked on `HumanTask` and addressed to you. Answering is `run/answer`, so it resumes exactly the run that asked, and only a person can do it.
4. **A changeset becomes a storyline.** A pull request at a head commit is cut into steps (small changes), and each step into items: code slices with guides, recordings with chapters, designs and the decisions they raise.
5. **Notifications and approvals use the same queue.** The queue reads your feed (0009's `notifications` rows). The bell's panel stays for a glance; the queue is where you clear things. Both run the same acts on the same rows.
6. **Later is a durable timer.** Snoozing writes the time on your feed row, and a remote `attention/remind` run raises the row again when the time comes, with every device off.
7. **The curator is a flow over flows.** `queue/curate` runs one short pass per event, with CURATOR-PROMPT.md as its system prompt, and writes ranks, coverage, rulings and new items.
8. **Agents never approve, merge or answer for you.** Approvals and protected acts are drawn by the host's action strip, never by plugin code (0017's host contract).

## What exists today

Checked on disk on 2026-10-21. Paths are relative to `apps/mvp` unless they start with `packages/`.

| Piece | Where | State |
|---|---|---|
| The prototype | `apps/maintainer-site/client/queue.{html,js,css}`, `serve.mjs`, `queue/` | Works locally: 100 answers in `answers.jsonl`, 44 items, coverage of 5,394 slices |
| Plugin interface | decision 0017, approved 2026-10-20 17:03 | Built since (checked 2026-10-25): `@smthrs/plugin`'s `Manifest`, `Load` and `Host`; the app's host in `src/plugins/`; the `queue` plugin over `core/waits` (`plugins/queue/`) |
| Waits | `HumanTask` (`packages/smithers/flows/flow/src/HumanTask.ts`): kinds `ask`, `confirm`, `select`, `json` (:71-79); `HumanTask.answer` (:933) | `app/agent/ask` uses it (`src/features/status/flows.ts:117`); its wait closes after `ASK_WITHIN_MS`, 10 minutes (`src/features/status/contract.ts:30`) |
| Answering | `run/answer` (`src/features/status/flows.ts:167`); `POST /api/runs/<id>/answer` (`worker/Runs.ts:158-170`) | Person-only (`src/flows/registry.ts:149`); the launcher only (`Runs.ts:213`, `:241`); an approval takes a boolean only (`Runs.ts:154-155`) |
| The runs shape | `GET /api/shapes/runs` | `launched_by = $1` (`Runs.ts:361`): a wait addressed to anyone but its launcher can't reach them |
| Notifications | `db/migrations/0020_notifications.ts:42-69`, `worker/Notifications.ts`, `src/features/attention/` | One row per recipient and subject, with `version`, `read_version`, `dismissed_version` and `hidden_version`. The acts are `read`, `dismiss` and `hide` (`packages/smithers/notifications/src/Inbox.ts:220`), person-only (`Notifications.ts:469`). No snooze. The panel and bell are built (`src/screens/root/Root.tsx:28-29`) |
| Durable timers | `Sleep.action` with `{ until }` parks durably (`packages/smithers/flows/flow/src/Sleep.ts:66`, `:86-103`) | Remote flows wake on the Durable Object's alarm (`worker/ExecutionHost.ts:198-226`); `chat/Expire` and `ops/SpendAlert` sleep this way (`worker/flows/Expire.ts:120`, `SpendAlert.ts:175`). A browser timer doesn't fire while no tab is open (`packages/smithers/flows/platform-browser/docs/guides/run-flows-in-a-tab.md:139`) |
| Protected acts | `PROTECTED_ACTS` (`worker/Actor.ts:147-151`) holds `pr/merge`; `refusesPersonOnly` (:180) | Approving a pull request has no route yet (:145) |
| Pull requests | `docs/features/pulls.md`; `pr/merge` through the writes route; `checks/Run` (`worker/flows/Checks.ts:87`) | `GET /api/repos/<o>/<n>/compare/<base>...<head>` returns the files two commits differ by |
| Recordings | `e2e/gifs.mjs` writes `~/Desktop/smithers-mvp/videos/<spec>/<test>.{mp4,chapters.json}` | Nothing uploads them. `@smthrs/artifacts` has file-system, memory and HTTP stores and `ImmutableCache`, but no Cloudflare object-store layer |
| Code view | `@smthrs/repo-view`, `src/features/code-intel/` | An outline from the language server (`SymbolsPane.tsx`), line marks and annotations (`CodeFileView.tsx:83-100`). No folding and no comment hiding; nothing requests LSP `foldingRange` |
| Device store | `src/device/registry.ts`; `Outbox.withdraw` (`packages/effect-tanstack-db/src/Outbox.ts:250`) | No row LRU and no always-kept subset (`docs/work/lru-size-limit.md`: todo) |
| Shapes | `ShapeProxy` (`packages/effect-electric/src/ShapeProxy.ts:16`, `:175`) | Drops client subset requests; the server fixes every `where` |
| Migrations | `db/migrations/` | The highest is `0034_prototypes.ts` |

## 1. What the queue is

### Items and kinds

An **item** is one judgment asked of one person about one subject at one revision. Its id is the subject's key plus a digest of the evidence and the judgment, so an answer always refers to what the person saw, and a changed subject gets a new id. Re-ranking changes neither.

| Kind | You judge | Keys | Comes from |
|---|---|---|---|
| `question` | a fact or choice only you have | `1`–`4`, type an answer | the agent's `app/agent/ask`, the curator |
| `decision` | a choice for what is being built now | `1`–`4`, Other | the curator, a storyline step |
| `approval` | an exact action waiting for your yes | Approve, Deny, with a note | any `HumanTask` `confirm`; a TODO's pull request ready to merge |
| `code` | a slice of code with its guide | Looks good, Changes | a storyline step; the curator over `main` |
| `recording` | a feature shown in chaptered recordings | Looks good, Changes | a storyline step |
| `design` | a mock or screenshots, light and dark | Looks good, Changes | a storyline step |
| `verify` | whether a fix does what you meant | Fixed, Not fixed | the curator, when a fix lands |
| `notification` | something that happened | Open, Retry, Dismiss | your feed |

- **"Looks good" is not "Approve".** Looks good records that you reviewed the evidence. Approve and Deny are reserved for authorization items and drawn by the host.
- **An alert is a notification's severity,** not a ninth kind: spend, outages and security notices sort first.
- **The core never switches on a kind** (0017: "no feature nouns in the core"). Kinds are the plugin's data.

### Priority

The curator ranks every item from 0 to 1000 by CURATOR-PROMPT §3's bands: blockers, the current release, verify, live decisions, walkthroughs, designs, code by risk, internal tooling last. Within a band: what depends on it, risk, recency. A priority you state overrides these and becomes a standing rule. The rank is a `rank` record per person with its band and one-line reason, so the order explains itself. Without a rank, items sort by kind: approvals and needs-you, failures, verify, decisions, reviews, updates.

Re-ranking never replaces the item under your hands or takes your draft. A new urgent item updates the count; moving to it is your press. The visible queue holds about the top 150 ready items; coverage tracks the rest. Open waits are never capped.

### Confidence

Every question, decision and approval carries a confidence score for its recommended default (PROC-19), shown beside the recommended option before the context: an integer from 0 to 100 and one line on why. Below 60, a second line says what would raise it. The rubric is CURATOR-PROMPT §7: 85 to 100 when a ruling or hard evidence settles it and it is easy to reverse; 60 to 84 for sound reasoning without a ruling, or hard to reverse; below 60 for new territory or rulings in tension. An item with several questions scores each and shows the lowest. A score is advice: it never orders the queue and never approves anything.

### Answers

| Action | Key | Means |
|---|---|---|
| option | `1`–`4` | that option, with the note if any |
| looks good / approve | `a` | reviewed, or yes to an authorization |
| changes / deny | `r` | your note asks for work, or no |
| later | `l` | snooze ([§3](#later-snooze)) |
| applies to all | `g` | this note covers every item of this kind in this repository |
| undo | `u` | take back the last answer |

- An empty note sends at once; with text, a key picks and `⌘↵` sends.
- Changes needs a note or a line or chapter stamp (`L42:`, `[02:14 Save]`).
- A substantive note on Looks good is still a change request: "good, but…" dispatches work.
- "Make it easier to review" is not a review: the slice is recorded `needs guide` and returns with a better guide.
- **Undo** takes back an answer the outbox hasn't sent (`Outbox.withdraw`). Once sent, `u` appends a retraction that reopens a review or a snooze. It can't unmerge or take back an answer the asking run already used; the item says so and offers a correction.
- **Applies to all** writes one fix request for the kind in this repository and holds the siblings it hits. When the fix lands, they return: recordings and designs only once rebuilt after the fix, code and questions as they were. It never approves in bulk.

## 2. The review of a changeset

### The storyline

A changeset is a pull request at a pinned base and head: a TODO's pull request, or any pull request in a repository with the plugin.

```
PR #42 base 1c0e7a → head 9f3c1e
  overview        why, the steps, one diagram
  1 data          code: db/migrations/0036_notification_snooze.ts                 + guide
  2 the reminder  code: worker/flows/Remind.ts L1-96                               + guide
                  code: worker/Notifications.ts L380-452                           + guide
                  decision: "Presets: 1 hour, this evening, tomorrow, next week?"  72%
  3 the queue     code: plugins/queue/src/later.ts                                 + guide
                  design: the Later chooser, light and dark
  4 proof         recording: e2e/queue-later.spec.ts, 4 recordings, chapters
  verdict         approval: "Merge #42?"   Maintainers; the host's confirm
```

`queue/storyline { repo, pr, base, head }` builds it in four steps:

1. **Inventory, from facts only.** It reads the changed files from the compare route and the check runs from `runs`. The model never invents the file list or a passing run.
2. **Slices.** Related changed files are grouped into slices of about 150 to 400 changed lines; a large file is cut into consecutive hunks. Every changed range belongs to exactly one slice, so coverage counts each line once. Generated files and binaries get an item or a stated exclusion.
3. **Steps.** Slices group by role (data and migrations, core logic, flows, UI, tests, docs and designs) and read in that order: an overview first, then entry points, then internals, then tests. Within that order, security code comes first: sign-in, access checks, secrets, sandbox boundaries.
4. **Items.** Each slice becomes a `code` item; the pull request's passing e2e recordings become `recording` items grouped by feature; changed `docs/design/**` files become `design` items; and the choices the guide writer finds that only a person can make become `decision` items linked to their slice. The last item is the verdict: an approval to merge, shown only to people who may merge.

Each item is a `queue/ask` child run parked on `HumanTask`, addressed to the reviewer, with the item as its question payload (at most 16 KiB; a longer guide is an artifact referenced by digest). The `storyline` record holds the steps and their item ids, which the view draws as the rail.

**Placement** (DUR-5). A storyline a person starts runs on their browser engine. One the curator starts runs on `FlowExecution`, because no device started it.

### Guides

`review-code/guide { repo, sha, slice }` writes one guide per slice with `ModelStep` under the model role `review`. Its output decodes against a schema:

- **What** the slice does and **Why** it exists, citing rulings and decisions.
- **How**: the key steps.
- **A diagram** (ASCII) of the slice in its system: callers, effects, trust boundaries, the slice marked.
- **Read this first**: `path:line` pointers that resolve at the pinned commit; a pointer that doesn't resolve fails the guide.
- **Questions a reviewer should ask**, and a note per file.

The step's key is the digest of the slice's content and the rulings it read, so a replay or an unchanged slice costs nothing and keeps the prompt cache (DUR-4). A guide for other bytes is stale and holds its slice; a guide for a slice that was regrouped is orphaned. Neither is ever shown as ready.

### Answers flow back

Every answer key in the strip runs `queue/respond`, a person-only flow. It is a root dispatch from a person door, so its steps carry the person's session (0017 slice 0) and can make the person's writes:

| Answer on | `queue/respond` does | Then |
|---|---|---|
| any item | answers the wait (`POST /api/runs/<id>/answer`) | the asking run resumes |
| code, Looks good | | the asker writes a `coverage` record: the line ranges, the commit, you, the answer |
| a TODO's pull request, Changes | adds your note as the TODO's next revision through the stack's writer | the `todo` run implements again on the same branch |
| code on `main`, Changes | commits a TODO whose prompt is your words verbatim and the slice (`path:L1-L2 @ sha`) | the TODO's run, its pull request, then a `verify` item |
| a decision | | the asker writes a `ruling` record and resumes whoever waits on it |

- Each write is keyed by the answer's op id, so a retry writes nothing twice.
- Each request that asks for work is a `fix` record: the words verbatim, the files, the run doing it, and the fix's receipt or a "no verify" reason. It is the product form of the prototype's `dispatch.md` line.
- A TODO's next revision needs the writer's Amend operation, which 0016's addendum cut; this restores it for this consumer.

### Verify, before and after

- A landed fix (its receipt in the `fix` record) raises one `verify` item per walkthrough or code change, listing every open note it claims to address. It quotes your words and ends "Does it do what you meant?"
- **Before and after** are immutable: the media is snapshotted into the artifact store the first time it is shown, and code is read at its pinned commit, so a new recording never overwrites what you saw. Code compares as a diff with your `L42` notes on the old lines; recordings play on one timeline aligned by chapter; a chapter with no match stays unmatched.
- While a change request is open, newer revisions of its subject are held; its verify item brings them back.
- A complaint only about a recording (blank, too small, no timeline) returns as soon as a newer passing recording exists. A product change waits for the fix's receipt.

### Coverage

Coverage is a ledger of `coverage` records, not an estimate:
- Each unit is a changed range in a pull request, or a range of the source at a pinned commit for whole-repository review. The two scopes have separate denominators, labelled.
- Each unit is unreviewed, accepted, fix requested or needs guide. A changed line invalidates its unit; overlapping references count once.
- The header shows `4 of 9` for a changeset and the share of lines reviewed for the repository.
- Notifications, snoozes and guide complaints never count. Watching a recording doesn't review its code.
- **Coverage never gates a merge.** 0016's addendum: "Checks never gate: a person reads them and merges." Branch protection still applies.

## 3. Notifications and approvals

### How notifications enter

The queue reads your open feed rows:

| Row | In the queue |
|---|---|
| `needs_you` | its wait, as a question, decision or approval |
| `failed` | its own item: Retry (`x`), Open (`o`), Dismiss (`d`) |
| `done`, `main`, release | one `Updates` item per repository with a count; `d` clears it |
| quiet (someone else's run on your branch) | never enters |

A failure, a wait or an approval never folds into a digest. The bell's panel and the queue read the same rows and run the same acts (Read, Hide, Dismiss, Later), so they agree on every device. The panel's header gains one link, `Queue`. Mandatory delivery doesn't depend on the curator: with its model down, waits and failures still show in kind order.

### Approvals stay a person's

- An approval is a `HumanTask` `confirm` wait. Its item states the exact action, who asked, what it touches, before and after, the evidence (checks, recordings, the diff) and the confidence that approving is right.
- The host's action strip draws Approve and Deny and owns their keys. Plugin code never dispatches `run/answer` (0017's host contract), and `run/answer` refuses any actor acting for a person (`Runs.ts:282-283`).
- A note rides with the answer: `run/answer` accepts `{ approved, note }` beside a boolean, an additive change to `Runs.ts:154-155`.
- A protected act, such as merging, also needs the host's confirm dialog and its single-use receipt (0017 slice 0). The queue never approves because a confidence score is high.
- **Checked when used:** role, access, the open wait's version and the exact target revision. A new commit on the pull request answers `Changed`, keeps the draft and shows the new before and after; an old press never approves the new head.

### Later (snooze)

`l` opens the chooser in the strip:

| Key | Returns |
|---|---|
| `1` | in 1 hour |
| `2` | this evening, 18:00 (offered until 17:00) |
| `3` | tomorrow, 9:00 |
| `4` | next week, Monday 9:00 |
| `l` | tomorrow, 9:00 (the prototype's `l`) |
| type | "in 3h", "fri 2pm": parsed by a pure function; the resolved time shows before you send |

- Times resolve in your IANA time zone with calendar arithmetic, so a daylight-saving change doesn't move "tomorrow 9:00". The row stores the instant and the zone.
- **A preset past the wait's deadline is disabled** and shows the deadline. An agent's chat question closes in 10 minutes, so Later is never offered for it; snoozing a card never extends its run.
- **Data:** `notifications` gains `snoozed_until`, `snoozed_zone` and `snoozed_version`. A row is snoozed while `snoozed_version = version` and `now < snoozed_until`: a pure function of the row and the clock, like 0009's visibility rules. 0009 §3 designed this as `hidden_until` ("Snooze is a time").
- **The act** is `notification/snooze { subject, version, until, zone }`. The person or their agent may run it ("remind me about #42 tomorrow"), on that person's own rows only; answering stays person-only.
- **The reminder is a durable timer.** The snooze route writes the row and admits `attention/remind { recipient, subject, version, until }` on `FlowExecution`, in one transaction. It is remote by need: it must fire with every device off. It runs `Sleep.action({ until })`, wakes on the Durable Object's alarm, then raises the row's `version` only if the snooze is still current, and every device shows the item again with a toast.
- **Exactly once:** the execution id is `remind/<recipient>/<subject>/<version>`. A newer snooze, an answer, a dismissal or a newer version of the row makes an older timer a no-op; nothing is cancelled and nothing sweeps.
- **Offline:** the snooze goes through the outbox and hides the item on this device at once. If its time passed before the device reconnects, the item returns at once.
- Snoozing an approval releases nothing: the run keeps waiting.

## 4. The curator as a flow

`queue/curate` is a flow over flows (0017 §Flows over flows), remote, with the plugin installation as its principal and model spend on the repository's budget.

**Triggers,** each a short pass keyed by run and event sequence, never a loop:
- `run.waiting` and `run.settled` over `todo` and `checks/Run`;
- `github.push:main`;
- a `queue/respond` run settling.

**Each pass:**

```
read new answers ─▶ coverage, rulings, fix records; retractions
read fix receipts ─▶ verify items; release held subjects
read sources     ─▶ new commits, check runs and recordings, designs, waits
gate (code)      ─▶ run passed · chapters non-empty · guide matches revision · design marked done
rank             ─▶ bands in code; the model only orders within a band ─▶ rank records
publish          ─▶ new items as queue/ask runs; moot ones cancelled with a drop record and the ruling that settled them
```

- **The system prompt** is CURATOR-PROMPT.md, shipped in the plugin's folder and versioned with it; each run pins its digest. Its maintainer mechanics (`queue.json`, `dispatch.md`, a loop every few minutes) become records and triggers.
- **The quality gate is code where it can be.** A recording without a recorded status is unknown, never passing. A design is ready when its author marks it done; 15 minutes without changes is only the fallback for imported folders.
- **The rulings check:** before raising a question or decision, the pass reads the repository's rulings and accepted answers not yet in its rulings file, and drops or cites any that settle it ("decided by GH-9"). Jev scores the match (FLOW-7).
- **Secrets:** an item names a secret and links the core Secrets page; it never shows a value or a command that prints one, and never asks for a secret in a note.
- **Evals** (TEST-11), with the real model: an already-settled question, missing evidence, a failing recording offered as proof, a false fix claim, an unrelated applies-to-all note. The invariant: no approval and no invented evidence.

### Where rulings live

- Each accepted decision is a `ruling` record at once: the question, the option, the person's words verbatim, who, when, and what it replaces. The next pass can't ask it again.
- The repository's rulings file is the durable, reviewable copy: `apps/mvp/docs/rulings.md` for Smithers, `.smithers/rulings.md` elsewhere, set by a repository setting. `queue/curate` drafts its changes through the coding factory, and a person merges them.
- Only answers from people with authority over the repository become its rulings; a person's own preferences stay theirs.

### Importing the maintainer queue

`queue/import` runs once, when Will chooses to move: it reads `answers.jsonl`, `coverage.json`, `dispatch.md` and `before/`, keeps every answer's id, time and words, and dedupes by id. Imported answers are history: they never authorize a merge or a grant. After it, the maintainer queue stops writing (SDK-11).

## 5. The plugin shape

```
apps/mvp/plugins/queue/          the queue: views, waits, notifications, Later, storylines, the curator
  plugin.json  src/tab.ts  src/components/*.tsx  prompts/curator.md  e2e/
apps/mvp/plugins/review-code/    code items and guides; taps queue/item-kind
apps/mvp/plugins/review-media/   recording and design items, scripts; taps queue/item-kind
```

**The public extension points it needs, all from 0017:**

| Point | `queue` contributes | 0017 slice |
|---|---|---|
| `views` | `queue/main` at `/app/queue` and `queue/repo` at `/<owner>/<repo>/-/queue`, sizes `inline` and `full`, reading `core/waits`, the feed and its records | 1 |
| view `events` | `option`, `approve`, `changes`, `reply`, `later`, `dismiss`, `retry`, `open`, `next`, `previous`; the person-only ones drawn by the host's action strip | 1 |
| `slots` | `shell.nav` (the count), `repo.tabs` (a repository's queue), `item.pane` (Review on a pull request or TODO page) | 1 |
| `commands` | `/queue`, `/queue.review #42`, palette entries | 1 |
| `keybindings` | every key in [§7](#7-ui), with `when` | 1 |
| `flows`, `owns`, `uses` | owns `queue/respond`, `queue/ask`, `queue/storyline`, `queue/curate`, `queue/import`; uses `notification/snooze`, `notification/ack`, `pr/merge`, `app/navigate`. `queue/respond` makes the answer and stack writes in its own steps, because a nested person-only flow is refused (0017 slice 0) | 1 (built-ins) |
| `hooks` | owns `queue/item-kind` (collect); `review-code` and `review-media` tap it | 4 |
| `records` | `storyline`, `coverage`, `rank`, `fix`, `ruling`, `drop` | 4 |
| `triggers` | `run.waiting`, `run.settled` over `todo`, `checks/Run`; `github.push:main` | 2 |
| `modelRoles` | `review` (guides and curation), mapped by Admins | 5 |
| `settings` | per repository: the rulings file's path, who reviews (default: Maintainers) | 5 |
| capabilities | `run:observe`, `run/inspect` | 2 |

**Core additions, each generic:**
- `core/waits` gains `addressedTo`; the runs shape and `run/answer` honour it.
- `notification/snooze` and `attention/remind` in core attention.
- The records contract gains a schema version and a retention class (`always` or `lru`) per collection, so the device registry can keep or evict them (ARCH-18).
- An `ArtifactStore` layer over Cloudflare's object store in `@smthrs/platform-cloudflare`, and an authorized route that reads by digest (SDK-1).
- LSP `foldingRange` in `@smthrs/std`'s `LanguageServer` and code intelligence, and folding and comment hiding in `@smthrs/repo-view` from those ranges (the `comment` kind), never from a regular expression.

No new slot name, no private interface and no second graph model. Disabling `queue` leaves waits, approvals, toasts and the panel working through the core.

## 6. Data model and sync

### Postgres

| Migration | Change |
|---|---|
| `0035_wait_address` | `runs.addressed_to text` with an index. The runs shape becomes `launched_by = $1 OR addressed_to = $1`; `run/answer` checks `addressed_to` when it is set |
| `0036_notification_snooze` | `notifications.snoozed_until timestamptz`, `snoozed_zone text`, `snoozed_version integer NOT NULL DEFAULT 0 CHECK (snoozed_version BETWEEN 0 AND version)` |
| `0037_plugin_records` | 0017's `plugin_records (plugin, collection, scope_kind, scope_id, key, schema_version, value jsonb, run_id, updated_at)`, primary key `(plugin, collection, scope_kind, scope_id, key)`, `REPLICA IDENTITY FULL`; at most 16 KiB a record and 10,000 per collection and scope; written only through the core step that runs `Authorize` |
| `0038_artifacts` | `artifacts (digest, repo_id, run_id, kind, content_type, bytes, created_at)`: metadata; the bytes live in the object store |

Numbers are the next free ones today and are taken at build time.

**Records the plugins write:**

| Collection | Scope | Key | Holds |
|---|---|---|---|
| `storyline` | repository | pull request and head | steps, their item ids, the overview |
| `coverage` | repository | path and range at a commit | state, reviewer, answer, invalidation reason |
| `rank` | person | item id | priority, band, reason |
| `fix` | repository | answer id | words, files, run, receipt or "no verify" reason |
| `ruling` | repository | ruling id | question, option, words, who, when, replaces, file status |
| `drop` | repository | subject | reason and the ruling that settled it |

Existing tables stay authoritative for their own jobs: records link to runs, notifications, TODOs and pull requests by id and never write stack order, merge state or an approval.

### Electric and TanStack DB

| Shape (through `ShapeProxy`) | Collection | Kept on the device |
|---|---|---|
| `notifications`, yours (exists) | `notifications` | always |
| `runs`, yours and addressed to you | `runs` | always |
| `plugin-records` `queue/rank`, yours | `queue-rank` | always |
| `plugin-records` `queue/storyline`, per repository, `repo:read` | `queue-storylines` (family) | always while the changeset is open |
| `plugin-records` `coverage`, `ruling`, `fix`, per repository | `queue-coverage`, `queue-rulings`, `queue-fixes` (families) | LRU |
| none | `queue-drafts`: the note and scope per item | always, persisted |
| none | `queue-pending`: acts sent, not yet in the rows | always, persisted |
| none | `queue-view`: the item, file, media, compare mode | this tab |
| none | `queue-prefs`: hide comments, outline open | always, persisted |

- Each collection and each outbox payload is declared in `src/device/registry.ts` with its versions (decision 0021): a synced change drops and resyncs; a local change migrates.
- **ARCH-18.** The always-kept subset is your open items, their waits and ranks, and the storylines of open changesets. The LRU holds coverage, rulings and fixes of other repositories, and answered items. The row LRU isn't built (`docs/work/lru-size-limit.md`); the queue is its first consumer.
- **Bytes** (a file at a commit, recordings, designs) go through `ImmutableCache` over `BrowserCache`, keyed by digest. A pending answer, a draft or an open item's evidence is never evicted.
- Offline, an item whose evidence was never downloaded says `Not kept offline` and keeps your note; Looks good waits until the evidence is here.
- Pending answers sit in `queue-pending` and are anti-joined against the synced rows, as `attention-pending` does, so another device's newer answer always wins.
- Sign-out wipes all of it through the existing wipe.

## 7. UI

### Layout

Full screen inside the chat shell (FE-9). The host header stays, `⌘K` opens the chat over the queue, and `f` toggles the queue between full screen and its inline view in the conversation.

```
┌ host header ───────────────────────── Flows  Runs  Settings  Queue 7  bell  ◐  will ┐
│ Queue  3 / 7   ● 1 approval ● 1 decision ● 3 code ● 1 recording   #42 4 of 9   31 done │
├ storyline ┬ item ────────────────────────┬ subject ─────────────────────────────────┤
│ #42 Later │ CODE  sdk:notifications  640 │ Remind.ts  Notifications.ts   J K       │
│ ● overview│ The reminder fires once      │ worker/flows/Remind.ts  L1-96   9f3c1e  │
│ ✓ 1 data  │ What · Why · How · diagram   │  1 import { Flow, Sleep } from …        │
│ ◉ 2 remind│ Read this first ·  Questions │ 12 ▸ export const remindId = …  ⋯ 3     │
│ ○ 3 queue │ ┌ note (i) ───────────────┐  │ …                                       │
│ ○ 4 proof │ └─────────────────────────┘  │                                         │
│           │ [a Looks good] [r Changes] [l Later]                                   │
├───────────┴──────────────────────────────┴──────────────────────────────────────────┤
│ a looks good  r changes  l later  g all  u undo  J K file  c comments  z fold  O outline  s story  ? keys │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **The item** (left): kind, area, priority, title, why, the confidence line, the context or guide, your quoted words, links, then the host's action strip: the note box and the buttons with their keys.
- **The subject** (right): code with file tabs, a recording with its chapter timeline, a design in a sandboxed frame, or before and after.
- **The storyline rail** (far left, changesets only): the steps with their summaries always visible, one dot per item, the current one lit, reviewed ones filled. `s` opens it as a list to jump.
- **Motion:** the item slides about 160 ms on an answer; reduced motion turns it off.
- Minimal text (FE-15): no explanatory prose, no provenance footer, no row whose value is "not measured".

### Keys

The prototype's keys, plus three:

| Key | Does |
|---|---|
| `1`–`4` | option; in the Later chooser, a preset |
| `a` · `r` | looks good or approve · changes or deny (focuses the note) |
| `l` | Later |
| `u` · `g` | undo · applies to all |
| `i` `/` · `Esc` · `⌘↵` | the note · leave it · send |
| `j` `k` · `J` `K` · `n` `p` | scroll · file · media |
| `c` · `z` `Z` · `O` | hide comments · fold the body at the cursor, fold all · outline |
| `b` | before, after, both |
| `space` `←` `→` `,` `.` `[` `]` `<` `>` `0` | play · 2 s · frame · chapter · speed · start |
| `o` | open a referenced file inline |
| `s` | the storyline list (new) |
| `d` · `x` | dismiss · retry, on notifications (new) |
| `f` | full screen or inline in the conversation (changed: the prototype's browser full screen) |
| `?` | every key |

The core keymap resolves conflicts (0017): the queue's keys apply while its view has focus and no text field does. Typing pauses a recording and stamps the note with its moment (`[02:14 Save] `); clicking a line number starts `L42: `.

### Code

`@smthrs/repo-view` shows the slice with real line numbers, the guide's `Read this first` lines marked, folding from LSP ranges (a fold shows how many changed or annotated lines it hides, and a guide pointer opens it), comments hidden from the language server's `comment` ranges with line numbers kept, and the outline (`O`). A language without a server shows plain source.

### Phone

One column: the subject, then the item; the action strip pinned to the bottom above the soft keyboard; the storyline and the key sheet as sheets; before and after as a toggle, never two small videos. Every action is a button with the same command as its key. A swipe never approves.

## 8. Slices

Each slice lands with its e2e tests, a chaptered recording, observability and docs, and works locally and in production (TEST-1, TEST-4).

| # | Slice | Builds | Needs |
|---|---|---|---|
| **1** | **The queue over waits (smallest)** | 0017's slice 1 under the name `queue`: the plugin host's views, slots, commands, keybindings and events; `core/waits`; the host's action strip; the Queue view full screen by keyboard with the note box; `app/agent/ask` gains `confidence` and `priority`; `run/answer` takes `{ approved, note }`. Items: the agent's questions and approvals | ships to production after 0017's slice 0 (run credentials) |
| 2 | One changeset | `queue/storyline` started by a person (`/queue.review #42`, Review on the PR page); `review-code` and `queue/item-kind`; `queue/ask` with `addressed_to`; guides; coverage, `fix` and `ruling` records; folding and comment hiding; `queue/respond` with Amend and TODO commit; the merge approval with stale-head refusal | slice 1; `plugin_records` and the kernel's `collect` hook kind (both 0017 slice 4, pulled forward); the writer's Amend |
| 3 | Notifications, approvals and Later | feed rows as items, the Updates digest, `notification/snooze`, `attention/remind`, the panel's Queue link | slice 1 |
| 4 | Recordings, designs and verify | the object-store `ArtifactStore`; check runs upload recordings; `review-media`, the player and design frames; before and after; verify items; applies to all | slice 2 |
| 5 | The curator | `queue/curate` on triggers over `todo` and `checks/Run` and `main`; ranking, the gate, rulings, drops, the import; evals | slices 2 to 4; 0017's flows over flows |
| 6 | Parity | the Queue as a framed app through the bridge alone, passing slice 1's e2e (0017 slice 3) | 0017 slice 3 |

**Slice 1's acceptance:** the scripted agent asks three questions, one an approval; `g q` opens the queue; the oldest fills the screen with its confidence; `2` answers from the host's strip; the run resumes and its card shows `Answered`; the approval takes a note; an answer on device B removes the item on device A within one sync; a reload mid-send keeps the draft and `Sending`; an answer offline lands once on reconnect; the `Queue` component calling `dispatch` for `option` is refused `person_only`; keyboard only, both themes, with a GIF.

**Observability, every slice** (OBS-1, OBS-5): one trace from admission through prepare, gate, show, answer, dispatch, fix and verify, with ids and reason codes only. Counts: items by kind and state, held reasons, stale guides, invalidated units, pending writes, approval refusals, reminder lag (`attention.remind.lag_ms`) and time to ready. No title, note, code, guide or recording text in any log, span or metric; a sentinel test proves it against the OTLP export.

**Benchmarks** (TEST-8), locally and live: key press to next item, the queue's first frame after a reload, guide cost per slice, reminder wake to row raised.

## 9. Questions for Will

1. **The bell's panel stays for a glance, and the queue is where you process notifications?** Recommended: yes. **80%**: both designs reached it from "when we want to handle them", and it keeps one set of rows and acts; you haven't seen the two side by side yet.
2. **"Changes" on code already on `main` commits a TODO with your words in the same press?** Recommended: yes. **66%**: it is the fastest loop and stays your own act, but one key then starts paid agent work; the alternative is a second item asking you to commit the drafted TODO.
3. **A repository's rulings: recorded in Smithers at once, then written to its rulings file (`.smithers/rulings.md`; `apps/mvp/docs/rulings.md` here) by a pull request a person merges?** Recommended: yes. **68%**: records stop the queue asking twice, and the file stays reviewable and readable by any agent; the cost is one rulings pull request after each batch of decisions.

**Settled here, without asking** (PROC-16): the plugin is `queue`; applies to all covers this repository and this kind; coverage never gates a merge (0016's addendum); no quiet hours and no "snoozed three times" flag until asked for; the overview is the first item of a storyline, and `a` moves past it.

## Where the drafts disagreed

Both drafts agreed on: a plugin on 0017's interface with `review-code` and `review-media` as taps; waits answered through `run/answer` and the host's strip; the storyline built from a real inventory with revision-bound guides; immutable before and after; coverage that never gates a merge; the panel kept for a glance; a remote durable timer for Later; no extending a 10-minute question by snoozing it; and the same smallest slice, 0017's slice 1 over waits.

| Point | Opus | Sol | Final | Why |
|---|---|---|---|---|
| Name | `queue`, titled Queue | `needs-you`, titled Review | `queue`, Queue | Will calls it "this queue feature", and the prototype is titled Queue. "Needs you" is 0015's state word, and "Review" collides with the factory's `review` check (`docs/features/pulls.md`) and GitHub reviews. Nothing is built, so the rename costs nothing |
| What an item is | a wait raised by the queue's flows | typed review records (13 logical collections) linked to waits and notifications | waits, plus six record collections | 0017 §Flows over flows already says the queue "raises an item to the person as its own wait"; `run/answer`, its person-only check and cross-device delivery exist. Answers are already write-once on the row (`Runs.ts:158-170`), so no answers table |
| Where Later lives | core attention: columns on `notifications`, a core remind flow | the plugin: `review_deferrals`, `review_reminders` | core | 0009 §3 designed Snooze as a time on the feed row; Later applies to the panel and toasts too, so one per-person state |
| Later's time rules | presets only | IANA zone, daylight saving, the stored zone, generations | Sol's | Calendar arithmetic is what "tomorrow 9:00" means |
| Presets | 1 hour, tomorrow, next week | 1 hour, this evening, tomorrow morning, next week | Sol's four | Keys `1`–`4` match; Will named "1 hour" and "tomorrow" |
| Quiet hours, three-snooze flag | none | kept from the curator's prompt | none | Will didn't ask for them (FE-15, no invention) |
| Who may snooze | the person | the person | the person or their agent, own rows only | FLOW-3; it is reversible and touches only that person's attention |
| Undo | 5 s before delivery | an appended retraction | both | `Outbox.withdraw` exists for unsent answers; a retraction covers sent ones and says what can't be undone |
| Applies-to-all scope | unstated | this repository and kind (a question) | Sol's, settled | A micro choice with an obvious default (PROC-16) |
| Merge gate | unstated | asked as a question (88%) | settled: never a gate | 0016's addendum rules it; asking would spend one of three questions |
| `s` and `O` | `s` storyline, `O` outline | `s` outline | `s` storyline, `O` outline | The prototype binds `O` to the outline (`queue.js` footer) |
| `f` | not covered | full screen or inline in the shell | Sol's | FE-9: views go full screen or back into the chat |
| Recording without a status | the prompt's failure-marker check | unknown, never passing | Sol's | A missing status proves nothing |
| Design readiness | 15 quiet minutes | the author marks it done; quiet time is a fallback | Sol's | Quiet files don't prove a design is finished |
| Rulings home | records, with a file export later | the file is the truth, records bridge until merged | Sol's hybrid, as question 3 | Records stop re-asking at once; the file stays reviewable |
| Storyline placement | remote | local by default, remote when needed | local when a person starts it, remote for the curator | DUR-5 |
| Hooks | `queue/item-kind` | plus `evidence` and `curation-policy` | `queue/item-kind` only | Each extra hook has one consumer today; add them with a second |
| A chat card | none | a `cards` contribution | none: the view's `inline` size | 0017's views already render inline in the conversation |
| Slice order after 2 | Later, then recordings | recordings, then Later | Later first | Later is smaller and Will named it; recordings need an artifact store that doesn't exist |
| Importing the prototype | not covered | a one-time import, provenance kept | adopted in slice 5 | Will's answers are rulings worth keeping; imported ones never authorize anything |
| Questions | TODO on Changes; the panel; rulings home | the panel; applies-to-all scope; merge gate | the panel; TODO on Changes; rulings home | The other two are settled by rulings or common practice |
| Recording artifacts today | none uploaded | "the app supplies recording artifacts" | none uploaded | Checked: nothing uploads recordings; `@smthrs/artifacts` has no Cloudflare store |

## Will's answer

2026-10-21 01:14, option 2, "approve with changes": "We need to make sure we eval this stuff too heavily we want to eval if user types something if the user is just rubber stamping everything if our recomendations are good etc."

**Change: evaluate the queue heavily.** The queue measures itself, and the curator flow has real evals (TEST-11). Each measure is a counted metric (OBS-1) that never records note text (OBS-5):
- **Engagement:** the share of answers with a typed note, by item kind.
- **Rubber-stamping:** runs of quick approvals with no note, judged against how long the item takes to read (videos, code size). The queue flags a likely rubber-stamp streak to the person and never blocks them.
- **Recommendation quality:** how often the recommended option is chosen, how often an answer brings changes, and verify items sent back.
- **Confidence calibration:** acceptance rate per confidence band. A good curator's 90% items are accepted about 90% of the time.
- **Evals:** cases built from real answered items, with notes stripped of personal content, scoring whether the curator picks the default the person chose, writes a question the rulings don't already answer, and holds unready items back.

The maintainer queue measures the same things from its own answers.jsonl now, as dogfood, before the product slice exists.

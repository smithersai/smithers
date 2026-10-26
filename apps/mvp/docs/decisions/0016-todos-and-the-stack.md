# 0016: TODOs and the stack: one writer, one run per attempt, and GitHub branches without jj

Status: proposed (design panel T: Opus as lead and merger, and Sol; 2026-10-20). It designs MVP item 1 and early feature 8c, [TODOs and the stack](../work/todos-and-stack.md), on [0002](0002-local-first.md) (the outbox), [0004](0004-agent-ui-codemode-and-rendering.md) (cards), [0007](0007-roles-and-tags.md) (the catalog), [0009](0009-notifications-and-live-work.md) (toasts), [0011](0011-the-agent-runs-in-the-browser.md) (placement), [0012](0012-git-end-to-end.md) (the GitHub projection, writes and `pr/Merge`), [0013](0013-branch-workspace.md) (branches), [0014](0014-flows-authoring-debugging-and-home-view.md) (code flows, Inspect) and [0015](0015-agent-status.md) (run status). Will ruled on 2026-10-20 that Smithers has no GitHub Actions, so a pull request's checks are Smithers runs.

The product rules are mvp.md §3, §4, §6.6, §6.10, Appendices A and B, M-05, M-22, M-30, M-32, M-33, M-39 and M-49, and Will's ruling TODO-2 ([rulings](../rulings.md), 2026-10-20): the stack's order lives in Postgres, the `mythical` history comes later, and `main` stays append-only. Opus and Sol designed independently; the [appendix](#appendix-opus-sol-and-final-compared) compares them. The lead's rulings on its two questions are [at the end](#rulings-on-the-two-questions).

## Decision

1. **A TODO is Smithers' row; its branch and pull request are GitHub's** (M-22). `T<n>` counts per repository and is never reused. Its prompt is revision 1 of immutable `todo_requests`, and Amend adds a revision. A TODO has one branch, one pull request and one or more attempts.
2. **One writer changes the stack.**
   - The stack is the repository's unmerged, undropped TODOs in `position` order.
   - `worker/stack/Stack.ts` `apply(op)` is the only code that writes `stacks`, `todos`, `todo_requests` and `todo_attempts`. Each call is one transaction that locks the repository's `stacks` row `FOR UPDATE` and makes no network or model call.
   - People and the agent reach it only through `POST /api/repos/:owner/:repo/stack`: a closed union of operations, admitted by sign-in, `Authorize` and the payload's hash, keyed by the outbox's op id. The `todo` run calls it in process from its own steps.
   - This is the single-writer rule on Cloudflare. Order lives in Postgres, and the history is the chain of TODO branches on GitHub. No `mythical` ref exists now; Will ruled it comes later (TODO-2).
3. **A person commits; the agent drafts.** `todo/draft` writes a private draft on the person's device and shows the draft card, whose **Commit** runs `todo/commit`. Drop is a person's press too. The agent may open TODOs and, from slice 2, move them (Appendix B: A✓ for commit, amend and drop; A for open and move).
4. **One durable `todo` run per attempt, on Cloudflare** ([ruling 1](#rulings-on-the-two-questions)).
   - Only the writer starts it, keyed by the attempt's id. Its steps are Plan, Implement, Publish, Propose, Await and Settle.
   - It is a built-in app flow (M-11). Publish, Propose and Settle are system steps no repository flow overrides (M-30). A repository's `.smithers/flows/todo/flow.ts` later replaces Plan and Implement only, in a job sandbox (0014 decision 1).
5. **Commits leave through the host, never the box.** Publish creates `smithers/t<n>-<slug>` at its base with REST `POST /git/refs`, then appends one commit with GraphQL `createCommitOnBranch`, fenced by `expectedHeadOid`, as the App. Nothing forces a ref, and no box holds a credential (0005 §4; 0013's forge refuses pushes).
6. **On GitHub, the stack is a chain of branches whose pull requests target `main`.**
   - Tn starts from T(n−1)'s published head, else from `main`'s head. Its pull request targets `main` and is squash-merged. Only the next item's pull request is ready; later ones are drafts.
   - **Forward changes merge, never rebase.** GitHub's `update-branch`, fenced by `expected_head_sha`, brings `main` in, and `POST /merges` brings an earlier item's new commits in. Under squash merge, `main` gets the same commit a rebase would give.
   - **Taking a change out** of later items (Drop or Move of a started item) resets them to their new base with GraphQL `updateRefs` and `beforeOid`. They redo their attempt until slice 4; from slice 4 the branch machine rebases them. A conflict is Needs you.
7. **People merge, in order.**
   - A person merges with 0012's `pr/Merge` or GitHub's own button, and the webhook settles Merged (M-22). `pr/Merge` on a TODO's pull request asks the writer, which refuses anything but the next item.
   - A merge on GitHub out of order marks both items Merged and raises Needs you, "T3 merged before T2" (mvp.md §4.2). A pull request closed on GitHub drops its TODO (M-22).
   - Pre-approval (M-39) is a Maintainer's attributed grant that a system step carries out. No agent grants one.
8. **A TODO's state is on its row, for the whole team.** The run reports each step to the writer, which updates `todos`. `runs` stays the launcher's own (0015).
9. **Checks are Smithers runs.** From slice 3 a verify step runs the repository's check flows and publishes each as a GitHub check run (`GitHub.Actions.CheckRun`, `packages/smithers/agent/integrations/src/github/Actions.ts:473`), so branch protection can require them.
10. **Slice 1 works one TODO at a time** (`stacks.lanes = 1`). Each starts from `main` once the one before it settles, so nothing restacks or rewrites until slice 2.

**Out of this decision:** Make TODO and the `todo` label (J2), scratch branches and Add to stack (J7), learning, and a repository's own `todo` flow until 0014's code flows run. Steer, answer, stop, resume, retry and pre-approval are later slices (§8).

## Why

- **M-22 splits ownership this way:** "GitHub keeps `main`, issues, PRs, reviews and checks; Smithers keeps TODOs, stack order, live branches, runs". A `mythical` ref on the customer's GitHub would be a second name for the last item's head that nothing reads, and Will ruled the `mythical` history comes later, not now (TODO-2, 14:21 on 2026-10-20).
- **One short transaction is the single writer.** The Go service needed a lease, a prepared write and a fenced push because one pass held a jj push inside it (`packages/backend/internal/services/mythical.go:26-35`, `packages/backend/internal/db/mythical_ext.go:126-168`). Here each GitHub call is its own durable step fenced by an expected SHA, so the lock never spans the network, and the engine supplies retries and resumption.
- **Most of the old service can't move.** It is 57 files and 26,454 lines of Go, and its rebases run in the guest through jj-lib (`packages/smithers-machined/src/native.rs:693-933`). What ports is pure: the state mapping (`mythical_todo_state.go:38-91`), placement (`mythical_file_todo.go:68-299`, `mythical_todo_move.go:21-144`), merge readiness (`mythical_merge_todo.go:453-486`) and `@smthrs/rpc`'s projection and grammar (`packages/rpc/src/StackView.ts:168`, `TodoCommands.ts:45-66`), re-expressed in Effect Schema rather than imported as Zod.
- **Merging forward needs no machine.** Say `main` is A, T1 is B on A, and T2 is C on B. T1 squash-merges as S, whose tree is B's. `update-branch` merges S into C; B's hunks appear identically on both sides, so the merge takes them once. T2's pull request then shows only its own change, and its squash equals a rebase's. GitHub's update merges "HEAD from the base branch into the pull request branch" [GH-pulls] and never rewrites, so a person's pushed commit survives (M-33). The old engine rebuilt every PR head as a synthetic commit on `main` and pushed it through a control-plane bridge (`mythical_items.go:4353-4371`), which needs git on a host each time `main` moves.
- **`createCommitOnBranch` publishes with a fence and no machine.** It "appends a commit to the given branch as the authenticated user", `expectedHeadOid` is the commit "expected at the head of the branch prior to the commit", and GitHub signs the result [GH-commits]. The REST ref update has no expected-old SHA [GH-refs]; `updateRefs` takes `beforeOid` and applies a batch atomically [GH-git], which a reset needs.
- **The run belongs on Cloudflare.** A TODO is the team's work: J4's lead opens the app to "Working 3" and "5 merged since they last looked", any member answers a TODO's question (§4.1), and with one lane a closed laptop would stop the whole stack. 0011 decision 2 sends a flow remote when it "must happen while every device is off". Its model calls are `ModelStep`s through the metered `agent` seat, as triage's are on the same host (`worker/github/Triage.ts:251-254,441`).
- **Status rides the TODO row,** because the `runs` shape syncs only the launcher's rows (`db/migrations/0013_runs.ts:4-7`).
- **The old app proved the doors:** the draft's Place menu (`apps/app/src/mainview/cards/views/DraftView.tsx:61-70`), the Order menu (`cards/views/HomeView.tsx:26`), the TODO card's controls (`cards/TodoCard.tsx:45-107`), and `todo.new` with the agent rule `confirm` and a Commit form (`flows/entries/todo.ts:39-42`). Its route never served Amend as a placement (`mythical_file_todo.go:443`), so Amend stays its own operation.
- **One lane first.** Restacks, drafts and removals are the hard half. Slice 1 needs none of them, and its first merged TODO still crosses every layer.

## Terminal admission recovery (2026-10-21)

The writer keeps a terminal report's event and successor starts on its originating `todo_attempts` row, atomically
with finishing the TODO and allocating those starts (`0035_todo_report_receipts`). Only the same event under the
same attempt id, TODO, repository and ordinal replays that receipt. Conflicting or unrelated reports stay stale.
The run host propagates admission failures, and Settle and Fail use the engine's unbounded retry policy to admit
the recorded execution ids after a lost acknowledgment or restart. This closes the Postgres-to-host gap without
adding an app retry loop, queue or sweep. `TODO_RUNS` remains off by default.

The terminal event is persisted data with an upgrade contract. `Settle` derives it from the recorded `Await` result;
`Fail` derives it from its recorded typed failure. PostgreSQL `jsonb` equality ignores object-key order. A future
change to those derivations must preserve the event for outstanding attempts, or explicitly migrate their receipts
along with the action contract. The engine's [schema and plan checks](../../../../packages/smithers/flows/flow/docs/concepts/bodies-and-plans.md)
do not inspect silent edits inside an imported action handler. Comparing only terminal state would accept conflicting
merge SHAs or failure codes, so it is not a receipt migration.

Library catalog entries used: `@smthrs/flow` actions and retry policies, `@smthrs/platform-cloudflare` execution
admission, and the existing Effect SQL Postgres layer. The regression tests use real Postgres and ExecutionHost;
only admission failure is injected at its service boundary.

## Consequences

- **SDK work, each with its first consumer here:**
  - `@smthrs/integrations`: `Refs` (create, read), `Commits.createOnBranch`, `Pulls` (open, close, and ready or draft through GraphQL), later `updateRefs`; each reads back and adopts after an unknown outcome. 0012 W1 owns `Pulls`.
  - `@smthrs/platform-cloudflare`: `ExecutionObject.signal`, delivering a `WaitFor` value to a parked execution and arming its alarm. The browser engine has `signal` (`platform-browser/src/BrowserEngine.ts:161`); the Cloudflare host has only `wake` (`platform-cloudflare/src/ExecutionObject.ts:389`).
  - `@smthrs/ui`: §4's components.
- **0007's catalog gains** `repo:todo-commit` (Member; agent never), `repo:todo-drop` (Member; agent never until a confirmation door exists) and `repo:stack-move` (Member; agent run).
- **0012 is a prerequisite of Track B:** the `pulls` projection, `pull_request` events (`worker/github/Api.ts:197` takes issue events only) and the mirror's pull at a SHA (W8). Apply also signals a TODO's run.
- **mvp.md §4.2's "rebase" becomes an update.** The activity reads "Updated with main" or "Updated with T2"; "Rebased onto T2" stays for slice 4's machine rebases.
- **Library catalog entries used:** `@smthrs/flow` (`WaitFor`, `Poll`), `@smthrs/agent` (`AgentAction`, `ModelStep`), `@smthrs/integrations`, `@smthrs/platform-cloudflare`, `@smthrs/effect-code-storage`, `@smthrs/effect-electric`, `@smthrs/effect-tanstack-db` and `@smthrs/ui`. Not `@smthrs/patterns`' merge queue: stack order is the queue.

## 1. Data and state

One migration, numbered at write time (0020 is the latest today).

```sql
stacks        (repo_id text PRIMARY KEY, next_number int NOT NULL DEFAULT 1, version bigint NOT NULL DEFAULT 0,
               lanes int NOT NULL DEFAULT 1 CHECK (lanes BETWEEN 1 AND 8),
               max_open int NOT NULL DEFAULT 50 CHECK (max_open BETWEEN 1 AND 500))         -- not synced
todos         (id uuid PRIMARY KEY, repo_id text NOT NULL, number int NOT NULL CHECK (number >= 1),
               title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
               state text NOT NULL CHECK (state IN ('queued','starting','working','needs_you','in_review',
                                                    'merged','dropped','failed')),
               step text CHECK (step IN ('plan','implement','publish','propose','await')),
               position int,                                          -- NULL once merged or dropped
               revision int NOT NULL DEFAULT 1, attempt int NOT NULL DEFAULT 0,
               branch text, base_sha text, head_sha text, pr_number int, pr_draft boolean, merge_sha text,
               failure text CHECK (failure IN ('plan','implement','empty_change','publish_refused','pr_refused',
                                               'app_not_installed','budget')),
               note text CHECK (note IN ('merged_on_github','closed_on_github','out_of_order')),
               created_by text NOT NULL, created_login text NOT NULL, settled_by text,
               created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, settled_at timestamptz,
               UNIQUE (repo_id, number), UNIQUE (repo_id, position) DEFERRABLE INITIALLY IMMEDIATE,
               CHECK ((state IN ('merged','dropped')) = (position IS NULL)))
todo_requests (todo_id uuid REFERENCES todos, revision int, repo_id text NOT NULL,
               prompt text NOT NULL CHECK (octet_length(prompt) <= 16384), acceptance text[] NOT NULL DEFAULT '{}',
               by_login text NOT NULL, created_at timestamptz NOT NULL, PRIMARY KEY (todo_id, revision))
todo_attempts (id uuid PRIMARY KEY,                                   -- the run's execution id
               todo_id uuid REFERENCES todos, repo_id text NOT NULL, ordinal int NOT NULL, revision int NOT NULL,
               base_sha text, plan text CHECK (octet_length(plan) <= 8192),
               status text NOT NULL CHECK (status IN ('running','published','proposed','settled','failed')),
               created_at timestamptz NOT NULL, settled_at timestamptz, UNIQUE (todo_id, ordinal))
stack_ops     (id uuid PRIMARY KEY, repo_id text NOT NULL, actor_id text NOT NULL,
               via text NOT NULL CHECK (via IN ('person','agent')),
               op text NOT NULL CHECK (op IN ('commit','drop','move','amend')),
               payload_hash text NOT NULL, outcome text NOT NULL, result jsonb, created_at timestamptz NOT NULL)
               -- not synced: the receipt that makes a repeated op id answer the same
```

- **Shapes:** `todos`, `todo_requests` and `todo_attempts` are `REPLICA IDENTITY FULL`, read `where repo_id = $1`, and are authorized like 0013's live workspace (`mayWatch`: Member and above). Prompts and plans are Smithers' content.
- **States** are mvp.md §4.1's. Slice 1 uses Queued, Starting, Working, In review, Merged, Dropped and Failed. Needs you arrives with slice 2's conflicts and slice 3's questions. `step` lights the card's step strip.
- **The device:** persisted `todos:<repo>`, `todoRequests:<repo>` and `todoAttempts:<repo>`; local-only `todoDrafts` (the private draft) and `pendingStackOps` (optimistic rows). The page reads `todos ∪ (pending − todos by op id)`, so a commit made offline shows `T–` and Requested until it is numbered. The open TODO lives in the URL; no `useState`, no `useEffect`.

**What the writer does** (each row is one transaction):

| Op | From | Effect | Slice |
|---|---|---|---|
| `commit`, Append | a person | number `next_number++`, last position, revision 1, Queued; start the next item if a lane is free | 1 |
| `drop` | a person | Dropped, position cleared, gap closed; signal the run; refused when merged or merging | 1 |
| `started`, `step`, `published`, `proposed`, `failed`, `settled` | the run, fenced by todo id and attempt | state, step, branch, SHAs and PR; a stale or dropped attempt is refused | 1 |
| `merged`, `closed` | GitHub, through the run's Settle | Merged or Dropped with its `note`; start the next item | 1 |
| `commit`, Before Tn; `amend` | a person | insert and shift, or add a revision; later items update forward | 2 |
| `move` | a person or the agent | swap with the neighbour; started later items reset and redo | 2 |

**Starting runs.** The transaction that frees a lane marks the next Queued item Starting and inserts its attempt; after commit, the caller starts `FlowExecution(<attempt id>)`, which is idempotent by key. If the caller dies first, the outbox repeats the op and the writer answers the same result, start included, or the settling run's step retries the start.

## 2. Flows

| Flow | Payload | Doors | Placement | Minimum | Agent |
|---|---|---|---|---|---|
| `todo/draft` | `{ repo, prompt, title?, acceptance? }` | `/todo.new <text>`, New TODO, the agent | device: the local draft only | Member | run |
| `todo/commit` | `{ repo, opId, title, prompt, acceptance, place: append }` | Commit on the draft card | device → outbox → stack route → writer | `repo:todo-commit` | never: the draft card is the person's confirmation |
| `todo/drop` | `{ repo, opId, number }` | Drop, `/todo.drop T2` | the same | `repo:todo-drop` | never in slice 1 |
| `todo/open` | `{ repo, number }` | a row, `/todo T2` | device: navigate | Member | run |
| `stack/move` | `{ repo, opId, number, direction }` | Move up, Move down, `/stack.move` | as commit | `repo:stack-move` | run (slice 2) |
| `todo` | `{ todoId, attemptId, revision, baseSha }` | the writer only | Cloudflare `FlowExecution` | system | never (`modelInvocable: false`) |
| `pr/Merge` | 0012's | Merge on the TODO card | 0012's | 0012's merge minimum | confirm |

```
todo (one FlowExecution per attempt; every writer call is fenced by todo id and attempt)
  todo/Plan       RepoReader at base_sha · ModelStep (seat agent) ─▶ plan ≤ 8 KiB ─▶ writer: working, implement
  todo/Implement  AgentAction (seat agent); tools tree and read at base_sha, and write, staging whole files in the step
                  (≤ 50 files, ≤ 1 MiB) ─▶ the change and its digest; nothing staged ─▶ failed empty_change
  todo/Publish    POST /git/refs smithers/t<n>-<slug> at base · createCommitOnBranch(expectedHeadOid = base), as the App
                  unknown outcome: read the ref; adopt it if its head's parent is base and its tree is ours
  todo/Propose    POST /pulls { head, base: main, draft: not next, body ending <!-- smithers:todo=<id> --> }
                  unknown outcome: find the PR by head and marker ─▶ writer: in_review, pr_number
  todo/Await      WaitFor "github": github/Apply on pull_request closed, or the writer on Drop; Poll re-reads every 15 min
  todo/Settle     writer: merged or dropped; a dropped TODO with an open PR closes it as the App with the comment
                  "Dropped in Smithers by @maya"; the branch stays
```

- **Reads happen at the base SHA only.** A `FileAddition` replaces a whole file [GH-git], so a read at another commit would silently revert someone's change. When the mirror lacks the base, Plan waits for `repo/Pull` (0012 decision 8).
- **Commit text** is `T<n>: <title>` and "Smithers for @maya". The pull request's body is the prompt and the plan, plus "Includes T1" from slice 2 while earlier items are unmerged.
- **Model spend** is metered to the person who committed, through the model endpoint's seat accounting.
- **A dropped attempt** has every later writer call refused `dropped`, so the run goes to Settle at its next step. Cancelling a Cloudflare run mid-step waits for 0014's `run/cancel` there.

## 3. The stack on GitHub

| Event | Branches and pull requests | Slice |
|---|---|---|
| Commit, Append | nothing until the item starts; then its branch from its base | 1 |
| Closed on GitHub | Dropped, `closed_on_github` | 1 |
| An earlier item merges | the next PR gets `update-branch` and turns ready; later ones get `POST /merges` from their predecessor | 2 |
| `main` moves, or an earlier item publishes again | the affected PRs update forward the same way | 2 |
| Before Tn; Amend Tn | the new item starts from T(n−1)'s head, or Tn gets new commits; later items merge them in | 2 |
| Drop or Move of a started item | later started items reset to the new base (`updateRefs`, `beforeOid` = their head) and redo; a person's commit on one refuses the reset with Needs you (M-33) | 2; rebase in 4 |
| Merged out of order on GitHub | both Merged; Needs you "T3 merged before T2" until a Maintainer's OK | 2 |

- **Drafts:** GitHub's docs list drafts in private repositories only on Team and Enterprise plans [GH-drafts]. Where GitHub refuses a draft, the pull request opens when its item becomes next. The old service used a title and a `smithers:waiting` label instead (`mythical_items.go:5057-5160`).
- **A conflict on update** puts that item in Needs you. Its PR keeps its head, with "Open on GitHub ↗", until a branch machine resolves it (slice 4).
- **Merge readiness** follows the old `MergeReady` (`mythical_merge_todo.go:453-486`): in review, first in order, no drop pending, and the head the person saw. GitHub's branch protection enforces required checks, and Smithers never bypasses it (0012 §4).

## 4. UI

**Amended 2026-10-20 after Will's review of the walkthrough** ("I would expect this todo interface to look more like the github issues interface"): the stack page is `@smthrs/ui`'s `IssuesView`, as GitHub's issue list, with Open and Closed tabs, a state icon per row and Drop in a row's `⋯` menu; one TODO is `ItemConversation`, as GitHub's issue page, with Drop in its side column. `StackList` and `TodoCard` are deleted. And a TODO can be made from an issue, linked to it, through one flow `todo/issue` (Will: "we should have the ability to create TODOs from issues"); its pull request's "Fixes #n" is Track B's. [todos.md](../features/todos.md) describes both; the sketch below is the original design.

```
┌ octocat/hello · main                                            Code  Stack 3 ┐
│ Stack                                                         [New TODO]      │
│  T4  Retry webhook delivery     ◌ Working · Implement              Drop       │
│  T5  Add rate limit headers     ○ Queued                           Drop       │
│  ✓ T3  Fix README typo          Merged · #41                                  │
├ T4  Retry webhook delivery ────────────────────────────────────────────────── ┤
│ ● Plan  ◌ Implement  ○ Publish  ○ PR  ○ Merge          smithers/t4-retry-…    │
│ prompt (Markdown)                                                             │
│ #42 on GitHub ↗ · +31 −4 · 2 files                         [Merge]  [Drop]    │
└───────────────────────────────────────────────────────────────────────────────┘
 Draft · Only you   Title [            ]  Prompt [                ]   [Commit] [Discard]
```

- **Routes:** `/$owner/$repo/stack` and `/$owner/$repo/stack/$n` (one TODO at full size). `main`'s branch page gains a Stack link beside Code (0013's `BranchHeader`). The draft card shows in the agent's answer and on the stack page.
- **Existing `@smthrs/ui` root exports:** `Card`, `Button`, `Input`, `Textarea`, `Select`, `StatusPill`, `Badge`, `EmptyState`, `Markdown`, `Dialog` (the Drop confirmation) and `ToastStack`.
- **Missing, each added with its consumer and tests:** `StackList` (ordered, keyboard-navigable rows; the Order menu in slice 2), `TodoCard` (header, step strip, prompt, PR row, actions), `TodoDraftCard` (title, prompt, acceptance; Place fixed to Append in slice 1) and `StepStrip` (a flow's steps with the current one lit, also for run pages).
- **Copy:** mvp.md §4.1's state words, "Only you", "Commit", "Drop" and "Merges after T3". A control the person can't use is hidden (0007 §3). Toasts follow the 300 ms rule and settle from the row. Keyboard paths and both themes are acceptance tests (M-48).

## 5. Failure and recovery

| Case | Outcome |
|---|---|
| A repeated op id: same payload; different payload | the same result; `409` |
| Two people commit at once | the row lock orders them; each gets its own number |
| A commit made offline | queued in the outbox as `T–` Requested; one number on reconnect |
| A role lost before the op lands; the stack full (`max_open`) | refused `not_allowed` or `stack_full`; the draft stays, with Edit and Discard |
| A model call fails, or the budget is spent | the engine retries the step, then Failed with its code; the next item starts |
| Nothing staged | Failed `empty_change` |
| The mirror lacks the base SHA | Plan waits for `repo/Pull`; it never reads another commit |
| An unknown outcome on a ref, commit or PR | read back and adopt by tree or marker; never a blind repeat (0012 §3) |
| The branch name exists on GitHub and isn't ours | a `-2` suffix; never written over |
| A missed `pull_request` delivery | Await's 15-minute re-read; 0012's Reconcile |
| Merged or closed on GitHub | Merged (`merged_on_github`) or Dropped (`closed_on_github`), as in Smithers (M-22) |
| Drop during Implement; Drop after merge | Dropped at once, and Settle closes any PR the run opened; refused `merged` |
| The App uninstalled | Publish or Propose fails `app_not_installed` |
| A Worker crash anywhere | the engine resumes the step; writer calls are idempotent by attempt and step |
| A run that never settles | it holds its lane; Inspect (0014) shows the parked step; Drop frees the lane |

## 6. Observability

- **Spans and logs:** `stack.apply` (op, outcome, version), `todo.step` (step, attempt, outcome), `todo.publish` (expected and observed SHAs, adopted), `todo.propose` (PR number, draft, adopted) and `todo.await` (woken by `webhook`, `poll` or `drop`). Each carries the repository id, TODO id, number, op id, attempt id, `durationMs` and trace id.
- **Metrics:** `stack_ops{op,outcome}`, `todo_transitions{from,to}`, `todo_step_ms{step,outcome}`, `todo_publish_unknown`, `todo_time_to_pr_seconds`, `todo_time_to_merge_seconds`, and `todo_await_found_by_poll`, where nonzero means `pull_request` deliveries are being lost.
- **Never recorded:** titles, prompts, plans, file paths or contents, branch names, logins or tokens. A sentinel test proves it against the OTLP export.
- **Joined by ids** from the press through the outbox, the writer, the attempt and GitHub's ids to the Electric txid, so one trace answers "where is my TODO".

## 7. Tests

- **Unit, pure** (`src/features/todos/stack.ts`): property tests over random op sequences (Append and Drop in slice 1; Before, Amend and Move in slice 2). Numbers stay unique and never reused, positions contiguous, settled rows unplaced, only the next item mergeable, and lanes never exceeded.
- **Writer, real Postgres:** concurrent commits from two connections; repeated op ids and `409`; each op refused one role below its minimum and allowed at it; a stale attempt refused; Drop during each step.
- **Run, on the Node host's engine over real Postgres,** with a scripted model and a scripted GitHub on the `fetch` seam (0012 §9): the happy path; a kill after each step resumes with no second branch, commit or PR; a dropped response after GitHub made each one is adopted; an empty change; a mirror behind. Faults come only through injected services.
- **End to end, real browser and real stack,** each recording video and a GIF in `/Users/williamcory/Desktop/smithers-mvp/gifs/`:
  - `todo-commit-drop`: ask Smithers for a TODO, edit the draft, Commit; device B sees T1; both reload; Drop; B sees Dropped.
  - `todo-offline`: commit offline, reload, reconnect; one number.
  - `todo-merge`: on a fixture repository with the App, as `codeplanesmithers`, T1 "add a line to README" opens a branch and PR on GitHub; merging it there turns T1 Merged, and T2 starts.
  - `todo-closed`: closing T2's PR on GitHub turns it Dropped. Each also runs keyboard only, in both themes.

## 8. Build plan

**Slice 1, the walking skeleton: ask Smithers for a TODO, commit it, and see it merge.** Two tracks meet on the stack page; Track A needs nothing unbuilt and ships first.

| Track | Builds | Needs |
|---|---|---|
| A: the stack | the migration; `worker/stack/{Stack,Api}.ts` with Append and Drop; the shapes; `src/features/todos/**`; `/$owner/$repo/stack`; `StackList`, `TodoCard`, `TodoDraftCard`, `StepStrip` | nothing unbuilt |
| B: the run | `worker/flows/Todo.ts`; `Refs`, `Commits.createOnBranch` and `Pulls` open and close; `ExecutionObject.signal`; `pull_request` in the webhook, with Apply signalling the run | 0012 W1, W2 and W8 |

It is done when the four end-to-end tests pass locally and live, with their GIFs and the sentinel.

| Later slice | Builds | Needs |
|---|---|---|
| 2 | two lanes, stacked bases, drafts, forward updates; Before and Amend; Move and Drop of started items by reset and redo; in-app Merge behind the next-item gate; out-of-order merges | slice 1 |
| 3 | Implement binds the branch machine's tools (0005 decision 7); verify runs check flows, published as check runs; steer and answer from any member; stop, resume and retry | feature 7 |
| 4 | the machine rebases instead of redoing; the coding agent resolves conflicts | slice 3 |
| 5 | pre-approval (M-39) and the owner's default; Make TODO and the `todo` label (J2); a repository's own `todo` flow | 0014's code flows |

**Workstreams by file ownership.** One integrator owns `db/migrations/**`, `src/router.tsx`, `src/boot.ts`, `src/flows/registry.ts`, `worker/ChatApi.ts` registrations and `alchemy.run.ts`.

| # | Files | Builds | Needs |
|---|---|---|---|
| T1 | `packages/smithers/agent/integrations/src/github/{Refs,Commits}.ts` | ref create and read, `createCommitOnBranch`, adoption | first |
| T2 | `packages/smithers/flows/platform-cloudflare/src/ExecutionObject.ts` | `signal` | first |
| T3 | `apps/mvp/worker/stack/**` | writer, route, shapes | the migration |
| T4 | `apps/mvp/src/features/todos/**`, `src/screens/stack/**` | state, doors, screens | T3's schema |
| T5 | `packages/smithers/ui/src/{stack-list,todo-card,todo-draft-card,step-strip}/**` | components | nothing |
| T6 | `apps/mvp/worker/flows/Todo*.ts` | the run | T1, T2, T3, 0012 W1 |
| T7 | `apps/mvp/worker/github/{Api,Apply}.ts` (`pull_request`) | shared with 0012 W2; signal the run | T2 |
| T8 | `apps/mvp/e2e/todo-*.spec.ts`, `docs/features/todos.md`, `docs/observability.md` rows | proof and docs | each track |

## Addendum, 2026-10-20 19:45: the factory, simplified

Will, 19:33 (queue, on the VibeLang home mock): "make the coding factory simpler. Bugs require a minimal reproduction. Issues need to be accepted for discussion and able to be marked with what the maintainer believes the timeline and commitment to imlementing it is and also come with a generate poc automatically if an issue is accepted that can be viewed and played with"; 19:33 (chat): "sorry meant to put that into the feedback app for vibelang home page". This addendum replaces §1 to §8 wherever they disagree. It was feedback for VibeLang's home, so it cuts nothing GH-6 asks for (ruling GH-12).

```
issue ─▶ (a bug: minimal repro required) ─▶ triage: accepted for discussion │ not accepted
      ─▶ a Maintainer sets the commitment (timeline) ─▶ accepted: a POC is generated (playable)
      ─▶ a Maintainer makes a TODO ─▶ the todo run ─▶ a PR (checks = Smithers runs) ─▶ a person merges
                                      issue side ▲ │ ▼ TODO side
```

**The TODO side keeps:**

| | Kept |
|---|---|
| States | `queued` ─▶ `working` ─▶ `in_review` ─▶ `merged`; or `dropped` (a person's Drop, or the PR closed on GitHub); or `failed` (with its code) |
| The `todo` run, one per attempt on Cloudflare | `implement`: the branch `smithers/t<n>-<slug>` is reserved at `main`'s head, and the agent (`AgentAction`) writes the change on the attempt's machine, checked out at that base, with the sandbox tools, running the repository's tests there. `publish`: the branch created on GitHub at the base (2026-10-25, ruling GH-11: an attempt that publishes nothing leaves nothing on GitHub), one commit with `createCommitOnBranch`, fenced by the base, then the PR into `main`, its body ending `Fixes #n` when the TODO came from issue `n`; then the checks start. `await`: re-reads the PR until it is merged or closed, and settles |
| Checks | `checks/run`, one Smithers run per check on the PR's head SHA, recorded in `runs` with that SHA: each `.smithers/checks/<name>.sh` run on the branch's machine, and `review`, which reads the diff with the judge role and posts one comment review as the App. Checks never gate: a person reads them and merges. GitHub's own branch protection still applies |
| Merge | a person only: Merge on the PR page (`pr/merge`, squash, head and base rechecked; never the agent, never a run credential) or GitHub's own button |
| Screens | the stack and one TODO (Track A); the PR list and one PR page with Conversation, Commits, Checks and Files |
| Lanes | one TODO at a time per repository, each from `main` |

**Cut, and why:**

- **`plan` as a step, and `todo_attempts.plan`:** the agent plans inside `implement`; a separate plan call bought no decision.
- **`starting` and `needs_you`:** nothing asks a person mid-run in this slice, and a run that can't finish fails with its code. The writer marks a started TODO `working` at once.
- **`propose` as a step:** opening the PR is the end of `publish`.
- **Opening a PR by hand from a branch, the compare page, Update branch, the branches page:** deferred, not cut. GH-6 asks for them (Will, 2026-10-20 06:39: "finishing the entire git e2e flow of being able to create issues open prs or update branch resync etc."), and GH-11 needs an explicit publish for a Smithers-only branch. Will's 19:33 message was feedback for VibeLang's home page (19:33: "sorry meant to put that into the feedback app for vibelang home page"), not a cut of Smithers' git loop. Publish (a pull request from a branch), Update branch and the compare view are built ([branch publish](../features/branch-publish.md)); the branches page waits.
- **GitHub check runs** (§Decision 9): Smithers writes none (0012 decision 12). The Checks tab reads `runs`.
- **`ExecutionObject.signal`:** `await` re-reads GitHub on the engine's retry schedule, at most a minute apart; webhooks only refresh the projection.
- **Slice 2 and later as written:** stacked bases, GitHub draft PRs, forward updates, Move, Before, Amend, out-of-order merges, restacks, machine rebases and pre-approval. Each comes back only when a person needs it.

**Seams with the issue side** (a separate builder owns the repro requirement, "accepted for discussion", the commitment and the POC):

1. **A TODO's issue is `todos.issue_number`** (migration 0027), set once when a person makes the TODO with `todo/issue` and never changed. The TODO side reads nothing else of the issue: not its triage, its commitment or its POC. It writes one thing back: `Fixes #n` in the PR's body, so GitHub closes the issue when the PR merges. Whether an issue may become a TODO (accepted, committed) is `todo/issue`'s check, on the issue side.
2. **A POC hands over by name only.** A POC is its own branch, `smithers/poc-<n>`, made and run by the issue side, and it never merges. `todo/issue` may put the POC branch's name in the TODO's prompt; the TODO's run still starts from `main`, and its agent may read the POC branch from the forge as reference. A POC branch is never a TODO's base.

## Rulings on the two questions

The lead ruled on both on 2026-10-20 instead of putting them to Will; Track A of slice 1 is built on them.

1. **A TODO's run (plan it, write the change, open the PR, wait for the merge) runs on Cloudflare, not in the committer's browser.** 0011 decision 2 already lists "must happen while every device is off" as a reason to run remotely, and a TODO is the team's work: it must keep going with every laptop shut, any member answers it, and with one lane a closed laptop would stop the team's stack. The chat agent stays in the browser. 0005 recorded the coding agent's loop as "the browser", and Sol's design kept it there; this ruling departs from both for the `todo` run only.
2. **Yes: slice 1's agent may write a TODO's change from reading the code, before branch machines run agents.** Every change still reaches `main` only through a pull request a person merges (M-05, M-39), so a change written without running the code can't land unseen. The agent-in-sandbox tools being built now replace this in slice 3, which binds the same Implement step to the branch machine's tools.

## Appendix: Opus, Sol and final compared

Both designs were written independently, then Opus merged them. Adopted claims were checked against the code and docs cited above and GitHub's GraphQL `commits` and `git` references. **Agreed:** TODOs and order are Postgres rows with stable numbers and immutable request revisions; one non-overridable writer per repository; Commit is the person's press and the agent drafts; Append and Drop first, with Before, Amend and Move after safe restacks; PRs target `main`, are squash-merged, and only the first is ready; people merge, and pre-approval is a person's grant; status is team-visible while `runs` stays private; checks are Smithers runs published as check runs.

| Point | Opus | Sol | Final | Why |
|---|---|---|---|---|
| Slice 1 | through a merged PR on GitHub | create, sync and Drop, no run | both, as two tracks; A ships first | Sol's T0 needs nothing unbuilt; a walking skeleton must cross every layer, so B joins it |
| Writer | one transaction on the stack row, via one route and in process | a remote `stack/Write` flow per command with an operation lease; commit before remote work | Opus's transaction, with Sol's rule that no lock spans the network | the write is all Postgres; a flow per command adds a hop and a second queue, and each GitHub call is already a fenced step |
| A `mythical` ref | none | a service-owned ref on GitHub, fenced | none | M-22 keeps order in Smithers, and nothing would read the ref |
| Restack | merge forward (`update-branch`, `POST /merges`) | replay each logical diff onto the squash in a sandbox, then `updateRefs` | forward merges for additions; Sol's `updateRefs` for removals | squash makes them equal on `main`; the common case needs no machine and no force, and M-33 holds |
| Where the run runs | Cloudflare | the browser, Cloudflare for writes | Cloudflare, as ruling 1 | J4, §4.1 and one lane |
| Publish | `createCommitOnBranch` on a created ref | an object upload plus `updateRefs`; names `createCommitOnBranch` | `createCommitOnBranch` | fenced and signed, with no machine [GH-commits] |
| PR closed on GitHub | Dropped | Needs you | Dropped | M-22: "A merge or close on GitHub counts the same"; the old service agrees (`mythical_items.go:5295-5299`) |
| Receipts | `stack_ops`, synchronous | `stack_operations` with stages | `stack_ops` | one transaction leaves no stage to record |
| Stack logic | a pure module in the app | a new SDK package that also adapts `packages/backend` | the pure module | one consumer; the Go backend can't run on Workers; two adapters come before an abstraction |
| Drafts | with a fallback | drafts | drafts; where refused, the PR opens when next | private repositories below Team have no drafts [GH-drafts] |
| Questions | two | none | two | the placement departs from 0005's record, and slice 1's agent can't run code |

## Sources

- [GH-commits] https://docs.github.com/en/graphql/reference/commits (`createCommitOnBranch`, `expectedHeadOid`, signing)
- [GH-git] https://docs.github.com/en/graphql/reference/git (`updateRefs`, `RefUpdate.beforeOid`, `FileChanges`, `FileAddition`)
- [GH-pulls] https://docs.github.com/en/rest/pulls/pulls (create with `draft`, `update-branch` with `expected_head_sha`, merge)
- [GH-refs] https://docs.github.com/en/rest/git/refs
- [GH-branches] https://docs.github.com/en/rest/branches/branches (`POST /merges`)
- [GH-drafts] https://docs.github.com/en/enterprise-server@3.9/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/changing-the-stage-of-a-pull-request; https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests ("Draft pull requests cannot be merged")
- [GH-checks] https://docs.github.com/en/rest/checks/runs


## Issue lifecycle seam (2026-10-20 19:42 brief; proposed in 0018)

[0018](0018-issue-lifecycle.md) owns reproduction gating, acceptance for discussion, Maintainer commitment labels and `poc/<issue>` previews. None starts a TODO run. **Make TODO** reuses the issue-to-draft flow, with source issue and POC branch as context; the person still commits the draft. This factory starts only from that committed TODO. Acceptance and Now/Next/Later/No commitment labels grant no authority to implement, approve or merge. The lifecycle builder owns this addendum; the factory builder can bind its simplified addendum to this seam.

## Dogfood correction — 2026-10-22: failed dependencies

Will's production reproduction (#4430, runs b590330a and a6dc894b) supersedes the earlier failure-table statement that the next item starts after failure. Admission stops at the first failed predecessor. A person's Drop releases an unpublished failed dependency; dropping an In review base or an unmerged PR close fails queued successors `base_closed`. A missing published base branch is also `base_closed`, never permission to begin on main. The existing restack and descendant-close behavior still applies to TODOs already published.

## Dogfood correction — 2026-10-22: merge waits

Will's instruction replaces the simplified factory's minute retry schedule for open PRs. A published TODO parks on the engine's durable deferred; the existing `pull_request` Apply flow re-reads GitHub, then signals the own and stacked-dependent executions through their object hosts. The host records completion before waking. An engine-owned hourly clock is the missed-delivery fallback; neither a timer nor an open PR fails the action. This uses the library catalog's @smthrs/flow durable wait, deferred and clock services, not an application polling loop.

A verified close remains terminal for that TODO attempt if GitHub reopens the PR before the host resumes. The hourly fallback is only a wake to re-read; it never fabricates a close completion.

Hosted webhook wakes persist readiness; only an explicit alarm drive starts idle
work. Registration recovery and signal delivery must not bypass the object's
admission/cancellation check or the engine's drive budget. A drive joining a
stopping recovery drain waits for cleanup and starts a replacement without
inheriting the old drain's interruption. Cancellation is settled from its durable
request before any further action, including when that drive's budget is spent.

### Closed bases during implementation (2026-10-22, #4432)

Dropping an In review TODO or projecting its unmerged PR close starts the same
independent durable cleanup. Its first action records a transitive descendant
snapshot; its next action requests every execution's engine cancellation and
reports `base_closed` through the stack writer. A separate action closes recorded
PRs after settlement. Refused closes are logged and counted; transient failures
retry without holding execution lanes or delaying another cancellation. Retries
retain that snapshot, and attempt fencing protects replacement attempts. There
is no application polling or cancellation sweep. Queued successors hold with
`base_closed`. Begin, collection, publication and the writer's step boundary
also check closed ancestry, covering a branch assignment racing cleanup.
Retry clears the failed attempt's base and selects the nearest open ancestor,
else main. Cancellation uses the same engine path as dropping a TODO; the
execution object retains its cancellation tombstone against delayed admission.

Library catalog entries: `@smthrs/flow` (durable workflow and cancellation),
`@smthrs/integrations` (GitHub). Core stack enforcement is infrastructure shared
by every plugin that starts a TODO; it is not a plugin-specific feature.

Migration 0045 preserves each attempt's base ref with its branch and PR number.
Discovery traverses those historical edges as well as current TODOs, so Retry
of an intermediate TODO cannot hide a still-running grandchild from a delayed
close delivery. The migration backfills current attempts; it does not invent
base refs for historical attempts that predate this field.

Migration 0045 also stores `todos.base_reset`: an explicit Retry keeps its new
base choice while waiting for a lane. Admission clears it. Dropping or settling
the old predecessor does not fail that queued Retry again. Projected unmerged
closures block ordinary admission synchronously under the stack lock, before
invalidation's asynchronous launch. The new `todo/InvalidateBase` flow leaves
existing `todo/Drop` declarations and persisted single-close plans unchanged.


A close delivery for an already failed predecessor preserves ordinary queued
successors for that predecessor's Retry. An explicit Retry of a descendant may
skip ancestors failed `base_closed` by the same closure, choosing an open base;
unrelated failures continue to hold ordinary admission. The terminal event's
failure classification reaches the rules before lane admission in that same
transaction, including when a queued Retry is waiting for cleanup to free it.

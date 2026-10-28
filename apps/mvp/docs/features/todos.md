# TODOs and the stack

A person asks Smithers for a TODO, or makes one from an issue, edits the draft and commits it to the repository's stack; every Member sees it numbered on every device, and a person drops it. The stack looks like GitHub's issue list, and one TODO like GitHub's issue page. This is decision [0016](../decisions/0016-todos-and-the-stack.md)'s slice 1, Track A, and Track B's durable `todo` run ([the run](#the-run)), which takes a TODO to a pull request a person merges. The run is on wherever the GitHub App is configured; `TODO_RUNS=false` switches it off, and every TODO then stays Queued.

## How it works

```
the device                                      ChatApi (Cloudflare)
"make a TODO …" ─▶ the agent ─▶ todo/draft
  step ─▶ the tab that asked keeps a private draft (todo-drafts), shown under the answer
Commit on the draft card, or on the stack page
  FlowDispatch ─▶ todo/commit (client flow, never the agent's)
    step: op id = UUIDv5(execution id) ─▶ the tab that asked ─▶ the device's one outbox (todo-op)
  outbox ─ POST /api/repos/<o>/<n>/stack ─▶ sign-in, Member, bounds; who acts from the session
            202 { txid, opId, outcome, number } ◀── worker/stack/Stack.ts: one transaction,
  todo-requested: "T–  Requested"                     stacks row FOR UPDATE, no network or model call
todos, todo_requests ◀── Electric ◀── Postgres ◀──┘
Drop ─▶ todo/drop ─▶ the same outbox and route
```

- **One writer.** `worker/stack/Stack.ts` `apply` is the only code that writes `stacks`, `todos`, `todo_requests`, `todo_attempts` and `stack_ops`. Each change is one transaction that locks the repository's `stacks` row first, applies the stack's rules (`src/features/todos/stack.ts`), writes back what changed in one statement, and keeps a receipt under the op id. Writers racing on the same repository queue on the lock, so none loses another's change.
- **The rules are one pure function.** `stack.ts` `apply(stack, op)`: a commit takes the next number, which is never reused, and the last position; a drop clears the TODO's position and closes the gap; a full stack (`max_open`) refuses a commit; a merged TODO refuses a drop; dropping a dropped TODO changes nothing. Property tests prove them over random histories.
- **A person commits; the agent drafts** (0016 §3). `todo/draft` is the agent's; `todo/commit` and `todo/drop` are a person's only. The agent's catalog lists neither, the step refuses a run that is the agent's call before it asks any tab, and the route takes who acts from the session (`Actor.act`), never from the request: a body that claims a door claims nothing.
- **One route.** Buttons, slash commands, the agent's drafts once a person commits them, and the API all change a stack through `POST /api/repos/<owner>/<name>/stack`.
- **The run starts from the writer.** The writer starts an attempt only when the host provides `TodoRuns` (`worker/stack/Stack.ts`): `start(attempt)` and `stop(attempt)`, idempotent by attempt id. ChatApi provides it when the GitHub App is configured and `TODO_RUNS` isn't `false`: each attempt runs `todo` on its own Durable Object, `todo:<attempt id>`. Without it the writer works with no lanes and every TODO stays Queued.
- **Libraries** (`docs/libraries.md`): `@smthrs/flow` (the flows), `@smthrs/effect-electric` (`ShapeProxy` with its default `no-store`, `ElectricCollection`), `@smthrs/effect-tanstack-db` (`Outbox`, collections, live queries, `Persistence`), `@smthrs/crypto` (`Uuid.v5`, `digestSync`), `@smthrs/ui` (`IssuesView`, `ItemConversation`, `ItemAsideSection`, `ItemStatus.live`, `ConfirmButton`, `TodoDraftCard`, `Breadcrumbs`), `@smthrs/engine-store` (`RunInspection`, watching the run), and Effect's own `Arbitrary` for the property tests.

## Who reads, who writes

| Act | Who |
|---|---|
| Read a repository's TODOs and prompts | a signed-in Member or above (like a branch's live workspace, 0013); signed out `401`, a Guest `403` |
| Draft a TODO | the agent, for a Member who asked; a Member with New TODO or `/todo.new`. A draft lives on that person's device only |
| Commit, Drop | a Member or above, in person (`repo:todo-commit`, `repo:todo-drop`); never the agent |
| Retry own TODO | Member or above, in person or through the agent |
| Retry anyone’s TODO | Maintainer or above, in person or through the agent |

Every role here is the person's on the repository the route names ([decision 0079](../decisions/0079-roles-per-repository.md)), and so are the buttons: New TODO, Make TODO, Drop and Retry show by the role ChatApi answers for the repository (`GET /api/repos/<owner>/<name>/role`), none before it answers: on the deployment's own (`GITHUB_REPOSITORY`), the session's; on any other the App is installed on, their GitHub permission there, read with the App and kept 5 minutes (`worker/github/RepoRoles.ts`). A change applies only while that role still holds, in the stack's own transaction. Local development without the App keeps the developer's role everywhere.

## Routes

`worker/stack/Api.ts`; ChatApi routes these paths to it before RepoApi (`StackApi.handles`).

| Route | Answers |
|---|---|
| `POST /api/repos/<owner>/<name>/stack` | `202 { txid, opId, outcome, number }` for a new change, `200 { txid: null, … }` for a repeated op id. Refusals below |
| `GET /api/repos/<owner>/<name>/stack/<number>` | current status, step, failure, branch, PR and Cloud run ID for a Member there; `404 { code: "todo_not_found" }` only after authorization; never cached |
| `GET /api/shapes/todos?repo=<owner>/<name>` | the repository's `todos`, `TODO_COLUMNS`; never cached |
| `GET /api/shapes/todo-requests?repo=<owner>/<name>` | their `todo_requests`, `TODO_REQUEST_COLUMNS`; never cached |

The stack route's body is `{ opId, op: "commit", title, prompt, acceptance?, issue? }` or `{ opId, op: "drop", number }`: a UUID op id (a commit's is its TODO's id), a title of 1 to 120 characters not blank, a prompt not blank of at most 16,384 bytes, at most 20 criteria of 1 to 300 characters, the number of the issue it was made from, and a number of 1 to 2,147,483,647. Its refusals are `{ code }`, `Cache-Control: no-store`:

| Status | `code` | When |
|---|---|---|
| 400 | `invalid` | not that body |
| 401 | `authentication` | signed out |
| 403 | `forbidden` | not a Member on that repository, an agent, flow or sandbox acting for the person, or a role that changed between the read and the change |
| 404 | `not_found` | a drop of a number the stack never had, or a repository `GITHUB_ALLOWED_REPOSITORIES` leaves out |
| 404 | `app_not_installed` | another repository the App isn't installed on |
| 409 | `conflict` | the op id was used for another change |
| 409 | `stack_full` | `max_open` TODOs are open |
| 409 | `merged` | a drop of a merged TODO |
| 413 | `too_large` | a body over `MAX_STACK_BODY_BYTES` |
| 429 | `rate_limited` | GitHub rate limited the role's read; `Retry-After` is its wait, and the device sends again |
| 503 | `not_configured` | another repository, on a deployment without the App |
| 503 | `github_unavailable` | GitHub didn't answer the role's read; the device sends again |
| 503 | `unavailable` | Postgres, sessions or the run host couldn't answer; the device sends again |

A shape request whose `repo` names no repository reads no repository's rows; on another repository, a role the deployment can't read there is `403`, and GitHub not answering `503`; sessions that can't be read are `503` with `Retry-After: 5`, so a device keeps its rows.

## Flows

| Flow | Payload | Doors | Agent |
|---|---|---|---|
| `todo/draft` | `{ repo, prompt, title?, acceptance? }` | the agent; `/todo.new owner/repo <prompt>` (Member) | yes: it answers `{ draftId, status: "drafted", path }` |
| `todo/issue` | `{ repo, issue, title?, prompt?, acceptance? }` | Make TODO in an issue's menu or on its page, and its key `t`; `/todo.issue owner/repo <n>` (Member) | yes: with a better title and prompt than the issue's, if it has them |
| `todo/inspect` | `{ repo, number }` | the agent reads a TODO's current shared state | yes: found or authorized not found; access and network errors remain errors |
| `todo/commit` | `{ repo, title, prompt, acceptance?, issue? }` | Commit on a draft card | never |
| `todo/drop` | `{ repo, number }` | Drop on a row or the TODO's card; `/todo.drop owner/repo <n>` (Member) | never |
| `todo/Retry` | `{ repo, number }` | Retry on a failed TODO or its run | yes, with the same ownership and role checks |

Drafts and changes are steps (`src/features/todos/steps.ts`) that ask, over the engine's todos channel, the tab that started the request (`TabTodos`, `src/flows/askingTab.ts`) to keep the draft or queue the change. `todo/inspect` is a durable read step through ChatApi, scoped to the run's credential and the repository's Member policy ([decision 0093](../decisions/0093-agent-reads-shared-todo-status.md)). It returns no title, prompt or person fields. Only an authorized missing TODO returns `todo_not_found`; repository access failures remain errors. The status read has one 10-second deadline and does not retry inside the step, so an unavailable answer can return promptly without claiming the TODO is absent. The device's `run/list` cannot establish a Cloud TODO's status. `todo/issue` fails `issue_not_found` when the device doesn't have the issue. The draft's and the change's ids are UUIDv5s of the execution id, so a step run again names the same draft or change, and the tab keeps it once. A draft without a title takes the prompt's first line.

## The browser

`src/features/todos/`, framework-free logic beside React views ([state.md](../state.md#todos-2026-10-20)).

| Piece | What it is |
|---|---|
| `stack.ts` | the stack's rules, pure; the writer applies them |
| `writes.ts` | `todo-sending` (the outbox's optimistic rows) and `todo-requested` (kept on the device: taken with the stack's number, or refused with why); the outbox's `todo-op` mutation posts to the stack route and never waits for Electric |
| `store.ts` | per repository, Electric collections `todos:<repo id>` and `todo-requests:<repo id>`, kept on the device and opened by the route; `todo-drafts`, kept on the device; `todo-view`, `todo-access`; followers that drop a requested change once Electric shows what it did, and read the shape's refusal |
| `view.ts` | the stack's rows (`todos ∪ (pending commits − todos by op id)`, a pending drop on its TODO), the TODO at full size, the drafts, Not sent changes, access and who may change a stack |
| `actions.ts`, `todos.ts` | `open` (the routes), `warm` (a link's hover: opens the stack's sync), New TODO, a draft's text, Commit, Discard, Drop, and Edit and Discard on a change Not sent |
| `components/` | `DraftCard` (`TodoDraftCard`, with its issue `#12` when it has one), `AnswerDrafts` (the drafts under the answer that made them) |

Screens (`src/screens/stack/`), and a Stack link beside Issues in the repository's header:

```
octocat/Spoon-Knife / Stack                      octocat/Spoon-Knife / Stack / T4
┌ ◯ 2 Open  ✓ 1 Closed           [New TODO] ┐    Retry webhook delivery T4
│ ◔ Retry webhook delivery               ⋯  │    (◯ Queued) ann · 2m ago
│   T4 · ann · 2m ago · #12 · smithers/t4…  │    ┌ prompt, then its acceptance criteria ┐   Issue  #12
│ ◯ Add rate limit headers               ⋯  │    ◯ ann committed · 2m ago                  Branch smithers/t4-…
│   T5 · ben · 1m ago                       │                                              [Drop]
└───────────────────────────────────────────┘
```

- **`/$owner/$repo/stack`** is `IssuesView`, as GitHub's issue list. Open (the stack in merge order, then this device's commits the stack hasn't numbered) and Closed (merged and dropped, latest first) are tabs with counts, `?state=closed` in the URL. Each row has its state icon (Requested, Queued, Working, In review, Merged, Dropped, Failed; Working's blinks), its title, `T<n>`, who committed it and when, its issue, branch and pull request, Watch while it runs ([watching the run](#watching-the-run)), and Drop in its `⋯` menu, which asks `Drop T4?` first. ArrowUp and ArrowDown move between rows. This device's drafts show above the list, and its changes that weren't sent below, with Edit and Discard.
- **`/$owner/$repo/stack/$number`** is `ItemConversation`, as GitHub's issue page: the title and `T<n>`, the state pill, who committed it and when, the prompt and its acceptance criteria, a timeline (committed, then the state it is in, with the reason if it failed), and a side column with its issue, branch and pull request, its Run while it works or after failure, and Drop.
- A reserved branch name links to Code Storage only after Publish has opened its PR. Before that, the branch exists nowhere and an app link would lead to Not found.
- The page's frame (breadcrumbs, tabs, New TODO) paints at once. Until the device restored or synced the stack, the list shows no rows and no counts: never the empty state, and never a loading state. Commit on a draft opens its stack, where it shows `T–` and Requested until the stack numbers it. A commit the stack refused shows Not sent with why, Edit (back to a draft) and Discard.

## From an issue

Make TODO drafts a TODO from an issue, linked to it (Will, 2026-10-20). Everything that makes one runs `todo/issue`: Make TODO in an open issue's `⋯` menu on `/$owner/$repo/issues`, Make TODO on the issue's page with its key `t` (`aria-keyshortcuts`, `src/features/keys/keys.ts`), `/todo.issue owner/repo <n>`, and the agent.

- The step asks the tab that started it to keep the draft. A title or prompt the call left out is the issue's title, or its body (its title when the body is blank), cut to a TODO's limits (`draftFromIssue`); the agent may pass better ones. The press opens the stack, where the draft shows with its issue `#12`.
- The person commits it like any TODO. The commit carries `issue`, and the writer stores it in `todos.issue_number` (migration `0027_todo_issue`), set once.
- The TODO shows its issue, on its row and its page. The issue shows its TODOs, newest first, on its row and in its page's side column, and offers Make TODO while it is open, however many of its TODOs are open, so one issue becomes a stack of TODOs (`todosByIssue`, `mayMakeTodo`; Will, 2026-10-21). The issue routes open the repository's stack for this.
- Its pull request's body ends "Fixes #n" from `issue_number`, so GitHub closes the issue when a person merges it ([the run](#the-run)).

## The run

`todo` (`worker/flows/Todo.ts`, decision 0016's factory simplified): one durable run per attempt, on the `FlowExecution` Durable Object.

```
todo/Begin      the TODO and its prompt; its base, the head of the TODO in review before it (stacked), else of the
                default branch; its branch's name smithers/t<n>-<slug>-<key> reserved; nothing written to GitHub
                ─▶ writer: branch and its base, step implement
todo/Implement  the agent (AgentAction, the `coding` role) writes the change on the attempt's machine, checked out at the
                base, with the sandbox tools (worker/flows/TodoAgent.ts), and checks only the packages it changed, with
                their own scripts
todo/Collect    the files it changed, read whole from the machine (50 files, 1 MiB at most); none ─▶ failed empty_change
todo/Publish    the branch made on GitHub at the base, as the App, under the reserved name; one commit,
                createCommitOnBranch fenced by the base ("T<n>: <title>", "Smithers for @maya"); the pull request into
                its base (a draft while that is another TODO's branch), its body the prompt, "Fixes #n" for a TODO from
                an issue, and whom the App acted for ─▶ writer: in review, which frees the lane for the next TODO; the
                head's checks start (checks/Run, docs/features/pulls.md)
todo/Await      parks on a durable PR-close event; GitHub Apply signals it after a merge or close; an hourly engine clock covers missed webhooks; a TODO dropped
                in Smithers meanwhile closes the pull request its run opened. Stacked: see below
todo/Settle     writer: merged releases the next Queued TODO; an unmerged close fails queued successors base_closed
todo/Fail       any step that gave up ─▶ writer: failed with its code (implement, empty_change, publish_refused,
                pr_refused, app_not_installed, base_closed); queued successors hold behind the failed TODO
```

- **Nothing on GitHub before Publish.** `todo/Begin` reserves the branch name and its base; `todo/Publish` creates the branch on GitHub with its one commit, so an attempt that publishes nothing leaves nothing on GitHub (GH-11).
- **States** (decision 0016's factory simplified): Queued, Working, In review, Merged, Dropped, Failed. Steps: implement, publish, await. Only Working holds one of the stack's lanes (`stacks.lanes`, 1): a TODO in review frees it, so the next one starts.
- **Published reports keep their receipt.** The first `published` report stores the attempts it started (`todo_attempts.published_report`), so a retried `todo/Publish`, or a new head after a restack, starts the same ones and never another. A drop copies those starts into its own receipt under the stack lock before cancelling the old run, so the durable drop request owns their admission even when publish stopped after its report committed.
- **Drop cancels durably.** The route cancels the old execution before admitting successors. The object persists a tombstone, interrupts active work through the engine, and wakes parked work to settle cancelled and release ownership. First admission rechecks the current attempt and TODO state; a dropped TODO creates no engine run. The independent `todo/Drop` flow closes the PR recorded for that dropped attempt, with engine-owned retries and stable id `todo-drop:<attempt id>`. A PR created externally before its publish report committed is not inferred by branch.
- **Every writer call is fenced** by the TODO and the attempt (`Stack.report`): a dropped TODO's run, or an earlier attempt's, is stale and stops.
- **Terminal reports keep their receipt.** The attempt stores the exact terminal event and successor attempt ids in the same Postgres transaction as the lane change. Replaying that event returns `repeated` with those same starts; another event or attempt stays stale. `todo/Settle` and `todo/Fail` retry admission through the durable engine without expiring. The host propagates a refused or lost admission acknowledgment, including when the successor already accepted its intent, so a restart can admit that same execution again. No retry allocates another successor.
- **Every GitHub write adopts its own earlier attempt** after a lost answer, by its key alone: the branch by the key its name ends with (`branchKeyOf`, from the attempt, so Begin and Publish name the same branch), the commit by its `Smithers-Write` trailer, the pull request by its marker. A branch the key finds under a name Begin didn't reserve fails `publish_refused`. Nothing here approves, forces a ref or merges a pull request: a person merges ([pull requests](pulls.md#merge)). The one merge a run makes is the TODO below's merge commit into its own branch, when it restacks.
- **How the agent checks its change** (`TodoAgent.SYSTEM`): it reads what the TODO names, makes the change, then runs the lint and typecheck scripts of each package it changed, each command on its own (and, for a change to what code does, the tests that cover it), and fixes what they find, in as few commands as it can (a command takes one to two minutes in production; it reads the working copy with `sandbox/status` and `sandbox/diff`). It never installs dependencies, checks the whole repository or writes a script or log to run checks: the branch machine has no internet, so an install hangs until its command times out, and Smithers commits every file left in the working copy. A check whose tools aren't installed can't run there; the agent says so and publishes, and the pull request's checks (each `.smithers/checks/` script, on a job machine that installs) run the full checks ([where checks run](pulls.md#where-checks-run)). Each turn tells it the time it has left of `IMPLEMENT_TIMEOUT` (40 minutes, `Steering.withTimeLeft` in `@smthrs/harness`), and a run that runs out of time publishes nothing. On 2026-10-22 the dogfood loop's T3 (`todo:7844cd5e`), a two-line lint fix, timed out without publishing: its lint found no `eslint`, and it spent the rest of its 40 minutes writing its own check script and installing the monorepo, which hung. `evals/todo-lint.eval.ts` holds the agent to the narrow path ([agent evals](agent-evals.md#todo-lint)).
- **The machine** is the attempt's own branch machine, `todo-<attempt id>`, checking out the attempt's base commit alone and detached from GitHub (`todo_attempts.base_sha`; the branch doesn't exist yet), its tools running as the person who committed the TODO (`worker/flows/TodoMachine.ts`).
- **The agent's sandbox on Cloudflare** (`worker/AgentSandbox.ts`): `Agent.layerDefaultsWithVariant` over QuickJS's separate-`.wasm` build. workerd compiles no WebAssembly from bytes, so the single-file build `Agent.layerDefaults` uses fails there ("Wasm code generation disallowed by embedder"). The `.wasm` file arrives as `#quickjs.wasm`, a package.json `imports` name ending in `.wasm`, which Alchemy's bundler uploads as a CompiledWasm module and hands the Worker as a `WebAssembly.Module`. The import is dynamic, inside the layer: `alchemy dev` imports the stack in Node, where a static `.wasm` import fails ("Cannot find package 'a'").

### Stacked pull requests

Will, 2026-10-21: "produce a stacked diff". The stack's TODOs become stacked pull requests: each TODO's branch starts on the branch of the TODO in review before it, and merges forward, never by a rebase, as each one below merges (decision 0016 §Decision 6, slice 2).

```
main ── T1 smithers/t1-… ── T2 smithers/t2-… ── T3 …       T1 In review: the lane frees, T2 starts on T1's head
         PR #1 → main         PR #2 → t1 (draft)            T2 In review: T3 starts on T2's head, PR #3 → t2 (draft)
a person squash-merges #1 ─▶ T1 Merged; T2's await:
  POST /merges  T1's merge commit into smithers/t2-…  "Merge T1 from main into T2"  ─▶ writer: T2's new head
  checks/Run    on the new head, its review reading from T1's merge: T2's change alone
  PATCH base: main, then markPullRequestReadyForReview  ─▶ #2 is into main, ready, and shows only T2
```

- **The base.** `todo/Begin` takes the nearest TODO before it in the stack that is In review, at its branch's head on GitHub; with none, the default branch; with its branch gone, it fails `base_closed`. The TODO keeps it as `todos.base_ref` (migration `0039_stacked_todos`) and its head as `base_sha`; `todo/Publish` makes the branch there, and its pull request is into it.
- **Draft while stacked.** A pull request into another TODO's branch opens as a draft, so nobody merges it there; GitHub and the Merge route refuse a draft. It is marked ready when it moves onto the default branch.
- **The TODO below merged.** The waiting run merges that TODO's merge commit into its own branch (`GitHub.Commits.mergeInto`, 204 when it holds it already), reports the new head, starts its checks, moves the pull request onto the default branch and only then marks it ready, so it is never a ready pull request into the old branch. A step cut short does it all again, each part a no-op once done; one stopped between the move and the mark is marked ready by the next await. Under squash merge the TODO below's changes appear on both sides and merge once. A merge GitHub can't make (a conflict) closes the pull request as the App and fails `pr_refused`.
- **The TODO below won't merge** (dropped in Smithers, closed on GitHub, or failed, `base_closed` included, so the failure climbs the stack): this branch holds a change that won't merge, so the run closes its pull request as the App and fails `base_closed`. It checks this before reading its own pull request's state, so a close whose answer was lost still ends `base_closed`, never as closed on GitHub.
- **One issue, many TODOs.** A pull request with an open TODO above it from the same issue says `Part of #n`; the top one says `Fixes #n`, so merging the bottom of the stack doesn't close the issue the rest still work on.
- **A run from before stacking** carries no `baseRef` and no `begun` at its await: its base is the default branch, and it never restacks.
- **Order.** People merge from the bottom: only the lowest pull request is ready and into the default branch.

### Watching the run

A TODO starts the work through to a mergeable pull request; while it runs, it shows that it is working and links to its run, so a person can watch the agent (ruling TODO-3, decision [0026](../decisions/0026-watching-a-todo-run.md)).

```
◔ Retry webhook delivery                ⋯        Retry webhook delivery T4
  T4 · ann · 2m ago · smithers/t4-… · Watch      (◔ Working) ann · 2m ago        Run    Watch
```

- **The indicator.** A Working TODO's icon blinks slowly, one calm 2-second cycle, on its row and in its page's state pill (`ItemStatus.live`, `@smthrs/ui`). It holds steady for a person who prefers reduced motion. In review stays steady: the run waits on a person's merge, not on work.
- **The link.** A Working or In review TODO links to its run with Watch; a Failed TODO links with Open. The link appears at the end of its row and in a Run section on its page. It opens `/app/runs/todo:<attempt id>` from Cloudflare ([a run on Cloudflare](runs.md#a-run-on-cloudflare)). A failed TODO also shows its safe failure reason in the timeline. Queued, Merged and Dropped TODOs link to none.
- **How the link knows the run.** The writer records each attempt's run on its TODO, `todos.run_id` = `todo:<attempt id>`, in the transaction that records the attempt (migration `0036_todo_run`). It syncs with the rest of the row, to Members, as everything of a TODO does; `todo_attempts` still never syncs. A run started before the column existed got it from its attempt.
- **Who watches.** A Member or above, as the TODO itself: the run's routes refuse anyone else, and a run no TODO started.
- **Steering.** While its agent works, a Member steers it from the run's page: the message reaches the agent at its next turn, and the page shows it Sent, then Delivered, with the agent's next step ([steering](runs.md#steering)).

| Test | Proves |
|---|---|
| `worker/flows/Todo.test.ts` | on the Node host's engine with the scripted GitHub, a test machine and a scripted agent: a TODO from an issue to a squash-merged pull request with "Fixes #n" and the next TODO started when it published; GitHub holding no branch while the agent works, and the machine at the base commit; closed on GitHub; an empty change and an agent that never answers, each leaving no branch on GitHub; no App; dropped before and while waiting; a name taken; a lost branch, commit and pull request adopted by key; a branch the key finds under another name refused; each step's refusals and retries. Stacked: T2 on T1's branch, its pull request a draft into it and its review reading its change alone; T1 merged, T2 merges it in, its new head's checks start, it moves onto main, ready, and merges; a restack cut short by a lost merge and a failed retarget done once, and one stopped before the mark finished; T1 closed fails T2 `base_closed` and closes its pull request, a lost close included; a failed T2 fails T3 above it; a conflict closes the pull request and fails `pr_refused`; one a person took out of draft isn't marked again; one closed on GitHub drops; `Part of #n` below, `Fixes #n` on top; a dropped run's publish starts replayed; a run from before stacking just waits; the branch below gone, T2 refuses base_closed |
| `worker/flows/TodoHost.test.ts` | the Durable Object's handlers with `withTodos`: `checks/Run` driven to the end |
| `worker/flows/TodoRecovery.test.ts` | merged reports recover successor admission after failure and host restart; dropped and failed reports preserve dependent holds after restart; report committed before launch; target accepted before acknowledgment lost; repeated execution stays singular |
| `worker/AgentSandbox.workerd.test.ts` | in local workerd, bundled with Alchemy's own bundler and Cloudflare plugins as ChatApi is: the bundle carries QuickJS as one compiled WebAssembly module, and an agent's cell lists, reads and writes the checkout through the run's sandbox tools as the TODO's committer. Fails on `Agent.layerDefaults` with workerd's refusal |
| `e2e/factory.spec.ts` | live: against an instance with the GitHub App on a scratch repository the test account administers (`E2E_FACTORY_REPOSITORY`, `E2E_SESSION_COOKIE`, `BASE_URL`; it skips without them), a person asks Smithers for a TODO and commits it; the agent writes the change on the attempt's machine with the deployment's model, the run publishes its branch on GitHub, and the TODO reaches In review with an open, mergeable pull request on its `smithers/t<n>-` branch. On the way: the Working TODO blinks, Watch opens its run read from Cloudflare (`Cloud`, `todo/Implement`), and the pull request's page shows Squash and merge with `Merging into main deploys it.`, its checks and the README line in Files. It never merges. Over HTTPS (`https://localhost:1445` for a live dev instance): over plain HTTP/1.1 the browser's six connections fill with Electric's long polls |
| `worker/stack/Stack.test.ts` | the writer's reports: step, branch and its base, published (the next TODO started, its receipt replayed, a new head taken), finished; stale reports; each attempt's run recorded on its TODO |
| `src/features/todos/view.test.ts` | a Working TODO's icon live; Watch on Working and In review, Open on Failed, and the Failed timeline's reason; no link for Queued, Merged or Dropped |
| `src/features/runs/remote.test.ts`, `worker/RemoteRuns.test.ts` | watching a TODO's run ([a run on Cloudflare](runs.md#a-run-on-cloudflare)), and steering its agent ([steering](runs.md#steering)) |
| `evals/todo-lint.eval.ts`, `evals/todoLint.test.ts` | live (`pnpm eval`): with the real model, a two-line lint fix in one package of a pnpm repository on a real box with no registry publishes within 10 minutes, as production would time it, running no install, declared check script or check of every package, and writing nothing but the fix ([agent evals](agent-evals.md#todo-lint)) |
| `worker/flows/Todo.test.ts` "steer" | a person's message admitted while the agent's first turn is in flight reaches its second turn, once, and is in the merged change |
| `src/features/todos/stack.test.ts` | the rules' `publish` and `finish`: publishing frees the lane and starts the next, again changes nothing, a stale one is refused; merged and dropped leave the stack, failed keeps its place, a dropped TODO in review stops its run; random histories with publishes keep every rule |

## Postgres

Migrations `0022_todos`, `0027_todo_issue`, `0035_todo_report_receipts`, `0036_todo_run` and `0039_stacked_todos`. Synced tables are `REPLICA IDENTITY FULL`.

| Table | | |
|---|---|---|
| `stacks` | `repo_id`, `next_number`, `version`, `lanes` (1), `max_open` (50), `updated_at` | never synced; the row the writer locks |
| `todos` | `id`, `repo_id`, `number`, `title`, `state`, `step`, `position`, `revision`, `attempt`, `branch`, SHAs, `pr_number`, `pr_draft`, `failure`, `note`, `created_by`, `created_login`, `settled_by`, times, `issue_number` (`0027_todo_issue`), `run_id` (`0036_todo_run`: its latest attempt's run, `todo:<attempt id>`), `base_ref` (`0039_stacked_todos`: the branch its branch was made from, never synced) | `(repo_id, number)` unique; `(repo_id, position)` unique at each statement's end; settled exactly when merged or dropped, and then unplaced |
| `todo_requests` | `todo_id`, `revision`, `repo_id`, `prompt`, `acceptance`, `by_login`, `created_at` | each revision of a prompt, never changed |
| `todo_attempts` | `id` (the run's id), `todo_id`, `ordinal`, `revision`, `base_sha`, `status` (`running`, `published`, `settled`, `failed`), `published_report` (the starts its first publish made, `0039_stacked_todos`), `finished_report` (terminal event and starts) | the run's; written only when a host runs TODOs; receipts never synced |
| `stack_ops` | `id` (the op id), `repo_id`, `actor_id`, `via` (from the session), `op`, `payload_hash`, `outcome`, `result` | never synced: the receipt a repeated op answers from |

## Observability

No record carries a title, a prompt, a criterion or a login ([observability.md](../observability.md#todos)).

| Record | Kind | Fields |
|---|---|---|
| `stack.request` | log, span | `op`, `via`, `opId`, `outcome` (the change's outcome, `repeated`, or the refusal's code), `number`, `status`, `bytes`, `durationMs`, `errorCode` |
| `stack.apply` | log, span | `repoId`, `opId`, `op`, `via`, `outcome`, `number`, `version`, `durationMs` |
| `stack.report`; `smithers_todo_reports{kind,outcome}` | log, span, counter | attempt and TODO ids, kind, `applied` / `repeated` / `stale`, successor count; a repeated report counts no state transition |
| `todo.start`; `smithers_todo_admissions{flow,outcome}` | log, span, counter | flow, execution id, `started` / `not_started`, error code; records admission acknowledgment, not execution completion |
| `todo.restack` | log | attempt and TODO ids, the TODO below's number, the pull request's number: a stacked TODO took in the one below it and moved onto the default branch |
| `stack.shape.todos`, `stack.shape.todo_requests` | log, span | Electric's request records |
| `stack.status`; `smithers_todo_status_reads{outcome}` | log, span, counter | HTTP status, duration and distinct `todo_not_found` or repository refusal outcomes; no TODO content or person field |
| `smithers_stack_requests{op,outcome}`, `smithers_stack_ops{op,outcome}`, `smithers_todo_transitions{from,to}`, `smithers_todo_shape_requests`, `smithers_todo_request_shape_requests` | counters | |
| `todos.draft`, `todos.queue`, `todos.send`, `todos.pending`; `smithers_todo_drafts`, `smithers_todo_queued`, `smithers_todo_sends`, `smithers_todo_pending_actions` | browser logs, spans, counters | `op`, `door`, `via`, `outcome` (a draft's `issue_not_found` too), `fromIssue`, `status`, `code`, `opId`, `draftId`, `action` |
| `todos.inspect`; `smithers_todo_status_reads_client{outcome}` | browser worker log, span, counter | found, not found or refusal and duration; no TODO content |
| `keys.press`; `smithers_web_shortcut_presses{key}` | browser log, counter | `key`: a one-key shortcut pressed a button |

## Tests

Run with the compose Postgres and Electric up (`pnpm db:up`).

| Test | Proves |
|---|---|
| `src/features/todos/stack.test.ts` | property tests over random histories of commits, drops and run failures: the rules hold after every change; order is the model's, a permutation of 1 to n; numbers count up and are never reused; Drop is idempotent; a refusal changes nothing; no lane idles while a TODO waits; each start is the first Queued TODO |
| `worker/stack/Stack.test.ts` | the writer on real Postgres: what each change writes, receipts, repeated ops and conflicts, refusals, attempts when the host runs TODOs; twelve writers committing at once and random races of commits and drops on connections of their own: no change lost, the rules hold |
| `worker/stack/Api.test.ts` | every route and refusal through the real handler; who acts from the session, never the body (the agent's door can't commit or drop); the run host's seam; the shapes' access and columns; no title or prompt in any record |
| `worker/stack/Api.status.test.ts` | authorized current status and absence, real access refusals, invalid numbers and malformed repository escapes |
| `src/features/todos/todos.test.ts` "a shared TODO status read" | the registered durable read keeps the host's authenticated HTTP client; reads a missing TODO and a failed TODO's Cloud run from Postgres, and preserves a Guest's refusal |
| `src/features/todos/todos.test.ts` | Node devices against the real routes and Electric: a commit Requested at once then numbered on every device; offline then numbered once; a lost answer resent once; Drop; refusals Not sent with Edit and Discard; a Guest and a visitor refused; the agent drafts under its answer and can't commit or drop; the slash commands |
| `src/features/todos/steps.test.ts`, `api.test.ts`, `view.test.ts` | the steps' refusals, the agent's door refused before any tab, a draft from an issue and `issue_not_found`; the client against a local server; the views as GitHub's list and page, the issue links both ways, Make TODO's rule, and the contract |
| `src/features/todos/todos.test.ts` "from an issue" | Make TODO drafts from a real issue row, Commit stores `issue_number` and syncs it to another device, which lists the issue's TODO; a second TODO from the same issue while the first is open; the agent's own title and prompt; `issue_not_found`; `/todo.issue` |
| `src/features/keys/keys.test.ts` | a one-key shortcut presses the shown, enabled button that declares it; never with ⌘, Ctrl or Alt, in a field, a dialog or a menu, or once handled |
| `e2e/todos.spec.ts` | real browsers, two people: Ann asks Smithers for a TODO, edits the draft and commits; Ben sees it numbered and opens its page; both reload; Ann drops it from its page and both see Dropped; it has left Open and shows under Closed. New TODO, Commit and Drop from the row's menu with the keyboard only. Make TODO from an issue's menu, the link both ways, and `t` on the issue's page, with `E2E_ISSUES_REPOSITORY` and a Member's `E2E_SESSION_COOKIE` (it skips without either). GIFs: `todos-todo-commit-drop.gif`, `todos-todo-new-keyboard.gif`, `todos-todo-from-issue.gif` |

## Not built yet

- The run's step strip on a TODO's page.
- Slice 2's rest: Before Tn and Amend, Move, two lanes, forward updates while the TODO below is still in review, out-of-order merges, and redoing a TODO whose base closed instead of failing it.


### Boundary regression guarantees

Titles count Unicode code points and truncate only between them. The request body allowance covers JSON's six-byte escapes for every permitted prompt byte and title or criterion character; decoded field limits still apply. A missing refusal reason displays “Not sent”. Delivery receipts match the requested repository before comparing TODO ids or numbers.

Client steps use the catalog's `@smthrs/flow` `RetryPolicy`: declared `TodoStepRefused` errors stop immediately, while transport failures retain bounded retries. Stack access combines both Electric shapes; a successful shape cannot erase the other shape's authorization refusal. Failed initialization is evicted from the Effect cache so another open can recover. Existing step and shape telemetry records these outcomes without prompt text.


## Retry

Retry on a failed TODO's page or run dispatches the model-invocable system flow
`todo/Retry { repo, number }`. The agent uses the same flow for “retry my failed
TODO”. The least role is **Member** for one's own TODO and **Maintainer** for
anyone's; Guests cannot retry. The server checks the creator's stable person id
under the stack lock, not a login supplied by a client.

The browser engine derives one outbox operation id from the flow execution id.
Replaying that press returns its persisted stack receipt and admits the same
attempt again, never a second attempt. A new press while working, queued or in
review is refused. A cancelled engine run may be retried only after the server
confirms cancellation and the writer rechecks its current attempt id; a live
run cannot be reset by claiming it stopped.

Retry resets the failed attempt's branch and publication projection and queues
a new attempt at the same stack position. The TODO's number, title, prompt
revision and issue stay intact; previous attempts and durable run records stay
readable. Publishing follows the normal stack report path, freeing the lane for
a held successor (the failure hold policy is owned by `todo-stack-hold`).
Merged and dropped TODOs cannot be retried.

This uses the library catalog's durable workflow and retry entries
(`@smthrs/flow`) and UI entry (`@smthrs/ui`). It extends the existing
non-overridable stack infrastructure rather than defining a separate writer.
Existing `todos.queue`, `todos.send`, `stack.request`, `stack.apply` and
transition metrics record `op=retry`, without titles or prompts.

The mini farm's model-free local stack cannot run a TODO: the existing factory
tests require a deployed GitHub App and live model. Retry's browser-to-publication
Playwright proof therefore requires that deployment; a local passing browser
test would not prove the TODO ran.

Retry uses the same `worker/stack/TodoRuns.ts` adapter as durable Drop and admission. A cancellation tombstone or a missing engine run is insufficient: only a recorded engine status of `cancelled` allows a stopped current attempt to retry. Drop cleanup and delayed admission fencing remain unchanged.

### Admission after a failed base (2026-10-22)

The writer admits no queued TODO beyond the first failed predecessor. Dropping an unpublished failed TODO releases its dependency; dropping an In review base holds queued successors `base_closed`. A PR closed unmerged fails queued successors `base_closed`; a missing published base branch also refuses `base_closed`, never falling back to main. Already published descendants retain the existing close-and-fail behavior. Retrying the failed predecessor preserves its position; its publication releases the held TODO onto its branch.

Stack initialization retains the store’s shape source, including cache isolation and injected access refusals. A prompt shape refused with 401 or 403 keeps access at `sign_in` or `forbidden` even when the TODO shape succeeds.


### Merge wake (2026-10-22)

`github/Apply/read` signals a TODO's own PR and every active TODO based on that PR's branch after re-reading a terminal PR from GitHub. The execution host persists the durable deferred before arming the alarm. Early signals, duplicate delivery and replacement hosts retain the same completion. The run parks without `StillOpen` failures; an engine-owned clock at the next hourly boundary re-enters inspection if a webhook is lost. Stacked inspection also re-reads the base PR, so fallback recovery does not depend on its run settling first. Existing retry-policy declarations are retained for persisted-plan compatibility; retries cover failed inspections, not an open PR.

A verified close is terminal for that TODO attempt. Reopening the GitHub PR before the host resumes does not resurrect the attempt or restore retry polling. A verified base close similarly fails the dependent attempt, even if that base PR reopens.

Retry keeps the previous attempt's branch and PR number in `todo_attempts` before
clearing the current projection. Published descendants continue to resolve their
original base after replacement publication, including a confirmed GitHub merge.

A dropped or closed-unmerged base cancels its running descendants through the
durable engine and settles them `base_closed`, freeing their lanes before
another implementation cycle publishes. Queued successors hold. Retry chooses
the nearest open ancestor, or the default branch. The durable cleanup records
its descendant snapshot before cancellation; repeated delivery and recovery
preserve attempt fencing. `todo.base_closed` logs and spans carry attempt IDs
and outcomes; `smithers_todo_base_closed` counts settlement outcomes. PR cleanup
runs after lane release; `smithers_todo_base_closed_pulls` counts closed, refused
and retried closes. A close refusal never blocks cancellation or settlement.

Publish compares the branch machine's complete working tree with the attempt's recorded base, including commits the agent already made and pending edits. An equal tree fails `empty_change`. The host publishes the resulting files as one commit with the TODO message, using the same path validation and expected-head fence; only the TODO branch is written (decision 0016).

An issue’s TODO links include the TODO number and title.

A direct TODO load shows Syncing TODO until the stack shape has applied. Repository permission alone never certifies that a TODO is missing. Revocation remains immediate while sync is pending.

Commit, Drop and Retry first retain a recoverable local operation and await outbox admission. Commit derives its identity from the private draft and its content snapshot, so an unchanged admission attempt cannot create a second TODO. Retrying an earlier snapshot preserves newer edits. A local storage refusal remains Not sent with Retry under the same identity.

Input storage refusal shows Not sent on both the stack and TODO detail. The same operation identity stays available for Retry or Discard; its recovery row is persisted once if device persistence is usable. No delivery starts from a refused input receipt. Explicit Retry fences Discard until admission finishes and completes the original input cleanup lifecycle.

Machine access remains restricted to Members or above of `GITHUB_REPOSITORY` (decision 0122 amendment). Per-person sandbox hours and concurrent TODO-machine accounting are held for a separate design.

Steering a running TODO also requires deployment membership; a repository Member without it may still read the run (decision 0122 amendment).

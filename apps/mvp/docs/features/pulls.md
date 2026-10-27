# Pull requests

A detail shape admits a bounded, deduplicated `github/Apply` refresh for its PR.
That existing durable flow reads GitHub's issue, PR metadata, commits and reviews.
A repository-wide sync receipt does not prove that an unprojected PR is absent.
Not found requires a per-PR GitHub absence fence; otherwise an absent projection
remains unavailable here, with the existing GitHub link. Refused readers never
start a refresh. Late receipts for a different route or an older read are ignored.

Detail reads trace `pull.refresh.start` and `pull.refresh.receipt`; admissions
count `smithers_pull_refresh_starts` by started, timed_out and not_started.
Receipts count `smithers_pull_absence_receipts` by missing or unproven and record
the selected PR, repository and absence result on their span and log.
Records contain identifiers and error codes, never PR content or credentials.

GitHub is the truth for pull requests, as for issues ([issues](issues.md)): Postgres holds a projection that only the server's GitHub flows write, and Electric syncs it to every device. A person merges, never the agent; a pull request's checks are Smithers runs on its head, never GitHub check runs (decision [0012](../decisions/0012-git-end-to-end.md) decisions 6 and 12), each reported on the head as the write-only commit status `smithers/<name>` (ruling GH-10). The `todo` run opens pull requests ([TODOs](todos.md#the-run)), and so does a person's Publish of a branch ([branch publish](branch-publish.md)).

```
GitHub ── pull_request, pull_request_review ─▶ POST /api/github/webhook ─▶ github/Apply (re-read the pull request)
                                                                               items · pulls · pull_commits · reviews
Merge (a Maintainer's own press) ─▶ POST /api/repos/<o>/<n>/writes { op: "pr/merge" } ─▶ pr/Merge
                                     Action.once: merged with our key? ─▶ else recheck head, draft, the base branch's head
                                     ─▶ PUT /pulls/<n>/merge { sha: head, commit_message: Smithers-Write: <key> } with their token
the todo run publishes ─▶ checks/Run on the head ─▶ runs rows with the head's SHA (the Checks tab)
                                     each .smithers/checks/<name>.sh on the branch's machine · the review: one comment
                                     each check's result ─▶ POST /statuses/<head> smithers/<name>, as the App (GH-10)
GET /api/repos/<o>/<n>/compare/<base>...<head> ─▶ the files two commits differ by, kept forever
```

- **One row per pull request, beside its issue row.** A pull request is an `items` row of kind `pull` (title, body, state, author, conversation) and a `pulls` row with its head, base, draft, merge and size. `github/Apply` reads it with its commits and reviews (`worker/github/Pulls.ts`), under the same newer-than guard as an issue.
- **Merging into the default branch is a deploy** (ruling GH-9). Beside Merge on a pull request into the repository's default branch, the page says `Merging into <branch> deploys it.`, with the branch's real name. Production work, checks and runs, happens on Smithers.
- **A person merges, bound to what they saw.** The writes route takes `pr/merge` only from a person's own session, Maintainer or Admin, never from a run credential (the agent, a flow, a frame or a sandbox; `PROTECTED_ACTS`, worker/Actor.ts). `pr/Merge` re-reads the pull request and refuses a moved head, a draft, or one already merged or closed, reads the base branch's own head and refuses one other than the base the page showed, then merges with the person's own GitHub token at the head they saw, squash by default. GitHub's refusal, a required check included, is `not_mergeable`. The merge commit's message ends with `Smithers-Write: <key>`, so a lost answer is found by that key, never by the pull request merely being merged.
- **Checks are Smithers runs.** `checks/Run` runs once per head. Each `.smithers/checks/<name>.sh` runs with `sh` on the head's own throwaway job machine, synced to the head ([where checks run](#where-checks-run)), and the `review` check reads the diff with the `review` role (the `hard` tier, [decision 0107](../decisions/0107-model-tiers.md)) and posts one comment review as the App, never an approval. Each is a `runs` row with the head's SHA, reported on GitHub as the commit status `smithers/<name>` ([commit statuses](#commit-statuses)). Smithers never gates the merge on them itself: a repository's branch protection may require `smithers/<name>`.
- **Libraries** (`docs/libraries.md`): "Touch GitHub" (`@smthrs/integrations`: `GitHub.Pulls`, `GitHub.Refs`, `GitHub.Commits`, `GitHub.AppAuth`), `@smthrs/flow`, `@smthrs/agent` (`ModelStep` for the review), `@smthrs/sandbox` (`SandboxTools` on the branch machine), `@smthrs/effect-electric` (`ShapeProxy`).

## Who reads, who writes

| Act | Who | Token on GitHub |
|---|---|---|
| Read pull requests, their commits, reviews and checks; compare two commits | as issues: a role on the repository, or anyone once GitHub said it is public | the App's, for the compare route |
| Merge | a Maintainer or Admin, in person (`repo:merge`); never the agent | the person's own |
| The review's comment | the `review` check, for the person who committed the TODO | the App's (`smithers[bot]`), "Reviewed by Smithers for @maya" |
| A check's commit status | `checks/Run`, never a person or the agent | the App's, minted with only `statuses: write` |

## Routes

`worker/github/Api.ts` and `worker/github/Compare.ts`.

| Route | Answers |
|---|---|
| `POST /api/repos/<owner>/<name>/writes` `{ writeId, op: "pr/merge", number, headSha, baseSha, method? }` | `202 { txid, writeId }` and `pr/Merge` started (`pr-merge:<writeId>`); refusals as issues' writes: `403 forbidden` for a Member, a Guest or anyone acting for the person, `401 authentication` without a session |
| `GET /api/repos/<owner>/<name>/compare/<base>...<head>` | `200 { files, truncated, commits, commitsTruncated }`, `Cache-Control: private, max-age=31536000, immutable`, on any repository the person may read as the shapes allow (a published branch's lives on its own); `404 not_found` (no such commits), `401`/`403` as the shapes, `503 not_configured` (no App) or `unavailable` |
| `GET /api/shapes/pulls`, `/api/shapes/pull-commits`, `/api/shapes/reviews` | the repository's rows, `PULL_COLUMNS`, `PULL_COMMIT_COLUMNS`, `REVIEW_COLUMNS` |
| `GET /api/shapes/checks` | the repository's `runs` with a commit (`CHECK_COLUMNS`): never who launched them |

## The browser

`src/features/pulls/`, framework-free logic beside React views ([state.md](../state.md)), over the issues' store: a pull request's title, body, state and conversation are its `items` and `comments` rows.

| Piece | What it is |
|---|---|
| `store.ts` | per repository (`forRepo(id)`, with that repository's issues; decision 0079 slice 1b), Electric collections `pull-rows:<repo id>`, `pull-commits:<repo id>`, `pull-reviews:<repo id>`, `pull-checks:<repo id>`, each shape naming its repository with `?repo=`, kept on the device (`src/device/registry.ts`, families); `pull-files` (the comparisons this tab read) and `pull-view` (the route, this person's merge, and what the routed repository's shape last said of access), in memory. The facade's queries are the routed repository's. Commits, reviews and checks request their shapes only while the route shows a pull request ([0112](../decisions/0112-shape-demand.md)) |
| `queries.ts` | the list (newest first), the pull request, its comments, reviews, commits and checks (the runs on its head), the files, the view joined to the merge's write |
| `actions.ts`, `pulls.ts` | `open` (the routes; the Files tab reads its comparison once the head is on the device), `warm` (a link's hover), `loadFiles` (once per two SHAs; a failed read is read again), `merge` (a person's press, sent at once in their session, never queued) |
| `api.ts` | `PullsClient`: the merge write and the compare route, one deadline each |
| `view.ts` | the props of `IssuesView`, `ItemConversation` and `RunList`; `listPageOf`: the list, unknown or refused; `mergeBoxOf`: the notice (Merging, Merged, or why not), whether Merge shows, and the deploy warning |

Screens (`src/screens/pulls/`), at GitHub's paths:

```
/$owner/$repo/pulls                 the list: Open, Draft, Merged or Closed, newest first
/$owner/$repo/pull/$n               Conversation: body, comments, reviews; main ← smithers/t1-add  [Merging into main deploys it.] [Squash and merge]
/$owner/$repo/pull/$n/commits       Commits: headline, author, SHA
/$owner/$repo/pull/$n/checks        Checks: the Smithers runs on the head (RunList), never GitHub's
/$owner/$repo/pull/$n/files         Files: each file's diff (DiffHunks), from the compare route
```

- **Merge** shows only to a Maintainer or Admin, on an open pull request that isn't a draft, once the device has its head. It sends `pr/merge` at the head and base the page shows; the page says Merging, then Merged, or why not (`New commits`, `<base> moved`, `Can't merge`, `Not allowed`, `Sign in`).
- **The deploy warning** shows beside Merge, and only there, when the base is the repository's default branch. `pulls.default_branch` is the base repository's default branch as GitHub's last read named it; until a read names it, no warning shows.
- The list also waits for its device query to become ready: a completed GitHub walk cannot declare an empty list while the shared items shape is still hydrating.
- A direct pull-list visit updates the repository used by the shared issues sync-status query. An empty completed and hydrated list shows confirmed counts; navigating to another repository cannot reuse the previous repository's completion.
- Until the repository's first complete sync and device list hydration the list keeps unknown counts and an empty list stays blank, without a loading state. A direct pull request page waits for the pull collection's accepted network batch to be installed (`currentApplied`) and the repository sync shape before treating a missing item as "Pull request unavailable here" with a GitHub link; a failed cold issue or pull shape settles it as unavailable before hydration, with Try again to reconnect. An installed snapshot stays readable through a transient failed poll. It never claims Not found from an incomplete sync. A current `401` or `403` from either the issue or pull shape hides even cached pull requests and shows Sign in with GitHub or Not found, including after a failed reconnect ([0094](../decisions/0094-item-access-before-cache.md)); so does a pull request number the synced repository doesn't have.
- A TODO's pull request link opens its page here ([TODOs](todos.md)).

## Merge

`pr/Merge { writeId }` (`worker/github/Merge.ts`): `pr/Merge/send` (1 s doubling to 15 s, 5 minutes), then `pr/Merge/give-up` settles `failed unavailable` (a write another run settled answers what it settled). Its write settles `done`, or `refused` with `head_moved`, `base_moved`, `draft`, `merged`, `closed`, `not_mergeable`, `sign_in_required`, `not_found`, `invalid` or `not_allowed`. `github/Write` refuses a `pr/merge` write it is handed: only `pr/Merge` merges.

- **One merge, found by its key.** `send` merges through `Action.once` with `GitHub.Once.merge`, keyed by SHA-256 of the write id (`mergeKeyOf`). The adapter puts `Smithers-Write: <key>` at the end of the merge commit's message and finds the merge as the pull request's merge commit carrying it; a merge someone else made at the same head is `merged`, never this write's. A rebase writes no message to carry the key, so a rebase merge whose answer was lost settles `merged`, never claimed as this write's. The step is `irreversible` with the write id as its `idempotencyKey`, implementation `pr-merge/send/v2`.
- **The base the person saw.** GitHub's `base.sha` is the commit the base branch pointed at when the pull request opened or changed base, and GitHub never moves it ("If the branch is updated in the future, GitHub does not update the base branch's commit", [GitHub docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/changing-the-base-branch-of-a-pull-request)). So `pulls.base_sha` is the base branch's head when the pull request was last read (`GitHub.Refs.getBranch`; GitHub's `base.sha` when the branch is gone or its name can't be read), and the step rechecks the branch's own head just before the merge, never falling back to the snapshot. A head other than the page's, or one it can't read, is `base_moved`: nothing merges, and every open pull request into that branch still showing the page's base takes the head read, so the page shows it and a second press binds it. After a merge, every other open pull request into the branch still showing the base the merge checked takes the merge as its base's head, so merging a stack one after another needs one press each; a settlement that lands late never moves a pull request back over a newer base.
- **The window GitHub can't close.** GitHub's merge takes no base precondition (`sha` fences only the head), so a push between the step's check and GitHub's merge, one round trip, lands under the merge. The step compares a squash with the base it checked: one commit ahead is `base="seen"`, anything else `base="moved"` (a Warn), and a merge commit or a rebase is `unchecked`. Branch protection ("require branches to be up to date", or a merge queue) is the only full fence.
- **A projection that fails after the merge** (the read-back, or the other pull requests' bases) is logged and skipped in a savepoint, so the write still settles `done`; the next webhook read fixes the rows.

## Where checks run

Each head's scripts run on a check job: a throwaway machine of its own, never the TODO's machine the agent wrote on (`Checks.jobMachineOf`, `kind: "job"` on its `SandboxBranch`).

- **One per head.** `job-<owner>-<name>-<head SHA>`: a branch machine's `SandboxObject` and container, checking the head's branch out from GitHub and synced to the SHA. Its tools run as the person who committed the TODO. Once its scripts ran it sleeps (`sleepIfIdle`, 0 ms).
- **The package registries, nothing else.** A job's box reaches the package registries every box reaches, npm, PyPI, crates.io, Go's proxy, GitHub's releases and dprint's plugins, and nothing else ([the machine](sandbox-tools.md#the-machine), `worker/branch/RegistryEgress.ts`). It keeps that egress even with `SANDBOX_SECRETS` on, holds no placeholder, and trusts the egress's CA: the system store, Node's `NODE_EXTRA_CA_CERTS` and dprint's `DPRINT_CERT`. Each request is counted, `smithers_registry_egress_requests{outcome}`, and logged as `secrets.egress`; none is stored.
- **The checkout.** The job syncs to exactly the head SHA. A request that isn't a branch and a SHA, a clone the forge refused, or a sync that failed runs no script: the head gets a Failed `checkout` check, never a pass another commit earned. A machine that couldn't start is tried again.
- **A script holds no step.** Each script runs as its own `sandbox/Command` job ([long commands](sandbox-tools.md#long-commands)): `checks/Run` parks while it runs, so a lint of the whole monorepo outlives any one host's drive, and a host that stops mid-script loses nothing. The step runs again from the top once a script ends: a check's row, its pending status, its count and its log line come only from the call that recorded its start or its end.
- **The repository's checks.** This repository's are `.smithers/checks/lint.sh` and `check.sh`: install the packages the head changed since it left `main` (`pnpm --filter "[<merge base>]..."`, with `main` fetched from the forge) and what they depend on, then run each one's own `lint` or `check` script.
- **The toolchain** is the branch image's (`infra/sandbox/Dockerfile`): Node and pnpm at the versions the repository names, Go, Python with pip and venv, and a C toolchain.

## Commit statuses

Ruling GH-10: Smithers writes GitHub commit statuses, write-only, so branch protection can require Smithers checks. It never reads one back, and it still neither reads nor shows GitHub Actions ([github.no-actions](../rules.md#githubno-actions)).

```
checks/Scripts   each script: its run row ─▶ smithers/<name> pending "Running", best effort ─▶ the script
checks/Report    after the scripts: each check of the head that ended, read from runs ─▶ success "Passed" or failure "Failed"
checks/Review    smithers/review pending ─▶ the judge, the comment review
checks/Report    after the review: every ended check again, the review's included
```

- **On the exact head.** A status names the SHA the check ran on. A newer head starts with none, so an older head's result never stands in for it.
- **The runs are the truth.** `checks/Report` reads the head's ended `checks/*` runs, not the step before it, so a report sent again says the same thing, and a status always matches the Checks tab.
- **Durable, and safe to repeat.** A report that meets an outage, a rate limit or a lost answer is sent again until GitHub takes it (`REPORT_RETRY`, no deadline): a status left `pending` would hold a required check forever. GitHub keeps the latest status per context. A pending status that couldn't be sent is dropped and counted: the report replaces it.
- **Nothing stays Running.** A report follows a step that finished or gave up, so it first fails any check of the head still Running (a review whose judge never answered), and reports it failed.
- **The permission.** The App needs "Commit statuses: Read and write". Without it, or without the App, the token is refused: every check still runs and keeps its result, and each status is recorded `refused`, never retried. GitHub's `422` for a commit it doesn't have is a refusal too.
- **Requiring a check.** A Maintainer adds `smithers/<name>` to the branch's required status checks on GitHub. GitHub then holds Merge, ours and its own, until that context reports `success` on the head.

## Postgres

Migrations `0031_pulls`, `0033_pull_writes` and `0037_pull_default_branch`.

| Table | | |
|---|---|---|
| `pulls` | `item_id` (`<repo_id>#<number>`), head and base refs and SHAs (`base_sha` the base branch's head at the last read), `default_branch` (GitHub's `base.repo.default_branch`; `NULL` until a read names it), `draft`, `merged`, `merged_at`, `merged_by`, `merge_sha`, `mergeable_state`, sizes | synced without the guard's times |
| `pull_commits` | `item_id`, `position`, `sha`, `headline`, `author_login`, `authored_at` | rewritten whole when the list changes |
| `reviews` | `id` (`<repo_id>/review/<GitHub id>`), `item_id`, `author_login`, `state`, `commit_sha`, `body` without the marker, `write_id` | |
| `runs.sha` | the commit a run works on | a pull request's Checks read the runs on its head |
| `github_writes` | takes `pr/merge` and the merge's refusals | |

## Observability

| Record | Kind | Fields |
|---|---|---|
| `github.merge` | log, span | `writeId`, `outcome` (`done` or the refusal), `settled`, `base` (`seen`, `moved`, `unchecked`), `projection` (`failed`), `errorCode` |
| `smithers_pr_merges{outcome,base}` | counter | `base` on a merge only |
| `github.compare`, `smithers_github_compares{outcome}` | log, span, counter | `outcome`, `files` |
| `checks.script`, `checks.review`, `checks.sync`; `smithers_checks{check,outcome}` | logs, spans, counter | `repoId`, `sha`, `check`, `prNumber`, `outcome` |
| `sandbox.registry.egress`, `secrets.egress`; `smithers_registry_egress_requests{outcome}` | span, log, counter | a box's outbound request through the registry egress, a check job's included: `host`, `method`, `status`, `outcome` (`forwarded` or the refusal), never a path or a header |
| `checks.status`, `checks.report`; `smithers_check_statuses{state,outcome}` | log, span, counter | `repoId`, `sha`, `check`, `state` (`pending`, `success`, `failure`), `outcome` (`sent`, `refused`, `dropped`), `errorCode` |
| `github.apply` | log, span | as issues' (`event` `pull_request` or `pull_request_review`) |
| `pulls.merge.post`, `pulls.compare.get`; `smithers_web_pull_merges{outcome}` | browser spans, counter | `outcome`: `sent`, the route's status, or `unreachable` |

No record carries a title, a body, a diff, a finding, a command's output or a login.

## Tests

| Test | Proves |
|---|---|
| `packages/smithers/agent/integrations/test/Pulls.test.ts` | `GitHub.Pulls`, `Refs` and `Commits` against a fake GitHub on a real socket: fenced merges and commits, adoption after a lost answer, every refusal, 100% |
| `packages/smithers/agent/integrations/test/Once.test.ts` | `GitHub.Once.merge` against a fake GitHub on a real socket: the trailer written and found by its key alone, never a merge someone else made at the same head, the head fence, a rebase never claimed |
| `worker/github/Merge.test.ts` | `pr/Merge` on the Node host against the scripted GitHub: as the person, with the key in the commit message; each refusal, the base branch moved since the page read it included; a lost answer found by its key; someone else's merge at the same head refused `merged`; a base branch it can't read refused; a moved base moving every open pull request's base and a second press merging; a late settlement never moving a base back; a push landing during the merge counted `moved`; a failing projection settling `done`; a run again; give-up |
| `worker/github/PullsApi.test.ts` | the merge write's admission (a Maintainer only; never the agent or a flow), the pull request webhooks and Apply's projection, the compare route, the shapes |
| `worker/flows/Checks.test.ts` | script checks pass and fail, the review's one comment as the App, a lost review adopted, a failing judge, no App; each check's status pending then its result on the head, as the App with only `statuses: write`; no permission or an unknown commit refused once and the results kept; a 502 and a lost answer sent again; each head's statuses its own; the scripts on the head's own job machine, put to sleep after, and one that never answers runs no script |
| `worker/branch/RegistryEgress.test.ts` | a box reaches each registry host, counted; every other host refused before anything is sent; no secret in its policy or vault; a job's box never gets the secrets egress |
| `packages/smithers/agent/integrations/test/Statuses.test.ts` | `GitHub.Statuses.create` against a fake GitHub on a real socket: per-commit statuses, a lost answer retryable, refusals unretried, every invalid input refused before a request, 100% |
| `src/features/pulls/pulls.test.ts` | the browser's layer on a Node device against ChatApi's real routes and Electric: the list, a pull request's tabs, the checks on its head only, the files through the compare route on the scripted GitHub, a Maintainer's merge followed to its write's refusal, a Member's, a signed-out person's and an unreachable ChatApi's |
| `src/features/pulls/view.test.ts`, `contract.test.ts`, `api.test.ts` | the pages' words and the merge box, the deploy warning (into the default branch only, never without Merge), the paths, and the client against a local server |

## Not built yet

- The pages' end-to-end run with its chaptered recording, against a live instance with the GitHub App ([pull requests](../work/pull-request-list-and-tabs.md)).
- The branches page: deferred; GH-6 and GH-11 still require it. Opening a pull request from a branch (Publish), Update branch and a branch's compare view are built ([branch publish](branch-publish.md)).
- The configurable merge flow (BR-7): merging into the default branch runs a flow a repository can override, whose default admits Maintainers and Admins. Today the gate is fixed in the writes route and `pr/Merge`.

### Projection and merge recovery

Pull snapshots serialize per item and project atomically. Commit replacement uses the same transaction lock, including when called directly. An older pull snapshot cannot replace newer commits; unchanged pull and review reads still advance their freshness fences.

A merge's attempt count is a record of how many times the step went to GitHub; it decides nothing. Which merge is this write's is decided by the key in the merge commit's message (see [Merge](#merge)). Confirmed GitHub success settles the write; its projection runs in a savepoint of the same transaction, and a projection that fails is logged as `github.merge` with `projection: failed` and counted by `github_projection_failures`, waiting for the next read or webhook. It cannot turn that successful write into a failed one. Migration `0050_drop_merge_unknown` drops the `merge_unknown` flag `0045` added for the earlier recovery.

Issue and pull request detail pages link back to their repository's list. Every pull request tab keeps its title and number, including Checks, Commits and Files. The read-only `item-navigation.spec.ts` regression checks these links and headings against a deployment.

Pull request bodies and conversation comments use the issue store's item-scoped persisted shapes. PR metadata, reviews, commits and checks continue using their existing repository shapes. Hover preload carries the PR number so its body starts before navigation.

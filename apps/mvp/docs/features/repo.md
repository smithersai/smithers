# Repositories: clone and view

A signed-in Member or above clones a public GitHub repository into Code Storage, and anyone browses a cloned one: its file tree, a directory with its README, and a file as highlighted code or rendered Markdown, at any branch, tag or commit. A file opens raw or downloads; Copy puts a permalink, a path, a file's text or the clone URL on the clipboard. The URLs are GitHub's: swapping `github.com` for the app's domain opens the same thing, raw files included. Every action is a registered flow that a person and the agent run alike: `repo/clone`, `repo/copy`, `repo/refs`, `repo/tree`, `repo/read`, and `app/navigate` to open a location. The first visit uses the page as GitHub's repository page does, before anyone clones: the top folder, the README, and the about panel from GitHub ([About](#about)). A clone reports its stages in the person's feed ([the clone in the feed](#the-clone-in-the-feed)), and a copy without the Smithers app is reclaimable ([reclaiming](#reclaiming)). Decision: [0006](../decisions/0006-repo-clone-and-view.md).

## How it works

```
browser                         ChatApi (Cloudflare)                              Code Storage / GitHub
Clone, /clone, the agent
  └ repo/clone (engine worker)
     ── POST /api/repos ──────▶ RepoApi: sign-in, Member, bounds, REPO_MAX_REPOSITORIES
            202 {txid, cloneId} ◀ INSERT repositories 'cloning'   (answers at once, starts nothing)
     ── POST /api/repos/launch ▶ RepoApi: the row still holds cloneId? ── FlowStarter ─┐
            202 {launched}  (the step retries a 503)                                 │
                                 FlowExecution Durable Object (alarm) ◀─────────────┘
                                   repo/Clone: Inspect ── HEAD (git smart HTTP) + size (REST) ──▶ GitHub
                                                  └── admission (Postgres, one row lock)
                                               Import ── POST /api/repos {upstream: public} ────▶ Code Storage
                                               Pull ──── POST /upstream/pull
                                               AwaitSync GET /commits?limit=1 until synced or the deadline
                                               Index ─── the file list into the cache; the App installed?
                                               Settle ── UPDATE repositories … WHERE clone_id = $2 AND status = 'cloning'
repositories ◀── GET /api/shapes/repositories (ShapeProxy) ◀── Electric ◀── Postgres
tree, file   ◀── GET /api/repos/<o>/<n>/tree/<sha> · /blob/<sha>/<path> ◀── immutable cache ◀── Code Storage
raw          ◀── GET /api/repos/<o>/<n>/raw/<sha>/<path> (text/plain)    ◀── the same cached file
refs         ◀── GET /api/repos/<o>/<n>/refs ◀── Postgres head ── immutable cache (by head) ◀── Code Storage
about        ◀── GET /api/repos/<o>/<n>/about ◀── immutable cache (by hour) ◀── GitHub's REST API, cloned or not
```

- **Cloning runs remotely** because it needs the Code Storage organization key, which a person must not hold ([0011](../decisions/0011-the-agent-runs-in-the-browser.md) §2). It is the durable flow `repo/Clone` on the per-execution Durable Object ([remote flows](remote-flows.md)).
- **Reading runs anywhere.** The tree and file bodies stay in Code Storage and are read at a commit SHA, so an answer never changes: RepoApi keeps it in the immutable cache, and the browser's HTTP cache keeps it too (`Cache-Control: public, max-age=31536000, immutable`).
- **Libraries** (`docs/libraries.md`): `@smthrs/effect-code-storage` (`CodeStorage`, `GitRemote`), `@smthrs/artifacts` (`ImmutableCache`) with `@smthrs/platform-cloudflare`'s `EdgeCache.layer`, `@smthrs/integrations` (`GitHub.GitHubClient`, its `count` new for this) for the size call and the about read, `@smthrs/ui`'s `RepoAbout` and `GeneratedChip`, `@smthrs/flow` for the flows, `@smthrs/effect-electric` (`ShapeProxy`, `ElectricCollection`), `@smthrs/effect-tanstack-db`, and `@smthrs/repo-view`'s `RepoView`, imported from its root ([rules](../rules.md#sdkroot-imports-only)).

## RepoApi

`worker/RepoApi.ts`. ChatApi routes `/api/repos`, `/api/repos/*` and `/api/shapes/repositories` to it, with sign-in's `Sessions`, the `FlowStarter` that starts a Durable Object, and the Workers Cache API as `ImmutableCache` (`EdgeCache.layer({ name: "repo" })`).

| Route | Who | Answers |
|---|---|---|
| `POST /api/repos` `{ owner, name }` | signed in | persists the request and answers at once, starting nothing: `202 { txid, id, attempt, cloneId }` for a new clone or Try again on a `failed` or `capacity` row; `200 { txid: null, id, status, cloneId }` for a row already `cloning` or `ready` |
| `POST /api/repos/launch` `{ owner, name, cloneId }` | signed in | starts the durable `repo/Clone` for attempt `cloneId` under its own [execution id](#execution-ids), so starting it again changes nothing: `202 { launched: true }` while the row holds that attempt `cloning`; `200 { launched: false, status }` for an attempt the row no longer holds or one that settled; `503 unavailable` when the Durable Object couldn't take it, and the row stays `cloning` for the next launch; if Code Storage was removed after the request, `503 not_configured` settles the matching attempt as failed (`unavailable`) and folds its feed row in the same transaction |
| `GET /api/shapes/repositories` | anyone | Electric's `repositories`, whole: `ShapeProxy` with the table fixed and no subset requests |
| `GET /api/repos/<owner>/<name>/tree/<sha>` | anyone | `{ paths, truncated }`: every file's path, in pages of 5,000, up to `REPO_TREE_MAX_PATHS` |
| `GET /api/repos/<owner>/<name>/blob/<sha>/<path>` | anyone | the file's bytes (`application/octet-stream`, `x-blob-sha`) |
| `GET /api/repos/<owner>/<name>/raw/<sha>/<path>` | anyone | the same bytes as a page shows them: `text/plain; charset=utf-8` for text, `application/octet-stream` for a binary, with `x-content-type-options: nosniff` and `content-security-policy: default-src 'none'; sandbox`, so a file is never sniffed or run |
| `GET /api/repos/<owner>/<name>/about` | anyone | what GitHub says of the repository, cloned or not ([About](#about)); `Cache-Control: public, max-age=` the seconds left in its window |
| `GET /api/repos/<owner>/<name>/refs` | anyone | `{ defaultBranch, head, branches, tags, truncated }`: the ready row's default branch and head commit, and every branch and tag as `{ name, sha }`, in pages of 100 up to `REPO_MAX_REFS` each; `Cache-Control: no-cache`, since it follows the row |

Refusals are `{ code }` JSON with `Cache-Control: no-store`:

| Status | `code` | When |
|---|---|---|
| 400 | `invalid` | not `{ owner, name }` JSON, a name GitHub couldn't have, a reserved owner (`app`, `api`, `assets`), a SHA that isn't 40 hex, a path with an empty, `.` or `..` segment or over 1,024 characters or 64 segments |
| 401 | `authentication` | cloning while signed out ([0008](../decisions/0008-auth.md): importing needs sign-in) |
| 403 | `forbidden` | cloning as a Guest or a person with no role: a clone spends the deployment's Code Storage budget, so it needs the Member role or above, the tier of `repo:branch-create` ([0007](../decisions/0007-roles-and-tags.md)) |
| 404 | `not_found` | no such route, repository, commit or file; for `refs`, a repository that isn't `ready` |
| 405 | none | a method the route doesn't take (`allow` names it) |
| 413 | `too_large` | a body over 1 KiB; a file over 512 KiB, with its `size` when Code Storage declared it, never reading the body |
| 429 | `repository_limit` | `REPO_MAX_REPOSITORIES` rows are already `cloning` or `ready` |
| 503 | `capacity` | this month's read budget is spent and the answer isn't cached |
| 503 | `rate_limited` | GitHub limited a public About read; `retry-after` (seconds) when GitHub gave a wait |
| 503 | `unavailable` | Postgres, sessions, the Durable Object, GitHub or Code Storage couldn't answer; `retry-after` (seconds) when the upstream gave a wait |
| 503 | `not_configured` | this deployment has no Code Storage organization |

## Postgres

Migrations `0007_repositories`, `0009_clone_ids`, `0028_clone_progress` and `0041_refs_changed_at`.

| Table | Columns | |
|---|---|---|
| `repositories` | `id` (key: `github/<owner>/<name>`, lowercased; also the Code Storage name), `owner`, `name`, `status` (`cloning`, `ready`, `failed`, `capacity`), `failure` (`not_found`, `empty`, `unavailable`, `timed_out`), `capacity` (`paused`, `storage`, `reads`, `too_large`, `size_unknown`), `stored_bytes`, `retry_at`, `default_branch`, `head_sha`, `head_message`, `head_author`, `head_at`, `attempt` (1, then 2 after Try again), `clone_id` (the attempt's own id, a UUID drawn when the attempt is created), `requested_at`, `settled_at`, `stage` (`requested`, `fetching`, `indexing` while `cloning`, else null), `reclaimable` (a ready copy without the Smithers app), `refs_changed_at` (when its branches or tags last changed in a way the app knows of) | synced to every device by Electric; `REPLICA IDENTITY FULL` |
| `clone_requests` | `repo_id` (key), `clone_id`, `requested_by`, `requested_at` | who asked for each repository's current attempt: the person its feed row goes to. Not synced |
| `repo_imports` | `id` (always 1), `paused`, `changed_at` | the pause switch admission reads; its row lock serializes requests and admission |
| `code_storage_usage` | `month` (key), `bytes_read`, `bytes_imported`, `alerted_pct` | what Code Storage served and imported each UTC month, and the highest spend alert raised |

## The clone

`repo/Clone { id, owner, name, cloneId, requestedAt }` (`worker/flows/RepoClone.ts`), execution id `repo-clone:<id>:<cloneId>`. Every step is sealed: a resumed run never repeats one that finished.

| Step | Does | Retry policy |
|---|---|---|
| `repo/Inspect` | `GitRemote.head` over git's smart HTTP (no key, no REST quota): 401, 403 or 404 is `not_found`, no commits is `empty`, a detached HEAD is `unavailable`. Then GitHub's size (`GET /repos/<o>/<n>`, with the [read token](#configuration)) and [admission](#admission) | 1 s doubling to 30 s, 2 minutes |
| `repo/Import` | `CodeStorage.createRepo` with the public GitHub upstream; one that exists is fine, one with another upstream is refused | the same |
| `repo/Pull` | `CodeStorage.pullUpstream`; `sync_in_progress` is fine | the same |
| `repo/AwaitSync` | `CodeStorage.listCommits(id, { ref: defaultBranch, limit: 1 })`: the head commit once synced; `timed_out` once `REPO_CLONE_DEADLINE` has passed since the request; otherwise `SyncPending`, retried | 2 s doubling to 30 s, after Code Storage's `Retry-After` when it sends one; an hour at most |
| `repo/Index` | once the head commit is in: the row's stage becomes `indexing`; reads the file list at the head through RepoApi's own tree read, into the immutable cache, so the first visit's tree is a hit (best effort); asks GitHub, as the App, whether the Smithers app is installed on the repository (`false` without the App) | as Inspect |
| `repo/Settle` | writes the outcome only while this attempt owns a `cloning` row (`clone_id` is its `cloneId`), with `reclaimable` for a ready copy the app isn't installed on; a `ready` clone adds its size to this month's imported bytes | 1 s doubling to a minute, 30 minutes |

- Inspect's failure past its retries settles `failed` `unavailable`; so does any failure of Import, Pull or AwaitSync. A refusal by a budget skips straight to Settle as `capacity`. A stale attempt's Settle changes nothing.
- AwaitSync is a step with a retry policy rather than `Poll.make` (0006 named a poll): a poll's backoff can't cap at 30 s, and a step's attempts and expiration are persisted the same way.
- The flow runs on the Node host in its tests and on the Durable Object when deployed: the host injects Postgres, Code Storage and GitHub (`RepoClone.registration`, `ExecutionHost.withRepoClone`).

### The clone in the feed

A clone is a workflow the person who asked watches in their feed (decision [0009](../decisions/0009-notifications-and-live-work.md)), not a spinner. Every write to a clone's row folds it into that person's `notifications` row, `clone:<repo id>`, in the same transaction (`worker/CloneFeed.ts`): RepoApi's request (`requested`), admission (`fetching`, with the size), Index (`indexing`), and Settle (done, or failed with why). The row's `ref` carries the stage and size (`fetching:<bytes>`) or the outcome (`failed:not_found`, `capacity:too_large`); its version goes up for done, failed and a new attempt, so a dismissed entry shows again.

```
Clone ─▶ POST /api/repos ─▶ requested ─▶ Inspect: fetching 640.0 KB ─▶ Index: indexing ─▶ Settle: done
                                                                                   └─▶ failed · Not found · [Try again]
```

The toast reads `◌ Clone · octocat/Spoon-Knife · Fetching 640.0 KB`, then `✓ Clone · octocat/Spoon-Knife`. A failed clone's toast and list entry offer Try again, which runs `repo/clone` again (`src/features/attention/actions.ts`); Open goes to the repository. The header shows no spinner while it clones: Clone gives way to nothing until the clone settles, or to why it stopped with Try again.

### Reclaiming

A cloned copy of a repository the Smithers GitHub App isn't installed on is reclaimable: Index asks GitHub as the App, and Settle writes `reclaimable` only for a confirmed absent installation. If the lookup remains unavailable after Index retries, the clone still becomes ready but is not reclaimable. Rows ready before migration 0028 are reclaimable unless their installation was known (`github_repositories`). The page shows the quiet note under the about panel, "Until the Smithers app is installed, this copy may be reclaimed for space.", with Install, which opens `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`.

Nothing deletes a copy yet. Reclaiming waits for a durable flow that frees storage when the budgets need room, and for clearing the mark when the App is installed later; both are in [not built yet](#not-built-yet).

### Execution ids

Each attempt has an id of its own, `clone_id`: Postgres draws a UUID when `POST /api/repos` inserts the row or Try again starts a new attempt (`gen_random_uuid()`), and a request on a `cloning` row reuses it. It names the attempt's execution, `repo-clone:<id>:<clone_id>` (`cloneExecutionId`), so the attempt's Durable Object is its own, and it fences admission's and Settle's writes (`WHERE id = $1 AND clone_id = $2 AND status = 'cloning'`).

- **Never the `attempt` counter.** It restarts when `repositories` is reset or restored while the Durable Objects keep their executions. A new attempt 1 then named the old execution, whose intent holds another payload: the start failed (`StartConflict`), RepoApi answered 503, and the row stayed `cloning` with every request colliding again. An old run fenced by the counter could also settle the new row. `attempt` stays as the count of tries, in the `202` answer and the request's log line.
- **A start that still conflicts is a bug,** since an id never repeats. RepoApi settles that attempt `failed` `unavailable`, logs `repo.clone.request` at Error with `outcome` and `errorCode` `conflict`, and answers `503 unavailable`. The browser shows "Couldn't clone" and Try again, which starts a new attempt, rather than a spinner forever.
- **Migration `0009_clone_ids`** adds the column, with its own UUID for every row, and settles each row still `cloning` as `failed` `unavailable`: its execution was named by the counter, and none carries the new id to settle it.

### Admission

In Inspect, after the size, one transaction holds `repo_imports`' row, so two imports can't both take the last headroom. The first rule that holds decides: imports `paused`; GitHub rate limited the size call (`size_unknown`, with `retry_at` at GitHub's reset); the size is over `REPO_MAX_SIZE_MB` (`too_large`); the stored bytes of the other `cloning` and `ready` rows plus this one are over `REPO_MAX_STORED_GB` (`storage`); this month's reads have reached `REPO_MAX_READ_GB_PER_MONTH` (`reads`); otherwise it writes `stored_bytes` and admits.

### Spend

Every write to `code_storage_usage` recomputes this month's estimate in its transaction: stored GB × $3.60 + read GB × $0.15 + imported GB × $0.06. Crossing 50%, 80% or 100% of `REPO_BUDGET_USD` above `alerted_pct` raises it and logs `repo.spend.alert` at Error once a month per threshold; the gauges `repo_stored_bytes` and `repo_spend_estimate_usd` follow every write. Delivering that line to Will is the token-spend alert's job ([spend alerts](spend-alerts.md)).

## About

`GET /api/repos/<owner>/<name>/about` (`worker/RepoAbout.ts`) answers what GitHub says of a repository, cloned or not: its description, homepage (an `http(s)` URL only), topics, stars, watchers, forks and license; its languages by bytes; the latest release and how many there are; the first 12 contributors and how many there are; how many commits, branches and tags; the newest commit; the top folder; the README's text (512 KiB at most, text only); the repository's own `.smithers/home.json` text at the newest commit (`home`, the same bounds, `null` without one), which [its home](home.md#before-a-clone) draws before a clone and whose `docs` names the repository's [docs](docs.md#where-docs-come-from); and where the Smithers app is installed. The repository's page, its home before a clone, the Docs tab and the code root all start from it, and the docs routes read it through the same about read, so GitHub is asked once for both.

```
request ─▶ repo_about (each request on its own; nothing shared between requests)
             │
             ├─ fresh ────────────────────────────────────────▶ 200 (hit)
             ├─ read due, claim won ─▶ GitHub ─▶ answer ───────▶ 200 (miss), kept
             │                            └─▶ refusal ─────────▶ last good answer (stale), else the refusal, kept
             └─ claim held elsewhere ─▶ last good answer (stale) │ kept refusal
                                        │ nothing yet: watch repo_about ─▶ 200 (hit) │ its refusal │ 503 after 10 s
```

- **Whose quota.** A read the store misses goes out with the read token for a signed-in Member or above, and for anyone when the Smithers App is installed on the repository: its owner let Smithers act there (decision [0079](../decisions/0079-roles-per-repository.md) §4), so a public repository with the App, such as `smithersai/vibelang`, never depends on GitHub's anonymous quota. A visitor's or Guest's read of any other repository is anonymous, so naming arbitrary repositories can't spend the App's quota. A kept answer serves everyone. In order:
  - the App's installation token for the repository, minted with Contents read for that one repository (`worker/github/Tokens.ts`), when the App is configured, installed there and `GITHUB_ALLOWED_REPOSITORIES` doesn't leave the repository out (the deployment's own repository always counts). Where the App isn't installed, that is remembered for an hour (`app_absent_until`), so a visitor naming arbitrary repositories costs no installation lookup each time; a token that can't be minted now leaves the read to the next rule and records `tokenError`;
  - the deployment's [read token](#configuration) for a Member or above;
  - none: anonymous, 60 calls an hour per address, shared with every Worker on Cloudflare's egress.
- **Few calls** (`worker/about/GitHubRead.ts`, through `@smthrs/integrations`' `GitHubClient`, each call with an 8-second deadline). With a token, one GraphQL query answers everything but the contributors: the README is the first blob among `.github/README.md`, the usual top-folder names and `docs/README.md`, and a top-folder README with another name is read over REST. Then the contributors over REST, and their count only when they fill a page: two calls, three past 12 contributors. GitHub's GraphQL needs a token, so an anonymous read is REST: the repository first, then eight parts at once, then the latest release only when there are releases, the contributors' count only past a page, and the home only when the top folder has `.smithers`. Ten calls for a typical repository (twelve before), twelve at most.
- **Only the repository must answer.** GitHub's 404, or a private repository, is `404 not_found`. Any other refusal of the repository itself is `503 rate_limited`, with GitHub's wait as `Retry-After`, or `503 github_unavailable`. A part GitHub doesn't have (a 404, an empty repository's 409) is left out (`null`, or empty). A part GitHub couldn't give now (a rate limit, a 5xx, no answer) is left out too, and the answer is fresh for 5 minutes at most so it is read again sooner.
- **Kept for every data center.** The answer is kept in Postgres, `repo_about` (`worker/about/Store.ts`, migration 0060), not in the Workers Cache API, which each data center keeps apart. It is fresh for `REPO_ABOUT_FRESH_MINUTES` (10) when read with a token and `REPO_ABOUT_ANONYMOUS_FRESH_MINUTES` (60) when anonymous; the browser keeps a fresh answer until it goes stale (`max-age`). Once stale, the next request claims the read in one statement (`next_read_at`, held 30 seconds) and every other request, in every data center, keeps answering the stale answer (`max-age=30`) until the new one lands. With nothing kept yet, the requests that didn't claim the first read watch the store every 250 ms and answer with what it keeps, so a crowd's first read is one read of GitHub too. No request ever awaits another request's work: a Worker isolate serves many requests at once, and one request may not resume on another's I/O (on 2026-10-25 a lookup shared through Effect's `Cache` answered 23 of 30 concurrent visitors 500). The store never fails a read: when Postgres can't answer, the request reads GitHub and the `repo.about` line names the failed operations (`store`).
- **When GitHub can't answer.** The last good answer serves for up to 7 days. Its refusal is kept too, and nobody asks GitHub again for 5 seconds after it didn't answer (a page waiting through a moment's outage shows as soon as GitHub answers), 1 minute after a 404, or until its rate limit resets (at least 1 minute, at most 15), so a burst of visitors during an outage gets the kept answer or the kept refusal with the wait as `Retry-After`. A 404 also drops the kept answer. A request whose wait for another's first read reaches 10 seconds is answered `503 unavailable` with `Retry-After: 1`, which the browser's flow waits out.
- **Records** (OBS-1, OBS-5). Every read of GitHub logs `repo.about.read` (the token, `via`: `app`, `deployment` or `anonymous`; `outcome`; on a refusal its `stage` and `upstreamStatus`; `rateRemaining`, the least `x-ratelimit-remaining` GitHub answered with; `missing`, the parts left out; `tokenError`) and counts `repo_about_reads`; every answer's `repo.about` line says where it came from (`cache`: `hit`, `miss`, `stale`, `refusal` or `wait`), how long it waited for another request's first read (`waitedMs`), and counts `repo_about_answers`. These fields are fixed names and numbers; they contain no token, response body, repository content or person field ([observability](../observability.md#repositories)).
- **The browser** loads it once per tab when a repository opens, and when a link to one is warmed: `abouts`, keyed by the repository's id, `loading`, `ready`, `missing` or `failed`. The load is the flow `repo/about`, door `view`, on the device's engine: a `503` or an unreachable RepoApi is asked again under the reads' retry policy (1 s doubling to 15 s, for 2 minutes, after any `Retry-After`) while the panel shows it loading. `404` is `missing` at once. A spent read budget or 2 minutes of refusals becomes `failed`; route navigation leaves that failure in place instead of spending another retry window. An uncloned repository's root then shows Reading paused, GitHub limit reached, or "GitHub isn't answering. Repositories already cloned keep working." (Will, 2026-10-19 12:41), else Couldn't load, each with Try again through the same flow's `button` door. A cloned repository keeps its Code view.

## Reads

`worker/RepoReads.ts` answers the GET routes and the agent's flows alike. A read checks the immutable cache under `repo.tree` (`id`, `sha`) or `repo.blob` (`id`, `sha`, `path`, which the `raw` route shares); a hit costs Code Storage nothing and is served over budget too. A miss checks this month's read budget, reads Code Storage, meters its bytes into `code_storage_usage`, and stores the answer. A failed read is never cached. A meter Postgres refuses is logged (`repo.meter`) and the read still answers.

The branches and tags (`CodeStorage.listBranches` and `listTags`) change when a clone attempt settles `ready` and when the app makes a branch on the forge (`worker/branch/Branches.ts`), which may leave the default branch's head where it was. Both write the row's `refs_changed_at`, and the listing is cached under `repo.refs` (`id`, the head commit Settle wrote, `refs_changed_at`). A refs read first reads the `ready` row's `default_branch`, `head_sha` and `refs_changed_at` from Postgres (`Repos.readyHead`), then the listing through the cache. A device keys the refs it keeps the same way (`refsKey`), so a new branch shows the next time the view opens.

A refs read before a mirror has a ready head answers `204`, `X-Repo-State: not_imported`, with `private, no-store`. This says nothing about the repository's existence on GitHub. Missing refs in a ready mirror and provider failures retain their error responses. The browser treats the empty response as its existing missing-mirror state.

## Flows

Every repository action is one registered client flow (`src/features/repo/flows.ts`), model-invocable, run on this device's engine by a person's button or slash command and by the agent's cell alike ([flows](flows.md#the-registry)). The engine worker registers them with `repoFlows(origin)` (`src/flows/registrations.ts` over `src/features/repo/steps.ts`): each step reaches RepoApi through `RepoClient` on the page's origin, with the worker's own `HttpClient` and `REQUEST_WITHIN` (15 s) for each whole request. The device never holds the Code Storage key.

| Flow | Answers | Failures |
|---|---|---|
| `repo/tree { repo, revision }` | `{ paths, truncated }` | `RepoNotFound`, `RepoReadsPaused`, `RepoReadUnavailable` |
| `repo/read { repo, revision, path }` | `{ state: "text", contents, size }`, or `{ state, size }` for a binary file or one over 512 KiB | the same |
| `repo/refs { repo }` | `{ defaultBranch, head, branches, tags, truncated }`: the agent's way to a SHA for the reads, and to a branch or tag name for `app/navigate` | the same; `RepoNotFound` for a repository that isn't ready |
| `repo/about { repo }` | what GitHub says of the repository, cloned or not ([About](#about)); the page's, not the agent's | the same; `RepoNotFound` for one GitHub doesn't have |
| `repo/clone { repo }` | RepoApi's answer: `{ id, txid, attempt }` for a clone it started, `{ id, txid: null, status }` for one already cloning or ready | `RepoCloneRefused { reason }` (`sign_in`, `forbidden`, `limit`, `invalid`, `not_configured`), `RepoCloneUnavailable` |
| `repo/copy { repo, what, revision?, path?, kind?, line?, lineEnd? }` | `{ copied }` | `RepoCopyRefused { reason }` (`invalid`: a needed `revision` or `path` missing; `not_text`), or the read's failure for `contents` |

`repo` is `owner/name`; `revision` is a full SHA. The reads retry 1 s doubling to 15 s for 2 minutes, after RepoApi's `Retry-After`. `repo/clone` and `repo/copy` run once: a person waiting on their click answers a failure with Try again, and a copy that landed later would overwrite what they copied since.

### Cloning

`repo/clone` has two steps (`src/features/repo/clone.ts`). `repo/clone/request` is `POST /api/repos`, so RepoApi admits every clone (sign-in, the Member role, the repository cap and the budgets), persists it and answers at once. `repo/clone/launch` is `POST /api/repos/launch` for the attempt it answered, which starts the durable `repo/Clone` ([no remote door](remote-flows.md#no-remote-door)); its retry policy (1 s doubling to 15 s, for 2 minutes) tries again while RepoApi or the Durable Object can't take it, and the device's engine resumes it after a reload or a crash. A launch whose start conflicts with another payload (a bug: attempt ids never repeat) settles the attempt `failed` `unavailable`, never leaving it `cloning`. Its doors: Clone and Try again in the header, `/clone owner/name` for a Member or above, and the agent ("clone octocat/Spoon-Knife").

### Copy

`repo/copy` works out the text from its payload and puts it on the clipboard of the tab that asked:

| `what` | Text |
|---|---|
| `permalink` | the app's URL of `path` (`kind` `tree` for a directory, else `blob`; the root without a `path`) at `revision`, with `?L=` from `line` and `lineEnd` |
| `path` | `path` |
| `contents` | the file's text at `revision`, read through `RepoReader` |
| `clone-url` | `https://github.com/<owner>/<name>.git`, what `git clone` takes until Smithers serves git itself |

Its step runs in the leader tab's engine worker, which has no clipboard, so it asks over the engine's clipboard channel (`<name>/clipboard`, a `BroadcastChannel`, through `TabClipboard`) for the tab that started the request, as `app/navigate` asks for the tab to move ([navigation](flows.md#navigation)): a person's button is its own tab's request, and the agent's call belongs to the tab whose composer asked. Only that tab answers (`tabClipboard`, `src/features/repo/tab.ts`): it writes through the host's clipboard (`Host.clipboard`) and replies with its door and whether the clipboard took it. With nothing to copy, the step still asks, for the door, and the tab writes nothing. A tab that doesn't answer within 5 seconds (`COPY_WITHIN`) is gone: `copied: false`. The text never reaches the journal, a log or a span: the step's result is `{ copied }`.

## The browser

`src/features/repo/`, framework-free logic beside React views ([state.md](../state.md#repositories)).

| Piece | What it is |
|---|---|
| `repositories` | Electric collection over `/api/shapes/repositories`, decoded by `schema.ts` `Repository`, kept on the device (`schemaVersion` 4 for `refsChangedAt`; older device caches are dropped and resynced by `device/prepare` (decision 0021), with their deployed schemas and fingerprints preserved) |
| `trees`, `blobs` | local-only collections keyed `<id>@<sha>` and `<id>@<sha>:<path>`, in the states `RepoView` takes |
| `clones` | this tab's clone requests while they are on their way or were refused |
| `abouts` | local-only, keyed by the repository's id: what GitHub says of it ([About](#about)), `loading`, `ready`, `missing` or `failed` |
| `refs` | local-only, keyed `<id>@<head sha>`: the branches and tags as of the repository's sync, loaded once per tab through `GET /refs`, for the picker and for resolving a ref |
| `heads` | local-only, keyed by the repository's id: its ready head as `GET /refs` named it before Electric delivered its row ([a page's head](#a-pages-head)), `loading`, `ready` (the default branch and head commit; its branches and tags go into `refs`), `absent` (`404`: no ready clone) or `failed` |
| `clone(owner, name)`, `retryClone` | validate, show `cloning` at once, dispatch `repo/clone` (door `button`), wait for Electric to deliver the row. Not chat's outbox: RepoApi takes a clone idempotently, and it needs the network and sign-in anyway |
| `warmRoute(kind, params, search)` | what a route calls first, on a link's hover or focus and before every navigation ([navigation](navigation.md)): loads what GitHub says of the repository, then, once its clone is ready ([a page's head](#a-pages-head)), its branches and tags, the ref, the tree at its commit, and the file or the directory's README, without opening the view; ends once they loaded or failed, or after `pageWait` (1 s). A failed load, an absent or failed head included, loads again |
| `openRoute(kind, params, search)` | what a route calls once warm: opens the location in the view, reading what the warm loaded and asking for what isn't loading yet; a failure stays as the warm left it. Once it knows where the location is, a log line `repo.locate` and `smithers_web_repo_locate_ms` say how long that took and where the head came from (`row` or `refs`) |
| `copy(what)` | dispatches `repo/copy` for what the view shows (`copyPayloadOf`), door `button`; resolves once the text is on the clipboard, rejects `NotCopied` otherwise |
| `navigate(to)` | a ref chosen in the picker: dispatches `app/navigate` to the same location at that ref, door `button` |
| `rawRoute(params)` | the raw route's navigation: once the ref resolves, RepoApi's raw route of the file at its commit |

Screens: `/$owner/$repo` (`src/screens/repo/RepoHomeScreen.tsx`: the repository's own home when it declares one, else this view; [home.md](home.md)), `/$owner/$repo/tree/$ref/$` (the branch workspace) and `/$owner/$repo/blob/$ref/$` (`src/screens/repo/RepoScreen.tsx`), with `?L=<n>` or `?L=<a>-<b>` marking lines. `$ref` is a branch, a tag or a full SHA, resolved as GitHub does (`resolveRef`, `paths.ts`): a SHA reads at itself and the default branch at its head at once; any other name waits for the branches and tags, and a name with a `/` arrives split across `$ref` and the path, so the longest name leading them wins, a branch over a tag of the same name. A ref the repository doesn't have shows Not found; branches and tags that couldn't load show why. `/$owner/$repo/raw/$ref/$`, GitHub's raw path, opens the file's view, and once the ref resolves loads RepoApi's raw route in place of the app (TanStack Router's `redirect` with `reloadDocument`).

### A page's head

A file reads at a commit, so a page needs the repository's ready head first. The device's synced row has it once Electric delivers it; RepoApi's `GET /refs` reads the same row in Postgres directly and answers it with every branch and tag. A device that has the ready row reads at its head and asks RepoApi nothing. Without it (a visitor's first page, a device whose shape is still on its way, a cold shape that takes many seconds) the page waits for whichever answers first: Electric's ready row, or the refs' ready head (`heads`). So a file shows as soon as RepoApi answers its refs and the file, never after the shape. The refs claim nothing they don't know: a `404` (`absent`) says only that Postgres has no ready clone, and a refused or unreachable read (`failed`) says nothing, so both leave the page to the row, which says whether the repository is not cloned, cloning or refused, and which a clone that settles later delivers. A navigation's warm asks again after an absent or failed head. The view row keeps the location's `revision`, `sha` and the repository's `defaultBranch`; a `sha` means the load found the clone ready, so the page shows its files from the row once ready, else from the view (`shownOf`, `view.ts`). The head commit's row is the synced row's, else GitHub's newest commit when it is the view's commit (`headCommitOf`). What the page shows is `pageOf` (`view.ts`): loading, Not found, why a ref couldn't resolve, About's Try again, GitHub's preview loading or shown, Not cloned or Cloning, or the files.

**The top level** (`/$owner/$repo`, or a ref's root) is laid out as GitHub's repository page: no tree on the left, the folder's listing with its README under it, and the about panel on the right (`RepoAside.tsx`: `@smthrs/ui`'s `RepoAbout` and, for a reclaimable copy, the [reclaim note](#reclaiming)), moving under the files when the page is narrow. Beside the picker it counts the branches and tags (the clone's own once its refs loaded whole, else GitHub's), and the commit row ends with GitHub's commit count. **Before the clone is ready**, the same page shows what GitHub says: its top folder (`RepoView`'s `directories` for folders it lists without their files), its README, the default branch, the counts, the newest commit, Code and the about panel; the header offers Clone. While GitHub's answer is on its way the page keeps that layout with skeletons in its places; GitHub's 404 says Not found in the page and header before anyone clicks Clone (the Clone action remains, or sign-in for a signed-out visitor); a terminal About failure shows GitHub limit reached, Reading paused, or Couldn't load with Try again. Below the top level, a repository that isn't ready shows the Not cloned card.

A Clone in progress takes precedence over a stale failed About read, so the Cloning bar remains visible.

**A file's view:** A Markdown file opens as a WYSIWYG document (Milkdown): editable for a person who may write the branch, read-only for anyone else or when anything needed to write is missing (Will, 2026-10-20 18:17). Its source is one press of Code away, with Raw beside it. May write means the branch's page tracked it and this person is its Owner or has Can edit, on a branch open to changes: never the locked default branch, a tag or a commit, nor while signed out, offline or with view-only access (`writable` in `src/features/branch/actions.ts`). Then the page's route opens the file's shared text (`openBranchPage`'s `file`, `coedit.actions.showFile`), the text everyone editing the branch's file types together, seeded from the working copy ([coedit](coedit.md#files)); once it has loaded, `@smthrs/repo-view`'s `RepoView` shows `LiveMarkdownEditor` over it in the read-only document's place (`markdownPreview`, `markdownInPlace` in `src/features/coedit/view.ts`), with Save in the file's toolbar, which writes the working copy through `sandbox/write` and says Saved on every editor's screen. Until then, and if the text can't be read, the document stays read-only. A directory's README under its listing is always read-only; its name opens the file's own page. In a branch's workspace a writer's file links open the live editor (`?edit`), except a Markdown file's, which opens its own page (`viewHrefFor`, `paths.ts`). An HTML file opens as code with Code, Preview and Split, as CodePen shows it: the page runs in `@smthrs/repo-view`'s `HtmlPreview`, a frame sandboxed to `allow-scripts` alone (an opaque origin: no app, storage or cookies) under a policy with no network, and a page that navigates itself is put back. A [generated file](#generated-files) carries the Generated chip.

The page (`RepoPage.tsx`) shows, beside the path trail, `@smthrs/ui`'s `RefPicker` (the branches and tags counted on their tabs, a filter, each commit's short SHA, a full SHA typed in the filter offered too; every choice a link, a plain click `navigate`), **Code** (a `Popover` with the clone URL in a `Snippet`, whose Copy runs `repo/copy`), and **Copy permalink**. A file's toolbar adds **Raw** (a new tab; a file over 512 KiB opens GitHub's raw URL), **Download** (the raw route, saved under the file's name), **Copy path** and **Copy** for a text file's contents. Each Copy is a `CopyButton`, which shows Copied once the flow says so. The head commit's row shows only at the head; another commit's details aren't on the device. `src/router.tsx` keeps only `?L=` in each route's search (`validateSearch: lineSearch`, `paths.ts`), and gives it a `beforeLoad` that warms the location (`warmRoute`), then opens it (`openRoute("tree" | "blob", params, search)`) on the repository layer in the router's context (`createRootRouteWithContext<RouterContext>`), which main.tsx passes to `RouterProvider`; a link's hover or focus only warms it ([navigation](navigation.md)). In `appLayer` (`src/boot.ts`) the repository layer sits beside chat, sign-in and the theme: `Repo.layer` over `RepoStore.layer({ origin })`, which reads sign-in's own `AuthStore` row, `RepoClient.layer({ origin, within: REQUEST_WITHIN })` and `FlowDispatch`; beside navigation's answers, `tabClipboard` answers the engine's clipboard channel over `Clipboard.layer(host.clipboard)`; main.tsx's clipboard is `navigator.clipboard.writeText`. The header starts with Back to chat ([in the chat](#in-the-chat)), then shows `owner / name`, a link to `/$owner/$repo`, and Clone, once the repositories' shape has answered (its rows or a failure; before that a repository this device hasn't seen offers nothing, since its row may be on its way); nothing while cloning, when the files' place says Cloning with a calm bar along its top; "Sign in to clone" for a signed-out person; or why a clone failed or was refused, with Try again; its last slot is the person's notifications bell, which these screens don't float over the page (`BELL_ROUTES`, [notifications](notifications.md)). A missing repository or file shows "Not found".

## In the chat

A repository lives in the chat shell (ruling FE-9; Will, 2026-10-19 20:43: "Note this should be an embedded app though"). `/repo owner/name` and the agent's `ui/repo` add the repository's own view to the conversation, small: `RepoView` at `size="inline"`, its location's directory with its README, or its file ([a repository and its issues](views.md#a-repository-and-its-issues)). Its Full screen opens this page, the repository's URL, so the page is that view at full size and a deep link lands on it. The header's Back to chat minimizes the page: back to the page the view was opened from, or, opened by its URL, into the home conversation, which gets a view of the location unless it shows one already (`src/features/views/minimize.ts`). The agent's `app/navigate` and `file/open` open and move this page as before ([files](files.md)).

## Generated files

A file a flow produced, such as a cached build step's output, carries a quiet Generated chip in its toolbar (`@smthrs/ui`'s `GeneratedChip`, `src/features/repo/components/FileMarks.tsx`). Pressed, it opens the flow that produced it (the manifest's `source`, else `.smithers/flows/<tag>/flow.ts`), its last run (`/app/runs/<run>`), and its inputs, each a link at the view's commit where the repository has it. The branch workspace's editor of a generated file shows one warning over it, with a link to the source to edit instead.

What counts as generated (`src/features/generated/detect.ts`), first match wins:

1. **The nearest manifest**, `.smithers/generated.json`, read at the view's commit (256 KiB of UTF-8 at most). The repository's root and any project folder inside it may hold one; the view reads the one in the file's own folder, else the nearest folder above it (`nearestManifest`), and a manifest marks only files under its folder, by their paths from it. `docs/generate` writes one (`docs/design/vibelang-readme/docgen/.smithers/generated.json`):

   ```json
   { "version": 1, "outputs": { "out/CONTRIBUTING.md": {
       "flow": "docs/generate", "source": ".smithers/flows/docs/flow.ts",
       "inputs": [{ "path": "project.ts", "sha256": "6bd0…" }, "render.ts"],
       "cacheKey": "7211…", "sha256": "cdca…", "run": "r-91" } } }
   ```

   Each output names its flow's tag, and optionally the flow's source file, its inputs (a path, or a path with the hash the build saw), its build's cache key, the output's own hash and the run that last produced it. Anything else a generator records, such as its toolchain, is ignored. A manifest that doesn't read, or has another `version`, marks nothing.
2. **A header marker** in a file's first five lines: `@generated` on its own line, or `@generated` or Go's `Code generated … DO NOT EDIT` at the start of a comment. Marker text in ordinary code or prose does not count. It names no flow, so the chip is plain.

It is a contribution to the repository's file view (`src/features/generated/contribution.ts`: an id, the place it draws, `repo.file`, and the pure decision), as data a plugin manifest can declare once the plugin host of decision [0017](../decisions/0017-everything-is-a-plugin.md) lands.

## Configuration

| Variable | Default | |
|---|---|---|
| `CODE_STORAGE_ORG` | none | the Code Storage organization (`smithers`); without it, or without the key, the deployment clones nothing (`503 not_configured`) |
| `CODE_STORAGE_KEY` | none | the organization's ES256 key, a PKCS#8 PEM; a redacted secret |
| `CODE_STORAGE_API_URL` | `https://api.<org>.code.storage` | |
| `GITHUB_TOKEN` | none | a bot token for the size call and a Member's about read of a repository without the App. Unset, they read as the GitHub App when the deployment has one: an installation token for `GITHUB_REPOSITORY` with Metadata read only, kept until 5 minutes before it expires (`worker/github/ReadToken.ts`). Either gives 5,000 calls an hour or more; neither, 60 an hour per IP address, which a Worker shares with every other Worker on Cloudflare's addresses. A repository the App is installed on is read with its own installation's token ([whose quota](#about)) |
| `GITHUB_API_URL` | `https://api.github.com` | where the about read reaches GitHub |
| `GITHUB_APP_SLUG` | `smithers` | the Smithers GitHub App's name in its URL: where Install goes |
| `REPO_ABOUT_FRESH_MINUTES` | `10` | how long an about answer read with a token is fresh |
| `REPO_ABOUT_ANONYMOUS_FRESH_MINUTES` | `60` | how long an anonymous about answer is fresh |
| `REPO_MAX_REPOSITORIES` | `100` | `cloning` and `ready` rows |
| `REPO_MAX_STORED_GB` | `3` | their stored bytes together |
| `REPO_MAX_READ_GB_PER_MONTH` | `40` | Code Storage reads this UTC month |
| `REPO_MAX_SIZE_MB` | `1000` | one repository's size on GitHub |
| `REPO_BUDGET_USD` | `20` | the base of the spend alerts |
| `REPO_TREE_MAX_PATHS` | `50000` | paths a tree lists before it answers `truncated` |
| `REPO_MAX_REFS` | `1000` | branches, and tags, a refs listing names before it answers `truncated` |
| `REPO_CLONE_DEADLINE` | `10 minutes` | how long after the request the sync may take |

ChatApi and the Durable Object read them with Effect `Config` (`worker/RepoConfig.ts`, `worker/Repos.ts`, `worker/RepoReads.ts`), so Alchemy binds each one that is set. On this Mac the key is `CODE_STORAGE_API_KEY` in `~/.zshrc`: map it to `CODE_STORAGE_KEY` and set `CODE_STORAGE_ORG=smithers`.

The App read token is shared in an isolate only as a value: the minted token and its expiry. A read that finds none, or one within 5 minutes of expiry, mints its own and never waits on another request's mint, since workerd cancels a request that waits on another request's permit or I/O as hung (decision [0104](../decisions/0104-request-owned-worker-io.md)). Concurrent first reads on a cold isolate may each mint one token; the last one minted is kept. A failed mint leaves that read anonymous and the next read mints again. Each mint counts `github_token_mints{kind="read",outcome}` (`minted` or `anonymous`) and logs `github.read_token` with its `outcome`, and `durationMs` or GitHub's `errorCode`. GitHub calls remain through the library catalog's `@smthrs/integrations` AppAuth and GitHubClient.

An [issues read](issues.md#sync) with stale sync state also awaits `github/Reconcile` admission inside its request, for at most 2 seconds beside its shape read. The Durable Object admits one execution per repository and 5-minute bucket. The isolate remembers admitted buckets as completed values; failed or timed-out admission leaves the read usable and can be requested again. No admission runs in an isolate scope. `github.reconcile.start` and `github_reconcile_starts{outcome}` record `started`, `timed_out` or `not_started`, with an error code on timeout or failure.

## Tests

| Test | Proves |
|---|---|
| `worker/github/ReadToken.test.ts` | configured bot or App token, anonymous fallback and recovery, expiry refresh, a read that mints for itself while another read's mint is still in flight, and each mint's count and log by outcome without the token |
| `worker/GitHubShapes.workerd.test.ts` | in workerd, through the bundled GitHub shape routes with the App configured, sign-in's sessions, real Postgres and Electric: eight signed-out and eight signed-in (a Member whose role check is due) first reads on a cold isolate, then each reader's 16 catch-up and live reads at once, all answer 200; the old shared permit failed 7 of the 8 signed-out first reads as hung while the Member's all answered |
| `worker/RepoApi.test.ts` | the about route over a scripted GitHub (`worker/test/githubRest.ts`): every part, cached for its window, parts GitHub refuses left out, a rate limit failing the whole read uncached, 404 for missing or private, 503 for GitHub down; every route and refusal through RepoApi's real handler over the compose Postgres and Electric, with each clone's intent on an in-memory Durable Object storage and its run on the Node host: 202 then `ready`, a second request starting nothing, Try again's attempt 2 under a new id, a database reset that kept the Durable Objects (attempt 1 again starts and settles), a conflicting start settling its attempt `failed`, sign-in, a Guest's and a role-less person's 403, bounds, `repository_limit`, Postgres down and a start refused; trees page by page and truncated; files, binaries, 413 with and without a size, 404; raw files as plain text or bytes, never sniffed, sharing the file's cached read; the branches and tags cached under the head, paged and truncated at `REPO_MAX_REFS`, 404 before ready, 503 with `Retry-After`; the cache serving repeats and reads over budget; `Retry-After`; the meter; spend alerts once per threshold; the agent's flows over the server reads; the shape; and no file content, commit message or Code Storage text in telemetry |
| `worker/flows/RepoClone.test.ts` | `repo/Clone` on the Node host: the asker's feed row through requested, fetching with its size, indexing and done; a failure's reason and Try again raising it again; reclaimable unless the App is installed; Index only for a ready sync that owns its row, its list and the App best effort; ready with its head and metered import; `not_found` and `empty` with no Code Storage call; each budget's `capacity`; two imports for the last headroom; `timed_out`; a conflicting upstream; a stale attempt; a run from before a reset, also attempt 1, writing nothing to the new row; a run killed mid-step resumed by a new engine with no second create; each step's transient and refused failures |
| `db/Database.test.ts` | `0009_clone_ids`: every row gets its own UUID, a `cloning` row settles `failed` `unavailable`, the others keep their status; `0028_clone_progress`: ready copies reclaimable unless the App was known installed, a running clone at `fetching`, `clone` feed rows with a run's states, and stages bounded |
| `worker/ExecutionHost.test.ts` | the Durable Object's handlers run `repo/Clone` to the end over the app's tables (`withRepoClone`) |
| `worker/RepoUpstream.test.ts` | HEAD and size from the real GitHub; the token sent only when configured; rate limits as `size_unknown` until GitHub's reset; 404 and 5xx |
| `worker/RepoConfig.test.ts` | no organization or key clones nothing; a bad key is logged by code, never printed; the clone's services from `Config`, Index retried when nothing answers; whether the App is installed: yes, 404 as no, anything else retried |
| `worker/RepoClone.live.test.ts` | the whole clone of `octocat/Spoon-Knife` into the real organization, then its tree and README through the GET routes; skips without `CODE_STORAGE_ORG` and `CODE_STORAGE_KEY` |
| `packages/effect-code-storage/test/Live.test.ts` | the real organization's mirror of `octocat/Spoon-Knife` lists every branch, the default one at GitHub's head |
| `src/features/repo/*.test.ts` | the browser's machine through its actions and queries against RepoApi's real handler and Electric on two tabs, each tab dispatching to an engine of its own on the Node host (`src/test/repoDevice.ts`): Clone through `repo/clone`; a branch, a tag and a name with a slash read at their commits; refs that couldn't load; the picker's `app/navigate`; GitHub's raw path; each Copy through `repo/copy` onto the tab's clipboard, a refusing clipboard and a binary's contents; the agent's `repo/refs`, `repo/clone` (signed out, a Guest) and `repo/copy` (no tab to answer, nothing to copy) as the engine worker registers them (`repoFlows`); the clipboard channel's door for the agent's call, and stray replies (`copy.test.ts`); faults through a faulty `RepoClient` and an engine that refuses every dispatch; what GitHub says of a repository nobody cloned (its folder, README and about at once, loaded once per tab), one GitHub doesn't have, one GitHub can't answer for a moment shown once it answers, with no reopen; the generated-files manifest beside a file and a directory, linking its flow and sources |
| `src/features/repo/visitor.test.ts` | [a page's head](#a-pages-head), with the repositories' shape held by the faulty shape source: a file opened by its URL on a device with no rows shows within 5 s once RepoApi answers, its head from `GET /refs` and the picker's branches with it; the next file asks the refs nothing more; a directory and its README; a missing ref Not found and a missing file's Not found; a repository nobody cloned claims nothing until the shape says Not cloned; a failed refs read asked again by the next warm and the file shown from the row once Electric delivers it; a device with the ready row asking the refs nothing |
| `src/features/repo/view.test.ts`, `contract.test.ts` | the first visit's pure parts: the about panel's props and links, GitHub's folder, README and newest commit, the counts, the reclaim note, generated links; what the page shows (`pageOf`, `shownOf`) and the head commit's row (`headCommitOf`); the clone's `ref` and its words |
| `src/features/generated/*.test.ts` | the manifest's shape and bounds; header markers in the first five lines only; the manifest winning over a marker; the chip's and the warning's links |
| `src/features/attention/entries.test.ts`, `detail.test.ts`, `attention.test.ts` | a clone's entry: `Clone · <repository> · <stage>`, Try again on the person's failed clone, which runs `repo/clone` from the person's button |
| `packages/smithers/ui/tests/repo-about.test.tsx`, `generated-chip.test.tsx`; `repo-view/test/repo-view-first-visit.test.tsx` | `RepoAbout`'s parts and links; `GeneratedChip`'s plain and linked forms; `RepoView`'s about column with no tree, folders known by name, file badges, Code, Preview and Split, and `HtmlPreview`'s policy, sandbox and remount on navigation |
| `src/boot.test.ts` | the app's own layer: `boot` renders the repository layer; a route opened through it syncs `repositories` from the app's RepoApi and Electric, shows "Sign in to clone" from sign-in's own row, and Copy permalink runs `repo/copy` on the device's leading engine, which writes the host's clipboard |
| `src/flows/registry.test.ts` | `repo/tree`, `repo/read`, `repo/refs`, `repo/clone` and `repo/copy` are client flows in the agent's catalog |
| `packages/smithers/ui/tests/ref-picker.test.tsx`, `copy-button.test.tsx` | `RefPicker`'s list, counts, filter, SHA, keys, links and states; `CopyButton`'s copied, failed and in-flight states |
| `e2e/repo.spec.ts` | in real browsers: two devices see the cloned repository; a file from the listing, a line anchor across a reload, Copy permalink at the head commit; Not found for a missing repository and file, alongside exactly one Connection live region on the missing repository's page. It skips locally without `CODE_STORAGE_*` |
| `e2e/repo-extras.spec.ts` | on `octocat/Spoon-Knife`: the picker lists its three branches, filters and opens `test-branch`; GitHub's file URL on the branch; Raw as plain text in a new tab, Download, and GitHub's raw path by domain swap; Copy permalink, Copy path, Copy and the clone URL on the clipboard |
| `e2e/vibelang-visitor.spec.ts` | signed out, on the deployment's clone of `smithersai/vibelang`: a Markdown file and a code file opened by their URLs show the document and the highlighted code, Code the one current tab, and the page makes no `POST /api/branches` or credential request |
| `src/features/branch/branch.test.ts` "a blob page's Markdown file opens in the live editor in place only for someone who may write the branch"; `src/features/coedit/view.test.ts`; `src/features/repo/paths.test.ts` "Markdown edited in place"; `packages/smithers/ui/repo-view/test/repo-view.test.tsx` "a host's Markdown preview" | the blob page's route opens a Markdown file's shared text only for a writer of an open branch (the person's own), never on the locked default branch, a code file or a branch GitHub doesn't have, and `writable` says so; a page edits in place only a Markdown file whose text loaded, never one loading or failed; a writer's workspace links Markdown to its page and other files to the live editor; `RepoView` shows the host's preview in place of the read-only document in preview mode only, an empty file's included, never for code or a directory's README |
| `e2e/markdown-edit.spec.ts` | in a real browser, with Code Storage and the branch's machine: a writer opens a Markdown file's page on a branch they may write (the test account's own on a deployment, Spoon-Knife's `test-branch` locally), types in the document, saves, sees Saved, keeps the edit across a reload and finds it in the working copy; the locked default branch's same file is read-only; locally, a Guest reads the file's page with no Save |
| `e2e/repo-browse.spec.ts` | in a real browser: a repository nobody cloned (`octocat/linguist`) shows GitHub's folder, README, about panel, counts and newest commit at once, never the Not cloned card; the header's bell in its own slot after Clone, apart from it at 1280 px and at a phone's 390 px; and, with Code Storage, a clone's toast through Not found and Try again, the reclaim note with Install, a Markdown file as a read-only document with Code one press away, and an HTML file's Preview and Split whose frame reaches neither the app nor the network |
| `e2e/repo-clone.spec.ts` | `/clone octocat/Hello-World` runs `repo/clone` (its relayed `repo.clone` line) and the repository opens ready; asking the agent to clone `octocat/Spoon-Knife` settles an answer with a `repo/clone` step |

Code Storage and GitHub are third-party providers, scripted like the model (`worker/test/codeStorage.ts`); the live tests use the real ones.

## Not built yet

- Reclaiming: a durable flow that frees a reclaimable copy when the storage budget needs room, re-checking the App first; and clearing `reclaimable` when the App is installed on a repository later (its installation webhook). Today the copy is marked, and nothing deletes it ([work note](../work/repo-clone-reclaim.md)).
- `repo/SetImports`, the operator's pause switch as a flow (`repo_imports.paused` is read; nothing writes it yet).
- Delivering `repo.spend.alert` to Will, with the token-spend alert.
- Several highlighted ranges in one file (0004 §7): `CodeFileView` marks one range.
- Stopping showing a repository made private or deleted after cloning ([repo open states](../work/repo-open-states.md)).
- Go to file through the command palette's path mode ([command palette](../work/command-palette.md)).
- Serving git: the clone URL is GitHub's until Smithers serves git itself.
- Another commit's details (message, author, age) beside a branch, tag or SHA other than the default branch's head.

## Repository page boundaries

Issues, pull requests, Stack, Secrets and Runs retain the repository header and home navigation on direct visits. For repositories outside `GITHUB_REPOSITORY`, issue and pull-request lists link to GitHub, and new issues open on GitHub. Deployment-only controls fail closed until About identifies the configured repository. See decision [0102](../decisions/0102-repository-page-boundaries.md).

## Mirror freshness

[Decision 0105](../decisions/0105-mirror-freshness.md).

Public Code Storage mirrors do not subscribe to GitHub themselves. A verified App push for **any installed
repository**, including a deleted ref, requests `repo/Refresh`, independently of `REPO_FLOWS` and the deployment's
issue/PR repository. The delivery ID names the execution, so redelivery resumes the same work. Repositories without
an admitted, ready clone are skipped; a webhook cannot bypass clone admission.

`repo/RefreshInspect` checks GitHub and the stored clone, `repo/RefreshPull` requests Code Storage's upstream pull,
and `repo/RefreshSettle` waits for Code Storage's default-branch commit to equal GitHub's current head. The engine
owns all retries. A busy pull is retried; an accepted pull is journaled and is not repeated while waiting for sync.
Settle compares the previously read database head before updating it, so racing refreshes retry instead of
publishing an older head. It advances `refs_changed_at` even when only another branch or a tag changed.

A missing tree or file probes the commit separately: a missing path at an available commit remains `404 not_found`;
a commit absent from an admitted mirror is `503 not_synced`, uncached, with `Retry-After: 2`. That read requests the
same durable refresh used by push deliveries. The view says **Not synced yet** with **Refresh**; a missing branch
also offers this recovery, and Refresh discards its tab's mutable refs listing. Refs reads and an explicit Clone
of an existing ready repository request refresh too. Read-driven requests share one execution per repository per
minute, across tree, blob and refs requests. A failed start never claims sync completed.

This deliberately uses the not-synced fallback: the current Code Storage SDK exposes a whole-mirror
`pullUpstream`, not a scoped upstream fetch. The sandbox's scoped git transport is not a Code Storage mirror-write
API. No raw git transport or invented provider option is used. The SDK remains the library catalog's
“Import a public GitHub repository into git hosting and read its files and commits” entry.

Records: `repo.refresh.inspect`, `.pull`, `.settle` spans, `repo.refresh` logs with stage/ref/outcome, and
`repo_refresh_steps{stage,outcome}`. No file content, commit messages or credentials enter these records.
Regression coverage is in `worker/flows/RepoRefresh.test.ts`, webhook API tests and the repository device suite.
`e2e/vibelang-highlighting.spec.ts` additionally obtains GitHub's newest commit and compares its README with
Smithers' tree/blob responses; it runs locally or against a deployment with the declared Code Storage/member needs.

Optional blob reads use `?optional=true`: an absent file at a readable commit returns
204 with no body. Missing repositories, unsynced commits and provider failures retain
their error responses. Repository homes use this query so an absent `.smithers/home.json`
does not produce a failed browser request.

## Visibility of repository rows

For visitors, a current GitHub metadata read must say the repository is public (decision 0012). “Current” means at most 60 seconds old. Each Worker isolate shares only completed answers by repository ID, retaining public and private-or-gone answers for 60 seconds. A cache miss makes its own request, including concurrent misses; no request waits on another request's I/O. Unavailable answers are never cached and refuse reads with 503. A private-or-gone answer refuses visitors.

Curated public repository homes use the deployment read token for visitors too. These repositories are explicitly
listed by the deployment, so arbitrary visitor input cannot spend that quota. They use REST, including its private
repository refusal, since the deployment installation token need not have GraphQL access to that repository.
The existing shared About cache and rate-limit holds still apply; real upstream failures remain errors.


A cached About rate limit records its quota (`refusal_via`). A curated public home with no usable answer may replace
an anonymous or legacy rate-limit hold with one deployment-token read. The database claim clears the refusal atomically;
concurrent visitors wait for that read. Authenticated holds and other refusals remain in force. `repo.about` records
`refusalVia` and `retryAfterMs` when serving a held refusal, without credentials or provider response text.

GitHub file fragments (`#L72`, `#L5-L12`) select and reveal their lines, including when only the fragment changes. Existing `?L=` links remain supported.

A missing file names its revision and links back to Code. Browser file reads use `?optional=true`: a confirmed absent path at a readable commit is `204`, so a normal missing-file page produces no browser error. Missing repositories and unreadable commits retain their error status.

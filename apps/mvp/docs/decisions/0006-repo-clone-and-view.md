# 0006: Clone a public GitHub repository into Code Storage, and view it

Status: proposed (feature 2 owner, 2026-10-19). Will's three questions are at the end; the build proceeds on the recommended answers. Built as [repo.md](../features/repo.md) describes (2026-10-20), which differs from this text in five places: cloning needs sign-in and the Member role or above (decisions 0008 and 0007), because a clone spends the deployment's Code Storage budget, where §1 below says the person cloning needs nothing; `repo/AwaitSync` is a step whose retry policy waits (2 s doubling to 30 s) and which answers `timed_out` itself, not a `Poll.make` (a poll's backoff can't cap at 30 s); `repo/tree` and `repo/read` run on the device and read through RepoApi's GET routes (decision 0011 §2: neither needs the key), not remotely; a failure `empty` joins `not_found`, `unavailable` and `timed_out`; and a clone's execution is keyed, and its writes fenced, by the attempt's own UUID `clone_id`, not by `attempt`, a counter that restarts when the table is reset while the Durable Objects keep their executions ([execution ids](../features/repo.md#execution-ids)). The extras §2 dropped as having no backing were built later the same day: the branch and tag picker, any branch, tag or commit in the routes, Raw and Download, Copy path and Copy, and the Code menu with the clone URL, every one a registered flow ([repo.md](../features/repo.md#flows)). The embed (§2, "The embed") was built 2026-10-25 as the `repo` template ([in the chat](../features/repo.md#in-the-chat)): inline as described, with no tree, but Open is Full screen and goes to the repository's own URL rather than `/app/views/$viewId` (ruling FE-9), and the view keeps no `views.state`.

## Decision

1. **Pierre's git provider is Code Storage** (code.storage). Smithers clones a public GitHub repository into it as a one-time public sync: no GitHub App and no GitHub token. Smithers holds one Code Storage organization key on the server. The person cloning needs nothing: no sign-in, no key, no install.
2. **A new SDK package, `@smthrs/effect-code-storage`,** is the Effect client for Code Storage's HTTP API: Effect `HttpClient`, Effect `Schema`, and ES256 JWTs signed with WebCrypto. It also reads any git remote's HEAD over smart HTTP with no credential (`GitRemote.head`). It has no new dependencies and runs in a browser, a Worker, Node and Bun. It does not wrap the `@pierre/storage` SDK (see [Why](#why)).
3. **Cloning is the durable flow `repo/Clone`** on the Cloudflare host from the lead's durable-answering plan ([HOST-PLAN]). Its steps are Inspect, Import, Pull, AwaitSync (a durable `Poll`) and Settle, within a 10-minute `Deadline`. Retries, timers and resumption belong to the engine, never to the app.
4. **Repository metadata lives in Postgres** (`repositories`), and Electric syncs it to every device. One row per repository holds its status, default branch and head commit.
5. **File contents are not copied into Postgres.** The tree and file bodies are read from Code Storage at a commit SHA, so they never change. The view reads them through RepoApi's `GET` routes, whose responses cache forever. The agent reads them through the flows `repo/tree` and `repo/read` ([0004](0004-agent-ui-codemode-and-rendering.md)'s catalog). One implementation serves both.
6. **The view is `RepoView`** (`@smthrs/repo-view`, imported from its root), built on `FileTree`, the new `Breadcrumbs` and `DirectoryListing`, `CodeFileView` (`@pierre/diffs` `File`) and `MarkdownEditor` (Milkdown). It fetches nothing, and the host owns its location. One component serves the routed page (`size="full"`) and [0004](0004-agent-ui-codemode-and-rendering.md)'s `repo` template (`inline` in a message, `full` at `/app/views/$viewId`).
7. **Routes** follow GitHub's paths: `/$owner/$repo`, `/$owner/$repo/tree/$ref/$` and `/$owner/$repo/blob/$ref/$`. Changing the domain from github.com opens the same view.

## Why

- **Code Storage is real git, built for programmatic use:** clone, push and fetch over HTTPS with per-repository JWTs. Features 5 and 7 need exactly that: sandboxes clone through the egress proxy, which adds a short read-only token so the sandbox never holds one, and branches and commits go back as flow steps ([0005](0005-sandboxes-secrets-and-the-forge.md)). A read-only GitHub proxy (DiffsHub-style raw reads) needs no key, but it stores nothing and has no write path.
- **"No API key or app install" holds for the person cloning, not for Smithers.** Every Code Storage request carries a JWT signed by a key registered to a paid organization. Unauthenticated `GET /api/repos/x/files` and `git info/refs` both answer `401 unauthorized` (research, 2026-10-19). What public mode removes is the GitHub App: `upstream: { provider: "github", owner, name, access: "public" }` mirrors a public repository with no GitHub credentials.
- **Effect-native over the HTTP API, not the Promise SDK** (rules `effect.native-api-first`, `effect.wrap-every-library`):
  - `@pierre/storage` 1.17.1 sends the deprecated `/api/v1/...` routes and the deprecated `base_repo` body.
  - It brings `jose`, `zod` 3 and `snakecase-keys`.
  - It throws `ApiError` with the provider's `detail` text, which must never reach telemetry (`obs.content-free`).
  - The documented API is small: seven endpoints, problem-details errors and cursor pages. Effect's `HttpClient` plus WebCrypto ES256 covers it with no dependency.
- **`@pierre/diffs` already renders files and diffs in `@smthrs/ui`** (`CodeFileView`, `PierreDiffView`, 1.3.6). `@pierre/trees` is beta-only on a Preact beta, so the tree stays our `FileTree`.
- **Metadata in Postgres, bodies by SHA:**
  - The row is small and shared, and it must reach every device live: "cloning", then "ready". That is Electric's job ([0001](0001-electric-postgres-tanstack-db.md)).
  - Trees and blobs are already in Code Storage and never change at a SHA. Copying them into Postgres would duplicate the provider and bloat the shape log.
  - HTTP caching of immutable responses gives repeat views at no cost.

## Code Storage facts this design relies on

All of these come from the OpenAPI at `code.storage/docs/openapi.json`, checked 2026-10-19.

| Need | Endpoint | Scope | Notes |
|---|---|---|---|
| Create, idempotent | `POST /api/repos` `{repo_name, default_branch, upstream}` | `repo:write` | 201 created; 200 already exists; 409 exists with a different upstream |
| Start the sync | `POST /api/repos/{r}/upstream/pull` | `git:write` | 202. While the first sync runs, calls answer `409 sync_in_progress` |
| Head commit | `GET /api/repos/{r}/commits?ref=&limit=1` | `git:read` | `{sha, message, author_name, date, ...}` |
| Tree | `GET /api/repos/{r}/files?ref=&recursive=true&limit=5000&cursor=` | `git:read` | `{paths, entries, has_more, next_cursor}` |
| Blob | `GET /api/repos/{r}/file?path=&ref=` | `git:read` | raw bytes; `Content-Length`, `X-Blob-Sha`, `ETag` |

- **Auth:** `Authorization: Bearer <JWT>`, ES256, with claims `iss` (the organization), `sub`, `repo`, `scopes`, `iat` and `exp`. A restricted key allows `exp - iat ≤ 3600`.
- **Errors:** problem details with a stable snake_case `code`. 429 carries `Retry-After`.
- **Cost:** Starter from $20 a month, a minimum and not a cap. Hot storage $0.005 per GB-hour (about $3.60 per GB-month), cold $0.0002 per GB-hour after 7 days untouched; inbound $0.06 and outbound $0.15 per GB. There is no free tier.
- **Public mode limits:** one-time sync, no LFS, and the upstream must stay public.

## Libraries used (`docs/libraries.md`)

- **`@smthrs/flow`** runs `repo/Clone`, through `Flow.make`, `Action.make`, `Poll.make`, `RetryPolicy.make` and `Deadline`. **`@smthrs/platform-cloudflare`** hosts it: `ExecutionObject` and `CloudflareRuntime`.
- **`@smthrs/effect-electric`** gives `ShapeProxy.make` on the server and `ElectricCollection.make` in the browser. **`@smthrs/effect-tanstack-db`** gives `Collection.local` and `LiveQuery.make`.
- **`@smthrs/ui`** gives `RepoView`, `FileTree`, `Breadcrumbs`, `DirectoryListing`, `CodeFileView` and `MarkdownEditor`.
- **`@smthrs/observability`** gives `Logger.layerStructuredJson` and the OTLP export.
- **`@smthrs/effect-code-storage`** is new: Code Storage has no catalog entry yet. Its row is in the registries below.

## 1. The backend

```
BROWSER                         CLOUDFLARE (Alchemy)                                   CODE STORAGE / GITHUB
clone(owner,name) ─ insert row ─▶ POST /api/repos ─▶ RepoApi ── ExecutionObject.start ─┐
  (Electric collection onInsert)  202 {txid} ◀────────  (insert row 'cloning', idempotent)│
                                                         DO alarm ─▶ repo/Clone flow ◀───┘
                                  repo/Inspect   GET github.com/<o>/<n>.git/info/refs ──▶ GitHub (no key)
                                  repo/Import    POST /api/repos {upstream: public} ────▶ Code Storage
                                  repo/Pull      POST /upstream/pull (409 in progress = ok)
                                  repo/AwaitSync Poll: GET /commits?limit=1 until not 409
                                  repo/Settle    UPDATE repositories SET status='ready', head_* … WHERE owned
repositories ◀── /api/shapes/repositories (ShapeProxy) ◀── Electric ◀── Postgres
tree/blob    ◀── GET /api/repos/<o>/<n>/tree/<sha> · /blob/<sha>/<path> ◀── RepoApi ◀── Code Storage (read)
```

### `repositories` (Postgres, migration `000N_repositories`)

| Column | Type | Meaning |
|---|---|---|
| `id` | text PK | `github/<owner>/<name>`, lowercased. It is also the Code Storage `repo_name` and the flow's key |
| `owner`, `name` | text | as the person typed them, for display |
| `status` | text | `cloning`, `ready`, `failed` or `capacity` |
| `failure` | text | `not_found`, `unavailable` or `timed_out`; set only when `failed` |
| `capacity` | text | `paused`, `storage`, `reads`, `too_large` or `size_unknown`; set only when `capacity` ([Capacity and spend](#capacity-and-spend)) |
| `stored_bytes` | bigint | GitHub's `size` × 1,024, written at admission |
| `retry_at` | timestamptz | when GitHub will give the size again; `size_unknown` only |
| `default_branch` | text | from GitHub's `HEAD` symref |
| `head_sha`, `head_message`, `head_author`, `head_at` | text, text, text, timestamptz | the default branch's head commit, set at Settle |
| `attempt` | int | which clone execution owns the row (1, then 2 after Try again) |
| `requested_at`, `settled_at` | timestamptz | |

`REPLICA IDENTITY FULL`, as `messages` has. Electric syncs the whole table through one `ShapeProxy` (`/api/shapes/repositories`), with the column list fixed by the host. It is one row per cloned repository, so every device holds the full list. A later repository launcher (`/`) reads the same collection.

### The flow `repo/Clone`

- **Key:** keyed by `repo-clone:<id>:<attempt>`. Started by `POST /api/repos` through the per-execution Durable Object. Its `start` effect is the idempotent `INSERT ... ON CONFLICT DO NOTHING` that returns the txid.
- **Steps:**

| Step | Kind | Does | Seals |
|---|---|---|---|
| `repo/Inspect` | read, sealed | `GitRemote.head("https://github.com/<o>/<n>.git")`. It reads only the first ref line of `info/refs`, with no key and no REST rate limit. `not_found` (401, 403 or 404: missing or private) and `empty` fail the clone. Then the size and admission ([Capacity and spend](#capacity-and-spend)) | `Admitted {defaultBranch, headSha, storedBytes}` or `Capacity {reason, storedBytes?, retryAt?}` |
| `repo/Import` | write | `CodeStorage.createRepo({ name: id, defaultBranch, upstream: github public })`. 200 and 201 both succeed; 409 means `unavailable` | `{created}` |
| `repo/Pull` | write | `CodeStorage.pullUpstream(id)`. `409 sync_in_progress` succeeds | none |
| `repo/AwaitSync` | `Poll.make`, 2 s doubling to 30 s | `CodeStorage.listCommits(id, { ref: defaultBranch, limit: 1 })`. `409 sync_in_progress` means not yet | the head commit |
| `repo/Settle` | write, irreversible | sets `status`, `failure` or `capacity`, and `head_*` `WHERE id = $1 AND attempt = $2 AND status = 'cloning'`, fenced with `RunStore.owned` (HOST-PLAN §5) | none |

- **Retries:** `RetryPolicy` retries 429, 5xx, transport faults, `repository_thawing` and `authentication_unavailable`. Nothing in the app counts attempts or sleeps.
- **Deadline:** `REPO_CLONE_DEADLINE`, default 10 minutes. Past it, Settle writes `timed_out`.
- **Try again:** a failed row's Try again sends `POST /api/repos` again. The server increments `attempt`, resets the row to `cloning` and starts a new execution. A row that is `cloning` or `ready` answers 200 and starts nothing.

### RepoApi (Effect-native Alchemy Worker)

| Route | Kind | Bounds |
|---|---|---|
| `POST /api/repos` `{owner, name}` | starts `repo/Clone` | Body at most 1 KiB. `owner` must match `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`. `name` must match `^[A-Za-z0-9._-]{1,100}$` and not be `.` or `..`. The first path segments `app`, `api` and `assets` are reserved. `REPO_MAX_REPOSITORIES` (default 100) caps the table: past it, 429 `repository_limit` |
| `GET /api/shapes/repositories` | read-only proxy | `ShapeProxy` with the protocol allowlist and no subset requests |
| `GET /api/repos/:owner/:name/tree/:sha` | read-only proxy | `sha` must match `^[0-9a-f]{40}$`. Reads pages of 5,000, up to `REPO_TREE_MAX_PATHS` (default 50,000), then returns `{paths, truncated}`. `Cache-Control: public, max-age=31536000, immutable` |
| `GET /api/repos/:owner/:name/blob/:sha/*path` | read-only proxy | Path at most 1,024 characters and 64 segments. Bodies up to 512 KiB (repo-ui-spec view 2); above that, 413 `{size}` without reading the body. Immutable cache. |

- **The agent's reads:** `repo/tree {repo, revision}` and `repo/read {repo, revision, path}` are `remote`, `modelInvocable` flows that return what the two `GET` routes return. They are keyed by their inputs, since a commit SHA never changes.
- **Who answers:** `worker/index.ts` forwards `/api/repos/*` and `/api/shapes/repositories` to RepoApi.
- **Configuration:**
  - `CODE_STORAGE_ORG`: Effect `Config`.
  - `CODE_STORAGE_KEY`: a redacted PKCS#8 PEM, an Alchemy secret.
  - `CODE_STORAGE_API_URL`: defaults to `https://api.<org>.code.storage`.
- **Where flows run:** `repo/Clone` runs in the same per-execution Durable Object class as `chat/Answer`. Feature 1's flow registry decides how flows are registered there.

### Abuse surface (auth comes later; `auth.open-but-bounded`)

Cloning spends money: storage, plus outbound reads.
- **Per repository,** a clone is idempotent: repeated clicks start nothing.
- **Per deployment,** `REPO_MAX_REPOSITORIES` caps the total.
- **Spend:** budgets, admission, metering and alerts are in [Capacity and spend](#capacity-and-spend).

### Capacity and spend

Starter's $20 is a minimum monthly spend, not a cap: Code Storage bills usage above it and never stops us. So capacity is a budget Smithers enforces, plus Code Storage's own refusals: `429 rate_limited`, 5xx, `409 repository_thawing` and `403 authentication_unavailable`.

**What Code Storage documents** (`code.storage/docs/llms.txt` and its pages, 2026-10-19):
- **No usage or billing API.** `meta.get` returns the cluster's provider, region and IP ranges. `repos.get` and `repos.list` return name, default branch, creation time and upstream, with no size.
- **No published rate limit.** A 429 carries `Retry-After`, the minimum delay, which wins, and an IETF `RateLimit` field. The gateway's capacity is dynamic, so it publishes no `RateLimit-Policy`.
- **Cold storage.** A repository untouched for 7 days goes cold. The next read answers `409 repository_thawing` with `Retry-After` until it is back.
- **Unknown codes** count as their status's generic code. The SDK maps them and keeps the original as `unknownCode`.

**A repository's size before import.** Neither Code Storage nor git's `info/refs` reports one, so there is no way around GitHub's REST API. Inspect makes one call, `GET /repos/{o}/{n}`, whose `size` is in KB, computed hourly, and 0 for a new repository. Without a token that call spends GitHub's 60 an hour per IP address, and a `304` is free only with a token. So Inspect sends `GITHUB_TOKEN` (an optional, redacted `Config`: a Smithers GitHub App or bot token, 5,000 an hour) when it is set. The client is `@smthrs/integrations`' `GitHub.GitHubClient` (catalog row "Touch GitHub"); its Node-only root is a listed violation to fix before R3.

**Budgets (Effect `Config`).** The defaults hold the worst-case month to about $17 of usage, under the $20 minimum:

| Config | Default | Counts | Worst-case month |
|---|---|---|---|
| `REPO_MAX_STORED_GB` | 3 | `stored_bytes` over `cloning` and `ready` rows, all priced as hot | $10.80 |
| `REPO_MAX_READ_GB_PER_MONTH` | 40 | `code_storage_usage.bytes_read`, this UTC month | $6.00 |
| `REPO_MAX_SIZE_MB` | 1,000 | one repository's GitHub `size` | within the 3 GB |
| `REPO_MAX_REPOSITORIES` | 100 | `cloning` and `ready` rows | |
| `REPO_BUDGET_USD` | 20 | the base for alerts | |

Imports bring in at most the stored budget: 3 GB × $0.06 = $0.18. The remaining $3 covers estimate error. For scale, `smithersai/smithers` is 0.62 GB and fits; `facebook/react` is 1.15 GB and doesn't.

**Admission in `repo/Inspect`.** After the size, one Postgres transaction locks the `repo_imports` row (`SELECT … FOR UPDATE`), so two imports can't both take the last headroom. The first rule that holds decides:
1. imports are paused: `paused`;
2. GitHub is rate limiting the size call: `size_unknown`, with `retry_at` from `x-ratelimit-reset`;
3. the size is over `REPO_MAX_SIZE_MB`: `too_large`;
4. stored bytes plus the size are over `REPO_MAX_STORED_GB`: `storage`;
5. this month's reads have reached `REPO_MAX_READ_GB_PER_MONTH`: `reads`;
6. otherwise it writes `stored_bytes` and seals `Admitted`.

GitHub reports 0 until its hourly count runs, so a repository pushed within the hour passes rules 3 and 4; the alerts and the invoice catch it.

`Capacity` goes straight to Settle, which writes `status = 'capacity'`. It is a settled outcome, not a failure: nothing retries it and it never waits on the deadline. Try again starts a new attempt, which runs admission again.

**A busy Code Storage.** `CodeStorageError.retryAfterMillis` is the field `RetryPolicy.decide` reads (with W1's rename from `retryAfterMs`), so the engine waits the server's `Retry-After` on 429, 5xx, `repository_thawing` and `authentication_unavailable`. The 10-minute deadline bounds the wait.

**What a person sees** (M-46: never report an import that didn't happen):

| Situation | Row or answer | Shown |
|---|---|---|
| Paused, a budget spent, or 100 repositories | `capacity` `paused`, `storage` or `reads`; or `POST` 429 `repository_limit` | **Imports paused** and Try again. Repositories already `ready` open and read as before |
| Over the per-repository limit | `capacity` `too_large` | **Too large to import** · 1.2 GB of 1 GB |
| GitHub withholds the size | `capacity` `size_unknown` | **Can't check its size until 15:40** and Try again |
| Code Storage busy during an import | stays `cloning` | The header's one `cloning` indicator: no countdown and no second spinner (0002's rule). Past the deadline, `failed` `timed_out` and Try again |
| Code Storage busy or thawing on a view read | RepoApi 503 with `Retry-After` | The pane's `failed` state, **Code Storage is busy**, and Try again. The agent's `repo/tree` and `repo/read` retry in the engine |
| Read budget spent | RepoApi serves the cached response; a miss is 503 `capacity` | Cached files open. Others show **Reading paused until Nov 1** |

- **The SHA cache.** Tree and blob responses never change at a SHA. RepoApi keeps them in the edge cache and checks it before Code Storage, so a hit costs nothing and is served over budget too. Browsers also keep them (`immutable`). The Cache API is platform code, so RepoApi reaches it as an injected service: `ImmutableCache.readThrough` from `@smthrs/artifacts`, provided by `EdgeCache.layer` from `@smthrs/platform-cloudflare` (built 2026-10-20).

**Metering.** No API reports usage, so the numbers are ours. Will reconciles them with the monthly invoice.

| What | Where | Written by |
|---|---|---|
| Bytes stored per repository | `repositories.stored_bytes` | Inspect's admission |
| Bytes read and imported this month | `code_storage_usage (month PK, bytes_read, bytes_imported, alerted_pct)` | RepoApi, `repo/tree` and `repo/read` add each call's `bytesRead` (a file's is `bytes.length`). Import adds `stored_bytes` to `bytes_imported`. Sandbox git fetches (features 5 and 7) add the egress proxy's byte count |
| Imports paused | `repo_imports (id = 1, paused, changed_at)` | `repo/SetImports` |
| The same, live | `code_storage_bytes_read{operation}` and `code_storage_requests{operation,outcome}` (SDK); gauges `repo_stored_bytes` and `repo_spend_estimate_usd`; `repo_capacity{reason}` at Settle | the SDK, RepoApi and the flow |

**Alerts to Will.** Every write to `code_storage_usage` recomputes this month's estimate in the same transaction: stored GB × $3.60 + read GB × $0.15 + imported GB × $0.06 (code.storage/pricing, 2026-10-19). When it crosses 50%, 80% or 100% of `REPO_BUDGET_USD` above `alerted_pct`, the transaction raises `alerted_pct` and starts `ops/alert`, keyed `code-storage:<month>:<pct>`. That is the token-spend alert's flow ([todo.md](../todo.md)), sending through `@smthrs/notifications` `Alerts.layerWebhook`. Each threshold reaches Will once a month.

**The operator switch.** `repo/SetImports {paused}` is a flow that sets `repo_imports.paused` and logs `repo.imports.paused` or `repo.imports.resumed`. Until auth lands, only the operator starts it, from the CLI; RepoApi has no route for it. Pausing stops new admissions only: running imports finish, and reads go on.

## 2. The frontend

### What the view keeps from the mock, and what it drops

| Kept (supported now) | Dropped (no backing yet) |
|---|---|
| File tree sidebar (`FileTree`), hidden below 720 px of the view's own width | Global search, Sign in, the Public badge, the GitHub sync chip |
| Default branch chip, static | Branch picker, branch and tag counts, the commit count |
| Path trail (`Breadcrumbs`) | Tabs: Issues, Pull requests, Runs, Flows, Wiki, Docs |
| Head commit row: message, author, short SHA, age | Per-entry last commit and age columns; agent badges |
| Directory listing with `..` (`DirectoryListing`), README under it | Releases sidebar, Go to file, the Code clone menu |
| File toolbar: lines · size; Preview or Code for Markdown | Blame, History, Raw, the `…` menu |
| Code (`CodeFileView`, Shiki through `@pierre/diffs`), anchored by `?L=<n>` or a range `?L=<a>-<b>` | "Ask about lines" and several highlighted ranges in one file (feature 4) |
| Markdown as Milkdown WYSIWYG, read-only; relative links open in the view | Editing and saving Markdown (question 3) |
| **Copy permalink** (the view's one primary action; links the head SHA) | Ask (chat is feature 1 and 3's surface) |
| States: loading, not found, binary, too large (above 512 KiB), empty, failed | |

### `RepoView` (built; `@smthrs/repo-view`)

```
RepoView { name, tree, location: {kind, path, line?, lineEnd?}, file?, readme?, size: "inline" | "full",
           href(location), onNavigate(location), expanded?, onToggle?, markdownMode?,
           onMarkdownModeChange?, revision?, actions?, summary?, fileActions?, codeMode?, markdownEditor? }
```

- **It fetches nothing.** The host passes the file list (`tree`), the file at `location` (`file`) and the directory's README (`readme`), each as `loading`, `text`, `binary`, `too-large` or `failed`.
- **Every link is real.** Each link is an `<a href>` from `href`. A plain click calls `onNavigate`, and a modified click opens a new tab.
- **README links resolve against the repository.** A relative link resolves the way GitHub does and navigates in place. An external link is left to the browser.
- **It sizes from its own width.** It uses `container-type: inline-size`, so the same view lays out right in a chat bubble and on a page.

### The app's state machine (`src/features/repo/`, framework-free; [state.md](../state.md))

| Piece | What it is |
|---|---|
| `repositories` | Electric collection over `/api/shapes/repositories`, decoded by `schema.ts`; `onInsert` posts `POST /api/repos` and awaits the txid (the chat `ask` pattern) |
| `trees`, `blobs` | local-only collections keyed `<id>@<sha>` and `<id>@<sha>:<path>`, each `{state, …}` as `RepoView` takes them |
| `ui` | local-only `{repoId, expanded[], markdownMode}` for the routed view, whose location is the URL. An embed's state is its [0004](0004-agent-ui-codemode-and-rendering.md) `views` row instead (below) |
| `clone(owner, name)` | validates, inserts the `cloning` row (shown at once), Electric delivers the server's row |
| `open(view, location)` | the routed view navigates through the router; an embed runs `view/repo.open` on its `views` row. Then it marks the location's ancestors expanded and loads what the location needs (the tree, the blob or the README) if absent |
| `retryClone(id)` | Try again on a failed row |
| queries | `repository(id)`, `tree(id, sha)`, `file(id, sha, path)`, `readme(id, sha, dir)` (case-insensitive `README.md` in the directory's entries) |

- **When loads happen:** a route's `loader` and an embed's mount call `open` with the current location. No `useEffect` triggers a load.
- **What stays in `.tsx`:** React files only read live queries and call the bound actions.

### Routing (`src/router.tsx`)

```
/                               Landing                (exists)
/app                            AppScreen              (exists)
/$owner/$repo                   RepoScreen  tree ""    (Clone button when there is no row)
/$owner/$repo/tree/$ref/$       RepoScreen  tree <_splat>
/$owner/$repo/blob/$ref/$       RepoScreen  blob <_splat>, search { L?: "<n>" | "<a>-<b>" }
```

- **Refs:** `$ref` is the default branch name or a 40-hex SHA. A default branch with a `/` is matched against the splat's prefix, using `resolveRefLocation` from `@smthrs/rpc` once its root export lands.
- **Reserved names:** an owner of `app`, `api` or `assets` answers not found.
- **Copy permalink** replaces the branch with `head_sha`.
- **Screens without the view:**
  - A missing row shows `owner / name` and **Clone**.
  - `cloning` shows a spinner in the header.
  - `failed` shows the reason and **Try again**.

### The embed (feature 3's template)

[0004](0004-agent-ui-codemode-and-rendering.md) fixes the embedding contract; this view fulfils it.
- **Template:** `repo`, with props `{repo, revision}`, validated by an Effect `Schema` in `features/repo/contract.ts`.
- **Inline:** in the message, the template renders `RepoView size="inline"`, with no tree and the content scrolling within 420 px. Its one action is **Open**, which goes to `/app/views/$viewId`.
- **Full:** the same component with `size="full"`, at `/app/views/$viewId`.
- **State:** the `views` row's `state` (`{repo, revision, tabs, active, highlights, expanded}`, 0004 §7) is the view's state.
  - `active` is the location. `expanded` is the tree.
  - The first highlight of `active` becomes `line` and `lineEnd`. `CodeFileView` marks one range, because `@pierre/diffs` `File` takes one `selectedLines`. Several ranges in one file are feature 4's extension to `CodeFileView`.
  - The person's clicks and the agent's `view/repo.*` flows write the same row.

## 3. Tests

- **SDK (`@smthrs/effect-code-storage`), unit, 100%:**
  - A scripted Code Storage on the `fetch` seam. It is a third-party provider, scripted like the model. It verifies every JWT's ES256 signature with the public key, plus `iss`, `repo`, `scopes` and `exp - iat ≤ 3600`.
  - It covers every endpoint and every problem code mapping: 409 `sync_in_progress`, 429 with `Retry-After`, 5xx, transport, and an invalid body.
  - It covers the 512 KiB cap read from `Content-Length` and from a streamed body without one.
  - A sentinel test proves the key, the JWT and the provider's `detail` text never reach a span, log line or error.
  - A browser-bundle test proves the entry has no `node:` imports.
- **SDK, live:** `test/Live.test.ts` imports a tiny public repository into the real organization when `CODE_STORAGE_ORG` and `CODE_STORAGE_KEY` are set. Otherwise it skips and says which variable is missing.
- **`@smthrs/ui` (bun, happy-dom):** `Breadcrumbs`, `DirectoryListing`, the repo-view path helpers and `RepoView`. That covers every state, both sizes, controlled and uncontrolled tree and Markdown mode, link resolution and modified clicks. Every new file is at 100% lines and functions.
- **App unit (vitest, 100% under `apps/mvp/vitest.config.ts`):**
  - The `repo/Clone` flow and RepoApi run against the compose Postgres and Electric and the real engine, with the scripted Code Storage and a scripted GitHub `info/refs`.
  - Covered cases:
    - killed after Import, it resumes with no second create;
    - a second `POST` starts nothing;
    - Try again starts attempt 2;
    - the deadline settles `timed_out`;
    - a stale attempt cannot settle;
    - each capacity reason settles `capacity` with no Code Storage call, and two concurrent imports can't both take the last headroom;
    - each alert threshold fires once a month.
  - The machine tests drive `clone`, `open` and `retryClone` through actions and queries, with no React.
- **E2E (`e2e/repo.spec.ts`), real everything, video on:**
  1. Open `/smithersai/repo-view-fixture` (a fixture repository we own, with a directory, Markdown with relative links, a binary and a file over 512 KiB) and press Clone. A second device sees `cloning`, then `ready`.
  2. Browse `docs/`, open `docs/guide.md` (WYSIWYG), follow its relative link, switch to Code, open `src/index.ts?L=3`, and Copy permalink.
  3. Reload mid-clone: the clone still finishes.
  4. Refusals: an unknown repository shows `not_found`, and a binary file and the large file show their states.
  - The suite runs locally and against a live deployment (`BASE_URL`). Without `CODE_STORAGE_*` it skips and says so.
- **Observability tests** read back the OTLP exports. The cases are listed in the [Observability](#4-observability) section.
- **Benchmarks (`pnpm bench`):** tree load for 1,000 and 50,000 paths; time to first paint of a 500 KiB file, cold and warm.

## 4. Observability

| Where | Record |
|---|---|
| RepoApi | Spans `repo.clone.request`, `repo.tree` and `repo.blob`. Each also writes one log line with `repo_id`, `sha`, `status`, `bytes`, `duration_ms`, `trace_id` and `span_id` |
| RepoApi metrics | `repo_clone_requests{outcome}`, `repo_reads{kind,status}`, `repo_read_bytes_total` |
| Flow | The engine's per-step spans and logs for `repo/*`. `repo_clones{outcome}` is counted at Settle |
| Browser | `repo.open{kind}` log and span; `repo_clone_clicks` metric; tree and blob load durations |

The JWT, the key and Code Storage's `detail` text never reach any of these. Commit messages and file contents are never recorded.

## 5. Implementation plan, by file ownership

| # | Owner | Files | When | State |
|---|---|---|---|---|
| R1 | feature 2 | `packages/effect-code-storage/**` (new): `CodeStorage` and `GitRemote` | now | built: 46 tests, 100% statements, branches, functions and lines; `code_storage_bytes_read`, `bytesRead` and unknown-code mapping added 2026-10-19 |
| R2 | feature 2 | `packages/smithers/ui`: `src/{breadcrumbs,directory-listing,repositoryCss}.ts*`, `src/adapters/repo-view/**` and `src/internal/navigationClick.ts`, their tests and docs; `CodeFileView` gains `lineEnd`; `MarkdownEditor` takes its container's background | now | built: every new file at 100% lines and functions; the package's 2,032 tests pass |
| R3 | feature 2 | `db/migrations/0007_repositories.ts`, `worker/RepoApi.ts`, `worker/Repos.ts`, `worker/RepoReads.ts`, `worker/RepoUpstream.ts`, `worker/RepoConfig.ts`, `worker/RepoMetrics.ts`, `worker/flows/RepoClone.ts`, `src/features/repo/{contract,schema,flows}.ts`; routes in `worker/ChatApi.ts`, `repo/Clone` in `worker/Executions.ts` | after W5 lands the Cloudflare host and the ExecutionObject Durable Object | built 2026-10-20 ([repo.md](../features/repo.md)): every new file at 100% coverage; the live clone of `octocat/Spoon-Knife` into organization `smithers` passes. RepoApi is ChatApi's routes, not a Worker of its own, so `worker/index.ts` and `alchemy.run.ts` needed no change: ChatApi's `Config` binds the secrets |
| R4 | feature 2 | `apps/mvp/src/features/repo/**`, `src/screens/repo/**`, routes in `src/router.tsx`, wiring in `src/boot.ts` | after the `db`, `worker` and `src` rewrites land; the embed after feature 3's template registry | logic, views and screen built 2026-10-20, every logic file at 100% coverage; the routes and boot wiring go to the wiring agent; the embed waits |
| R5 | feature 2 | `apps/mvp/e2e/repo.spec.ts`, `bench`, `docs/features/repo.md`, `docs/observability.md` rows | with R3 and R4 | written 2026-10-20 against `octocat/Spoon-Knife` (no fixture repository was created); the e2e runs once the routes are wired; the bench's `repo` suite reads the fixture's tree and README |
| R6 | lead | registries outside these files (below) | with R1 and R2 | listed in the report |

Registries to change outside feature 2's files:
- `docs/libraries.md`: add the catalog row.
- The root `PACKAGE.ts`: add the package to `sdkRuleLibraries` and `sdkRuleGenericLibraries`.
- `packages/repo-targets/browser/browser-contract.mjs`: add its entry.
- `apps/mvp/PACKAGE.ts`: no `rootImportsOnly` exception; `RepoView` is `@smthrs/repo-view`'s root export (question 2).
- The fixture repository `smithersai/repo-view-fixture`.

## Questions for Will

1. **Code Storage needs a paid organization and a key: $20 a month minimum, about $3.60 per GB-month stored, and no free tier.** Until one exists, the e2e and live tests skip and nothing clones outside tests. Will you create the organization (proposed name `smithers`) and give its ES256 key to the deploy secrets as `CODE_STORAGE_KEY`? Recommended: yes, the Starter plan.
2. **Heavy UI adapters vs root imports.** `CodeFileView` (about 10 MB with Shiki) and `MarkdownEditor` (about 2.9 MB) live behind `@smthrs/ui/adapters/*` subpaths so the base barrel stays light, and `RepoView` joins them. `apps/mvp` allows only root imports. Recommended: allow `@smthrs/ui/adapters/*` as the one exception. The alternative is to move each heavy renderer into its own package with a root entry. **Answered 2026-10-20: the alternative.** Will: "Yes move code viewer to it's own package". `RepoView`, `CodeFileView`, `PierreDiffView` and `MarkdownEditor` are `@smthrs/repo-view`, `TerminalFrame` is `@smthrs/terminal-frame`, and the app imports both from their roots with no exception.
3. **Markdown: view or edit?** Recommended for now: the WYSIWYG renders read-only. Saving an edit means a commit to the Code Storage mirror, which then diverges from GitHub (public mode is one-way) and needs the auth design to say who may write.

## Revisions after Will's review (2026-10-20, evening)

Will, about 18:22: the first visit was empty, the clone showed a spinner instead of notifying, a clone should say it may be reclaimed until the Smithers app is installed, Markdown should be WYSIWYG and HTML viewable as CodePen does. Decided, as [repo.md](../features/repo.md) describes:

1. **The page reads GitHub before any clone.** `GET /api/repos/<owner>/<name>/about` answers what GitHub's REST API says (about, counts, newest commit, top folder, README), cached in the immutable cache per hour-long window, so a repository costs GitHub's quota once an hour. Only the repository must answer; a rate limit fails the whole read uncached. The top level is laid out as GitHub's repository page, cloned or not.
2. **The clone is a workflow in its asker's feed.** A new step, `repo/Index`, joins `repo/Clone`. Each write to a clone's row folds into the asker's `notifications` row (`clone:<repo id>`) in the same transaction, a new kind beside `run`, `main` and `release`; who asked lives in `clone_requests`, never in the synced row (migration 0028). The header shows no spinner.
3. **Reclaimable means not installed.** Index asks GitHub, as the App, whether it is installed; Settle writes `reclaimable`. Nothing deletes a copy until a durable reclaim flow exists, and it re-checks the App first (question 3 is unchanged: the view stays read-only; a person who may edit a branch edits in its workspace).
4. **An HTML file previews in a sandboxed frame** with no network and an opaque origin, under 0017's app-frame policy.

[HOST-PLAN] the lead's durable-answering plan, 2026-10-19: `@smthrs/platform-cloudflare`, the per-execution Durable Object, the engine journal in Postgres, and fencing (§5).

## Missing metadata and clone refusal (2026-10-21)

When no repository row exists, About's missing answer supplies the header's Not found status immediately, alongside Clone (or the signed-out sign-in action). It does not claim a clone finished. A clone request and a stored repository keep their existing status precedence. Tests establish initial absence before clicking Clone, then require the clone's own feed outcome and Try again separately. The header's live query joins the About row by repository id.

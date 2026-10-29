// The repository feature's contract between the browser and RepoApi (docs/features/repo.md, decision 0006): the one
// home of every value the browser, RepoApi, the flows, the end-to-end tests and the unit tests share. Nothing here
// imports a library, so every side can.

/**
 * `POST <route>` `{ owner, name }` asks for a clone; `GET <route>/<owner>/<name>/{tree,blob,raw}/<sha>[/<path>]` reads at
 * a commit, and `GET <route>/<owner>/<name>/refs` lists the branches and tags.
 */
export const REPOS_ROUTE = "/api/repos"

/**
 * RepoApi's clone launch, `POST` `{ owner, name, cloneId }`: starts the durable remote `repo/Clone` for the attempt a
 * clone request persisted (`repo/clone`'s second step). `POST /api/repos` answers at once and starts nothing.
 */
export const LAUNCH_ROUTE = `${REPOS_ROUTE}/launch`

/** RepoApi's Electric shape proxy for `repositories`: `GET`. */
export const REPOSITORIES_SHAPE_ROUTE = "/api/shapes/repositories"

/** The Postgres table the shape proxy serves. */
export const REPOSITORIES_TABLE = "repositories"

/** A GitHub owner: a letter or digit, then up to 38 letters, digits or hyphens. */
export const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/** A GitHub repository name: 1 to 100 letters, digits, `.`, `_` or `-`, never `.` or `..`. */
export const NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/

/** First path segments the app owns, so no owner can take them. */
export const RESERVED_OWNERS: ReadonlyArray<string> = ["app", "api", "assets"]

/** A full commit SHA: the only revision RepoApi reads at, since a SHA never changes. */
export const SHA_PATTERN = /^[0-9a-f]{40}$/

/** The largest `POST /api/repos` body. */
export const MAX_REQUEST_BYTES = 1024

/** The largest file RepoApi returns; above it, `413 { code: "too_large", size }` without reading the body. */
export const MAX_BLOB_BYTES = 512 * 1024

/** The longest file path RepoApi reads, in characters, and the most segments in it. */
export const MAX_PATH_LENGTH = 1024
export const MAX_PATH_SEGMENTS = 64

/** One page of a tree listing from Code Storage. */
export const TREE_PAGE_SIZE = 5_000

/** A row's status: being cloned, ready to read, failed, or refused by a budget (decision 0006, Capacity and spend). */
export const STATUSES = ["cloning", "ready", "failed", "capacity"] as const
export type Status = (typeof STATUSES)[number]

/**
 * Why a clone failed: the repository is missing or private on GitHub (`not_found`), has no commits (`empty`), Code
 * Storage or GitHub couldn't do it (`unavailable`), or the sync didn't finish in time (`timed_out`).
 */
export const FAILURES = ["not_found", "empty", "unavailable", "timed_out"] as const
export type Failure = (typeof FAILURES)[number]

/**
 * Which budget refused a clone: imports are paused, Code Storage's stored bytes or this month's reads are spent, the
 * repository is over the per-repository size, or GitHub withheld its size (`size_unknown`, until `retry_at`).
 */
export const CAPACITY_REASONS = ["paused", "storage", "reads", "too_large", "size_unknown"] as const
export type CapacityReason = (typeof CAPACITY_REASONS)[number]

/**
 * The refusal codes RepoApi answers with, as `{ code }`: `invalid` (400), `authentication` (401, cloning needs sign-in),
 * `forbidden` (403, cloning needs the Member role or above), `not_found` (404), `too_large` (413, with `size` for a
 * file), `repository_limit` (429), `capacity` (503, the read budget is spent), `rate_limited` (503, GitHub's
 * public About limit), `github_unavailable` (503, GitHub didn't answer About's read and no earlier answer is kept),
 * `unavailable` (503, with `Retry-After` when the upstream said when) and `not_configured` (503, no Code Storage
 * organization).
 */
export const REFUSALS = [
  "not_synced",
  "invalid",
  "authentication",
  "forbidden",
  "not_found",
  "too_large",
  "repository_limit",
  "capacity",
  "rate_limited",
  "github_unavailable",
  "unavailable",
  "not_configured",
] as const
export type Refusal = (typeof REFUSALS)[number]

/** Whether `owner` and `name` name a GitHub repository the app may clone: valid, and not a reserved first segment. */
export const isRepository = (owner: string, name: string): boolean =>
  OWNER_PATTERN.test(owner) && NAME_PATTERN.test(name) && !RESERVED_OWNERS.includes(owner.toLowerCase())

/** A repository's id: `github/<owner>/<name>`, lowercased. Also its Code Storage name and its clone's key. */
export const repoId = (owner: string, name: string): string => `github/${owner}/${name}`.toLowerCase()

/**
 * A clone attempt's execution id, from the repository's id and the attempt's own `clone_id`, a UUID drawn when the
 * attempt was created. Never the `attempt` counter: it restarts when `repositories` is reset or restored, while the
 * Durable Objects keep the executions it named.
 */
export const cloneExecutionId = (id: string, cloneId: string): string => `repo-clone:${id}:${cloneId}`

/** Whether `path` is a file path RepoApi reads: relative, bounded, with no empty, `.` or `..` segment. */
export const isFilePath = (path: string): boolean => {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false
  const segments = path.split("/")
  return segments.length <= MAX_PATH_SEGMENTS && segments.every((s) => s !== "" && s !== "." && s !== "..")
}

/** `GET` route of a repository's file list at `sha`: `{ paths, truncated }`. */
export const treeRoute = (owner: string, name: string, sha: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tree/${sha}`

/** `GET` route of a file at `sha`: its bytes. */
export const blobRoute = (owner: string, name: string, sha: string, path: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/blob/${sha}/${
    path.split("/").map(encodeURIComponent).join("/")
  }`

/** `GET` route of a file's bytes at `sha` as a page shows them: text as `text/plain`, what Raw opens and Download saves. */
export const rawRoute = (owner: string, name: string, sha: string, path: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/raw/${sha}/${
    path.split("/").map(encodeURIComponent).join("/")
  }`

/** `GET` route of a repository's default branch, head commit, branches and tags, as of its sync. */
export const refsRoute = (owner: string, name: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/refs`

/** `GET` route of what GitHub says of a repository, cloned or not: `About` (schema.ts). */
export const aboutRoute = (owner: string, name: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/about`

/** The most contributors the about answer names; the rest are counted. */
export const ABOUT_CONTRIBUTORS = 12

/** The most top-level entries the about answer lists before a clone. */
export const ABOUT_ROOT_ENTRIES = 1000

/** Where the Smithers GitHub App is installed, by the App's `slug`. */
export const installUrl = (slug: string): string => `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`

/** One page of branches or tags from Code Storage. */
export const REFS_PAGE_SIZE = 100

/** What `git clone` takes for a repository: its GitHub URL, until Smithers serves git itself. */
export const cloneUrl = (owner: string, name: string): string => `https://github.com/${owner}/${name}.git`

/**
 * What Copy puts on the clipboard: the location's link at its commit (`permalink`), the file's or directory's path
 * (`path`), the file's text (`contents`), or the URL `git clone` takes (`clone-url`).
 */
export const COPY_KINDS = ["permalink", "path", "contents", "clone-url"] as const
export type CopyKind = (typeof COPY_KINDS)[number]

/** A file's raw bytes on GitHub: where Raw goes for a file over `MAX_BLOB_BYTES`, which RepoApi doesn't serve. */
export const githubRawUrl = (owner: string, name: string, sha: string, path: string): string =>
  `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/raw/${sha}/${
    path.split("/").map(encodeURIComponent).join("/")
  }`

/** How long `repo/copy`'s step waits for the tab that asked: a tab that is open answers in milliseconds. */
export const COPY_WITHIN = "5 seconds"

/**
 * The `BroadcastChannel` `repo/copy`'s step asks the tabs of engine `name` on, as `app/navigate`'s does on its own: only
 * the tab that started the request writes its clipboard.
 */
export const clipboardChannel = (name: string): string => `${name}/clipboard`

/**
 * How a copy ended: on the clipboard (`copied`), refused by the clipboard (`failed`), nothing to copy (`refused`), the
 * file unreadable (`unavailable`), or no tab answered because the one that asked is gone (`gone`).
 */
export const COPY_OUTCOMES = ["copied", "failed", "refused", "unavailable", "gone"] as const
export type CopyOutcome = (typeof COPY_OUTCOMES)[number]

/** The file list RepoApi answers: every file's path, and whether it stopped before the end. */
export interface TreeListing {
  readonly paths: ReadonlyArray<string>
  readonly truncated: boolean
}

/** How many leading bytes decide whether a file is binary. */
export const BINARY_SNIFF_BYTES = 8 * 1024

const utf8 = new TextDecoder("utf-8", { fatal: true })

/**
 * A file's bytes as text, or `undefined` when the file is binary: a NUL byte among its first `BINARY_SNIFF_BYTES`, or
 * bytes that aren't UTF-8. RepoApi and the browser decide the same way.
 */
export const textOf = (bytes: Uint8Array): string | undefined => {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined
  try {
    return utf8.decode(bytes)
    // expected: bytes that aren't UTF-8 are a binary file
  } catch {
    return undefined
  }
}

// The repository view's copy. No other repository copy exists.

/** The button that asks for a clone. */
export const CLONE = "Clone"

/** The button on a failed or refused clone. */
export const TRY_AGAIN = "Try again"

/** Copies the location's link at its commit. */
export const COPY_PERMALINK = "Copy permalink"

/** Copies the location's path. */
export const COPY_PATH = "Copy path"

/** Copies the file's text. */
export const COPY_CONTENTS = "Copy"

/** Opens the file's bytes as plain text in a new tab. */
export const RAW = "Raw"

/** Saves the file. */
export const DOWNLOAD = "Download"

/** Opens the menu with the URL `git clone` takes. */
export const CODE = "Code"

/** Copies the URL `git clone` takes. */
export const COPY_CLONE_URL = "Copy clone URL"

/** Where Clone would be, for a signed-out person. */
export const SIGN_IN_TO_CLONE = "Sign in to clone"

/** Where Clone was, once RepoApi refused it: the person isn't a Member or above on the repository (ruling AUTH-8). */
export const MEMBERS_CLONE = "Members can clone."

/** A repository GitHub doesn't have, or keeps private. */
export const NOT_FOUND = "Not found"

/** The Code view of a repository nobody cloned yet, or whose clone failed or was refused: Clone is in its header. */
export const NOT_CLONED = "Clone to browse files"

/** The Code view while the repository clones. */
export const CLONING = "Cloning"

/** What a failed clone shows, by failure. */
export const FAILURE_COPY: Readonly<Record<Failure, string>> = {
  not_found: NOT_FOUND,
  empty: "Empty repository",
  unavailable: "Couldn't clone",
  timed_out: "Clone timed out",
}

/** What a refused clone shows, by reason; `size_unknown` adds the time GitHub gives the size again. */
export const CAPACITY_COPY: Readonly<Record<CapacityReason, string>> = {
  paused: "Imports paused",
  storage: "Imports paused",
  reads: "Imports paused",
  too_large: "Too large to import",
  size_unknown: "Can't check its size until",
}

/** How far a running clone has come: RepoApi took it, Code Storage is fetching it from GitHub, or its files are being listed. */
export const CLONE_STAGES = ["requested", "fetching", "indexing"] as const
export type CloneStage = (typeof CLONE_STAGES)[number]

/** A running clone's stage, as its toast says it. */
export const CLONE_STAGE_COPY: Readonly<Record<CloneStage, string>> = {
  requested: "Requested",
  fetching: "Fetching",
  indexing: "Indexing",
}

/** The feed row of repository `id`'s clone (worker/CloneFeed.ts): one per person who asked, `clone:<id>`. */
export const cloneSubject = (id: string): string => `clone:${id}`

/**
 * What a clone's feed row says in its `ref`: the stage while it runs, with the size once admission knows it
 * (`fetching:<bytes>`, `indexing:<bytes>`); `ready`; or `failed:<failure>` or `capacity:<reason>`.
 */
export const cloneRef = (stage: CloneStage, bytes?: number): string =>
  bytes === undefined || stage === "requested" ? stage : `${stage}:${bytes}`

/** Bytes in the largest whole unit, one decimal past KB: `512 B`, `1.2 MB`. */
export const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`
}

/**
 * A clone feed row's detail from its `ref`: `Fetching 1.2 MB` while it runs, why it failed or was refused, or `null`
 * once ready, or for a `ref` this app doesn't know.
 */
export const cloneDetail = (ref: string | null): string | null => {
  const [kind = "", value] = (ref ?? "").split(":", 2)
  if ((CLONE_STAGES as ReadonlyArray<string>).includes(kind)) {
    const words = CLONE_STAGE_COPY[kind as CloneStage]
    const bytes = value === undefined ? Number.NaN : Number(value)
    return Number.isFinite(bytes) && bytes >= 0 ? `${words} ${formatBytes(bytes)}` : words
  }
  if (kind === "failed") return FAILURE_COPY[value as Failure] ?? FAILURE_COPY.unavailable
  if (kind === "capacity") {
    return value === "size_unknown" ? "Can't check its size" : CAPACITY_COPY[value as CapacityReason] ?? CAPACITY_COPY.paused
  }
  return null
}

/** The quiet note on a cloned repository whose copy may be reclaimed: until the Smithers GitHub App is installed on it. */
export const RECLAIMABLE = "Until the Smithers app is installed, this copy may be reclaimed for space."

/** Opens the Smithers GitHub App's installation on GitHub. */
export const INSTALL = "Install"

/** A view read Code Storage couldn't answer. */
export const BUSY = "Code Storage is busy"

/** A view read that failed for any other reason: the network, or a gateway's 5xx. */
export const COULDNT_LOAD = "Couldn't load"

/** GitHub refused a public About read at its rate limit. */
export const GITHUB_LIMIT = "GitHub limit reached"

/** GitHub didn't answer a public About read, and no earlier answer is kept (Will, 2026-10-19 12:41). */
export const GITHUB_DOWN = "GitHub isn't answering. Repositories already cloned keep working."

/** A view read refused by this month's read budget. */
export const READING_PAUSED = "Reading paused"

/**
 * What the repository view records in the browser (docs/features/repo.md), by name, and the attributes they carry.
 * ChatApi's relay keeps exactly what src/telemetry.ts merges from every feature; none of these fields carries a file's
 * content.
 */
export const REPO_TELEMETRY = {
  records: [
    "repo.clone",
    "repo.clone.admission",
    "repo.open",
    "repo.alias.check",
    "repo.tree.load",
    "repo.blob.load",
    "repo.refs.load",
    "repo.head.load",
    "repo.locate",
    "repo.about.load",
    "repo.embed.load",
    "repo.about.get",
    "repo.clone.unconfirmed",
    "repo.repositories.load",
    "repo.copy",
    "repo.clone.post",
    "repo.clone.launch",
    "repo.clone.launch.post",
    "repo.tree.get",
    "repo.blob.get",
    "repo.refs.get",
    "repo.role",
    "repo.role.get",
    "smithers_web_repo_clone_clicks",
    "smithers_web_repo_clones",
    "smithers_web_repo_opens",
    "smithers_web_repo_alias_checks",
    "smithers_web_repo_tree_load_ms",
    "smithers_web_repo_blob_load_ms",
    "smithers_web_repo_refs_load_ms",
    "smithers_web_repo_head_load_ms",
    "smithers_web_repo_locate_ms",
    "smithers_web_repo_about_load_ms",
    "smithers_web_repo_embed_load_ms",
    "smithers_web_repo_copies",
    "smithers_web_repo_role_answers",
    "execute_tool repo/tree",
    "execute_tool repo/read",
    "execute_tool repo/refs",
    "execute_tool repo/copy",
    "execute_tool repo/clone",
  ],
  fields: [
    "outcome",
    "status",
    "kind",
    "what",
    "door",
    "role",
    "own",
    "durationMs",
    "source",
    "reason",
    "errorCode",
    "smithers.repo.kind",
    "smithers.repo.copy",
  ],
} as const

/** The mirror has not received the requested GitHub commit yet. */
export const NOT_SYNCED = "Not synced yet"

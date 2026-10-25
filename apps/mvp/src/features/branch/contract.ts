// The branch workspace's contract between the browser, ChatApi, the flows and the tests (decision 0013,
// docs/features/branch-workspace.md): the one home of every value they share. Nothing here imports a library, so every
// side can.

/** `POST <route>` `{ owner, name, ref? }` tracks a branch GitHub already has: `branch/Track`. */
export const BRANCHES_ROUTE = "/api/branches"

/** ChatApi's Electric shape proxy for one repository's `branches`: `GET ?repo=<repository id>`. */
export const BRANCHES_SHAPE_ROUTE = "/api/shapes/branches"

/** The Postgres tables the branch workspace adds (db/migrations/0014_branch_workspace.ts). */
export const BRANCHES_TABLE = "branches"
export const CONVERSATIONS_TABLE = "conversations"

/**
 * The namespace of every conversation's id: a conversation's id is the version 5 UUID of its branch's id in it, so a
 * device that knows a branch knows its conversation offline (decision 0013, decision 2).
 */
export const CONVERSATION_NAMESPACE = "5b0a6f0e-2c5d-4f0e-9a43-0c1e6a7b8d91"

/**
 * The branch of the deployment's own repository (`GITHUB_REPOSITORY`) that the rows written before branches existed
 * belong to, and that `/app` shows until the launcher lands (decision 0013 §1 and §5).
 */
export const HOME_BRANCH = "main"

/**
 * `POST <route>` `{ grantee | login, access }` changes who branch `branchId` is shared with: `branch/share`. Only the
 * branch's owner may (docs/features/branch-workspace.md#sharing).
 */
export const sharesRoute = (branchId: string): string => `${BRANCHES_ROUTE}/${branchId}/shares`

/** `GET <route>` with `Upgrade: websocket`: branch `branchId`'s room, who is on it and where (decision 0013 §4). */
export const roomRoute = (branchId: string): string => `${BRANCHES_ROUTE}/${branchId}/room`

/** ChatApi's Electric shape proxy for one branch's permission list: `GET ?branch=<branch id>`, its owner's only. */
export const SHARES_SHAPE_ROUTE = "/api/shapes/shares"

/** A branch's permission list (db/migrations/0023_branch_sharing.ts). */
export const SHARES_TABLE = "branch_shares"

/** The grantee of the grant to anyone in the repository with the link: Members and above, never a Guest. */
export const REPOSITORY_GRANTEE = "repository"

/** What a share grants: to view the live branch, or to edit it (ask in its conversation, type in its terminals). */
export const SHARE_ACCESSES = ["view", "edit"] as const
export type ShareAccess = (typeof SHARE_ACCESSES)[number]

/** What a person may do on a branch they can open: own it, which is also sharing it, edit it, or view it. */
export const ACCESSES = ["owner", "edit", "view"] as const
export type Access = (typeof ACCESSES)[number]

/** What the branch's chrome says a person may do on it, in the share dialog's words. */
export const ACCESS_LABELS: Readonly<Record<Access, string>> = { owner: "Owner", edit: "Can edit", view: "Can view" }

/**
 * Whether `login` can be a GitHub login: 1 to 39 letters, digits and single hyphens, neither first nor last. GitHub
 * compares logins ignoring case.
 */
export const isLogin = (login: string): boolean => login.length <= 39 && /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/.test(login)

/** The largest `POST /api/branches/<id>/shares` body. */
export const MAX_SHARE_BODY_BYTES = 1024

/** The most people one branch may be shared with by name. */
export const MAX_SHARES = 100

/** The branch modes (decision 0007 §5): `locked` (the default branch: changes only by merge), `open` and `restricted`. */
export const MODES = ["locked", "open", "restricted"] as const
export type Mode = (typeof MODES)[number]

/** The longest branch name the app tracks, in characters. */
export const MAX_BRANCH_NAME_LENGTH = 255

/** The largest `POST /api/branches` body. */
export const MAX_TRACK_BODY_BYTES = 2 * 1024

/**
 * Whether `name` is a branch name git accepts (`git check-ref-format --branch`), within the app's length: no control
 * characters, spaces or `~^:?*[\`, no `..`, `@{` or `//`, no segment starting with `.` or ending in `.lock`, and not
 * starting with `-`, starting or ending with `/`, or ending with `.`.
 */
export const isBranchName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= MAX_BRANCH_NAME_LENGTH &&
  name !== "@" &&
  !name.startsWith("-") &&
  !/[\x00-\x20\x7f~^:?*[\\]/.test(name) &&
  !name.includes("..") &&
  !name.includes("@{") &&
  !name.includes("//") &&
  !name.startsWith("/") &&
  !name.endsWith("/") &&
  !name.endsWith(".") &&
  name.split("/").every((segment) => !segment.startsWith(".") && !segment.endsWith(".lock"))

/**
 * The refusal codes the branch routes answer with, as `{ code }`: `invalid` (400), `authentication` (401),
 * `forbidden` (403: access or a forge write refused), `not_found` (404: GitHub has no such repository or branch), `locked` (409: the
 * branch is locked), and `unavailable` (503).
 */
export const REFUSALS = [
  "invalid",
  "authentication",
  "forbidden",
  "not_found",
  "locked",
  "unavailable",
  // `POST /api/branches` with `create: true` on a forge that can't make a branch (GitHub, read with no credential).
  "not_configured",
  // `POST /api/branches` with `create: true` for a name the forge already has (409): someone else's branch.
  "exists",
] as const
export type Refusal = (typeof REFUSALS)[number]

/**
 * What the branch workspace records in the browser (docs/observability.md#browser), by name, and the attributes they
 * carry: `branch/track`'s step and its request, opening a branch's page, chat showing a branch's conversation, and a
 * person's presses of Publish and Update branch, by outcome. No attribute carries a branch's name, a title or anything
 * asked.
 */
export const BRANCH_TELEMETRY = {
  records: [
    "branch.track",
    "branch.track.post",
    "branch.open",
    "smithers_web_branch_tracks",
    "smithers_web_branch_opens",
    "chat conversation opened",
    "chat conversation shown",
    "branch.publish.press",
    "branch.update.press",
    "smithers_web_branch_publishes",
    "smithers_web_branch_updates",
  ],
  fields: ["outcome", "status", "durationMs", "conversation", "conversationId"],
} as const

/**
 * ChatApi's Electric shape proxy for one branch's publication on GitHub (docs/features/branch-publish.md): `GET
 * ?branch=<branch id>`, to anyone who may view the branch.
 */
export const PUBLICATIONS_SHAPE_ROUTE = "/api/shapes/branch-publications"

/** A Smithers-only branch's publication on GitHub (db/migrations/0068_branch_publish.ts): one row once published. */
export const PUBLICATIONS_TABLE = "branch_publications"

/** The `branch_publications` columns a device syncs. */
export const PUBLICATION_COLUMNS = [
  "branch_id",
  "repo_id",
  "github_ref",
  "base_ref",
  "base_sha",
  "head_sha",
  "pr_number",
  "update_state",
  "updated_at",
] as const

/**
 * How Update branch brings a published branch up to date with its base: GitHub's default, a merge commit, or a rebase
 * of the branch's commits onto the base. The repository's `branches/update` flow chooses; the built-in one merges.
 */
export const UPDATE_METHODS = ["merge", "rebase"] as const
export type UpdateMethod = (typeof UPDATE_METHODS)[number]

/** How the last Update branch ended: `updated` (the base taken in), `up_to_date`, or `conflict` (GitHub can't). */
export const UPDATE_STATES = ["updated", "up_to_date", "conflict"] as const
export type UpdateState = (typeof UPDATE_STATES)[number]

/** The most files one Publish commits. */
export const MAX_PUBLISH_FILES = 50

/** The most bytes of file contents one Publish commits. */
export const MAX_PUBLISH_BYTES = 1024 * 1024

/** A Publish write's run: one per write id. */
export const publishExecutionId = (writeId: string): string => `branch-publish:${writeId}`

/** An Update branch write's run: one per write id. */
export const updateExecutionId = (writeId: string): string => `branch-update:${writeId}`

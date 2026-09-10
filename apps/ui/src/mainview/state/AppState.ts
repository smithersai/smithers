import {
  CardPatchSchema,
  CardPlanItemSchema,
  CardSchema,
  EnvironmentImageRowSchema,
  SandboxEgressRowSchema,
  WorkspaceDesktopSchema,
  WorkspaceEnvironmentSchema,
  WorkspaceFileEntrySchema,
  WorkspaceHeadSchema,
  WorkspaceServiceSchema
} from "@smthrs/rpc/Cards"
import { AgentRoleIdSchema, AgentRoleSchema } from "@smthrs/rpc/AgentRoles"
import type { AgentRole, AgentRoleId } from "@smthrs/rpc/AgentRoles"
import { HARNESS_IDS, HarnessSchema, RepoFileEntrySchema, RepoSchema } from "@smthrs/rpc/LocalApp"
import type { Harness, Repo } from "@smthrs/rpc/LocalApp"
import { REPOSITORY_ACCESS_VALUES } from "@smthrs/rpc/NativeRepository"
import type { LocalRepositoryInspection, RepositoryAccess } from "@smthrs/rpc/NativeRepository"
import { z } from "zod"
import { CloudWikiState } from "../wiki/CloudWikiState"

export {
  CardPatchSchema,
  CardPlanItemSchema,
  CardSchema,
  EnvironmentImageRowSchema,
  SandboxEgressRowSchema,
  WorkspaceDesktopSchema,
  WorkspaceEnvironmentSchema,
  WorkspaceFileEntrySchema,
  WorkspaceHeadSchema,
  WorkspaceServiceSchema
}
export type {
  EnvironmentImageRow,
  SandboxEgressRow,
  WorkspaceDesktop,
  WorkspaceEnvironment,
  WorkspaceFileEntry,
  WorkspaceHead,
  WorkspaceService
} from "@smthrs/rpc/Cards"
import type { Card, CardPatch } from "@smthrs/rpc/Cards"
export type { Card, CardPatch, CardPlanItem } from "@smthrs/rpc/Cards"
export { AgentRoleSchema, HARNESS_IDS, HarnessSchema, RepoSchema }
export type { AgentRole, Harness, Repo }

/*
 * The sidebar's pinned repositories (docs/LOCAL-APP.md "Tabs"). A server
 * mints a fresh opaque `repoId` every time a repository is opened, so a pin
 * keys on what survives a reopen: the local path. Opening a repository pins
 * it; it stays pinned until unpinned, open or not. Tabs nest under the pin
 * they were opened in (`TabRow.repoKey`).
 */
export const PinnedRepoSchema = z.object({
  /** `repoKeyOf(path)`: stable across reopens. */
  id: z.string(),
  name: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  origin: z.literal("local"),
  pinnedAt: z.number()
})
export type PinnedRepo = z.infer<typeof PinnedRepoSchema>

/*
 * The flows one repository declares (Factory design session 2026-09-07 §4):
 * the `flows` rows of `.smithers/factory.json`, read for the active
 * repository through the public contents route, one row per repository. The
 * registry derives a slash leaf from every flow row (flows/entries/flow.ts
 * `repositoryFlowLeaves`), so `/review` runs the repository's review flow
 * exactly as `/flow.run review` does. Collection state, never persisted: a
 * projection changes when the repository lands, so every launch re-reads it.
 */
export const RepositoryFlowSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  summary: z.string().nullable(),
  featured: z.boolean(),
  modelInvocable: z.boolean()
})
export type RepositoryFlow = z.infer<typeof RepositoryFlowSchema>
export const RepositoryFlowsRowSchema = z.object({
  /** The `owner/repo` the projection belongs to. */
  id: z.string(),
  /** The projection's flow rows, featured first, in catalog order. */
  flows: z.array(RepositoryFlowSchema),
  loadedAt: z.number()
})
export type RepositoryFlowsRow = z.infer<typeof RepositoryFlowsRowSchema>

/*
 * The sidebar's repository file tree (docs/workbench-lanes/sidebar-tree.md):
 * one row per directory the user expanded in a working copy, keyed
 * `<copyId>#<path>` (`""` is the copy's root). `expanded` is the caret;
 * `state` is the listing's honest state — `loading` until the local route
 * answers, `loaded` with the entries it returned (nothing filtered, nothing
 * invented), `failed` with the server's error text verbatim. Collection
 * state, never React state, and NEVER persisted across launches: a checkout
 * changes on disk, so every launch starts with every row collapsed.
 */
export const RepoTreeEntrySchema = RepoFileEntrySchema
export type RepoTreeEntry = z.infer<typeof RepoTreeEntrySchema>
export const RepoTreeRowSchema = z.object({
  /** `repoTreeRowId(copyId, path)`. */
  id: z.string(),
  /** The working copy (`WorkingCopy.id`, `local:<path>` for a checkout). */
  copyId: z.string(),
  /** Relative to the copy's root; `""` is the root. */
  path: z.string(),
  expanded: z.boolean(),
  state: z.enum(["loading", "loaded", "failed"]),
  entries: z.array(RepoTreeEntrySchema),
  /** The route's error text, verbatim, when `state` is `failed`. */
  error: z.string().optional(),
  /** The route capped the listing at its first page by name. */
  truncated: z.boolean().optional(),
  loadedAt: z.number()
})
export type RepoTreeRow = z.infer<typeof RepoTreeRowSchema>
export const repoTreeRowId = (copyId: string, path: string): string => `${copyId}#${path}`

/*
 * A target this user starred (target.star): the targets card's Featured
 * view leads with the repository's manifest-featured labels plus these.
 * Keyed by the repo's pin key and the label so a star survives the server's
 * fresh repo id on a reopen.
 */
export const StarredTargetSchema = z.object({
  /** `${repoKey}::${label}`. */
  id: z.string(),
  repoKey: z.string(),
  label: z.string(),
  starredAt: z.number()
})
export type StarredTarget = z.infer<typeof StarredTargetSchema>

export const starredTargetId = (repoKey: string, label: string): string => `${repoKey}::${label}`

/** The pin key for a local path: the same key for an open repo and its connector. */
export const repoKeyOf = (path: string): string => `local:${path}`

/*
 * Lane piper (docs/decisions/0001-piper-one-truth.md): Smithers Cloud is the one
 * truth. A repository lives under a user or an org; its head is the default
 * bookmark's change and commit ids. NO mirror field: the backend has no
 * mirror status yet, and nothing here may fake one. The row is shaped so
 * plue#445's `owner_type` and `default_bookmark_head` replace the per-repo
 * bookmarks call when they land.
 */
export const RepoHeadSchema = z.object({
  bookmark: z.string(),
  changeId: z.string().nullable(),
  commitId: z.string().nullable()
})
export type RepoHead = z.infer<typeof RepoHeadSchema>

export const CloudRepositorySchema = z.object({
  /** `org/repo` — the first two segments of every global path. */
  id: z.string(),
  /** The owner's login (a user or an org). */
  org: z.string(),
  /** GET /api/user/orgs classifies the owner; "local" = no cloud repository (ADR 0001). */
  ownerKind: z.enum(["user", "org", "local"]),
  name: z.string(),
  /** The default bookmark's head; null while unloaded or when the repo declares none. */
  head: RepoHeadSchema.nullable(),
  /**
   * True for a row the public catalog (GET /api/public/repos) supplied: a
   * repository anyone reads signed out (apps/server/PUBLIC-REPOSITORIES.md).
   * Absent on the signed-in inventory.
   */
  catalog: z.boolean().optional(),
  /**
   * The catalog's curated one-sentence explanation of the repository, the
   * welcome's source (controller/onboarding.ts). Absent on the signed-in
   * inventory, which carries no such sentence.
   */
  summary: z.string().optional(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type CloudRepository = z.infer<typeof CloudRepositorySchema>

/*
 * A working copy of a repository (ADR 0001): a local checkout on this
 * machine, a cloud workspace (a box), or the SHARED copy of a public
 * repository: the one read-only virtual box every reader of a catalog
 * repository shares over the public mirror (factory design session ruling,
 * lane plan B2: a virtual copy over the mirror's contents reads; factory
 * spec 04 §2 gives a signed-in person one box per branch). It has no VM and
 * no terminal; its files are the mirror's contents route. A checkout computes `ahead` with jj; a
 * cloud workspace has no API field yet, so it carries state only (never
 * faked). `readAt` is the checkout's own jj position, when the local server
 * probed it. A shared copy is a materialized view (WorkspaceViews.ts), never
 * a persisted row.
 */
export const WorkingCopySchema = z.object({
  /** `local:<path>` (the pin key) for a checkout; `workspace:<workspaceId>` for a cloud workspace; `shared:<org/repo>` for the shared copy. */
  id: z.string(),
  /** The repositories row this is a copy of, or the checkout's name when no cloud repo matches. */
  repoId: z.string(),
  kind: z.enum(["local", "workspace", "shared"]),
  /**
   * The derived access bit (no role field on the wire yet, lane plan B2): `read`
   * for the shared copy, whose only route is the public mirror's contents
   * read, so no write door renders on it. Absent for a checkout and a box:
   * their own routes decide.
   */
  access: z.enum(["read", "write"]).optional(),
  /** The bookmark the copy tracks, when a seam supplied it: the shared copy reads the repositories row's head bookmark. */
  bookmark: z.string().optional(),
  label: z.string(),
  path: z.string().optional(),
  workspaceId: z.string().optional(),
  ahead: z.number().int().nonnegative().optional(),
  state: z.string().optional(),
  /** The checkout's jj position (a local probe); absent for workspaces and unprobed checkouts. */
  readAt: z.object({ changeId: z.string().nullable(), commitId: z.string().nullable() }).optional(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type WorkingCopy = z.infer<typeof WorkingCopySchema>

/*
 * The Smithers Cloud session as the renderer may know it (lane piper step 1b):
 * the token NEVER appears here — it lives in Bun memory and the OS keychain.
 * "degraded" scopes mean the legacy token set lacks workspace/agent/approval
 * scope, so those acts say "sign in again to enable".
 */
export const CloudSessionRowSchema = z.object({
  id: z.literal("cloud"),
  state: z.enum(["unknown", "signed-out", "signing-in", "signed-in"]),
  username: z.string().nullable(),
  expiresAt: z.string().nullable(),
  scopes: z.literal("degraded").nullable(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type CloudSessionRow = z.infer<typeof CloudSessionRowSchema>

export const initialCloudSession = (createdAt = Date.now()): CloudSessionRow => ({
  id: "cloud",
  state: "unknown",
  username: null,
  expiresAt: null,
  scopes: null,
  updatedAt: createdAt,
  revision: 0
})

/*
 * A cloud workspace (lane citc, ADR 0002; completed by lane L3): plue's
 * workspace DTO trimmed to what the app states — the six statuses, the
 * provisioning stage, the target bookmark, and the header facts plue#446
 * landed: the sandbox kind, the workspace's OWN head, ahead/behind, the
 * environment reference, persistence, the ssh host, and when the VM started.
 * Each of those is nullable AND optional: absent on the wire means absent on
 * the row and nothing rendered — never a default, never a guess. Optional so
 * a row persisted before this lane still validates without a schema reset.
 * This collection is the authority the workspace working copies
 * (`workingCopies`, kind "workspace") derive from.
 */
export const WORKSPACE_STATUSES = ["pending", "starting", "running", "suspended", "stopped", "failed"] as const
export const CloudWorkspaceStatusSchema = z.enum(WORKSPACE_STATUSES)
export type CloudWorkspaceStatus = z.infer<typeof CloudWorkspaceStatusSchema>

export const CloudWorkspaceRowSchema = z.object({
  /** plue's workspace id. */
  id: z.string(),
  /** `org/repo` — the repositories row this workspace is bound to. */
  repoId: z.string(),
  name: z.string(),
  targetBookmark: z.string().nullable(),
  status: CloudWorkspaceStatusSchema,
  /**
   * plue#482 `failure_code` / `failure_message`: why a `failed` workspace
   * failed, in the provider's own words. Both null when the platform
   * recorded none — a failure with no reason is a fact, not a blank.
   */
  failureCode: z.string().nullable().optional(),
  failureMessage: z.string().nullable().optional(),
  provisioningStage: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  /**
   * `container` / `vm` / `desktop` / `agent`, verbatim from the DTO (ADR 0002:
   * the kind IS the choice; RFD-004 added `agent` for the computer an agent
   * run executed in).
   */
  kind: z.string().nullable().optional(),
  /** The agent session that drove this workspace (RFD-004 `agent_session_id`); null for a human's. */
  agentSessionId: z.string().nullable().optional(),
  /** The workspace's own head as the guest last reported it — never the bookmark's. */
  head: WorkspaceHeadSchema.nullable().optional(),
  ahead: z.number().int().nullable().optional(),
  behind: z.number().int().nullable().optional(),
  /** When the VM last started; null while it has never run, and the uptime line is then absent. */
  startedAt: z.string().nullable().optional(),
  environment: WorkspaceEnvironmentSchema.nullable().optional(),
  persistence: z.string().nullable().optional(),
  sshHost: z.string().nullable().optional(),
  /**
   * Lane L3b: the DTO's `desktop` object — the relative stream path and the
   * last mint's id and expiry. Present only for `kind: "desktop"`; the
   * credential the facet renders never lands here (see seams/DesktopStream.ts).
   */
  desktop: WorkspaceDesktopSchema.nullable().optional(),
  /**
   * Lane L6 (plue #505): the languages the workspace relays a language server
   * for (DTO `lsp.languages`, `["typescript"]` today). Null when the DTO
   * carried no `lsp` object — unknown, never assumed empty.
   */
  lspLanguages: z.array(z.string()).nullable().optional(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type CloudWorkspaceRow = z.infer<typeof CloudWorkspaceRowSchema>

/** The fields a workspace load or act writes (the reducer adds updatedAt/revision). */
export type CloudWorkspaceInput = Omit<CloudWorkspaceRow, "updatedAt" | "revision">

/*
 * Lane change (ADR 0003 — the change is the unit): one change as the app
 * knows it, keyed `${repoId}#${changeId}` because a change id is per-repo and
 * a changeset's members span repos. The row carries what plue's change DTO
 * carries today — one `commitId`, no revisions — so `currentSeq` and
 * `revisionCount` stay null until plue#450 records them; nothing is inferred
 * from timestamps. Pinned cards (file, diff) read this collection to learn
 * when a newer revision exists.
 */
export const ChangeRowSchema = z.object({
  /** `${repoId}#${changeId}`. */
  id: z.string(),
  /** `org/repo`. */
  repoId: z.string(),
  changeId: z.string(),
  commitId: z.string().nullable(),
  description: z.string(),
  authorName: z.string().nullable(),
  timestamp: z.string().nullable(),
  hasConflict: z.boolean(),
  parentChangeIds: z.array(z.string()),
  /** null until plue#450 records revisions. */
  currentSeq: z.number().int().positive().nullable(),
  revisionCount: z.number().int().nonnegative().nullable(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type ChangeRow = z.infer<typeof ChangeRowSchema>

/** The fields a change load writes (the reducer adds updatedAt/revision). */
export type ChangeInput = Pick<
  ChangeRow,
  "id" | "repoId" | "changeId" | "commitId" | "description" | "authorName" | "timestamp" | "hasConflict" | "parentChangeIds" | "currentSeq" | "revisionCount"
>

/** The changes collection key for one repo's change. */
export const changeRowId = (repoId: string, changeId: string): string => `${repoId}#${changeId}`

/*
 * Lane sync (ADR 0005): one Linear integration as GET /api/linear answers it
 * — team, repository, active, last sync. The collection is the authority for
 * the Connectors surface's Linear row (per team, with last sync) and for the
 * bare-act resolution of linear.sync / linear.activity / linear.disconnect.
 * The wire's numeric id is the key, as a string.
 */
export const LinearIntegrationRowSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  teamKey: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  active: z.boolean(),
  remediation: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type LinearIntegrationRow = z.infer<typeof LinearIntegrationRowSchema>

/** The fields an integrations load writes (the reducer adds updatedAt/revision). */
export type LinearIntegrationInput = Pick<
  LinearIntegrationRow,
  "id" | "teamId" | "teamName" | "teamKey" | "repoOwner" | "repoName" | "active" | "remediation" | "lastSyncAt" | "createdAt"
>

/** The `org/repo` of an integration row. */
export const linearIntegrationRepo = (row: Pick<LinearIntegrationRow, "repoOwner" | "repoName">): string =>
  `${row.repoOwner}/${row.repoName}`

/*
 * Lane sync (ADR 0005): the GitHub App status the app has READ for one
 * repository (GET /api/repos/{o}/{r}/github-app-status). The Connectors
 * surface's GitHub row counts these — every counted row is a DTO read, so a
 * repo the app never checked is simply absent, never assumed. `rateLimit`
 * rides the status answer's own `github_rate_limit_*` fields when they
 * arrive; null when they don't.
 */
export const GitHubAppStatusRowSchema = z.object({
  /** `org/repo` (the key). */
  repo: z.string(),
  installed: z.boolean(),
  configured: z.boolean(),
  installationId: z.number().int().nullable(),
  /** The App's install page when the status answer carries it (untrusted until the card checks the origin). */
  installUrl: z.string().nullable(),
  rateLimit: z.object({
    limit: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    resetAt: z.string().nullable()
  }).nullable(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type GitHubAppStatusRow = z.infer<typeof GitHubAppStatusRowSchema>

/** The fields a status read writes (the reducer adds updatedAt/revision). */
export type GitHubAppStatusInput = Pick<
  GitHubAppStatusRow,
  "repo" | "installed" | "configured" | "installationId" | "installUrl" | "rateLimit"
>

/** The working-copy id of a local checkout: the pin key, stable across reopens. */
export const localCopyIdOf = (path: string): string => repoKeyOf(path)

/** The working-copy id of a public repository's shared read-only copy: one per repository, keyed on `org/repo`. */
export const sharedCopyIdOf = (repoId: string): string => `shared:${repoId}`

/**
 * The `org/repo` a remote URL names (`git@host:org/repo.git`,
 * `https://host/org/repo`), or null when the remote names nothing parseable.
 * A checkout whose remote does not parse keeps its own name — never an
 * invented owner.
 */
export const repoIdFromRemote = (remote: string | null | undefined): string | null => {
  if (remote === null || remote === undefined) return null
  const match = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote.trim())
  return match === null ? null : `${match[1]}/${match[2]}`
}

/**
 * The repo.select grammar (lane piper step 3): `org/repo` selects the
 * repository (its head); `org/repo#copyId` selects one working copy; and a
 * `local:/path` key selects a checkout that has no repository remote.
 */
export const parseRepoSelection = (
  token: string
): { readonly repoId: string; readonly copyId?: string } | { readonly localCopyId: string } | null => {
  const hash = token.indexOf("#")
  const head = hash === -1 ? token : token.slice(0, hash)
  if (/^[\w.-]+\/[\w.-]+$/.test(head)) {
    if (hash === -1) return { repoId: head }
    const copyId = token.slice(hash + 1)
    return copyId === "" ? null : { repoId: head, copyId }
  }
  return hash === -1 && token.startsWith("local:") ? { localCopyId: token } : null
}

export const ActorSchema = z.enum(["user", "smithers", "system"])
export type Actor = z.infer<typeof ActorSchema>

export const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "smithers"]),
  text: z.string(),
  reasoning: z.string().optional(),
  status: z.enum(["complete", "failed", "interrupted"]),
  statusDetail: z.string().optional(),
  /** A message-ridden action (sign-in rides the opening message; retry rides the failed-OAuth one). */
  action: z.object({ flow: z.string(), args: z.string().optional(), label: z.string() }).optional(),
  /** A one-line visible tool act ("Smithers ran /world.new-note") renders as a marker row, not a bubble. */
  act: z.string().optional(),
  createdAt: z.number(),
  ordinal: z.number().int().nonnegative(),
  /**
   * The conversation this message belongs to (docs/LOCAL-APP.md "Tabs").
   * There is one Smithers, so live rows carry no id; the field stays so rows
   * persisted by a build that had conversation tabs parse unchanged.
   */
  tabId: z.string().optional()
})
export type Message = z.infer<typeof MessageSchema>

export const DEFAULT_WORKSPACE_ID = "workspace-main"
export const DEFAULT_BRANCH_ID = "branch-main"

export const rootFrameId = (branchId: string): string => `frame-root:${branchId}`
export const cardFrameId = (branchId: string, cardId: string): string => `frame-card:${branchId}:${cardId}`

export const WorkspaceSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type Workspace = z.infer<typeof WorkspaceSchema>

/** Branch-owned conversation state. Host resources and credentials remain shared authorities. */
export const FrameSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  messages: z.array(MessageSchema),
  cards: z.array(CardSchema),
  worldDocuments: z.array(z.lazy(() => WorldDocumentSchema)),
  draft: z.string(),
  selectedWorldDocumentId: z.string().nullable().optional()
})
export type FrameSnapshot = z.infer<typeof FrameSnapshotSchema>

export const BranchSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  parentBranchId: z.string().nullable(),
  forkedFromFrameId: z.string().nullable(),
  forkedAtRevision: z.number().int().nonnegative().nullable(),
  snapshot: FrameSnapshotSchema.optional(),
  createdAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type Branch = z.infer<typeof BranchSchema>

export const FrameSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  branchId: z.string(),
  kind: z.enum(["root", "card"]),
  parentFrameId: z.string().nullable(),
  cardId: z.string().nullable(),
  presentation: z.enum(["embedded", "maximized"]),
  stateRevision: z.number().int().nonnegative(),
  snapshot: FrameSnapshotSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type Frame = z.infer<typeof FrameSchema>

/*
 * The shared toast stack (the 300ms law, 2026-08-09): background work that has
 * not settled within 300ms states what is running on ONE store-backed corner
 * surface; work under 300ms never flashes anything. Toasts are notifications,
 * not state mutations — they never gate the app, and a failure toast is
 * honest and stays until dismissed.
 */
export const ToastSchema = z.object({
  id: z.string(),
  /** The work identity ("billing.balance.refresh"): one toast per background flow. */
  key: z.string(),
  title: z.string(),
  status: z.enum(["running", "ok", "failed"]),
  detail: z.string(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Toast = z.infer<typeof ToastSchema>

/*
 * The Wiki's display name, centralized. Will renamed World to Wiki on
 * 2026-09-07: every user-visible label and flow summary reads this constant,
 * while `world` stays the persisted surface id, the card kind, the store
 * event prefix and the CSS class prefix, so no session migration is needed.
 */
export const WIKI_DISPLAY_NAME = "Wiki"

/*
 * The graph's unfocused scope, named by the design session (spec 07 §2): a
 * scope pill names a kind of wiki content, never a surface and never a store,
 * so the graph over everything reads "All" and not "the whole Wiki". The two
 * kinds it covers are the pages the //:wiki target generates and the person's
 * own notes; only notes exist today, and a scope that has no pages shows none
 * rather than an empty group. The focused scope stays `Around <path>`, which
 * names a note, not a store.
 */
export const WIKI_GRAPH_ALL_SCOPE = "All"

/*
 * Wave 10 (§2a/§2f) — pills are flow BINDINGS, never prompt strings: a
 * suggestion carries the flow it invokes directly, and the suggestion set
 * is DERIVED in App.tsx from live state (the genuinely-next step) — never
 * fabricated, never stored.
 */
export interface Suggestion {
  readonly id: string
  readonly label: string
  readonly flow: string
  readonly args?: string
  readonly emphasis: "primary" | "secondary"
  /** The recommender's one-line reason, when an agent chose the pill. */
  readonly why?: string
}

/*
 * The next-step pills are a projection of ONE store row, regenerated by the
 * `recommend` flow (Recommend.ts) after every material change: the server's
 * recommender (POST /api/recommend) orders what to click next from the chat
 * tail and the invocable flows (source "agent"), and the old state rule
 * stands in whenever the recommender cannot answer (source "rule").
 * Persisted so a reload shows the last recommendation instead of a blank row
 * while the first regeneration is in flight.
 */
export const SuggestionSchema = z.object({
  id: z.string(),
  label: z.string(),
  flow: z.string(),
  args: z.string().optional(),
  emphasis: z.enum(["primary", "secondary"]),
  why: z.string().optional()
})
export const RecommendationSourceSchema = z.enum(["agent", "rule"])
export type RecommendationSource = z.infer<typeof RecommendationSourceSchema>
export const RECOMMENDATION_ID = "current"
export const RecommendationSchema = z.object({
  id: z.literal(RECOMMENDATION_ID),
  suggestions: z.array(SuggestionSchema),
  source: RecommendationSourceSchema,
  /** The session revision the recommendation was made against. */
  revision: z.number().int().nonnegative(),
  createdAt: z.number()
})
export type Recommendation = z.infer<typeof RecommendationSchema>

/*
 * The color themes (/theme), the axis ORTHOGONAL to light/dark (/dark-mode):
 * a palette names a set of semantic color values, and each one ships both a
 * light and a dark variant in styles/tokens.css. This table is the one typed
 * authority for the keys and labels — the store's validation, the command's
 * argument spec, the /theme picker's swatch list, and the contrast gate all
 * derive from it, so adding a palette is one entry here plus its two CSS
 * blocks (and its swatch preview in cards/ThemePickerCard.tsx).
 */
export const PALETTE_METADATA = [
  { key: "night-owl", label: "Night Owl" },
  { key: "paper", label: "Paper" },
  { key: "fucory", label: "Fucory" },
  { key: "one", label: "One" },
  { key: "github", label: "GitHub" },
  { key: "catppuccin", label: "Catppuccin" },
  { key: "solarized", label: "Solarized" },
  { key: "gruvbox", label: "Gruvbox" },
  { key: "rose-pine", label: "Rosé Pine" }
] as const
export type Palette = (typeof PALETTE_METADATA)[number]["key"]
export const PALETTES = PALETTE_METADATA.map((entry) => entry.key) as unknown as readonly [
  Palette,
  ...Array<Palette>
]
/** The palette a session that has never chosen one gets (and the CSS default). */
export const DEFAULT_PALETTE: Palette = "night-owl"

export const isPalette = (value: string): value is Palette => (PALETTES as ReadonlyArray<string>).includes(value)

export const GuideSchema = z.object({
  responseId: z.string().uuid().optional(),
  demoRun: z.object({ id: z.string(), status: z.enum(["running", "succeeded", "interrupted"]), startedAt: z.number(), finishedAt: z.number().optional() }).optional(),
  /*
   * Version 1 persisted the 16-lesson introduction, where the light lesson
   * stood alone at step 2 and the scale ran to 15. Version 2 folds it into
   * the theme lesson, so every later lesson moved one down. Both shapes stay
   * readable; the store's seed remaps a version-1 guide once, by version.
   */
  version: z.union([z.literal(1), z.literal(2)]),
  playthrough: z.number().int().nonnegative().optional(),
  step: z.number().int().min(0).max(15),
  conversationOpen: z.boolean(),
  library: z.boolean(),
  librarian: z.boolean(),
  heard: z.string().max(500),
  project: z.string().max(500),
  prototypeTitle: z.string().max(100),
  revised: z.boolean(),
  acceptedPracticeTitle: z.string().max(100).optional(),
  sound: z.boolean()
})
export type GuideState = z.infer<typeof GuideSchema>
export const initialGuide = (): GuideState => ({ version: 2, step: 0, conversationOpen: false,
  library: false, librarian: false, heard: "", project: "", prototypeTitle: "A little room for big ideas", revised: false, sound: false })

export const SessionSchema = z.object({
  guide: GuideSchema.optional(),
  id: z.literal("main"),
  draft: z.string(),
  phase: z.enum(["idle", "responding"]),
  theme: z.enum(["light", "dark"]),
  /*
   * The color theme. Optional (missing = DEFAULT_PALETTE) so sessions
   * persisted before the field parse without a schema reset — the same
   * discipline pendingCommand follows below; a zod default
   * would fork the schema's input and output types and break collection
   * inference.
   */
  palette: z.enum(PALETTES).optional(),
  composerOwner: z.enum(["user", "smithers"]),
  /* The pane the chat shell has open beside the conversation ("flows": will, ask 5, 2026-09-02). */
  surface: z.enum(["chat", "world", "connectors", "flows", "plugins"]),
  /*
   * The plugins installed on this workspace, in the order a person added
   * them. Optional (missing = none installed) so sessions persisted before
   * the plugin shelf existed parse unchanged, the same discipline `palette`
   * follows above.
   */
  plugins: z.array(z.string()).optional(),
  selectedWorldDocumentId: z.string().nullable(),
  /** The card currently maximized (a presentation transition; null = embedded). */
  maximizedCardId: z.string().nullable(),
  /** Durable navigation scope; optional only for rows written before frames existed. */
  activeWorkspaceId: z.string().optional(),
  activeBranchId: z.string().optional(),
  activeFrameId: z.string().optional(),
  /** The admin dev-tools panel (§2b/§2d) — only ever true for admin sessions. */
  devtoolsOpen: z.boolean(),
  /** The composer surfaces menu (the /surfaces command's open state). */
  surfacesMenuOpen: z.boolean(),
  /*
   * The composer connect menu's open state. A component is a projection and
   * never an authority, so the menu that used to live in a `useState` lives
   * here — opened and closed through the transition dispatcher with the actor
   * recorded, exactly like surfacesMenuOpen above. Optional (missing = closed)
   * so sessions persisted before the field parse without a schema reset.
   *
   * `initialSession` supplies false for new sessions. The storage openers now
   * run schema decoders, but this remains optional for older snapshots and
   * in-memory producers too. Every read uses `=== true` / `!== true`, so an
   * omitted field consistently means closed at all of those boundaries.
   */
  connectMenuOpen: z.boolean().optional(),
  /** Admin reset confirmation; optional for sessions persisted before this field. */
  resetConfirmOpen: z.boolean().optional(),
  /*
   * The maintainer's /verbose switch: while on, every flow invocation and
   * every non-user transition (background, system, agent) renders as a trace
   * line in the transcript and the transition logger writes to the console.
   * Optional (missing = off) so sessions persisted before the field parse.
   */
  verbose: z.boolean().optional(),
  /*
   * The note `/world.delete` is asking about (§10.6, §28.4). Deleting is not
   * undoable, so the flow ASKS and the answer is an act of its own — and the
   * question lives in the store rather than in a component's local state,
   * because a component is a projection and never an authority. Optional so
   * sessions persisted before the field parse without a schema reset.
   */
  pendingWorldDeleteId: z.string().nullable().optional(),
  /*
   * The Wiki pane's mode (Librarian L5): the note editor with its link rail,
   * or the knowledge graph over the same notes. `wiki.graph [path]` switches
   * it and `wikiGraphPath` names the note the graph is focused on (null =
   * every page). Both live here, not in a component, for the reason
   * pendingWorldDeleteId does; optional so persisted sessions parse.
   */
  wikiPane: z.enum(["document", "graph"]).optional(),
  wikiGraphPath: z.string().nullable().optional(),
  /** Repository whose disconnect confirmation is open. */
  pendingConnectorRemovalId: z.string().nullable().optional(),
  /*
   * The one deferred command (requirement axis): a user-invoked command whose
   * requirement (e.g. signed-in) was unmet parks HERE while the fulfilling
   * command runs, and resumes when the requirement's predicate flips true.
   * Persisted because sign-in is a full OAuth redirect — the intent must
   * survive the reload. Optional (missing = none) so persisted sessions from
   * before the field parse without a schema reset, like palette above.
   * Latest wins: deferring a second command replaces the first.
   */
  pendingCommand: z
    .object({
      name: z.string(),
      args: z.string().nullable(),
      /** The requirement id the command is waiting on. */
      requirement: z.string(),
      requestedAt: z.number()
    })
    .nullable()
    .optional(),
  /*
   * The user's recently run visible commands, most recent first (capped in
   * the reducer): the slash menu's recency ranking past its cap. Optional
   * (missing = none) so persisted sessions parse without a schema reset.
   */
  recentCommands: z.array(z.string()).optional(),
  /*
   * The local-app tab strip (docs/LOCAL-APP.md "Tabs"). The selected tab,
   * the `+` menu's open state, and the tab a close is asking about all live
   * here for the same reason as connectMenuOpen and pendingWorldDeleteId: a
   * component is a projection, never an authority. Optional (missing =
   * main / closed / none) so sessions persisted before the fields parse.
   */
  activeTabId: z.string().optional(),
  /*
   * The conversation the turn in flight was asked in: a chat tab's id, or
   * null for main. Read only while `phase` is "responding", so a response
   * lands in the tab that asked even if the human switched tabs meanwhile.
   * Optional (missing = main) so persisted sessions parse without a reset.
   */
  turnTabId: z.string().nullable().optional(),
  /*
   * The turn in flight. Read only while `phase` is "responding", so boot
   * reconciliation names the turn the session was actually answering:
   * steering inserts its own `message-steer-<revision>` user bubble and a
   * retry re-runs an older turn, so the newest user message does not
   * identify it. Optional (missing = derive it from the transcript) so
   * sessions persisted before the field parse without a schema reset.
   */
  turnId: z.string().nullable().optional(),
  tabMenuOpen: z.boolean().optional(),
  pendingTabCloseId: z.string().nullable().optional(),
  /** The composer's `+` menu (the /composer.add command's open state); optional like the menus above. */
  addMenuOpen: z.boolean().optional(),
  /*
   * The search palette (Search and Command Palette Spec 2026-09-07 §3, §5):
   * the overlay's open state, the item whose actions panel is open, the last
   * query (Cmd+Shift+K reopens it) and the recents ledger the ranking reads.
   * Session state like the menus above, never a component's; all optional so
   * sessions persisted before the fields parse without a schema reset.
   */
  paletteOpen: z.boolean().optional(),
  paletteActionsRef: z.string().nullable().optional(),
  paletteLastQuery: z.string().optional(),
  paletteRecents: z
    .array(z.object({ ref: z.string(), kind: z.string(), count: z.number().int().positive(), lastSeen: z.number() }))
    .optional(),
  /*
   * The active repository as a pin key (`repoKeyOf`): the row the sidebar
   * highlights, the name the composer's selector shows, and where a new
   * terminal or agent starts. Optional (missing = the first open repo).
   */
  activeRepoKey: z.string().nullable().optional(),
  /*
   * The sidebar heading's name (docs/workbench-lanes/sidebar-tree.md):
   * `workspace.rename <name>` writes it; the heading renders "Workspace"
   * until it is set. `workspaceRenameOpen` is the inline editor the pencil
   * opens (workspace.rename.edit) — session state like every other menu,
   * so a component never owns it. Both optional so persisted sessions parse.
   */
  workspaceName: z.string().optional(),
  workspaceRenameOpen: z.boolean().optional(),
  revision: z.number().int().nonnegative()
})
export type Session = z.infer<typeof SessionSchema>

/** The heading's default until the user names the workspace. */
export const DEFAULT_WORKSPACE_NAME = "Workspace"

/**
 * The active open repository: the one the session names when it is open,
 * else the first open one by name. One rule for the sidebar, the composer's
 * selector, and the tabs controller, so a terminal never starts somewhere
 * the header does not show.
 */
export const activeRepoOf = (
  session: Pick<Session, "activeRepoKey">,
  repos: Iterable<Repo>
): Repo | undefined => {
  const open = [...repos].sort((left, right) => left.name.localeCompare(right.name))
  const named = session.activeRepoKey === undefined || session.activeRepoKey === null
    ? undefined
    : open.find((repo) => repoKeyOf(repo.path) === session.activeRepoKey)
  return named ?? open[0]
}

/*
 * The local-app tabs (docs/LOCAL-APP.md "Tabs"). `Tab` is the contract union
 * verbatim; `TabRow` is what the collection stores: the same record plus its
 * place in the strip (creation order) and, for a process tab, the exit code
 * once the PTY ends (undefined while it is alive).
 */
export type Tab =
  | { id: "main"; kind: "main"; title: "Smithers" }
  | {
    id: string
    kind: "terminal"
    title: string
    sessionId: string
    /**
     * The local directory; absent on a workspace terminal (lane citc), whose
     * process runs inside the cloud workspace, not here.
     */
    cwd?: string
    /** A cloud-workspace terminal: the workspace it attaches to, and the repo the session routes through. */
    workspaceId?: string
    repo?: string
    repoKey?: string
  }
  | {
    id: string
    kind: "harness"
    title: string
    sessionId: string
    harnessId: Harness["id"]
    /** The named role it was launched as (AgentRoles.ts); absent for a raw harness. */
    roleId?: AgentRoleId
    cwd: string
    repoKey?: string
  }
  | { id: string; kind: "card"; title: string; cardId: string; repoKey?: string }

const tabRowShape = {
  ordinal: z.number().int().nonnegative(),
  /** The pinned repository the tab nests under in the sidebar; absent = "No repository". */
  repoKey: z.string().optional()
}
const processTabShape = {
  ...tabRowShape,
  sessionId: z.string(),
  cwd: z.string(),
  exitCode: z.number().nullable().optional()
}

export const TabSchema = z.discriminatedUnion("kind", [
  z.object({ ...tabRowShape, id: z.literal("main"), kind: z.literal("main"), title: z.literal("Smithers") }),
  z.object({
    ...tabRowShape,
    id: z.string(),
    kind: z.literal("terminal"),
    title: z.string(),
    sessionId: z.string(),
    /* Optional like the TS union: a workspace terminal (lane citc) has no local cwd. */
    cwd: z.string().optional(),
    exitCode: z.number().nullable().optional(),
    workspaceId: z.string().optional(),
    repo: z.string().optional()
  }),
  z.object({
    ...processTabShape,
    id: z.string(),
    kind: z.literal("harness"),
    title: z.string(),
    harnessId: z.enum(HARNESS_IDS),
    roleId: AgentRoleIdSchema.optional()
  }),
  z.object({ ...tabRowShape, id: z.string(), kind: z.literal("card"), title: z.string(), cardId: z.string() })
])
export type TabRow = z.infer<typeof TabSchema>

/**
 * The conversation a transcript row belongs to, as a tab id. There is ONE
 * Smithers: the first tab, aware of every other one — so the conversation is
 * always main's (undefined). The scoping seam stays so a turn in flight keeps
 * writing where it started, and so a persisted row that carries a `tabId`
 * from an earlier build still parses.
 */
export const conversationTabIdOf = (
  session: Pick<Session, "phase" | "activeTabId" | "turnTabId">,
  _tabOf: (id: string) => TabRow | undefined
): string | undefined => {
  if (session.phase === "responding" && session.turnTabId !== undefined) return session.turnTabId ?? undefined
  return undefined
}

/** Whether a row (message or card) belongs to the given conversation. */
export const inConversation = (row: { readonly tabId?: string | undefined }, tabId: string | undefined): boolean =>
  (row.tabId ?? undefined) === tabId

export const MAIN_TAB_ID = "main"

export const mainTab = (): TabRow => ({ id: "main", kind: "main", title: "Smithers", ordinal: 0 })

/*
 * The tool-call stream the admin dev-tools panel reads (Wave 10, §2b): the
 * full arguments AND result of every agent tool act. Persisted like
 * everything else, recorded with actor smithers, and rendered ONLY in the
 * admin panel — the transcript itself never carries raw payloads.
 */
export const ToolCallRecordSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  name: z.string(),
  arguments: z.string(),
  result: z.string(),
  createdAt: z.number()
})
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>

export const TransitionRecordSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  actor: ActorSchema,
  type: z.string(),
  payload: z.string(),
  createdAt: z.number()
})
export type TransitionRecord = z.infer<typeof TransitionRecordSchema>

/*
 * One chain journal event (DESIGN.md §14) — the durable evidence of a chain
 * turn. `event` is the @smthrs/chain Event as plain JSON: stored opaque here
 * because state schemas stay runtime-free, and schema-validated by the chain
 * journal layer on read. `seq` orders events within one lineage. This
 * collection is the app-layer stand-in for the Smithers engine journal; when the
 * engine mounts it becomes a sync-fed projection and readers do not change.
 */
export const ChainEventRecordSchema = z.object({
  id: z.string(),
  lineageId: z.string(),
  seq: z.number().int().nonnegative(),
  event: z.unknown(),
  createdAt: z.number()
})
export type ChainEventRecord = z.infer<typeof ChainEventRecordSchema>

/** A permanent replay refusal after account data was scrubbed; no event content. */
export const RetiredChainLineageSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/)
})
export type RetiredChainLineage = z.infer<typeof RetiredChainLineageSchema>

export const WorldDocumentSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  body: z.string(),
  links: z.array(z.string()),
  tags: z.array(z.string()),
  sources: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  cloud: CloudWikiState.optional(),
  updatedAt: z.number(),
  updatedBy: ActorSchema,
  revision: z.number().int().nonnegative()
})
export type WorldDocument = z.infer<typeof WorldDocumentSchema>

export const RepositoryCapabilityPatternSchema = z.object({
  action: z.enum(["fs:read", "fs:write"]),
  resource: z.string()
})
export type RepositoryCapabilityPattern = z.infer<typeof RepositoryCapabilityPatternSchema>

export const LocalRepositoryConnectorSchema = z.object({
  id: z.string(),
  kind: z.literal("local-repository"),
  status: z.literal("connected"),
  access: z.enum(REPOSITORY_ACCESS_VALUES),
  name: z.string(),
  root: z.string(),
  head: z.string().nullable(),
  branch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  capabilities: z.array(RepositoryCapabilityPatternSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type LocalRepositoryConnector = z.infer<typeof LocalRepositoryConnectorSchema>

export const ConnectorOperationSchema = z.object({
  id: z.literal("connector-operation"),
  phase: z.enum(["idle", "selecting-local-repository"]),
  requestedAccess: z.enum(REPOSITORY_ACCESS_VALUES).nullable(),
  error: z.string().nullable(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type ConnectorOperation = z.infer<typeof ConnectorOperationSchema>

/*
 * The identity session record: one row, driven only by real answers from the
 * identity seam (GET /api/auth/session). "unknown" is pre-load; "unavailable"
 * is an honest seam failure — neither changes the chat, because neither is a
 * definitive answer about the person. Signed-out and non-allowlisted are
 * definitive and change what the chat CONTAINS (the opening Smithers message
 * carries the one available action) — never which page exists.
 */
export const IdentitySessionSchema = z.object({
  id: z.literal("identity"),
  state: z.enum(["unknown", "signed-out", "signed-in", "unavailable"]),
  login: z.string().nullable(),
  /** Owner of retained account data, even while identity is unavailable. Missing only on legacy rows. */
  accountOwnerLogin: z.string().nullable().optional(),
  allowlisted: z.boolean(),
  admin: z.boolean(),
  accessRequested: z.boolean(),
  accessError: z.string().nullable(),
  /** Plain-words scope list fetched from GET /api/auth/scopes; null = honest fallback copy. */
  scopesPlain: z.string().nullable(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type IdentitySession = z.infer<typeof IdentitySessionSchema>

/*
 * The billing record: one row, dollars only (no credit abstraction). Chat is
 * complimentary during the alpha (the billing seam records true cost, debits
 * zero), so a definitive $0 NEVER pauses the composer or the chat — the pause
 * discipline applies only to non-complimentary (paid) work, and the dollar
 * balance chip stays visible either way.
 */
export const BillingAccountSchema = z.object({
  id: z.literal("billing"),
  state: z.enum(["unknown", "ok", "low", "empty", "unavailable"]),
  totalUsd: z.string().nullable(),
  allowedToStartWork: z.boolean(),
  lifetimeChargedUsd: z.string().nullable(),
  chargeCount: z.number().int().nonnegative(),
  refreshedAt: z.number().nullable(),
  revision: z.number().int().nonnegative()
})
export type BillingAccount = z.infer<typeof BillingAccountSchema>

export type AppTransition =
  | { type: "composer.changed"; actor: Actor; draft: string }
  | { type: "message.submitted"; actor: "user" | "smithers"; turnId: string; text: string }
  | {
    type: "message.response.delta"
    actor: "smithers"
    turnId: string
    channel: "text" | "reasoning"
    delta: string
  }
  | {
    type: "message.response.completed"
    actor: "smithers"
    turnId: string
  }
  | {
    type: "message.response.failed"
    actor: "system"
    turnId: string
    message: string
  }
  | {
    /*
     * /retry re-RUNS the last turn: the answer that turn produced is
     * dropped and the same turn id launches again. Re-SENDING the prompt
     * instead appended a second user bubble per retry, so the transcript
     * grew a duplicate pair every time and every retry re-sent a longer
     * history than the one before it.
     */
    type: "message.retried"
    actor: "user"
    turnId: string
  }
  | {
    type: "message.response.cancelled"
    // "user" pressed stop; "system" is a server-side kill ending the stream.
    actor: "user" | "system"
    turnId: string
    /** One honest line naming what was stopped. */
    detail?: string
  }
  | {
    /*
     * Boot reconciliation: the persisted session said a turn was in
     * flight when the app went away, so the stream is orphaned — there
     * is no turnId to cancel and no done frame will ever arrive. The
     * boot names what happened (the in-flight message is marked
     * interrupted, the phase returns to idle) instead of restoring a
     * silently stuck "responding" surface.
     */
    type: "session.turn.orphaned"
    actor: "system"
  }
  | { type: "conversation.reset"; actor: "user" }
  | { type: "conversation.reset.asked"; actor: "user"; open: boolean }
  | {
    /*
     * One commit archives the outgoing branch, adds optional summary notes,
     * and starts a fresh conversation. Notes are append-only, never upserts.
     */
    type: "conversation.cleared"
    actor: "user"
    branchId: string
    notes: ReadonlyArray<{ readonly title: string; readonly body: string; readonly confidence: number }>
    interruptedTurnId?: string
  }
  | { type: "app.reset"; actor: Actor }
  | { type: "guide.changed"; actor: Actor; guide: GuideState }
  | { type: "theme.changed"; actor: "user" | "system"; theme: Session["theme"] }
  /* The color theme (/theme) — the axis orthogonal to light/dark. */
  | { type: "palette.changed"; actor: "user"; palette: Palette }
  | {
    /* Maximize/minimize an embedded card — a presentation transition, user-only. */
    type: "card.maximized"
    actor: "user"
    id: string
  }
  | { type: "card.minimized"; actor: "user" }
  | {
    type: "frame.navigated"
    actor: "user" | "system"
    workspaceId: string
    branchId: string
    frameId: string
  }
  | {
    type: "frame.forked"
    actor: "user"
    branch: Branch
    rootFrame: Frame
    selectedFrame: Frame
  }
  | {
    /* The admin dev-tools panel opens/closes (registered only for admins). */
    type: "devtools.toggled"
    actor: "user"
    open: boolean
  }
  | {
    /* The /verbose switch flips; the reducer states it in the transcript. */
    type: "verbose.toggled"
    actor: "user"
    on: boolean
  }
  | {
    /*
     * One flow invocation settled through the registry's single run path —
     * every trigger (button, slash, agent, deferral) included. Always recorded
     * as a transition; rendered as a transcript trace line only while verbose.
     */
    type: "flow.invoked"
    actor: "user" | "smithers"
    name: string
    args: string | null
    hidden: boolean
    outcome: "executed" | "failed" | "unknown-command" | "deferred" | "confirm-requested" | "form"
    detail: string | null
    durationMs: number
  }
  | {
    /* The composer surfaces menu opens/closes (the surfaces command). */
    type: "surfaces-menu.toggled"
    actor: "user"
    open: boolean
  }
  | {
    /* The composer connect menu opens/closes (trigger, Escape, outside press). */
    type: "connect-menu.toggled"
    actor: "user"
    open: boolean
  }
  | {
    /* The composer `+` menu opens/closes (trigger, Escape, outside press, an entry). */
    type: "add-menu.toggled"
    actor: "user"
    open: boolean
  }
  | {
    /* The search palette opens/closes (Cmd+K, Escape, Enter on an item); a close remembers the query. */
    type: "palette.toggled"
    actor: "user"
    open: boolean
    lastQuery?: string
  }
  | {
    /* The palette's actions panel opens for one item (→, a second Cmd+K) or closes (←, Escape). */
    type: "palette.actions.toggled"
    actor: "user"
    ref: string | null
  }
  | {
    /* An item opened from the palette: the recents ledger (§5) the ranking reads. */
    type: "palette.item.opened"
    actor: "user"
    ref: string
    kind: string
    at: number
  }
  | {
    /*
     * A user-invoked command parked on an unmet requirement (requirement
     * axis): the fulfilling command runs now; this record resumes the
     * original when the requirement's predicate flips true.
     */
    type: "command.deferred"
    actor: "user"
    name: string
    args: string | null
    requirement: string
  }
  | {
    /* The deferred command resumed (or went stale) — the parking spot clears. */
    type: "command.deferral.cleared"
    actor: "system"
  }
  | {
    /* A visible command ran for the user — the slash menu's recency signal. */
    type: "command.ran"
    actor: "user"
    name: string
  }
  | {
    /* The full-fidelity record of one agent tool act (dev-tools panel only). */
    type: "toolcall.recorded"
    actor: "smithers"
    turnId: string
    name: string
    arguments: string
    result: string
  }
  | {
    /* A failed background must remain dormant even if its journal is unreadable. */
    type: "chain.lineage.retired"
    actor: "system"
    lineageId: string
  }
  | {
    /* One chain journal event appended; seq is per lineage (DESIGN.md §14). */
    type: "chain.event.appended"
    actor: "smithers" | "system"
    lineageId: string
    seq: number
    event: unknown
  }
  | {
    /*
     * A parked chain lineage resumes after an approval decision: the
     * session re-enters responding for the same turn id (DESIGN.md §14).
     */
    type: "chain.turn.resumed"
    actor: "system"
    turnId: string
  }
  | {
    type: "composer.control.changed"
    actor: "smithers" | "system"
    owner: Session["composerOwner"]
    draft?: string
  }
  | {
    type: "surface.changed"
    actor: Actor
    surface: Session["surface"]
  }
  /* A plugin is added to (or taken off) this workspace's shelf. */
  | {
    type: "plugin.installed"
    actor: Actor
    plugin: string
  }
  | {
    type: "plugin.removed"
    actor: Actor
    plugin: string
  }
  | {
    type: "world.document.selected"
    actor: Actor
    id: string
  }
  | {
    type: "world.document.upserted"
    actor: Actor
    document: Omit<WorldDocument, "updatedAt" | "updatedBy" | "revision">
    /*
     * false = write without stealing the world surface's selection. The
     * user-facing editor keeps the default; agent memory writes pass
     * false so a background remember never moves what the human reads.
     */
    select?: boolean
  }
  | {
    type: "world.document.removed"
    actor: Actor
    id: string
  }
  | {
    /* The Wiki pane's mode: the editor or the graph, focused on a note or over every page. */
    type: "wiki.pane.changed"
    actor: Actor
    pane: "document" | "graph"
    path: string | null
  }
  | {
    /*
     * The delete question, asked and answered (§10.6). `id: null` is the
     * answer "no" — the dialog closes and the note stays.
     */
    type: "world.delete.asked"
    actor: Actor
    id: string | null
  }
  | {
    type: "connector.local.requested"
    actor: "user"
    access: RepositoryAccess
  }
  | {
    type: "connector.local.cancelled"
    actor: "user" | "system"
  }
  | {
    type: "connector.local.failed"
    actor: "system"
    message: string
  }
  | {
    type: "connector.local.connected"
    actor: "system"
    access: RepositoryAccess
    repository: LocalRepositoryInspection
  }
  | {
    type: "connector.access.changed"
    actor: "user"
    id: string
    access: RepositoryAccess
  }
  | { type: "connector.removal.asked"; actor: "user"; id: string | null }
  | {
    type: "connector.removed"
    actor: "user"
    id: string
  }
  | { type: "card.upsert"; actor: Actor; card: Card }
  // Local producers may omit kind: the store binds it to the existing card.
  // RPC producers must pass the discriminated CardPatchSchema instead.
  | { type: "card.updated"; actor: Actor; id: string; patch: Omit<CardPatch, "kind"> & { kind?: Card["kind"] } }
  | {
    type: "card.approval.decision.pending"
    actor: "user"
    id: string
  }
  | {
    type: "card.approval.decision.failed"
    actor: "system"
    id: string
    message: string
  }
  | {
    type: "card.approval.decided"
    actor: "user"
    id: string
    decision: "approved" | "denied"
    decidedAt: number
  }
  | {
    type: "identity.session.loaded"
    actor: "system"
    state: "signed-out" | "signed-in" | "unavailable"
    login: string | null
    allowlisted: boolean
    admin: boolean
    scopesPlain: string | null
  }
  | { type: "identity.access.requested"; actor: "user" }
  | { type: "identity.access.failed"; actor: "system"; message: string }
  | { type: "identity.session.cleared"; actor: "user" }
  | {
    type: "billing.refreshed"
    actor: "system"
    state: "ok" | "low" | "empty"
    totalUsd: string
    allowedToStartWork: boolean
    lifetimeChargedUsd: string
    chargeCount: number
  }
  | { type: "billing.unavailable"; actor: "system" }
  | {
    /* The 300ms toast law: slow background work states what is running. */
    type: "toast.shown"
    actor: "system"
    key: string
    title: string
  }
  | {
    /* Settled: ok resolves (auto-dismisses); failed stays honest until dismissed. */
    type: "toast.resolved"
    actor: "system"
    key: string
    status: "ok" | "failed"
    /** The settled title, so a done toast stops reading as still running. */
    title?: string
    detail: string
  }
  | { type: "toast.dismissed"; actor: "user" | "system"; id: string }
	| { type: "card.removed"; actor: Actor; id: string }
  | {
    /* The visible one-line record of an agent tool execution. */
    type: "message.tool.executed"
    actor: "smithers"
    turnId: string
    text: string
  }
  | {
    /*
     * Mid-turn input admitted as steering (DESIGN.md §14): the user's
     * words render as their own bubble without touching the turn phase;
     * the running chain drains them at its next link boundary.
     */
    type: "message.steered"
    actor: "user"
    turnId: string
    text: string
  }
  | {
    /*
     * Wave 12 §1 — the deterministic claim surface. A turn that launched a
     * run does not get to narrate it: the client replaces the model's prose
     * for that turn with the one line it is willing to stand behind. Actor
     * system, journaled, so the substitution is a recorded act rather than
     * an invisible edit.
     */
    type: "message.claim.substituted"
    actor: "system"
    turnId: string
    text: string
  }
  | {
    /* A complete one-line Smithers message (admin results, honest states, auth replies). */
    type: "message.appended"
    /** The initiator of this app-authored reply, independently of its transcript role. */
    actor: "system" | "user" | "smithers"
    text: string
    /** The action that rides the message (sign-in, request access, retry, a confirm flow). */
    action?: { flow: string; args?: string; label: string }
  }
  /* The local-app tabs (docs/LOCAL-APP.md "Tabs"). */
  | { type: "tab.opened"; actor: Actor; tab: Tab }
  | { type: "tab.selected"; actor: Actor; id: string }
  | {
    /* The close question for a tab whose process is alive; `id: null` answers "keep it". */
    type: "tab.close.asked"
    actor: Actor
    id: string | null
  }
  | { type: "tab.closed"; actor: "user" | "system"; id: string }
  | { type: "tab.menu.toggled"; actor: Actor; open: boolean }
  | { type: "pty.exited"; actor: "system"; sessionId: string; code: number | null }
  | { type: "harnesses.loaded"; actor: "system"; harnesses: ReadonlyArray<Harness> }
  /* Agents as data (custom-agents.md): `GET /api/agents` replaces the app-agents mirror the way the harness list does. */
  | { type: "agents.loaded"; actor: "system"; agents: ReadonlyArray<AgentRole> }
  | { type: "repos.loaded"; actor: "system"; repos: ReadonlyArray<Repo> }
  /*
   * Lane piper: the cloud repository inventory (RepositoriesSeam) replaces
   * the repositories collection; the cloud workspace list replaces the
   * workspace working copies (local copies sync from pins/repos.loaded); the
   * cloud session record answers { state, username, expiresAt, scopes } —
   * never the token.
   */
  | {
    type: "repositories.loaded"
    actor: "system"
    repositories: ReadonlyArray<Pick<CloudRepository, "id" | "org" | "ownerKind" | "name" | "head" | "catalog" | "summary">>
  }
  /*
   * One repository row upserted: the catalog row a `/owner/name` request
   * opens, and that row's default bookmark once the mirror answers
   * (RepoLink.ts). Every other row is left as it was, so a caller adding one
   * row never re-projects the whole collection. A row keeps its fresher head
   * when the upsert carries none, the same reading `repositories.loaded` takes.
   */
  | {
    type: "repository.upserted"
    actor: "system"
    repository: Pick<CloudRepository, "id" | "org" | "ownerKind" | "name" | "head" | "catalog" | "summary">
  }
  | {
    type: "workingcopies.workspaces.loaded"
    actor: "system"
    copies: ReadonlyArray<Pick<WorkingCopy, "id" | "repoId" | "kind" | "label" | "workspaceId" | "state">>
  }
  | {
    type: "cloud.session.loaded"
    actor: "system"
    state: "signed-out" | "signing-in" | "signed-in"
    username: string | null
    expiresAt: string | null
    scopes: "degraded" | null
  }
  /*
   * Lane citc: the workspaces collection (the authority the workspace
   * working copies derive from). `workspaces.loaded` replaces a scope — the
   * per-user list (no repoId) or one repository's; `workspace.updated` upserts
   * one row (an act's answer, the watch's poll). Live working copies and card
   * headers are derived views over those rows.
   */
  | {
    type: "workspaces.loaded"
    actor: "system"
    workspaces: ReadonlyArray<CloudWorkspaceInput>
    /** Present = one repository's list replaced; absent = the per-user list. */
    repoId?: string
  }
  | {
    type: "workspace.updated"
    actor: "system"
    workspace: CloudWorkspaceInput
  }
  /*
   * A destroyed session and a deleted workspace are facts the card, the
   * collection, and the terminal tabs learn in ONE transaction: a tab whose
   * session or workspace is gone closes here, never one poll later.
   */
  | { type: "workspace.session.destroyed"; actor: Actor; sessionId: string }
  | { type: "workspace.deleted"; actor: Actor; workspaceId: string }
  /*
   * Lane change: one change read through the ChangeSeam (change.view, a
   * land's re-read). Upsert only — the collection answers "what is the
   * current revision of this change" for the pinned cards.
   */
  | {
    type: "change.loaded"
    actor: "system"
    change: ChangeInput
  }
  /*
   * Lane sync (ADR 0005): the Linear integrations list replaced (the signed-in
   * user's whole list — the route lists per user, so there is no scope) and
   * one repository's GitHub App status read. Both are DTO facts, never
   * inferred state.
   */
  | {
    type: "linear.integrations.loaded"
    actor: "system"
    integrations: ReadonlyArray<LinearIntegrationInput>
  }
  | {
    type: "github.app-status.loaded"
    actor: "system"
    status: GitHubAppStatusInput
  }
  /* The sidebar's pinned repositories: opening pins, unpinning forgets, selecting names the active one. */
  | { type: "repo.pinned"; actor: Actor; pin: PinnedRepo }
  | { type: "repo.unpinned"; actor: "user"; id: string }
  | { type: "repo.selected"; actor: Actor; id: string }
  /*
   * The sidebar's file tree (docs/workbench-lanes/sidebar-tree.md): a caret
   * toggles a directory row; a first expand (or a retry of a failed one)
   * marks it loading, and the local route's answer lands as loaded or failed.
   */
  | { type: "repo-tree.toggled"; actor: "user"; copyId: string; path: string; expanded: boolean }
  | { type: "repo-tree.loading"; actor: "user"; copyId: string; path: string }
  | { type: "repo-tree.loaded"; actor: "system"; copyId: string; path: string; entries: ReadonlyArray<RepoTreeEntry>; truncated: boolean }
  | { type: "repo-tree.failed"; actor: "system"; copyId: string; path: string; error: string }
  /* The repository's declared flows landed (or went absent: an empty list) from its factory projection. */
  | { type: "repository-flows.loaded"; actor: "system"; repo: string; flows: ReadonlyArray<RepositoryFlow> }
  /* The workspace heading: its name, and the inline editor the pencil opens. */
  | { type: "workspace.renamed"; actor: Actor; name: string }
  | { type: "workspace.rename.toggled"; actor: "user"; open: boolean }
  /* A user's star on a target (targets card Featured view); `repoId` names the open card the mirror lands on. */
  | { type: "target.starred"; actor: "user"; repoId: string; star: StarredTarget }
  | { type: "target.unstarred"; actor: "user"; repoId: string; id: string }
  | {
    /*
     * The next-step pills were regenerated (Recommend.ts): by the server's
     * recommender (source "agent") or by the state rule it falls back to
     * (source "rule"). `revision` is the session revision the read was made
     * against, so a stale answer never overwrites a fresher one.
     */
    type: "recommendations.updated"
    actor: "system" | "smithers"
    suggestions: ReadonlyArray<Suggestion>
    source: RecommendationSource
    revision: number
  }

export const initialSession = (theme: Session["theme"]): Session => ({
  id: "main",
  draft: "",
  phase: "idle",
  theme,
  palette: DEFAULT_PALETTE,
  composerOwner: "user",
  surface: "chat",
  selectedWorldDocumentId: "world-home",
  maximizedCardId: null,
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  activeBranchId: DEFAULT_BRANCH_ID,
  activeFrameId: rootFrameId(DEFAULT_BRANCH_ID),
  devtoolsOpen: false,
  surfacesMenuOpen: false,
  connectMenuOpen: false,
  resetConfirmOpen: false,
  verbose: false,
  pendingWorldDeleteId: null,
  wikiPane: "document",
  wikiGraphPath: null,
  pendingConnectorRemovalId: null,
  activeTabId: MAIN_TAB_ID,
  tabMenuOpen: false,
  pendingTabCloseId: null,
  addMenuOpen: false,
  activeRepoKey: null,
  revision: 0
})

export const initialWorldDocuments = (createdAt = Date.now()): ReadonlyArray<WorldDocument> => [
  {
    id: "world-home",
    path: "World.md",
    title: "World",
    body: "# World\n\n",
    links: [],
    tags: [],
    sources: ["system:bootstrap"],
    confidence: 1,
    updatedAt: createdAt,
    updatedBy: "system",
    revision: 0
  }
]

export const initialConnectorOperation = (createdAt = Date.now()): ConnectorOperation => ({
  id: "connector-operation",
  phase: "idle",
  requestedAccess: null,
  error: null,
  updatedAt: createdAt,
  revision: 0
})

export const initialIdentitySession = (createdAt = Date.now()): IdentitySession => ({
  id: "identity",
  state: "unknown",
  login: null,
  accountOwnerLogin: null,
  allowlisted: false,
  admin: false,
  accessRequested: false,
  accessError: null,
  scopesPlain: null,
  updatedAt: createdAt,
  revision: 0
})

export const initialBillingAccount = (): BillingAccount => ({
  id: "billing",
  state: "unknown",
  totalUsd: null,
  allowedToStartWork: true,
  lifetimeChargedUsd: null,
  chargeCount: 0,
  refreshedAt: null,
  revision: 0
})

/*
 * Wave 14 §1: there is no seeded opening message, in either auth state.
 *
 * A generic "Hey — I'm Smithers, tell me what you're working on" rendered as
 * the OPENING message before the honest content arrived, and the opening
 * message is the one the product is judged by. Signed out, the opening (and
 * only) message IS the auth conversation state — App.tsx derives it, nothing
 * is seeded under it. Signed in, the transcript opens clean and the loaded
 * repositories arrive through the inventory seam. A filler line ahead of
 * either is invention, because it claims a conversation before there is one.
 */

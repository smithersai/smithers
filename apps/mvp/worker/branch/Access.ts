import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  type Access,
  type Mode,
  MODES,
  REPOSITORY_GRANTEE,
  SHARE_ACCESSES,
  type ShareAccess,
} from "../../src/features/branch/contract.ts"
import { type Actor, canAsk, type Role } from "../Actor.ts"
import { repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"

// Who may do what on a branch's live workspace (decision 0013 §2 and §4, docs/features/branch-workspace.md#sharing):
// its conversation, its terminals, its room. A live branch is private to its creator until they share it, Google Docs
// style: with people by name, to view or edit, or with anyone in the repository who has the link. Every route, socket
// and host of the branch workspace decides with `accessOf`, at every check, so a change of policy is a change here.
//
// The role every check decides with is the person's on the branch's own repository (decision 0079), from
// `BranchRoles`: on a repository the App is installed on (as Smithers recorded it), the role `RepoRoles` gives there,
// so a Member of the deployment's repository is only a Guest on another where GitHub says read; on any other, nothing
// done in the branch reaches GitHub, and the session's role on the deployment's repository decides, as before 0079.
//
// Seams for the features beside this one (no tables of their own):
// - Notifications (worker/Notifications.ts) route a run on a branch to the people watching it: a watcher whose
//   `branchAccess` is `none` gets nothing, and a watch is recorded only for someone who may view the branch.
// - Presence (worker/BranchRooms.ts): the room admits `view` and up, and `enforce` closes the sockets of anyone a
//   change narrowed. The agent's run on a branch shows from the runs a branch's people see, not from presence.

/** Who a share narrows to: what each role may get at most. A Member or above may edit; a Guest only view. */
const MEMBER_OR_ABOVE: ReadonlySet<Role> = new Set(["admin", "maintainer", "member"])

/** The most a person with `role` may do on any branch: `edit` for a Member or above, `view` for a Guest, else nothing. */
export const ceilingOf = (role: Role | null): ShareAccess | "none" =>
  role === null ? "none" : MEMBER_OR_ABOVE.has(role) ? "edit" : "view"

/**
 * A branch's grants as one person's check reads them: who created it (its owner, `null` for the team's branches), the
 * person's own share, and the grant to anyone in the repository with the link.
 */
export interface Grants {
  readonly createdBy: string | null
  readonly person: ShareAccess | null
  readonly repository: ShareAccess | null
}

const rank = { none: 0, view: 1, edit: 2 } as const

const lower = (left: ShareAccess | "none", right: ShareAccess | "none") => (rank[left] <= rank[right] ? left : right)

/**
 * What `actor` may do on a branch with `grants`: `owner` (its creator, a Member or above), else the best of their own
 * share and, for a Member or above, the link's, never above their role's ceiling; `none` when signed out or granted
 * nothing. A Guest opens a branch only when it is shared with them by name, and only to view.
 */
export const accessOf = (actor: Option.Option<Actor>, grants: Grants): Access | "none" => {
  if (Option.isNone(actor)) return "none"
  const ceiling = ceilingOf(actor.value.role)
  if (ceiling === "none") return "none"
  if (ceiling === "edit" && grants.createdBy === actor.value.subject.id) return "owner"
  const person = grants.person ?? "none"
  const link = ceiling === "edit" ? grants.repository ?? "none" : "none"
  return lower(rank[person] >= rank[link] ? person : link, ceiling)
}

/** Whether `access` opens the live branch: its conversation, terminals and room. */
export const canView = (access: Access | "none"): access is Access => access !== "none"

/** Whether `access` writes to the live branch: asks in its conversation and types in its terminals. */
export const canEdit = (access: Access | "none"): boolean => access === "owner" || access === "edit"

/** A branch's whole permission list, as the hosts of its sockets apply it to everyone connected (`underPolicy`). */
export interface Policy {
  readonly createdBy: string | null
  readonly grants: Readonly<Record<string, ShareAccess>>
}

export const PolicySchema = Schema.Struct({
  createdBy: Schema.NullOr(Schema.String),
  grants: Schema.Record(Schema.String, Schema.Literals(SHARE_ACCESSES)),
})

/** What `principal`, with `role`, may do under `policy`. */
export const underPolicy = (policy: Policy, principal: string, role: Role | null): Access | "none" =>
  accessOf(Option.some({ subject: { kind: "person", id: principal }, role }), {
    createdBy: policy.createdBy,
    person: Object.hasOwn(policy.grants, principal) ? policy.grants[principal]! : null,
    repository: Object.hasOwn(policy.grants, REPOSITORY_GRANTEE) ? policy.grants[REPOSITORY_GRANTEE]! : null,
  })

/**
 * How a branch's checks learn the person's role on its repository (decision 0079): `RepoRoles.workRole`, which ChatApi
 * provides for each request (`layer`). Asked only for a repository the App is installed on; GitHub or Postgres not
 * answering is the refusal, never a guessed role.
 */
export class BranchRoles extends Context.Service<
  BranchRoles,
  { readonly roleOn: (actor: Actor, repoId: string) => Effect.Effect<Role | null, RepoRoles.RoleRefused> }
>()("@smthrs/mvp/branch/BranchRoles") {
  /** `BranchRoles` over `roles`, with what its database needs taken from where the layer is built. */
  static readonly layer = <R>(roles: RepoRoles.RepoRoles<R>): Layer.Layer<BranchRoles, never, R> =>
    Layer.effect(
      BranchRoles,
      Effect.map(Effect.context<R>(), (context) =>
        BranchRoles.of({
          roleOn: (actor, repoId) =>
            RepoRoles.workRole(roles, actor, repositoryOf(repoId.replace(/^github\//, ""))).pipe(Effect.provideContext(context)),
        })),
    )
}

/**
 * The role `actor` works with on repository `repoId` (`installed`: whether Smithers recorded the App's installation on
 * it): `BranchRoles`' where the App is installed, else the session's, asking GitHub nothing.
 */
export const roleOn = (
  actor: Actor,
  repoId: string,
  installed: boolean,
): Effect.Effect<Role | null, RepoRoles.RoleRefused, BranchRoles> =>
  installed
    ? Effect.gen(function* () {
      return yield* (yield* BranchRoles).roleOn(actor, repoId)
    })
    : Effect.succeed(actor.role)

/** Whether Smithers recorded the App's installation on repository `repoId`. */
export const installedOn = (repoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`
      SELECT 1 FROM github_repositories WHERE repo_id = ${repoId} AND installation_id IS NOT NULL`
    return rows.length > 0
  })

/**
 * Whether `actor` is a Member or above on repository `repoId` (`repo:branch-create`, decision 0007): who may track a
 * branch there, and own one, by the role they work with there (`roleOn`).
 */
export const isMemberOn = (actor: Option.Option<Actor>, repoId: string) =>
  Effect.gen(function* () {
    if (Option.isNone(actor)) return false
    const role = yield* roleOn(actor.value, repoId, yield* installedOn(repoId))
    return isMember(Option.some({ ...actor.value, role }))
  })

/** A living branch as an access check reads it. */
export interface BranchAccess {
  readonly branchId: string
  readonly conversationId: string
  readonly repoId: string
  readonly name: string
  readonly mode: Mode
  readonly createdBy: string | null
  readonly access: Access | "none"
  /** The role `access` was decided with: the person's on the branch's repository (`roleOn`); none signed out. */
  readonly role: Role | null
  /**
   * Whether its owner shared it, by name or by link: its prompt is then typed together (docs/features/coedit.md). The
   * team's branches have no owner, so nobody shared them.
   */
  readonly shared: boolean
}

const Row = Schema.Struct({
  branchId: Schema.String,
  conversationId: Schema.String,
  repoId: Schema.String,
  name: Schema.String,
  mode: Schema.Literals(MODES),
  createdBy: Schema.NullOr(Schema.String),
  person: Schema.NullOr(Schema.Literals(SHARE_ACCESSES)),
  repository: Schema.NullOr(Schema.Literals(SHARE_ACCESSES)),
  anyShare: Schema.Boolean,
  installed: Schema.Boolean,
})
const decodeRow = Schema.decodeUnknownEffect(Row)

/** The person `actor` acts as, for reading their own share: nobody signed out. */
const personOf = (actor: Option.Option<Actor>) => (Option.isSome(actor) ? actor.value.subject.id : "")

/** Living branch `id`'s row as a check reads it, with `person`'s own share; `undefined` when there is no such branch. */
const readBranch = (person: string, id: string, by: "branch" | "conversation") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`
      SELECT b.id AS "branchId", c.id AS "conversationId", b.repo_id AS "repoId", b.name, b.mode,
        b.created_by AS "createdBy",
        (SELECT access FROM branch_shares s WHERE s.branch_id = b.id AND s.grantee = ${person}
          AND ${person} <> ${REPOSITORY_GRANTEE}) AS person,
        (SELECT access FROM branch_shares s WHERE s.branch_id = b.id AND s.grantee = ${REPOSITORY_GRANTEE}) AS repository,
        EXISTS (SELECT 1 FROM branch_shares s WHERE s.branch_id = b.id) AS "anyShare",
        EXISTS (SELECT 1 FROM github_repositories g WHERE g.repo_id = b.repo_id AND g.installation_id IS NOT NULL)
          AS installed
      FROM branches b JOIN conversations c ON c.branch_id = b.id
      WHERE ${by === "branch" ? sql`b.id = ${id}` : sql`c.id = ${id}`} AND b.deleted_at IS NULL`
    return rows[0] === undefined ? undefined : yield* decodeRow(rows[0]).pipe(Effect.orDie)
  })

/** What `actor`, with the role they carry, may do on branch `row`. */
const decided = (actor: Option.Option<Actor>, row: typeof Row.Type): BranchAccess => {
  const access = accessOf(actor, { createdBy: row.createdBy, person: row.person, repository: row.repository })
  const { person: _person, repository: _repository, anyShare, installed: _installed, ...branch } = row
  return {
    ...branch,
    access,
    role: Option.isSome(actor) ? actor.value.role : null,
    shared: row.createdBy !== null && anyShare,
  }
}

/**
 * Living branch `branchId` (or, with `by: "conversation"`, the branch of conversation `id`) and what `actor` may do on
 * it, by their role on the branch's repository (`roleOn`): `undefined` when there is no such branch. One query, and on
 * a repository the App is installed on the person's role there, kept 5 minutes (decision 0079).
 */
export const branchAccess = (actor: Option.Option<Actor>, id: string, by: "branch" | "conversation" = "branch") =>
  Effect.gen(function* () {
    const row = yield* readBranch(personOf(actor), id, by)
    if (row === undefined) return undefined
    if (Option.isNone(actor)) return decided(actor, row)
    const role = yield* roleOn(actor.value, row.repoId, row.installed)
    return decided(Option.some({ ...actor.value, role }), row)
  })

/**
 * `branchAccess` with the role `actor` carries, asking no one: for a feed's recipients, whom notifications check as
 * Members inside their own transaction (worker/Notifications.ts).
 */
export const branchAccessAs = (actor: Option.Option<Actor>, id: string, by: "branch" | "conversation" = "branch") =>
  Effect.map(readBranch(personOf(actor), id, by), (row) => (row === undefined ? undefined : decided(actor, row)))

/** Branch `branchId`'s whole permission list, as `underPolicy` applies it. */
export const policyOf = (branchId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [branch] = yield* sql<{ readonly createdBy: string | null }>`
      SELECT created_by AS "createdBy" FROM branches WHERE id = ${branchId}`
    const rows = yield* sql<{ readonly grantee: string; readonly access: ShareAccess }>`
      SELECT grantee, access FROM branch_shares WHERE branch_id = ${branchId}`
    return {
      createdBy: branch?.createdBy ?? null,
      grants: Object.fromEntries(rows.map((row) => [row.grantee, row.access])),
    } satisfies Policy
  })

/** Whether `actor` is a Member or above: who may track a branch, and own one (`repo:branch-create`, decision 0007). */
export const isMember = (actor: Option.Option<Actor>): actor is Option.Some<Actor> =>
  Option.isSome(actor) && canAsk(actor.value)

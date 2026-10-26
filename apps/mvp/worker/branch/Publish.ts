import { digestSync, Uuid, WebCrypto } from "@smthrs/crypto"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { GitHub } from "@smthrs/integrations"
import { Node } from "@smthrs/plan"
import { Cause, Clock, Effect, Layer, Metric, Option, type Redacted, Schema } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import {
  MAX_PUBLISH_BYTES,
  MAX_PUBLISH_FILES,
  type UpdateMethod,
  type UpdateState,
} from "../../src/features/branch/contract.ts"
import { agentAttribution, type WriteFailure } from "../../src/features/issues/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import { roleOf } from "../GitHubAuth.ts"
import type { Services as GitHubServices } from "../github/Apply.ts"
import { classify, statusOf, withToken } from "../github/Calls.ts"
import { type Repository, repositoryOf } from "../github/Config.ts"
import * as Metrics from "../github/Metrics.ts"
import { fetchPull, projectPull } from "../github/Pulls.ts"
import { permissionOf } from "../github/RepoRoles.ts"
import * as Store from "../github/Store.ts"
import type { SandboxTools } from "@smthrs/sandbox"
import { base64Of, type Change, collect } from "./Change.ts"
import type { Forge } from "./Forge.ts"
import { Machines } from "./Machines.ts"
import { resync, ResyncRefused, ResyncUnavailable } from "./Resync.ts"
import type { SandboxBranch } from "./Sandboxes.ts"

// Publish and Update branch (docs/features/branch-publish.md; rulings GH-6 and GH-11). A Smithers-only branch lives in
// Code Storage's ephemeral namespace, and its edits in its machine's working copy; nothing reaches GitHub until a person
// explicitly publishes it (Will, 2026-10-23 14:09: "generrally interacting with github is always explicit").
//
//   branch/Publish { writeId }   the writes route admitted `branch/publish` from someone who may edit the branch
//     send      the working copy's change against the branch's base, read whole from its machine as the person
//               (`Change.collect`) ─▶ with the person's own token (the App's for the agent, "Smithers for @maya"):
//               the GitHub branch `<name>-<key>` at the base, one commit, the pull request into the default branch,
//               each through `Action.once` keyed by the write ─▶ the branch's publication and the write, settled together
//     give-up   settles `failed unavailable` once send outlived its retries
//   branch/Update { writeId }    the writes route admitted `branch/update`
//     send      the published pull request's base taken into its branch: a merge commit (`POST /merges`, keyed by the
//               write's trailer), or a rebase fenced by the head it read (GraphQL `updatePullRequestBranch`) ─▶
//               `updated`, `up_to_date`, or refused `conflict`
//     give-up   as Publish's
//   after Publish and Update settle `done`: resync, the branch's Smithers branch and working copy brought to the head
//               GitHub's branch reached (worker/branch/Resync.ts); it never changes how the write settled
//   branch/Resync { writeId }    the writes route admitted `branch/resync` (GitHub's branch moved for any reason)
//     send      GitHub's head read as the person ─▶ resync ─▶ `done`, or refused `conflict` with its files listed
//     give-up   as Publish's
//
// Nothing here merges a pull request, approves, or forces a ref. Records carry ids, numbers and outcomes, never a title,
// a body, a path or a branch name.

/** GitHub, the machine or Postgres couldn't answer, or the answer was lost: retried, after `retryAfterMillis`. */
export class PublishUnavailable extends Schema.TaggedError<PublishUnavailable>()("@smthrs/mvp/branch/PublishUnavailable", {
  retryAfterMillis: Schema.optional(Schema.Number),
}) {}

/** A step's calls: 1 s doubling to a minute, for at most an hour, through a machine's wake and GitHub's outages. */
export const PUBLISH_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 60 * 60_000 })

const Request = { writeId: Schema.String.check(Schema.isUUID()) }

/** How a write ended: `done` with its pull request, or why not. */
export const Settled = Schema.Struct({
  status: Schema.Literals(["done", "refused", "failed", "missing"]),
  prNumber: Schema.NullOr(Schema.Int),
})
export type Settled = typeof Settled.Type

/** The steps' implementation versions; a run parked on another stops with `plan_changed`. */
export const PUBLISH_VERSION = "branch-publish/send/v1"
export const UPDATE_VERSION = "branch-update/send/v1"
export const RESYNC_VERSION = "branch-resync/send/v1"

/** A resync after a Publish or an Update: 1 s doubling to a minute, for at most half an hour, through the mirror's sync. */
export const RESYNC_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

/** After a Publish settled `done`: the working copy follows the GitHub branch it made or pushed. Answers the write. */
export const PublishResync = Action.make("branch/Publish/resync", {
  payload: Request,
  success: Settled,
  error: PublishUnavailable,
  tier: "irreversible",
  idempotencyKey: ({ writeId }) => ({ publishResync: writeId }),
  retryPolicy: RESYNC_RETRY,
})

/** After an Update branch settled `done`: the working copy takes in what GitHub merged or rebased. Answers the write. */
export const UpdateResync = Action.make("branch/Update/resync", {
  payload: Request,
  success: Settled,
  error: PublishUnavailable,
  tier: "irreversible",
  idempotencyKey: ({ writeId }) => ({ updateResync: writeId }),
  retryPolicy: RESYNC_RETRY,
})

export const PublishSend = Action.make("branch/Publish/send", {
  payload: Request,
  success: Settled,
  error: PublishUnavailable,
  implementationVersion: PUBLISH_VERSION,
  tier: "irreversible",
  idempotencyKey: ({ writeId }) => ({ publish: writeId }),
  retryPolicy: PUBLISH_RETRY,
})

export const PublishGiveUp = Action.make("branch/Publish/give-up", {
  payload: Request,
  success: Settled,
  error: PublishUnavailable,
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
})

/** `branch/Publish`: takes one Smithers-only branch to GitHub as a branch, one commit and a pull request. */
export const Publish = Flow.make("branch/Publish", {
  description: "Publish a Smithers-only branch to GitHub: its working copy's change as one commit on a new GitHub " +
    "branch at its base, and a pull request into the default branch, as the person who pressed Publish.",
  capabilities: [
    "db:write:github_writes",
    "db:write:branch_publications",
    "db:write:items",
    "db:write:pulls",
    "db:write:text_updates",
  ],
  modelInvocable: false,
  payload: Request,
  success: Settled,
  error: PublishUnavailable,
  body: Node.capture({ send: PublishSend.name, giveUp: PublishGiveUp.name, resync: PublishResync.name }, (request) =>
    PublishSend.call(request).pipe(
      Node.catch({ onFailure: () => PublishGiveUp.call(request) }),
      Node.andThen(PublishResync.call(request).pipe(Node.catch({ onFailure: () => PublishGiveUp.call(request) }))),
    )),
})

export const UpdateSend = Action.make("branch/Update/send", {
  payload: Request,
  success: Settled,
  error: PublishUnavailable,
  implementationVersion: UPDATE_VERSION,
  tier: "irreversible",
  idempotencyKey: ({ writeId }) => ({ update: writeId }),
  retryPolicy: PUBLISH_RETRY,
})

export const UpdateGiveUp = Action.make("branch/Update/give-up", {
  payload: Request,
  success: Settled,
  error: PublishUnavailable,
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
})

/** `branch/Update`: brings a published branch up to date with its pull request's base, on GitHub. */
export const Update = Flow.make("branch/Update", {
  description: "Bring a published branch up to date with its pull request's base on GitHub, by a merge commit or a " +
    "rebase, as the person who pressed Update branch; a conflict is reported, never resolved.",
  capabilities: [
    "db:write:github_writes",
    "db:write:branch_publications",
    "db:write:items",
    "db:write:pulls",
    "db:write:text_updates",
  ],
  modelInvocable: false,
  payload: Request,
  success: Settled,
  error: PublishUnavailable,
  body: Node.capture({ send: UpdateSend.name, giveUp: UpdateGiveUp.name, resync: UpdateResync.name }, (request) =>
    UpdateSend.call(request).pipe(
      Node.catch({ onFailure: () => UpdateGiveUp.call(request) }),
      Node.andThen(UpdateResync.call(request).pipe(Node.catch({ onFailure: () => UpdateGiveUp.call(request) }))),
    )),
})

export const ResyncSend = Action.make("branch/Resync/send", {
  payload: Request,
  success: Settled,
  error: PublishUnavailable,
  implementationVersion: RESYNC_VERSION,
  tier: "irreversible",
  idempotencyKey: ({ writeId }) => ({ resync: writeId }),
  retryPolicy: PUBLISH_RETRY,
})

export const ResyncGiveUp = Action.make("branch/Resync/give-up", {
  payload: Request,
  success: Settled,
  error: PublishUnavailable,
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
})

/** `branch/Resync`: brings a published branch's Smithers branch and working copy to its GitHub branch's head. */
export const Resync = Flow.make("branch/Resync", {
  description: "Bring a published branch's Smithers branch and working copy to the head its GitHub branch reached, " +
    "keeping the working copy's own changes; a conflict is reported with its files, never resolved.",
  capabilities: ["db:write:github_writes", "db:write:branch_publications", "db:write:text_updates"],
  modelInvocable: false,
  payload: Request,
  success: Settled,
  error: PublishUnavailable,
  body: Node.capture({ send: ResyncSend.name, giveUp: ResyncGiveUp.name }, (request) =>
    ResyncSend.call(request).pipe(Node.catch({ onFailure: () => ResyncGiveUp.call(request) }))),
})

/** Publishes, by `outcome`: `done`, or the failure. */
export const publishes = Metric.counter("smithers_branch_publishes", {
  description: "Publish writes settled, by outcome",
  incremental: true,
})

/** Updates, by `outcome` (`updated`, `up_to_date`, or the failure) and `method`. */
export const updates = Metric.counter("smithers_branch_updates", {
  description: "Update branch writes settled, by outcome and method",
  incremental: true,
})

/**
 * The key write `name` of write `writeId` carries on GitHub: SHA-256 of both, so every attempt and run of the write
 * derives the same one and no other write does. The route recorded the write id before the flow started.
 */
export const keyOf = (writeId: string, name: "branch" | "commit" | "pull" | "update"): string =>
  digestSync(`smithers/branch-publish/v1\n${name}\n${writeId}`)

/** The namespace a Publish step's machine call ids are version 5 UUIDs of `<write id>:<name>` in. */
export const CALL_NAMESPACE = "9d3f6a1e-4b2c-4e7a-8f05-6c1b2d3e4f71"

/**
 * The most characters of a Smithers branch's name its GitHub branch keeps before `-<key>`, so the name stays within
 * GitHub's 200 (`GitHub.Refs.MAX_BRANCH_LENGTH`).
 */
export const PREFIX_LENGTH = 180

/** The GitHub branch name's fixed part: the Smithers branch's name, then a dash. Its key follows. */
export const prefixOf = (name: string): string => `${name.slice(0, PREFIX_LENGTH)}-`

/**
 * What GitHub holds of the pushes after `change` lands on `pushed`: each added file's contents' SHA-256 (of their base64),
 * null for each deletion; each `restored` path is the base's again, no longer the pushes'.
 */
export const pushedOf = (
  pushed: Readonly<Record<string, string | null>>,
  change: Change,
  restored: ReadonlyArray<string> = [],
): Record<string, string | null> => {
  const next: Record<string, string | null> = { ...pushed }
  for (const addition of change.additions) next[addition.path] = digestSync(addition.contents)
  for (const deletion of change.deletions) next[deletion] = null
  for (const path of restored) delete next[path]
  return next
}

/** Every path a comparison's files touch: each file's, and a renamed file's old one too. */
export const changedPaths = (files: ReadonlyArray<{ readonly filename: string; readonly previous_filename?: string }>) =>
  new Set(files.flatMap((file) => file.previous_filename === undefined ? [file.filename] : [file.filename, file.previous_filename]))

/** A living branch as Publish reads it. */
export interface BranchRow {
  readonly branchId: string
  readonly repoId: string
  readonly name: string
  readonly baseSha: string | null
  readonly namespace: "default" | "ephemeral"
  readonly forge: "deployment" | "github"
}

/** Living branch `branchId`, or `undefined`. */
export const branchOf = (branchId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<BranchRow>`
      SELECT id::text AS "branchId", repo_id AS "repoId", name, base_sha AS "baseSha", ref_namespace AS namespace,
        ref_forge AS forge
      FROM branches WHERE id = ${branchId}::uuid AND deleted_at IS NULL`
    return row
  })

/** A branch's publication on GitHub. */
export interface Publication {
  readonly branchId: string
  readonly repoId: string
  readonly githubRef: string
  readonly baseRef: string
  readonly baseSha: string
  readonly headSha: string
  readonly prNumber: number
  readonly writeId: string
  readonly updateState: UpdateState | null
  /** What the pushes wrote, by path: the contents' SHA-256 (of their base64), or null for a deletion. */
  readonly pushed: Readonly<Record<string, string | null>>
  /** The head the last push made. */
  readonly pushedSha: string
  /** The push on its way, and the head it commits onto, recorded before it writes. */
  readonly pushingWrite: string | null
  readonly pushingFrom: string | null
  /** The GitHub commit the working copy was last brought to (worker/branch/Resync.ts); null until a resync. */
  readonly syncedSha: string | null
  /** How the last resync ended, and the files a conflict listed. */
  readonly syncState: "synced" | "conflict" | null
  readonly syncConflicts: ReadonlyArray<string> | null
  /** The texts a resync on its way brings along, by path: their contents' SHA-256 before it, recorded before it applies. */
  readonly syncing: Readonly<Record<string, string>> | null
}

/** Branch `branchId`'s publication, or `undefined` before it is published. */
export const publicationOf = (branchId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<Publication>`
      SELECT branch_id::text AS "branchId", repo_id AS "repoId", github_ref AS "githubRef", base_ref AS "baseRef",
        base_sha AS "baseSha", head_sha AS "headSha", pr_number AS "prNumber", write_id::text AS "writeId",
        update_state AS "updateState", pushed, pushed_sha AS "pushedSha", pushing_write::text AS "pushingWrite",
        pushing_from AS "pushingFrom", synced_sha AS "syncedSha", sync_state AS "syncState",
        sync_conflicts AS "syncConflicts", syncing
      FROM branch_publications WHERE branch_id = ${branchId}::uuid`
    return row
  })

/**
 * Whether branch `branchId` may take Publish or Resync `writeId` now: `pending` while another Publish or Resync of it is
 * on its way, since both move what the working copy is measured from. A write's own id is never its own obstacle, so a
 * resend answers as it stands.
 */
export const publishBlocked = (branchId: string, writeId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const pending = yield* sql`
      SELECT id FROM github_writes WHERE op IN ('branch/publish', 'branch/resync') AND status = 'pending'
        AND branch_id = ${branchId}::uuid AND id <> ${writeId}::uuid LIMIT 1`
    return pending.length > 0 ? "pending" as const : undefined
  })

/** A refusal decided before or instead of GitHub's answer. */
class Refused extends Schema.TaggedError<Refused>()("@smthrs/mvp/branch/PublishRefused", {
  failure: Schema.Literals([
    "sign_in_required",
    "not_allowed",
    "not_found",
    "invalid",
    "app_not_installed",
    "empty_change",
    "too_large",
    "not_published",
    "base_missing",
    "conflict",
    "merged",
    "closed",
    "head_moved",
    "not_mergeable",
  ]),
}) {}

/** A write's log and span name: `branch.publish`, `branch.update` or `branch.resync`. */
const labelOf = (op: string): string =>
  op === "branch/update" ? "branch.update" : op === "branch/resync" ? "branch.resync" : "branch.publish"

/** What GitHub's refusal of a Publish or an Update means. */
export const refusalOf = (status: number): WriteFailure =>
  status === 401
    ? "sign_in_required"
    : status === 404
    ? "not_found"
    : status === 409
    ? "head_moved"
    : status === 422
    ? "invalid"
    : "not_allowed"

/** The steps over GitHub's `services` and the host's `Machines`. */
export const steps = <E, R>(services: GitHubServices<E, R>) => {
  const settled = (
    write: Store.Write,
    settlement: Store.Settlement,
    project: Effect.Effect<unknown, never, SqlClient.SqlClient> = Effect.void,
    method?: UpdateMethod,
    state?: UpdateState,
  ) =>
    Effect.gen(function* () {
      const now = yield* Store.settleWrite(write.id, settlement, project)
      const outcome = settlement.status === "done" ? state ?? "done" : settlement.failure
      const op = write.payload.op
      if (now) {
        // A resync counts its own outcomes (`smithers_branch_resyncs`).
        if (op !== "branch/resync") {
          yield* Metric.update(
            op === "branch/update"
              ? Metric.withAttributes(updates, { outcome, method: method! })
              : Metric.withAttributes(publishes, { outcome }),
            1,
          )
        }
        yield* Metric.update(Metric.withAttributes(Metrics.writeMs, { op: write.op }), (yield* Clock.currentTimeMillis) - write.createdAt)
      }
      yield* Effect.logWithLevel(settlement.status === "done" ? "Info" : "Warn")(labelOf(write.op)).pipe(
        Effect.annotateLogs({ writeId: write.id, outcome, settled: now, ...(method === undefined ? {} : { method }) }),
      )
      return {
        status: settlement.status,
        prNumber: settlement.status === "done" ? settlement.itemNumber : null,
      } satisfies Settled
    })

  /** The token the write acts with: the person's own for their press, the App's for the agent's. */
  const tokenOf = (write: Store.Write, repository: Repository) =>
    Effect.gen(function* () {
      if (write.via === "agent") {
        return yield* services.tokens.forInstallation(repository, "publish").pipe(Effect.mapError((failure) =>
          failure.reason === "app_not_installed" || failure.reason === "not_allowed" || failure.reason === "sign_in_required"
            ? new Refused({ failure: failure.reason })
            : new PublishUnavailable(failure.retryAfterMillis === undefined ? {} : { retryAfterMillis: failure.retryAfterMillis })
        ))
      }
      // The route admits a person's write only from their session, and Postgres holds every person's write to one.
      return yield* services.tokens.forSession(write.sessionId!).pipe(Effect.mapError((failure) =>
        failure.reason === "refreshing" || failure.reason === "unavailable"
          ? new PublishUnavailable(failure.retryAfterMillis === undefined ? {} : { retryAfterMillis: failure.retryAfterMillis })
          : new Refused({ failure: "sign_in_required" })
      ))
    })

  /**
   * The agent writes as the App, so GitHub checks nothing of the person: before writing, each attempt checks again that
   * they still write to the repository, by the account sign-in knows (decisions 0007 §6 and 0079), as `github/Write`
   * does. A person's own write goes with their own token, which GitHub checks.
   */
  const actsForWriter = (write: Store.Write, repository: Repository) =>
    Effect.gen(function* () {
      if (write.via !== "agent") return
      const permission = write.login === null
        ? Option.none()
        : yield* GitHub.Collaborators.permission(repository.owner, repository.name, write.login)
      const role = Option.isSome(permission) && permission.value.userId === write.accountId
        ? roleOf(permissionOf(permission.value))
        : null
      if (role !== "admin" && role !== "maintainer" && role !== "member") return yield* new Refused({ failure: "not_allowed" })
    })

  /** A step's failure as the write reads it: refused for good, or tried again. */
  const failureOf = (error: unknown): Refused | PublishUnavailable => {
    if (error instanceof Refused || error instanceof PublishUnavailable) return error
    const classified = classify(error)
    if (classified.kind === "refused") return new Refused({ failure: refusalOf(classified.status) as Refused["failure"] })
    return new PublishUnavailable(
      classified.kind === "retry" && classified.retryAfterMillis !== undefined ? { retryAfterMillis: classified.retryAfterMillis } : {},
    )
  }

  /**
   * Pull request `number` read back with the App's token and projected, in a savepoint: a projection that fails is
   * logged and left to the next read, never undoing the write's settlement.
   */
  const projected = (writeId: string, repository: Repository, number: number) =>
    Effect.gen(function* () {
      const read = yield* services.tokens.forInstallation(repository, "pulls").pipe(Effect.option)
      const fetched = Option.isSome(read)
        ? yield* fetchPull(repository, number).pipe(withToken(read.value, services.apiBaseUrl), Effect.option)
        : Option.none()
      const project: Effect.Effect<void, unknown, SqlClient.SqlClient> = Option.isSome(fetched)
        ? Effect.asVoid(projectPull(repository, number, fetched.value))
        : Effect.void
      return project.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Metric.update(Metric.withAttributes(Metrics.projectionFailures, { op: "branch/publish" }), 1)
            yield* Effect.logWarning("branch.publish").pipe(
              Effect.annotateLogs({ writeId, projection: "failed", errorCode: codeOf(Cause.squash(cause)) }),
            )
          })
        ),
      )
    })

  /** A step's end: the settlement it reached, or the retry it asks for. */
  const ended = <A>(write: Store.Write, method?: UpdateMethod) => (error: unknown) =>
    Effect.gen(function* () {
      const failure = failureOf(error)
      if (failure instanceof Refused) return yield* settled(write, { status: "refused", failure: failure.failure }, Effect.void, method)
      if (classify(error).kind === "unknown") {
        yield* Metric.update(Metric.withAttributes(Metrics.writeUnknown, { op: write.op }), 1)
      }
      yield* Effect.logWarning(labelOf(write.op)).pipe(
        Effect.annotateLogs({ writeId: write.id, outcome: "retry", errorCode: codeOf(error) }),
      )
      return yield* Effect.fail(failure) as Effect.Effect<A, PublishUnavailable>
    })

  /**
   * Publish again: only what changed since the last push, as one more commit onto the GitHub branch's head. A file the
   * working copy no longer changes is put back as the base has it. A file GitHub changed since the last push (an Update
   * branch, a commit on github.com) that this push also changes is refused `conflict`, never overwritten. The head the
   * push commits onto is recorded before it writes, so a step that runs again fences on it and finds its commit.
   */
  const again = (input: {
    readonly write: Store.Write
    readonly title: string
    readonly existing: Publication
    readonly machine: SandboxBranch
    readonly callId: (name: string) => Effect.Effect<string>
    readonly change: Change
    readonly token: Redacted.Redacted<string>
    readonly repository: Repository
    readonly attribution: string | undefined
  }) =>
    Effect.gen(function* () {
      const { write, existing, change, repository } = input
      const now = pushedOf({}, change)
      const additions = change.additions.filter((addition) => existing.pushed[addition.path] !== now[addition.path])
      const deletions = change.deletions.filter((path) => existing.pushed[path] !== null)
      const restored = Object.keys(existing.pushed).filter((path) => !(path in now))
      const machines = yield* Machines
      const restoring: { additions: Array<Change["additions"][number]>; deletions: Array<string> } = { additions: [], deletions: [] }
      for (const path of restored) {
        const read = yield* Effect.flatMap(input.callId(`restore:${path}`), (callId) =>
          machines.tool(input.machine, write.actorId, callId, { tool: "read", path })).pipe(Effect.result)
        if (read._tag === "Success") {
          const file = read.success.result as typeof SandboxTools.ReadResult.Type
          if (file.truncated) return yield* new Refused({ failure: "too_large" })
          restoring.additions.push({ path, contents: base64Of(file.content) })
        } else if (read.failure._tag === "@smthrs/sandbox/SandboxTools/ToolRefused" && read.failure.reason === "not_found") {
          restoring.deletions.push(path)
        } else if (read.failure._tag === "@smthrs/sandbox/SandboxTools/ToolRefused" || read.failure._tag === "@smthrs/mvp/branch/CheckoutFailed") {
          return yield* new Refused({ failure: "invalid" })
        } else {
          return yield* new PublishUnavailable({})
        }
      }
      const delta = { additions: [...additions, ...restoring.additions], deletions: [...deletions, ...restoring.deletions] }
      if (delta.additions.length + delta.deletions.length === 0) return yield* new Refused({ failure: "empty_change" })
      const sql = yield* SqlClient.SqlClient
      const { owner, name } = repository
      const headSha = yield* Effect.gen(function* () {
        yield* actsForWriter(write, repository)
        const pull = yield* GitHub.Pulls.getPull(owner, name, existing.prNumber)
        if (pull.merged) return yield* new Refused({ failure: "merged" })
        if (pull.state === "closed") return yield* new Refused({ failure: "closed" })
        let from = existing.pushingWrite === write.id ? existing.pushingFrom : null
        if (from === null) {
          const head = yield* GitHub.Refs.getBranch(owner, name, existing.githubRef)
          if (Option.isNone(head)) return yield* new Refused({ failure: "not_found" })
          if (head.value.sha !== existing.pushedSha) {
            const since = yield* GitHub.Commits.compare(owner, name, existing.pushedSha, head.value.sha)
            const changed = changedPaths(since.files)
            const touched = [...delta.additions.map((addition) => addition.path), ...delta.deletions]
            if (since.truncated || touched.some((path) => changed.has(path))) return yield* new Refused({ failure: "conflict" })
          }
          from = head.value.sha
          yield* sql`
            UPDATE branch_publications SET pushing_write = ${write.id}::uuid, pushing_from = ${from}
            WHERE branch_id = ${existing.branchId}::uuid`
        }
        return yield* Action.once(
          "commit",
          GitHub.Once.commitOnBranch(owner, name, {
            branch: existing.githubRef,
            expectedHeadOid: from,
            headline: input.title,
            body: input.attribution,
            additions: delta.additions,
            deletions: delta.deletions,
          }),
          { key: keyOf(write.id, "commit") },
        )
      }).pipe(withToken(input.token, services.apiBaseUrl))
      const next = pushedOf(existing.pushed, { additions, deletions }, restored)
      const projection = yield* projected(write.id, repository, existing.prNumber)
      return yield* settled(
        write,
        { status: "done", itemNumber: existing.prNumber, githubId: null },
        Effect.gen(function* () {
          yield* sql`
            UPDATE branch_publications SET head_sha = ${headSha}, pushed_sha = ${headSha}, pushed = ${JSON.stringify(next)}::jsonb,
              pushing_write = NULL, pushing_from = NULL, updated_at = now()
            WHERE branch_id = ${existing.branchId}::uuid`
          yield* sql.withTransaction(projection)
        }).pipe(Effect.orDie),
      )
    })

  const publish = ({ writeId }: typeof PublishSend.payloadSchema.Type) =>
    Effect.gen(function* () {
      const found = yield* Store.writeOf(writeId)
      if (Option.isNone(found) || found.value.payload.op !== "branch/publish") {
        return { status: "missing", prNumber: null } satisfies Settled
      }
      const write = found.value
      const payload = found.value.payload
      if (write.status !== "pending") return { status: write.status, prNumber: write.itemNumber } satisfies Settled
      return yield* Effect.gen(function* () {
        const repository = repositoryOf(write.repoId.replace(/^github\//, ""))
        const branch = yield* branchOf(payload.branchId)
        if (branch === undefined || branch.repoId !== write.repoId) return yield* new Refused({ failure: "not_found" })
        // Published by this write in a run that stopped before settling: settle it.
        const existing = yield* publicationOf(branch.branchId)
        if (existing !== undefined && existing.writeId === write.id) {
          return yield* settled(write, { status: "done", itemNumber: existing.prNumber, githubId: null })
        }
        // Only a Smithers-only branch publishes: one GitHub has already needs no Publish.
        if (branch.namespace !== "ephemeral" || branch.forge === "github" || branch.baseSha === null) {
          return yield* new Refused({ failure: "invalid" })
        }
        const baseSha = branch.baseSha
        const token = yield* tokenOf(write, repository)
        const machine: SandboxBranch = {
          branchId: branch.branchId,
          owner: repository.owner,
          name: repository.name,
          branch: branch.name,
          namespace: "ephemeral",
        }
        const callId = (name: string) =>
          Uuid.v5(CALL_NAMESPACE, `${write.id}:${name}`).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
        // Publishing again, a working copy back at its base still has something to push: the files it reverted. Once a
        // resync brought the working copy to GitHub's head, the change is measured from that head.
        const change = yield* collect({
          branch: machine,
          ownerId: write.actorId,
          base: existing?.syncedSha ?? baseSha,
          maxFiles: MAX_PUBLISH_FILES,
          maxBytes: MAX_PUBLISH_BYTES,
          callId,
        }).pipe(
          Effect.catchTags({
            "@smthrs/mvp/branch/ChangeRefused": (refused) =>
              refused.reason === "empty" && existing !== undefined
                ? Effect.succeed<Change>({ additions: [], deletions: [] })
                : Effect.fail(new Refused({ failure: refused.reason === "empty" ? "empty_change" : refused.reason === "too_large" ? "too_large" : "invalid" })),
            "@smthrs/mvp/branch/ChangeUnavailable": () => Effect.fail(new PublishUnavailable({})),
          }),
        )
        // Counted for the write's record; `Action.once` decides what was made, by the keys alone.
        yield* Store.beginAttempt(write.id)
        // Store.writeOf reads the person's login with the write; `actsForWriter` refuses an agent's write without one.
        const attribution = write.via === "agent" ? agentAttribution(write.login!) : undefined
        const sql = yield* SqlClient.SqlClient
        if (existing !== undefined) {
          return yield* again({ write, title: payload.title, existing, machine, callId, change, token, repository, attribution })
        }
        const made = yield* Effect.gen(function* () {
          yield* actsForWriter(write, repository)
          const client = yield* GitHub.GitHubClient.GitHubClient
          const facts = yield* client.request(
            "GET",
            `/repos/${GitHub.Repository.repositoryPath(repository.owner, repository.name)}`,
            undefined,
            { schema: Schema.Struct({ default_branch: Schema.String }) },
          )
          // The base must be a commit GitHub has: a mirror behind GitHub, or a base GitHub dropped, can't publish. Comparing
          // the base with itself reads nothing else, and GitHub answers 404 for a commit it doesn't have.
          const base = yield* GitHub.Commits.compare(repository.owner, repository.name, baseSha, baseSha).pipe(Effect.result)
          if (base._tag === "Failure") {
            const status = statusOf(base.failure)
            if (status === 404 || status === 422) return yield* new Refused({ failure: "base_missing" })
            return yield* Effect.fail(base.failure)
          }
          const ref = yield* Action.once(
            "branch",
            GitHub.Once.branch(repository.owner, repository.name, { prefix: prefixOf(branch.name), label: "", at: Effect.succeed(baseSha) }),
            { key: keyOf(write.id, "branch") },
          )
          const headSha = yield* Action.once(
            "commit",
            GitHub.Once.commitOnBranch(repository.owner, repository.name, {
              branch: ref.name,
              expectedHeadOid: baseSha,
              headline: payload.title,
              body: attribution,
              additions: change.additions,
              deletions: change.deletions,
            }),
            { key: keyOf(write.id, "commit") },
          )
          const pull = yield* Action.once(
            "pull",
            GitHub.Once.pull(repository.owner, repository.name, {
              head: ref.name,
              base: facts.default_branch,
              title: payload.title,
              body: attribution === undefined ? payload.body : [payload.body, attribution].filter((part) => part !== "").join("\n\n"),
            }),
            { key: keyOf(write.id, "pull") },
          )
          return { ref: ref.name, defaultBranch: facts.default_branch, headSha, number: pull.number }
        }).pipe(withToken(token, services.apiBaseUrl))
        const projection = yield* projected(write.id, repository, made.number)
        return yield* settled(
          write,
          { status: "done", itemNumber: made.number, githubId: null },
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO branch_publications (branch_id, repo_id, github_ref, base_ref, base_sha, head_sha, pr_number, write_id,
                pushed, pushed_sha)
              VALUES (${branch.branchId}::uuid, ${write.repoId}, ${made.ref}, ${made.defaultBranch}, ${baseSha}, ${made.headSha},
                ${made.number}, ${write.id}::uuid, ${JSON.stringify(pushedOf({}, change))}::jsonb, ${made.headSha})
              ON CONFLICT (branch_id) DO NOTHING`
            yield* sql.withTransaction(projection)
          }).pipe(Effect.orDie),
        )
      }).pipe(Effect.catch(ended<Settled>(write)))
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, services.http),
      Effect.provide(services.database),
      Effect.catch((error) =>
        error instanceof PublishUnavailable
          ? Effect.fail(error)
          : Effect.logWarning("branch.publish").pipe(
            Effect.annotateLogs({ writeId, outcome: "failed", errorCode: codeOf(error) }),
            Effect.andThen(Effect.fail(new PublishUnavailable({}))),
          )
      ),
      Effect.withSpan("branch.publish", { attributes: { "smithers.github.write": writeId } }),
    )

  const update = ({ writeId }: typeof UpdateSend.payloadSchema.Type) =>
    Effect.gen(function* () {
      const found = yield* Store.writeOf(writeId)
      if (Option.isNone(found) || found.value.payload.op !== "branch/update") {
        return { status: "missing", prNumber: null } satisfies Settled
      }
      const write = found.value
      const payload = found.value.payload
      if (write.status !== "pending") return { status: write.status, prNumber: write.itemNumber } satisfies Settled
      const method = payload.method
      const sql = yield* SqlClient.SqlClient
      return yield* Effect.gen(function* () {
        const repository = repositoryOf(write.repoId.replace(/^github\//, ""))
        const publication = yield* publicationOf(payload.branchId)
        if (publication === undefined || publication.repoId !== write.repoId) return yield* new Refused({ failure: "not_published" })
        const token = yield* tokenOf(write, repository)
        yield* Store.beginAttempt(write.id)
        const outcome = yield* Effect.gen(function* () {
          yield* actsForWriter(write, repository)
          const pull = yield* GitHub.Pulls.getPull(repository.owner, repository.name, publication.prNumber)
          if (pull.merged) return yield* new Refused({ failure: "merged" })
          if (pull.state === "closed") return yield* new Refused({ failure: "closed" })
          if (method === "merge") {
            // A merge commit carries the write's key, so a lost answer is found by it, never by a head that looks alike.
            const merged = yield* Action.once(
              "update",
              GitHub.Once.mergeInto(repository.owner, repository.name, {
                base: pull.head.ref,
                head: pull.base.ref,
                commitMessage: `Merge ${pull.base.ref} into ${pull.head.ref}`,
              }),
              { key: keyOf(write.id, "update") },
            ).pipe(Effect.catchIf(
              (error) => statusOf(error) === 409,
              () => Effect.fail(new Refused({ failure: "conflict" })),
            ))
            return merged.kind === "merged"
              ? { state: "updated" as const, headSha: merged.sha }
              : { state: "up_to_date" as const, headSha: pull.head.sha }
          }
          // A rebase rewrites the branch and writes no marker: GitHub fences it by the head read (`expectedHeadOid`).
          // A head that already holds the base is up to date; a lost answer reads the head again and finds it so.
          const baseHead = yield* GitHub.Refs.getBranch(repository.owner, repository.name, pull.base.ref)
          if (Option.isNone(baseHead)) return yield* new Refused({ failure: "not_found" })
          const behind = (head: string) =>
            Effect.map(GitHub.Commits.compare(repository.owner, repository.name, baseHead.value.sha, head), (compared) => compared.behindBy)
          if ((yield* behind(pull.head.sha)) === 0) return { state: "up_to_date" as const, headSha: pull.head.sha }
          const rebased = yield* Action.once(
            "update",
            Action.keyed({
              find: () =>
                Effect.gen(function* () {
                  const now = yield* GitHub.Pulls.getPull(repository.owner, repository.name, publication.prNumber)
                  return now.head.sha !== pull.head.sha && (yield* behind(now.head.sha)) === 0
                    ? Option.some({ headSha: now.head.sha })
                    : Option.none()
                }),
              perform: () =>
                GitHub.Pulls.updateBranch(repository.owner, repository.name, {
                  pullNodeId: pull.node_id,
                  expectedHeadOid: pull.head.sha,
                  method: "rebase",
                }),
            }),
            { key: keyOf(write.id, "update") },
          ).pipe(Effect.catchIf(
            (error) => classify(error).kind === "refused",
            () =>
              Effect.gen(function* () {
                const now = yield* GitHub.Pulls.getPull(repository.owner, repository.name, publication.prNumber)
                return yield* new Refused({
                  failure: now.head.sha !== pull.head.sha ? "head_moved" : now.mergeable_state === "dirty" ? "conflict" : "not_mergeable",
                })
              }),
          ))
          return { state: "updated" as const, headSha: rebased.headSha }
        }).pipe(withToken(token, services.apiBaseUrl))
        const projection = yield* projected(write.id, repository, publication.prNumber)
        return yield* settled(
          write,
          { status: "done", itemNumber: publication.prNumber, githubId: null },
          Effect.gen(function* () {
            yield* sql`
              UPDATE branch_publications SET head_sha = ${outcome.headSha}, update_state = ${outcome.state}, updated_at = now()
              WHERE branch_id = ${publication.branchId}::uuid`
            yield* sql.withTransaction(projection)
          }).pipe(Effect.orDie),
          method,
          outcome.state,
        )
      }).pipe(
        Effect.catch((error) =>
          error instanceof Refused && error.failure === "conflict"
            // The conflict shows on the branch for everyone, with the write that found it.
            ? sql.withTransaction(Effect.gen(function* () {
              const answer = yield* settled(write, { status: "refused", failure: "conflict" }, Effect.void, method)
              yield* sql`
                UPDATE branch_publications SET update_state = 'conflict', updated_at = now()
                WHERE branch_id = ${payload.branchId}::uuid`
              return answer
            }))
            : ended<Settled>(write, method)(error)
        ),
      )
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, services.http),
      Effect.provide(services.database),
      Effect.catch((error) =>
        error instanceof PublishUnavailable
          ? Effect.fail(error)
          : Effect.logWarning("branch.update").pipe(
            Effect.annotateLogs({ writeId, outcome: "failed", errorCode: codeOf(error) }),
            Effect.andThen(Effect.fail(new PublishUnavailable({}))),
          )
      ),
      Effect.withSpan("branch.update", { attributes: { "smithers.github.write": writeId } }),
    )

  /** A resync's failure as a step's: a refusal settles, an outage is tried again. */
  const resyncFailure = (error: ResyncRefused | ResyncUnavailable): Refused | PublishUnavailable =>
    error._tag === "@smthrs/mvp/branch/ResyncRefused"
      ? new Refused({ failure: error.failure })
      : new PublishUnavailable(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis })

  /**
   * `branch/Resync`: GitHub's branch moved (a push, a commit on github.com, an Update another device ran), and the
   * person asks the working copy to follow. GitHub's head is read as them (as the App for the agent); a conflict
   * settles `refused conflict` and lists its files on the publication.
   */
  const resyncSend = ({ writeId }: typeof ResyncSend.payloadSchema.Type) =>
    Effect.gen(function* () {
      const found = yield* Store.writeOf(writeId)
      if (Option.isNone(found) || found.value.payload.op !== "branch/resync") {
        return { status: "missing", prNumber: null } satisfies Settled
      }
      const write = found.value
      const payload = found.value.payload
      if (write.status !== "pending") return { status: write.status, prNumber: write.itemNumber } satisfies Settled
      return yield* Effect.gen(function* () {
        const repository = repositoryOf(write.repoId.replace(/^github\//, ""))
        const branch = yield* branchOf(payload.branchId)
        const publication = yield* publicationOf(payload.branchId)
        if (branch === undefined || publication === undefined || publication.repoId !== write.repoId) {
          return yield* new Refused({ failure: "not_published" })
        }
        const token = yield* tokenOf(write, repository)
        yield* Store.beginAttempt(write.id)
        const head = yield* GitHub.Refs.getBranch(repository.owner, repository.name, publication.githubRef).pipe(
          withToken(token, services.apiBaseUrl),
        )
        if (Option.isNone(head)) return yield* new Refused({ failure: "not_found" })
        const resynced = yield* resync({
          branch,
          publication,
          repository,
          onto: head.value.sha,
          actorId: write.actorId,
          key: write.id,
        }).pipe(Effect.mapError(resyncFailure))
        if (resynced.state === "conflict") return yield* new Refused({ failure: "conflict" })
        return yield* settled(write, { status: "done", itemNumber: publication.prNumber, githubId: null })
      }).pipe(Effect.catch(ended<Settled>(write)))
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, services.http),
      Effect.provide(services.database),
      Effect.catch((error) =>
        error instanceof PublishUnavailable
          ? Effect.fail(error)
          : Effect.logWarning("branch.resync").pipe(
            Effect.annotateLogs({ writeId, outcome: "failed", errorCode: codeOf(error) }),
            Effect.andThen(Effect.fail(new PublishUnavailable({}))),
          )
      ),
      Effect.withSpan("branch.resync.send", { attributes: { "smithers.github.write": writeId } }),
    )

  /**
   * After a Publish or an Update settled `done`: the working copy follows the head GitHub's branch reached, as
   * `branch/Resync` does, with the head the write recorded. It answers how the write settled whatever the resync
   * found: a conflict is on the publication, and a refusal is logged. An outage is tried again.
   */
  const afterSettled = ({ writeId }: { readonly writeId: string }) =>
    Effect.gen(function* () {
      const found = yield* Store.writeOf(writeId)
      if (Option.isNone(found)) return { status: "missing", prNumber: null } satisfies Settled
      const write = found.value
      // Its send settles it or fails, and a failed send's give-up settles it: one still pending is tried again.
      if (write.status === "pending") return yield* new PublishUnavailable({})
      const answer = { status: write.status, prNumber: write.itemNumber } satisfies Settled
      const payload = write.payload
      if (write.status !== "done" || (payload.op !== "branch/publish" && payload.op !== "branch/update")) return answer
      const branch = yield* branchOf(payload.branchId)
      const publication = yield* publicationOf(payload.branchId)
      if (branch === undefined || publication === undefined) return answer
      // Followed already: an Update that found the branch up to date with its working copy there.
      if (publication.syncedSha === publication.headSha && publication.syncState === "synced") return answer
      yield* resync({
        branch,
        publication,
        repository: repositoryOf(write.repoId.replace(/^github\//, "")),
        onto: publication.headSha,
        actorId: write.actorId,
        key: write.id,
      }).pipe(
        Effect.catchTag("@smthrs/mvp/branch/ResyncRefused", () => Effect.void),
        Effect.mapError((error) => resyncFailure(error) as PublishUnavailable),
      )
      return answer
    }).pipe(
      Effect.provide(services.database),
      Effect.catch((error) =>
        error instanceof PublishUnavailable
          ? Effect.fail(error)
          : Effect.logWarning("branch.resync").pipe(
            Effect.annotateLogs({ writeId, outcome: "failed", errorCode: codeOf(error) }),
            Effect.andThen(Effect.fail(new PublishUnavailable({}))),
          )
      ),
      Effect.withSpan("branch.resync.after", { attributes: { "smithers.github.write": writeId } }),
    )

  /** Settles a write still pending once its send gave up: `failed unavailable`. One another run settled answers that. */
  const giveUp = ({ writeId }: { readonly writeId: string }) =>
    Effect.gen(function* () {
      const found = yield* Store.writeOf(writeId)
      if (Option.isNone(found)) return { status: "missing", prNumber: null } satisfies Settled
      if (found.value.status !== "pending") return { status: found.value.status, prNumber: found.value.itemNumber } satisfies Settled
      const method = found.value.payload.op === "branch/update" ? found.value.payload.method : undefined
      return yield* settled(found.value, { status: "failed", failure: "unavailable" }, Effect.void, method)
    }).pipe(
      Effect.provide(services.database),
      Effect.mapError(() => new PublishUnavailable({})),
      Effect.withSpan("branch.publish.give_up", { attributes: { "smithers.github.write": writeId } }),
    )

  return { publish, update, resync: resyncSend, afterSettled, giveUp }
}

/**
 * Registers `branch/Publish`, `branch/Update` and `branch/Resync` with their steps over `services`, the branches'
 * `machines` and the deployment's `forge`.
 */
export const registration = <E, R, ME, MR, FE, FR>(
  services: GitHubServices<E, R>,
  machines: Layer.Layer<Machines, ME, MR>,
  forge: Layer.Layer<Forge, FE, FR>,
) => {
  const implementation = steps(services)
  return Layer.mergeAll(
    Interpreter.layerWithImplementations(
      Publish,
      Layer.mergeAll(
        PublishSend.toLayer(implementation.publish, { implementationVersion: PUBLISH_VERSION }),
        PublishGiveUp.toLayer(implementation.giveUp),
        PublishResync.toLayer(implementation.afterSettled),
      ),
    ),
    Interpreter.layerWithImplementations(
      Update,
      Layer.mergeAll(
        UpdateSend.toLayer(implementation.update, { implementationVersion: UPDATE_VERSION }),
        UpdateGiveUp.toLayer(implementation.giveUp),
        UpdateResync.toLayer(implementation.afterSettled),
      ),
    ),
    Interpreter.layerWithImplementations(
      Resync,
      Layer.merge(
        ResyncSend.toLayer(implementation.resync, { implementationVersion: RESYNC_VERSION }),
        ResyncGiveUp.toLayer(implementation.giveUp),
      ),
    ),
  ).pipe(Layer.provide(machines), Layer.provide(forge), Layer.provideMerge(Action.layerImplementations))
}

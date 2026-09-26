/**
 * The organization's durable steps.
 *
 * Declarations a flow calls, and one layer implementing all of them except
 * {@link RoleTask}, whose implementation ships with its declaration as an
 * `AgentAction` and is installed under `Authority.layer`:
 *
 * - {@link PinRoster} records which roster snapshot a run uses.
 * - {@link ComposeTask} resolves a principal against that snapshot and
 *   composes its task into a ready {@link RoleTask} payload.
 * - {@link RoleTask} runs the principal's model turn under its own host and
 *   returns a `Profile.RoleResult`.
 * - {@link ValidateResult} checks a result against the principal's charter.
 * - {@link PrepareWorkspace}, {@link CollectDiff}, {@link RunChecks},
 *   {@link DisposeWorkspace}, and {@link ApplyChange} drive the
 *   `Workspace` service. Repositories are named; their host paths are host
 *   configuration and never travel in a payload.
 * - {@link WriteReceipt} writes a JSON receipt under the wiki's generated
 *   directory, atomically.
 *
 * {@link reviewHandler} answers `Gates` Review gates by running the
 * reviewer's role task.
 *
 * @since 1.0.0
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Authority from "./Authority.ts"
import * as Gates from "./Gates.ts"
import type * as GatesLive from "./GatesLive.ts"
import * as Confined from "./internal/confined.ts"
import { canonicalDigest, sha256Hex } from "./internal/digest.ts"
import * as Profile from "./Profile.ts"
import * as Prompt from "./Prompt.ts"
import * as Roster from "./Roster.ts"
import * as Workspace from "./Workspace.ts"

/**
 * Records the current roster snapshot's revision. Nondeterministic, so a
 * replay reads the recorded revision, never the registry's current one.
 *
 * @category actions
 * @since 1.0.0
 */
export const PinRoster = Action.make("organization/pin-roster", {
  implementationVersion: "pin-roster/v1",
  payload: {},
  success: Schema.Struct({ revision: Schema.NonEmptyString }),
  nondeterministic: true
})

/**
 * Resolves a principal at a pinned revision and composes its task.
 *
 * @category actions
 * @since 1.0.0
 */
export const ComposeTask = Action.make("organization/compose-task", {
  implementationVersion: "compose-task/v1",
  payload: {
    revision: Schema.NonEmptyString,
    principal: Profile.PrincipalId,
    task: Profile.TaskContract,
    context: Schema.Array(Prompt.ContextEntry),
    workspace: Schema.optionalKey(Authority.TaskWorkspace)
  },
  success: Authority.RoleTaskPayload,
  error: Authority.DispatchRefused
})

/**
 * One principal's model turn. The seat and prompt come from the payload,
 * which `Authority.layer` checks against the trusted snapshot before the
 * handler runs; the system prompt and tools come from the principal's host.
 *
 * @category actions
 * @since 1.0.0
 */
export const RoleTask = AgentAction.make(Authority.roleTaskTag, {
  payload: Authority.RoleTaskPayload,
  output: Profile.RoleResult,
  seat: (payload) => payload.seat,
  prompt: Authority.promptOf
})

/**
 * A result's charter check.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Validation = Schema.Struct({ valid: Schema.Boolean, violations: Schema.Array(Roster.Violation) })

/**
 * A result's charter check.
 *
 * @category models
 * @since 1.0.0
 */
export type Validation = typeof Validation.Type

/**
 * Checks a role result against the principal's charter at a pinned
 * revision.
 *
 * @category actions
 * @since 1.0.0
 */
export const ValidateResult = Action.make("organization/validate-result", {
  implementationVersion: "validate-result/v1",
  payload: { revision: Schema.NonEmptyString, principal: Profile.PrincipalId, result: Profile.RoleResult },
  success: Validation,
  error: Authority.DispatchRefused
})

/**
 * A repository name, as the host's configuration spells it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Repository = Profile.Container

/**
 * A slug naming one workspace within an execution.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/, { expected: "a slug" }))

/**
 * The execution that prepared a workspace, from its key
 * `<execution>/<repository>/<slug>`.
 *
 * @category conversions
 * @since 1.0.0
 */
export const executionOfWorkspace = (key: string): string => key.split("/", 1)[0]!

/**
 * Seeds the workspace `<execution>/<repository>/<slug>` from a commit, with
 * an optional collected change applied over it.
 *
 * @category actions
 * @since 1.0.0
 */
export const PrepareWorkspace = Action.make("organization/prepare-workspace", {
  implementationVersion: "prepare-workspace/v1",
  payload: {
    repository: Repository,
    commit: Schema.NonEmptyString,
    slug: Slug,
    /** A collected change to apply over the commit, for a checker's own machine. */
    patch: Schema.optionalKey(Schema.String)
  },
  success: Workspace.Prepared,
  error: Workspace.WorkspaceError
})

/**
 * Collects a workspace's change.
 *
 * @category actions
 * @since 1.0.0
 */
export const CollectDiff = Action.make("organization/collect-diff", {
  implementationVersion: "collect-diff/v1",
  payload: { workspace: Workspace.Prepared },
  success: Workspace.Diff,
  error: Workspace.WorkspaceError
})

/**
 * The name of the check receipt an empty change fails with.
 *
 * @category constants
 * @since 1.0.0
 */
export const changeCheck = "change"

/**
 * What an empty change is, as a check result: one failing `change` receipt.
 * No check passes on nothing, so an empty change never counts as checked.
 *
 * @category constructors
 * @since 1.0.0
 */
export const unchanged = (commit: string): Workspace.Checks => {
  const reason = "no change: the collected diff is empty"
  return {
    commit,
    patchDigest: sha256Hex(""),
    passed: false,
    receipts: [{
      name: changeCheck,
      argv: ["git", "diff", "--cached"],
      exitCode: 1,
      timedOut: false,
      stdout: { text: "", bytes: 0, truncated: false },
      stderr: { text: reason, bytes: reason.length, truncated: false },
      durationMs: 0
    }]
  }
}

/**
 * Runs checks against a change in a fresh machine. An empty change boots no
 * machine and fails with {@link unchanged}'s receipt. Nondeterministic: the
 * recorded receipts are what a replay sees.
 *
 * @category actions
 * @since 1.0.0
 */
export const RunChecks = Action.make("organization/run-checks", {
  implementationVersion: "run-checks/v2",
  payload: {
    repository: Repository,
    commit: Workspace.CommitId,
    patch: Schema.String,
    checks: Schema.Array(Workspace.Check)
  },
  success: Workspace.Checks,
  error: Workspace.WorkspaceError,
  nondeterministic: true
})

/**
 * Removes a workspace's machine.
 *
 * @category actions
 * @since 1.0.0
 */
export const DisposeWorkspace = Action.make("organization/dispose-workspace", {
  implementationVersion: "dispose-workspace/v1",
  payload: { workspace: Workspace.Prepared },
  error: Workspace.WorkspaceError
})

/**
 * What {@link ApplyChange} lands.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ApplyPayload = Schema.Struct({
  repository: Repository,
  branch: Schema.NonEmptyString,
  parent: Workspace.CommitId,
  patch: Schema.String,
  message: Schema.NonEmptyString,
  principal: Profile.PrincipalId,
  at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

/**
 * Lands a patch on a branch of a host repository. Irreversible and keyed by
 * its content, so a retry lands the same commit or reports that the branch
 * moved.
 *
 * @category actions
 * @since 1.0.0
 */
export const ApplyChange = Action.make("organization/apply-change", {
  implementationVersion: "apply-change/v1",
  payload: ApplyPayload,
  success: Workspace.Applied,
  error: Workspace.WorkspaceError,
  tier: "irreversible",
  idempotencyKey: (payload) =>
    canonicalDigest({
      repository: payload.repository,
      branch: payload.branch,
      parent: payload.parent,
      patch: sha256Hex(payload.patch),
      message: payload.message,
      principal: payload.principal,
      at: payload.at
    })
})

/**
 * A receipt name: lowercase words joined by hyphens.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ReceiptName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/, { expected: "a receipt name" })
)

/**
 * A receipt that could not be written.
 *
 * @category errors
 * @since 1.0.0
 */
export class ReceiptFailed extends Schema.TaggedError<ReceiptFailed>()(
  "@smthrs/organization/Actions/ReceiptFailed",
  { message: Schema.String }
) {}

/**
 * Writes `<generatedDir>/<run>/<name>.json` atomically and returns its wiki
 * path and content digest.
 *
 * @category actions
 * @since 1.0.0
 */
export const WriteReceipt = Action.make("organization/write-receipt", {
  implementationVersion: "write-receipt/v1",
  payload: { runId: Schema.NonEmptyString, name: ReceiptName, receipt: Schema.Json },
  success: Schema.Struct({ path: Schema.String, digest: Schema.String }),
  error: ReceiptFailed
})

/**
 * The directory name a run's receipts are written under: the run id with
 * every character outside `[A-Za-z0-9._-]` replaced by `-`, and a leading
 * dot replaced.
 *
 * @category conversions
 * @since 1.0.0
 */
export const runDirectory = (runId: string): string =>
  runId.replaceAll(/[^A-Za-z0-9._-]/g, "-").replace(/^\./, "-").slice(0, 200)

/**
 * Host configuration for {@link layer}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** Repository names to trusted host paths. */
  readonly repositories: Readonly<Record<string, string>>
  /** The wiki root and the generated directory receipts go under. */
  readonly wiki: { readonly root: string; readonly generatedDir: string }
}

const executionId = Effect.map(FlowRuntime.FlowInstance, (instance) => instance.executionId)

/**
 * Implements every declaration here but {@link RoleTask}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: Options) => {
  const repositoryPath = (name: string) =>
    Object.hasOwn(options.repositories, name)
      ? Effect.succeed(options.repositories[name]!)
      : Effect.fail(
        new Workspace.WorkspaceError({ code: "invalid-request", message: `repository ${name} is not configured` })
      )
  return Layer.mergeAll(
    PinRoster.toLayer(
      () =>
        Effect.map(Authority.RosterRegistry, (registry) => registry.current).pipe(
          Effect.flatten,
          Effect.map((snapshot) => ({ revision: snapshot.revision }))
        ),
      { implementationVersion: "pin-roster/v1" }
    ),
    ComposeTask.toLayer(
      (payload) =>
        Effect.gen(function*() {
          const registry = yield* Authority.RosterRegistry
          const { profile, snapshot } = yield* registry.resolve(payload.revision, payload.principal)
          const composed = yield* Effect.fromResult(
            Authority.compose(snapshot, profile, payload.task, payload.context)
          )
          return {
            revision: payload.revision,
            principal: profile.id,
            seat: profile.seat,
            task: payload.task,
            context: payload.context,
            digest: composed.digest,
            ...(payload.workspace === undefined ? {} : { workspace: payload.workspace })
          }
        }),
      { implementationVersion: "compose-task/v1" }
    ),
    ValidateResult.toLayer(
      (payload) =>
        Effect.gen(function*() {
          const registry = yield* Authority.RosterRegistry
          const snapshot = yield* registry.get(payload.revision)
          const profile = snapshot.roster.profiles.get(payload.principal)
          if (profile === undefined) {
            return yield* new Authority.DispatchRefused({
              reason: "unknown-principal",
              message: `principal ${payload.principal} is not in roster revision ${payload.revision}`
            })
          }
          const violations = Roster.validateResult(profile, payload.result)
          return { valid: violations.length === 0, violations }
        }),
      { implementationVersion: "validate-result/v1" }
    ),
    PrepareWorkspace.toLayer(
      (payload) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace.Workspace
          const repoPath = yield* repositoryPath(payload.repository)
          const key = `${yield* executionId}/${payload.repository}/${payload.slug}`
          return yield* workspace.prepare({
            key,
            repoPath,
            commit: payload.commit,
            ...(payload.patch === undefined ? {} : { patch: payload.patch })
          })
        }),
      { implementationVersion: "prepare-workspace/v1" }
    ),
    CollectDiff.toLayer(
      (payload) => Effect.flatMap(Workspace.Workspace, (workspace) => workspace.collect(payload.workspace)),
      { implementationVersion: "collect-diff/v1" }
    ),
    RunChecks.toLayer(
      (payload) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace.Workspace
          const repoPath = yield* repositoryPath(payload.repository)
          if (payload.patch === "") return unchanged(payload.commit)
          return yield* workspace.runChecks({
            key: `${yield* executionId}/${payload.repository}/checks`,
            repoPath,
            commit: payload.commit,
            patch: payload.patch,
            checks: payload.checks
          })
        }),
      { implementationVersion: "run-checks/v2" }
    ),
    DisposeWorkspace.toLayer(
      (payload) => Effect.flatMap(Workspace.Workspace, (workspace) => workspace.dispose(payload.workspace)),
      { implementationVersion: "dispose-workspace/v1" }
    ),
    ApplyChange.toLayer(
      (payload) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace.Workspace
          const repoPath = yield* repositoryPath(payload.repository)
          return yield* workspace.applyChange({
            repoPath,
            branch: payload.branch,
            parent: payload.parent,
            patch: payload.patch,
            message: payload.message,
            runId: yield* executionId,
            principal: payload.principal,
            at: payload.at
          })
        }),
      { implementationVersion: "apply-change/v1" }
    ),
    WriteReceipt.toLayer(
      (payload) =>
        Effect.gen(function*() {
          const content = `${JSON.stringify(payload.receipt, null, 2)}\n`
          const relative = `${options.wiki.generatedDir.replace(/\/+$/, "")}/${
            runDirectory(payload.runId)
          }/${payload.name}.json`
          yield* Confined.writeText({ root: options.wiki.root, relative, content }).pipe(
            Effect.mapError((refusal) => new ReceiptFailed({ message: `${relative} ${refusal.message}` }))
          )
          return { path: relative, digest: sha256Hex(content) }
        }),
      { implementationVersion: "write-receipt/v1" }
    )
  )
}

/**
 * The layer's requirements, spelled out for hosts.
 *
 * @category models
 * @since 1.0.0
 */
export type Requirements =
  | Authority.RosterRegistry
  | Workspace.Workspace
  | FileSystem.FileSystem
  | Path.Path
  | FlowRuntime.FlowRuntime

/**
 * Options for {@link reviewHandler}.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReviewOptions {
  /** The reviewer's charter output field holding `approve` or `request-changes`. Default `verdict`. */
  readonly verdictField?: string | undefined
}

/**
 * Answers a Review gate by running the reviewer's role task.
 *
 * The reviewer is resolved against the registry's current snapshot, so a
 * paused or retired reviewer denies the gate. Its task carries the gate's
 * subject as fenced context. The verdict is `approve` only when the result
 * is `done`, passes its charter check, and its verdict field is `approve`;
 * every failure to produce such a result is a `ReviewFailed`, which the gate
 * records as denied.
 *
 * @category reviewers
 * @since 1.0.0
 */
export const reviewHandler = (
  options: ReviewOptions = {}
): GatesLive.ReviewHandler<
  Authority.RosterRegistry | Action.Implementations | Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
> => {
  const field = options.verdictField ?? "verdict"
  const failed = (message: string) => new Gates.ReviewFailed({ message })
  return (request) =>
    Effect.gen(function*() {
      const registry = yield* Authority.RosterRegistry
      const snapshot = yield* registry.current
      const { profile } = yield* registry.resolve(snapshot.revision, request.reviewer).pipe(
        Effect.mapError((refused) => failed(`reviewer ${request.reviewer} refused: ${refused.message}`))
      )
      if (!profile.charter.output.fields.some((declared) => declared.name === field)) {
        return yield* failed(`reviewer ${profile.id}'s charter declares no ${field} output`)
      }
      const subjectDigest = canonicalDigest(request.subject)
      const task: Profile.TaskContract = {
        id: `review/${request.gateId}/${subjectDigest.slice(0, 16)}`,
        objective:
          `Review the subject of gate ${request.gateId} at ${request.boundary} ${request.target} and decide whether it may proceed.`,
        inputs: ["The subject under review, in the context below."],
        acceptance: [`Return done with ${field} set to approve or request-changes, and the reason as the summary.`],
        evidence: ["What in the subject the decision rests on."],
        requestedBy: "owner"
      }
      const context: ReadonlyArray<Prompt.ContextEntry> = [{
        source: { provider: "organization", id: `gate/${request.gateId}` },
        provenance: { retrievedAtMs: yield* Clock.currentTimeMillis },
        text: JSON.stringify(request.subject, null, 2)
      }]
      const composed = Authority.compose(snapshot, profile, task, context)
      if (Result.isFailure(composed)) return yield* failed(composed.failure.message)
      const payload: Authority.RoleTaskPayload = {
        revision: snapshot.revision,
        principal: profile.id,
        seat: profile.seat,
        task,
        context,
        digest: composed.success.digest
      }
      const table = yield* Action.Implementations
      const implementation = yield* table.get(Authority.roleTaskTag)
      if (Option.isNone(implementation)) return yield* failed("no organization/role-task is registered")
      const answer = yield* implementation.value.action(payload).pipe(
        Effect.mapError((error) =>
          failed(`the review did not complete: ${String(Reflect.get(Object(error), "message"))}`)
        )
      )
      const result = yield* Profile.decodeRoleResult(answer).pipe(
        Effect.mapError(() => failed("the review returned a malformed result"))
      )
      const violations = Roster.validateResult(profile, result)
      if (violations.length > 0) {
        return yield* failed(`the review result breaks ${profile.id}'s charter: ${violations[0]!.message}`)
      }
      return {
        decision: result.status === "done" && result.fields[field] === "approve"
          ? "approve" as const
          : "request-changes" as const,
        reason: result.summary,
        reviewer: profile.id
      }
    })
}

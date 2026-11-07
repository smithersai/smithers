import { digestSync } from "@smthrs/crypto"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Core, GitHub } from "@smthrs/integrations"
import { Node } from "@smthrs/plan"
import { Cause, Clock, Effect, Layer, Metric, Option, Schema } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { WRITE_FAILURES, type WriteFailure } from "../../src/features/issues/contract.ts"
import {
  DEFAULT_MERGE_FLOW,
  MERGE_FLOW_FILE,
  MERGE_FLOWS,
  type MergeFlow,
  queueRequestOf,
} from "../../src/features/pulls/contract.ts"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import type { Services } from "./Apply.vibe"
import { classify, withToken } from "#vibelang/emitted/worker/github/Calls"
import { repositoryOf } from "#vibelang/emitted/worker/github/Config"
import * as Metrics from "#vibelang/emitted/worker/github/Metrics"
import { fetchPull, liveBaseHeadOf, moveBase, projectPull } from "./Pulls.ts"
import * as Store from "./Store.ts"

// `pr/Merge { writeId }` (decision 0012 decision 6, docs/features/pulls.md#merge): a person's merge, and only a
// person's. The writes route admitted it from the person's own session (never a run credential, never the agent),
// at Maintainer or above, bound to the head and base they saw. This step merges through `Action.once` with
// `GitHub.Once.merge`, so the merge commit's message carries the write's key and a lost answer is found by that key,
// never by the pull request merely being merged. Before merging it re-reads the pull request and refuses a moved head
// (`head_moved`), a draft, or one already merged or closed, and reads the base branch's own head, refusing
// `base_moved` unless it is the base the person saw: GitHub's `base.sha` is the commit the branch pointed at when the
// pull request opened and never moves. Then it merges with the person's own GitHub token, so GitHub shows them and
// applies their permissions and the branch protection, fenced by the head SHA (GitHub answers 409 when it moved since).
// Squash by default. Nothing here bypasses a required check: GitHub's refusal is `not_mergeable`.
//
// GitHub's merge takes no base precondition, so a push to the base between the step's read and GitHub's merge, one
// round trip, still lands under the merge; branch protection ("require branches to be up to date") is the only fence
// for it. The step reads a squash merge back against the base it checked and records `base="moved"` when that happened.
//
// Which merge runs is the repository's to say (ruling BR-7, decision 0134): `.smithers/merge.json` at the base the
// person saw names its merge flow. `github` (no file) is the merge above. `queue` asks the repository's own merge queue
// instead: after the same recheck of the head, the step posts one comment as the person, keyed like the merge, whose
// hidden marker names the head they pressed Merge on. The queue's poller enqueues exactly that head, lands it through
// its gate, says on the pull request how it went, and closes it once landed. The base isn't checked for a queue: the
// queue lands the head on whatever main is then, through its gate.

/** GitHub or Postgres couldn't answer, or the answer was lost: retried, after `retryAfterMillis`. */
export class MergeUnavailable extends Schema.TaggedError<MergeUnavailable>()("@smthrs/mvp/github/MergeUnavailable", {
  retryAfterMillis: Schema.optional(Schema.Number),
}) {}

/** A person waits on a merge: 1 s doubling to 15 s, for at most 5 minutes. */
export const MERGE_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 15_000, expirationMs: 5 * 60_000 })

const MergeRequest = { writeId: Schema.String.check(Schema.isUUID()) }

/** How the merge ended: `done` with the merge commit, or why not. */
export const Merged = Schema.Struct({
  status: Schema.Literals(["done", "refused", "failed", "missing"]),
  mergeSha: Schema.NullOr(Schema.String),
})
export type Merged = typeof Merged.Type

/**
 * `send`'s implementation version. v2 (2026-10-21) merges through `Action.once` keyed by the write and rechecks the
 * base branch's own head; a run parked on a v1 plan stops with `plan_changed` rather than resume under different
 * recovery. v3 (2026-10-31, decision 0134) reads the repository's merge flow first and may ask its queue instead.
 */
export const SEND_VERSION = "pr-merge/send/v3"

/**
 * The step: recheck and merge once. Its merge goes through `Action.once`, so a repeat is safe: the durable engine
 * re-runs an attempt that died mid-merge, and `once` finds the merge by its key.
 */
export const Send = Action.make("pr/Merge/send", {
  payload: MergeRequest,
  success: Merged,
  error: MergeUnavailable,
  implementationVersion: SEND_VERSION,
  tier: "irreversible",
  idempotencyKey: ({ writeId }) => ({ merge: writeId }),
  retryPolicy: MERGE_RETRY,
})

export const GiveUp = Action.make("pr/Merge/give-up", {
  payload: MergeRequest,
  success: Merged,
  error: MergeUnavailable,
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
})

/** `pr/Merge`: merges one pull request as the person who pressed Merge. */
export const Merge = Flow.make("pr/Merge", {
  description: "Merge one pull request as the person who pressed Merge, at the head they saw, squash unless they " +
    "chose otherwise; refuse a moved head or base, a draft, or a pull request already merged or closed.",
  capabilities: ["db:write:github_writes", "db:write:items", "db:write:pulls"],
  modelInvocable: false,
  payload: MergeRequest,
  success: Merged,
  error: MergeUnavailable,
  body: Node.capture({ send: Send.name, giveUp: GiveUp.name }, (request) =>
    Send.call(request).pipe(Node.catch({ onFailure: () => GiveUp.call(request) }))),
})

/**
 * Merges, by `outcome`: `done`, or the failure; by `flow` once the repository's merge flow is known (`github` or
 * `queue`, decision 0134); a GitHub merge also by `base`, the base GitHub merged it onto: `seen` (the one the step
 * checked), `moved` (a push landed between the check and the merge), or `unchecked` (a merge commit or a rebase, or a
 * read-back that failed).
 */
export const merges = Metric.counter("smithers_pr_merges", {
  description: "Pull request merges a person asked for, by outcome and, for a merge, the base it landed on",
  incremental: true,
})

/** The base a merge landed on, as the step read it back. */
export type Landed = "seen" | "moved" | "unchecked"

/**
 * The key a merge carries in its commit message: SHA-256 of the write id, which the route recorded before the flow
 * started, so every attempt and every run of this write derives the same one and no other write does.
 */
export const mergeKeyOf = (writeId: string): string => digestSync(`smithers/pr-merge/v1\n${writeId}`)

/**
 * `.smithers/merge.json`'s one field (decision 0134). Anything else in the file is refused, so a typo never reads as
 * the default.
 */
const MergeFile = Schema.Struct({ flow: Schema.Literals(MERGE_FLOWS) })
const decodeMergeFile = Schema.decodeUnknownOption(Schema.fromJsonString(MergeFile), { onExcessProperty: "error" })

/** A repository's merge flow from its `.smithers/merge.json` text, or none when the file says nothing we know. */
export const mergeFlowOf = (text: string): Option.Option<MergeFlow> =>
  Option.map(decodeMergeFile(text), (file) => file.flow)

/** The recheck refused the merge before anything was sent: why, and the base branch's head when it moved. */
class Refused extends Schema.TaggedError<Refused>()("@smthrs/mvp/github/MergeRefused", {
  failure: Schema.Literals(WRITE_FAILURES),
  baseHead: Schema.optional(Schema.String),
}) {}

/** What GitHub's refusal of a merge means. */
export const refusalOf = (status: number): WriteFailure =>
  status === 405
    ? "not_mergeable"
    : status === 409
    ? "head_moved"
    : status === 401
    ? "sign_in_required"
    : status === 404
    ? "not_found"
    : status === 422
    ? "invalid"
    : "not_allowed"

/** The steps over `services`. */
export const steps = <E, R>(services: Services<E, R>) => {
  const settled = (
    write: Store.Write,
    settlement: Store.Settlement,
    mergeSha: string | null,
    landed?: Landed,
    project?: Effect.Effect<unknown, never, SqlClient.SqlClient>,
    flow?: MergeFlow,
  ) =>
    Effect.gen(function* () {
      const now = yield* Store.settleWrite(write.id, settlement, project)
      const outcome = settlement.status === "done" ? "done" : settlement.failure
      const base: Record<string, string> = {
        ...(landed === undefined ? {} : { base: landed }),
        ...(flow === undefined ? {} : { flow }),
      }
      if (now) {
        yield* Metric.update(Metric.withAttributes(merges, { outcome, ...base }), 1)
        yield* Metric.update(Metric.withAttributes(Metrics.writeMs, { op: write.op }), (yield* Clock.currentTimeMillis) - write.createdAt)
      }
      yield* Effect.logWithLevel(settlement.status === "done" && landed !== "moved" ? "Info" : "Warn")("github.merge").pipe(
        Effect.annotateLogs({ writeId: write.id, outcome, settled: now, ...base }),
      )
      return { status: settlement.status, mergeSha } satisfies Merged
    })

  /**
   * The merged pull request read back with the App's token and projected, and every other open pull request into its
   * base given the merge as its base's head, in a savepoint: a projection that fails is logged and left to the next
   * read, never rolling back the merge's settlement (Fable review, 2026-10-21).
   */
  const projected = (
    writeId: string,
    repository: ReturnType<typeof repositoryOf>,
    number: number,
    checked: string,
    mergeSha: string,
  ) =>
    Effect.gen(function* () {
      const read = yield* services.tokens.forInstallation(repository, "pulls").pipe(Effect.option)
      const fetched = Option.isSome(read)
        ? yield* fetchPull(repository, number).pipe(withToken(read.value, services.apiBaseUrl), Effect.option)
        : Option.none()
      const sql = yield* SqlClient.SqlClient
      return sql.withTransaction(Effect.gen(function* () {
        if (Option.isSome(fetched)) yield* projectPull(repository, number, fetched.value)
        yield* moveBase(repository.id, number, checked, mergeSha)
      })).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Metric.update(Metric.withAttributes(Metrics.projectionFailures, { op: "pr/merge" }), 1)
            yield* Effect.logWarning("github.merge").pipe(
              Effect.annotateLogs({ writeId, projection: "failed", errorCode: codeOf(Cause.squash(cause)) }),
            )
          })
        ),
      )
    })

  /**
   * The repository's merge flow (decision 0134): `.smithers/merge.json` at the base the person saw, read with the App's
   * contents token. No file is GitHub's merge. A file that isn't `{ "flow": "github" | "queue" }` is refused `invalid`,
   * never read as the default, so a repository that asked for its queue never gets a direct merge by mistake.
   */
  const flowOf = (repository: ReturnType<typeof repositoryOf>, ref: string) =>
    Effect.gen(function* () {
      const token = yield* services.tokens.forInstallation(repository, "contents").pipe(
        Effect.mapError((error) =>
          error.reason === "app_not_installed" || error.reason === "not_allowed"
            ? new Refused({ failure: error.reason })
            : new MergeUnavailable(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis })
        ),
      )
      const file = yield* GitHub.Contents.getText(repository.owner, repository.name, MERGE_FLOW_FILE, { ref }).pipe(
        withToken(token, services.apiBaseUrl),
        Effect.mapError((error) => {
          // A directory, a file over 1 MB or bytes that aren't UTF-8: no merge flow we can read.
          if (Core.IntegrationError.isIntegrationError(error) && error.reason === "decode-failed") {
            return new Refused({ failure: "invalid" })
          }
          const classified = classify(error)
          return classified.kind === "refused"
            ? new Refused({ failure: refusalOf(classified.status) })
            : new MergeUnavailable(
              classified.kind === "retry" && classified.retryAfterMillis !== undefined
                ? { retryAfterMillis: classified.retryAfterMillis }
                : {},
            )
        }),
      )
      if (Option.isNone(file)) return DEFAULT_MERGE_FLOW
      const flow = mergeFlowOf(file.value.text)
      return Option.isSome(flow) ? flow.value : yield* new Refused({ failure: "invalid" })
    })

  /**
   * A queue merge: the head rechecked as for a merge, then one comment as the person asking the repository's queue to
   * land it, found again by the write's key in its hidden marker. The base isn't checked: the queue lands the head on
   * whatever main is then, through its own gate.
   */
  const queued = (repository: ReturnType<typeof repositoryOf>, number: number, headSha: string, key: string) => {
    const request = GitHub.Once.comment(repository.owner, repository.name, number, queueRequestOf(headSha))
    return Action.once(
      "queue",
      Action.keyed({
        find: request.find,
        perform: (key) =>
          Effect.gen(function* () {
            const pull = yield* GitHub.Pulls.getPull(repository.owner, repository.name, number)
            if (pull.merged) return yield* new Refused({ failure: "merged" })
            if (pull.state === "closed") return yield* new Refused({ failure: "closed" })
            if (pull.draft) return yield* new Refused({ failure: "draft" })
            if (pull.head.sha !== headSha) return yield* new Refused({ failure: "head_moved" })
            return yield* request.perform(key)
          }),
      }),
      { key },
    )
  }

  /** A merge or a queue request that failed: refused for good and settled, or unavailable and tried again. */
  const failedSend = (write: Store.Write, failure: unknown, flow: MergeFlow) =>
    Effect.gen(function* () {
      if (failure instanceof Refused) {
        return yield* settled(write, { status: "refused", failure: failure.failure }, null, undefined, undefined, flow)
      }
      const classified = classify(failure)
      if (classified.kind === "refused") {
        return yield* settled(
          write,
          { status: "refused", failure: refusalOf(classified.status) },
          null,
          undefined,
          undefined,
          flow,
        )
      }
      if (classified.kind === "unknown") {
        yield* Metric.update(Metric.withAttributes(Metrics.writeUnknown, { op: write.op }), 1)
      }
      yield* Effect.logWarning("github.merge").pipe(
        Effect.annotateLogs({ writeId: write.id, flow, outcome: classified.kind, errorCode: codeOf(failure) }),
      )
      return yield* new MergeUnavailable(
        classified.kind === "retry" && classified.retryAfterMillis !== undefined
          ? { retryAfterMillis: classified.retryAfterMillis }
          : {},
      )
    })

  const send = ({ writeId }: typeof Send.payloadSchema.Type) =>
    Effect.gen(function* () {
      const found = yield* Store.writeOf(writeId)
      if (Option.isNone(found) || found.value.payload.op !== "pr/merge") {
        return { status: "missing", mergeSha: null } satisfies Merged
      }
      const write = found.value
      const payload = found.value.payload
      if (write.status !== "pending") return { status: write.status, mergeSha: null } satisfies Merged
      const repository = repositoryOf(write.repoId.replace(/^github\//, ""))
      // Only a person's own session admits a merge. A write without one, which the route never admits, is refused now
      // rather than retried.
      if (write.sessionId === null) return yield* settled(write, { status: "refused", failure: "sign_in_required" }, null)
      const token = yield* services.tokens.forSession(write.sessionId).pipe(Effect.result)
      if (token._tag === "Failure") {
        if (token.failure.reason === "refreshing" || token.failure.reason === "unavailable") {
          return yield* new MergeUnavailable(
            token.failure.retryAfterMillis === undefined ? {} : { retryAfterMillis: token.failure.retryAfterMillis },
          )
        }
        return yield* settled(write, { status: "refused", failure: "sign_in_required" }, null)
      }
      const flow = yield* flowOf(repository, payload.baseSha).pipe(Effect.result)
      if (flow._tag === "Failure") {
        if (flow.failure instanceof Refused) {
          return yield* settled(write, { status: "refused", failure: flow.failure.failure }, null)
        }
        return yield* flow.failure
      }
      if (flow.success === "queue") {
        const asked = yield* Effect.gen(function* () {
          // Counted for the write's record; `Action.once` decides what was asked, by the key alone.
          yield* Store.beginAttempt(write.id)
          return yield* queued(repository, payload.number, payload.headSha, mergeKeyOf(write.id))
        }).pipe(withToken(token.success, services.apiBaseUrl), Effect.result)
        if (asked._tag === "Failure") return yield* failedSend(write, asked.failure, "queue")
        return yield* settled(
          write,
          { status: "done", itemNumber: payload.number, githubId: asked.success.id, mergeFlow: "queue" },
          null,
          undefined,
          undefined,
          "queue",
        )
      }
      const keyed = (commitTitle?: string) =>
        GitHub.Once.merge(repository.owner, repository.name, payload.number, {
          sha: payload.headSha,
          method: payload.method,
          ...(commitTitle === undefined ? {} : { commitTitle }),
        })
      const outcome = yield* Effect.gen(function* () {
        // Counted for the write's record; `Action.once` decides what was merged, by the key alone.
        yield* Store.beginAttempt(write.id)
        const merged = yield* Action.once(
          "merge",
          Action.keyed({
            find: keyed().find,
            perform: (key) =>
              Effect.gen(function* () {
                const pull = yield* GitHub.Pulls.getPull(repository.owner, repository.name, payload.number)
                if (pull.merged) return yield* new Refused({ failure: "merged" })
                if (pull.state === "closed") return yield* new Refused({ failure: "closed" })
                if (pull.draft) return yield* new Refused({ failure: "draft" })
                if (pull.head.sha !== payload.headSha) return yield* new Refused({ failure: "head_moved" })
                // The branch's own head, never GitHub's snapshot: a branch gone, or one whose head can't be read, is
                // refused rather than merged onto a base nobody checked (Codex Astra review).
                const baseHead = yield* liveBaseHeadOf(repository, pull)
                if (Option.isNone(baseHead)) return yield* new Refused({ failure: "base_moved" })
                if (baseHead.value !== payload.baseSha) {
                  return yield* new Refused({ failure: "base_moved", baseHead: baseHead.value })
                }
                return yield* keyed(`${pull.title} (#${pull.number})`).perform(key)
              }),
          }),
          { key: mergeKeyOf(write.id) },
        )
        // A squash is one commit on the base GitHub merged onto: one ahead of the base checked, unless a push landed
        // between the check and the merge.
        const landed: Landed = payload.method === "squash"
          ? yield* GitHub.Commits.compare(repository.owner, repository.name, payload.baseSha, merged.sha).pipe(
            Effect.map((compared): Landed => (compared.aheadBy === 1 && compared.behindBy === 0 ? "seen" : "moved")),
            Effect.catch(() => Effect.succeed<Landed>("unchecked")),
          )
          : "unchecked"
        return { sha: merged.sha, landed }
      }).pipe(withToken(token.success, services.apiBaseUrl), Effect.result)
      if (outcome._tag === "Failure") {
        const failure = outcome.failure
        // The base moved: every open pull request into it shows the head read, so the person decides again on it.
        if (failure instanceof Refused && failure.baseHead !== undefined) {
          yield* moveBase(repository.id, payload.number, payload.baseSha, failure.baseHead)
        }
        return yield* failedSend(write, failure, "github")
      }
      const merged = outcome.success
      return yield* settled(
        write,
        { status: "done", itemNumber: payload.number, githubId: null, mergeFlow: "github" },
        merged.sha,
        merged.landed,
        yield* projected(write.id, repository, payload.number, payload.baseSha, merged.sha),
        "github",
      )
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, services.http),
      Effect.provide(services.database),
      Effect.catch((error) =>
        error instanceof MergeUnavailable
          ? Effect.fail(error)
          : Effect.logWarning("github.merge").pipe(
            Effect.annotateLogs({ writeId, outcome: "failed", errorCode: codeOf(error) }),
            Effect.andThen(Effect.fail(new MergeUnavailable({}))),
          )
      ),
      Effect.withSpan("github.merge", { attributes: { "smithers.github.write": writeId } }),
    )

  const giveUp = ({ writeId }: typeof GiveUp.payloadSchema.Type) =>
    Effect.gen(function* () {
      const found = yield* Store.writeOf(writeId)
      if (Option.isNone(found)) return { status: "missing", mergeSha: null } satisfies Merged
      // A write another run settled answers what it settled, never `failed`.
      if (found.value.status !== "pending") return { status: found.value.status, mergeSha: null } satisfies Merged
      return yield* settled(found.value, { status: "failed", failure: "unavailable" }, null)
    }).pipe(
      Effect.provide(services.database),
      Effect.mapError(() => new MergeUnavailable({})),
      Effect.withSpan("github.merge.give_up", { attributes: { "smithers.github.write": writeId } }),
    )

  return { send, giveUp }
}

/** Registers `pr/Merge` with its steps over `services`. */
export const registration = <E, R>(services: Services<E, R>) => {
  const implementation = steps(services)
  return Interpreter.layerWithImplementations(
    Merge,
    Layer.merge(
      Send.toLayer(implementation.send, { implementationVersion: SEND_VERSION }),
      GiveUp.toLayer(implementation.giveUp),
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}

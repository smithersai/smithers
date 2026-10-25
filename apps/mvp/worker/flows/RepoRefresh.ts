import { CodeStorage } from "@smthrs/effect-code-storage"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { repoId } from "../../src/features/repo/contract.ts"
import * as Repos from "../Repos.ts"
import { CloneUnavailable, STEP_RETRY, SYNC_RETRY, type Services } from "./RepoClone.ts"

const Request = { owner: Schema.String, name: Schema.String }
const Target = Schema.Struct({ ready: Schema.Boolean, id: Schema.String, branch: Schema.String, sha: Schema.String, owner: Schema.String, name: Schema.String })
const outcomes = Metric.counter("repo_refresh_steps", { description: "Mirror refresh steps by stage and outcome" })
const record = (stage: string, ref: string, outcome: string) => Effect.all([
  Effect.logInfo("repo.refresh").pipe(Effect.annotateLogs({ stage, ref, outcome })),
  Metric.update(Metric.withAttributes(outcomes, { stage, outcome }), 1),
], { discard: true })

export const Inspect = Action.make("repo/RefreshInspect", {
  payload: Request, success: Target, error: CloneUnavailable, retryPolicy: STEP_RETRY,
})
export const Pull = Action.make("repo/RefreshPull", {
  payload: { id: Schema.String, sha: Schema.String }, success: Schema.Struct({}), error: CloneUnavailable, retryPolicy: STEP_RETRY,
})
export const Settle = Action.make("repo/RefreshSettle", {
  payload: Target, success: Schema.Struct({}), error: CloneUnavailable, retryPolicy: SYNC_RETRY,
})

/** Refresh only an admitted mirror. Pull's receipt is durable; waiting never starts another pull. */
export const Refresh = Flow.make("repo/Refresh", {
  description: "Refresh an existing GitHub mirror and publish its verified default branch head.",
  capabilities: ["db:write:repositories"], modelInvocable: false,
  payload: Request, success: Schema.Struct({}), error: CloneUnavailable,
  body: Node.capture({ inspect: Inspect.name, pull: Pull.name, settle: Settle.name }, (request) =>
    Inspect.call(request).pipe(Node.branch({
      if: Node.capture({ ready: true }, (target: typeof Target.Type) => target.ready),
      then: Node.capture({ pull: Pull.name, settle: Settle.name }, (target) =>
        Pull.call({ id: target.id, sha: target.sha }).pipe(Node.andThen(Settle.call(target)))),
      else: Node.capture({ skipped: true }, () => Node.succeed({})),
    }))),
})

export const steps = <E, R>(services: Pick<Services<E, R>, "database" | "upstream" | "codeStorage">) => {
  const inspect = (request: typeof Inspect.payloadSchema.Type) => Effect.gen(function* () {
    const id = repoId(request.owner, request.name)
    const current = yield* Repos.readyHead(id)
    if (Option.isNone(current)) {
      yield* record("inspect", "", "not_cloned")
      return { ...request, id, ready: false, branch: "", sha: "" }
    }
    const head = yield* services.upstream.head(request.owner, request.name).pipe(Effect.mapError(() => new CloneUnavailable()))
    if (head.branch === undefined) return yield* new CloneUnavailable()
    yield* record("inspect", head.sha, "ready")
    return { ready: true, id, branch: head.branch, sha: head.sha, owner: request.owner, name: request.name }
  }).pipe(Effect.provide(services.database), Effect.mapError((error) => error instanceof CloneUnavailable ? error : new CloneUnavailable()), Effect.withSpan("repo.refresh.inspect"))

  const settle = (target: typeof Target.Type) => Effect.gen(function* () {
    const current = yield* Repos.readyHead(target.id)
    if (Option.isNone(current)) return {}
    const upstream = yield* services.upstream.head(target.owner, target.name).pipe(Effect.mapError(() => new CloneUnavailable()))
    if (upstream.branch === undefined) return yield* new CloneUnavailable()
    const page = yield* services.codeStorage.listCommits(target.id, { ref: upstream.branch, limit: 1 }).pipe(
      Effect.mapError((error: CodeStorage.CodeStorageError) => new CloneUnavailable(
        error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis },
      )),
    )
    const head = page.commits[0]
    // A pull acknowledgment isn't completion. Never publish the previous mirror head as a successful refresh.
    if (head === undefined || head.sha !== upstream.sha) {
      yield* record("settle", target.sha, "pending")
      return yield* new CloneUnavailable()
    }
    const sql = yield* SqlClient.SqlClient
    // An older execution must not overwrite a newer refresh (including after a force push).
    const updated = yield* sql`UPDATE repositories SET default_branch = ${upstream.branch}, head_sha = ${head.sha},
      head_message = ${head.message}, head_author = ${head.authorName}, head_at = ${head.date}::timestamptz,
      refs_changed_at = now()
      WHERE id = ${target.id} AND status = 'ready' AND head_sha = ${current.value.sha} RETURNING id`
    if (updated.length === 0) return yield* new CloneUnavailable()
    yield* record("settle", head.sha, "ready")
    return {}
  }).pipe(Effect.provide(services.database), Effect.mapError((error) => error instanceof CloneUnavailable ? error : new CloneUnavailable()), Effect.withSpan("repo.refresh.settle"))
  const pull = (target: typeof Pull.payloadSchema.Type) => services.codeStorage.pullUpstream(target.id).pipe(
    Effect.tap(() => record("pull", target.sha, "requested")),
    Effect.mapError((error) => new CloneUnavailable(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis })),
    Effect.as({}), Effect.withSpan("repo.refresh.pull"),
  )
  return { inspect, pull, settle }
}

export const registration = <E, R>(services: Pick<Services<E, R>, "database" | "upstream" | "codeStorage">) => {
  const handlers = steps(services)
  return Interpreter.layerWithImplementations(Refresh, Layer.mergeAll(
    Inspect.toLayer(handlers.inspect), Pull.toLayer(handlers.pull), Settle.toLayer(handlers.settle),
  )).pipe(Layer.provideMerge(Action.layerImplementations))
}

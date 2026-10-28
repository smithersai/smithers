import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Deferred, Effect, Exit, Option, Schema, type Scope } from "effect"
import { type DispatchFailed, FlowDispatch } from "../../flows/dispatch"
import { entryOf, type FlowName } from "../../flows/registry"
import { ENGINE_OPERATIONS } from "../../writeAdmission"
import { WRITE_ID_NAMESPACE } from "../issues/contract"
import { QueuedWrite } from "../issues/schema"
import { IssuesStore } from "../issues/store"
import { OP_ID_NAMESPACE } from "../todos/contract"
import { QueuedOp } from "../todos/schema"
import { TodosStore } from "../todos/store"
import { STEER_ID_NAMESPACE } from "../runs/contract"
import { RunSteers } from "../runs/steers"

const issueWrites = new Set<FlowName>(["issue/create", "issue/comment", "issue/triage", "issue/commitment", "triage/run", "triage/enable", "triage/pause"])
const todoWrites = new Set<FlowName>(["todo/commit", "todo/drop", "todo/Retry"])
export const hasOutboxAdmission = (name: FlowName): boolean => issueWrites.has(name) || todoWrites.has(name) || name === "run/steer"
export const admissionNamespace = (name: FlowName) => issueWrites.has(name) ? WRITE_ID_NAMESPACE : todoWrites.has(name) ? OP_ID_NAMESPACE : STEER_ID_NAMESPACE
/** Operations whose admission is this device's engine recording their run (decision 0124): their input is staged too. */
export const hasEngineAdmission = (name: FlowName): boolean => ENGINE_OPERATIONS.has(name)

/** How an engine admission ended: recorded, refused by the engine, or unconfirmed (no reply, which proves nothing). */
export type Started = "admitted" | "refused" | "unconfirmed"

/** A refusal the engine answered, as opposed to a reply that never came. */
const refusedStart = (failure: DispatchFailed) => failure.reason === "refused" || failure.reason === "invalid"

/**
 * Starts an engine operation under `executionId` through dispatch, in `scope`, and answers once the engine recorded it
 * or said why not, with the run's fiber: the run goes on in the background. The same execution again joins its run.
 */
export const startOperation = (
  name: FlowName,
  payload: Readonly<Record<string, unknown>>,
  options: { readonly executionId: string; readonly door: "slash" | "button"; readonly scope: Scope.Scope },
) =>
  Effect.gen(function* () {
    const flows = yield* FlowDispatch
    const admitted = yield* Deferred.make<void, DispatchFailed>()
    const run = yield* flows.dispatch(name, payload as never, { door: options.door, executionId: options.executionId, admitted }).pipe(
      Effect.forkIn(options.scope, { startImmediately: true }),
    )
    // Dispatch completes `admitted` with a `DispatchFailed` for every start that didn't record a run.
    const start = yield* Effect.exit(Deferred.await(admitted))
    const started: Started = Exit.isSuccess(start)
      ? "admitted"
      : Option.exists(Exit.findErrorOption(start), refusedStart) ? "refused" : "unconfirmed"
    return { started, run }
  })

const outcome = (queued: boolean) => Option.some(queued ? "queued" as const : "not_admitted" as const)

/** Core transport infrastructure: the existing public flow schemas feed their existing device outboxes. */
export const admitCommand = (name: FlowName, payload: Readonly<Record<string, unknown>>, executionId: string) =>
  Effect.gen(function* () {
    if (!hasOutboxAdmission(name)) return Option.none<"queued" | "not_admitted">()
    const decoded = yield* Schema.decodeUnknownEffect(entryOf(name).flow.payloadSchema as unknown as Schema.Codec<unknown>)(payload).pipe(Effect.result)
    if (decoded._tag === "Failure") return outcome(false)
    const value = decoded.success as Readonly<Record<string, unknown>>
    const id = yield* Uuid.v5(admissionNamespace(name), executionId).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
    if (issueWrites.has(name)) {
      const write = yield* Schema.decodeUnknownEffect(QueuedWrite)({ ...value, id, op: name,
        title: typeof value.title === "string" ? value.title.trim() : "", number: value.number ?? 0,
        body: value.body ?? value.reason ?? "",
      }).pipe(Effect.orDie)
      const store = yield* IssuesStore
      return outcome((yield* store.queue(write)).queued)
    }
    if (todoWrites.has(name)) {
      const op = yield* Schema.decodeUnknownEffect(QueuedOp)({ ...value, id,
        op: name === "todo/commit" ? "commit" : name === "todo/drop" ? "drop" : "retry",
        title: typeof value.title === "string" ? value.title.trim() : "", prompt: value.prompt ?? "", acceptance: value.acceptance ?? [], number: value.number ?? 0,
      }).pipe(Effect.orDie)
      const store = yield* TodosStore
      return outcome((yield* store.queue(op)).kept)
    }
    const steer = { id, runId: value.runId as string, body: value.body as string }
    return outcome((yield* (yield* RunSteers).queue(steer)).kept)
  })

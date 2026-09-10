/** Private recipe composition over the Plue-owned adapter installed in a guest.
 * No credential, JJ implementation, process runtime, or receipt ledger lives here.
 */
import { Action } from "@smthrs/flow"
import * as Digest from "@smthrs/core/Digest"
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const ChangeId = Schema.String.check(Schema.isPattern(/^[k-z]{32}$/))
const CommitId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const OperationId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/))
const RequestId = Schema.String.check(Schema.isPattern(/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const revisionFields = {
  changeId: ChangeId, commitId: CommitId, operationId: OperationId,
  parentCommitIds: Schema.Array(CommitId),
  description: Schema.optionalKey(Schema.String), empty: Schema.optionalKey(Schema.Boolean)
}
export const Resolved = Schema.Struct({ ...revisionFields, kind: Schema.Literal("resolved"), treeId: CommitId })
export const Conflicted = Schema.Struct({
  ...revisionFields, kind: Schema.Literal("conflicted"),
  treeTerms: Schema.Array(Schema.Struct({ treeId: CommitId, positive: Schema.Boolean }))
})
export const NativeRevision = Schema.Union([Resolved, Conflicted])
export type NativeRevision = typeof NativeRevision.Type
const expected = {
  requestId: RequestId, expectedOperationId: OperationId,
  target: Schema.Struct({ ...revisionFields, kind: Schema.optionalKey(Schema.Literal("resolved")), treeId: CommitId })
}
const Expected = Schema.Struct(expected.target.fields)
export const Operation = Schema.Union([
  Schema.Struct({ ...expected, operation: Schema.Literal("create"), description: Schema.String }),
  Schema.Struct({ ...expected, operation: Schema.Literal("describe"), description: Schema.String }),
  Schema.Struct({ ...expected, operation: Schema.Literal("snapshot") }),
  Schema.Struct({ ...expected, operation: Schema.Literal("edit") }),
  Schema.Struct({ ...expected, operation: Schema.Literal("amend"), source: Expected }),
  Schema.Struct({ ...expected, operation: Schema.Literal("reorder"), after: Expected })
])
export type Operation = typeof Operation.Type
export const ReadResult = Schema.Struct({
  status: Schema.Literal("read"), operationId: OperationId, head: NativeRevision,
  revisions: Schema.Array(NativeRevision),
  history: Schema.optionalKey(Schema.Array(NativeRevision)),
  historyComplete: Schema.optionalKey(Schema.Boolean)
})
const sourceIdentity = Schema.Struct({ changeId: ChangeId, commitId: CommitId, treeId: CommitId, parentCommitIds: Schema.Array(CommitId) })
export const SourcePublication = Schema.Struct({
  status: Schema.Literal("retained"), requestId: RequestId, workspaceId: RequestId,
  repositoryId: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ref: Schema.String, source: sourceIdentity
})
export type SourcePublication = typeof SourcePublication.Type
export const PublishSource = Schema.Struct({ requestId: RequestId, source: Resolved })
export const OperationResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("accepted"), replayed: Schema.optionalKey(Schema.Boolean),
    operationId: OperationId, parentOperationId: OperationId, timestamp: Schema.String,
    head: NativeRevision, revision: NativeRevision, revisions: Schema.Array(NativeRevision),
    // The local native receipt is durable. Its asynchronous cloud projection
    // is acknowledged only by the head reporter, not by this guest process.
    provenance: Schema.Literal("pending")
  }),
  Schema.Struct({ status: Schema.Literal("unchanged"), operationId: OperationId, revision: NativeRevision })
])
export type OperationResult = typeof OperationResult.Type
export class NativeCodingError extends Schema.TaggedError<NativeCodingError>()("coding/NativeCodingError", {
  code: Schema.String, message: Schema.String
}) {}

/** An invocation identity, never an atomic change identity. Use a durable flow
 * execution ID and stable action key; retry the ORIGINAL operation payload.
 */
export const requestIdFor = (executionId: string, actionKey: string): string => {
  const hash = Digest.digest(JSON.stringify(["coding/native/v1", executionId, actionKey]))
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export class NativeCoding extends Context.Service<NativeCoding, {
  readonly sourcePublication: "cloud" | "local-only"
  readonly read: (changeIds?: ReadonlyArray<string>, historyLimit?: number) => Effect.Effect<typeof ReadResult.Type, NativeCodingError>
  readonly apply: (operation: Operation) => Effect.Effect<OperationResult, NativeCodingError>
  readonly publishOriginalSource: (request: typeof PublishSource.Type) => Effect.Effect<SourcePublication, NativeCodingError>
}>()("coding/NativeCoding") {}

export interface NativeOptions {
  /** Must exactly match the path bound by Plue provisioning. */
  readonly repositoryPath: string
  /** Host-selected executable location; never part of a flow input. */
  readonly adapterPath?: string
  readonly python?: string
  /** Explicit development capability. Local requests may run but cannot
   * produce cloud retention or become eligible for Vibe publication. */
  readonly sourcePublication?: "cloud" | "local-only"
}

const failure = (code: string, message: string) => new NativeCodingError({ code, message })
const capture = <E>(stream: Stream.Stream<Uint8Array, E>, limit: number) =>
  Stream.runFoldEffect(stream, () => ({ text: "", bytes: 0, decoder: new TextDecoder() }), (state, chunk) => {
    const bytes = state.bytes + chunk.length
    if (bytes > limit) return Effect.fail(failure("response_too_large", "Native coding output exceeded its bounded response size; inspect the existing native receipt before replanning"))
    return Effect.succeed({ ...state, bytes, text: state.text + state.decoder.decode(chunk, { stream: true }) })
  }).pipe(Effect.map(state => state.text + state.decoder.decode()))

/** Effect's injected spawner owns acquisition, cancellation and process cleanup
 * on both Node and Bun. The guest Python program owns native JJ and identity.
 */
export const nativeLayer = (options: NativeOptions) => Layer.effect(NativeCoding)(Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const invoke = (request: object) => Effect.gen(function*() {
    const input = JSON.stringify({ ...request, repositoryPath: options.repositoryPath })
    if (new TextEncoder().encode(input).length > 64 * 1024) return yield* failure("invalid_request", "Native coding request exceeds 64 KiB")
    const process = yield* spawner.spawn(ChildProcess.make(options.python ?? "python3", [
      options.adapterPath ?? "/usr/local/lib/smithers/workspace-coding.py", "--local"
    ], { stdin: Stream.make(new TextEncoder().encode(input)), cwd: options.repositoryPath }))
    const [stdout, , exitCode] = yield* Effect.all([
      capture(process.stdout, 16 * 1024 * 1024), capture(process.stderr, 64 * 1024), process.exitCode
    ], { concurrency: "unbounded" })
    const result = yield* Effect.try({ try: () => JSON.parse(stdout) as unknown, catch: () => failure("outcome_unknown", "Native adapter returned no valid receipt; retry the identical operation") })
    if (result !== null && typeof result === "object" && "error" in result) {
      const error = yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.String, message: Schema.String }))(result.error)
        .pipe(Effect.mapError(() => failure("outcome_unknown", "Native adapter returned an invalid error envelope")))
      return yield* failure(error.code, error.message)
    }
    if (exitCode !== 0) return yield* failure("outcome_unknown", "Native adapter exited without an accepted receipt; retry the identical operation")
    return result
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: "4 minutes", orElse: () => Effect.fail(failure("outcome_unknown", "Native coding timed out; retry the identical operation to recover its native receipt")) }),
    Effect.catchCause(cause => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      const reason = Cause.squash(cause)
      return reason instanceof NativeCodingError
        ? Effect.fail(reason)
        : Effect.fail(failure("outcome_unknown", "Native coding process interrupted; retry the identical operation to recover its native receipt"))
    })
  )
  return {
    sourcePublication: options.sourcePublication ?? "cloud",
    read: (changeIds: ReadonlyArray<string> = [], historyLimit?: number) => invoke({
      operation: "read", changeIds, ...(historyLimit === undefined ? {} : { historyLimit })
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ReadResult)),
      Effect.mapError(error => error instanceof NativeCodingError ? error : failure("invalid_receipt", "Native read returned an invalid revision"))
    ),
    publishOriginalSource: (request: typeof PublishSource.Type) => Effect.gen(function*() {
      if (options.sourcePublication === "local-only") return yield* failure("source_publication_unavailable", "This host has explicit local-only native capability; it cannot acknowledge cloud retention")
      const input = yield* Schema.decodeUnknownEffect(PublishSource)(request).pipe(
        Effect.mapError(() => failure("invalid_request", "Publication requires an exact resolved native source")))
      const result = yield* invoke({ operation: "publish_source", ...input }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SourcePublication)),
        Effect.mapError(error => error instanceof NativeCodingError ? error : failure("source_publication_invalid_ack", "Cloud source publication returned an incomplete acknowledgement")))
      if (result.requestId !== input.requestId || result.source.changeId !== input.source.changeId ||
          result.source.commitId !== input.source.commitId || result.source.treeId !== input.source.treeId ||
          result.source.parentCommitIds.length !== input.source.parentCommitIds.length ||
          result.source.parentCommitIds.some((id, index) => id !== input.source.parentCommitIds[index]) ||
          result.ref !== `refs/smithers/workspaces/${result.workspaceId}/sources/${input.source.commitId}`) {
        return yield* failure("source_publication_invalid_ack", "Cloud acknowledgement did not match the exact native source")
      }
      return result
    }),
    apply: (operation: Operation) => Schema.decodeUnknownEffect(Operation)(operation).pipe(
      Effect.mapError(() => failure("invalid_request", "Native operation requires exact resolved JJ revision identities")),
      Effect.flatMap(invoke),
      Effect.map(result => result !== null && typeof result === "object" && "status" in result && result.status === "accepted"
        ? { ...result, provenance: "pending" } : result),
      Effect.flatMap(Schema.decodeUnknownEffect(OperationResult)),
      Effect.mapError(error => error instanceof NativeCodingError ? error : failure("invalid_receipt", "Native operation returned an invalid receipt"))
    )
  }
}))

export const ReadNative = Action.make("coding/ReadNative", {
  payload: { changeIds: Schema.Array(ChangeId) }, success: ReadResult, error: NativeCodingError, nondeterministic: true
})
export const ApplyNative = Action.make("coding/ApplyNative", {
  payload: { operation: Operation }, success: OperationResult, error: NativeCodingError, nondeterministic: true
})
const transient = (error: NativeCodingError) =>
  error.code === "outcome_unknown" || error.code === "workspace_busy" || error.code === "guest_failure"

/** Reads use the same guest lock; retry transient admission/transport failures. */
export const readNative = (changeIds: ReadonlyArray<string> = []) =>
  Effect.flatMap(NativeCoding, native => native.read(changeIds)).pipe(Action.retry({ times: 2, while: transient }))

/** Merge into the existing runtime's action table; never create another one. */
export const nativeActions = Layer.mergeAll(
  ReadNative.toLayer(({ changeIds }) => readNative(changeIds)),
  ApplyNative.toLayer(({ operation }) => Effect.flatMap(NativeCoding, native => native.apply(operation)).pipe(
    // Retry inside the durable action before its terminal result is recorded.
    // Never refresh the request: native receipts recover an accepted mutation
    // whose response was lost. Conflicting revisions still require replanning.
    Action.retry({ times: 2, while: transient })
  ))
)

/** Private native receipt contracts shared by the Effect adapter and browser projections. */
import { Schema } from "effect"

export const ChangeId = Schema.String.check(Schema.isPattern(/^[k-z]{32}$/))
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

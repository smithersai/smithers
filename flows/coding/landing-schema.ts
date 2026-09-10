/** Private receipt projections of Plue's existing landing service. Browser safe. */
import { Schema } from "effect"
import { ChangeId, Resolved, SourcePublication } from "./native-schema.ts"

const CommitId = Resolved.fields.commitId
const PositiveId = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const AppendPreparationInput = Schema.Struct({ target_bookmark: Schema.Literal("main"),
  expected_commit_id: CommitId, source_commit_id: CommitId, source_base_commit_id: CommitId })
export type AppendPreparationInput = typeof AppendPreparationInput.Type
export const AppendPreparation = Schema.Struct({ ...AppendPreparationInput.fields, status: Schema.Literal("prepared"),
  changes: Schema.Array(Schema.Struct({ change_id: ChangeId, commit_id: CommitId })).check(Schema.isMinLength(1), Schema.isMaxLength(1024)) })
export type AppendPreparation = typeof AppendPreparation.Type
export const LandingIdentity = Schema.Struct({ requestId: SourcePublication.fields.requestId, number: PositiveId })
export type LandingIdentity = typeof LandingIdentity.Type
export const AppendRequest = Schema.Struct({ commit_id: CommitId, expected_commit_id: CommitId,
  source_base_commit_id: CommitId, description: Schema.NonEmptyString.check(Schema.isMaxLength(32_768)) })
export type AppendRequest = typeof AppendRequest.Type
export const QueuedAppend = Schema.Struct({ ...LandingIdentity.fields, taskId: PositiveId,
  preparation: AppendPreparation, request: AppendRequest })
export type QueuedAppend = typeof QueuedAppend.Type
const NativeAppendRequest = Schema.Struct({ change_ids: Schema.Array(ChangeId).check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  target_bookmark: Schema.Literal("main"), expected_commit_id: CommitId,
  operation_key: Schema.NonEmptyString.check(Schema.isMaxLength(1024)), lookup_only: Schema.optionalKey(Schema.Literal(false)),
  append: Schema.Struct({ source_commit_id: CommitId, source_base_commit_id: CommitId,
    description: AppendRequest.fields.description }) })
export const AppendObservation = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "running", "failed"]), task_id: PositiveId,
    request: NativeAppendRequest, result: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ status: Schema.Literal("landed"), task_id: PositiveId, request: NativeAppendRequest,
    result: Schema.Struct({ landed_count: PositiveId, target_bookmark: Schema.Literal("main"), target_commit_id: CommitId }) })
])
export type AppendObservation = typeof AppendObservation.Type

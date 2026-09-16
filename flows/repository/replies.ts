/** Automatic native replies use the dispatch-bound idempotent repository API. */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Option, Schema } from "effect"
import { CodingError } from "../coding/schema.ts"
import { JobInput, JobResult } from "./schema.ts"
import { RepositoryRemote } from "./remote.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const object = (value: Schema.Json): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const CommentReceipt = Schema.Struct({ registration_id: Schema.String, revision: Schema.Int, digest: Schema.String,
  delivery_key: Schema.String, step: Schema.String, source: Schema.Literal("smithers-cloud"), issue_number: Schema.Int,
  comment_id: Schema.Number, api_path: Schema.String })
const Publish = Action.make("repository/publish-reply", { payload: { input: JobInput, result: JobResult }, success: JobResult, error: CodingError, nondeterministic: true })
export const PublishReply = Flow.make("repository/PublishReply", { payload: Publish.payloadSchema, success: JobResult, error: CodingError, body: input => Publish.call(input) })
export const replyLayers = Layer.mergeAll(Interpreter.layer(PublishReply), Publish.toLayer(({ input, result }) => Effect.gen(function*() {
  if (input.event.trial === true || input.configuration.replies === "draft" || !input.event.issueNumber || result.status === "skipped") return result
  if (input.job !== "issues" || input.event.source !== "smithers-cloud") return yield* invalid("Automatic replies are supported only for native issue handling; retain this reply as a draft")
  const remote = yield* Effect.serviceOption(RepositoryRemote)
  if (Option.isNone(remote) || !remote.value.comment || remote.value.repo !== input.repo) return yield* invalid("The repository has no idempotent reply adapter")
  const body = result.results.filter(step => step.status === "completed" || step.status === "needs-author")
    .map(step => `${input.configuration.steps.find(value => value.id === step.stepId)?.name ?? step.stepId}\n${step.summary}${step.status === "needs-author" &&
      typeof object(step.output).question === "string" ? `\n${object(step.output).question}` : ""}`).join("\n\n").slice(0, 16000)
  if (!body.trim()) return result
  const step = "response", receipt = yield* remote.value.comment(input.job, step, {
    repo: input.repo, workspace_id: remote.value.workspaceId, revision: input.revision, digest: input.digest,
    delivery_key: input.event.deliveryKey, source: "smithers-cloud", issue_number: input.event.issueNumber, body
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CommentReceipt)))
  if (receipt.revision !== input.revision || receipt.digest !== input.digest || receipt.delivery_key !== input.event.deliveryKey ||
      receipt.step !== step || receipt.issue_number !== input.event.issueNumber) return yield* invalid("The public reply receipt belongs to another dispatch")
  return { ...result, publicActions: [...result.publicActions, JSON.parse(JSON.stringify(receipt))] }
}).pipe(Effect.mapError(error => error instanceof CodingError ? error : invalid("The public reply could not be verified; retry the same dispatch")))))

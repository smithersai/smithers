import { Data, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { WAITLIST_JOIN_ROUTE, type WaitlistJoinResponse } from "./contract.ts"

const WaitlistJoinResponseSchema = Schema.Struct({
  status: Schema.Literal("submitted"),
  repoUrl: Schema.String,
  position: Schema.Number,
})

const WaitlistErrorBody = Schema.Struct({
  error: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
})

const decodeSuccess = Schema.decodeUnknownEffect(WaitlistJoinResponseSchema)
const decodeError = Schema.decodeUnknownEffect(WaitlistErrorBody)

export class WaitlistJoinFailed extends Data.TaggedError("WaitlistJoinFailed")<{
  readonly status?: number
  readonly code: string
}> {}

export const waitlistErrorMessage = (error: WaitlistJoinFailed): string => {
  if (error.code === "invalid_repo_url" || error.code === "invalid_json" || error.code === "invalid_payload") {
    return "Enter a valid HTTPS repository URL."
  }
  if (error.code === "person_only") return "Sign in directly to request repository hosting."
  if (error.code === "rate_limited") return "Too many requests. Wait a minute and try again."
  if (error.code === "too_large") return "Request is too large."
  return "Waitlist is unavailable right now. Try again shortly."
}

/** Submit a repository hosting waitlist request through ChatApi via Effect HttpClient. */
export const submitWaitlist = (input: {
  readonly origin?: string
  readonly repoUrl: string
  readonly workflowNote?: string
}): Effect.Effect<WaitlistJoinResponse, WaitlistJoinFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const url = input.origin === undefined ? WAITLIST_JOIN_ROUTE : `${input.origin}${WAITLIST_JOIN_ROUTE}`
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({
        repoUrl: input.repoUrl,
        ...(input.workflowNote !== undefined && input.workflowNote.trim().length > 0
          ? { workflowNote: input.workflowNote.trim() }
          : {}),
      }),
      Effect.mapError(() => new WaitlistJoinFailed({ code: "invalid_payload" })),
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(() => new WaitlistJoinFailed({ code: "unavailable" })),
    )
    if (response.status !== 200) {
      const parsed = yield* response.json.pipe(Effect.flatMap(decodeError), Effect.option)
      const code = Option.match(parsed, {
        onNone: () => (response.status === 429 ? "rate_limited" : response.status === 413 ? "too_large" : "unavailable"),
        onSome: (body) => body.error ?? body.code ?? "unavailable",
      })
      return yield* new WaitlistJoinFailed({ status: response.status, code })
    }
    return yield* response.json.pipe(
      Effect.flatMap(decodeSuccess),
      Effect.mapError(() => new WaitlistJoinFailed({ status: 200, code: "invalid_response" })),
    )
  })

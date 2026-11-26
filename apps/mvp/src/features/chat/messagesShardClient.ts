import { type ShardClient, ShardProtocol } from "@smthrs/sync"
import { Data, type Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { CONFIRM_401_HEADER, sessionCheckOf } from "../auth/contract"

// A conversation's messages shard as the browser reaches it (decision 0170, slice 4): protocol v2's Submit, Pull and
// Snapshot over ChatApi's `/api/conversations/:id/messages/{submit,pull,snapshot}` (worker/chat/MessagesShardRoutes.ts).
// This is only the transport. `ShardClient` owns the outbox, the cursor and every protocol check
// (src/features/chat/messagesShard.ts).

/** ChatApi names why the shard refused a write here (worker/chat/MessagesShardRoutes.ts `refusalHeader`). */
export const MESSAGES_REFUSAL_HEADER = "x-smithers-messages-refusal"

/** The shard of conversation `conversationId`. A UUID has equivalent case spellings; the shard has one. */
export const shardOf = (conversationId: string): ShardProtocol.ShardId =>
  Schema.decodeUnknownSync(ShardProtocol.ShardId)("conv:" + conversationId.toLowerCase())

/** What every person's owner name starts with. A run's starts with its act's kind (worker/chat/MessagesShardRoutes.ts `ownerOf`). */
export const PERSON_OWNER_PREFIX = "person:"

/** The owner name ChatApi admits person `id` under: their messages' author and the prefix of their nodes. */
export const personOwner = (id: string): string => PERSON_OWNER_PREFIX + encodeURIComponent(id)

/** The node a person's `device` submits from. The shard refuses a node whose prefix is another owner's. */
export const nodeOf = (owner: string, device: string): string => `${owner}/${device}`

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Where ChatApi serves conversation `conversationId`'s shard on `origin`, or nothing when no request may be built from
 * them: the id must be a UUID, so it adds one path segment and no delimiter, and `origin` must be an `http:` or
 * `https:` URL, of which only the origin is kept (never a path, a query or credentials).
 */
export const messagesRoute = (origin: string, conversationId: string): string | undefined => {
  if (!CONVERSATION_ID.test(conversationId) || !URL.canParse(origin)) return undefined
  const base = new URL(origin)
  return base.protocol === "http:" || base.protocol === "https:"
    ? `${base.origin}/api/conversations/${conversationId.toLowerCase()}/messages`
    : undefined
}

/**
 * The shard gave no protocol answer:
 * - `unreachable`: no whole answer within the deadline, its body included, for example offline;
 * - `refused`: a status other than 200, with ChatApi's `refusal` when it names one (`origin`, `author`, `person_only`,
 *   `wrong_shard`);
 * - `invalid_response`: 200 with a body outside protocol v2, or entries the reducer cannot fold;
 * - `invalid_target`: the conversation id is not a UUID or the origin is not an HTTP origin, so nothing was sent.
 */
export class MessagesShardUnavailable extends Data.TaggedError("MessagesShardUnavailable")<{
  readonly request: "submit" | "pull" | "snapshot"
  readonly reason: "unreachable" | "refused" | "invalid_response" | "invalid_target"
  readonly status?: number
  readonly refusal?: string
  readonly sessionCheck?: "same_person"
}> {}

/**
 * Whether sending the request again can succeed with nothing else changed: no answer, an answer outside the contract,
 * a `401` the page's transport found was the same person's session, or a status that is not the request's own fault.
 * `400`, `401`, `403`, `404` and `413` are final: ChatApi decided against this person or this body. So is a target
 * no request may be built from.
 */
export const isTransient = (error: MessagesShardUnavailable): boolean =>
  error.reason !== "invalid_target" && (
    error.reason !== "refused" ||
    (error.status === 401 && error.sessionCheck === "same_person") ||
    ![400, 401, 403, 404, 413].includes(error.status!)
  )

export interface TransportOptions {
  /** ChatApi's origin, as the browser reaches it. */
  readonly origin: string
  readonly conversationId: string
  /** One deadline for each whole request: sending it, the status and reading the body. */
  readonly within: Duration.Input
}

/**
 * The HTTP `ShardClient.Transport` of one conversation's shard. Every request is the person's own signed-in request,
 * and every answer is decoded with protocol v2's schema before `ShardClient` reads it.
 */
export const make = Effect.fnUntraced(function* (options: TransportOptions) {
  const client = yield* HttpClient.HttpClient
  const route = messagesRoute(options.origin, options.conversationId)
  const ask = <A>(
    request: MessagesShardUnavailable["request"],
    send: (route: string) => HttpClientRequest.HttpClientRequest,
    decode: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>,
  ): Effect.Effect<A, MessagesShardUnavailable> =>
    Effect.gen(function* () {
      // No route, no request: an id or an origin that is not what it must be is never put into a signed-in URL.
      if (route === undefined) return yield* new MessagesShardUnavailable({ request, reason: "invalid_target" })
      const response = yield* client.execute(send(route)).pipe(
        Effect.mapError(() => new MessagesShardUnavailable({ request, reason: "unreachable" })),
      )
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
      if (response.status !== 200) {
        const refusal = response.headers[MESSAGES_REFUSAL_HEADER]
        return yield* new MessagesShardUnavailable({
          request,
          reason: "refused",
          status: response.status,
          ...(refusal === undefined ? {} : { refusal }),
          ...sessionCheckOf(response.headers),
        })
      }
      return yield* decode(response).pipe(
        Effect.mapError(() => new MessagesShardUnavailable({ request, reason: "invalid_response", status: 200 })),
      )
    }).pipe(
      // Interrupting the request, at any step, aborts its fetch (Effect HttpClient), so a stalled body stops too.
      Effect.timeoutOrElse({
        duration: options.within,
        orElse: () => Effect.fail(new MessagesShardUnavailable({ request, reason: "unreachable" })),
      }),
      Effect.withSpan(`chat.messages.${request}`),
    )
  const transport: ShardClient.Transport<MessagesShardUnavailable> = {
    submit: (request) =>
      ask(
        "submit",
        (route) =>
          HttpClientRequest.post(`${route}/submit`).pipe(
            HttpClientRequest.bodyJsonUnsafe(request),
            HttpClientRequest.setHeader(CONFIRM_401_HEADER, "1"),
          ),
        HttpClientResponse.schemaBodyJson(ShardProtocol.SubmitResponse),
      ),
    pull: (request) =>
      ask(
        "pull",
        (route) => HttpClientRequest.get(`${route}/pull?${ShardProtocol.pullQuery(request)}`),
        HttpClientResponse.schemaBodyJson(ShardProtocol.PullResponse),
      ),
    snapshot: (shard) =>
      ask(
        "snapshot",
        (route) => HttpClientRequest.get(`${route}/snapshot?${new URLSearchParams({ shard })}`),
        HttpClientResponse.schemaBodyJson(ShardProtocol.SnapshotResponse),
      ),
  }
  return transport
})

import { type ShardClient, ShardProtocol } from "@smthrs/sync"
import { Data, type Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { CONFIRM_401_HEADER, sessionCheckOf } from "../auth/contract"

// A conversation's messages shard as the browser reaches it (decision 0170, slice 4): protocol v2's Submit, Pull and
// Snapshot over ChatApi's `/api/conversations/:id/messages/{submit,pull,snapshot}` (worker/chat/MessagesShardRoutes.ts),
// and `writer`, which tells a page the name it writes under in that one conversation. This is only the transport.
// `ShardClient` owns the outbox, the cursor and every protocol check (src/features/chat/messagesShard.ts).

/** ChatApi names why the shard refused a write here (worker/chat/MessagesShardRoutes.ts `refusalHeader`). */
export const MESSAGES_REFUSAL_HEADER = "x-smithers-messages-refusal"

/** The shard of conversation `conversationId`. A UUID has equivalent case spellings; the shard has one. */
export const shardOf = (conversationId: string): ShardProtocol.ShardId =>
  Schema.decodeUnknownSync(ShardProtocol.ShardId)("conv:" + conversationId.toLowerCase())

/**
 * What every person's owner name starts with. A run's starts with its act's kind. What follows names nobody: ChatApi
 * admits a writer under a digest of who they are in the one conversation, keyed with a secret only it holds
 * (worker/chat/MessagesShardRoutes.ts `ownerOf`), so a page cannot build an owner name, its own included: it asks
 * ChatApi for its own, conversation by conversation (`writer`).
 */
export const PERSON_OWNER_PREFIX = "person:"

/**
 * The node `owner`'s `device` submits from. The shard refuses a node whose prefix is another owner's. ChatApi journals
 * neither the device nor a command id as a page sends it: each is replaced by a digest under the one conversation
 * (worker/chat/MessagesShardRoutes.ts `scopedKey`), and the page is answered under the key it sent.
 */
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
 * The `401`s ChatApi answers a page's reads of its conversations' shards with, told as each arrives: before whatever
 * the page's transport does with a `401` (it reads the session again, `src/device/identity.ts` `boundFetch`), which
 * may never answer. A page makes one and puts `observing` under that transport, around the browser's own `fetch`
 * (src/main.tsx).
 */
export interface ReadDenials {
  /**
   * `next`, with each `401` that answers a Pull or a Snapshot told to the conversation's watchers in the task the
   * answer arrives in, before it is returned. The answer is returned as it came.
   */
  readonly observing: (next: typeof globalThis.fetch) => typeof globalThis.fetch
  /** Calls `listener` for each such `401` of conversation `conversationId`, until the function it returns is called. */
  readonly watch: (conversationId: string, listener: () => void) => () => void
}

const READ = /^\/api\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/messages\/(?:pull|snapshot)$/i

export const readDenials = (): ReadDenials => {
  const watchers = new Map<string, Set<() => void>>()
  return {
    observing: (next) => async (input, init) => {
      const response = await next(input, init)
      if (response.status === 401) {
        const read = READ.exec(new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname)
        if (read !== null) for (const told of [...(watchers.get(read[1]!.toLowerCase()) ?? [])]) told()
      }
      return response
    },
    watch: (conversationId, listener) => {
      const id = conversationId.toLowerCase()
      // Its own entry, so one listener watching twice is told twice and stops each on its own.
      const told = () => listener()
      const held = watchers.get(id) ?? new Set()
      watchers.set(id, held.add(told))
      return () => void held.delete(told)
    },
  }
}

/**
 * The shard gave no protocol answer:
 * - `unreachable`: no whole answer within the deadline, its body included, for example offline;
 * - `refused`: a status other than 200, or a read's `401` the page saw arrive (`ReadDenials`) though its transport
 *   then gave no answer within the deadline or failed, with ChatApi's `refusal` when it names one (`origin`, `author`, `person_only`,
 *   `wrong_shard`, `question` for a body update to the person's own question, or `reserved` for a post under a
 *   message id ChatApi itself stored);
 * - `invalid_response`: 200 with a body outside protocol v2, or entries the reducer cannot fold;
 * - `invalid_target`: the conversation id is not a UUID or the origin is not an HTTP origin, so nothing was sent.
 */
export class MessagesShardUnavailable extends Data.TaggedError("MessagesShardUnavailable")<{
  readonly request: "submit" | "pull" | "snapshot" | "writer"
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
  /**
   * The read `401`s the page sees arrive. With it, a read ChatApi answered `401` is `refused` with that status even
   * when the page's transport, checking the session after it, never returns the answer: what ChatApi said of the read
   * is kept through the check and through the deadline.
   */
  readonly denials?: ReadDenials
}

/** One request to conversation `options.conversationId`'s shard routes, whole within `options.within`. */
const asking = Effect.fnUntraced(function* (options: TransportOptions) {
  const client = yield* HttpClient.HttpClient
  const route = messagesRoute(options.origin, options.conversationId)
  return <A>(
    request: MessagesShardUnavailable["request"],
    send: (route: string) => HttpClientRequest.HttpClientRequest,
    decode: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>,
  ): Effect.Effect<A, MessagesShardUnavailable> =>
    Effect.suspend(() => {
      // ChatApi's `401` to this conversation's read, seen while this request is out: its answer, whatever the page's
      // transport then does with it.
      let denied = false
      const stop = options.denials?.watch(options.conversationId, () => {
        denied = true
      })
      const unanswered = () =>
        new MessagesShardUnavailable(denied ? { request, reason: "refused", status: 401 } : { request, reason: "unreachable" })
      return Effect.gen(function* () {
        // No route, no request: an id or an origin that is not what it must be is never put into a signed-in URL.
        if (route === undefined) return yield* new MessagesShardUnavailable({ request, reason: "invalid_target" })
        const response = yield* client.execute(send(route)).pipe(Effect.mapError(unanswered))
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
        Effect.timeoutOrElse({ duration: options.within, orElse: () => Effect.fail(unanswered()) }),
        Effect.ensuring(Effect.sync(() => stop?.())),
        Effect.withSpan(`chat.messages.${request}`),
      )
    })
})

const Writer = Schema.Struct({ owner: Schema.String })

/**
 * The owner name the signed-in person writes under in conversation `options.conversationId`, as ChatApi tells it: the
 * author of what this page posts there and the prefix of the node it submits from. Another conversation is another
 * name, so it is asked once for each.
 */
export const writer = (options: TransportOptions): Effect.Effect<string, MessagesShardUnavailable, HttpClient.HttpClient> =>
  Effect.flatMap(asking(options), (ask) =>
    ask("writer", (route) => HttpClientRequest.get(`${route}/writer`), HttpClientResponse.schemaBodyJson(Writer))).pipe(
      Effect.map(({ owner }) => owner),
    )

/**
 * The HTTP `ShardClient.Transport` of one conversation's shard. Every request is the person's own signed-in request,
 * and every answer is decoded with protocol v2's schema before `ShardClient` reads it.
 */
export const make = Effect.fnUntraced(function* (options: TransportOptions) {
  const ask = yield* asking(options)
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

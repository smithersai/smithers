/**
 * The Telegram `getUpdates` long-poll source: how a bot receives messages
 * without a public webhook URL.
 *
 * Bot API semantics: the offset is the last `update_id` plus one, the server
 * holds the request open for `timeout` seconds, and confirming an offset is
 * what tells Telegram to forget those updates. {@link make} returns a core
 * `Source.Source`, so `run` is `Core.Source.runWithCursor`: the offset is
 * committed to `Core.CursorStore` only after the batch was handled. A process
 * that dies mid-batch polls the batch again, and each event's dedupe key drops
 * the redelivery downstream.
 *
 * Only `message` and `edited_message` updates are read. A message in a forum
 * topic or reply thread emits two events, chat-scoped and thread-scoped, with
 * distinct dedupe keys, so both a chat listener and a thread listener wake.
 *
 * Each poll is one request, never repeated here. A failure says in
 * `details.retryable` whether another poll can clear it, and a rate limit
 * names the server's wait in `details.retryAfterMillis`; the flow engine makes
 * the retry decision.
 *
 * @since 1.0.0
 */

import { Clock, Duration, Effect, Option, Redacted } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { forCredentials, MAX_RETRY_AFTER_MS } from "../core/CredentialHttp.ts"
import type { ExternalEvent } from "../core/ExternalEvent.ts"
import { IntegrationError } from "../core/IntegrationError.ts"
import * as SignalName from "../core/SignalName.ts"
import * as CoreSource from "../core/Source.ts"
import * as Environment from "../Environment.ts"

/**
 * The service segment of every Telegram signal name, and the default source id.
 *
 * @category constants
 * @since 1.0.0
 */
export const SERVICE = "telegram"

/**
 * The signal name for a new message: `integration:telegram:message`.
 *
 * @category constants
 * @since 1.0.0
 */
export const MESSAGE_EVENT = SignalName.eventName(SERVICE, "message")

/**
 * The signal name for an edited message: `integration:telegram:edited_message`.
 *
 * @category constants
 * @since 1.0.0
 */
export const EDITED_MESSAGE_EVENT = SignalName.eventName(SERVICE, "edited_message")

/**
 * The public Bot API host.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_API_BASE_URL = "https://api.telegram.org"

/**
 * The environment variable {@link make} reads the bot token from when the
 * options name none.
 *
 * @category constants
 * @since 1.0.0
 */
export const TOKEN_ENV = "SMITHERS_TELEGRAM_BOT_TOKEN"

const ALLOWED_UPDATES = ["message", "edited_message"] as const
const DEFAULT_POLL_TIMEOUT_SECONDS = 25
const MAX_POLL_TIMEOUT_SECONDS = 50
const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(10)
// BotFather's shape: a numeric bot id, a colon, and a URL-safe secret. The
// token is a path segment, so anything else could change the request's path.
const TOKEN = /^\d{1,20}:[\w-]{1,200}$/u

/**
 * The correlation for a chat.
 *
 * @category constructors
 * @since 1.0.0
 */
export const chatCorrelationId = (chatId: number | string): string => `chat:${chatId}`

/**
 * The correlation for a forum-topic or reply thread.
 *
 * @category constructors
 * @since 1.0.0
 */
export const threadCorrelationId = (chatId: number | string, threadId: number | string): string =>
  `chat:${chatId}:thread:${threadId}`

type Json = ExternalEvent["payload"]
type JsonObject = { readonly [key: string]: Json }

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const chatIdOf = (message: JsonObject): number | string | null => {
  const chat = message["chat"]
  const id = isObject(chat) ? chat["id"] : undefined
  return typeof id === "number" || typeof id === "string" ? id : null
}

/**
 * Maps one `getUpdates` update onto events: none for an update that is not a
 * message or an edit or names no chat, one per chat message, two for a message
 * in a thread.
 *
 * Telegram numbers updates per bot, so two sources routinely see the same
 * `update_id`. The dedupe key carries the source id behind its length, so a
 * source id holding a colon cannot forge another source's key.
 *
 * @category constructors
 * @since 1.0.0
 */
export const updateToEvents = (
  source: string,
  update: JsonObject,
  receivedAtMs: number
): ReadonlyArray<ExternalEvent> => {
  const kind = ALLOWED_UPDATES.find((key) => isObject(update[key]))
  if (kind === undefined) return []
  const message = update[kind] as JsonObject
  const chatId = chatIdOf(message)
  if (chatId === null) return []
  const eventName = kind === "message" ? MESSAGE_EVENT : EDITED_MESSAGE_EVENT
  const key = `update:${source.length}:${source}:${String(update["update_id"])}`
  const event = (correlationId: string, dedupeKey: string): ExternalEvent => ({
    source,
    eventName,
    correlationId,
    payload: message,
    dedupeKey,
    receivedAtMs
  })
  const threadId = message["message_thread_id"]
  return typeof threadId === "number" || typeof threadId === "string"
    ? [event(chatCorrelationId(chatId), key), event(threadCorrelationId(chatId, threadId), `${key}:thread`)]
    : [event(chatCorrelationId(chatId), key)]
}

/**
 * What the source needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /**
   * The chats whose messages become events. Required and non-empty. A message
   * from any other chat is dropped, and so is an update whose chat cannot be
   * read; the offset still moves past both once the batch is handled.
   */
  readonly allowedChatIds: ReadonlyArray<number | string>
  /** The token from BotFather. Defaults to `SMITHERS_TELEGRAM_BOT_TOKEN` in `env`. */
  readonly botToken?: string | Redacted.Redacted<string> | undefined
  /** The source id, which is also the cursor key and the dedupe scope. Defaults to `telegram`. */
  readonly sourceId?: string | undefined
  /** How long the Bot API holds a poll open, in whole seconds from 0 to 50. Defaults to 25. */
  readonly pollTimeoutSeconds?: number | undefined
  /** The deadline for one request beyond the poll's own hold. Defaults to 10 seconds. */
  readonly requestTimeout?: Duration.Input | undefined
  /** An http: or https: origin to send to instead of the public host, for a fixture server. */
  readonly apiBaseUrl?: string | undefined
}

/**
 * A source bound to one bot: the core `Source.Source`. `poll` is one
 * `getUpdates` request against the stored offset and commits nothing; `run`
 * is `Core.Source.runWithCursor` over it. Run one driver per bot: Telegram
 * answers a second concurrent poll with 409.
 *
 * @category services
 * @since 1.0.0
 */
export type Source = CoreSource.Source

const invalid = (message: string, details: Record<string, unknown> = {}) =>
  Effect.fail(new IntegrationError("invalid-config", message, details))

const originOf = (raw: string): string | null => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const plain = url.username === "" && url.password === "" && url.search === "" && url.hash === ""
  return (url.protocol === "https:" || url.protocol === "http:") && plain ? raw.replace(/\/+$/u, "") : null
}

const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const retryAfterOf = (body: unknown): number | undefined => {
  const parameters = isObject(body) ? body["parameters"] : undefined
  const seconds = isObject(parameters) ? parameters["retry_after"] : undefined
  return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0
    ? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS)
    : undefined
}

/**
 * Builds a long-poll source over the `HttpClient` in context, usually
 * `FetchHttpClient.layer` from `effect/http`.
 *
 * `env` is where the bot token comes from when `options.botToken` is absent;
 * passing one replaces the ambient environment rather than layering over it.
 * Fails with `invalid-config` for an empty allowlist, a malformed source id,
 * poll timeout, request timeout or origin, and `credentials-missing` when no well-formed token
 * is found. No message or detail ever holds the token.
 *
 * @example
 * ```ts
 * import { Telegram } from "@smthrs/integrations"
 * import { FetchHttpClient } from "effect/http"
 * import { Effect } from "effect"
 *
 * const source = Telegram.Source.make({ allowedChatIds: [123456789] }).pipe(
 *   Effect.provide(FetchHttpClient.layer)
 * )
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  options: Options,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Effect.Effect<Source, IntegrationError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const sourceId = options.sourceId ?? SERVICE
    if (sourceId.length === 0 || sourceId.trim() !== sourceId) {
      return yield* invalid("Telegram source id must be a non-empty string with no surrounding whitespace.", {
        sourceId
      })
    }
    if (options.allowedChatIds.length === 0) {
      return yield* invalid("Telegram allowedChatIds must name at least one chat.", { sourceId })
    }
    const pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS
    if (
      !Number.isSafeInteger(pollTimeoutSeconds) || pollTimeoutSeconds < 0 ||
      pollTimeoutSeconds > MAX_POLL_TIMEOUT_SECONDS
    ) {
      return yield* invalid(
        `Telegram pollTimeoutSeconds must be a whole number from 0 to ${MAX_POLL_TIMEOUT_SECONDS}.`,
        { sourceId, pollTimeoutSeconds }
      )
    }
    const origin = originOf(options.apiBaseUrl ?? DEFAULT_API_BASE_URL)
    if (origin === null) {
      // The message names no URL: a misconfigured one may hold a credential.
      return yield* invalid("Telegram apiBaseUrl must be an http: or https: origin with no credentials or query.", {
        sourceId
      })
    }
    const configured = options.botToken ?? env[TOKEN_ENV]
    const token = Redacted.isRedacted(configured) ? Redacted.value(configured) : configured
    if (token === undefined || !TOKEN.test(token)) {
      return yield* Effect.fail(
        new IntegrationError(
          "credentials-missing",
          `No well-formed Telegram bot token. Pass options.botToken or set ${TOKEN_ENV}.`,
          { sourceId }
        )
      )
    }
    const extra = Option.getOrUndefined(Duration.fromInput(options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT))
    if (extra === undefined || !Duration.isFinite(extra) || Duration.toMillis(extra) <= 0) {
      return yield* invalid("Telegram requestTimeout must be a finite, positive duration.", { sourceId })
    }
    const deadline = Duration.millis(pollTimeoutSeconds * 1_000 + Duration.toMillis(extra))
    const allowedChats = new Set(options.allowedChatIds.map(String))
    const http = forCredentials(yield* HttpClient.HttpClient)
    const url = `${origin}/bot${token}/getUpdates`

    const failed = (summary: string, details: Record<string, unknown>) =>
      new IntegrationError("poll-failed", `Telegram source "${sourceId}" ${summary}`, { sourceId, ...details })
    const malformed = (summary: string, details: Record<string, unknown> = {}) =>
      Effect.fail(
        new IntegrationError("decode-failed", `Telegram source "${sourceId}" ${summary}`, { sourceId, ...details })
      )

    // One request. A read changes nothing on Telegram's side, so a lost answer
    // is safe to poll again, and every transport failure is retryable.
    const request = (body: Record<string, unknown>) =>
      http.execute(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body)).pipe(
        // The transport's span would record the URL, and the URL holds the token.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.flatMap((response) =>
          Effect.map(response.text, (text) => ({ status: response.status, body: parseBody(text) }))
        ),
        // The transport's error message names the URL, so only its name crosses.
        Effect.mapError((error) => failed(`could not reach the Bot API (${error.reason._tag}).`, { retryable: true })),
        Effect.timeoutOrElse({
          duration: deadline,
          orElse: () =>
            Effect.fail(
              failed(`timed out after ${Duration.toMillis(deadline)} ms.`, { retryable: true, timedOut: true })
            )
        })
      )

    const poll: Source["poll"] = (cursor) =>
      Effect.gen(function*() {
        const body: Record<string, unknown> = { timeout: pollTimeoutSeconds, allowed_updates: ALLOWED_UPDATES }
        if (cursor !== null) {
          // Only the canonical decimal this source writes. A dropped or
          // misread offset would replay Telegram's whole retained backlog.
          if (!/^\d{1,16}$/u.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
            return yield* invalid(
              `Telegram source "${sourceId}" has a stored cursor that is not an update offset.`,
              { sourceId }
            )
          }
          body["offset"] = Number(cursor)
        }
        const answer = yield* request(body)
        const description = isObject(answer.body) ? answer.body["description"] : undefined
        const bounded = typeof description === "string" ? { description: description.slice(0, 200) } : {}
        if (answer.status === 429) {
          const wait = retryAfterOf(answer.body)
          return yield* Effect.fail(
            failed("was rate limited by the Bot API.", {
              status: 429,
              retryable: true,
              ...(wait === undefined ? {} : { retryAfterMillis: wait }),
              ...bounded
            })
          )
        }
        if (answer.status < 200 || answer.status >= 300) {
          // A 5xx or 408 can clear. A 401 (revoked token), 409 (a second
          // driver or a webhook is set) or an unfollowed 3xx cannot.
          const retryable = answer.status >= 500 || answer.status === 408
          return yield* Effect.fail(
            failed(`got HTTP ${answer.status} from getUpdates.`, { status: answer.status, retryable, ...bounded })
          )
        }
        const result = isObject(answer.body) && answer.body["ok"] === true ? answer.body["result"] : undefined
        // A non-array result is a Bot API contract change, not an empty batch.
        if (!Array.isArray(result)) return yield* malformed("got a getUpdates answer with no update array.")
        const receivedAtMs = yield* Clock.currentTimeMillis
        const events: Array<ExternalEvent> = []
        let next: number | null = null
        for (const [index, update] of result.entries()) {
          const updateId = isObject(update) ? update["update_id"] : undefined
          if (!isObject(update) || typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) {
            return yield* malformed("got an update with no numeric update_id.", { index })
          }
          next = Math.max(next ?? 0, updateId + 1)
          // Fail closed: an update whose chat is not allowed, or cannot be read, is dropped.
          const message = ALLOWED_UPDATES.map((key) => update[key]).find(isObject)
          const chatId = message === undefined ? null : chatIdOf(message)
          if (chatId !== null && allowedChats.has(String(chatId))) {
            events.push(...updateToEvents(sourceId, update, receivedAtMs))
          }
        }
        // A proposed offset: `run` commits it only after the batch was handled.
        return next === null ? { events } : { events, cursor: String(next) }
      })

    return {
      sourceId,
      poll,
      run: (onBatch, runOptions) => CoreSource.runWithCursor(sourceId, poll, onBatch, runOptions)
    }
  })

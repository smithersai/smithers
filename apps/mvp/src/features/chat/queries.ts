import { type Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import type { Effect } from "effect"
import { COULDNT_ANSWER, MODEL_QUOTA_SPENT } from "./contract"
import type { View } from "../views/schema"
import type { Asking, Composer, Connection, History, Message, Place, Unsent } from "./schema"

// What every frontend reads. Each is a live query over this device's collections, built once per ChatStore; it starts
// on first read. React renders its `tanstack` collection with `useLiveQuery`; a TUI reads its `rows` stream. No query
// waits for the network: they read only what the device has.

/**
 * The whole conversation on this device: `messages ∪ views ∪ (unsent − messages) ∪ (asking − messages − unsent)`.
 * - Synced rows come first, in Postgres' order (`position`); a failed answer reads the failure copy. A view
 *   (src/features/views, role `view`) shares the messages' positions, so it sits where it was added, with its template
 *   and its id, by which the conversation reads the row itself.
 * - Then this device's own rows, in the order they were asked (`queuedAt`): questions the server refused or the outbox
 *   couldn't take (`unsent`; `sendAgain` when the outbox couldn't, so Retry applies rather than Edit), unless Postgres
 *   has that very question with the answer this device made for it, and questions the outbox holds that Postgres
 *   doesn't have yet (`queued`).
 *   A queued question never overlays a synced row: once Postgres has it, only the synced row shows.
 * - `createdAt` is a synced row's or a view's time, as Postgres prints it; this device's own rows are timed by `at`,
 *   when they were asked (src/features/chat/view.ts `timeOf`).
 */
export const conversationQuery = (
  messages: Collection.Collection<Message>,
  unsent: Collection.Collection<Unsent, string>,
  asking: Collection.Collection<Asking, string>,
  views: Collection.Collection<View>,
  // The branch conversation this is (decision 0013 §1): this device's own rows count only when asked in it. `undefined`
  // is the home conversation, whose rows name none.
  conversationId?: string,
) =>
  LiveQuery.make((q) =>
    q
      .unionAll(
        q.from({ synced: messages.tanstack }).select(({ synced }) => ({
          id: synced.id,
          questionId: Query.coalesce(synced.questionId, ""),
          role: synced.role,
          text: Query.caseWhen(Query.eq(synced.status, "failed"),
            Query.caseWhen(Query.eq(synced.failure, "quota"), MODEL_QUOTA_SPENT, COULDNT_ANSWER), synced.text),
          status: synced.status,
          sendAgain: false,
          local: 0,
          at: synced.position,
          createdAt: synced.createdAt,
          // A message's tokens as numbers, 0 while unknown: a nullable column here collapses the union's row type.
          inputTokens: Query.coalesce(synced.inputTokens, 0),
          outputTokens: Query.coalesce(synced.outputTokens, 0),
        })),
        q.from({ view: views.tanstack }).select(({ view }) => ({
          id: view.id,
          role: "view" as const,
          text: "",
          status: "done",
          sendAgain: false,
          local: 0,
          at: view.position,
          createdAt: view.createdAt,
          // What it shows is the view's own row, which the conversation reads by id (src/features/views): an object
          // column here collapses the union's row type.
          template: view.template,
        })),
        q
          .from({ refused: unsent.tanstack })
          // Postgres' answer to a question with this id. When it is the answer this device made for it, Postgres has
          // this very question, and its synced row shows instead: an unsent copy the device couldn't drop never shows
          // twice. A question whose id another message took has another answer, and stays.
          .leftJoin({ answer: messages.tanstack }, ({ refused, answer }) => Query.eq(refused.id, answer.questionId))
          .where(({ refused, answer }) =>
            Query.and(
              conversationId === undefined
                ? Query.isUndefined(refused.conversationId)
                : Query.eq(refused.conversationId, conversationId),
              Query.or(Query.isUndefined(answer?.id), Query.not(Query.eq(answer?.id, refused.answerId))),
            ),
          )
          .select(({ refused }) => ({
            id: refused.id,
            role: "user" as const,
            text: refused.text,
            status: "unsent",
            sendAgain: Query.eq(refused.reason, "not_admitted"),
            local: 1,
            at: refused.queuedAt,
            createdAt: "",
          })),
        q
          .from({ queued: asking.tanstack })
          .leftJoin({ inPostgres: messages.tanstack }, ({ queued, inPostgres }) => Query.eq(queued.id, inPostgres.id))
          .leftJoin({ inUnsent: unsent.tanstack }, ({ queued, inUnsent }) => Query.eq(queued.id, inUnsent.id))
          .where(({ queued, inPostgres, inUnsent }) =>
            Query.and(
              conversationId === undefined
                ? Query.isUndefined(queued.conversationId)
                : Query.eq(queued.conversationId, conversationId),
              Query.isUndefined(inPostgres?.id),
              Query.isUndefined(inUnsent?.id),
            ),
          )
          .select(({ queued }) => ({
            id: queued.id,
            role: "user" as const,
            text: queued.text,
            status: "queued",
            sendAgain: false,
            local: 1,
            at: queued.queuedAt,
            createdAt: "",
          })),
      )
      .orderBy(({ $selected }) => $selected.local)
      .orderBy(({ $selected }) => $selected.at),
  )

/** The conversation's live query. */
export type Conversation = Effect.Success<ReturnType<typeof conversationQuery>>

/** The most recent `limit` messages of the conversation, newest first: the window "Load earlier" widens. */
export const latestQuery = (conversation: Conversation, limit: number) =>
  LiveQuery.make((q) =>
    q
      .from({ message: conversation.tanstack })
      .orderBy(({ message }) => message.local, "desc")
      .orderBy(({ message }) => message.at, "desc")
      .limit(limit),
  )

/** The window's live query. */
export type Latest = Effect.Success<ReturnType<typeof latestQuery>>

/** The window, oldest first: what the conversation view shows. */
export const shownQuery = (latest: Latest) =>
  LiveQuery.make((q) =>
    q
      .from({ message: latest.tanstack })
      .orderBy(({ message }) => message.local)
      .orderBy(({ message }) => message.at),
  )

/** The questions queued on this device that Postgres doesn't have yet: the pill counts them. */
export const queuedQuery = (conversation: Conversation) =>
  LiveQuery.make((q) =>
    q.from({ message: conversation.tanstack }).where(({ message }) => Query.eq(message.status, "queued")),
  )

/** This tab's composer. */
export const composerQuery = (composer: Collection.Collection<Composer, string>) =>
  LiveQuery.make((q) => q.from({ composer: composer.tanstack }).findOne())

/** This tab's connection, as the pill shows it. */
export const connectionQuery = (connection: Collection.Collection<Connection, string>) =>
  LiveQuery.make((q) => q.from({ connection: connection.tanstack }).findOne())

/** This tab's view of the conversation: whether it has opened, and whether "Load earlier" applies. */
export const historyQuery = (history: Collection.Collection<History, string>) =>
  LiveQuery.make((q) => q.from({ history: history.tanstack }).findOne())

/** Which conversation this tab shows and asks in. */
export const placeQuery = (place: Collection.Collection<Place, string>) =>
  LiveQuery.make((q) => q.from({ place: place.tanstack }).findOne())

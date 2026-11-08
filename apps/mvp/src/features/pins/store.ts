import { PinPendingStore } from "../../device/registry"
import { postgresTime } from "../chat/view"
import { ElectricCollection } from "@smthrs/effect-electric"
import { Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { Effect, Stream } from "effect"
import type { Message } from "../chat/schema"
import type { Source } from "../repo/gate"
import { PINS_SHAPE_ROUTE } from "./contract"
import { Collapsed, Pending, Pin } from "./schema"

interface MessageText { readonly id: string; readonly role: string; readonly text: string; readonly status: string }
export interface PinMessage extends MessageText { readonly local: number }

/** Reads from the full conversation, so Load earlier's window never evicts the pin. */
export const pinnedQuery = <A extends MessageText, P extends string | number, M extends string | number>(
  pins: Collection.Collection<Pin, P>, messages: Pick<Collection.Collection<A, M>, "tanstack">, pending?: Source<Pending>, conversationId?: string,
) => LiveQuery.make(q => {
  const source = q.from({ pin: pins.tanstack }).innerJoin({ message: messages.tanstack }, ({ pin, message }) => Query.eq(pin.messageId, message.id))
  if (pending === undefined) return source.select(({ message }) => ({ id: message.id, role: message.role, text: message.text, status: message.status, local: 0 }))
  const visible = source.leftJoin({ intent: pending.tanstack }, ({ pin, intent }) => Query.eq(pin.messageId, intent.messageId))
    .where(({ intent }) => Query.or(Query.isUndefined(intent?.conversationId), Query.eq(intent?.awaitAdmission, false), Query.eq(intent?.failed, true),
      conversationId === undefined ? Query.eq(intent?.home, false) : Query.not(Query.eq(intent?.conversationId, conversationId))))
    .select(({ message }) => ({ id: message.id, role: message.role, text: message.text, status: message.status, local: 0 }))
  return q.unionAll(visible,
    q.from({ held: pending.tanstack })
      .where(({ held }) => Query.and(
        conversationId === undefined ? Query.eq(held.home, true) : Query.eq(held.conversationId, conversationId),
        Query.eq(held.awaitAdmission, true), Query.eq(held.failed, false), Query.not(Query.isNull(held.messageId)),
      ))
      .select(({ held }) => ({ id: Query.coalesce(held.messageId, ""), role: "user" as const, text: Query.coalesce(held.text, ""), status: "unsent" as const, local: 1 })),
  )
})

/** Personal home intents and branch intents whose conversation access is known. */
export const pendingQuery = (pending: Source<Pending>, shown: Source<Pending>) => LiveQuery.make(q => q
  .from({ row: pending.tanstack })
  .leftJoin({ permitted: shown.tanstack }, ({ row, permitted }) => Query.eq(Query.coalesce(row.conversationId, ""), permitted.conversationId))
  .where(({ row, permitted }) => Query.or(Query.eq(row.home, true), Query.not(Query.isUndefined(permitted?.conversationId))))
  .select(({ row }) => row))

/** One personal shape per tab, stored on the device with an explicit schema version. */
export const makePins = <M extends string | number>(origin: string, homeMessages: Collection.Collection<Message, M>) => Effect.gen(function* () {
  const pins = yield* ElectricCollection.make<Pin>({
    id: "message-pins", schema: Pin, getKey: r => r.conversationId, syncMode: "eager", persist: { schemaVersion: 1 },
    shape: { url: `${origin}${PINS_SHAPE_ROUTE}`, columnMapper: ElectricCollection.snakeCamelMapper() },
  })
  const pending = yield* Collection.persisted(PinPendingStore)
  const effective = yield* Collection.local<Pin, string>({ id: "effective-pins", schema: Pin, getKey: r => r.conversationId })
  const project = Effect.gen(function* () {
    const rows = yield* pins.toArray
    const acts = yield* pending.toArray
    const homeId = (yield* homeMessages.toArray)[0]?.conversationId
    const actual = (held: Pending) => held.home ? held.serverConversationId ?? homeId ?? "home" : held.conversationId
    for (const held of acts) {
      const synced = rows.find(r => r.conversationId === actual(held))
      if (synced !== undefined && (postgresTime(synced.changedAt) ?? 0) >= held.at) yield* pending.delete(held.conversationId)
    }
    const next = new Map(rows.map(r => [r.conversationId, r]))
    for (const held of yield* pending.toArray) if (!held.failed) next.set(actual(held), { ...held, conversationId: actual(held) })
    const old = yield* effective.toArray
    for (const before of old) if (!next.has(before.conversationId)) yield* effective.delete(before.conversationId)
    for (const row of next.values()) {
      const before = old.find(r => r.conversationId === row.conversationId)
      if (before === undefined) yield* effective.insert(row)
      else if (before.messageId !== row.messageId || before.changedAt !== row.changedAt) yield* effective.update(row.conversationId, draft => { Object.assign(draft, row) })
    }
  }).pipe(Effect.orDie)
  yield* Stream.merge(
    Stream.map(pins.changes({ initial: true }), () => undefined),
    Stream.merge(Stream.map(pending.changes({ initial: true }), () => undefined), Stream.map(homeMessages.changes({ initial: true }), () => undefined)),
  ).pipe(Stream.runForEach(() => project), Effect.forkScoped)
  const collapsed = yield* Collection.local({ id: "pin-collapsed", schema: Collapsed, getKey: r => r.id })
  const collapseState = yield* LiveQuery.make(q => q.from({ row: collapsed.tanstack }))
  return { pins, effective, pending, collapsed, collapseState }
})

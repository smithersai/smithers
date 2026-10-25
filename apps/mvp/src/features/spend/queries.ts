import { type Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import type { Session } from "../auth/schema"
import type { Effect } from "effect"
import type { AlertChannel, AlertDelivery, ChannelSave, LimitsSave, SandboxLimitsRow, Seen, SpendAlert } from "./schema"

// What frontends read about spend alerts (docs/features/spend-alerts.md): a live query over the synced alerts and this
// device's mark of what it has seen.

/** Hide retained Admin data immediately when the confirmed session no longer grants access. */
export const adminQuery = <A extends object>(rows: Collection.Collection<A>, session: Collection.Collection<Session, string>, fields: Record<keyof A, unknown>) =>
  LiveQuery.make((q) => {
    const audience = q.from({ value: rows.tanstack }).select(({ value }) => ({ value, role: "admin" }))
    return q.from({ item: audience })
      .innerJoin({ reader: session.tanstack }, ({ item, reader }) => Query.eq(item.role, reader.role))
      .where(({ reader }) => Query.eq(reader.status, "signed_in"))
      .select(({ item }) => Object.fromEntries(Object.keys(fields).map((field) => [field, (item.value as unknown as Record<string, unknown>)[field]])) as A)
  })

type AdminRows<A extends object> = Effect.Success<ReturnType<typeof adminQuery<A>>>

/** The alerts this device hasn't hidden: later than its mark, newest first. */
export const openQuery = (alerts: AdminRows<SpendAlert>, seen: Collection.Collection<Seen, string>) =>
  LiveQuery.make((q) =>
    q
      .from({ alert: alerts.tanstack })
      .leftJoin({ mark: seen.tanstack }, ({ alert, mark }) => Query.eq(alert.kind, mark.kind))
      .where(({ alert, mark }) => Query.or(Query.isUndefined(mark?.through), Query.gt(alert.createdAt, mark?.through)))
      .select(({ alert }) => alert)
      .orderBy(({ alert }) => alert.createdAt, "desc"),
  )

/** The alerts that show. */
export type Open = Effect.Success<ReturnType<typeof openQuery>>

/** The channels an Admin turned on. */
export const channelsQuery = (channels: AdminRows<AlertChannel>) =>
  LiveQuery.make((q) => q.from({ channel: channels.tanstack }).select(({ channel }) => channel))

/** How many receipts the settings show: the latest. */
export const RECEIPTS_SHOWN = 10

/** The latest receipts, newest first. */
export const deliveriesQuery = (deliveries: AdminRows<AlertDelivery>) =>
  LiveQuery.make((q) =>
    q
      .from({ delivery: deliveries.tanstack })
      .orderBy(({ delivery }) => delivery.updatedAt, "desc")
      .limit(RECEIPTS_SHOWN)
      .select(({ delivery }) => delivery)
  )

/** This tab's saves that haven't landed. */
export const savesQuery = (saves: Collection.Collection<ChannelSave, string>) =>
  LiveQuery.make((q) => q.from({ save: saves.tanstack }).select(({ save }) => save))

/** The sandbox limits an Admin set: one row, or none while the defaults hold. */
export const limitsQuery = (limits: AdminRows<SandboxLimitsRow>) =>
  LiveQuery.make((q) => q.from({ limit: limits.tanstack }).select(({ limit }) => limit))

/** This tab's save of the sandbox limits that hasn't landed. */
export const limitSavesQuery = (saves: Collection.Collection<LimitsSave, string>) =>
  LiveQuery.make((q) => q.from({ save: saves.tanstack }).select(({ save }) => save))

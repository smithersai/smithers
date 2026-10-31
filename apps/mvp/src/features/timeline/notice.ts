import type { Collection } from "@smthrs/effect-tanstack-db"
import { Clock, Deferred, Effect, Schema } from "effect"
import { LOCAL_RECIPIENT, HOME_HREF } from "../attention/contract"
import type { Notice } from "../attention/schema"
import type { Lane } from "./store"

// Saying so when summaries can't be made (ruling FE-19): "if it's falling back to this because a model is not
// configured it should say so". One toast per cause per session, on the one stack (decision 0009), and the same words on
// what the rail is missing.

/** Why summaries stopped, in the product's words; a person reads these. */
export const NOTICE_TEXT: Readonly<Record<string, string>> = {
  unconfigured: "No summary model is set",
  capped: "Today's summaries are spent",
  credit: "The summary model is out of credit",
  unavailable: "The summary model isn't answering",
  server: "Summaries can't be saved right now",
}

/** A local collection's one row: why summaries stopped. */
export const TimelineNotice = Schema.Struct({ id: Schema.String, code: Schema.String, text: Schema.String })
export type TimelineNotice = typeof TimelineNotice.Type

/**
 * The stack's row for `code`: this device's own (`LOCAL_RECIPIENT`), of the `write` kind local failures use, so the
 * synced feed's schema stays as it is. `failed`, so it stays in the person's list until they dismiss it.
 */
export const noticeRow = (code: string, at: string): Notice => ({
  subject: `timeline-summaries:${code}`, recipient: LOCAL_RECIPIENT, kind: "write", state: "failed", mine: true, quiet: false,
  runId: null, repoId: null, conversationId: null, actor: null, title: NOTICE_TEXT[code] ?? NOTICE_TEXT.unavailable!, ref: code,
  href: code === "unconfigured" || code === "credit" ? "/settings" : HOME_HREF,
  version: 1, readVersion: 0, dismissedVersion: 0, hiddenVersion: 0, occurredAt: at, createdAt: at, updatedAt: at,
})

/**
 * Once `lane` stops, says why: to the rail through `state`, and to the person through `launches`, which only one follower
 * in the app ever writes, so a cause toasts once however many conversations stopped on it.
 */
export const followNotice = (lane: Lane, state: Collection.Collection<TimelineNotice, string>, launches: Collection.Collection<Notice, string>) =>
  Effect.gen(function* () {
    yield* Deferred.await(lane.stopped)
    const code = lane.stoppedFor() ?? "unavailable"
    yield* state.insert({ id: "notice", code, text: NOTICE_TEXT[code] ?? NOTICE_TEXT.unavailable! }).pipe(Effect.orDie)
    yield* launches.insert(noticeRow(code, new Date(yield* Clock.currentTimeMillis).toISOString())).pipe(Effect.orDie)
    yield* Effect.logWarning("timeline.summary.notice").pipe(Effect.annotateLogs({ code }))
  })

/**
 * The durable shapes this package writes, frozen as literals.
 *
 * Every value here is already on disk in engine databases and is what a foreign
 * projection matches on. A rename or a reshaped payload is a wire-format break
 * that no behavioural test would notice: the queue would keep working against
 * its own new spelling and stop seeing every record written before it. So these
 * cases assert the literal strings and the literal stored JSON, and they are
 * expected to fail loudly whenever either changes.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.ts"
import * as NotificationEvent from "../src/NotificationEvent.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const provenance = {
  sourceRunId: "operator",
  sourceLineageId: "operator/root",
  sourceTurn: 3,
  sourceActor: "human:will"
}

const steer: Notification = {
  _tag: "human-steer",
  id: "wire-steer",
  targetLineageId: "run/root",
  delivery: "steer",
  provenance,
  payload: { kind: "Message", body: "look at the failing test" }
}

const followup: Notification = {
  _tag: "human-followup",
  id: "wire-followup",
  targetLineageId: "run/root",
  delivery: "queue",
  provenance,
  payload: { kind: "Message", body: "when you get a moment" }
}

const event: Notification = {
  _tag: "system-event",
  id: "wire-event",
  targetLineageId: "run/root",
  delivery: "queue",
  coalescingKey: "run:waiting-approval",
  provenance,
  payload: { condition: "waiting-approval" }
}

const written = Effect.gen(function*() {
  const queue = yield* NotificationQueue.NotificationQueue
  const journal = yield* Journal.Journal
  yield* queue.admit("run", steer)
  yield* queue.admit("run", followup)
  yield* queue.admit("run", event)
  yield* queue.drain({ runId: "run", targetLineageId: "run/root", boundary: "turn-1", wouldIdle: false })
  const page = yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 512 })
  return page.entries.map((entry) => ({ eventType: entry.eventType, payload: entry.payload }))
}).pipe(
  Effect.provide(NotificationQueue.layer),
  Effect.provide(TestJournal.layer()),
  Effect.scoped
)

describe("the durable notification vocabulary", () => {
  it("spells its event types the way every existing engine database holds them", () => {
    // Slashes and PascalCase, unlike the dot-separated names everywhere else in
    // the repository. The divergence is deliberate and documented; what must
    // not happen is a silent correction of it.
    expect(NotificationEvent.AdmittedEventType).toBe("flows/notifications/Admitted")
    expect(NotificationEvent.PromotedEventType).toBe("flows/notifications/Promoted")
  })

  it("tells its two owned events apart by one named refinement", () => {
    const admitted: NotificationEvent.Event = { notification: steer, decision: "admitted" }
    const promoted: NotificationEvent.Event = { boundary: "turn-1", targetLineageId: "run/root", ids: ["wire-steer"] }

    expect(NotificationEvent.isAdmitted(admitted)).toBe(true)
    expect(NotificationEvent.isPromoted(admitted)).toBe(false)
    expect(NotificationEvent.isAdmitted(promoted)).toBe(false)
    expect(NotificationEvent.isPromoted(promoted)).toBe(true)
  })

  it("stores one admission per notification tag, byte for byte", async () => {
    const entries = await Effect.runPromise(written)

    expect(entries).toEqual([
      {
        eventType: "flows/notifications/Admitted",
        payload: {
          notification: {
            _tag: "human-steer",
            id: "wire-steer",
            targetLineageId: "run/root",
            delivery: "steer",
            provenance: {
              sourceRunId: "operator",
              sourceLineageId: "operator/root",
              sourceTurn: 3,
              sourceActor: "human:will"
            },
            payload: { kind: "Message", body: "look at the failing test" }
          },
          decision: "admitted",
          fingerprint: "85fca33dbf4723a84614e47fad256f7c50a53064f77cc8ced348792d822ccec3"
        }
      },
      {
        eventType: "flows/notifications/Admitted",
        payload: {
          notification: {
            _tag: "human-followup",
            id: "wire-followup",
            targetLineageId: "run/root",
            delivery: "queue",
            provenance: {
              sourceRunId: "operator",
              sourceLineageId: "operator/root",
              sourceTurn: 3,
              sourceActor: "human:will"
            },
            payload: { kind: "Message", body: "when you get a moment" }
          },
          decision: "admitted",
          fingerprint: "3c21cc48d8c8fca0b97fd2ece6fd494873d22d8d30ee459f7f906c0b2a2980e9"
        }
      },
      {
        eventType: "flows/notifications/Admitted",
        payload: {
          notification: {
            _tag: "system-event",
            id: "wire-event",
            targetLineageId: "run/root",
            delivery: "queue",
            coalescingKey: "run:waiting-approval",
            provenance: {
              sourceRunId: "operator",
              sourceLineageId: "operator/root",
              sourceTurn: 3,
              sourceActor: "human:will"
            },
            payload: { condition: "waiting-approval" }
          },
          decision: "admitted",
          fingerprint: "978270e4ca46788eef4fd37b2cda8278a784a4721715906767097b55e59c9e78"
        }
      },
      {
        eventType: "flows/notifications/Promoted",
        payload: { boundary: "turn-1", targetLineageId: "run/root", ids: ["wire-steer"] }
      }
    ])
  })

  it("preserves legacy fingerprints with numeric keys, omitted fields and escaped surrogates", async () => {
    const notification: Notification = {
      ...steer,
      _tag: "system-event",
      id: "wire-legacy-json",
      delivery: "queue",
      payload: { "2": "two", "10": "ten", "\ud800": ["\udead", "😀"] }
    }
    const fingerprint = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const journal = yield* Journal.Journal
        yield* queue.admit("run", notification)
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 512 })
        return (page.entries[0]!.payload as { readonly fingerprint: string }).fingerprint
      }).pipe(
        Effect.provide(NotificationQueue.layer),
        Effect.provide(TestJournal.layer()),
        Effect.scoped
      )
    )
    expect(fingerprint).toBe("c1aca20e6dd34b8234959ea05a16f2b855af81a2079abde56618ccaf40b3c445")
  })

  it("keys an admission on the notification id and a drain on the lineage and boundary", async () => {
    const sources = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const journal = yield* Journal.Journal
        yield* queue.admit("run", steer)
        yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "turn one",
          wouldIdle: false
        })
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 512 })
        return page.entries.map((entry) => `${entry.sourceId}:${entry.sourceSeq}`)
      }).pipe(
        Effect.provide(NotificationQueue.layer),
        Effect.provide(TestJournal.layer()),
        Effect.scoped
      )
    )

    expect(sources).toEqual([
      "/notifications/admission/wire-steer:0",
      "/notifications/drain/run%2Froot/turn%20one:0"
    ])
  })
})

/**
 * Case 15 — a live follower whose WebSocket is cut ends, and the reader that
 * replaces it loses nothing that happened while it was gone.
 *
 * A follow stream is the one place where "the connection is fine" is an
 * assumption rather than a fact. The case cuts the socket underneath a running
 * `watch` and then checks the two things that matter: the stream stops instead
 * of hanging forever, and the events the server committed during the outage are
 * still there for the next reader.
 */
import { Control } from "@smthrs/control"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { trackingWebSocketConstructor } from "./harness/dropWebSocket.ts"
import { emitSignals, launchRun } from "./harness/servedRun.ts"
import { servedSuite } from "./harness/servedSuite.ts"

const suite = servedSuite("case15")

beforeAll(() => suite.start(), 180_000)
afterAll(() => suite.stop())

describe("case15 WebSocket drop and reconnect", () => {
  it("ends the follow stream when the socket dies and replays the outage from the cursor", async () => {
    const sockets = trackingWebSocketConstructor(suite.server().token)
    const credential = suite.server().token

    const runId = await suite.remoteWith(
      { credential, sockets },
      Effect.gen(function*() {
        const run = yield* launchRun("case15", suite.server().root)
        yield* emitSignals(run.runId, 5, "before")
        return run.runId
      })
    )

    // A live follower on its own connection. `follow` is the default, so this
    // stream stays open until the server or the socket ends it.
    const followed = await suite.remoteWith(
      { credential, sockets },
      Effect.gen(function*() {
        const control = yield* Control.Control
        const collected: Array<number> = []
        let admittedBefore = 0
        const follow = control.watch({ runId }).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              collected.push(event.sequence)
              if (event.kind === "control.signal.admitted") admittedBefore += 1
            })
          ),
          Stream.runDrain
        )
        const fiber = yield* Effect.forkChild(Effect.exit(follow), { startImmediately: true })
        // Cut only after the follower has actually consumed all admissions,
        // not after an arbitrary sleep that depends on host load.
        yield* Effect.gen(function*() {
          while (admittedBefore < 5) yield* Effect.sleep(10)
        }).pipe(Effect.timeout("15 seconds"))
        const beforeDrop = [...collected]
        yield* Effect.promise(() => sockets.dropLatest("abrupt"))
        // The stream must SETTLE. A follower that hangs on a dead socket is the
        // defect this case exists for, so the timeout is the assertion.
        const settled = yield* Effect.exit(Effect.timeout(Fiber.await(fiber), "15 seconds"))
        return { beforeDrop, settled: Exit.isSuccess(settled) }
      })
    )

    expect(followed.beforeDrop.length).toBeGreaterThan(0)
    expect(followed.settled).toBe(true)

    const cursor = followed.beforeDrop[followed.beforeDrop.length - 1]!
    const openedAfterDrop = sockets.opened()

    // The outage: more events land while nobody is following.
    await suite.remoteWith({ credential, sockets }, emitSignals(runId, 5, "during"))

    const replayed = await suite.remoteWith(
      { credential, sockets },
      Effect.gen(function*() {
        const control = yield* Control.Control
        return yield* control.watch({ runId, follow: false, afterSequence: cursor }).pipe(Stream.runCollect)
      })
    )

    expect(sockets.opened()).toBeGreaterThan(openedAfterDrop)
    expect(replayed.map((event) => event.sequence)).toEqual(
      replayed.map((_, index) => cursor + 1 + index)
    )
    // Admission commits before delivery and is the durable journal contract.
    // This fixture has no matching engine wait, so it cannot claim delivery.
    const admissions = replayed.filter((event) => event.kind === "control.signal.admitted")
    expect(admissions).toHaveLength(5)
    for (const event of admissions) {
      expect(event.runId).toBe(runId)
      expect(event.payload).toEqual(expect.objectContaining({
        commandId: expect.any(String),
        runId,
        name: "during"
      }))
    }
    expect(new Set(admissions.map((event) => JSON.stringify(event.payload))).size).toBe(5)
  })
})

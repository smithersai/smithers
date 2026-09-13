/**
 * Case 9 — a reader that loses its connection resumes from a durable cursor
 * without a gap and without a duplicate.
 *
 * The cursor is the journal sequence the reader last committed, which is why it
 * survives the connection: it names a row in the server's SQLite file, not a
 * position in a socket. The case reads part of a run's history, cuts that
 * reader's socket while the reader still holds it, reconnects with a second
 * client, and asks for everything after the last sequence it kept.
 *
 * The cut has to happen inside the first client's own scope. Collecting the
 * whole history and slicing it afterwards lets the client's scope close first,
 * so the drop lands on a socket that is already gone and the case degenerates
 * into ordinary pagination across two fresh clients. `stateAtDrop` and the drop
 * report are here so that degeneration fails instead of passing quietly.
 */
import { Control } from "@smthrs/control"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type LatencyBudget, loadBudget } from "./budgets/loadBudget.ts"
import { SocketState, trackingWebSocketConstructor } from "./harness/dropWebSocket.ts"
import { emitSignals, launchRun } from "./harness/servedRun.ts"
import { servedSuite } from "./harness/servedSuite.ts"

const suite = servedSuite("case09")
const budget = loadBudget<LatencyBudget>("latency")
const prefix = 20

beforeAll(() => suite.start(), 180_000)
afterAll(() => suite.stop())

const history = (runId: string, afterSequence?: number) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    return yield* control.watch(
      afterSequence === undefined ? { runId, follow: false } : { runId, follow: false, afterSequence }
    ).pipe(Stream.runCollect)
  })

describe("case09 reconnect from a durable cursor", () => {
  it("resumes after a dropped socket with no gap and no duplicate", async () => {
    const sockets = trackingWebSocketConstructor(suite.server().token)
    const credential = suite.server().token
    const runId = await suite.remoteWith(
      { credential, sockets },
      Effect.gen(function*() {
        const run = yield* launchRun("case09", suite.server().root)
        yield* emitSignals(run.runId, 40)
        return run.runId
      })
    )

    // First reader: takes only the prefix and is cut while its connection is
    // still live. `terminate` destroys the TCP connection without a close
    // frame, which is what a lost network does.
    const first = await suite.remoteWith(
      { credential, sockets },
      Effect.gen(function*() {
        const control = yield* Control.Control
        const events = yield* control.watch({ runId, follow: false }).pipe(
          Stream.take(prefix),
          Stream.runCollect
        )
        const stateAtDrop = sockets.latestState()
        const drop = yield* Effect.promise(() => sockets.dropLatest("abrupt"))
        return { events: [...events], stateAtDrop, drop }
      })
    )

    expect(first.events.length).toBe(prefix)
    // The fault this case names: a live socket, cut.
    expect(first.stateAtDrop).toBe(SocketState.open)
    expect(first.drop).toEqual({ stateBefore: SocketState.open, cut: true })

    const cursor = first.events[first.events.length - 1]!.sequence
    const openedBefore = sockets.opened()
    expect(openedBefore).toBeGreaterThan(0)

    // Second reader: a new connection, told only the cursor.
    const startedAt = performance.now()
    const rest = await suite.remoteWith({ credential, sockets }, history(runId, cursor))
    const elapsedMs = performance.now() - startedAt

    expect(sockets.opened()).toBeGreaterThan(openedBefore)
    expect(rest[0]?.sequence).toBe(cursor + 1)
    // Contiguous, in order, and starting exactly where the first reader stopped:
    // no sequence is repeated and none is skipped.
    expect(rest.map((event) => event.sequence)).toEqual(
      rest.map((_, index) => cursor + 1 + index)
    )

    // The union of the two readers is the server's own history up to the last
    // sequence the second one saw: what the cut interrupted, nothing lost and
    // nothing seen twice.
    const union = [...first.events, ...rest].map((event) => event.sequence)
    expect(new Set(union).size).toBe(union.length)
    const complete = await suite.remoteWith({ credential, sockets }, history(runId))
    const last = rest[rest.length - 1]!.sequence
    expect(union.slice().sort((left, right) => left - right)).toEqual(
      complete.map((event) => event.sequence).filter((sequence) => sequence <= last)
    )
    expect(elapsedMs).toBeLessThan(budget.reconnectCursorMaxMs)
  })
})

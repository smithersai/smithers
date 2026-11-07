/**
 * Control errors cross the RPC boundary as JSON. Their schema codec must turn
 * live driver failures into a bounded wire representation before JSON sees
 * circular references or other non-JSON members.
 */
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { LaunchFailed, PersistenceError } from "../src/ControlError.vibe"

class CircularDriverError extends Error {
  readonly self = this
}

const roundTrip = <A>(schema: Schema.Codec<A, unknown, never, never>, value: A): A => {
  const encoded = Schema.encodeSync(schema)(value)
  return Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(encoded)))
}

describe("control error serialization", () => {
  it("round-trips a persistence failure carrying a circular live driver error", () => {
    const decoded = roundTrip(
      PersistenceError,
      new PersistenceError({
        operation: "read control_plans.card_json",
        message: "The stored plan could not be read",
        cause: new CircularDriverError("driver detail")
      })
    )

    expect(decoded).toBeInstanceOf(PersistenceError)
    expect(decoded).toMatchObject({
      code: "persistence_failed",
      operation: "read control_plans.card_json",
      message: "The stored plan could not be read"
    })
    expect(decoded.cause).toBeInstanceOf(Error)
  })

  it("round-trips a launch failure carrying a circular live driver error", () => {
    const decoded = roundTrip(
      LaunchFailed,
      new LaunchFailed({
        runId: "run-1",
        message: "The executor could not start the run",
        cause: new CircularDriverError("executor detail")
      })
    )

    expect(decoded).toBeInstanceOf(LaunchFailed)
    expect(decoded).toMatchObject({
      code: "launch_failed",
      runId: "run-1",
      message: "The executor could not start the run"
    })
    expect(decoded.cause).toBeInstanceOf(Error)
  })
})

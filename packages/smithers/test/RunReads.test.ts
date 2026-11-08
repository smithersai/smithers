import type { ControlSchema } from "@smthrs/control"
import { Effect, Stream } from "effect"
import { expect, it } from "vitest"
import { terminalFailure } from "../src/commands/RunReads.ts"

const failure = {
  tag: "request/Unavailable",
  message: "after the outage, retry",
  action: "Write",
  attempts: 12,
  retryable: true
}
const terminal: ControlSchema.ControlEvent = {
  sequence: 60_001,
  occurredAt: 1,
  kind: "control.engine.event",
  runId: "root",
  payload: {
    executionId: "root",
    eventType: "flows.engine.run-decision",
    payload: { decision: "transitioned", status: "failed", failure }
  }
}

it("finds the terminal failure after more than 50,000 events and 16 MiB without collecting history", async () => {
  const history = Stream.range(0, 60_000).pipe(
    Stream.map((sequence): ControlSchema.ControlEvent => ({
      sequence,
      occurredAt: 0,
      runId: "root",
      kind: "control.node.progress",
      payload: "x".repeat(1024)
    })),
    Stream.concat(Stream.succeed(terminal))
  )
  expect(await Effect.runPromise(terminalFailure(history, "root"))).toEqual({ failure, unavailable: false })
})

it("distinguishes a failed optional diagnosis read from an old run with no diagnosis", async () => {
  expect(await Effect.runPromise(terminalFailure(Stream.empty, "root"))).toEqual({
    failure: undefined,
    unavailable: false
  })
  expect(await Effect.runPromise(terminalFailure(Stream.fail(new Error("disconnected")), "root"))).toEqual({
    failure: undefined,
    unavailable: true
  })
})

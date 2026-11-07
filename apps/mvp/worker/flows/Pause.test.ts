// `probe/Pause` on the Node host (worker/test/flowHost.ts), over the compose Postgres (`pnpm db:up`). The same flow
// and registration run on the Cloudflare Durable Object (worker/Executions.ts) and in local workerd
// (worker/Executions.workerd.test.ts), so passing here shows the flow is host-agnostic.
import { Sleep } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Cause, Effect, Exit, Logger } from "effect"
import { describe, expect, test } from "vitest"
import { runFlow } from "../test/flowHost.ts"
import { logged, Pause, registration } from "./Pause.vibe"

describe("probe/Pause on the Node host", () => {
  test("marks before, sleeps on a durable timer, marks after, and completes", async () => {
    const marks: Array<{ readonly label: string; readonly at: number }> = []
    const startedAt = Date.now()
    const ran = await runFlow(
      Pause,
      { label: "node", pauseMs: 300 },
      registration((label) => Effect.sync(() => marks.push({ label, at: Date.now() })).pipe(Effect.as(label))),
    )
    expect(ran.exit).toEqual(Exit.succeed("node:after"))
    expect(ran.status).toBe("completed")
    expect(marks.map((mark) => mark.label)).toEqual(["node:before", "node:after"])
    // The second step waited for the timer.
    expect(marks[1]!.at - marks[0]!.at).toBeGreaterThanOrEqual(300)
    expect(marks[0]!.at).toBeGreaterThanOrEqual(startedAt)
  })

  test("a negative pause fails with the flow's declared error after the first step", async () => {
    const marks: Array<string> = []
    const ran = await runFlow(
      Pause,
      { label: "bad", pauseMs: -1 },
      registration((label) => Effect.sync(() => marks.push(label)).pipe(Effect.as(label))),
    )
    expect(Exit.isFailure(ran.exit)).toBe(true)
    const error = Exit.isFailure(ran.exit) ? Cause.squash(ran.exit.cause) : undefined
    expect(error).toBeInstanceOf(Sleep.SleepRequestInvalid)
    expect(ran.status).toBe("failed")
    expect(marks).toEqual(["bad:before"])
  })
})

describe("the deployed step", () => {
  test("logs one probe.mark line with the label and returns it", async () => {
    const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const logger = Logger.make((options) => {
      lines.push(StructuredLogger.formatStructured.log(options))
    })
    const result = await Effect.runPromise(
      logged("node:before").pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger]))),
    )
    expect(result).toBe("node:before")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ message: "probe.mark", level: "INFO", annotations: { label: "node:before" } })
  })
})

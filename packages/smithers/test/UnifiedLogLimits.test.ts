import * as Audience from "@smthrs/build-cli/Audience"
import { Control } from "@smthrs/control"
import { Effect, Layer, Stream } from "effect"
import { HttpServer } from "effect/http"
import { describe, expect, it } from "vitest"
import { createRunsCli } from "../src/cli/ControlCommands.ts"
import * as BoundedEvents from "../src/internal/BoundedEvents.ts"
import * as NodeControl from "../src/NodeControl.ts"

const oversized = {
  sequence: 1,
  runId: "run-limit",
  kind: "control.test",
  occurredAt: 0,
  payload: "oversized-payload-" + "a".repeat(BoundedEvents.maximumEventBytes)
}
const faulty = Layer.effect(
  Control.Control,
  Effect.gen(function*() {
    const control = yield* Control.Control
    return Control.make({
      ...control,
      watch: () => Stream.succeed(oversized),
      list: () =>
        Effect.succeed({
          _tag: "runs",
          items: [{ runId: "run-limit", flowId: "test", status: "completed", createdAt: 0, updatedAt: 0 }]
        })
    })
  })
).pipe(Layer.provide(Control.layerNoop))

describe("canonical logs refuse oversized events", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])("refuses before structured=%s rendering, follow=%s", async (structured, follow) => {
    const result = { stdout: "", codes: [] as Array<number> }
    await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        if (server.address._tag !== "InetAddressV4") throw new Error("Expected TCP listener")
        const remote = `http://127.0.0.1:${server.address.port}`
        yield* Effect.promise(() =>
          createRunsCli({
            environment: {},
            presentation: {
              ...Audience.resolve({ env: {}, audience: "human", stdout: true, stderr: false }),
              structured
            },
            stdout: {
              isTTY: true,
              columns: 80,
              write: (text) => {
                result.stdout += text
              }
            }
          }).serve([
            "logs",
            "run-limit",
            "--remote",
            remote,
            ...(structured ? ["--json"] : []),
            ...(follow ? ["--follow"] : [])
          ], {
            env: {},
            stdout: (text) => {
              result.stdout += text
            },
            exit: (code) => {
              result.codes.push(code)
            }
          })
        )
      }).pipe(
        Effect.provide(NodeControl.layerServerNoopAuth({ host: "127.0.0.1", port: 0 }).pipe(Layer.provide(faulty))),
        Effect.scoped
      )
    )
    expect(result.codes).toEqual([1])
    expect(result.stdout).toContain("ResourceLimitError")
    expect(result.stdout).toContain("1048576-bytes")
    expect(result.stdout).not.toContain("oversized-payload-")
  })
})

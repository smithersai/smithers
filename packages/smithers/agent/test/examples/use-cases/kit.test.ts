import { afterAll, expect, it } from "@effect/vitest"
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "use-case-kit-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const Echo = AgentAction.make("examples/Kit/Echo", {
  payload: { word: Schema.String },
  output: Schema.Struct({ word: Schema.String }),
  seat: "anthropic:claude-sonnet-5-5",
  prompt: ({ word }) => `Echo the word ${word}.`
})

const EchoFlow = Flow.make("examples/Kit/EchoFlow", {
  payload: { word: Schema.String },
  success: Schema.Struct({ word: Schema.String }),
  error: AgentAction.AgentFailure,
  body: Node.capture({}, (payload) => Echo.call(payload))
})

it.effect("stops the run and names a request the script did not expect", () =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(Kit.run(EchoFlow, { word: "ping" }, {
      filename: join(directory, "unscripted.sqlite"),
      executionId: "kit-unscripted",
      script: () => undefined,
      actions: Echo.layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    const reported = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(reported).toContain("No scripted answer for this request")
    expect(reported).toContain("Echo the word ping.")
  }))

it.effect("refuses raw workflow callbacks in the shared durable example host", () =>
  Effect.gen(function*() {
    const Raw = Flow.make("examples/raw-callback", {
      payload: {},
      success: Schema.Number,
      body: () => Node.succeed(1)
    })
    const exit = yield* Kit.run(Raw, {}, {
      filename: join(directory, "raw-callback.sqlite"),
      executionId: "raw-callback",
      script: () => undefined,
      actions: Layer.empty
    }).pipe(Effect.exit)
    expect(exit).toMatchObject({ _tag: "Failure" })
    expect(JSON.stringify(exit)).toContain("Callback body")
    expect(JSON.stringify(exit)).toContain("process-local identity")
  }))

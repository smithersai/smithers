// admin/SetModel's step (worker/SetModel.ts) on its own, for what a flow run can't reach: a runtime that gives no
// invocation key, and a database that refuses. Its runs on the Node host are in worker/ModelEndpoint.test.ts.
import { Cause, Effect, Exit, Layer, Logger, Redacted } from "effect"
import { describe, expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import { type Actor, CurrentActor } from "./Actor.vibe"
import * as SetModel from "./SetModel.ts"
import { runFlow } from "./test/flowHost.ts"

const admin: Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin" }
const change = {
  role: "agent" as const,
  model: { protocol: "openai-chat", baseUrl: "https://models.example", modelId: "m-1", credential: "FIXTURE" },
}

/** Runs the step as `actor` with an unreachable Postgres, keeping its log lines. */
const run = (invocationKey: string | undefined, actor: Actor = admin) => {
  const lines: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
  const logger = Logger.make((options) => {
    const line = Logger.formatStructured.log(options)
    lines.push({ message: line.message, annotations: line.annotations })
  })
  const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://nobody:nothing@127.0.0.1:1/none")))
  return Effect.runPromiseExit(
    SetModel.write(change, actor, invocationKey).pipe(
      Effect.provide(unreachable),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    ),
  ).then((exit) => ({ exit, lines }))
}

describe("admin/WriteModel", () => {
  test("refuses to write without an invocation key, as a defect, before touching Postgres", async () => {
    const { exit } = await run(undefined)

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(SetModel.NoInvocationKey)
  })

  test("logs a refusal at Warn with its reason, before touching Postgres", async () => {
    const { exit, lines } = await run("step-1", { ...admin, role: "member" })

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(new SetModel.NotAllowed({ reason: "not_admin" }))
    expect(lines.find((line) => line.message === "admin.set_model")?.annotations).toMatchObject({
      outcome: "refused",
      role: "agent",
      reason: "not_admin",
    })
  })

  test("logs a database failure by its SQL reason, never its message", async () => {
    const { exit, lines } = await run("step-1")

    expect(Exit.isFailure(exit)).toBe(true)
    expect(lines.find((line) => line.message === "admin.set_model")?.annotations).toMatchObject({
      outcome: "error",
      role: "agent",
      errorCode: expect.stringMatching(/^sql:/),
    })
  })
})

describe("admin/SetModel", () => {
  test("a database failure fails the run as a defect, not as a refusal", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://nobody:nothing@127.0.0.1:1/none")))

    const ran = await runFlow(
      SetModel.SetModel,
      change,
      SetModel.registration(unreachable).pipe(Layer.provide(Layer.succeed(CurrentActor, admin))),
    )

    expect(Exit.isFailure(ran.exit)).toBe(true)
    expect(Exit.isFailure(ran.exit) && Cause.hasDies(ran.exit.cause)).toBe(true)
    expect(ran.status).toBe("failed")
  })
})

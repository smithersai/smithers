import { Logger as StructuredLogger } from "@smthrs/observability"
import { Action, FlowRuntime } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { Context, Effect, Exit, Layer, Logger, Scope } from "effect"
import { afterEach, describe, expect, test } from "vitest"
import { build } from "../../../worker/test/flowHost"
import { answerAskingTab } from "../../flows/askingTab"
import { TabRequests } from "../../flows/requests.vibe"
import { type CheckOutcome, sessionChannel } from "./contract"
import { AuthRefresh, REFRESH_RETRY } from "./flows"
import { SessionCall } from "./schema"
import * as Steps from "./steps.vibe"

// `auth/refresh`'s step over the engine's session channel, on Node's own `BroadcastChannel` and the Node host's durable
// engine: what each outcome the tab answers becomes, the engine asking again while ChatApi can't say, and a tab that is
// gone. The tab's own side, over a real sign-in client, is in auth.test.ts.

const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

/** A tab on engine `name` that started `requests`, answering each check with the next of `outcomes`; returns its calls. */
const tab = async (name: string, requests: ReadonlyArray<string>, outcomes: ReadonlyArray<CheckOutcome>) => {
  const calls: Array<number> = []
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const answering = Layer.effectDiscard(
    answerAskingTab({
      channel: sessionChannel(name),
      input: SessionCall,
      answer: () => Effect.sync(() => ({ outcome: outcomes[Math.min(calls.push(Date.now()) - 1, outcomes.length - 1)]! })),
    }),
  )
  const context = await Effect.runPromise(
    Scope.provide(scope)(
      Layer.build(answering.pipe(Layer.provideMerge(TabRequests.layer()), Layer.provide(TabChannel.layer))),
    ),
  )
  for (const request of requests) await Effect.runPromise(Context.get(context, TabRequests).add(request, "sync"))
  return calls
}

type Line = ReturnType<typeof StructuredLogger.formatStructured.log>

/**
 * Runs `auth/refresh` as `executionId` on the Node host's engine, its step asking the tabs of engine `name`; its log
 * lines go to `logs`. The engine runs a step with the services it was built with, so the logger goes to the build.
 */
const runFlow = (name: string, executionId: string, logs: Array<Line>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { context } = yield* build(
          Steps.registration.pipe(
            Layer.provide(Steps.TabSession.layerChannel({ name, within: "500 millis" })),
            Layer.provide(TabChannel.layer),
            Layer.provideMerge(Action.layerImplementations),
          ),
        )
        const flows = Context.get(context, FlowRuntime.FlowRuntime)
        return { exit: yield* Effect.exit(flows.execute(AuthRefresh, { executionId, payload: {} }).pipe(Effect.provide(context))) }
      }),
    ).pipe(
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([Logger.make((options) => void logs.push(StructuredLogger.formatStructured.log(options)))]),
      ),
    ),
  )

const checks = (logs: ReadonlyArray<Line>) =>
  logs.filter((line) => line.message === "auth.refresh.check").map((line) => line.annotations)

describe("auth/refresh", () => {
  test.each(["signed_in", "signed_out"] as const)(
    "a tab whose check answers %s settles the run at once, logged with the outcome",
    async (outcome) => {
      const name = `auth-${crypto.randomUUID()}`
      const calls = await tab(name, ["run-1"], [outcome])
      const logs: Array<Line> = []
      const ran = await runFlow(name, "run-1", logs)
      expect(ran.exit).toEqual(Exit.succeed({ outcome }))
      expect(calls).toHaveLength(1)
      expect(checks(logs)).toEqual([expect.objectContaining({ outcome, executionId: "run-1", feature: "auth" })])
    },
  )

  test("while ChatApi can't say, the engine asks again, 1 s and then 2 s later, until the tab's check answers", async () => {
    const name = `auth-${crypto.randomUUID()}`
    const calls = await tab(name, ["run-1"], ["unreachable", "unreachable", "signed_in"])
    const logs: Array<Line> = []
    const ran = await runFlow(name, "run-1", logs)
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "signed_in" }))
    expect(calls).toHaveLength(3)
    // The engine's retry policy spaces the attempts: 1 s doubling, never sooner.
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(REFRESH_RETRY.initialMs)
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(REFRESH_RETRY.initialMs * REFRESH_RETRY.factor)
    expect(checks(logs).map((line) => line.outcome)).toEqual(["unreachable", "unreachable", "signed_in"])
    expect(logs.find((line) => line.message === "auth.refresh.check")!.level).toBe("WARN")
  }, 20_000)

  test("a tab that is gone settles the run, logged gone; another tab's request goes unanswered", async () => {
    const name = `auth-${crypto.randomUUID()}`
    const other = await tab(name, ["run-2"], ["signed_in"])
    const logs: Array<Line> = []
    const ran = await runFlow(name, "run-1", logs)
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "gone" }))
    expect(other).toEqual([])
    expect(checks(logs)).toEqual([expect.objectContaining({ outcome: "gone" })])
  })
})

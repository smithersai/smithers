import { Action } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { Cause, Context, Effect, Exit, Layer, Metric, Scope } from "effect"
import { afterEach, describe, expect, test } from "vitest"
import { runFlow } from "../../../worker/test/flowHost"
import { answerAskingTab } from "../../flows/askingTab"
import { TabRequests } from "../../flows/requests"
import { copyChannel, editChannel } from "./contract"
import { ChatCopy, ChatEdit, MessageNotFound, QuestionNotEditable } from "./flows"
import { messageCopies, questionEdits } from "./metrics"
import { type CopyAnswer, CopyCall, type EditAnswer, EditCall } from "./schema"
import * as Steps from "./steps"

/** A failed call's error. The engine annotates an action's failed cause with its FailureSite, which the outcome doesn't depend on. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit

// `chat/copy` and `chat/edit`'s steps over the engine's chat channels, on Node's own `BroadcastChannel`: what each
// outcome the tab answers becomes, which door it counts, and a tab that is gone. The tab's own side, over a real
// conversation, clipboard and outbox, is in controls.test.ts.

const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

/**
 * A tab on engine `name` that started `requests` through the button, answering each copy with `copy` and each edit with
 * `edit`; returns the calls it got.
 */
const tab = async (
  name: string,
  requests: ReadonlyArray<string>,
  copy: CopyAnswer["outcome"],
  edit: EditAnswer["outcome"],
) => {
  const calls: Array<unknown> = []
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const answering = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* answerAskingTab({
        channel: copyChannel(name),
        input: CopyCall,
        answer: (call) => Effect.sync(() => (calls.push(call), { outcome: copy })),
      })
      yield* answerAskingTab({
        channel: editChannel(name),
        input: EditCall,
        answer: (call) => Effect.sync(() => (calls.push(call), { outcome: edit })),
      })
    }),
  )
  const context = await Effect.runPromise(
    Scope.provide(scope)(
      Layer.build(answering.pipe(Layer.provideMerge(TabRequests.layer()), Layer.provide(TabChannel.layer))),
    ),
  )
  for (const request of requests) await Effect.runPromise(Context.get(context, TabRequests).add(request, "button"))
  return calls
}

/** Chat's steps on the Node host, asking the tabs of engine `name`, counting into `registry`. */
const registration = (name: string, registry: Metric.MetricRegistry) =>
  Steps.registration.pipe(
    Layer.provide(Steps.TabChat.layerChannel({ name, within: "500 millis" })),
    Layer.provide(TabChannel.layer),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, registry)),
  )

const count = (
  registry: Metric.MetricRegistry,
  metric: typeof messageCopies | typeof questionEdits,
  attributes: Record<string, string>,
) =>
  Effect.runSync(
    Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
  ).count

describe("chat/copy", () => {
  test.each([
    ["copied", Exit.succeed({ copied: true })],
    ["failed", Exit.succeed({ copied: false })],
  ] as const)("a tab that answers %s settles the step, counted by door, which and outcome", async (outcome, exit) => {
    const name = `chat-${crypto.randomUUID()}`
    const calls = await tab(name, ["run-1"], outcome, "edited")
    const registry: Metric.MetricRegistry = new Map()
    const ran = await runFlow(ChatCopy, { messageId: "m-1" }, registration(name, registry), { executionId: "run-1" })
    expect(ran.exit).toEqual(exit)
    expect(calls).toEqual([{ messageId: "m-1" }])
    expect(count(registry, messageCopies, { door: "button", which: "message", outcome })).toBe(1)
  })

  test("the agent's call copies the latest answer in the tab whose composer asked, and counts door agent", async () => {
    const name = `chat-${crypto.randomUUID()}`
    const asking = await tab(name, ["answer-1"], "copied", "edited")
    const other = await tab(name, ["answer-2"], "copied", "edited")
    const registry: Metric.MetricRegistry = new Map()
    const ran = await runFlow(ChatCopy, {}, registration(name, registry), {
      executionId: "answer-1/chat/Respond@1/call/0.0",
    })
    expect(ran.exit).toEqual(Exit.succeed({ copied: true }))
    expect(asking).toEqual([{}])
    expect(other).toEqual([])
    expect(count(registry, messageCopies, { door: "agent", which: "latest", outcome: "copied" })).toBe(1)
  })

  test("no such message fails MessageNotFound", async () => {
    const name = `chat-${crypto.randomUUID()}`
    await tab(name, ["run-1"], "not_found", "edited")
    const registry: Metric.MetricRegistry = new Map()
    const ran = await runFlow(ChatCopy, {}, registration(name, registry), { executionId: "run-1" })
    expect(failureOf(ran.exit)).toEqual(new MessageNotFound())
    expect(count(registry, messageCopies, { door: "button", which: "latest", outcome: "not_found" })).toBe(1)
  })

  test("a tab that is gone settles with copied false", async () => {
    const name = `chat-${crypto.randomUUID()}`
    const registry: Metric.MetricRegistry = new Map()
    const ran = await runFlow(ChatCopy, {}, registration(name, registry), { executionId: "run-1" })
    expect(ran.exit).toEqual(Exit.succeed({ copied: false }))
    expect(count(registry, messageCopies, { door: "unknown", which: "latest", outcome: "gone" })).toBe(1)
  })
})

describe("chat/edit", () => {
  test("a tab that takes the question back settles edited, counted by door and outcome", async () => {
    const name = `chat-${crypto.randomUUID()}`
    const calls = await tab(name, ["run-1"], "copied", "edited")
    const registry: Metric.MetricRegistry = new Map()
    const ran = await runFlow(ChatEdit, { questionId: "q-1" }, registration(name, registry), { executionId: "run-1" })
    expect(ran.exit).toEqual(Exit.succeed({ edited: true }))
    expect(calls).toEqual([{ questionId: "q-1" }])
    expect(count(registry, questionEdits, { door: "button", outcome: "edited" })).toBe(1)
  })

  test.each(["not_found", "sent", "failed"] as const)("a question the tab can't take back (%s) fails QuestionNotEditable", async (reason) => {
    const name = `chat-${crypto.randomUUID()}`
    await tab(name, ["run-1"], "copied", reason)
    const registry: Metric.MetricRegistry = new Map()
    const ran = await runFlow(ChatEdit, {}, registration(name, registry), { executionId: "run-1" })
    expect(failureOf(ran.exit)).toEqual(new QuestionNotEditable({ reason }))
    expect(count(registry, questionEdits, { door: "button", outcome: reason })).toBe(1)
  })

  test("a tab that is gone settles with edited false", async () => {
    const name = `chat-${crypto.randomUUID()}`
    const registry: Metric.MetricRegistry = new Map()
    const ran = await runFlow(ChatEdit, {}, registration(name, registry), { executionId: "run-1" })
    expect(ran.exit).toEqual(Exit.succeed({ edited: false }))
    expect(count(registry, questionEdits, { door: "unknown", outcome: "gone" })).toBe(1)
  })
})

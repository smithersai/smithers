import { TabChannel } from "@smthrs/platform-browser"
import { type Duration, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { answerAskingTab, asker } from "./askingTab"
import { TabRequests } from "./requests.vibe"

// The engine worker's line to the tab that asked, over real `BroadcastChannel`s in one Node process: a step asks, only
// the tab that started the requester answers, and every other message on the channel is ignored.

const Input = Schema.Struct({ word: Schema.String })
const Output = Schema.Struct({ length: Schema.Number })

/** A tab that started `started` through the button, answering `channel` with the word's length; returns what it saw. */
const openTab = Effect.fnUntraced(function* (channel: string, started: ReadonlyArray<string>) {
  const requests = yield* TabRequests
  for (const id of started) yield* requests.add(id, "button")
  const seen: Array<string> = []
  yield* answerAskingTab({
    channel,
    input: Input,
    answer: ({ word }, door) => Effect.sync(() => (seen.push(`${door} ${word}`), { length: word.length })),
  })
  return seen
})

/** Runs `body` with a step's asker on `channel` and, on its own `TabRequests`, a tab that started `started`. */
const withTab = <A>(
  started: ReadonlyArray<string>,
  body: (
    ask: Effect.Success<ReturnType<typeof asker<{ readonly word: string }, typeof Output>>>,
    seen: ReadonlyArray<string>,
    channel: string,
  ) => Effect.Effect<A, never, TabChannel.TabChannel | Scope.Scope>,
  within: Duration.Input = "2 seconds",
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const channel = `asking-${crypto.randomUUID()}`
        const seen = yield* openTab(channel, started).pipe(Effect.provide(TabRequests.layer()))
        const ask = yield* asker<{ readonly word: string }, typeof Output>({ channel, output: Output, within })
        return yield* body(ask, seen, channel)
      }),
    ).pipe(Effect.provide(TabChannel.layer)),
  )

describe("the tab that asked", () => {
  test("answers its own request with the door it started it through", async () => {
    const result = await withTab(["run-1"], (ask, seen) =>
      Effect.map(ask("run-1", { word: "hello" }), (answered) => ({ answered, seen: [...seen] })))
    expect(result).toEqual({ answered: Option.some({ door: "button", output: { length: 5 } }), seen: ["button hello"] })
  })

  test("a request no tab started gets no answer within the wait, and the tab does nothing", async () => {
    const result = await withTab(
      ["run-1"],
      (ask, seen) => Effect.map(ask("run-2", { word: "hello" }), (answered) => ({ answered, seen: [...seen] })),
      "200 millis",
    )
    expect(result).toEqual({ answered: Option.none(), seen: [] })
  })

  test("a call with another input is left alone", async () => {
    const result = await withTab(
      ["run-1"],
      (_ask, seen, channel) =>
        Effect.gen(function* () {
          const other = yield* asker<{ readonly word: number }, typeof Output>({
            channel,
            output: Output,
            within: "200 millis",
          })
          return { answered: yield* other("run-1", { word: 7 }), seen: [...seen] }
        }),
    )
    expect(result).toEqual({ answered: Option.none(), seen: [] })
  })

  test("the step waits for its own answer: stray messages and other calls' answers are ignored", async () => {
    // No tab started run-1; something else on the channel answers the call: junk, another id, an output of another
    // shape, and then a proper answer, in that order.
    const answered = await withTab([], (ask, _seen, channel) =>
      Effect.gen(function* () {
        const port = yield* (yield* TabChannel.TabChannel).open(channel)
        const calls = yield* port.subscribe
        yield* Effect.forkScoped(Effect.gen(function* () {
          const call = Option.getOrThrow(yield* Stream.runHead(Stream.fromQueue(calls))) as { readonly id: string }
          yield* port.post("junk")
          yield* port.post({ kind: "smithers/asking-tab-reply", id: "another", door: "button", output: { length: 1 } })
          yield* port.post({ kind: "smithers/asking-tab-reply", id: call.id, door: "button", output: { length: "x" } })
          yield* port.post({ kind: "smithers/asking-tab-reply", id: call.id, door: "slash", output: { length: 4 } })
        }))
        return yield* ask("run-1", { word: "four" })
      }))
    expect(answered).toEqual(Option.some({ door: "slash", output: { length: 4 } }))
  })

  test("the tab stops answering when its scope closes", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const channel = `asking-${crypto.randomUUID()}`
        const tab = yield* Scope.make()
        yield* openTab(channel, ["run-1"]).pipe(Effect.provide(TabRequests.layer()), Scope.provide(tab))
        yield* Scope.close(tab, Exit.void)
        const ask = yield* asker<{ readonly word: string }, typeof Output>({ channel, output: Output, within: "200 millis" })
        return yield* ask("run-1", { word: "gone" })
      }).pipe(Effect.scoped, Effect.provide(Layer.fresh(TabChannel.layer))),
    )
    expect(exit).toEqual(Option.none())
  })
})

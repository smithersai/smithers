/**
 * The services an action's implementation sees: the ones its layer was built
 * with, under the ones of the fiber that runs the flow. Where both hold a
 * service, the run's wins, so a flow started inside another flow's handler
 * carries that handler's services into its own steps unless it is started in
 * a context of its own (docs/guides/implement-an-action.md).
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Context, Effect, Layer, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

class Greeting extends Context.Service<Greeting, string>()("ActionServices/Greeting") {}
class Place extends Context.Service<Place, string>()("ActionServices/Place") {}

const Greet = Action.make("services/greet", { payload: {}, success: Schema.String })

const greets = Greet.toLayer(() =>
  Effect.gen(function*() {
    return `${yield* Greeting} ${yield* Place}`
  })
).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Greeting, "wired"), Layer.succeed(Place, "here"))))

const Greeter = Flow.make("services/greeter", {
  payload: {},
  success: Schema.String,
  body: () => Greet.call({})
})

const wired = Layer.mergeAll(greets, Interpreter.layer(Greeter)).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(layerMemory)
)

describe("the services an implementation sees", () => {
  it.effect("are the ones its layer was built with", () =>
    Effect.gen(function*() {
      const run = Greeter.execute({}, { executionId: "wired" }).pipe(Effect.provide(wired))
      expect(yield* withCrypto(run)).toBe("wired here")
    }))

  it.effect("take a service the running fiber holds over the same service in the wiring", () =>
    Effect.gen(function*() {
      const run = Greeter.execute({}, { executionId: "caller" }).pipe(
        Effect.provide(wired),
        Effect.provideService(Greeting, "caller")
      )
      expect(yield* withCrypto(run)).toBe("caller here")
    }))

  it.effect("are the wiring's again when the run starts in a context captured without the caller's", () =>
    Effect.gen(function*() {
      const own = yield* Effect.context<never>()
      const isolated = Effect.updateContext<string, unknown, never, never>(
        Greeter.execute({}, { executionId: "isolated" }).pipe(Effect.provide(wired), withCrypto),
        (): Context.Context<never> => own
      )
      expect(yield* isolated.pipe(Effect.provideService(Greeting, "caller"))).toBe("wired here")
    }))
})

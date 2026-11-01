import { Action, Flow, FlowRuntime, Interpreter, Poll, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Option, Schema } from "effect"
import * as fc from "fast-check"
import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { withCrypto } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

interface Schedule {
  readonly form: "poll" | "flow"
  readonly handlerDelay: number
  readonly registrationDelay: number
}

const corpus: ReadonlyArray<Schedule> = JSON.parse(readFileSync(
  new URL("./corpus/smithers-health-discovery-registration.json", import.meta.url),
  "utf8"
))

/**
 * Smithers HealthHost minimizes to a captured Discover action inside a Poll.
 * Interpreter's registration exposes it to durable recovery immediately, so
 * every named handler must already be filed when register is called.
 */
const observeRegistration = async ({ form, handlerDelay, registrationDelay }: Schedule) => {
  const Discover = Action.make("smithers-health-registration/Discover", {
    payload: { attempt: Schema.Number },
    success: Poll.CheckResult(Schema.Number)
  })
  const flowName = "smithers-health-registration/Discovery"
  const handlers = Layer.unwrap(
    Effect.sleep(handlerDelay).pipe(Effect.as(Layer.mergeAll(
      Discover.toLayer(() => Effect.succeed({ satisfied: false, output: 0 })),
      Poll.layer,
      Sleep.layer
    )))
  )
  const registration = form === "poll" ?
    Interpreter.layerWithImplementations(
      Poll.make(flowName, {
        input: {},
        result: Schema.Number,
        intervalMs: 5_000,
        maxAttempts: 2,
        check: Node.capture({ action: Discover.name }, ({ attempt }) => Discover.call({ attempt }))
      }),
      handlers
    ) :
    Interpreter.layerWithImplementations(
      Flow.make(flowName, {
        payload: {},
        success: Poll.CheckResult(Schema.Number),
        body: Node.capture({ action: Discover.name }, () => Discover.call({ attempt: 0 }))
      }),
      handlers
    )
  const ready: Array<boolean> = []
  await Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      const observed: typeof runtime = {
        ...runtime,
        register: (flow, execute, options) =>
          Effect.gen(function*() {
            if (flow._tag === flowName) yield* Effect.sleep(registrationDelay)
            yield* runtime.register(flow, execute, options)
            if (flow._tag === flowName) {
              const table = yield* Action.Implementations
              ready.push(Option.isSome(yield* table.get(Discover.name)))
            }
          })
      }
      yield* Effect.void.pipe(
        Effect.provide(registration),
        Effect.provideService(FlowRuntime.FlowRuntime, observed)
      )
    }).pipe(Effect.provide(layerMemory), Effect.scoped, withCrypto)
  )
  expect(ready).toEqual([true])
}

for (const schedule of corpus) {
  it(`files handlers before registering the Smithers ${schedule.form} (${schedule.handlerDelay}/${schedule.registrationDelay})`, () =>
    observeRegistration(schedule))
}

it("keeps handlers ready across construction schedules", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        form: fc.constantFrom("poll" as const, "flow" as const),
        handlerDelay: fc.integer({ min: 0, max: 8 }),
        registrationDelay: fc.integer({ min: 0, max: 8 })
      }),
      observeRegistration
    ),
    { seed: 20261101, numRuns: 200 }
  )
}, 30_000)

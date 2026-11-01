/**
 * Engine conformance, applied to the volatile runtime.
 *
 * What this certifies: the identity, replay, race, and interruption pins run
 * against `FlowEngine.layerMemory`, the in-memory implementation of the
 * production `FlowRuntime` port that ships in `@smthrs/engine`. The subject is
 * the real adapter in `src/FlowEngineLike.ts`, which drives that runtime
 * through its public `register`/`execute`/`poll`/`resume` surface, so these
 * are the engine's own semantics rather than a hand-written stand-in.
 *
 * What it does NOT certify: durability. `layerMemory` keeps every execution,
 * action, and journal entry in process memory, so nothing here survives a
 * restart, and the durable driver in `@smthrs/engine-store` (leases, the SQLite
 * journal, attempt and cache stores, snapshot boundaries) never runs. "Replay"
 * below means the runtime replaying a recorded result inside one process.
 *
 * Connecting the durable engine is a layer swap, not a rewrite: the binding
 * below takes any `Layer<FlowRuntime>`, and the durable one is
 * `EngineStore.layer({ owner, journalSource })`, which needs `AttemptStore`,
 * `CacheStore`, `Crypto`, `DurableEngineState`, `Journal`, `Jj`,
 * `OwnerIdentity`, `RunStore`, `Scope`, and `StepBoundary`. All of that lives
 * in `@smthrs/engine-store`, which `@smthrs/testing` does not depend on and
 * must not, so the durable application belongs in a suite that already has
 * that dependency.
 *
 * Source parity: `packages/testing/test/support/ParityManifest.ts`.
 */
import { FlowEngine } from "@smthrs/engine"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as TestClock from "effect/testing/TestClock"
import * as Conformance from "../../src/Conformance.vibe"
import * as EngineSubject from "../../src/EngineSubject.vibe"
import * as FlowEngineLike from "../../src/FlowEngineLike.ts"
import { describe, expect, it } from "../../src/Vitest.ts"

// The seam, spelled out: the runtime is an argument. Swapping this one
// expression for a durable runtime layer runs the identical case list against
// the durable engine.
const subject = FlowEngineLike.layerOver(FlowEngine.layerMemory)

describe("FlowEngine.layerMemory conformance", () => {
  for (const conformanceCase of Conformance.coreSuite()) {
    it.scoped(conformanceCase.name, () =>
      Effect.flatMap(EngineSubject.EngineSubject, conformanceCase.run).pipe(
        Effect.provide(subject)
      ))
  }

  // Pins delayed settlement: an execution whose only step settles far in the
  // future is still reported with its own outcome and value, and the waiting
  // fiber never holds the virtual clock back. This asserts the observable
  // contract of `awaitResult`; it does not on its own distinguish a suspending
  // waiter from a spinning one.
  it.scoped("reports a delayed completion once the step settles", () =>
    Effect.gen(function*() {
      const engine = yield* EngineSubject.EngineSubject
      const running = yield* Effect.forkChild(
        engine.run({
          flow: {
            name: "testing/engine-like/delayed-completion",
            steps: [{
              key: "delayed-completion",
              sealed: false,
              kind: "step",
              run: () => Effect.as(Effect.sleep("1 hour"), "settled")
            }]
          },
          payload: undefined
        }),
        { startImmediately: true }
      )

      // The engine crosses real async hops before the step's sleep registers
      // with the TestClock, so a single adjust can fire into an empty clock
      // under load and strand the sleep forever. Pump instead: flush a few
      // real milliseconds, advance a virtual hour, repeat — whichever pass
      // finds the sleep registered releases it, deterministically.
      const pump = Effect.forever(
        TestClock.withLive(Effect.sleep("5 millis")).pipe(
          Effect.andThen(TestClock.adjust("1 hour"))
        )
      )

      expect(yield* Effect.raceFirst(Fiber.join(running), pump)).toMatchObject({
        status: "completed",
        value: "settled"
      })
    }).pipe(Effect.provide(subject)))

  // Pins the payload boundary: the engine stores a payload through the flow's
  // own JSON codec, and `undefined` is not a JSON value. A run started with no
  // payload must therefore reach the step as `undefined` and settle, rather
  // than dying inside the codec before the flow ever starts.
  it.scoped("starts a flow that was given no payload", () =>
    Effect.gen(function*() {
      const engine = yield* EngineSubject.EngineSubject
      const seen: Array<unknown> = []

      const result = yield* engine.run({
        flow: {
          name: "testing/engine-like/absent-payload",
          steps: [{
            key: "echo",
            sealed: false,
            kind: "step",
            run: (input) =>
              Effect.sync(() => {
                seen.push(input)
                return "ran"
              })
          }]
        },
        payload: undefined
      })

      expect(seen).toEqual([undefined])
      expect(result).toMatchObject({ status: "completed", value: "ran" })
    }).pipe(Effect.provide(subject)))
})

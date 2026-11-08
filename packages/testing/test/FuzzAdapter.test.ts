import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as Internal from "../src/internal/fuzz.ts"
import { assert, it } from "../src/Vitest.ts"

// Exercise real Vitest registration with the session switch read at registration.
const previous = { selector: process.env.EFFECT_FUZZ, executions: process.env.EFFECT_FUZZ_EXECUTIONS }
process.env.EFFECT_FUZZ = "adapter session"
process.env.EFFECT_FUZZ_EXECUTIONS = "2"
let calls = 0
it.effect.fuzz("adapter session uses its id and explicit timeout", [Schema.Int], () =>
  Effect.sync(() => {
    calls++
    return true
  }), { id: "adapter/session", revision: "1", timeout: 10_000 })
it.fuzz("adapter session chooses its timeout", [Schema.String], () => true)
if (previous.selector === undefined) delete process.env.EFFECT_FUZZ
else process.env.EFFECT_FUZZ = previous.selector
if (previous.executions === undefined) delete process.env.EFFECT_FUZZ_EXECUTIONS
else process.env.EFFECT_FUZZ_EXECUTIONS = previous.executions
it("the session budget ran two evaluations", () => assert.strictEqual(calls, 2))
it("effect forwards its ordinary chainable members", () => assert.isFunction(it.effect.skip))

it.effect("a stale regression is reported explicitly", () =>
  Effect.gen(function*() {
    const store = Fuzz.memoryCorpus()
    const first = Fuzz.target(Arbitrary.Constant(1), () => false, { id: "stale", revision: "1" })
    yield* Fuzz.runTarget(first, { executions: 1 }).pipe(Effect.provideService(Fuzz.Corpus, store))
    const changed = Fuzz.target(Arbitrary.Constant(2), () => true, { id: "stale", revision: "2" })
    const messages: string[] = []
    yield* Internal.runFuzz(changed, store, undefined, undefined, (message) =>
      Effect.sync(() => {
        messages.push(message)
      }))
    assert.deepStrictEqual(messages, ["Replayed 0 saved failure(s) of stale; skipped 1 stale tape(s)"])
  }))

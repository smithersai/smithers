import { FuzzSimulation } from "@smthrs/fuzz"
import { Bounded, Saga } from "@smthrs/patterns"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"

describe("@smthrs/patterns concurrency & compensation fuzz (FuzzSimulation)", () => {
  it.effect.fuzz(
    "Bounded.run never exceeds concurrency limit across arbitrary fiber interleavings",
    [
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))
    ],
    ([concurrency, count]) =>
      Effect.gen(function*() {
        let active = 0
        let maxSeen = 0
        const members: Record<string, Effect.Effect<number>> = {}
        for (let i = 0; i < count; i++) {
          members[`m${i}`] = Effect.gen(function*() {
            active++
            if (active > maxSeen) maxSeen = active
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            active--
            return i * 10
          })
        }
        const results = yield* Bounded.run(members, { concurrency })
        expect(maxSeen).toBeLessThanOrEqual(concurrency)
        expect(active).toBe(0)
        for (let i = 0; i < count; i++) {
          expect(results[`m${i}`]).toBe(i * 10)
        }
        return true
      }),
    { fuzz: { execution: FuzzSimulation.execution({ maxSteps: 100_000 }) } }
  )

  it.effect.fuzz(
    "Saga.run compensates completed steps in exact reverse order when step k fails",
    [
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 })),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 }))
    ],
    ([totalSteps, rawFailAt]) =>
      Effect.gen(function*() {
        const failAt = rawFailAt <= totalSteps ? rawFailAt : -1
        const compensated: Array<string> = []
        const steps = Array.from({ length: totalSteps }, (_, idx) => ({
          id: `s${idx}`,
          action: (acc: number) =>
            idx === failAt
              ? Effect.fail(`boom-${idx}`)
              : Effect.yieldNow.pipe(Effect.as(acc + 1)),
          compensation: () =>
            Effect.sync(() => {
              compensated.push(`s${idx}`)
            })
        }))

        const exit = yield* Effect.exit(Saga.run(0, { steps }))
        if (failAt >= 0 && failAt < totalSteps) {
          // Steps 0..failAt-1 succeeded and MUST be compensated in exact reverse order!
          const expectedReverse = Array.from({ length: failAt }, (_, i) => `s${failAt - 1 - i}`)
          expect(compensated).toEqual(expectedReverse)
        } else {
          expect(exit._tag).toBe("Success")
          expect(compensated).toEqual([])
        }
        return true
      }),
    { fuzz: { execution: FuzzSimulation.execution({ maxSteps: 100_000 }) } }
  )
})

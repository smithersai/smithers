import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { Journal } from "../src/Journal.vibe"
import * as JournalLive from "../src/Journal.vibe"
import * as Notifying from "../src/test/Notifying.ts"

const record = (log: Array<string>): Notifying.Hook => (op, order, args) =>
  Effect.sync(() => {
    log.push(`${op}:${order}:${args.length}`)
  })

describe("Notifying", () => {
  it.effect("fires the hook around Effect-valued methods and plain Effect properties", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const service = {
        lookup: (key: string) => Effect.succeed(`value-${key}`),
        ready: Effect.succeed("ready"),
        // Non-Effect members delegate untouched, so a `Stream`-returning method
        // keeps working through the wrapper.
        watch: () => Stream.make(1, 2),
        label: "plain"
      }
      const wrapped = Notifying.wrap(service, record(log))

      expect(yield* (wrapped.lookup("a"))).toBe("value-a")
      expect(yield* (wrapped.ready)).toBe("ready")
      expect(yield* (Stream.runCollect(wrapped.watch()))).toEqual([1, 2])
      expect(wrapped.label).toBe("plain")
      expect(log).toEqual(["lookup:before:1", "lookup:after:1", "ready:before:0", "ready:after:0"])
    }))

  it.effect("skips the `after` firing when the delegated operation fails", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const wrapped = Notifying.wrap({ boom: () => Effect.fail("nope") }, record(log))

      expect(yield* (Effect.flip(wrapped.boom()))).toBe("nope")
      expect(log).toEqual(["boom:before:0"])
    }))

  it.effect("re-provides a real service under the same key as a layer", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const layer = Notifying.layer(Journal, record(log)).pipe(
        Layer.provide(
          Layer.succeed(Journal)(JournalLive.makeNoop({
            emitLossy: () =>
              Effect.succeed({ _tag: "Dropped", seq: 0, sourceSeq: 0, policy: "drop-newest" } as JournalLive.Dropped)
          }))
        )
      )

      yield* (
        Effect.gen(function*() {
          const journal = yield* Journal
          yield* journal.emitLossy({} as never)
        }).pipe(Effect.provide(layer))
      )

      expect(log).toEqual(["emitLossy:before:1", "emitLossy:after:1"])
    }))
})

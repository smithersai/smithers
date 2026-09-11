import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as ActiveRuns from "../src/internal/ActiveRuns.ts"

const run = <A>(body: (active: ActiveRuns.ActiveRuns) => Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(Effect.flatMap(ActiveRuns.make, body))

describe("ActiveRuns", () => {
  it("answers undefined for a trigger no occurrence has taken", async () => {
    expect(await run((active) => active.get("hourly"))).toBeUndefined()
  })

  it("lets the occurrence that took an entry update and remove it", async () => {
    const [updated, removed] = await run((active) =>
      Effect.gen(function*() {
        yield* active.take("hourly", { occurrence: 1, runId: "reservation:1" })
        yield* active.update("hourly", 1, (entry) => ({ ...entry, runId: "run-1" }))
        const updated = yield* active.get("hourly")
        yield* active.remove("hourly", 1)
        return [updated, yield* active.get("hourly")] as const
      })
    )
    expect(updated).toEqual({ occurrence: 1, runId: "run-1" })
    expect(removed).toBeUndefined()
  })

  it("ignores every write from an occurrence that no longer owns the entry", async () => {
    const [superseded, missing] = await run((active) =>
      Effect.gen(function*() {
        yield* active.take("hourly", { occurrence: 1, runId: "run-1" })
        // A supersede takes the entry for the next occurrence. The first
        // launch's late start and its finalizer must not touch the new entry.
        yield* active.take("hourly", { occurrence: 2, runId: "reservation:2" })
        yield* active.update("hourly", 1, (entry) => ({ ...entry, runId: "run-1" }))
        yield* active.remove("hourly", 1)
        const superseded = yield* active.get("hourly")
        yield* active.update("daily", 1, (entry) => ({ ...entry, runId: "run-1" }))
        return [superseded, yield* active.get("daily")] as const
      })
    )
    expect(superseded).toEqual({ occurrence: 2, runId: "reservation:2" })
    expect(missing).toBeUndefined()
  })

  it("keeps each trigger's entry apart", async () => {
    const entries = await run((active) =>
      Effect.gen(function*() {
        yield* active.take("hourly", { occurrence: 1, runId: "run-1" })
        yield* active.take("daily", { occurrence: 1, runId: "run-2" })
        yield* active.remove("hourly", 1)
        return [yield* active.get("hourly"), yield* active.get("daily")] as const
      })
    )
    expect(entries).toEqual([undefined, { occurrence: 1, runId: "run-2" }])
  })
})

/**
 * Case 16 — five concurrent subscribers over one run's history stay inside the
 * committed memory budget.
 *
 * The process that has to stay bounded is the gateway. `servedSuite` runs it as
 * a separate operating-system process, so the subscriber queues and retained
 * histories a fan-out can grow live over there, and `process.memoryUsage()` in
 * this process cannot see any of it. The server's resident set is therefore
 * sampled by pid, and sampled while all five readers are attached rather than
 * after their reads have closed, which is when the cost is highest. The reader
 * side is measured too, under its own name.
 *
 * The numbers that matter are growth over each side's own baseline, not an
 * absolute resident set: the fault tier shares one process and the server is
 * reused across a case, so an absolute ceiling would measure the host rather
 * than the fan-out. The budgets live in `test/faults/budgets/memory.json` and
 * are read, never restated here, so widening one is a reviewed diff.
 */
import { Control } from "@smthrs/control"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { loadBudget, type MemoryBudget } from "./budgets/loadBudget.ts"
import { residentBytes } from "./harness/residentBytes.ts"
import { emitSignals, launchRun } from "./harness/servedRun.ts"
import { servedSuite } from "./harness/servedSuite.ts"

const suite = servedSuite("case16")
const budget = loadBudget<MemoryBudget>("memory")
const subscribers = 5
const events = 500
/** Samples taken after every subscriber holds the whole history. */
const settledSamples = 4

beforeAll(() => suite.start(), 180_000)
afterAll(() => suite.stop())

const settle = async (): Promise<void> => {
  globalThis.gc?.()
  await new Promise((resolve) => setTimeout(resolve, 250))
}

describe("case16 five subscribers, bounded memory", () => {
  it("fans one run's journal out to five readers inside the RSS budget", async () => {
    const runId = await suite.remote(
      Effect.gen(function*() {
        const run = yield* launchRun("case16", suite.server().root)
        yield* emitSignals(run.runId, events)
        return run.runId
      })
    )

    const pid = suite.server().pid
    await settle()
    const serverBaseline = await residentBytes(pid)
    const clientBaseline = process.memoryUsage().rss

    const measured = await suite.remote(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const seen = Array.from({ length: subscribers }, () => 0)
        let peak = 0
        let samples = 0
        const sample = Effect.gen(function*() {
          const rss = yield* Effect.promise(() => residentBytes(pid))
          peak = Math.max(peak, rss)
          samples += 1
        })

        // Following readers, so every one of them is still subscribed while the
        // server is sampled. A finite read would have closed first and the
        // sample would be of an idle server.
        const readers = yield* Effect.forEach(seen.map((_, index) => index), (index) =>
          Effect.forkChild(
            control.watch({ runId }).pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  seen[index] = seen[index]! + 1
                })
              ),
              Stream.runDrain
            ),
            { startImmediately: true }
          ))

        yield* Effect.gen(function*() {
          while (seen.some((count) => count < events)) {
            yield* sample
            yield* Effect.sleep(25)
          }
        }).pipe(Effect.timeout("120 seconds"))

        // All five now hold the whole history and none has let go.
        for (let index = 0; index < settledSamples; index += 1) {
          yield* sample
          yield* Effect.sleep(25)
        }

        yield* Effect.forEach(readers, (reader) => Fiber.interrupt(reader))
        return { counts: [...seen], peak, samples }
      })
    )

    const serverGrowth = measured.peak - serverBaseline
    const clientGrowth = process.memoryUsage().rss - clientBaseline

    // Every subscriber genuinely read the whole run, so the measurement is of
    // work that happened.
    expect(measured.counts).toHaveLength(subscribers)
    for (const count of measured.counts) expect(count).toBeGreaterThanOrEqual(events)
    // And the server was sampled, repeatedly, during that work.
    expect(measured.peak).toBeGreaterThan(0)
    expect(measured.samples).toBeGreaterThan(settledSamples)
    expect(serverGrowth).toBeLessThan(budget.subscriberFanoutN5.serverRssGrowthBytesMax)
    expect(clientGrowth).toBeLessThan(budget.subscriberFanoutN5.clientRssGrowthBytesMax)
  })
})

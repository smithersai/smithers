/**
 * Case 1 — the engine is `SIGKILL`ed with an action in flight, and the run that
 * comes back settles exactly once.
 *
 * The action that was interrupted re-runs, because nothing durable said it
 * finished. The action that had already committed does NOT re-run, because
 * something durable said it did. Both halves are read out of an append-only
 * file the killed process could not have rewritten, and out of the run's own
 * journal.
 */
import { killProcess } from "@smthrs/testing/Faults"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { journalEventTypes } from "./harness/durableState.ts"
import { probeEngineChild, reapEngineChildren, spawnEngineChild, waitForEngine } from "./harness/engineChild.ts"
import { killResumeFixture } from "./harness/killResumeCase.ts"
import { firstStep, markers, secondStep } from "./harness/killResumeFlow.ts"

const fixture = killResumeFixture("case01", 60_000)
afterAll(async () => {
  await reapEngineChildren()
  rmSync(fixture.directory, { recursive: true, force: true })
})

describe("case01 kill the engine mid-action", () => {
  it("settles exactly once after a real SIGKILL", async () => {
    // Admission: the runner boots the shipped product against this database
    // before anything claims a kill proved something about it.
    await probeEngineChild({ ...fixture })

    try {
      const engine = spawnEngineChild({ ...fixture, mode: "execute" })
      await engine.handshake
      await waitForEngine(
        engine,
        () => fixture.marker(markers.secondStarted) !== undefined,
        "the second action to start",
        60_000
      )

      // The first action committed; the second is genuinely in flight.
      expect(fixture.marker(markers.firstDone)).toBeDefined()
      expect(fixture.marker(markers.secondDone)).toBeUndefined()
      expect(fixture.counter()).toEqual([firstStep, secondStep])

      await killProcess(engine.process)
      expect(fixture.marker(markers.secondDone)).toBeUndefined()

      const resumed = spawnEngineChild({ ...fixture, mode: "execute", secondSleepMs: 10 })
      expect(await resumed.exited, `${resumed.stderr()}\n${resumed.stdout()}`).toBe(0)
      expect(resumed.stdout()).toContain("RESULT_STATUS=succeeded kill-resume:first-value:second-value")

      // Exactly-once settlement: the committed action was replayed rather than
      // re-dispatched, and the interrupted one ran again.
      const counter = fixture.counter()
      expect(counter.filter((step) => step === firstStep)).toEqual([firstStep])
      expect(counter.filter((step) => step === secondStep)).toEqual([secondStep, secondStep])

      // The run's own history agrees: three steps, three attempts started, three
      // attempts finished. A replayed sealed result adds no fourth attempt, and
      // the interrupted attempt has exactly one recorded finish rather than two.
      const events = await journalEventTypes(fixture.filename, fixture.executionId, 5_000)
      expect(events.filter((type) => type === "flows.engine.attempt-started")).toHaveLength(3)
      expect(events.filter((type) => type === "flows.engine.attempt-finished")).toHaveLength(3)
    } finally {
      await reapEngineChildren()
    }
  }, 300_000)
})

import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import { main } from "../src/38-monitor-and-alert.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.effect("monitors a real event wait without healing or paging about a healthy run", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "monitor.sqlite"))

    // A park is a wait, not a wedge: the run whose approval arrived came back
    // and finished with the value that resolved it.
    expect(summary.answered).toEqual({ approved: true })

    // The unanswered run is parked on the engine, and the control plane reads
    // the waiting reason the engine wrote on its row.
    expect(summary.parked).toBe("parked")
    expect(summary.waitingFor).toBe("event")

    // Health.waitReason recognizes an event wait. Even after the stall
    // threshold, that documented wait is healthy, not a wedged action.
    expect(summary.beats).toEqual(["healthy", "healthy", "healthy", "healthy"])
    expect(summary.healed).toBeUndefined()

    // Neither a production delay nor a zero-delay policy may page about a
    // healthy wait. Repeated ticks leave the real notification queue empty.
    expect(summary.quiet).toBe(0)
    expect(summary.paged).toEqual([])
    expect(summary.repaged).toBe(0)
    expect(summary.pending).toEqual([])
  }))

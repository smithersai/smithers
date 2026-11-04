import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../../examples/06-time-travel-rewind.vibe"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.effect("re-derives state at a frame and rewinds the journal suffix", () =>
  Effect.gen(function*() {
    const summary = yield* (main(join(directory, "ledger.sqlite")))
    // Folded from an ORDINARY engine journal: nothing in the example writes
    // `meta.lineageId`, the engine does.
    expect(summary.derivedAttempts).toBeGreaterThan(0)

    // The rewind keeps the frame and archives only what followed it, so the
    // journal that survives is exactly the committed prefix through the frame.
    const prefix = summary.beforeSeqs.filter((seq) => seq <= summary.frameSeq)
    const suffix = summary.beforeSeqs.filter((seq) => seq > summary.frameSeq)
    expect(prefix).toContain(summary.frameSeq)
    expect(suffix.length).toBeGreaterThan(0)
    expect(summary.remainingSeqs).toEqual(prefix)
    expect(summary.archivedCount).toBe(suffix.length)
    // Truncation is a database write: a store opened afterwards reads the same
    // prefix, so nothing beyond the frame survives a restart either.
    expect(summary.persistedSeqs).toEqual(prefix)
    expect(summary.auditStatus).toBe("completed")
  }))

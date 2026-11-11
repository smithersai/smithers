import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bank, main } from "../../examples/26-memory-recall.vibe"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("spells the policy namespace as the bank recall accepts", () => {
  expect(bank).toBe("flow-release-notes")
})

it.live("recalls in a later run what an earlier run wrote, and honours both refusals", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "memory.sqlite"))

    // Six durable runs, each one a step the model was asked to do.
    expect(summary.asked).toEqual(["record", "recall", "foreign", "recall", "forget", "recall"])

    expect(summary.written).toEqual(["changelog-format", "release-cadence", "review-owner"])

    // Run 2 is a separate durable execution. It was handed nothing but the
    // database, and it found what run 1 wrote.
    //
    // Two of the three facts carry both query terms; the third mentions the
    // notes without the word "release", so the index leaves it out. The ranking
    // is FTS5's, not this example's: "release-cadence" says "release" twice, so
    // it scores above the entry that says it once.
    expect(summary.recalled).toEqual(["release-cadence", "changelog-format"])

    // It really was a run: the engine journalled an attempt for it.
    expect(summary.eventTypes).toContain("flows.engine.attempt-started")

    // A bank nothing was written to answers nothing: a namespace is a boundary,
    // not a hint.
    expect(summary.foreign).toEqual([])

    // `recall: "none"` is a refusal, so the request never reaches the service.
    // The only difference between this run and run 2 is the policy the bound
    // declaration carries.
    expect(summary.refusedRecall).toEqual([])

    // `retain: "never"` still answers with the key the caller asked for, and
    // stores nothing a later run can find.
    expect(summary.droppedWriteKey).toBe("never-stored")
    expect(summary.droppedWriteStored).toBe(false)
  }), { timeout: 60_000 })

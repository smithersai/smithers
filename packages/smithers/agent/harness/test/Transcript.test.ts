/**
 * Resume compatibility validation keeps current agent journals readable and
 * refuses history whose version cannot safely address sealed model steps.
 */
import { Result } from "effect"
import { expect, it } from "vitest"
import * as Transcript from "../src/Transcript.ts"
import { entry } from "./fixtures/journal.ts"

it("validates current session journals while leaving unrelated control history alone", () => {
  expect(Result.isSuccess(Transcript.validateJournal([
    entry(1, "control.run.started", {}),
    entry(2, "control.agent.discipline-armed", { journalVersion: Transcript.journalVersion })
  ]))).toBe(true)
})

it("selects the entries it validates through the prefix the writer is typed against", () => {
  // `@smthrs/agent` writes these entries and types every event type it emits
  // as `Transcript.ControlEventType`, so the two sides cannot drift: renaming
  // the constant fails that package's typecheck instead of silently emptying
  // the set this filter selects.
  expect(Transcript.controlEventPrefix).toBe("control.agent.")

  const stale = { journalVersion: Transcript.journalVersion - 1 }
  expect(Result.isFailure(
    Transcript.validateJournal([entry(1, `${Transcript.controlEventPrefix}turn-opened`, stale)])
  )).toBe(true)
  expect(Result.isSuccess(
    Transcript.validateJournal([entry(1, "control.run.turn-opened", stale)])
  )).toBe(true)
})

it.each([null, "invalid", {}, { journalVersion: 1 }, { journalVersion: 999 }])(
  "refuses incompatible session payload %j",
  (payload) => {
    const result = Transcript.validateJournal([entry(1, "control.agent.compaction-settled", payload)])
    expect(Result.isFailure(result) && result.failure.code).toBe("incompatible_journal")
  }
)

import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { replayRecordedResult } from "../examples/replay-recorded-result.vibe"

it.effect("runs the recorded-result example against the real store", () =>
  Effect.gen(function*() {
    const result = yield* replayRecordedResult
    expect(result.first).toEqual({ _tag: "Inserted" })
    expect(result.evicted).toBe(true)
    expect(result.replacement).toEqual({ _tag: "Inserted" })
    expect(Option.getOrThrow(result.head)).toMatchObject({
      result: { value: "replacement" },
      recordedRunId: "second-run",
      createdAtMs: 2
    })
    expect(Option.getOrThrow(result.recorded)).toMatchObject({
      result: { value: "original" },
      recordedRunId: "first-run",
      createdAtMs: 1
    })
  }))

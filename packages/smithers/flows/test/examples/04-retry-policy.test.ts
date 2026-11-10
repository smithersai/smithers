import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fatalDecision, ladder, main } from "../../examples/04-retry-policy.vibe"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("computes the backoff ladder from policy data alone", () => {
  expect(ladder).toEqual([100, 200, 400, null])
  expect(fatalDecision).toEqual({ _tag: "GiveUp", reason: "nonRetryable" })
})

it.effect("retries a flaky action until it succeeds", () =>
  Effect.gen(function*() {
    const summary = yield* (main(join(directory, "publish.sqlite")))
    expect(summary.result).toBe("v1:uploaded")
    expect(summary.dispatches).toBe(3)
    expect(summary.attempts).toEqual([1, 2, 3])
  }))

import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import { main } from "../../examples/39-agent-policies.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

// `it.live` rather than `it.effect`: the park is a real durable wait and the
// restart polls the engine's own waiting view, so the run needs the wall clock.
it.live(
  "parks on a quota refusal, resumes on a second engine, and spends one correction",
  () =>
    Effect.gen(function*() {
      const summary = yield* main(join(directory, "policies.sqlite"))

      expect(summary.review).toEqual({ approved: true, issues: [] })
      // The refusal happened before the restart and was never re-issued: three
      // provider calls in all, one of them before the engine was killed.
      expect(summary.callsBeforeTheRestart).toBe(1)
      expect(summary.providerCalls).toBe(3)
      // One recorded park decision, replayed by the second engine rather than
      // classified afresh, and its wake time is what the operator's waiting view
      // showed.
      expect(summary.parks).toBe(1)
      expect(summary.wakeAt).toBeGreaterThan(0)
      // One correction: the first answer after the wake was not the schema.
      expect(summary.corrections).toBe(1)
      // The budget accounted every call it let through.
      expect(summary.budgetWarnings).toBeGreaterThan(0)
    }),
  60_000
)

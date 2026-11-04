import { Clock, Effect, Exit, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { describe, expect, test } from "vitest"
import { createHostDiagnostics } from "../src/HostDiagnostics.vibe"

describe("host diagnostics lifetime", () => {
  test("refuses a diagnostic sink without injected host services", () => {
    expect(() => createHostDiagnostics({ write: () => {} })).toThrow(
      "Host diagnostics require an Effect clock and scope"
    )
  })
  test("uses the injected clock and stops pending reports when its scope closes", async () => {
    const lines: Array<{ phase: string; pendingMillis?: number }> = []
    await Effect.runPromise(
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const diagnostics = createHostDiagnostics({
          runtime: { clock: yield* Clock.Clock, scope },
          write: (line) => lines.push(JSON.parse(line)),
          pendingMillis: 100
        })
        yield* diagnostics.begin("chat_callback")
        yield* TestClock.adjust(100)
        expect(lines.filter((line) => line.phase === "pending")).toEqual([
          expect.objectContaining({ pendingMillis: 100 })
        ])
        yield* Scope.close(scope, Exit.void)
        yield* TestClock.adjust(500)
        expect(lines.filter((line) => line.phase === "pending")).toHaveLength(1)
        expect(yield* Clock.currentTimeMillis).toBe(600)
      }).pipe(Effect.provide(TestClock.layer()))
    )
  })
})

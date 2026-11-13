/**
 * Runs the live Gemini example only when explicitly requested.
 *
 * @since 0.1.0
 */
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

const hasKey = process.env.GEMINI_API_KEY !== undefined && process.env.GEMINI_API_KEY !== ""
const liveEnabled = process.env.SMITHERS_LIVE_EXAMPLES === "1"

it.effect.skipIf(!liveEnabled || !hasKey)(
  "runs the real Gemini stack (requires SMITHERS_LIVE_EXAMPLES=1 and GEMINI_API_KEY)",
  () =>
    Effect.gen(function*() {
      // Collection checks the opt-in gate without loading the native stack.
      const { main } = yield* Effect.promise(() => import("../../examples/14-agent-live-smoke-gemini.ts"))
      const result = yield* main("What is 2+2? Reply with just the digit.")
      expect(result.answer.length).toBeGreaterThan(0)
    }),
  300_000
)

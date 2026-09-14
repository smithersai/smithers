/**
 * Runs the live OpenAI example only when explicitly requested.
 *
 * @since 0.1.0
 */
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

const hasKey = process.env.OPENAI_API_KEY !== undefined && process.env.OPENAI_API_KEY !== ""
const liveEnabled = process.env.SMITHERS_LIVE_EXAMPLES === "1"

it.effect.skipIf(!liveEnabled || !hasKey)(
  "runs the real OpenAI stack (requires SMITHERS_LIVE_EXAMPLES=1 and OPENAI_API_KEY)",
  () =>
    Effect.gen(function*() {
      // Collection checks the opt-in gate without loading the native stack.
      const { main } = yield* Effect.promise(() => import("../src/12-agent-live-smoke.ts"))
      const result = yield* main("What is 2+2? Reply with just the digit.")
      // eslint-disable-next-line no-console
      console.log("LIVE MODEL ANSWER:", JSON.stringify(result))
      expect(result.answer.length).toBeGreaterThan(0)
    }),
  300_000
)

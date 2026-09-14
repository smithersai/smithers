/**
 * Runs the local model example only when explicitly requested.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import { expect, it } from "vitest"

const liveEnabled = process.env.SMITHERS_LIVE_EXAMPLES === "1"
const seatModel = "qwen2.5:7b"
const daemon = "http://localhost:11434"

/**
 * The answer has to decode, three times, against the step's declared schema.
 *
 * One run proves nothing here, because both defects this pins were
 * intermittent. The model answered `ctx.done("Paris")`, a sentence instead of a
 * document, and the example failed with `"Paris" is not valid JSON`; and,
 * more often, it spent all eight frames writing prose and never called
 * `ctx.done` at all, which failed the step with `model_failed`, "ended
 * without a completed answer". Three runs a suite is the cheap standing
 * check; the example's own header records the 60 direct runs and 12 suite
 * runs that measured the fix.
 */
it.skipIf(!liveEnabled)(
  "decodes each local agent answer (requires SMITHERS_LIVE_EXAMPLES=1 and Ollama qwen2.5:7b)",
  async (ctx) => {
    // Probe only after opt-in so ordinary collection never contacts a provider.
    const pulled = await fetch(`${daemon}/api/tags`, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.json() as Promise<{ models?: ReadonlyArray<{ name: string }> }>)
      .then((body) => (body.models ?? []).some((model) => model.name === seatModel))
      .catch(() => false)
    if (!pulled) ctx.skip(`Requires Ollama at ${daemon} with ${seatModel} pulled`)

    // Collection checks the opt-in gate without loading the native stack.
    const { main } = await import("../src/13-agent-live-smoke-local.ts")
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await Effect.runPromise(main("What is the capital of France? Answer in one word."))
      expect(result.answer).toMatch(/paris/i)
    }
  },
  300_000
)

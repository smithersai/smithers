/**
 * Refuses a missing Gemini key before constructing provider services.
 *
 * @since 0.1.0
 */
import { expect, it } from "vitest"

it("refuses an explicitly empty Gemini key before building the live stack", async () => {
  const { main } = await import("../../examples/14-agent-live-smoke-gemini.ts")
  expect(() => main("What is 2+2?", undefined, "")).toThrow(
    "Set GEMINI_API_KEY to run this live smoke test"
  )
})

it.skipIf(process.env.GEMINI_API_KEY !== undefined && process.env.GEMINI_API_KEY !== "")(
  "refuses a missing ambient Gemini key up front",
  async () => {
    const { main } = await import("../../examples/14-agent-live-smoke-gemini.ts")
    expect(() => main("What is 2+2?")).toThrow(
      "Set GEMINI_API_KEY to run this live smoke test"
    )
  }
)

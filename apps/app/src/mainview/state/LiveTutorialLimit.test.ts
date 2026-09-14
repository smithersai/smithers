import { expect, test } from "bun:test"
import { liveTutorialLimitMessage } from "./LiveTutorialLimit"

test("a limit uses the typed refusal copy and a reset on the viewer's labelled local clock", () => {
  const previous = process.env.TZ
  process.env.TZ = "America/Los_Angeles"
  try {
    const text = liveTutorialLimitMessage({ kind: "rate-limit", code: "turn_rate_limited", retryAt: Date.parse("2030-01-02T00:00:00Z") })
    expect(text).toContain("nothing was charged")
    expect(text).toContain("Jan 1, 2030")
    expect(text).toContain("4:00 PM PST")
    expect(text).not.toContain("UTC")
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

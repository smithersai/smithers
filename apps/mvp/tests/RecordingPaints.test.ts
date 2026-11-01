// @vitest-environment happy-dom
import { expect, test } from "vitest"
import { FPS } from "../e2e/frames"
import { waitForRecordingPaints } from "../e2e/fullPageScreenshot"

test("paint acknowledgments span two recording sample slots", async () => {
  const from = performance.now()
  await waitForRecordingPaints(FPS)
  expect(performance.now() - from).toBeGreaterThanOrEqual(2 * 1000 / FPS)
})

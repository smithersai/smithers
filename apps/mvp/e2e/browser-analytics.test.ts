import { expect, test } from "vitest"
import { onlyBeaconFailures } from "./browser-analytics.ts"

test("only the injected beacon 404 can make the known-broken smoke expected", () => {
  const beacon = "console 404 /cdn-cgi/rum: Failed to load resource ×1"
  expect(onlyBeaconFailures([beacon])).toBe(true)
  expect(onlyBeaconFailures([beacon, "console 404 /cdn-cgi/rum?x=1: Failed to load resource ×2"])).toBe(true)
  // No failure produces an unexpected pass, so removing the broken marker is required after the fix.
  expect(onlyBeaconFailures([])).toBe(true)
  for (const other of [
    "console 404 /api/repos/a/b: Failed to load resource ×1",
    "console 500 /cdn-cgi/rum: Failed to load resource ×1",
    "page error: application failed ×1",
    "console error: Access-Control failure ×1",
    "console 404 /cdn-cgi/rum-extra: Failed to load resource ×1",
  ]) expect(onlyBeaconFailures([beacon, other])).toBe(false)
})

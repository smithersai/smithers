/**
 * Checks for the story `expect` matcher shared by every card contract.
 * @since 1.0.0
 */

import { expect, test } from "vitest"
import { carries } from "./cardContract.ts"

test("a story expects a whole carried number, not digits inside a larger one", () => {
  // Settings' raised-allowance story expects "20"; its model also carries postgres_bytes 734_003_200.
  expect(carries([734_003_200], "20")).toBe(false)
  expect(carries([734_003_200, 20], "20")).toBe(true)
})

test("a story expects text inside a carried string, ignoring case", () => {
  expect(carries(["Close apps to free 6 GB"], "close apps")).toBe(true)
  expect(carries(["Close apps to free 6 GB"], "12 GB")).toBe(false)
})

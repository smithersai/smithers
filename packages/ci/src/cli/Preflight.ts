/**
 * What the program asks the model before a replay that needs it: one change
 * and one target, the smallest question the model can answer.
 *
 * @since 0.1.0
 */

import type { Row } from "../contract/Selection.ts"

/**
 * The row of the question. It describes no real change and is never recorded.
 *
 * @category constants
 * @since 0.1.0
 */
export const row: Row = {
  commit: "preflight",
  target: "//preflight:test",
  features: {
    extensions: [".ts"],
    fileChanges: { d3: 0, d14: 0, d56: 0 },
    failureRates: { d7: 0, d14: 0, d28: 0, d56: 0 },
    project: "preflight",
    testCount: 1,
    graphDistance: 0
  },
  attempts: [true],
  failed: false,
  flaky: false
}

/**
 * What a person can do instead of supplying the model.
 *
 * @category constants
 * @since 0.1.0
 */
export const withoutTheModel = "Or run with --mode normal, which does not use it."

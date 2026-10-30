/** Typed refusal for affected gates absent from their execution receipt.
 * @since 1.0.0
 */

import * as Data from "effect/Data"
import * as Affected from "../Affected.ts"

/**
 * Names every selected gate that has no planned execution result.
 * @category errors
 * @since 1.0.0
 */
export class UnrecordedGates extends Data.TaggedError("smithers-build/UnrecordedGates")<{
  readonly labels: ReadonlyArray<string>
  readonly message: string
}> {}

/**
 * Refuses a successful affected result that has no receipt for a selected gate.
 * @category guards
 * @since 1.0.0
 */
export const requireRecorded = (
  labels: ReadonlyArray<string>,
  summary: { readonly results: ReadonlyArray<{ readonly label: string }> },
  prefix = "Affected gates were never planned"
): void => {
  const missing = Affected.unrecorded(labels, summary)
  if (missing.length > 0) {
    throw new UnrecordedGates({
      labels: missing,
      message: `${prefix}: ${missing.join(", ")}`
    })
  }
}

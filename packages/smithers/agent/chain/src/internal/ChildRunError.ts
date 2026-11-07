/**
 * The typed failure bridge between recursive runs and catalog handlers.
 *
 * @since 0.1.0
 */

import type { Effect } from "effect"
import * as Catalog from "../Catalog.ts"
import type * as Chain from "../Chain.ts"

/**
 * Carries a child run's original typed failure across the catalog boundary.
 *
 * @private
 * @since 0.1.0
 */
export class ChildRunError extends Catalog.CallError {
  declare readonly error: Effect.Error<ReturnType<typeof Chain.run>>

  static new(error: Effect.Error<ReturnType<typeof Chain.run>>): ChildRunError {
    return Object.assign(
      new ChildRunError({ cause: error.code, message: `${error._tag}: ${error.message}`, name: "agent" }),
      { error }
    )
  }
}

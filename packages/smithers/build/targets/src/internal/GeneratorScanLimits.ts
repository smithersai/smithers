/**
 * Host scan budgets for generator output snapshots.
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import type * as Input from "../Input.ts"

/**
 * Optional host policy; production shares the workspace discovery ceilings.
 * @since 1.0.0
 * @private
 */
export const GeneratorScanLimits = Context.Reference<
  Pick<Input.ScanLimits, "depth" | "directories" | "entries" | "files"> | undefined
>(
  "@smthrs/targets/internal/GeneratorScanLimits",
  { defaultValue: () => undefined }
)

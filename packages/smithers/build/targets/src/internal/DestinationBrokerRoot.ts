/**
 * Where a confined run's destination broker keeps its private directory; ordinary runs use the one bubblewrap masks.
 * @since 1.0.0
 */

import * as Context from "effect/Context"

/** The directory a destination broker is made under, or `undefined` for `/tmp/.smthrs-egress`, the tree bubblewrap
 * masks. A run handed a broker anywhere else is refused before its tool starts.
 * @since 1.0.0
 * @private
 */
export const DestinationBrokerRoot = Context.Reference<string | undefined>(
  "@smthrs/targets/internal/DestinationBrokerRoot",
  { defaultValue: () => undefined }
)

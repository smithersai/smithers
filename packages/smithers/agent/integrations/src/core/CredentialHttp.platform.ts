/**
 * The host `Headers` constructor behind the package's response-header readers.
 *
 * @since 1.0.0
 */

import type * as Headers from "effect/http/Headers"

/**
 * A response's headers as a web `Headers`; every name and value came from a
 * response already parsed, so the constructor accepts all of them.
 *
 * @throws {never}
 * @since 1.0.0
 */
export const webHeaders = (headers: Headers.Headers): globalThis.Headers =>
  new globalThis.Headers(Object.entries(headers))

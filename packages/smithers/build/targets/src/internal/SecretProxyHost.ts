/**
 * Optional secret-proxy host capability; ordinary runs use the native adapter.
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import type * as SecretProxy from "../SecretProxy.ts"

/** Host proxy lifecycle used by the execution boundary.
 * @since 0.1.0
 * @private
 */
export const SecretProxyHost = Context.Reference<Pick<typeof SecretProxy, "startProxy"> | undefined>(
  "@smthrs/targets/internal/SecretProxyHost",
  { defaultValue: () => undefined }
)

/**
 * Redacts transport defects before native RPC serialization.
 * @since 1.0.0-rc.17
 */

import { Predicate, Schema } from "effect"
import type { RpcSerialization } from "effect/rpc"
import { ControlDefect } from "../ControlRpcs.ts"

/**
 * Protocol defects bypass individual procedures' declared defect schemas.
 * @private
 * @since 1.0.0-rc.17
 */
export const protectProtocolDefects = (
  serialization: RpcSerialization.RpcSerialization["Service"]
): RpcSerialization.RpcSerialization["Service"] => {
  const defect = Schema.encodeSync(serialization.codecFor(ControlDefect))(undefined)
  return {
    ...serialization,
    makeUnsafe: () => {
      const parser = serialization.makeUnsafe()
      return {
        ...parser,
        encode: (response) =>
          parser.encode(
            Predicate.isTagged(response, "Defect")
              ? { ...response, defect }
              : response
          )
      }
    }
  }
}

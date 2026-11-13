/**
 * The refused-capability failure and its constructor.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"
import { Capability } from "./Capability.ts"
import { capabilitySnapshot } from "./internal/capabilitySnapshot.ts"

/**
 * A capability rejected by policy or by the current capability ceiling.
 * `permissionDenied`, `PermissionDenied.new` and `decodePermissionError` retain
 * a defensive copy rather than the caller's `Capability` instance, and make
 * the `capability` slot non-writable. The public class constructor and direct
 * Effect schema decoding do not provide these guarantees.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()(
  "@smthrs/capability/PermissionDenied",
  {
    code: Schema.Literal("permission_denied"),
    capability: Capability,
    reason: Schema.String
  }
) {
  static new(props: {
    readonly code?: "permission_denied"
    readonly capability: Capability
    readonly reason: string
  }): PermissionDenied {
    const error = new PermissionDenied({ ...props, code: "permission_denied" })
    Object.defineProperty(error, "capability", {
      value: capabilitySnapshot(props.capability),
      enumerable: true,
      writable: false,
      configurable: false
    })
    return error
  }
}

/**
 * Constructs a denied permission failure.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const permissionDenied = (capability: Capability, reason: string): PermissionDenied =>
  PermissionDenied.new({
    code: "permission_denied",
    capability,
    reason
  })

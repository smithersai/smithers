/**
 * Safe derivation of an exact grant pattern from a capability.
 *
 * @since 0.1.0
 */

import { Option } from "effect"
import { CapabilityPattern } from "./CapabilityPattern.ts"
import type { Capability } from "./ExactCapability.ts"
import { isLiteralResource } from "./isLiteralResource.ts"
import { matches } from "./matches.ts"
import { maxResourceLength } from "./maxResourceLength.ts"

/**
 * Derives an exact pattern from a capability when the glob grammar can
 * represent the resource exactly.
 *
 * The function returns `Option.none()` when the resource is longer than
 * {@link maxResourceLength} or contains `*` or `?`. The grammar has no escape
 * for those metacharacters, so returning a pattern would silently widen the
 * grant. It also refuses filesystem resources when the literal
 * pattern cannot select both the written text and its lexical normal form,
 * or when the matcher rejects the path. For example, `./src`, `src/./a`,
 * and `a/../b` are refused; `.` is accepted.
 *
 * Quotes, newlines, and other literal text are accepted. Every returned
 * pattern matches the request and nothing else; resource text and case are
 * preserved.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const patternFromCapability = (capability: Capability): Option.Option<CapabilityPattern> => {
  if (capability.resource.length > maxResourceLength || !isLiteralResource(capability.resource)) {
    return Option.none()
  }
  const pattern = new CapabilityPattern({ action: capability.action, resource: capability.resource })
  return matches(pattern, capability) ? Option.some(pattern) : Option.none()
}

/**
 * The glob matcher that decides whether a pattern selects a capability.
 *
 * @since 0.1.0
 */

import type { CapabilityPattern } from "./CapabilityPattern.ts"
import type { Capability } from "./ExactCapability.ts"
import { dotSegmentForms } from "./internal/hasDotSegment.ts"
import { matchesAction } from "./internal/matchesAction.ts"
import { matchesResource } from "./internal/matchesResource.ts"

/**
 * Tests whether an exact capability is selected by a pattern.
 *
 * Matching is textual, so a filesystem resource with a `.` or `..` segment
 * gets extra checks: an absolute one (`/w/../etc/passwd`) is selected by no
 * pattern, since adapters canonicalize before building a capability. A
 * relative declared scope (`.`, `./src/./out`, `src/a/../out`) is selected
 * only when it stays inside its start and the pattern selects both its text
 * and its lexical normal form, so `src/**` does not select `src/../../etc`.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const matches = (pattern: CapabilityPattern, capability: Capability): boolean => {
  if (!matchesAction(pattern.action, capability.action)) {
    return false
  }
  const forms = dotSegmentForms(capability.action, capability.resource)
  return forms !== undefined && forms.every((resource) => matchesResource(pattern.resource, resource))
}

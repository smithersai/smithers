/**
 * The root-independent half of grant pattern validation.
 *
 * @since 1.0.0
 */

import { type Capability, type CapabilityPattern, matches } from "@smthrs/capability/Capability"

/** Whether a resource carries a wildcard metacharacter.
 * @category validation
 * @since 1.0.0
 */
export const hasResourceWildcard = (resource: string): boolean => resource.includes("*") || resource.includes("?")

/**
 * Whether a grant pattern stays within the request it answers: the same
 * action, a pattern that selects the requested resource, and no wildcard
 * resource restated verbatim, because the grammar has no escape and its
 * wildcard reading would widen access. None of this depends on the workspace.
 *
 * @category validation
 * @since 1.0.0
 */
export const fitsRequest = (pattern: CapabilityPattern, capability: Capability): boolean =>
  pattern.action === capability.action && matches(pattern, capability) &&
  !(hasResourceWildcard(pattern.resource) && pattern.resource === capability.resource)

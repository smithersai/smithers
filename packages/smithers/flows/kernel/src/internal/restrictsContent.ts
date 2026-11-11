/**
 * Whole-directory reading of a policy for operations that move, copy or
 * delete everything under one name.
 *
 * @since 1.0.0
 */

import { CapabilityPattern, maxResourceLength, mayOverlap, subsumes } from "@smthrs/capability/Capability"
import type { Policy, PolicyRule } from "../GrantStore.ts"

// The capability matcher lets one star cross separators, so `*` covers what
// `**` covers. `subsumes` proves coverage for the `**` spelling only.
const universal = (pattern: CapabilityPattern): CapabilityPattern =>
  pattern.resource === "*" ? new CapabilityPattern({ action: pattern.action, resource: "**" }) : pattern

const coversCeiling = (ceiling: PolicyRule["ceiling"], content: CapabilityPattern): boolean =>
  ceiling.groups.every((group) => group.some((pattern) => subsumes(universal(pattern), content)))

/**
 * Decides whether a `deny` or `ask` rule may select something under
 * `directory`, so that an operation authorized on the directory's own name
 * would reach content the policy restricts.
 *
 * A restricting rule counts when its pattern may overlap `<directory>/**`.
 * `Capability.mayOverlap` answers `false` only for provable disjointness, so
 * this is the wide reading a restriction needs. A later `allow` that provably
 * covers the whole of `<directory>/**` supersedes it, as last-match-wins does
 * for each resource under the directory. A configured `deny` (the first
 * group) is a hard veto: only a later rule of that same group lifts it.
 *
 * A name containing `*` or `?` yields a pattern wider than the directory.
 * That only makes more rules count.
 *
 * `separator` is the host's path separator. Rules and resources on a Windows
 * host are spelled with `\\`, and a pattern joined with `/` there would be
 * provably disjoint from every rule under the directory.
 *
 * @category predicates
 * @since 1.0.0
 * @private
 */
export const restrictsContent = (
  policy: Policy,
  action: "fs:read" | "fs:write",
  directory: string,
  separator = "/"
): boolean => {
  const resource = `${directory.endsWith(separator) ? directory.slice(0, -1) : directory}${separator}**`
  if (resource.length > maxResourceLength) return true
  const content = new CapabilityPattern({ action, resource })
  let restricted = false
  let vetoed = false
  for (const [index, group] of policy.groups.entries()) {
    for (const { rule, ceiling } of group) {
      if (rule.effect !== "allow") {
        if (mayOverlap(rule.pattern, content)) {
          restricted = true
          vetoed = vetoed || (index === 0 && rule.effect === "deny")
        }
      } else if (coversCeiling(ceiling, content) && subsumes(universal(rule.pattern), content)) {
        restricted = false
        vetoed = vetoed && index !== 0
      }
    }
  }
  return restricted || vetoed
}

/**
 * Execution labels derived from positions in the complete declaration graph.
 *
 * @since 0.1.0
 */

import * as Target from "@smthrs/targets/Target"
import type { PackageIndex } from "../PackageIndex.ts"
import { byCodeUnit, sha256Hex } from "./Text.ts"

/**
 * Gives each private handle the first canonical declaration path that reaches
 * it. Named declarations anchor their own paths; selection and execution order
 * never enter identity. Base dependencies precede verb-only dependencies.
 *
 * @private
 * @since 0.1.0
 */
export const declarationLabels = (
  index: PackageIndex,
  packagePathOf: (target: Target.AnyTarget) => string
): { readonly get: (target: Target.AnyTarget) => string | undefined } => {
  const rows = index.targets()
  const labels = new WeakMap<Target.AnyTarget, string>(rows.map((row) => [row.target, row.label]))
  const positions = new Map<Target.AnyTarget, string>()
  const visit = (target: Target.AnyTarget, position: string): void => {
    if (positions.has(target)) return
    position = sha256Hex(position)
    positions.set(target, position)
    if (!labels.has(target)) {
      const rule = Target.metadata(target).target.replace(/[^A-Za-z0-9]/g, "_")
      labels.set(target, `//${packagePathOf(target)}:__private_${rule}_${position}`)
    }
    Target.metadata(target).dependencies.forEach((dependency, at) => {
      // A named dependency owns its closure, even when another root reaches it first.
      if (index.labelOf(dependency) === undefined) visit(dependency, JSON.stringify([position, "base", at]))
    })
  }
  for (const row of rows) visit(row.target, row.label)
  let expanded = false
  return {
    get: (requested) => {
      const known = labels.get(requested)
      if (known !== undefined || expanded) return known
      // Unused verb callbacks stay untouched unless a kind-only handle needs
      // a position. Complete the canonical scan before answering any lookup.
      expanded = true
      for (const [target, position] of positions) {
        const metadata = Target.metadata(target)
        for (const kind of [...Target.Kind.literals].sort(byCodeUnit)) {
          let dependencies: ReadonlyArray<Target.AnyTarget>
          try {
            dependencies = metadata.forKind(kind).dependencies
          } catch {
            // Invalid unused views remain lazy: planning that view reports its
            // original declaration error at the ordinary planner boundary.
            continue
          }
          dependencies.forEach((dependency, at) => {
            if (index.labelOf(dependency) === undefined) visit(dependency, JSON.stringify([position, kind, at]))
          })
        }
      }
      return labels.get(requested)
    }
  }
}

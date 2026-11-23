/**
 * Monotone capability attenuation hook for pre-layered kernel host services.
 *
 * When a host service closes over a `GrantStore` at layer construction time,
 * attaching `Symbol.for("@smthrs/capability/attenuateService")` lets
 * `CapabilitySet.attenuate` replace the service in the narrowed `Context` with
 * an instance bound to `GrantStore.attenuated(grants, ceiling)`. That prevents
 * an untrusted fiber from escaping a ceiling via `Effect.forkDetach` +
 * `Context.pick` on the pre-layered service handle.
 *
 * @since 1.0.0
 */

import type { CapabilitySet } from "@smthrs/capability/CapabilitySet"
import * as GrantStore from "../GrantStore.ts"

const AttenuateServiceSymbol: symbol = Symbol.for("@smthrs/capability/attenuateService")

/**
 * Builds a host service over `grants` and attaches a non-enumerable,
 * non-writable, non-configurable monotone attenuation hook.
 *
 * @private
 * @since 1.0.0
 */
export const attachServiceAttenuator = <A extends object>(
  grants: GrantStore.Service,
  makeWith: (grants: GrantStore.Service) => A
): A => {
  const service = makeWith(grants)
  Object.defineProperty(service, AttenuateServiceSymbol, {
    value: (ceiling: CapabilitySet) => attachServiceAttenuator(GrantStore.attenuated(grants, ceiling), makeWith),
    enumerable: false,
    writable: false,
    configurable: false
  })
  return service
}

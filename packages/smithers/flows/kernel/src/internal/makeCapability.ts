/**
 * Typed capability construction for host decorators.
 *
 * @since 1.0.0-rc.0
 */

import * as Capability from "@smthrs/capability/Capability"
import { GrantStoreError } from "@smthrs/capability/Permission"
import { digestSync } from "@smthrs/crypto"
import { Effect } from "effect"

/**
 * Constructs decorator requests without leaking schema failures as defects.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeCapability = (action: Capability.Action, resource: string) =>
  Effect.try({
    try: () => Capability.make(action, resource),
    catch: () =>
      new GrantStoreError({
        code: "invalid_resolution",
        message:
          `capability requires a valid action and a resource within maximumCapabilityResourceLength (${Capability.maxResourceLength} UTF-16 code units)`
      })
  })

/**
 * Bounds command display resources while binding their entire rendered text.
 * Digest-form literals are hashed too, so they cannot impersonate a shortened
 * resource. Retain the full rendered value in permission metadata.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeCommandCapability = (action: "proc:spawn" | "jj:snapshot", rendered: string) =>
  Effect.try({
    try: () =>
      rendered.length <= Capability.maxResourceLength && !/… sha256:[0-9a-f]{64}$/.test(rendered)
        ? rendered
        : `${rendered.slice(0, 3900).replace(/[\uD800-\uDBFF]$/, "")}… sha256:${digestSync(rendered)}`,
    catch: () =>
      new GrantStoreError({
        code: "invalid_resolution",
        message: "command resource must contain well-formed UTF-16 text"
      })
  }).pipe(Effect.flatMap((resource) => makeCapability(action, resource)))

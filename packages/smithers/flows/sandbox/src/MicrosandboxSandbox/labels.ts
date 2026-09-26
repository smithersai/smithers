/**
 * Names the ownership labels every Microsandbox machine carries.
 *
 * @since 0.1.0
 */

/**
 * The label key naming the provider that created a machine. Its value is
 * always {@link providerName}.
 *
 * @category constants
 * @since 0.1.0
 */
export const providerLabel = "smithers.provider"

/**
 * The value of {@link providerLabel} on every machine this provider creates.
 *
 * @category constants
 * @since 0.1.0
 */
export const providerName = "microsandbox"

/**
 * The label key naming the host installation a machine belongs to. `reap`
 * lists machines by it, so one installation never sweeps another's.
 *
 * @category constants
 * @since 0.1.0
 */
export const ownerLabel = "smithers.owner"

/**
 * The label key naming the live process holding a machine. `reap` asks its
 * caller whether that holder is still alive.
 *
 * @category constants
 * @since 0.1.0
 */
export const holderLabel = "smithers.holder"

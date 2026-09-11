/**
 * The shared length bound for exact and patterned capability resources.
 *
 * @since 0.1.0
 */

/**
 * The maximum UTF-16 length of an exact or patterned capability resource.
 *
 * Exact requests and authored patterns share the bound so permission failures,
 * journal payloads, matching work, and exact-pattern derivation all have one
 * finite input contract. Adapters must reject or summarize a larger host value
 * before constructing a capability rather than carrying it into authorization.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const maxResourceLength = 4096

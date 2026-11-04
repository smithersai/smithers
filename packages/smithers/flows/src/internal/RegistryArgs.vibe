/** Registry arguments shared by runtime factories.
 * @since 1.0.0
 */

import * as Layer from "effect/Layer"

/** A declared registry must be supplied, including when callers specify type arguments.
 * @since 1.0.0
 * @category models
 */
export type RegistryArgs<A, E, R> =
  | [registry: Layer.Layer<A, E, R>]
  | ([A | E | R] extends [never] ? [registry?: undefined] : never)

/** The registry layer the arguments name, or an empty layer when none was passed.
 * The empty branch can only be selected when all three registry types are never.
 * @since 1.0.0
 * @category layers
 */
export const registryLayer = <A, E, R>(args: RegistryArgs<A, E, R>): Layer.Layer<A, E, R> =>
  (args[0] ?? Layer.empty) as Layer.Layer<A, E, R>

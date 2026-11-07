/**
 * Flow declarations for `.smithers/FACTORY.ts`.
 *
 * A repository's flows live under `flows/` and describe themselves in their
 * own entry files: the description, the capabilities, the model. What a flow
 * cannot say about itself is how the repository presents it: the one-line
 * `summary` a listing shows under the id, and whether it is `featured`, one
 * of the handful the repository recommends first. That prose belongs to the
 * factory declaration, under `S.Factory({ flows })`, riding the same
 * `summary` and `featured` pair every target carries.
 *
 * `Smithers.Flow` is that declaration. It is inert: it names a flow id and
 * carries its presentation, and nothing reads it until the
 * `FactoryProjection` target projects the declarations over the discovered
 * flows into the `flows` rows of `.smithers/factory.json`. A declaration
 * that names no discovered flow fails that projection by id, so a typo is
 * never silently featured.
 *
 * @since 1.0.0
 */
import { Declaration } from "../../../src/Flow.vibe.platform.js";
export { Declaration, Flow, idPattern, maximumIdLength } from "../../../src/Flow.vibe.platform.js";
export type { Options } from "../../../src/Flow.vibe.platform.js";
/**
 * Reports whether a value is a flow declaration.
 *
 * @category guards
 * @since 1.0.0
 */
export declare const isFlowDeclaration: (value: unknown) => value is Declaration;

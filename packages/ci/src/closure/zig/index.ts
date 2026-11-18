/**
 * The Zig strategy for contract 9, the dependency closure.
 *
 * @since 0.1.0
 */

export * from "./Strategy.vibe"

/**
 * A closure being put together from the inputs the toolchain reported.
 *
 * @category models
 * @since 0.1.0
 */
export * as Draft from "./Draft.ts"

/**
 * The step graph `zig build --print-configuration` prints.
 *
 * @category models
 * @since 0.1.0
 */
export * as Graph from "./Graph.ts"

/**
 * Zig's cache manifests: the files a cached step read.
 *
 * @category models
 * @since 0.1.0
 */
export * as Manifest from "./Manifest.ts"

/**
 * The stdio protocols of `zig build --listen=-` and `zig test --listen=-`.
 *
 * @category models
 * @since 0.1.0
 */
export * as Protocol from "./Protocol.ts"

/**
 * ZON, the notation the configuration is printed in.
 *
 * @category models
 * @since 0.1.0
 */
export * as Zon from "./Zon.ts"

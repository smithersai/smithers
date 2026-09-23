/**
 * Bun composition for a local Control service: the same native host the Node
 * CLI runs, over Bun's SQLite, HTTP, and process adapters.
 *
 * Use this from a Bun process that runs a project's file flows in-process,
 * such as a terminal UI. It opens `<root>/.flows` (or the configured
 * `stateRoot`) exactly as `smthrs up` does, so `smthrs runs` sees the runs.
 *
 * @since 1.0.0
 */
import { native } from "./internal/BunControl.ts"

/**
 * Provides the Control service over Bun adapters for one project root.
 *
 * Arguments match `NodeControl.layerControl`: pass trusted `modules` (an
 * executable catalog and its registrations) to make discovered module flows
 * runnable. Store open and migration failures die with the layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerControl = native.layerControl

/**
 * Provides the flow registry for `<root>/flows` without importing any flow
 * module. A root with no `flows/` directory lists no flows.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerRegistry = native.layerRegistry

/**
 * `@smthrs/platform-browser` supplies the two platform services
 * `@effect/platform-browser` does not ship.
 *
 * `effect`'s browser platform package covers HTTP, sockets, workers, key-value
 * storage, and crypto, but a browser tab has no `node:fs` and no `fork`, so it
 * ships neither a `FileSystem` nor a `ChildProcessSpawner`. A tab *can* have
 * both, given a virtual filesystem (ZenFS) and an in-page bash interpreter
 * (just-bash). Neither is an npm dependency here: both are taken as structural
 * slices, so the page decides which backend is mounted. The package itself
 * depends on `effect`, `@smthrs/kernel` (the command-line renderer and the
 * filesystem isolation attestation), and `@smthrs/jj` (the wasm-backed `Jj`
 * service the `BrowserHost` bundle composes).
 *
 * ```ts
 * import { BrowserServices } from "@smthrs/platform-browser"
 *
 * const layer = BrowserServices.layer({ bash, fs })
 * ```
 *
 * Everything in this package is browser-bundleable; `scripts/browser-check.mjs`
 * at the repository root pins that property.
 *
 * @since 1.0.0-rc.0
 */

/**
 * `ChildProcessSpawner` over an in-page bash interpreter.
 * @slop
 */
export * as BrowserChildProcessSpawner from "./BrowserChildProcessSpawner/index.ts"

/**
 * `FileSystem` over a ZenFS-shaped promises API.
 * @slop
 */
export * as BrowserFileSystem from "./BrowserFileSystem/index.ts"

/**
 * The complete closed Host bundle for a browser tab.
 * @slop
 */
export * as BrowserHost from "./BrowserHost.ts"

/**
 * The aggregate browser platform services layer.
 * @slop
 */
export * as BrowserServices from "./BrowserServices.ts"

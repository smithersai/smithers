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
 * Everything in this package is browser-bundleable; `packages/repo-targets/browser/browser-check.mjs`
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

/**
 * `@smthrs/artifacts`' immutable cache over the browser's Cache Storage.
 *
 * @since 1.0.0
 */
export * as BrowserCache from "./BrowserCache.ts"

/**
 * A language server in a dedicated Web Worker: TypeScript's language service
 * over a read-only workspace, binding `@smthrs/std`'s `LanguageServer`.
 *
 * @since 1.0.0
 */
export * as BrowserLanguageServer from "./BrowserLanguageServer.ts"

/**
 * The durable flow engine as a tab sees it: requests to the leader, events back.
 *
 * @since 1.0.0
 */
export * as BrowserEngine from "./BrowserEngine.ts"

/**
 * The durable flow engine in a dedicated Web Worker, its leader election
 * across tabs, and the requests it serves.
 *
 * @since 1.0.0
 */
export * as BrowserRuntime from "./BrowserRuntime.ts"

/**
 * Effect's fiber scheduler for a browser tab or worker, without the browser's
 * 4 ms hold on nested timers.
 *
 * @since 1.0.0
 */
export * as BrowserScheduler from "./BrowserScheduler.ts"

/**
 * SQLite on the origin private file system, through Effect SQL.
 *
 * @since 1.0.0
 */
export * as BrowserSqlite from "./BrowserSqlite.ts"

/**
 * The app's own SQLite database, shared by every tab through the engine's
 * leader.
 *
 * @since 1.0.0
 */
export * as SharedSqlite from "./SharedSqlite.ts"

/**
 * Persistent storage for the origin, as a service.
 *
 * @since 1.0.0
 */
export * as StoragePersistence from "./StoragePersistence.ts"

/**
 * A `BroadcastChannel` as a service.
 *
 * @since 1.0.0
 */
export * as TabChannel from "./TabChannel.ts"

/**
 * The reconnecting WebSocket a page holds to a terminal.
 *
 * @since 1.0.0
 */
export * as TerminalSocket from "./TerminalSocket.ts"

/**
 * Exclusive Web Locks as a service.
 *
 * @since 1.0.0
 */
export * as WebLock from "./WebLock.ts"

/** @since 1.0.0 */
export * as PendingSnapshot from "./PendingSnapshot.ts"

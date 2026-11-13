/**
 * `@smthrs/platform-node`, the Node.js Host bundle.
 *
 * `@effect/platform-node` already ships `FileSystem`, `Path`,
 * `ChildProcessSpawner`, and an Undici-backed `HttpClient` for Node, and
 * `NodeHost.layer` composes the complete closed five-tag Host surface out of
 * them plus the Node `Jj` adapter, which lives in `@smthrs/jj`.
 *
 * The host adapters add guarantees beyond Effect's base services.
 * `AtomicFileSystem` performs every filesystem operation relative to
 * a pinned directory descriptor, so a symlink swapped in after authorization
 * cannot redirect it; `ProcessReaper` kills the process groups a crashed
 * incarnation of this host abandoned; `HostLiveness` answers whether a recorded
 * run owner is still running here. `ScopedProcess` runs transient commands with
 * supervised process cleanup and owns their input and output pipes.
 * `FetchTransport` reports how far each `fetch` to one origin got on the wire,
 * which is how the Node model host attributes a journal callback that never
 * answered.
 * `NodeGarbageCollector` collects the heap for the Microsandbox provider in
 * `@smthrs/sandbox`, which gives finished command handles back to the guest.
 * `EgressHttpClient.layer` also provides the system name resolver the web
 * tools in `@smthrs/std` check every destination with. `NodeLanguageServer`
 * binds `@smthrs/std`'s `LanguageServer` to host language-server processes.
 *
 * `AtomicFileSystem` is `NodeHost`'s filesystem slot. It executes operations
 * through the packaged `smithers-jj-export --atomic-fs` helper, selected by
 * `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` or `layerWith({ executable })`.
 * The helper ships for macOS, Linux, and Windows x64. A missing helper fails
 * guarded operations closed.
 *
 * `NodeRuntime` runs durable flows on Node: `NodeRuntime.layerHost` opens the
 * engine's SQLite file or PostgreSQL database, guards flow bodies on this
 * host, and shuts down on a signal, over `@smthrs/flows`' platform-neutral
 * `Runtime`. `SandboxedFlow` runs a child flow's own code inside a sandbox
 * machine, and `TestNodeRuntime` is the durable engine tests and examples use.
 *
 * @since 0.1.0
 */

/** The complete closed Host bundle for Node. */
export * as NodeHost from "./NodeHost.ts"

/** The outbound HTTP client a Node process should use, read off its environment. */
export * as EgressHttpClient from "./EgressHttpClient.ts"

/** The transport phase each `fetch` to one origin reached, read from Node's `undici` channels. */
export * as FetchTransport from "./FetchTransport.ts"

/**
 * Language Server Protocol clients over host processes, binding `@smthrs/std`'s `LanguageServer`.
 *
 * @since 1.0.0-rc.16
 */
export * as NodeLanguageServer from "./NodeLanguageServer.ts"

/** Whether a recorded run owner is still alive on this host. */
export * as HostLiveness from "./HostLiveness.ts"

/** Node's full garbage collection, for `@smthrs/sandbox`'s Microsandbox provider. */
export * as NodeGarbageCollector from "./NodeGarbageCollector.ts"

/** Reaping the process groups a dead incarnation of this host abandoned. */
export * as ProcessReaper from "./ProcessReaper.ts"

/** Transient pipe-based commands with supervised process cleanup. */
export * as ScopedProcess from "./ScopedProcess.ts"

/** Native confinement of approved processes under the kernel grants. */
export * as ProcessConfinement from "./ProcessConfinement.ts"

/** Shared operating-system sandbox for build and agent processes. */
export * as ProcessSandbox from "./ProcessSandbox.ts"

/** The native Node and Bun runtime lifecycle over `@smthrs/flows`' injected `Runtime`. */
export * as NativeRuntime from "./NativeRuntime.ts"

/** The durable flow runtime on Node: the native lifecycle bound to Node's SQLite driver and `NodeHost`. */
export * as NodeRuntime from "./NodeRuntime.ts"

/** A child flow's own code run inside a provisioned sandbox machine. */
export * as SandboxedFlow from "./SandboxedFlow.ts"

/** Test support: a durable Node engine over one SQLite file with a `Jj` that records nothing. */
export * as TestNodeRuntime from "./TestNodeRuntime.ts"

/** Scoped host allowlists for HTTP clients in a private network namespace. */
export * as DestinationProxy from "./DestinationProxy.ts"

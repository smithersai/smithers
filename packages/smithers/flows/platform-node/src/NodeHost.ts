/**
 * Aggregate Node.js Host bundle.
 *
 * This module defines the `NodeHost` service union and a single `layer` that
 * provides the closed Host surface backed by Node: `@effect/platform-node`'s
 * filesystem, child-process spawner, Undici `HttpClient`, native `Path`,
 * and the Node `Jj` adapter from its own package. Use the layer when a Node
 * program wants every host capability from one place; use the individual
 * modules when a program should only be able to reach part of the host. The
 * bundle also supplies native `ProcessConfinement` for the kernel spawner.
 *
 * There is no Node HTTP module either: outgoing requests are Effect's
 * `HttpClient`, and `@effect/platform-node` already ships the Undici-backed
 * implementation. Undici follows no redirect unless a redirect interceptor is
 * installed, so every hop stays visible to `@smthrs/kernel`'s decorator.
 *
 * There is no Node shell module: running a command is Effect's
 * `ChildProcessSpawner`, and `@effect/platform-node` already ships the
 * implementation.
 *
 * @since 0.1.0
 */

import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodePath from "@effect/platform-node/NodePath"
import type { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import type { HostServiceIds } from "@smthrs/kernel/HostServices"
import type * as KernelProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import type * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Effect from "effect/Effect"
import type { File, FileSystem } from "effect/FileSystem"
import type { HttpClient } from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { isAbsolute } from "node:path"
import * as AtomicFileSystem from "./AtomicFileSystem.ts"
import * as EgressHttpClient from "./EgressHttpClient.ts"
import * as RegularFile from "./internal/RegularFile.ts"
import * as ProcessConfinement from "./ProcessConfinement.ts"
import * as ProcessReaper from "./ProcessReaper.ts"

/**
 * The Node platform modules Effect ships, re-exported so a program that wants
 * only part of the host has one place to reach for them. `NodeJj` belongs to
 * `@smthrs/jj`; import it from there.
 *
 * `NodeCrypto` is here for a different reason than the rest. `Crypto` is not a
 * Host service — it carries no host authority the kernel could attenuate, so
 * it is not in {@link NodeHost} and not in the closed list — but every durable
 * composition needs one, and a program that already depends on this package
 * for its host should not have to add a second dependency for the digest.
 *
 * @category re-exports
 * @since 0.1.0
 */
export {
  AtomicFileSystem,
  EgressHttpClient,
  NodeChildProcessSpawner,
  NodeCrypto,
  NodeFileSystem,
  NodeHttpClient,
  NodePath,
  ProcessReaper
}

/**
 * The `HttpClient` every bundle below installs: Undici through the egress
 * proxy this process's environment names, and a direct Undici pool when it
 * names none.
 *
 * `NodeHttpClient.layerUndici` is the direct pool unconditionally. It is still
 * re-exported above for a program composing its own services, but a bundle
 * that spans a whole host has to work inside a sandbox whose only way out is a
 * proxy, so the bundles read the environment. See {@link EgressHttpClient}.
 *
 * The bundles provide no `FetchHttpClient.Fetch`. Effect's fetch client reads
 * that reference from the fiber making the request, which outranks the context
 * the client was built in, and a flow runtime runs every step in a fiber that
 * carries its host's context. A host-wide `Fetch` would therefore replace the
 * fetch each composition injects, a test's included. A Node model host passes
 * {@link EgressHttpClient.providerFetch} as `HostModel`'s `fetch` option.
 */
const httpClient = EgressHttpClient.layer(process.env)

/**
 * The union of host services provided by the Node host layer.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeHost =
  | FileSystem
  | Path.Path
  | ChildProcessSpawner
  | Jj
  | HttpClient
  | KernelProcessConfinement.ProcessConfinement

/**
 * Invalid repository-root configuration, refused when the layer is built.
 * @category errors
 * @since 1.0.0-rc.0
 */
export class NodeHostError extends Schema.TaggedError<NodeHostError>()("@smthrs/platform-node/NodeHostError", {
  code: Schema.Literal("invalid_repository_root"),
  message: Schema.String
}) {
  override readonly name = "NodeHostError"
}

const absoluteRoot = (root: string): Effect.Effect<string, NodeHostError> =>
  isAbsolute(root) ? Effect.succeed(root) : Effect.fail(
    new NodeHostError({
      code: "invalid_repository_root",
      message: "NodeHost requires an absolute repository root"
    })
  )

/**
 * Stable implementation identities for the raw bundle's five Host slots.
 * Contained factories replace its spawner with {@link ProcessReaper.layerSpawner}.
 * @category models
 * @since 1.0.0-rc.0
 */
export const implementationIds: Readonly<Record<(typeof HostServiceIds)[number], string>> = {
  "effect/FileSystem": "@smthrs/platform-node/AtomicFileSystem",
  "effect/Path": "@effect/platform-node/NodePath",
  "effect/process/ChildProcessSpawner": "@effect/platform-node/NodeChildProcessSpawner",
  "@smthrs/jj/Jj": "@smthrs/jj/node/NodeJj",
  "effect/HttpClient": "@smthrs/platform-node/EgressHttpClient"
}

/** The two services `NodeChildProcessSpawner` resolves paths and files with. */
const platform = Layer.mergeAll(AtomicFileSystem.layer, NodePath.layer)

/**
 * What a caller may configure about a contained Node host.
 *
 * `platform` is deliberately absent. `ContainedSpawner.Options` declares it so a
 * caller that supplies its own spawner can describe one, but this native host
 * detaches by `process.platform` whatever a record claims. A caller-supplied
 * `"win32"` on a POSIX host would therefore
 * record `pgid: null` for a child that really does lead a group, and
 * {@link ProcessReaper.reap} would retire that record as `no-group` and leave
 * the orphan running forever — a durable lie rather than a compile error.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ContainedOptions = ProcessReaper.SpawnerOptions & ProcessReaper.Options

/** The reaper half of {@link ContainedOptions}. */
const reaping = (options?: ContainedOptions): ProcessReaper.Options => ({
  ownerPid: options?.ownerPid,
  system: options?.system
})

/**
 * Provides the default Node implementations for the whole closed Host surface.
 *
 * Builds on a host without jj: the `Jj` slot checks `jj --version` on its
 * first operation and fails that operation with `JjError` `not_installed` or
 * `unsupported_version`, so a program that never calls `Jj` runs without jj.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<NodeHost> = Layer.mergeAll(
  ProcessConfinement.layer(),
  platform,
  Layer.provide(NodeChildProcessSpawner.layer, platform),
  httpClient,
  NodeJj.layer
)

/**
 * Provides the Node host with `Jj` bound to one absolute repository root.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerAt = (repositoryRoot: string): Layer.Layer<NodeHost, NodeHostError> =>
  Layer.unwrap(Effect.map(absoluteRoot(repositoryRoot), (root) =>
    Layer.mergeAll(
      ProcessConfinement.layer(),
      platform,
      Layer.provide(NodeChildProcessSpawner.layer, platform),
      httpClient,
      NodeJj.layerAt(root)
    )))

/**
 * Provides the Node host with process containment turned on.
 *
 * The difference from {@link layer} is what happens to a spawned process when
 * its run stops. Under {@link layer} a child is signalled when its scope
 * closes and then waited for, forever if it ignores `SIGTERM`, and a host that
 * dies without closing its scopes abandons every child it started. This layer
 * gives each child an escalation deadline and records it in the
 * `ProcessLedger`, then sweeps the records a previous incarnation of the same
 * host left behind before it hands the host over
 * ({@link ProcessReaper.reap}).
 *
 * jj is contained here too: `layerContained` builds the `Jj` service over the
 * same spawner rather than letting it start its own children, so a `jj`
 * invocation a crashed host left running, including the version probe of the
 * first `Jj` operation, is a record the next incarnation reaps like any other.
 *
 * The ledger is a requirement rather than a default because the durable half
 * of containment is only as good as the journal underneath it:
 * `ProcessLedger.layer` inherits a crashed incarnation's processes,
 * `ProcessLedger.layerMemory` contains this incarnation and nothing more, and
 * the choice belongs to the program that knows which it has.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerContained = (
  options?: ContainedOptions
): Layer.Layer<NodeHost, never, ProcessLedger.ProcessLedger> => {
  const spawner = ProcessReaper.layerSpawner({ graceMs: options?.graceMs })
  return Layer.mergeAll(
    ProcessConfinement.layer(),
    platform,
    httpClient,
    // jj goes through the CONTAINED spawner here, not around it. `NodeJj.layer`
    // spawns its own children, which is right for a host that has no spawner
    // to offer, but under containment it would mean a `jj` that leads no
    // recorded process group, appears in no ledger, and survives the
    // incarnation that started it.
    Layer.provideMerge(NodeJj.layerSpawner, spawner)
  ).pipe(Layer.provideMerge(ProcessReaper.layer(reaping(options))))
}

/**
 * Provides the contained Node host with `Jj` bound to one absolute repository
 * root.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerContainedAt = (
  repositoryRoot: string,
  options?: ContainedOptions
): Layer.Layer<NodeHost, NodeHostError, ProcessLedger.ProcessLedger> =>
  Layer.unwrap(Effect.map(absoluteRoot(repositoryRoot), (root) => {
    const spawner = ProcessReaper.layerSpawner({ graceMs: options?.graceMs })
    return Layer.mergeAll(
      ProcessConfinement.layer(),
      platform,
      httpClient,
      Layer.provideMerge(NodeJj.layerSpawnerAt(root), spawner)
    ).pipe(Layer.provideMerge(ProcessReaper.layer(reaping(options))))
  }))

/**
 * Opens `path` for reading only when it names a regular file, and never waits
 * on a FIFO, even one swapped in after a caller's `stat`.
 *
 * On Linux and macOS the path is opened `O_RDONLY | O_NONBLOCK` and refused
 * unless that descriptor is a regular file; the returned `File` reopens the
 * verified descriptor through `/dev/fd`, never the path. Windows has no FIFOs
 * on ordinary paths, so there the path is opened `"r"` and refused unless it
 * is a regular file. A refusal is a `BadResource` `PlatformError`.
 *
 * This is the Node implementation of `@smthrs/build`'s
 * `PackageManager.RegularFileOpen`:
 * `Layer.succeed(PackageManager.RegularFileOpen)({ open: NodeHost.openRegularFile })`.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const openRegularFile = (path: string): Effect.Effect<File, PlatformError.PlatformError, Scope.Scope> =>
  RegularFile.open(process.platform, path)

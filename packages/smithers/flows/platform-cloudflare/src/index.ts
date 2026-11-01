/**
 * `@smthrs/platform-cloudflare`, the Cloudflare host for durable flows.
 *
 * - `CloudflareHost`: the closed Host surface for a Worker or Durable Object.
 * - `CloudflareRuntime`: the durable engine for one execution, over an
 *   injected `SqlClient`.
 * - `ExecutionObject`: the per-execution Durable Object, as `start`, `wake`
 *   and `alarm` functions an Effect-native Durable Object delegates to; a
 *   `Router` reaches the objects of child and handoff executions.
 * - `EdgeCache`: `@smthrs/artifacts`' `ImmutableCache` over the Workers Cache
 *   API.
 * - `SandboxObject`: what a container Durable Object runs before it uses its
 *   container: start it with internet access off, re-arm its inactivity
 *   timeout, register its outbound HTTP intercepts.
 * - `ContainerTerminal`: a browser terminal over `@smthrs/sandbox`'s
 *   `TerminalProtocol`, one tmux session per terminal in the container and
 *   one tmux client per socket.
 * - `ContainerSession`: the container as a `Sandbox.Session`, so
 *   `@smthrs/sandbox`'s `SandboxTools` and `Sandbox.layerHost` run on it.
 *
 * ```ts
 * import { CloudflareRuntime, EdgeCache, ExecutionObject } from "@smthrs/platform-cloudflare"
 * ```
 *
 * Nothing here imports a `node:` built-in or a Cloudflare module, so the
 * package bundles for workerd and runs under Node for tests.
 *
 * @since 1.0.0
 */

/**
 * The closed Host surface for a Worker or Durable Object.
 *
 * @since 1.0.0
 */
export * as CloudflareHost from "./CloudflareHost.vibe"

/**
 * The durable engine for one execution on Cloudflare.
 *
 * @since 1.0.0
 */
export * as CloudflareRuntime from "./CloudflareRuntime.ts"

/**
 * The per-execution Durable Object, as functions.
 *
 * @since 1.0.0
 */
export * as ExecutionObject from "./ExecutionObject.ts"

/**
 * The immutable cache over the Workers Cache API.
 *
 * @since 1.0.0
 */
export * as EdgeCache from "./EdgeCache.vibe"

/**
 * A browser terminal attached to a tmux session in a Durable Object's
 * container.
 *
 * @since 1.0.0-rc.17
 */
export * as ContainerTerminal from "./ContainerTerminal.ts"

/**
 * A container Durable Object's container as a `Sandbox.Session`.
 *
 * @since 1.0.0-rc.17
 */
export * as ContainerSession from "./ContainerSession.ts"

/**
 * The container Durable Object's wake: start, inactivity timeout and outbound
 * intercepts.
 *
 * @since 1.0.0-rc.17
 */
export * as SandboxObject from "./SandboxObject.ts"

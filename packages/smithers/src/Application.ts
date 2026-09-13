/**
 * Transport-neutral application composition.
 *
 * @since 0.1.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type { ApprovalAuthority, Control, ControlExecutor, ControlSchema } from "@smthrs/control"
import { ControlClient, ControlRuntime } from "@smthrs/control"
import type { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import type * as McpClient from "@smthrs/mcp/McpClient"
import type { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Layer } from "effect"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import type { RpcSerialization } from "effect/unstable/rpc/RpcSerialization"
import type { Socket } from "effect/unstable/socket/Socket"
import * as ExecutorOwnership from "./ExecutorOwnership.ts"
import * as LocalControl from "./internal/LocalControl.ts"

/**
 * Everything the durable layers need to know before any flag is parsed.
 *
 * The composition roots are built from this, and they are built before the
 * command tree runs, so these four values are read straight off the argument
 * vector and the environment by `NodeControl.makeConfig` rather than by a
 * handler. An invalid value is reported there as a usage error; by the time a
 * handler sees a `Config` it is already valid.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config {
  /** Trusted local host configuration, never decoded from command arguments. */
  readonly approvalAuthority?: ApprovalAuthority.Service | undefined
  /** Transport-owned local identity; remote RPC authentication owns its own actor. */
  readonly principal?: Omit<ControlSchema.Principal, "stampedAt"> | undefined
  /** Execution worktree for a durable fork; database and registry stay under root. */
  readonly executionRoot?: string | undefined
  readonly remote?: string | undefined
  readonly credential?: string | undefined
  /**
   * MCP servers the local executor connects at startup, each projected into
   * the run's flow catalog by `@smthrs/mcp/McpFlows`. Empty by default, and
   * meaningless when `remote` is set — a remote composition's executor is not
   * this process's to configure.
   */
  readonly mcpServers?: ReadonlyArray<McpClient.ConnectOptions> | undefined
  /**
   * The project root every durable layer is built over: the `.flows/`
   * directory, the `flows/` registry sources, and the detached run logs all
   * hang off it. Resolved from `--root` or the nearest ancestor holding
   * `.flows/` or `flows/`, before any command handler runs.
   */
  readonly root?: string | undefined
  /**
   * The 0.x project `smthrs migrate` converts when the operator names no
   * path: `--root`, or the nearest ancestor holding 0.x state.
   *
   * Not {@link Config.root}. That one anchors on `.flows/`, which a 0.x
   * project does not have, so migrating from a directory nested under an rc.0
   * project targeted the ancestor.
   */
  readonly migrationRoot?: string | undefined
}

/**
 * The runtime and journal a local composition executes on.
 *
 * Pass one to {@link layer} to choose where a local command's runs and events
 * are recorded: {@link engineMemory} for a composition that must not touch the
 * disk, `NodeControl.engineDurable` for the real project database.
 *
 * A journal is required, not optional: `Journal.layerNoop()` is a closed stub,
 * so every mutation event (decide/resume/launch) failed with
 * `journal_closed` after the runtime had already transitioned.
 *
 * @category models
 * @since 0.1.0
 */
export interface Engine {
  readonly runtime: Layer.Layer<ControlRuntime.ControlRuntime>
  readonly journal: Layer.Layer<Journal.Journal>
}

/**
 * The in-memory engine: a deterministic runtime over an in-memory SQLite
 * journal.
 *
 * It is the default because this module is transport-neutral and cannot open a
 * file. Nothing it records survives the process, so a platform composition
 * that can reach durable storage should supply its own —
 * `NodeControl.engineDurable` is the Node one.
 *
 * A local journal that fails to migrate cannot serve anything; startup failure
 * is a defect, not a typed control-plane error.
 *
 * @category layers
 * @since 0.1.0
 */
export const engineMemory: Engine = {
  // The runtime mints identifiers through `Crypto`, which is a host service
  // now rather than an ambient global.
  runtime: ControlRuntime.layerMemory().pipe(Layer.provide(NodeCrypto.layer)),
  journal: TestJournal.layer().pipe(Layer.orDie)
}

const rpcUrl = (remote: string): string => {
  const url = new URL(remote)
  if (!url.pathname.endsWith("/rpc")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/rpc`
  }
  return url.toString()
}

/**
 * Selects the sole Control implementation used by the command tree.
 *
 * Local commands call the in-process implementation directly. Remote commands
 * use the RPC-backed implementation and leave its abstract HTTP and socket
 * requirements for a platform composition module to provide.
 *
 * `registry` is the local flow registry and `engine` is what local commands
 * execute on. This module is transport-neutral, so it can construct neither a
 * filesystem-backed registry nor a file-backed engine and defaults to the empty
 * registry and the in-memory engine; a platform composition supplies the real
 * things — `NodeControl.layerRegistry` and `NodeControl.engineDurable` are the
 * Node ones.
 *
 * `executor` is the run executor `ControlLive.run` starts accepted launches
 * on. It must be provided here — `ControlLive` resolves it with
 * `Effect.serviceOption` while its own layer is built, so an executor
 * provided from outside an already-satisfied layer is invisible. Omitting it
 * leaves every run `pending`, which is only correct for compositions that
 * observe runs without executing them. `NodeControl.layerExecutor` is the
 * production one.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  config: Config,
  // Discovery, not safety: the empty registry is the transport-neutral default
  // this module can build, and `NodeControl.layerRegistry` is the production
  // one every Node composition passes. A command that finds no flows says so;
  // it does not run anything with a guard removed.
  // eslint-disable-next-line no-restricted-syntax -- registry is discovery, see above
  registry: Layer.Layer<Registry.Registry> = Registry.layerNoop(),
  engine: Engine = engineMemory,
  executor?:
    | Layer.Layer<
      ControlExecutor.ControlExecutor,
      never,
      ControlRuntime.ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
    >
    | undefined
): Layer.Layer<Control.Control, never, HttpClient | RpcSerialization | Socket> =>
  config.remote === undefined
    ? LocalControl.layer(registry, engine, executor)
    : Layer.merge(
      ControlClient.layer({ url: rpcUrl(config.remote), credential: config.credential }),
      ExecutorOwnership.layer(false)
    )

/**
 * The sandbox every build tool run goes through: the target's declared policy
 * over the one operating-system sandbox, `@smthrs/platform-node`'s
 * `ProcessSandbox`.
 *
 * A target declares a policy (`Attr.Sandbox`): the default confinement, a
 * loopback opening, the full network opening, or the `"none"` opt-out. The
 * workspace may declare a mechanism (`S.Sandboxes`). The surfaces
 * (`PackageExec` and `ExecLive`) turn the policy plus the planner's read and
 * write sets into a {@link Request}; this module resolves the policy and the
 * declaration into the sandbox's own request and plans it, or refuses with an
 * {@link Unenforceable} naming what the host lacks. Rendering an argv from a
 * plan, the host facts, and the diagnosis of a denied run are the sandbox's
 * and are re-exported here unchanged.
 *
 * Every declared confinement is enforced or the target fails closed. Nothing
 * here logs "unenforced" and carries on. `S.Sandbox.Microsandbox` is not a
 * build mechanism: it names the runtime sandbox `@smthrs/sandbox` boots for
 * sessions, and a build target declared under it is refused with the
 * mechanisms that do confine builds.
 *
 * @since 0.1.0
 */

import * as ProcessSandbox from "@smthrs/platform-node/ProcessSandbox"
import * as NodePath from "node:path"
import type * as Attr from "./Attr.ts"
import type * as WorkspaceDeclaration from "./WorkspaceDeclaration.ts"

export type {
  /**
   * The host facts mechanism selection reads.
   *
   * @category models
   * @since 0.1.0
   */
  Host,
  /**
   * One selected enforcement mechanism.
   *
   * @category models
   * @since 0.1.0
   */
  Mechanism,
  /**
   * The network posture a policy resolves to. Here `"none"` is a closed
   * network, the opposite of the `"none"` a {@link Policy} spells to drop
   * confinement entirely.
   *
   * @category models
   * @since 0.1.0
   */
  Network,
  /**
   * The resolved confinement one spawn runs under.
   *
   * @category models
   * @since 0.1.0
   */
  Plan,
  /**
   * What a confined run is shown of the tools the host has on `PATH`.
   *
   * @category models
   * @since 0.1.0
   */
  Toolchain,
  /**
   * The refusal a host that cannot enforce a declared confinement produces.
   *
   * @category models
   * @since 0.1.0
   */
  Unenforceable
} from "@smthrs/platform-node/ProcessSandbox"

export {
  /**
   * The bubblewrap argv for a plan.
   *
   * @category rendering
   * @since 0.1.0
   */
  bubblewrap,
  /**
   * Names, from a failed tool's own output, the paths it touched outside the
   * declared set.
   *
   * @category diagnostics
   * @since 0.1.0
   */
  diagnose,
  /**
   * The `docker run` argv for a plan.
   *
   * @category rendering
   * @since 0.1.0
   */
  docker,
  /**
   * Environment the confined process receives on top of the tool environment.
   *
   * @category rendering
   * @since 0.1.0
   */
  environment,
  /**
   * The real host: platform, `PATH` lookup, and filesystem probes.
   *
   * @category resolution
   * @since 0.1.0
   */
  host,
  /**
   * Checks for an {@link Unenforceable} refusal.
   *
   * @category guards
   * @since 0.1.0
   */
  isUnenforceable,
  /**
   * The seatbelt profile for a plan.
   *
   * @category rendering
   * @since 0.1.0
   */
  seatbelt,
  /**
   * The host tools a confined run finds by name on `PATH`, and what each one
   * needs to run.
   *
   * @category resolution
   * @since 0.1.0
   */
  toolchain,
  /**
   * Rechecks write grants before directory creation and before rendering.
   *
   * @category resolution
   * @since 0.1.0
   */
  validateWrites,
  /**
   * Wraps a tool argv in the plan's mechanism.
   *
   * @category rendering
   * @since 0.1.0
   */
  wrap,
  /**
   * Why this host cannot hold a path read-only under an unconfined run, or
   * nothing when it can.
   *
   * @category resolution
   * @since 0.1.0
   */
  writeProtectionRefusal
} from "@smthrs/platform-node/ProcessSandbox"

/**
 * The declared sandbox policy.
 *
 * The literal `"none"` is the confinement opt-out, not a network posture: it
 * asks for no sandbox at all, so the process keeps every access the host
 * gives it, the network included. {@link Network} spells its closed posture
 * with the same word and means the opposite, so read the token against the
 * type carrying it rather than on sight.
 *
 * @category models
 * @since 0.1.0
 */
export type Policy = Attr.Sandbox

/**
 * What a surface asks for: the policy, the workspace's mechanism choice, and
 * the read and write sets. Every path is workspace-relative and posix-shaped;
 * a read may name a file or a directory, a write names a directory. A
 * `readOnly` entry re-closes a subtree under a declared write.
 *
 * @category models
 * @since 0.1.0
 */
export interface Request {
  /** Exact HTTP egress hosts; enforced through a broker in a closed namespace. */
  readonly destinations?: ReadonlyArray<string> | undefined
  readonly policy: Policy | undefined
  readonly mechanism?: WorkspaceDeclaration.SandboxDeclaration | undefined
  readonly reads: ReadonlyArray<string>
  /**
   * Symbolic link inputs, each placed at its workspace-relative path with its
   * declared target and granting nothing through it.
   */
  readonly links?: ReadonlyArray<ProcessSandbox.Link> | undefined
  readonly writes: ReadonlyArray<string>
  /**
   * Declared outputs whose leaf is a file rather than a directory. A file
   * cannot be bound writable on its own and does not exist before the tool
   * writes it, so its parent directory becomes the writable bind. Kept apart
   * from `writes` because only the caller knows which of the two a
   * declaration meant: inferring it from the path would hand a not-yet-created
   * `.cargo-home` or `dist.new` its parent, and a parent that is the
   * workspace root opens the whole workspace for the run.
   */
  readonly writeFiles?: ReadonlyArray<string> | undefined
  readonly readOnly?: ReadonlyArray<string> | undefined
  /**
   * Absolute host paths outside the workspace the tool reads: a git
   * submodule's local source repository, for one. Bound read-only where the
   * mechanism would otherwise hide them; a path that does not exist, or that
   * sits inside the workspace, is dropped.
   */
  readonly externalReads?: ReadonlyArray<string> | undefined
  /**
   * Host links outside the workspace the run sees as links: the links a tool
   * on `PATH` is reached through. A link grants nothing.
   */
  readonly externalLinks?: ReadonlyArray<ProcessSandbox.Link> | undefined
  /**
   * Links placed in the run's private directories, each path relative to the
   * private temporary directory: a version manager's home where its shims
   * look for it.
   */
  readonly privateLinks?: ReadonlyArray<ProcessSandbox.Link> | undefined
  /**
   * Whether an undeclared write under the workspace lands in a private layer
   * discarded with the run, instead of failing. A check whose product is its
   * exit code asks for it, so a tool that leaves files beside its inputs
   * still runs against exactly its declared reads. Only bubblewrap has the
   * layer; under any other mechanism the request is refused.
   */
  readonly scratch?: boolean | undefined
  /**
   * Workspace paths the run may not write even when nothing confines it: the
   * policy is `"none"` or the workspace declared `Sandbox.None()`. The run
   * keeps the host's files and network and finds these paths read-only, so a
   * tree a content key has measured stays the tree while a tool runs over
   * it. It runs in a mount namespace to do so; `ProcessSandbox.writeProtected`
   * says what that changes. A confined run needs no entry here: what it may
   * write is its `writes`. A host without the mechanism runs the tool
   * unprotected; see {@link protect}.
   */
  readonly writeProtected?: ReadonlyArray<string> | undefined
}

/**
 * Resolves the network posture of an explicit policy. Service dependencies do
 * not widen it; their consumers must declare the network access they need.
 *
 * The policy `"none"` resolves to the `"open"` posture, which reads as a
 * contradiction only until the two vocabularies are separated: a target that
 * declared no sandbox is not confined, and an unconfined process has the
 * host's network.
 *
 * @category resolution
 * @since 0.1.0
 */
export const network = (policy: Policy | undefined): ProcessSandbox.Network => {
  if (policy === "none") return "open"
  if (typeof policy === "object" && policy !== null) {
    if (policy.network === true) return "open"
    if (policy.network === "loopback") return "loopback"
  }
  return "none"
}

const advice = `A confined target never runs unconfined; declare sandbox: "none" on the target to opt out, ` +
  `or declare a mechanism the host has with S.Sandboxes({ default: ... }).`

/** The build's reading of a sandbox refusal: what the host lacks, then what a declaration can do about it. */
const advised = (refusal: ProcessSandbox.Unenforceable): ProcessSandbox.Unenforceable => ({
  ...refusal,
  message: `${refusal.message} ${advice}`
})

/** The sandbox's own request for a build request whose policy did not opt out. */
const lower = (request: Request): ProcessSandbox.Request => {
  const declared = request.mechanism
  return {
    network: network(request.policy),
    ...(declared === undefined
      ? {}
      : declared._tag === "SandboxDocker"
      ? { mechanism: { _tag: "docker", image: declared.image } }
      : { mechanism: { _tag: "bubblewrap" } }),
    reads: request.reads,
    ...(request.links === undefined ? {} : { links: request.links }),
    writes: request.writes,
    writeFiles: request.writeFiles,
    readOnly: request.readOnly,
    externalReads: request.externalReads,
    ...(request.externalLinks === undefined ? {} : { externalLinks: request.externalLinks }),
    ...(request.privateLinks === undefined ? {} : { privateLinks: request.privateLinks }),
    ...(request.scratch === true ? { scratch: true } : {})
  }
}

/**
 * Selects the mechanism a request runs under on a host.
 *
 * A `"none"` policy or a `Sandbox.None()` declaration selects nothing. A
 * declared mechanism is honored or refused; with no declaration the platform
 * decides: bubblewrap on Linux, seatbelt on macOS, and a refusal elsewhere,
 * because Windows has no user-level process sandbox and Docker needs an image
 * only the workspace can name.
 *
 * @category resolution
 * @since 0.1.0
 */
export const select = (
  request: Request,
  hostFacts: ProcessSandbox.Host
): ProcessSandbox.Mechanism | ProcessSandbox.Unenforceable => {
  if (
    request.destinations !== undefined && (
      network(request.policy) !== "none" || hostFacts.platform !== "linux" ||
      (request.mechanism !== undefined && request.mechanism._tag !== "SandboxBubblewrap")
    )
  ) {
    return ProcessSandbox.unenforceable(
      hostFacts.platform,
      "bubblewrap",
      "closed network",
      "destination allowlists require bubblewrap with a closed network"
    )
  }
  if (request.policy === "none") return { _tag: "none" }
  const declared = request.mechanism
  const platform = hostFacts.platform
  if (declared !== undefined && declared._tag === "SandboxNone") return { _tag: "none" }
  if (declared !== undefined && declared._tag === "SandboxMicrosandbox") {
    return advised(ProcessSandbox.unenforceable(
      platform,
      "microsandbox",
      "S.Sandbox.Bubblewrap",
      "S.Sandbox.Microsandbox is the runtime sandbox (@smthrs/sandbox MicrosandboxSandbox) for agent and flow sessions; " +
        "build-target confinement runs under S.Sandbox.Bubblewrap or S.Sandbox.Docker"
    ))
  }
  if (declared === undefined && platform !== "linux" && platform !== "darwin") {
    return advised(ProcessSandbox.unenforceable(
      platform,
      "docker",
      "S.Sandbox.Docker",
      `${platform} has no process sandbox of its own; declare S.Sandboxes({ default: S.Sandbox.Docker({ image }) })`
    ))
  }
  if (declared !== undefined && declared._tag === "SandboxDocker" && hostFacts.executable("docker") === undefined) {
    return advised(ProcessSandbox.unenforceable(
      platform,
      "docker",
      "docker",
      "S.Sandbox.Docker is declared but docker is not on PATH"
    ))
  }
  if (declared !== undefined && declared._tag === "SandboxBubblewrap" && platform !== "linux") {
    return advised(ProcessSandbox.unenforceable(
      platform,
      "bubblewrap",
      "linux",
      "S.Sandbox.Bubblewrap is declared but bubblewrap runs only on Linux; on macOS the seatbelt mechanism is selected when no mechanism is declared"
    ))
  }
  const selected = ProcessSandbox.select(lower(request), hostFacts)
  if (ProcessSandbox.isUnenforceable(selected)) return advised(selected)
  if (request.scratch === true && selected._tag !== "bubblewrap") {
    return ProcessSandbox.unenforceable(
      platform,
      selected._tag,
      "bubblewrap",
      `a discarded scratch layer needs bubblewrap; under ${selected._tag} an undeclared write would reach the host`
    )
  }
  return selected
}

/**
 * Whether a request would be enforced on a host: the policy opts out, or a
 * mechanism is available. A confined request with no mechanism is not
 * enforced, and execution fails it closed.
 *
 * @category resolution
 * @since 0.1.0
 */
export const enforceable = (request: Request, hostFacts: ProcessSandbox.Host): boolean => {
  const selected = select(request, hostFacts)
  return !ProcessSandbox.isUnenforceable(selected) && selected._tag !== "none"
}

/**
 * Resolves a request against a workspace into a {@link Plan}, or refuses.
 * Nothing for a policy or declaration that opted out.
 *
 * @category resolution
 * @since 0.1.0
 */
export const plan = (
  request: Request,
  location: { readonly workspaceRoot: string; readonly cwd: string; readonly tmp: string },
  hostFacts: ProcessSandbox.Host
): ProcessSandbox.Plan | ProcessSandbox.Unenforceable | undefined => {
  const selected = select(request, hostFacts)
  if (ProcessSandbox.isUnenforceable(selected)) return selected
  if (selected._tag === "none") return undefined
  const planned = ProcessSandbox.plan(lower(request), location, hostFacts)
  return ProcessSandbox.isUnenforceable(planned) ? advised(planned) : planned
}

/**
 * The argv an unconfined run starts: `argv` wrapped so the request's
 * {@link Request.writeProtected} paths are read-only for it, or `argv` itself
 * when the request names none or the host has no mechanism to hold them.
 *
 * Call it only for a request {@link plan} answered nothing for. A path that
 * leaves the workspace is dropped, and one that does not exist is skipped.
 *
 * @category rendering
 * @since 0.1.0
 */
export const protect = (
  request: Request,
  workspaceRoot: string,
  argv: ReadonlyArray<string>,
  hostFacts: ProcessSandbox.Host
): ReadonlyArray<string> => {
  const paths = (request.writeProtected ?? [])
    .map((path) => NodePath.resolve(workspaceRoot, ...path.split("/")))
    .filter((path) => path.startsWith(workspaceRoot + NodePath.sep))
  if (paths.length === 0) return argv
  return ProcessSandbox.writeProtected(paths, argv, hostFacts) ?? argv
}
